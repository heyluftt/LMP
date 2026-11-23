//! LMP AV: the player's own container layer.
//!
//! The demuxers in this module read MP4/MOV, Matroska/WebM and MPEG-TS files
//! directly, describe their tracks in WebCodecs terms and hand compressed
//! samples to the frontend in compact binary batches. Decoding, clock, A/V
//! sync and rendering live in `src/player/av/` on the frontend side.

mod batch;
mod codec;
mod isobmff;
mod matroska;
mod mpegts;
mod reader;

#[cfg(test)]
mod tests;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex,
    },
};

use serde::Serialize;

pub use batch::encode_batch;
use reader::FileReader;

pub const SUPPORTED_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mov", "3gp", "3g2", "m4a", "mkv", "mka", "webm", "weba", "ts", "m2ts", "mts",
];

const DEFAULT_READ_BYTES: usize = 1536 * 1024;
const MAX_READ_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_READ_SAMPLES: usize = 512;
const MAX_SESSIONS: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    Video,
    Audio,
    Subtitle,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackInfo {
    pub id: u32,
    pub kind: TrackKind,
    /// Human readable codec family ("h264", "aac", ...), also for unsupported codecs.
    pub codec_family: String,
    /// WebCodecs codec string. `None` when LMP cannot describe the codec.
    pub codec: Option<String>,
    /// WebCodecs decoder description bytes (avcC, hvcC, AudioSpecificConfig, ...).
    pub description: Option<Vec<u8>>,
    pub width: u32,
    pub height: u32,
    pub display_width: u32,
    pub display_height: u32,
    pub frame_rate: Option<f64>,
    pub sample_rate: u32,
    pub channels: u32,
    pub bit_depth: Option<u32>,
    pub language: Option<String>,
    pub name: Option<String>,
    pub default: bool,
    pub forced: bool,
    pub default_duration_us: i64,
    pub codec_delay_us: i64,
    pub sample_count: u64,
    pub subtitle_format: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterInfo {
    pub start_us: i64,
    pub end_us: Option<i64>,
    pub title: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub container: String,
    pub duration_us: i64,
    pub tracks: Vec<TrackInfo>,
    pub chapters: Vec<ChapterInfo>,
    pub title: Option<String>,
    pub seekable: bool,
}

#[derive(Clone, Debug)]
pub struct Sample {
    pub track_id: u32,
    pub pts_us: i64,
    /// Decode timestamp, kept for ordering checks in tests and diagnostics.
    #[allow(dead_code)]
    pub dts_us: i64,
    pub duration_us: i64,
    pub keyframe: bool,
    pub data: Vec<u8>,
}

pub trait Demuxer: Send {
    fn info(&self) -> &MediaInfo;
    fn select_tracks(&mut self, ids: &[u32]);
    /// Repositions all selected tracks so that the next video sample is a key
    /// frame at or before `target_us`. Returns the time the stream resumes at.
    fn seek(&mut self, target_us: i64) -> Result<i64, String>;
    /// Returns the next samples in decode order plus an end-of-stream flag.
    fn next_samples(
        &mut self,
        max_bytes: usize,
        max_samples: usize,
    ) -> Result<(Vec<Sample>, bool), String>;
}

pub(crate) fn scale_to_us(value: i64, timescale: u32) -> i64 {
    if timescale == 0 {
        return 0;
    }
    ((value as i128 * 1_000_000) / timescale as i128) as i64
}

pub fn supports_extension(extension: &str) -> bool {
    SUPPORTED_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
}

pub fn open_demuxer(path: &Path) -> Result<Box<dyn Demuxer>, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    let mut reader = FileReader::open(path)?;
    let head = reader.peek(1024)?;

    let is_ebml = head.len() >= 4 && head[0..4] == [0x1A, 0x45, 0xDF, 0xA3];
    let is_isobmff = head.len() >= 8
        && matches!(
            &head[4..8],
            b"ftyp" | b"moov" | b"mdat" | b"free" | b"skip" | b"wide" | b"pnot" | b"styp"
        );
    let is_transport_stream = mpegts::looks_like_transport_stream(&head);

    if is_ebml {
        return Ok(Box::new(matroska::MkvDemuxer::open(reader)?));
    }
    if is_isobmff {
        return Ok(Box::new(isobmff::Mp4Demuxer::open(reader, &extension)?));
    }
    if is_transport_stream {
        return Ok(Box::new(mpegts::TsDemuxer::open(reader)?));
    }
    match extension.as_str() {
        "mkv" | "mka" | "webm" | "weba" => Ok(Box::new(matroska::MkvDemuxer::open(reader)?)),
        "mp4" | "m4v" | "mov" | "3gp" | "3g2" | "m4a" => {
            Ok(Box::new(isobmff::Mp4Demuxer::open(reader, &extension)?))
        }
        "ts" | "m2ts" | "mts" | "m2t" => Ok(Box::new(mpegts::TsDemuxer::open(reader)?)),
        _ => Err("LMP AV does not recognize this container.".to_string()),
    }
}

// ---------------------------------------------------------------------------
// Session store + Tauri commands
// ---------------------------------------------------------------------------

type SharedDemuxer = Arc<Mutex<Box<dyn Demuxer>>>;

#[derive(Default)]
pub struct AvState {
    sessions: Mutex<HashMap<u32, SessionEntry>>,
    next_id: AtomicU32,
}

struct SessionEntry {
    demuxer: SharedDemuxer,
    opened_at: std::time::Instant,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvOpenResult {
    pub session_id: u32,
    pub info: MediaInfo,
}

impl AvState {
    fn session(&self, id: u32) -> Result<SharedDemuxer, String> {
        self.sessions
            .lock()
            .map_err(|_| "AV session store is poisoned.".to_string())?
            .get(&id)
            .map(|entry| Arc::clone(&entry.demuxer))
            .ok_or_else(|| "AV session is no longer open.".to_string())
    }

    fn insert(&self, demuxer: Box<dyn Demuxer>) -> Result<u32, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "AV session store is poisoned.".to_string())?;
        while sessions.len() >= MAX_SESSIONS {
            let oldest = sessions
                .iter()
                .min_by_key(|(_, entry)| entry.opened_at)
                .map(|(id, _)| *id);
            match oldest {
                Some(oldest) => {
                    sessions.remove(&oldest);
                }
                None => break,
            }
        }
        sessions.insert(
            id,
            SessionEntry {
                demuxer: Arc::new(Mutex::new(demuxer)),
                opened_at: std::time::Instant::now(),
            },
        );
        Ok(id)
    }

    fn remove(&self, id: u32) -> Result<(), String> {
        self.sessions
            .lock()
            .map_err(|_| "AV session store is poisoned.".to_string())?
            .remove(&id);
        Ok(())
    }
}

fn validated_media_path(path: &str) -> Result<PathBuf, String> {
    let media = PathBuf::from(path);
    if !media.exists() || !media.is_file() {
        return Err(format!("File does not exist: {path}"));
    }
    let extension = media
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    if !supports_extension(&extension) {
        return Err(format!(
            "LMP AV does not handle .{extension} files yet (supported: {}).",
            SUPPORTED_EXTENSIONS.join(", ")
        ));
    }
    Ok(media)
}

async fn run_blocking<T, F>(context: &'static str, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("{context}: {error}"))?
}

#[tauri::command]
pub async fn av_open(
    path: String,
    state: tauri::State<'_, AvState>,
) -> Result<AvOpenResult, String> {
    let media = validated_media_path(&path)?;
    let demuxer = run_blocking("Could not open media", move || open_demuxer(&media)).await?;
    let info = demuxer.info().clone();
    let session_id = state.insert(demuxer)?;
    Ok(AvOpenResult { session_id, info })
}

#[tauri::command]
pub async fn av_select_tracks(
    session_id: u32,
    track_ids: Vec<u32>,
    state: tauri::State<'_, AvState>,
) -> Result<(), String> {
    let demuxer = state.session(session_id)?;
    run_blocking("Could not select tracks", move || {
        let mut demuxer = demuxer
            .lock()
            .map_err(|_| "AV session is poisoned.".to_string())?;
        demuxer.select_tracks(&track_ids);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn av_seek(
    session_id: u32,
    seconds: f64,
    state: tauri::State<'_, AvState>,
) -> Result<f64, String> {
    if !seconds.is_finite() {
        return Err("Seek target is not valid.".to_string());
    }
    let demuxer = state.session(session_id)?;
    let target_us = (seconds.max(0.0) * 1_000_000.0).round() as i64;
    run_blocking("Could not seek", move || {
        let mut demuxer = demuxer
            .lock()
            .map_err(|_| "AV session is poisoned.".to_string())?;
        let actual = demuxer.seek(target_us)?;
        Ok(actual as f64 / 1_000_000.0)
    })
    .await
}

#[tauri::command]
pub async fn av_read(
    session_id: u32,
    max_bytes: Option<usize>,
    max_samples: Option<usize>,
    state: tauri::State<'_, AvState>,
) -> Result<tauri::ipc::Response, String> {
    let demuxer = state.session(session_id)?;
    let max_bytes = max_bytes
        .unwrap_or(DEFAULT_READ_BYTES)
        .clamp(64 * 1024, MAX_READ_BYTES);
    let max_samples = max_samples.unwrap_or(DEFAULT_READ_SAMPLES).clamp(1, 4096);
    let bytes = run_blocking("Could not read media", move || {
        let mut demuxer = demuxer
            .lock()
            .map_err(|_| "AV session is poisoned.".to_string())?;
        let (samples, eof) = demuxer.next_samples(max_bytes, max_samples)?;
        Ok(encode_batch(&samples, eof))
    })
    .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn av_close(session_id: u32, state: tauri::State<'_, AvState>) -> Result<(), String> {
    state.remove(session_id)
}

#[tauri::command]
pub fn av_supported_extensions() -> Vec<String> {
    SUPPORTED_EXTENSIONS
        .iter()
        .map(|value| value.to_string())
        .collect()
}
