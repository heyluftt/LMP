//! ISO Base Media File Format demuxer (MP4, M4V, M4A, MOV, 3GP).
//!
//! Supports plain `moov`-indexed files and fragmented files (`moof`/`traf`/
//! `trun`). The whole sample table is built at open time; reading then walks
//! the selected tracks in decode order and pulls the raw sample bytes.

use super::{
    codec,
    reader::{fourcc_to_string, ByteCursor, FileReader},
    scale_to_us, ChapterInfo, Demuxer, MediaInfo, Sample, TrackInfo, TrackKind,
};

#[derive(Clone, Copy, Debug)]
struct Mp4Sample {
    offset: u64,
    size: u32,
    dts: u64,
    cts: i32,
    duration: u32,
    keyframe: bool,
}

struct Mp4Track {
    id: u32,
    kind: TrackKind,
    timescale: u32,
    /// Composition offset removed by the edit list (track timescale units).
    edit_media_time: i64,
    /// Presentation delay added by an empty leading edit (microseconds).
    empty_edit_us: i64,
    samples: Vec<Mp4Sample>,
    /// Decode time the next fragment continues from when `tfdt` is missing.
    next_dts: u64,
    default_sample_duration: u32,
    default_sample_size: u32,
    default_sample_flags: u32,
    info: TrackInfo,
}

impl Mp4Track {
    fn pts_us(&self, index: usize) -> i64 {
        let sample = &self.samples[index];
        let composition = sample.dts as i64 + sample.cts as i64 - self.edit_media_time;
        scale_to_us(composition, self.timescale) + self.empty_edit_us
    }

    fn dts_us(&self, index: usize) -> i64 {
        let sample = &self.samples[index];
        scale_to_us(sample.dts as i64 - self.edit_media_time, self.timescale) + self.empty_edit_us
    }

    fn duration_us(&self, index: usize) -> i64 {
        scale_to_us(self.samples[index].duration as i64, self.timescale)
    }
}

pub struct Mp4Demuxer {
    reader: FileReader,
    info: MediaInfo,
    tracks: Vec<Mp4Track>,
    selected: Vec<usize>,
    cursors: Vec<usize>,
}

struct BoxHeader {
    kind: [u8; 4],
    total_size: u64,
    header_len: u64,
}

impl BoxHeader {
    fn payload_size(&self) -> u64 {
        self.total_size.saturating_sub(self.header_len)
    }
}

fn read_box_header_from_file(reader: &mut FileReader) -> Result<Option<BoxHeader>, String> {
    if reader.remaining() < 8 {
        return Ok(None);
    }
    let start = reader.position();
    let size32 = reader.read_u32_be()?;
    let kind_bytes = reader.read_bytes(4)?;
    let kind = [kind_bytes[0], kind_bytes[1], kind_bytes[2], kind_bytes[3]];
    let mut header_len = 8u64;
    let total_size = match size32 {
        0 => reader.len() - start,
        1 => {
            header_len += 8;
            reader.read_u64_be()?
        }
        value => value as u64,
    };
    if &kind == b"uuid" {
        reader.skip(16);
        header_len += 16;
    }
    if total_size < header_len {
        return Err(format!(
            "Malformed box '{}' at offset {start}.",
            fourcc_to_string(&kind)
        ));
    }
    Ok(Some(BoxHeader {
        kind,
        total_size,
        header_len,
    }))
}

fn read_box_header(cursor: &mut ByteCursor) -> Result<Option<BoxHeader>, String> {
    if cursor.remaining() < 8 {
        return Ok(None);
    }
    let size32 = cursor.u32_be()?;
    let kind = cursor.fourcc()?;
    let mut header_len = 8u64;
    let total_size = match size32 {
        0 => header_len + cursor.remaining() as u64,
        1 => {
            header_len += 8;
            cursor.u64_be()?
        }
        value => value as u64,
    };
    if &kind == b"uuid" {
        cursor.skip(16)?;
        header_len += 16;
    }
    // Clamp malformed sizes to the available data instead of failing hard.
    let max_total = header_len + cursor.remaining() as u64;
    Ok(Some(BoxHeader {
        kind,
        total_size: total_size.clamp(header_len, max_total),
        header_len,
    }))
}

/// Iterates the child boxes of `data`, calling `visit(kind, payload)`.
fn for_each_box(
    data: &[u8],
    mut visit: impl FnMut(&[u8; 4], &[u8]) -> Result<(), String>,
) -> Result<(), String> {
    let mut cursor = ByteCursor::new(data);
    while let Some(header) = read_box_header(&mut cursor)? {
        let payload_len = header.payload_size().min(cursor.remaining() as u64) as usize;
        let payload = cursor.bytes(payload_len)?;
        visit(&header.kind, payload)?;
    }
    Ok(())
}

#[derive(Default)]
struct MovieHeader {
    timescale: u32,
    duration: u64,
}

#[derive(Default, Clone, Copy)]
struct TrackExtends {
    track_id: u32,
    default_sample_duration: u32,
    default_sample_size: u32,
    default_sample_flags: u32,
}

#[derive(Default)]
struct SampleTable {
    chunk_offsets: Vec<u64>,
    sample_to_chunk: Vec<(u32, u32)>, // (first_chunk, samples_per_chunk)
    sample_sizes: Vec<u32>,
    constant_sample_size: u32,
    sample_count: u32,
    time_to_sample: Vec<(u32, u32)>, // (count, delta)
    composition_offsets: Vec<(u32, i32)>,
    sync_samples: Option<Vec<u32>>,
}

struct SampleEntry {
    kind: TrackKind,
    codec_family: String,
    codec: Option<String>,
    description: Option<Vec<u8>>,
    width: u32,
    height: u32,
    sample_rate: u32,
    channels: u32,
    bit_depth: Option<u32>,
    subtitle_format: Option<String>,
}

struct ParsedTrack {
    id: u32,
    enabled: bool,
    timescale: u32,
    duration: u64,
    language: Option<String>,
    handler: [u8; 4],
    display_width: u32,
    display_height: u32,
    edit_list: Vec<(u64, i64)>,
    sample_entry: Option<SampleEntry>,
    table: SampleTable,
}

impl Mp4Demuxer {
    pub fn open(reader: FileReader, extension: &str) -> Result<Self, String> {
        let mut reader = reader;
        let mut movie = MovieHeader::default();
        let mut parsed_tracks: Vec<ParsedTrack> = Vec::new();
        let mut track_extends: Vec<TrackExtends> = Vec::new();
        let mut chapters: Vec<ChapterInfo> = Vec::new();
        let mut moof_positions: Vec<u64> = Vec::new();
        let mut brand = String::new();
        let mut found_moov = false;

        reader.seek(0);
        while let Some(header) = read_box_header_from_file(&mut reader)? {
            let payload_start = reader.position();
            let payload_size = header.payload_size();
            match &header.kind {
                b"ftyp" => {
                    let payload = reader.read_bytes(payload_size.min(64) as usize)?;
                    if payload.len() >= 4 {
                        brand = fourcc_to_string(&[payload[0], payload[1], payload[2], payload[3]]);
                    }
                }
                b"moov" => {
                    if payload_size > 512 * 1024 * 1024 {
                        return Err("Movie header is unexpectedly large.".to_string());
                    }
                    let payload = reader.read_bytes(payload_size as usize)?;
                    parse_moov(
                        &payload,
                        &mut movie,
                        &mut parsed_tracks,
                        &mut track_extends,
                        &mut chapters,
                    )?;
                    found_moov = true;
                }
                b"moof" => {
                    moof_positions.push(payload_start - header.header_len);
                }
                _ => {}
            }
            reader.seek(payload_start.saturating_add(payload_size));
            if payload_size == 0 && header.total_size == header.header_len {
                // Zero-sized box that does not advance: avoid an endless loop.
                if reader.remaining() < 8 {
                    break;
                }
            }
        }

        if !found_moov {
            return Err("No movie header (moov) found in this MP4 file.".to_string());
        }

        let movie_timescale = movie.timescale.max(1);
        let mut tracks: Vec<Mp4Track> = Vec::new();
        let mut first_of_kind: Vec<TrackKind> = Vec::new();
        for parsed in parsed_tracks {
            let Some(entry) = parsed.sample_entry else {
                continue;
            };
            let timescale = parsed.timescale.max(1);
            let samples = build_samples(&parsed.table);
            let (edit_media_time, empty_edit_us) =
                resolve_edit_list(&parsed.edit_list, movie_timescale);
            let defaults = track_extends
                .iter()
                .find(|extends| extends.track_id == parsed.id)
                .copied()
                .unwrap_or_default();
            let is_first = !first_of_kind.contains(&entry.kind);
            if is_first {
                first_of_kind.push(entry.kind);
            }

            let info = TrackInfo {
                id: parsed.id,
                kind: entry.kind,
                codec_family: entry.codec_family,
                codec: entry.codec,
                description: entry.description,
                width: entry.width,
                height: entry.height,
                display_width: if parsed.display_width > 0 {
                    parsed.display_width
                } else {
                    entry.width
                },
                display_height: if parsed.display_height > 0 {
                    parsed.display_height
                } else {
                    entry.height
                },
                frame_rate: None,
                sample_rate: entry.sample_rate,
                channels: entry.channels,
                bit_depth: entry.bit_depth,
                language: parsed.language,
                name: None,
                default: parsed.enabled && is_first,
                forced: false,
                default_duration_us: 0,
                codec_delay_us: 0,
                sample_count: samples.len() as u64,
                subtitle_format: entry.subtitle_format,
            };
            let _ = parsed.handler;
            let _ = parsed.duration;

            tracks.push(Mp4Track {
                id: parsed.id,
                kind: entry.kind,
                timescale,
                edit_media_time,
                empty_edit_us,
                samples,
                next_dts: 0,
                default_sample_duration: defaults.default_sample_duration,
                default_sample_size: defaults.default_sample_size,
                default_sample_flags: defaults.default_sample_flags,
                info,
            });
        }

        if tracks.is_empty() {
            return Err("This MP4 file has no playable tracks.".to_string());
        }

        for position in moof_positions {
            append_fragment(&mut reader, position, &mut tracks)?;
        }

        let mut duration_us = scale_to_us(movie.duration as i64, movie_timescale);
        for track in &mut tracks {
            finalize_track(track);
            if let Some(last) = track.samples.len().checked_sub(1) {
                let end = track.pts_us(last) + track.duration_us(last);
                duration_us = duration_us.max(end);
            }
        }

        let container = match brand.as_str() {
            "qt  " => "quicktime",
            _ if extension == "mov" => "quicktime",
            _ if extension == "3gp" || extension == "3g2" => "3gpp",
            _ => "mp4",
        };

        let info = MediaInfo {
            container: container.to_string(),
            duration_us,
            tracks: tracks.iter().map(|track| track.info.clone()).collect(),
            chapters,
            title: None,
            seekable: true,
        };

        let cursors = vec![0; tracks.len()];
        Ok(Self {
            reader,
            info,
            tracks,
            selected: Vec::new(),
            cursors,
        })
    }

    fn track_index(&self, id: u32) -> Option<usize> {
        self.tracks.iter().position(|track| track.id == id)
    }

    fn keyframe_at_or_before(&self, track: usize, target_us: i64) -> usize {
        let samples = &self.tracks[track].samples;
        if samples.is_empty() {
            return 0;
        }
        // Binary search on decode time (monotonic), then walk back to a key frame
        // whose presentation time is not after the target.
        let mut low = 0usize;
        let mut high = samples.len();
        while low < high {
            let mid = (low + high) / 2;
            if self.tracks[track].dts_us(mid) <= target_us {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        let mut index = low.saturating_sub(1);
        loop {
            if samples[index].keyframe && self.tracks[track].pts_us(index) <= target_us {
                return index;
            }
            if index == 0 {
                return 0;
            }
            index -= 1;
        }
    }

    fn index_for_time(&self, track: usize, target_us: i64) -> usize {
        let samples = &self.tracks[track].samples;
        if samples.is_empty() {
            return 0;
        }
        let mut low = 0usize;
        let mut high = samples.len();
        while low < high {
            let mid = (low + high) / 2;
            if self.tracks[track].pts_us(mid) <= target_us {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        let mut index = low.saturating_sub(1);
        // Non-video tracks must also start on a sync sample.
        while index > 0 && !samples[index].keyframe {
            index -= 1;
        }
        index
    }

    fn current_playhead_us(&self) -> Option<i64> {
        self.selected
            .iter()
            .filter_map(|&track| {
                let cursor = self.cursors[track];
                (cursor < self.tracks[track].samples.len())
                    .then(|| self.tracks[track].dts_us(cursor))
            })
            .min()
    }
}

impl Demuxer for Mp4Demuxer {
    fn info(&self) -> &MediaInfo {
        &self.info
    }

    fn select_tracks(&mut self, ids: &[u32]) {
        let playhead = self.current_playhead_us();
        let previous = self.selected.clone();
        self.selected = ids.iter().filter_map(|id| self.track_index(*id)).collect();
        if let Some(playhead) = playhead {
            for &track in &self.selected.clone() {
                if !previous.contains(&track) {
                    self.cursors[track] = self.index_for_time(track, playhead);
                }
            }
        }
    }

    fn seek(&mut self, target_us: i64) -> Result<i64, String> {
        let target_us = target_us.max(0);
        if self.info.duration_us > 0 && target_us >= self.info.duration_us {
            for &track in &self.selected.clone() {
                self.cursors[track] = self.tracks[track].samples.len();
            }
            return Ok(self.info.duration_us);
        }
        if target_us == 0 {
            for &track in &self.selected.clone() {
                let samples = &self.tracks[track].samples;
                self.cursors[track] = samples
                    .iter()
                    .position(|sample| sample.keyframe)
                    .unwrap_or(0);
            }
            return Ok(0);
        }
        let video = self
            .selected
            .iter()
            .copied()
            .find(|&track| self.tracks[track].kind == TrackKind::Video);
        let mut anchor_us = target_us;
        if let Some(track) = video {
            let index = self.keyframe_at_or_before(track, target_us);
            self.cursors[track] = index;
            if !self.tracks[track].samples.is_empty() {
                anchor_us = self.tracks[track].pts_us(index).min(target_us);
            }
        }
        for &track in &self.selected.clone() {
            if Some(track) == video {
                continue;
            }
            self.cursors[track] = self.index_for_time(track, anchor_us);
        }
        Ok(anchor_us)
    }

    fn next_samples(
        &mut self,
        max_bytes: usize,
        max_samples: usize,
    ) -> Result<(Vec<Sample>, bool), String> {
        let mut out: Vec<Sample> = Vec::new();
        let mut bytes = 0usize;
        loop {
            let mut best: Option<(usize, i64)> = None;
            for &track in &self.selected {
                let cursor = self.cursors[track];
                if cursor >= self.tracks[track].samples.len() {
                    continue;
                }
                let dts = self.tracks[track].dts_us(cursor);
                if best.is_none_or(|(_, best_dts)| dts < best_dts) {
                    best = Some((track, dts));
                }
            }
            let Some((track, _)) = best else {
                return Ok((out, true));
            };
            let cursor = self.cursors[track];
            let sample = self.tracks[track].samples[cursor];
            if !out.is_empty()
                && (bytes + sample.size as usize > max_bytes || out.len() >= max_samples)
            {
                return Ok((out, false));
            }
            let data = match self.reader.read_at(sample.offset, sample.size as usize) {
                Ok(data) => data,
                Err(_) => {
                    // Truncated file: stop this track here.
                    self.cursors[track] = self.tracks[track].samples.len();
                    continue;
                }
            };
            bytes += data.len();
            out.push(Sample {
                track_id: self.tracks[track].id,
                pts_us: self.tracks[track].pts_us(cursor),
                dts_us: self.tracks[track].dts_us(cursor),
                duration_us: self.tracks[track].duration_us(cursor),
                keyframe: sample.keyframe,
                data,
            });
            self.cursors[track] += 1;
        }
    }
}

// ---------------------------------------------------------------------------
// moov parsing
// ---------------------------------------------------------------------------

fn parse_moov(
    data: &[u8],
    movie: &mut MovieHeader,
    tracks: &mut Vec<ParsedTrack>,
    track_extends: &mut Vec<TrackExtends>,
    chapters: &mut Vec<ChapterInfo>,
) -> Result<(), String> {
    for_each_box(data, |kind, payload| {
        match kind {
            b"mvhd" => {
                let mut cursor = ByteCursor::new(payload);
                let version = cursor.u8()?;
                cursor.skip(3)?;
                if version == 1 {
                    cursor.skip(16)?;
                    movie.timescale = cursor.u32_be()?;
                    movie.duration = cursor.u64_be()?;
                } else {
                    cursor.skip(8)?;
                    movie.timescale = cursor.u32_be()?;
                    movie.duration = cursor.u32_be()? as u64;
                }
                if movie.duration == u32::MAX as u64 || movie.duration == u64::MAX {
                    movie.duration = 0;
                }
            }
            b"trak" => {
                if let Some(track) = parse_trak(payload)? {
                    tracks.push(track);
                }
            }
            b"mvex" => {
                for_each_box(payload, |kind, payload| {
                    if kind == b"trex" && payload.len() >= 24 {
                        let mut cursor = ByteCursor::new(payload);
                        cursor.skip(4)?;
                        let track_id = cursor.u32_be()?;
                        cursor.skip(4)?; // default_sample_description_index
                        let default_sample_duration = cursor.u32_be()?;
                        let default_sample_size = cursor.u32_be()?;
                        let default_sample_flags = cursor.u32_be()?;
                        track_extends.push(TrackExtends {
                            track_id,
                            default_sample_duration,
                            default_sample_size,
                            default_sample_flags,
                        });
                    }
                    Ok(())
                })?;
            }
            b"udta" => {
                for_each_box(payload, |kind, payload| {
                    if kind == b"chpl" {
                        if let Some(parsed) = parse_chpl(payload) {
                            *chapters = parsed;
                        }
                    }
                    Ok(())
                })?;
            }
            _ => {}
        }
        Ok(())
    })
}

fn parse_chpl(payload: &[u8]) -> Option<Vec<ChapterInfo>> {
    let mut cursor = ByteCursor::new(payload);
    let version = cursor.u8().ok()?;
    cursor.skip(3).ok()?;
    if version >= 1 {
        cursor.skip(4).ok()?;
    }
    let count = cursor.u8().ok()? as usize;
    let mut chapters = Vec::with_capacity(count);
    for _ in 0..count {
        let timestamp = cursor.u64_be().ok()?; // 100 ns units
        let title_len = cursor.u8().ok()? as usize;
        let title = cursor.bytes(title_len).ok()?;
        chapters.push(ChapterInfo {
            start_us: (timestamp / 10) as i64,
            end_us: None,
            title: String::from_utf8_lossy(title).trim().to_string(),
        });
    }
    for index in 0..chapters.len() {
        if index + 1 < chapters.len() {
            let next = chapters[index + 1].start_us;
            chapters[index].end_us = Some(next);
        }
    }
    Some(chapters)
}

fn parse_trak(data: &[u8]) -> Result<Option<ParsedTrack>, String> {
    let mut track = ParsedTrack {
        id: 0,
        enabled: true,
        timescale: 0,
        duration: 0,
        language: None,
        handler: [0; 4],
        display_width: 0,
        display_height: 0,
        edit_list: Vec::new(),
        sample_entry: None,
        table: SampleTable::default(),
    };

    for_each_box(data, |kind, payload| {
        match kind {
            b"tkhd" => {
                let mut cursor = ByteCursor::new(payload);
                let version = cursor.u8()?;
                let flags = cursor.u24_be()?;
                track.enabled = flags & 0x1 != 0;
                if version == 1 {
                    cursor.skip(16)?;
                    track.id = cursor.u32_be()?;
                    cursor.skip(4)?;
                    cursor.skip(8)?;
                } else {
                    cursor.skip(8)?;
                    track.id = cursor.u32_be()?;
                    cursor.skip(4)?;
                    cursor.skip(4)?;
                }
                cursor.skip(8)?; // reserved
                cursor.skip(2)?; // layer
                cursor.skip(2)?; // alternate group
                cursor.skip(2)?; // volume
                cursor.skip(2)?; // reserved
                cursor.skip(36)?; // matrix
                let width = cursor.u32_be()?;
                let height = cursor.u32_be()?;
                track.display_width = width >> 16;
                track.display_height = height >> 16;
            }
            b"edts" => {
                for_each_box(payload, |kind, payload| {
                    if kind == b"elst" {
                        let mut cursor = ByteCursor::new(payload);
                        let version = cursor.u8()?;
                        cursor.skip(3)?;
                        let count = cursor.u32_be()?;
                        for _ in 0..count.min(64) {
                            let (segment_duration, media_time) = if version == 1 {
                                (cursor.u64_be()?, cursor.i64_be()?)
                            } else {
                                (cursor.u32_be()? as u64, cursor.i32_be()? as i64)
                            };
                            cursor.skip(4)?; // media rate
                            track.edit_list.push((segment_duration, media_time));
                        }
                    }
                    Ok(())
                })?;
            }
            b"mdia" => {
                parse_mdia(payload, &mut track)?;
            }
            _ => {}
        }
        Ok(())
    })?;

    if track.sample_entry.is_none() || track.timescale == 0 {
        return Ok(None);
    }
    Ok(Some(track))
}

fn parse_mdia(data: &[u8], track: &mut ParsedTrack) -> Result<(), String> {
    for_each_box(data, |kind, payload| {
        match kind {
            b"mdhd" => {
                let mut cursor = ByteCursor::new(payload);
                let version = cursor.u8()?;
                cursor.skip(3)?;
                if version == 1 {
                    cursor.skip(16)?;
                    track.timescale = cursor.u32_be()?;
                    track.duration = cursor.u64_be()?;
                } else {
                    cursor.skip(8)?;
                    track.timescale = cursor.u32_be()?;
                    track.duration = cursor.u32_be()? as u64;
                }
                let language = cursor.u16_be()?;
                track.language = decode_language(language);
            }
            b"hdlr" => {
                let mut cursor = ByteCursor::new(payload);
                cursor.skip(4)?;
                cursor.skip(4)?;
                track.handler = cursor.fourcc()?;
            }
            b"minf" => {
                for_each_box(payload, |kind, payload| {
                    if kind == b"stbl" {
                        parse_stbl(payload, track)?;
                    }
                    Ok(())
                })?;
            }
            _ => {}
        }
        Ok(())
    })
}

fn decode_language(packed: u16) -> Option<String> {
    if packed == 0 || packed >= 0x8000 {
        return None;
    }
    let chars = [
        ((packed >> 10) & 0x1f) as u8 + 0x60,
        ((packed >> 5) & 0x1f) as u8 + 0x60,
        (packed & 0x1f) as u8 + 0x60,
    ];
    let language: String = chars.iter().map(|byte| *byte as char).collect();
    if language == "und" || !language.chars().all(|c| c.is_ascii_lowercase()) {
        None
    } else {
        Some(language)
    }
}

fn parse_stbl(data: &[u8], track: &mut ParsedTrack) -> Result<(), String> {
    for_each_box(data, |kind, payload| {
        let mut cursor = ByteCursor::new(payload);
        match kind {
            b"stsd" => {
                cursor.skip(4)?;
                let count = cursor.u32_be()?;
                if count > 0 {
                    let rest = cursor.rest();
                    track.sample_entry = parse_sample_entry(rest, &track.handler);
                }
            }
            b"stts" => {
                cursor.skip(4)?;
                let count = cursor.u32_be()? as usize;
                for _ in 0..count {
                    if cursor.remaining() < 8 {
                        break;
                    }
                    let sample_count = cursor.u32_be()?;
                    let delta = cursor.u32_be()?;
                    track.table.time_to_sample.push((sample_count, delta));
                }
            }
            b"ctts" => {
                let version = cursor.u8()?;
                cursor.skip(3)?;
                let count = cursor.u32_be()? as usize;
                for _ in 0..count {
                    if cursor.remaining() < 8 {
                        break;
                    }
                    let sample_count = cursor.u32_be()?;
                    let offset = if version == 1 {
                        cursor.i32_be()?
                    } else {
                        cursor.u32_be()? as i32
                    };
                    track.table.composition_offsets.push((sample_count, offset));
                }
            }
            b"stsc" => {
                cursor.skip(4)?;
                let count = cursor.u32_be()? as usize;
                for _ in 0..count {
                    if cursor.remaining() < 12 {
                        break;
                    }
                    let first_chunk = cursor.u32_be()?;
                    let samples_per_chunk = cursor.u32_be()?;
                    cursor.skip(4)?; // sample description index
                    track
                        .table
                        .sample_to_chunk
                        .push((first_chunk, samples_per_chunk));
                }
            }
            b"stsz" => {
                cursor.skip(4)?;
                let constant = cursor.u32_be()?;
                let count = cursor.u32_be()?;
                track.table.constant_sample_size = constant;
                track.table.sample_count = count;
                if constant == 0 {
                    for _ in 0..count {
                        if cursor.remaining() < 4 {
                            break;
                        }
                        track.table.sample_sizes.push(cursor.u32_be()?);
                    }
                }
            }
            b"stz2" => {
                cursor.skip(4)?;
                cursor.skip(3)?;
                let field_size = cursor.u8()?;
                let count = cursor.u32_be()?;
                track.table.sample_count = count;
                match field_size {
                    4 => {
                        let mut remaining = count;
                        while remaining > 0 && cursor.remaining() > 0 {
                            let byte = cursor.u8()?;
                            track.table.sample_sizes.push((byte >> 4) as u32);
                            remaining -= 1;
                            if remaining > 0 {
                                track.table.sample_sizes.push((byte & 0x0f) as u32);
                                remaining -= 1;
                            }
                        }
                    }
                    8 => {
                        for _ in 0..count {
                            if cursor.remaining() < 1 {
                                break;
                            }
                            track.table.sample_sizes.push(cursor.u8()? as u32);
                        }
                    }
                    16 => {
                        for _ in 0..count {
                            if cursor.remaining() < 2 {
                                break;
                            }
                            track.table.sample_sizes.push(cursor.u16_be()? as u32);
                        }
                    }
                    _ => {}
                }
            }
            b"stco" => {
                cursor.skip(4)?;
                let count = cursor.u32_be()? as usize;
                for _ in 0..count {
                    if cursor.remaining() < 4 {
                        break;
                    }
                    track.table.chunk_offsets.push(cursor.u32_be()? as u64);
                }
            }
            b"co64" => {
                cursor.skip(4)?;
                let count = cursor.u32_be()? as usize;
                for _ in 0..count {
                    if cursor.remaining() < 8 {
                        break;
                    }
                    track.table.chunk_offsets.push(cursor.u64_be()?);
                }
            }
            b"stss" => {
                cursor.skip(4)?;
                let count = cursor.u32_be()? as usize;
                let mut sync = Vec::with_capacity(count.min(1 << 20));
                for _ in 0..count {
                    if cursor.remaining() < 4 {
                        break;
                    }
                    sync.push(cursor.u32_be()?);
                }
                track.table.sync_samples = Some(sync);
            }
            _ => {}
        }
        Ok(())
    })
}

fn parse_sample_entry(data: &[u8], handler: &[u8; 4]) -> Option<SampleEntry> {
    let mut cursor = ByteCursor::new(data);
    let header = read_box_header(&mut cursor).ok()??;
    let entry_len = header.payload_size().min(cursor.remaining() as u64) as usize;
    let entry = cursor.bytes(entry_len).ok()?;
    let kind_code = header.kind;
    let kind_name = fourcc_to_string(&kind_code);
    let mut body = ByteCursor::new(entry);
    body.skip(6).ok()?; // reserved
    body.skip(2).ok()?; // data reference index

    let is_video = handler == b"vide"
        || matches!(
            &kind_code,
            b"avc1"
                | b"avc2"
                | b"avc3"
                | b"avc4"
                | b"hvc1"
                | b"hev1"
                | b"hvc2"
                | b"hev2"
                | b"vp08"
                | b"vp09"
                | b"av01"
                | b"mp4v"
                | b"dvh1"
                | b"dvhe"
        );
    let is_audio = handler == b"soun"
        || matches!(
            &kind_code,
            b"mp4a"
                | b"Opus"
                | b"fLaC"
                | b"ac-3"
                | b"ec-3"
                | b".mp3"
                | b"alac"
                | b"lpcm"
                | b"ipcm"
                | b"sowt"
                | b"twos"
                | b"fl32"
                | b"in24"
                | b"in32"
        );

    if is_video {
        body.skip(2).ok()?; // pre_defined
        body.skip(2).ok()?; // reserved
        body.skip(12).ok()?; // pre_defined
        let width = body.u16_be().ok()? as u32;
        let height = body.u16_be().ok()? as u32;
        body.skip(4).ok()?; // horizresolution
        body.skip(4).ok()?; // vertresolution
        body.skip(4).ok()?; // reserved
        body.skip(2).ok()?; // frame_count
        body.skip(32).ok()?; // compressorname
        body.skip(2).ok()?; // depth
        body.skip(2).ok()?; // pre_defined
        let children = body.rest();

        let mut avcc = None;
        let mut hvcc = None;
        let mut vpcc = None;
        let mut av1c = None;
        let _ = for_each_box(children, |kind, payload| {
            match kind {
                b"avcC" => avcc = Some(payload.to_vec()),
                b"hvcC" => hvcc = Some(payload.to_vec()),
                b"vpcC" => {
                    if payload.len() > 4 {
                        vpcc = Some(payload[4..].to_vec());
                    }
                }
                b"av1C" => av1c = Some(payload.to_vec()),
                _ => {}
            }
            Ok(())
        });

        let params = match &kind_code {
            b"avc1" | b"avc2" | b"avc3" | b"avc4" => avcc
                .as_deref()
                .map(codec::avc_params)
                .unwrap_or_else(|| codec::unsupported_video("h264")),
            b"hvc1" | b"hev1" | b"hvc2" | b"hev2" | b"dvh1" | b"dvhe" => hvcc
                .as_deref()
                .map(codec::hevc_params)
                .unwrap_or_else(|| codec::unsupported_video("hevc")),
            b"vp08" => codec::vp8_params(),
            b"vp09" => vpcc
                .as_deref()
                .map(codec::vp9_params_from_vpcc)
                .unwrap_or_else(|| codec::VideoCodecParams {
                    family: "vp9".to_string(),
                    codec: Some("vp09.00.10.08".to_string()),
                    description: None,
                }),
            b"av01" => av1c
                .as_deref()
                .map(codec::av1_params_from_av1c)
                .unwrap_or_else(|| codec::unsupported_video("av1")),
            b"mp4v" => codec::unsupported_video("mpeg4"),
            _ => codec::unsupported_video(&kind_name),
        };

        return Some(SampleEntry {
            kind: TrackKind::Video,
            codec_family: params.family,
            codec: params.codec,
            description: params.description,
            width,
            height,
            sample_rate: 0,
            channels: 0,
            bit_depth: None,
            subtitle_format: None,
        });
    }

    if is_audio {
        let version = body.u16_be().ok()?;
        body.skip(2).ok()?; // revision
        body.skip(4).ok()?; // vendor
        let mut channels = body.u16_be().ok()? as u32;
        let mut sample_size = body.u16_be().ok()? as u32;
        body.skip(2).ok()?; // compression id
        body.skip(2).ok()?; // packet size
        let mut sample_rate = body.u32_be().ok()? >> 16;
        let mut lpcm_flags = 0u32;
        if version == 1 {
            body.skip(16).ok()?;
        } else if version == 2 {
            body.skip(4).ok()?; // sizeOfStructOnly
            let rate_bits = body.u64_be().ok()?;
            sample_rate = f64::from_bits(rate_bits).round() as u32;
            channels = body.u32_be().ok()?;
            body.skip(4).ok()?; // always 0x7F000000
            sample_size = body.u32_be().ok()?;
            lpcm_flags = body.u32_be().ok()?;
            body.skip(4).ok()?; // constBytesPerAudioPacket
            body.skip(4).ok()?; // constLPCMFramesPerAudioPacket
        }
        let children = body.rest();

        let mut esds = None;
        let mut dops = None;
        let mut dfla = None;
        let mut pcmc = None;
        let _ = for_each_box(children, |kind, payload| {
            match kind {
                b"esds" => {
                    if payload.len() > 4 {
                        esds = Some(payload[4..].to_vec());
                    }
                }
                b"wave" => {
                    // QuickTime wraps esds inside wave.
                    let _ = for_each_box(payload, |kind, payload| {
                        if kind == b"esds" && payload.len() > 4 {
                            esds = Some(payload[4..].to_vec());
                        }
                        Ok(())
                    });
                }
                b"dOps" => dops = Some(payload.to_vec()),
                b"dfLa" => {
                    if payload.len() > 4 {
                        dfla = Some(payload[4..].to_vec());
                    }
                }
                b"pcmC" if payload.len() >= 6 => {
                    pcmc = Some((payload[4], payload[5]));
                }
                _ => {}
            }
            Ok(())
        });

        let params = match &kind_code {
            b"mp4a" => match esds.as_deref().and_then(codec::parse_esds) {
                Some((0x40 | 0x66 | 0x67 | 0x68, info)) => {
                    codec::aac_params(info.as_deref().unwrap_or(&[]))
                }
                Some((0x69 | 0x6b, _)) => codec::mp3_params(),
                Some((0xa5, _)) => codec::ac3_params(false),
                Some((0xa6, _)) => codec::ac3_params(true),
                Some((0xdd, info)) => codec::vorbis_params(info),
                Some((other, _)) => codec::unsupported_audio(&format!("mpeg4-{other:#x}")),
                None => codec::aac_params(&[]),
            },
            b"Opus" => codec::opus_params(dops.as_deref().and_then(codec::opus_head_from_dops)),
            b"fLaC" => codec::flac_params(dfla.as_deref().map(codec::flac_description_from_dfla)),
            b"ac-3" => codec::ac3_params(false),
            b"ec-3" => codec::ac3_params(true),
            b".mp3" => codec::mp3_params(),
            b"sowt" => codec::pcm_params(16, false, true),
            b"twos" => codec::pcm_params(16, false, false),
            b"ipcm" => {
                let (flags, size) = pcmc.unwrap_or((0, sample_size as u8));
                codec::pcm_params(size as u32, false, flags & 1 == 1)
            }
            b"lpcm" => codec::pcm_params(sample_size, lpcm_flags & 0x1 != 0, lpcm_flags & 0x2 == 0),
            _ => codec::unsupported_audio(&kind_name),
        };

        return Some(SampleEntry {
            kind: TrackKind::Audio,
            codec_family: params.family,
            codec: params.codec,
            description: params.description,
            width: 0,
            height: 0,
            sample_rate: params.sample_rate.unwrap_or(sample_rate),
            channels: params.channels.unwrap_or(channels),
            bit_depth: (sample_size > 0).then_some(sample_size),
            subtitle_format: None,
        });
    }

    let subtitle_format = match &kind_code {
        b"tx3g" => Some("tx3g"),
        b"wvtt" => Some("wvtt"),
        b"text" => Some("qt-text"),
        _ => None,
    };
    if handler == b"subt" || handler == b"sbtl" || handler == b"text" || subtitle_format.is_some() {
        return Some(SampleEntry {
            kind: TrackKind::Subtitle,
            codec_family: kind_name.clone(),
            codec: subtitle_format.map(ToString::to_string),
            description: None,
            width: 0,
            height: 0,
            sample_rate: 0,
            channels: 0,
            bit_depth: None,
            subtitle_format: subtitle_format.map(ToString::to_string),
        });
    }

    None
}

fn build_samples(table: &SampleTable) -> Vec<Mp4Sample> {
    let sample_count = if table.constant_sample_size > 0 {
        table.sample_count as usize
    } else {
        table.sample_sizes.len()
    };
    if sample_count == 0 || table.chunk_offsets.is_empty() || table.sample_to_chunk.is_empty() {
        return Vec::new();
    }

    let mut samples: Vec<Mp4Sample> = Vec::with_capacity(sample_count);

    // Chunk layout → offsets.
    let chunk_count = table.chunk_offsets.len();
    let mut sample_index = 0usize;
    for (entry_index, &(first_chunk, samples_per_chunk)) in table.sample_to_chunk.iter().enumerate()
    {
        let next_first_chunk = table
            .sample_to_chunk
            .get(entry_index + 1)
            .map(|entry| entry.0 as usize)
            .unwrap_or(chunk_count + 1);
        let first = (first_chunk as usize).max(1);
        for chunk in first..next_first_chunk.min(chunk_count + 1) {
            let mut offset = table.chunk_offsets[chunk - 1];
            for _ in 0..samples_per_chunk {
                if sample_index >= sample_count {
                    break;
                }
                let size = if table.constant_sample_size > 0 {
                    table.constant_sample_size
                } else {
                    table.sample_sizes[sample_index]
                };
                samples.push(Mp4Sample {
                    offset,
                    size,
                    dts: 0,
                    cts: 0,
                    duration: 0,
                    keyframe: true,
                });
                offset = offset.saturating_add(size as u64);
                sample_index += 1;
            }
            if sample_index >= sample_count {
                break;
            }
        }
        if sample_index >= sample_count {
            break;
        }
    }
    samples.truncate(sample_index);

    // Decode timestamps.
    let mut dts = 0u64;
    let mut index = 0usize;
    for &(count, delta) in &table.time_to_sample {
        for _ in 0..count {
            if index >= samples.len() {
                break;
            }
            samples[index].dts = dts;
            samples[index].duration = delta;
            dts = dts.saturating_add(delta as u64);
            index += 1;
        }
    }
    // Any samples without timing (malformed stts) inherit the last delta.
    let last_delta = table
        .time_to_sample
        .last()
        .map(|entry| entry.1)
        .unwrap_or(0);
    while index < samples.len() {
        samples[index].dts = dts;
        samples[index].duration = last_delta;
        dts = dts.saturating_add(last_delta as u64);
        index += 1;
    }

    // Composition offsets.
    let mut index = 0usize;
    for &(count, offset) in &table.composition_offsets {
        for _ in 0..count {
            if index >= samples.len() {
                break;
            }
            samples[index].cts = offset;
            index += 1;
        }
    }

    // Sync samples.
    if let Some(sync) = &table.sync_samples {
        for sample in &mut samples {
            sample.keyframe = false;
        }
        for &number in sync {
            if let Some(sample) = samples.get_mut(number.saturating_sub(1) as usize) {
                sample.keyframe = true;
            }
        }
    }

    samples
}

fn resolve_edit_list(edit_list: &[(u64, i64)], movie_timescale: u32) -> (i64, i64) {
    let mut empty_edit_us = 0i64;
    let mut media_time = 0i64;
    for &(segment_duration, entry_media_time) in edit_list {
        if entry_media_time == -1 {
            empty_edit_us += scale_to_us(segment_duration as i64, movie_timescale);
            continue;
        }
        media_time = entry_media_time.max(0);
        break;
    }
    (media_time, empty_edit_us)
}

fn finalize_track(track: &mut Mp4Track) {
    if track.samples.is_empty() {
        return;
    }
    // Most common sample duration → frame rate / default duration.
    let mut histogram: Vec<(u32, u32)> = Vec::new();
    for sample in track.samples.iter().take(4096) {
        if sample.duration == 0 {
            continue;
        }
        if let Some(entry) = histogram
            .iter_mut()
            .find(|entry| entry.0 == sample.duration)
        {
            entry.1 += 1;
        } else {
            histogram.push((sample.duration, 1));
        }
    }
    if let Some(&(duration, _)) = histogram.iter().max_by_key(|entry| entry.1) {
        track.info.default_duration_us = scale_to_us(duration as i64, track.timescale);
        if track.kind == TrackKind::Video && duration > 0 {
            track.info.frame_rate = Some(track.timescale as f64 / duration as f64);
        }
    }
    track.info.sample_count = track.samples.len() as u64;
    if track.kind == TrackKind::Audio && track.info.default_duration_us == 0 {
        track.info.default_duration_us = 0;
    }
}

// ---------------------------------------------------------------------------
// Fragmented MP4
// ---------------------------------------------------------------------------

fn append_fragment(
    reader: &mut FileReader,
    moof_start: u64,
    tracks: &mut [Mp4Track],
) -> Result<(), String> {
    reader.seek(moof_start);
    let Some(header) = read_box_header_from_file(reader)? else {
        return Ok(());
    };
    if &header.kind != b"moof" {
        return Ok(());
    }
    let payload_size = header.payload_size();
    if payload_size > 64 * 1024 * 1024 {
        return Err("Movie fragment is unexpectedly large.".to_string());
    }
    let payload = reader.read_bytes(payload_size as usize)?;

    for_each_box(&payload, |kind, traf| {
        if kind != b"traf" {
            return Ok(());
        }
        let mut track_id = 0u32;
        let mut tfhd_flags = 0u32;
        let mut base_data_offset: Option<u64> = None;
        let mut default_duration: Option<u32> = None;
        let mut default_size: Option<u32> = None;
        let mut default_flags: Option<u32> = None;
        let mut decode_time: Option<u64> = None;
        let mut truns: Vec<Vec<u8>> = Vec::new();

        for_each_box(traf, |kind, payload| {
            let mut cursor = ByteCursor::new(payload);
            match kind {
                b"tfhd" => {
                    cursor.skip(1)?;
                    tfhd_flags = cursor.u24_be()?;
                    track_id = cursor.u32_be()?;
                    if tfhd_flags & 0x1 != 0 {
                        base_data_offset = Some(cursor.u64_be()?);
                    }
                    if tfhd_flags & 0x2 != 0 {
                        cursor.skip(4)?;
                    }
                    if tfhd_flags & 0x8 != 0 {
                        default_duration = Some(cursor.u32_be()?);
                    }
                    if tfhd_flags & 0x10 != 0 {
                        default_size = Some(cursor.u32_be()?);
                    }
                    if tfhd_flags & 0x20 != 0 {
                        default_flags = Some(cursor.u32_be()?);
                    }
                }
                b"tfdt" => {
                    let version = cursor.u8()?;
                    cursor.skip(3)?;
                    decode_time = Some(if version == 1 {
                        cursor.u64_be()?
                    } else {
                        cursor.u32_be()? as u64
                    });
                }
                b"trun" => truns.push(payload.to_vec()),
                _ => {}
            }
            Ok(())
        })?;

        let Some(track) = tracks.iter_mut().find(|track| track.id == track_id) else {
            return Ok(());
        };
        let base = base_data_offset.unwrap_or(moof_start);
        let mut dts = decode_time.unwrap_or(track.next_dts);
        let duration_default = default_duration.unwrap_or(track.default_sample_duration);
        let size_default = default_size.unwrap_or(track.default_sample_size);
        let flags_default = default_flags.unwrap_or(track.default_sample_flags);
        let mut running_offset = base;

        for trun in &truns {
            let mut cursor = ByteCursor::new(trun);
            let version = cursor.u8()?;
            let flags = cursor.u24_be()?;
            let sample_count = cursor.u32_be()?;
            let mut data_offset = running_offset;
            if flags & 0x1 != 0 {
                data_offset = (base as i64 + cursor.i32_be()? as i64).max(0) as u64;
            }
            let first_sample_flags = if flags & 0x4 != 0 {
                Some(cursor.u32_be()?)
            } else {
                None
            };
            let mut offset = data_offset;
            for index in 0..sample_count {
                let duration = if flags & 0x100 != 0 {
                    cursor.u32_be()?
                } else {
                    duration_default
                };
                let size = if flags & 0x200 != 0 {
                    cursor.u32_be()?
                } else {
                    size_default
                };
                let sample_flags = if flags & 0x400 != 0 {
                    cursor.u32_be()?
                } else if index == 0 {
                    first_sample_flags.unwrap_or(flags_default)
                } else {
                    flags_default
                };
                let cts = if flags & 0x800 != 0 {
                    if version == 0 {
                        cursor.u32_be()? as i32
                    } else {
                        cursor.i32_be()?
                    }
                } else {
                    0
                };
                let non_sync = (sample_flags >> 16) & 1 == 1;
                let depends_on = (sample_flags >> 24) & 3;
                let keyframe = if track.kind == TrackKind::Video {
                    !non_sync || depends_on == 2
                } else {
                    true
                };
                track.samples.push(Mp4Sample {
                    offset,
                    size,
                    dts,
                    cts,
                    duration,
                    keyframe,
                });
                offset = offset.saturating_add(size as u64);
                dts = dts.saturating_add(duration as u64);
            }
            running_offset = offset;
        }
        track.next_dts = dts;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_packed_language() {
        // "eng" = e(0x65) n(0x6e) g(0x67) → (5<<10)|(14<<5)|7
        assert_eq!(
            decode_language((5 << 10) | (14 << 5) | 7).as_deref(),
            Some("eng")
        );
        assert_eq!(decode_language((21 << 10) | (14 << 5) | 4), None); // "und"
        assert_eq!(decode_language(0), None);
    }

    #[test]
    fn builds_samples_from_chunk_tables() {
        let table = SampleTable {
            chunk_offsets: vec![100, 500],
            sample_to_chunk: vec![(1, 2), (2, 1)],
            sample_sizes: vec![10, 20, 30],
            constant_sample_size: 0,
            sample_count: 3,
            time_to_sample: vec![(3, 1000)],
            composition_offsets: vec![(1, 2000), (2, 0)],
            sync_samples: Some(vec![1, 3]),
        };
        let samples = build_samples(&table);
        assert_eq!(samples.len(), 3);
        assert_eq!(samples[0].offset, 100);
        assert_eq!(samples[1].offset, 110);
        assert_eq!(samples[2].offset, 500);
        assert_eq!(samples[1].dts, 1000);
        assert_eq!(samples[0].cts, 2000);
        assert!(samples[0].keyframe);
        assert!(!samples[1].keyframe);
        assert!(samples[2].keyframe);
    }

    #[test]
    fn edit_list_resolves_offset_and_empty_edit() {
        let (media_time, empty) = resolve_edit_list(&[(500, -1), (10_000, 1024)], 1000);
        assert_eq!(media_time, 1024);
        assert_eq!(empty, 500_000);
    }
}
