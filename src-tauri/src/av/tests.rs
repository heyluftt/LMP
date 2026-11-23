//! Demuxer integration tests.
//!
//! Fixtures are generated on demand with the bundled FFmpeg
//! (`src-tauri/binaries/tools/ffmpeg.exe`) into `target/av-fixtures`. The
//! demuxer output is compared against `ffprobe -show_packets` for the same
//! file: sample count, sizes, timestamps and key frame flags must agree.
//! When FFmpeg is not available the tests print a notice and pass.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};

use super::{open_demuxer, Demuxer, TrackKind};

static GENERATE_LOCK: Mutex<()> = Mutex::new(());

fn tools_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join("tools")
}

fn tool(name: &str) -> Option<PathBuf> {
    let candidate = tools_dir().join(format!("{name}.exe"));
    if candidate.exists() {
        return Some(candidate);
    }
    let candidate = tools_dir().join(name);
    candidate.exists().then_some(candidate)
}

fn fixture_dir() -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("av-fixtures");
    let _ = fs::create_dir_all(&dir);
    dir
}

struct Fixture {
    name: &'static str,
    args: &'static [&'static str],
}

const COMMON_INPUT: &[&str] = &[
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=30:duration=2.4",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=2.4",
];

const FIXTURES: &[Fixture] = &[
    Fixture {
        name: "h264_aac.mp4",
        args: &[
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-g",
            "30",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-ac",
            "2",
            "-movflags",
            "+faststart",
        ],
    },
    Fixture {
        name: "h264_aac_frag.mp4",
        args: &[
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-g",
            "15",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-ac",
            "2",
            "-movflags",
            "+frag_keyframe+empty_moov+default_base_moof",
        ],
    },
    Fixture {
        name: "h264_aac.mkv",
        args: &[
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-g",
            "30",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-ac",
            "2",
        ],
    },
    Fixture {
        name: "h264_aac_live.mkv",
        args: &[
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-g",
            "30",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-ac",
            "2",
            "-f",
            "matroska",
            "-live",
            "1",
        ],
    },
    Fixture {
        name: "vp9_opus.webm",
        args: &[
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            "libvpx-vp9",
            "-deadline",
            "realtime",
            "-cpu-used",
            "8",
            "-g",
            "30",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "libopus",
            "-ac",
            "2",
        ],
    },
    Fixture {
        name: "hevc_flac.mkv",
        args: &[
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            "libx265",
            "-preset",
            "ultrafast",
            "-g",
            "30",
            "-pix_fmt",
            "yuv420p",
            "-x265-params",
            "log-level=none",
            "-c:a",
            "flac",
            "-ac",
            "2",
        ],
    },
    Fixture {
        name: "audio_only.m4a",
        args: &["-map", "1:a", "-c:a", "aac", "-ac", "2"],
    },
    Fixture {
        name: "h264_pcm.mov",
        args: &[
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-g",
            "30",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "pcm_s16le",
            "-ac",
            "2",
        ],
    },
    Fixture {
        name: "h264_aac.ts",
        args: &[
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-g",
            "30",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-ac",
            "2",
        ],
    },
    Fixture {
        // FFmpeg picks the 192-byte M2TS layout from the .m2ts extension.
        name: "h264_aac_mono.m2ts",
        args: &[
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-g",
            "30",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-ac",
            "1",
        ],
    },
    Fixture {
        name: "hevc_ac3.m2ts",
        args: &[
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            "libx265",
            "-preset",
            "ultrafast",
            "-g",
            "30",
            "-pix_fmt",
            "yuv420p",
            "-x265-params",
            "log-level=none",
            "-c:a",
            "ac3",
            "-ac",
            "2",
        ],
    },
];

fn fixture(name: &str) -> Option<PathBuf> {
    let ffmpeg = tool("ffmpeg")?;
    let path = fixture_dir().join(name);
    let _guard = GENERATE_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if path.exists() && path.metadata().map(|meta| meta.len() > 0).unwrap_or(false) {
        return Some(path);
    }
    let fixture = FIXTURES.iter().find(|fixture| fixture.name == name)?;
    let status = Command::new(&ffmpeg)
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-y")
        .args(COMMON_INPUT)
        .args(fixture.args)
        .arg(&path)
        .status()
        .ok()?;
    if !status.success() {
        eprintln!("ffmpeg could not create fixture {name}");
        return None;
    }
    Some(path)
}

fn multi_track_fixture() -> Option<PathBuf> {
    let ffmpeg = tool("ffmpeg")?;
    let path = fixture_dir().join("multi_audio_subs.mkv");
    let _guard = GENERATE_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if path.exists() && path.metadata().map(|meta| meta.len() > 0).unwrap_or(false) {
        return Some(path);
    }
    let srt = fixture_dir().join("subs.srt");
    fs::write(
        &srt,
        "1\n00:00:00,200 --> 00:00:01,000\nHello LMP\n\n2\n00:00:01,200 --> 00:00:02,000\nSecond line\n",
    )
    .ok()?;
    let status = Command::new(&ffmpeg)
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-y")
        .args(COMMON_INPUT)
        .args([
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:sample_rate=44100:duration=2.4",
        ])
        .arg("-i")
        .arg(&srt)
        .args([
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-map",
            "2:a",
            "-map",
            "3:s",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-g",
            "30",
            "-pix_fmt",
            "yuv420p",
            "-c:a:0",
            "aac",
            "-ac:a:0",
            "2",
            "-c:a:1",
            "libopus",
            "-ac:a:1",
            "1",
            "-c:s",
            "srt",
            "-metadata:s:a:0",
            "language=eng",
            "-metadata:s:a:0",
            "title=English",
            "-metadata:s:a:1",
            "language=deu",
            "-metadata:s:a:1",
            "title=Deutsch",
            "-metadata:s:s:0",
            "language=eng",
        ])
        .arg(&path)
        .status()
        .ok()?;
    if !status.success() {
        eprintln!("ffmpeg could not create the multi-track fixture");
        return None;
    }
    Some(path)
}

#[derive(Debug, Clone)]
struct ProbePacket {
    pts_us: Option<i64>,
    size: u32,
    key: bool,
}

fn ffprobe_packets(path: &Path, stream: &str) -> Option<Vec<ProbePacket>> {
    let ffprobe = tool("ffprobe")?;
    let output = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            stream,
            "-show_entries",
            "packet=pts_time,size,flags",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let packets = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let fields: Vec<&str> = line.split(',').collect();
            if fields.len() < 3 {
                return None;
            }
            let pts_us = fields[0]
                .trim()
                .parse::<f64>()
                .ok()
                .map(|value| (value * 1_000_000.0).round() as i64);
            let size = fields[1].trim().parse::<u32>().ok()?;
            let key = fields[2].contains('K');
            Some(ProbePacket { pts_us, size, key })
        })
        .collect::<Vec<_>>();
    Some(packets)
}

fn skip(reason: &str) {
    eprintln!("skipping: {reason}");
}

fn drain_all(demuxer: &mut Box<dyn Demuxer>) -> Vec<super::Sample> {
    let mut all = Vec::new();
    loop {
        let (samples, eof) = demuxer
            .next_samples(2 * 1024 * 1024, 256)
            .expect("read samples");
        all.extend(samples);
        if eof {
            break;
        }
        assert!(all.len() < 1_000_000, "demuxer never reached end of stream");
    }
    all
}

fn compare_track(
    path: &Path,
    demuxer: &mut Box<dyn Demuxer>,
    track_id: u32,
    stream: &str,
    tolerance_us: i64,
) {
    compare_track_with(path, demuxer, track_id, stream, tolerance_us, false, 0);
}

/// `normalize_pts` compares timestamps relative to each side's first packet
/// (transport streams start at an arbitrary PTS). `reference_size_delta` is
/// added to the ffprobe sizes, e.g. -7 when the demuxer strips ADTS headers.
fn compare_track_with(
    path: &Path,
    demuxer: &mut Box<dyn Demuxer>,
    track_id: u32,
    stream: &str,
    tolerance_us: i64,
    normalize_pts: bool,
    reference_size_delta: i64,
) {
    demuxer.select_tracks(&[track_id]);
    demuxer.seek(0).expect("seek start");
    let samples = drain_all(demuxer);
    let Some(reference) = ffprobe_packets(path, stream) else {
        skip("ffprobe not available");
        return;
    };
    assert_eq!(
        samples.len(),
        reference.len(),
        "{}: sample count mismatch for stream {stream}",
        path.display()
    );

    let mut ours: Vec<(i64, u32, bool)> = samples
        .iter()
        .map(|sample| (sample.pts_us, sample.data.len() as u32, sample.keyframe))
        .collect();
    let mut theirs: Vec<(i64, u32, bool)> = reference
        .iter()
        .map(|packet| {
            (
                packet.pts_us.unwrap_or(i64::MIN),
                (packet.size as i64 + reference_size_delta).max(0) as u32,
                packet.key,
            )
        })
        .collect();
    ours.sort();
    theirs.sort();
    if normalize_pts {
        let first_ours = ours.first().map(|entry| entry.0).unwrap_or(0);
        let first_theirs = theirs
            .iter()
            .map(|entry| entry.0)
            .find(|pts| *pts != i64::MIN)
            .unwrap_or(0);
        for entry in &mut ours {
            entry.0 -= first_ours;
        }
        for entry in &mut theirs {
            if entry.0 != i64::MIN {
                entry.0 -= first_theirs;
            }
        }
    }
    for (index, (mine, reference)) in ours.iter().zip(theirs.iter()).enumerate() {
        if reference.0 != i64::MIN {
            assert!(
                (mine.0 - reference.0).abs() <= tolerance_us,
                "{}: pts mismatch at sorted index {index} (ours {} vs ffprobe {})",
                path.display(),
                mine.0,
                reference.0
            );
        }
        assert_eq!(
            mine.1,
            reference.1,
            "{}: size mismatch at sorted index {index}",
            path.display()
        );
        assert_eq!(
            mine.2,
            reference.2,
            "{}: key frame flag mismatch at sorted index {index} (pts {})",
            path.display(),
            mine.0
        );
    }
}

fn open(path: &Path) -> Box<dyn Demuxer> {
    open_demuxer(path).unwrap_or_else(|error| panic!("open {}: {error}", path.display()))
}

#[test]
fn mp4_h264_aac_matches_ffprobe() {
    let Some(path) = fixture("h264_aac.mp4") else {
        return skip("ffmpeg not available");
    };
    let mut demuxer = open(&path);
    let info = demuxer.info().clone();
    assert_eq!(info.container, "mp4");
    assert!(info.duration_us > 2_300_000 && info.duration_us < 2_600_000);
    let video = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Video)
        .expect("video");
    let audio = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Audio)
        .expect("audio");
    assert_eq!(video.codec_family, "h264");
    assert!(video.codec.as_deref().unwrap_or("").starts_with("avc1."));
    assert!(video
        .description
        .as_ref()
        .map(|d| d[0] == 1)
        .unwrap_or(false));
    assert_eq!((video.width, video.height), (320, 180));
    assert!((video.frame_rate.unwrap_or(0.0) - 30.0).abs() < 0.01);
    assert_eq!(audio.codec.as_deref(), Some("mp4a.40.2"));
    assert_eq!(audio.sample_rate, 48000);
    assert_eq!(audio.channels, 2);
    assert!(audio.description.is_some());

    compare_track(&path, &mut demuxer, video.id, "v:0", 2);
    compare_track(&path, &mut demuxer, audio.id, "a:0", 2);
}

#[test]
fn fragmented_mp4_matches_ffprobe() {
    let Some(path) = fixture("h264_aac_frag.mp4") else {
        return skip("ffmpeg not available");
    };
    let mut demuxer = open(&path);
    let info = demuxer.info().clone();
    let video = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Video)
        .expect("video");
    let audio = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Audio)
        .expect("audio");
    assert!(video.sample_count > 60);
    compare_track(&path, &mut demuxer, video.id, "v:0", 2);
    compare_track(&path, &mut demuxer, audio.id, "a:0", 2);
}

#[test]
fn mkv_h264_aac_matches_ffprobe() {
    let Some(path) = fixture("h264_aac.mkv") else {
        return skip("ffmpeg not available");
    };
    let mut demuxer = open(&path);
    let info = demuxer.info().clone();
    assert_eq!(info.container, "matroska");
    assert!(info.duration_us > 2_300_000 && info.duration_us < 2_600_000);
    let video = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Video)
        .expect("video");
    let audio = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Audio)
        .expect("audio");
    assert_eq!(video.codec_family, "h264");
    assert_eq!(audio.codec.as_deref(), Some("mp4a.40.2"));
    assert_eq!(audio.sample_rate, 48000);
    compare_track(&path, &mut demuxer, video.id, "v:0", 1000);
    compare_track(&path, &mut demuxer, audio.id, "a:0", 1000);
}

#[test]
fn live_mkv_without_cues_reads_and_seeks() {
    let Some(path) = fixture("h264_aac_live.mkv") else {
        return skip("ffmpeg not available");
    };
    let mut demuxer = open(&path);
    let info = demuxer.info().clone();
    let video = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Video)
        .expect("video");
    compare_track(&path, &mut demuxer, video.id, "v:0", 1000);

    demuxer.select_tracks(&[video.id]);
    let resumed = demuxer.seek(1_500_000).expect("seek");
    assert!(resumed <= 1_500_000);
    let (samples, _) = demuxer.next_samples(1 << 20, 4).expect("read after seek");
    assert!(!samples.is_empty());
    assert!(
        samples[0].keyframe,
        "first video sample after seek must be a key frame"
    );
    assert!(samples[0].pts_us <= 1_500_000);
}

#[test]
fn webm_vp9_opus_matches_ffprobe() {
    let Some(path) = fixture("vp9_opus.webm") else {
        return skip("ffmpeg not available");
    };
    let mut demuxer = open(&path);
    let info = demuxer.info().clone();
    assert_eq!(info.container, "webm");
    let video = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Video)
        .expect("video");
    let audio = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Audio)
        .expect("audio");
    assert_eq!(video.codec_family, "vp9");
    assert!(video.codec.as_deref().unwrap_or("").starts_with("vp09.00."));
    assert_eq!(audio.codec.as_deref(), Some("opus"));
    assert!(audio
        .description
        .as_ref()
        .map(|d| d.starts_with(b"OpusHead"))
        .unwrap_or(false));
    assert_eq!(audio.sample_rate, 48000);
    compare_track(&path, &mut demuxer, video.id, "v:0", 1000);
    compare_track(&path, &mut demuxer, audio.id, "a:0", 1000);
}

#[test]
fn mkv_hevc_flac_matches_ffprobe() {
    let Some(path) = fixture("hevc_flac.mkv") else {
        return skip("ffmpeg not available");
    };
    let mut demuxer = open(&path);
    let info = demuxer.info().clone();
    let video = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Video)
        .expect("video");
    let audio = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Audio)
        .expect("audio");
    assert_eq!(video.codec_family, "hevc");
    assert!(video.codec.as_deref().unwrap_or("").starts_with("hvc1."));
    assert_eq!(audio.codec.as_deref(), Some("flac"));
    assert!(audio
        .description
        .as_ref()
        .map(|d| d.starts_with(b"fLaC"))
        .unwrap_or(false));
    assert_eq!(audio.sample_rate, 48000);
    compare_track(&path, &mut demuxer, video.id, "v:0", 1000);
    compare_track(&path, &mut demuxer, audio.id, "a:0", 1000);
}

#[test]
fn m4a_audio_only_matches_ffprobe() {
    let Some(path) = fixture("audio_only.m4a") else {
        return skip("ffmpeg not available");
    };
    let mut demuxer = open(&path);
    let info = demuxer.info().clone();
    assert!(info.tracks.iter().all(|t| t.kind == TrackKind::Audio));
    let audio = &info.tracks[0];
    compare_track(&path, &mut demuxer, audio.id, "a:0", 2);
}

#[test]
fn mov_pcm_audio_is_described() {
    let Some(path) = fixture("h264_pcm.mov") else {
        return skip("ffmpeg not available");
    };
    let mut demuxer = open(&path);
    let info = demuxer.info().clone();
    assert_eq!(info.container, "quicktime");
    let audio = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Audio)
        .expect("audio");
    assert_eq!(audio.codec_family, "pcm");
    assert_eq!(audio.codec.as_deref(), Some("pcm-s16"));
    let video = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Video)
        .expect("video");
    compare_track(&path, &mut demuxer, video.id, "v:0", 2);
}

#[test]
fn mp4_seek_lands_on_keyframe_and_interleaves() {
    let Some(path) = fixture("h264_aac.mp4") else {
        return skip("ffmpeg not available");
    };
    let mut demuxer = open(&path);
    let info = demuxer.info().clone();
    let video = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Video)
        .expect("video");
    let audio = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Audio)
        .expect("audio");
    demuxer.select_tracks(&[video.id, audio.id]);

    let resumed = demuxer.seek(1_250_000).expect("seek");
    assert!((0..=1_250_000).contains(&resumed));
    let (samples, _) = demuxer.next_samples(4 << 20, 400).expect("read");
    let first_video = samples
        .iter()
        .find(|s| s.track_id == video.id)
        .expect("video sample");
    assert!(
        first_video.keyframe,
        "first video sample after seek is not a key frame"
    );
    assert!(first_video.pts_us <= 1_250_000);
    let first_audio = samples
        .iter()
        .find(|s| s.track_id == audio.id)
        .expect("audio sample");
    assert!(first_audio.pts_us <= first_video.pts_us + 30_000);

    // Decode order per track must be monotonic.
    let mut last_video = i64::MIN;
    let mut last_audio = i64::MIN;
    for sample in &samples {
        if sample.track_id == video.id {
            assert!(sample.dts_us >= last_video);
            last_video = sample.dts_us;
        } else {
            assert!(sample.dts_us >= last_audio);
            last_audio = sample.dts_us;
        }
    }

    // Seeking past the end yields end of stream.
    demuxer.seek(60_000_000).expect("seek past end");
    let (rest, eof) = demuxer.next_samples(1 << 20, 16).expect("read past end");
    assert!(eof || rest.len() <= 2);
}

#[test]
fn ts_h264_aac_matches_ffprobe() {
    let Some(path) = fixture("h264_aac.ts") else {
        return skip("ffmpeg not available");
    };
    let mut demuxer = open(&path);
    let info = demuxer.info().clone();
    assert_eq!(info.container, "mpegts");
    assert!(info.seekable);
    assert!(
        info.duration_us > 2_300_000 && info.duration_us < 2_700_000,
        "duration {}",
        info.duration_us
    );
    let video = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Video)
        .expect("video");
    let audio = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Audio)
        .expect("audio");
    assert_eq!(video.codec_family, "h264");
    assert!(video.codec.as_deref().unwrap_or("").starts_with("avc1."));
    assert!(
        video.description.is_none(),
        "TS video stays Annex B without a description"
    );
    assert_eq!((video.width, video.height), (320, 180));
    assert_eq!((video.display_width, video.display_height), (320, 180));
    assert!((video.frame_rate.unwrap_or(0.0) - 30.0).abs() < 0.01);
    assert_eq!(video.default_duration_us, 33_333);
    assert_eq!(audio.codec_family, "aac");
    assert_eq!(audio.codec.as_deref(), Some("mp4a.40.2"));
    assert_eq!(audio.sample_rate, 48000);
    assert_eq!(audio.channels, 2);
    assert_eq!(audio.description.as_deref(), Some(&[0x11u8, 0x90][..]));

    compare_track_with(&path, &mut demuxer, video.id, "v:0", 50, true, 0);
    // ffprobe reports ADTS frames including the 7-byte header; LMP strips it.
    compare_track_with(&path, &mut demuxer, audio.id, "a:0", 50, true, -7);
}

#[test]
fn m2ts_hevc_ac3_matches_ffprobe() {
    let Some(path) = fixture("hevc_ac3.m2ts") else {
        return skip("ffmpeg not available");
    };
    let mut demuxer = open(&path);
    let info = demuxer.info().clone();
    assert_eq!(info.container, "mpegts");
    let video = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Video)
        .expect("video");
    let audio = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Audio)
        .expect("audio");
    assert_eq!(video.codec_family, "hevc");
    assert!(video.codec.as_deref().unwrap_or("").starts_with("hvc1."));
    assert!(video.description.is_none());
    assert_eq!((video.width, video.height), (320, 180));
    assert!((video.frame_rate.unwrap_or(0.0) - 30.0).abs() < 0.01);
    assert_eq!(audio.codec_family, "ac3");
    assert_eq!(audio.codec.as_deref(), Some("ac-3"));
    assert_eq!(audio.sample_rate, 48000);
    assert_eq!(audio.channels, 2);

    compare_track_with(&path, &mut demuxer, video.id, "v:0", 50, true, 0);
    compare_track_with(&path, &mut demuxer, audio.id, "a:0", 50, true, 0);
}

#[test]
fn ts_seek_lands_on_keyframe_and_interleaves() {
    let Some(path) = fixture("h264_aac.ts") else {
        return skip("ffmpeg not available");
    };
    let mut demuxer = open(&path);
    let info = demuxer.info().clone();
    let video = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Video)
        .expect("video");
    let audio = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Audio)
        .expect("audio");
    demuxer.select_tracks(&[video.id, audio.id]);

    let resumed = demuxer.seek(1_250_000).expect("seek");
    assert!((0..=1_250_000).contains(&resumed), "resumed at {resumed}");
    let (samples, _) = demuxer.next_samples(4 << 20, 400).expect("read");
    let first_video = samples
        .iter()
        .find(|s| s.track_id == video.id)
        .expect("video sample");
    assert!(
        first_video.keyframe,
        "first video sample after seek is not a key frame"
    );
    assert!(first_video.pts_us <= 1_250_000);
    // Key frames are one second apart (-g 30 at 30 fps): the seek must land on
    // the last one before the target, not an earlier one.
    assert!(
        first_video.pts_us > 250_000,
        "seek landed too early at {}",
        first_video.pts_us
    );
    assert_eq!(resumed, first_video.pts_us);
    let first_audio = samples
        .iter()
        .find(|s| s.track_id == audio.id)
        .expect("audio sample");
    assert!(first_audio.pts_us <= first_video.pts_us + 500_000);
    assert!(first_audio.pts_us >= first_video.pts_us - 1_500_000);

    let mut last_video = i64::MIN;
    let mut last_audio = i64::MIN;
    for sample in &samples {
        if sample.track_id == video.id {
            assert!(
                sample.dts_us >= last_video,
                "video decode order is not monotonic"
            );
            last_video = sample.dts_us;
        } else {
            assert!(sample.dts_us >= last_audio, "audio order is not monotonic");
            last_audio = sample.dts_us;
        }
    }

    // Seeking back to the start replays the first key frame.
    let resumed = demuxer.seek(0).expect("seek start");
    assert_eq!(resumed, 0);
    let (samples, _) = demuxer.next_samples(1 << 20, 8).expect("read start");
    let first_video = samples
        .iter()
        .find(|s| s.track_id == video.id)
        .expect("video sample");
    assert!(first_video.keyframe);
    assert!(first_video.pts_us < 200_000);

    demuxer.seek(60_000_000).expect("seek past end");
    let (rest, eof) = demuxer.next_samples(1 << 20, 16).expect("read past end");
    assert!(eof || rest.len() <= 2);
}

#[test]
fn mkv_seek_uses_cues_and_switches_audio_tracks() {
    let Some(path) = multi_track_fixture() else {
        return skip("ffmpeg not available");
    };
    let mut demuxer = open(&path);
    let info = demuxer.info().clone();
    let video = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Video)
        .expect("video");
    let audio: Vec<_> = info
        .tracks
        .iter()
        .filter(|t| t.kind == TrackKind::Audio)
        .collect();
    let subtitle = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Subtitle)
        .expect("subtitle");
    assert_eq!(audio.len(), 2);
    assert_eq!(audio[0].language.as_deref(), Some("eng"));
    assert_eq!(audio[0].name.as_deref(), Some("English"));
    assert_eq!(audio[1].language.as_deref(), Some("deu"));
    assert_eq!(audio[1].codec.as_deref(), Some("opus"));
    assert_eq!(subtitle.subtitle_format.as_deref(), Some("srt"));

    demuxer.select_tracks(&[video.id, audio[1].id, subtitle.id]);
    let resumed = demuxer.seek(1_100_000).expect("seek");
    assert!(resumed <= 1_100_000);
    let samples = drain_all(&mut demuxer);
    let first_video = samples
        .iter()
        .find(|s| s.track_id == video.id)
        .expect("video");
    assert!(first_video.keyframe);
    assert!(first_video.pts_us <= 1_100_000);
    assert!(samples.iter().any(|s| s.track_id == audio[1].id));
    assert!(samples.iter().all(|s| s.track_id != audio[0].id));
    let cue = samples
        .iter()
        .find(|s| s.track_id == subtitle.id)
        .expect("subtitle sample");
    assert_eq!(String::from_utf8_lossy(&cue.data).trim(), "Second line");
    assert!(cue.duration_us > 700_000 && cue.duration_us < 900_000);
}

#[test]
fn m2ts_aac_in_private_stream_matches_ffprobe() {
    // In M2TS mode FFmpeg marks AAC as private data (stream type 0x06) without
    // a descriptor; the demuxer has to recognise it from the ADTS payload.
    let Some(path) = fixture("h264_aac_mono.m2ts") else {
        return skip("ffmpeg not available");
    };
    let mut demuxer = open(&path);
    let info = demuxer.info().clone();
    assert_eq!(info.container, "mpegts");
    assert_eq!(info.tracks.len(), 2, "tracks: {:?}", info.tracks);
    let video = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Video)
        .expect("video");
    let audio = info
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Audio)
        .expect("audio");
    assert_eq!(video.codec_family, "h264");
    assert_eq!(audio.codec_family, "aac");
    assert_eq!(audio.codec.as_deref(), Some("mp4a.40.2"));
    assert_eq!(audio.sample_rate, 48000);
    assert_eq!(audio.channels, 1);
    assert_eq!(audio.description.as_deref(), Some(&[0x11u8, 0x88][..]));
    assert!(audio.default);

    compare_track_with(&path, &mut demuxer, video.id, "v:0", 50, true, 0);
    compare_track_with(&path, &mut demuxer, audio.id, "a:0", 50, true, -7);
}
