//! Matroska / WebM demuxer (EBML).
//!
//! Parses the segment headers (Info, Tracks, Cues, Chapters), then streams
//! clusters on demand. Supports SimpleBlock and BlockGroup, all three lacing
//! modes, header-stripping and zlib content compression, cue-based seeking
//! and a scan fallback for files without cues.

use std::collections::VecDeque;
use std::io::Read;

use super::{
    codec,
    reader::{ByteCursor, FileReader},
    ChapterInfo, Demuxer, MediaInfo, Sample, TrackInfo, TrackKind,
};

const ID_EBML: u32 = 0x1A45_DFA3;
const ID_DOC_TYPE: u32 = 0x4282;
const ID_SEGMENT: u32 = 0x1853_8067;
const ID_SEEK_HEAD: u32 = 0x114D_9B74;
const ID_SEEK: u32 = 0x4DBB;
const ID_SEEK_ID: u32 = 0x53AB;
const ID_SEEK_POSITION: u32 = 0x53AC;
const ID_INFO: u32 = 0x1549_A966;
const ID_TIMESTAMP_SCALE: u32 = 0x2AD7B1;
const ID_DURATION: u32 = 0x4489;
const ID_TITLE: u32 = 0x7BA9;
const ID_TRACKS: u32 = 0x1654_AE6B;
const ID_TRACK_ENTRY: u32 = 0xAE;
const ID_TRACK_NUMBER: u32 = 0xD7;
const ID_TRACK_TYPE: u32 = 0x83;
const ID_FLAG_ENABLED: u32 = 0xB9;
const ID_FLAG_DEFAULT: u32 = 0x88;
const ID_FLAG_FORCED: u32 = 0x55AA;
const ID_DEFAULT_DURATION: u32 = 0x23E383;
const ID_NAME: u32 = 0x536E;
const ID_LANGUAGE: u32 = 0x22B59C;
const ID_LANGUAGE_BCP47: u32 = 0x22B59D;
const ID_CODEC_ID: u32 = 0x86;
const ID_CODEC_PRIVATE: u32 = 0x63A2;
const ID_CODEC_DELAY: u32 = 0x56AA;
const ID_VIDEO: u32 = 0xE0;
const ID_PIXEL_WIDTH: u32 = 0xB0;
const ID_PIXEL_HEIGHT: u32 = 0xBA;
const ID_DISPLAY_WIDTH: u32 = 0x54B0;
const ID_DISPLAY_HEIGHT: u32 = 0x54BA;
const ID_AUDIO: u32 = 0xE1;
const ID_SAMPLING_FREQUENCY: u32 = 0xB5;
const ID_OUTPUT_SAMPLING_FREQUENCY: u32 = 0x78B5;
const ID_CHANNELS: u32 = 0x9F;
const ID_BIT_DEPTH: u32 = 0x6264;
const ID_CONTENT_ENCODINGS: u32 = 0x6D80;
const ID_CONTENT_ENCODING: u32 = 0x6240;
const ID_CONTENT_ENCODING_TYPE: u32 = 0x5033;
const ID_CONTENT_COMPRESSION: u32 = 0x5034;
const ID_CONTENT_COMP_ALGO: u32 = 0x4254;
const ID_CONTENT_COMP_SETTINGS: u32 = 0x4255;
const ID_CUES: u32 = 0x1C53_BB6B;
const ID_CUE_POINT: u32 = 0xBB;
const ID_CUE_TIME: u32 = 0xB3;
const ID_CUE_TRACK_POSITIONS: u32 = 0xB7;
const ID_CUE_TRACK: u32 = 0xF7;
const ID_CUE_CLUSTER_POSITION: u32 = 0xF1;
const ID_CHAPTERS: u32 = 0x1043_A770;
const ID_EDITION_ENTRY: u32 = 0x45B9;
const ID_CHAPTER_ATOM: u32 = 0xB6;
const ID_CHAPTER_TIME_START: u32 = 0x91;
const ID_CHAPTER_TIME_END: u32 = 0x92;
const ID_CHAPTER_DISPLAY: u32 = 0x80;
const ID_CHAP_STRING: u32 = 0x85;
const ID_CLUSTER: u32 = 0x1F43_B675;
const ID_CLUSTER_TIMESTAMP: u32 = 0xE7;
const ID_SIMPLE_BLOCK: u32 = 0xA3;
const ID_BLOCK_GROUP: u32 = 0xA0;
const ID_BLOCK: u32 = 0xA1;
const ID_BLOCK_DURATION: u32 = 0x9B;
const ID_REFERENCE_BLOCK: u32 = 0xFB;

const MAX_HEADER_ELEMENT: u64 = 256 * 1024 * 1024;
const MAX_BLOCK_SIZE: u64 = 256 * 1024 * 1024;
const CODEC_PROBE_LIMIT: u64 = 48 * 1024 * 1024;

struct ElementHeader {
    id: u32,
    size: Option<u64>,
    start: u64,
    data_start: u64,
}

impl ElementHeader {
    fn end(&self) -> Option<u64> {
        self.size.map(|size| self.data_start.saturating_add(size))
    }
}

fn vint_length(first: u8) -> Option<u32> {
    if first == 0 {
        return None;
    }
    Some(first.leading_zeros() + 1)
}

fn read_element_header(reader: &mut FileReader) -> Result<Option<ElementHeader>, String> {
    if reader.remaining() < 2 {
        return Ok(None);
    }
    let start = reader.position();
    let first = reader.read_u8()?;
    let Some(id_len) = vint_length(first) else {
        return Err(format!("Invalid EBML element ID at offset {start}."));
    };
    if id_len > 4 {
        return Err(format!("Invalid EBML element ID at offset {start}."));
    }
    let mut id = first as u32;
    for _ in 1..id_len {
        id = (id << 8) | reader.read_u8()? as u32;
    }

    if reader.remaining() < 1 {
        return Ok(None);
    }
    let first = reader.read_u8()?;
    let Some(size_len) = vint_length(first) else {
        return Err(format!("Invalid EBML element size at offset {start}."));
    };
    let mask = if size_len >= 8 {
        0x00
    } else {
        (1u8 << (8 - size_len)) - 1
    };
    let mut size = (first & mask) as u64;
    let mut all_ones = (first & mask) == mask;
    for _ in 1..size_len {
        let byte = reader.read_u8()?;
        size = (size << 8) | byte as u64;
        all_ones &= byte == 0xff;
    }
    Ok(Some(ElementHeader {
        id,
        size: if all_ones { None } else { Some(size) },
        start,
        data_start: reader.position(),
    }))
}

fn cursor_vint_id(cursor: &mut ByteCursor) -> Result<u32, String> {
    let first = cursor.u8()?;
    let Some(len) = vint_length(first) else {
        return Err("Invalid EBML ID.".to_string());
    };
    if len > 4 {
        return Err("Invalid EBML ID.".to_string());
    }
    let mut id = first as u32;
    for _ in 1..len {
        id = (id << 8) | cursor.u8()? as u32;
    }
    Ok(id)
}

/// Reads a size/data vint (marker bit removed). Returns (value, unknown).
fn cursor_vint(cursor: &mut ByteCursor) -> Result<(u64, bool), String> {
    let first = cursor.u8()?;
    let Some(len) = vint_length(first) else {
        return Err("Invalid EBML vint.".to_string());
    };
    let mask = if len >= 8 {
        0x00
    } else {
        (1u8 << (8 - len)) - 1
    };
    let mut value = (first & mask) as u64;
    let mut all_ones = (first & mask) == mask;
    for _ in 1..len {
        let byte = cursor.u8()?;
        value = (value << 8) | byte as u64;
        all_ones &= byte == 0xff;
    }
    Ok((value, all_ones))
}

fn cursor_signed_vint(cursor: &mut ByteCursor) -> Result<i64, String> {
    let first = cursor.u8()?;
    let Some(len) = vint_length(first) else {
        return Err("Invalid EBML vint.".to_string());
    };
    let mask = if len >= 8 {
        0x00
    } else {
        (1u8 << (8 - len)) - 1
    };
    let mut value = (first & mask) as u64;
    for _ in 1..len {
        value = (value << 8) | cursor.u8()? as u64;
    }
    let bias = (1i64 << (7 * len as i64 - 1)) - 1;
    Ok(value as i64 - bias)
}

/// Iterates child elements of an in-memory master element.
fn for_each_child(
    data: &[u8],
    mut visit: impl FnMut(u32, &[u8]) -> Result<(), String>,
) -> Result<(), String> {
    let mut cursor = ByteCursor::new(data);
    while cursor.remaining() >= 2 {
        let id = cursor_vint_id(&mut cursor)?;
        let (size, unknown) = cursor_vint(&mut cursor)?;
        let size = if unknown {
            cursor.remaining()
        } else {
            (size as usize).min(cursor.remaining())
        };
        let payload = cursor.bytes(size)?;
        visit(id, payload)?;
    }
    Ok(())
}

fn ebml_uint(data: &[u8]) -> u64 {
    data.iter()
        .take(8)
        .fold(0u64, |acc, byte| (acc << 8) | *byte as u64)
}

fn ebml_float(data: &[u8]) -> f64 {
    match data.len() {
        4 => f32::from_be_bytes([data[0], data[1], data[2], data[3]]) as f64,
        8 => {
            let mut raw = [0u8; 8];
            raw.copy_from_slice(data);
            f64::from_be_bytes(raw)
        }
        _ => 0.0,
    }
}

fn ebml_string(data: &[u8]) -> String {
    let end = data
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(data.len());
    String::from_utf8_lossy(&data[..end]).trim().to_string()
}

#[derive(Clone, Debug)]
struct CuePoint {
    time_us: i64,
    track: u32,
    cluster_position: u64,
}

struct MkvTrack {
    number: u32,
    kind: TrackKind,
    codec_id: String,
    default_duration_ns: u64,
    header_strip: Vec<u8>,
    zlib: bool,
    unsupported_encoding: bool,
    needs_codec_probe: bool,
    info: TrackInfo,
}

impl MkvTrack {
    fn decode_frame(&self, frame: &[u8]) -> Result<Vec<u8>, String> {
        let mut data = if self.header_strip.is_empty() {
            frame.to_vec()
        } else {
            let mut data = Vec::with_capacity(self.header_strip.len() + frame.len());
            data.extend_from_slice(&self.header_strip);
            data.extend_from_slice(frame);
            data
        };
        if self.zlib {
            let mut decoder = flate2::read::ZlibDecoder::new(&data[..]);
            let mut inflated = Vec::with_capacity(data.len() * 3);
            decoder
                .read_to_end(&mut inflated)
                .map_err(|error| format!("Could not inflate compressed frame: {error}"))?;
            data = inflated;
        }
        Ok(data)
    }
}

pub struct MkvDemuxer {
    reader: FileReader,
    info: MediaInfo,
    tracks: Vec<MkvTrack>,
    segment_start: u64,
    segment_end: u64,
    timestamp_scale: u64,
    cues: Vec<CuePoint>,
    cluster_index: Vec<(i64, u64)>,
    first_cluster: u64,
    pos: u64,
    cluster_timestamp: i64,
    selected: Vec<usize>,
    pending: VecDeque<Sample>,
    await_video_keyframe: bool,
    eof: bool,
}

#[derive(Default)]
struct SegmentHeaders {
    timestamp_scale: u64,
    duration_units: f64,
    title: Option<String>,
    tracks: Vec<MkvTrack>,
    cues: Vec<CuePoint>,
    chapters: Vec<ChapterInfo>,
    seek_head: Vec<(u32, u64)>,
    saw_info: bool,
    saw_tracks: bool,
    saw_cues: bool,
    saw_chapters: bool,
}

impl MkvDemuxer {
    pub fn open(reader: FileReader) -> Result<Self, String> {
        let mut reader = reader;
        reader.seek(0);
        let Some(ebml) = read_element_header(&mut reader)? else {
            return Err("File is empty.".to_string());
        };
        if ebml.id != ID_EBML {
            return Err("Not a Matroska/WebM file.".to_string());
        }
        let mut doc_type = String::from("matroska");
        if let Some(size) = ebml.size {
            let header = reader.read_bytes(size.min(4096) as usize)?;
            for_each_child(&header, |id, payload| {
                if id == ID_DOC_TYPE {
                    doc_type = ebml_string(payload);
                }
                Ok(())
            })?;
            reader.seek(ebml.data_start + size);
        }

        let mut segment = None;
        while let Some(element) = read_element_header(&mut reader)? {
            if element.id == ID_SEGMENT {
                segment = Some(element);
                break;
            }
            match element.end() {
                Some(end) => reader.seek(end),
                None => break,
            }
        }
        let Some(segment) = segment else {
            return Err("No Matroska segment found.".to_string());
        };
        let segment_start = segment.data_start;
        let segment_end = segment.end().unwrap_or(reader.len()).min(reader.len());

        let mut headers = SegmentHeaders {
            timestamp_scale: 1_000_000,
            ..SegmentHeaders::default()
        };
        let mut first_cluster = None;

        reader.seek(segment_start);
        while reader.position() < segment_end {
            let Some(element) = read_element_header(&mut reader)? else {
                break;
            };
            if element.id == ID_CLUSTER {
                first_cluster = Some(element.start);
                break;
            }
            let handled = Self::parse_level1(&mut reader, &element, &mut headers)?;
            if !handled {
                match element.end() {
                    Some(end) => reader.seek(end),
                    None => break,
                }
            }
        }

        // Pick up Cues / Chapters / Tracks stored after the clusters.
        for (id, position) in headers.seek_head.clone() {
            let wanted = (id == ID_CUES && !headers.saw_cues)
                || (id == ID_CHAPTERS && !headers.saw_chapters)
                || (id == ID_TRACKS && !headers.saw_tracks)
                || (id == ID_INFO && !headers.saw_info);
            if !wanted {
                continue;
            }
            let absolute = segment_start.saturating_add(position);
            if absolute >= segment_end {
                continue;
            }
            reader.seek(absolute);
            if let Ok(Some(element)) = read_element_header(&mut reader) {
                if element.id == id {
                    let _ = Self::parse_level1(&mut reader, &element, &mut headers);
                }
            }
        }

        if headers.tracks.is_empty() {
            return Err("This Matroska file has no tracks.".to_string());
        }
        let Some(first_cluster) = first_cluster else {
            return Err("This Matroska file has no clusters.".to_string());
        };

        let timestamp_scale = headers.timestamp_scale.max(1);
        let duration_us =
            ((headers.duration_units * timestamp_scale as f64) / 1000.0).round() as i64;
        headers.cues.sort_by_key(|cue| cue.time_us);

        let container = if doc_type == "webm" {
            "webm"
        } else {
            "matroska"
        };
        let info = MediaInfo {
            container: container.to_string(),
            duration_us: duration_us.max(0),
            tracks: headers
                .tracks
                .iter()
                .map(|track| track.info.clone())
                .collect(),
            chapters: headers.chapters,
            title: headers.title,
            seekable: true,
        };

        let mut demuxer = Self {
            reader,
            info,
            tracks: headers.tracks,
            segment_start,
            segment_end,
            timestamp_scale,
            cues: headers.cues,
            cluster_index: Vec::new(),
            first_cluster,
            pos: first_cluster,
            cluster_timestamp: 0,
            selected: Vec::new(),
            pending: VecDeque::new(),
            await_video_keyframe: true,
            eof: false,
        };
        demuxer.probe_missing_codecs()?;
        Ok(demuxer)
    }

    fn parse_level1(
        reader: &mut FileReader,
        element: &ElementHeader,
        headers: &mut SegmentHeaders,
    ) -> Result<bool, String> {
        let Some(size) = element.size else {
            return Ok(false);
        };
        if !matches!(
            element.id,
            ID_SEEK_HEAD | ID_INFO | ID_TRACKS | ID_CUES | ID_CHAPTERS
        ) {
            return Ok(false);
        }
        if size > MAX_HEADER_ELEMENT {
            return Err("Matroska header element is unexpectedly large.".to_string());
        }
        let data = reader.read_bytes(size as usize)?;
        match element.id {
            ID_SEEK_HEAD => {
                for_each_child(&data, |id, payload| {
                    if id == ID_SEEK {
                        let mut seek_id = 0u32;
                        let mut seek_position = None;
                        for_each_child(payload, |id, payload| {
                            match id {
                                ID_SEEK_ID => seek_id = ebml_uint(payload) as u32,
                                ID_SEEK_POSITION => seek_position = Some(ebml_uint(payload)),
                                _ => {}
                            }
                            Ok(())
                        })?;
                        if let Some(position) = seek_position {
                            headers.seek_head.push((seek_id, position));
                        }
                    }
                    Ok(())
                })?;
            }
            ID_INFO => {
                headers.saw_info = true;
                for_each_child(&data, |id, payload| {
                    match id {
                        ID_TIMESTAMP_SCALE => headers.timestamp_scale = ebml_uint(payload),
                        ID_DURATION => headers.duration_units = ebml_float(payload),
                        ID_TITLE => {
                            let title = ebml_string(payload);
                            if !title.is_empty() {
                                headers.title = Some(title);
                            }
                        }
                        _ => {}
                    }
                    Ok(())
                })?;
            }
            ID_TRACKS => {
                headers.saw_tracks = true;
                let mut first_of_kind: Vec<TrackKind> = Vec::new();
                for_each_child(&data, |id, payload| {
                    if id == ID_TRACK_ENTRY {
                        if let Some(track) = parse_track_entry(payload, &mut first_of_kind)? {
                            headers.tracks.push(track);
                        }
                    }
                    Ok(())
                })?;
            }
            ID_CUES => {
                headers.saw_cues = true;
                let scale = headers.timestamp_scale.max(1);
                for_each_child(&data, |id, payload| {
                    if id == ID_CUE_POINT {
                        let mut time = None;
                        let mut positions: Vec<(u32, u64)> = Vec::new();
                        for_each_child(payload, |id, payload| {
                            match id {
                                ID_CUE_TIME => time = Some(ebml_uint(payload)),
                                ID_CUE_TRACK_POSITIONS => {
                                    let mut track = 0u32;
                                    let mut cluster = None;
                                    for_each_child(payload, |id, payload| {
                                        match id {
                                            ID_CUE_TRACK => track = ebml_uint(payload) as u32,
                                            ID_CUE_CLUSTER_POSITION => {
                                                cluster = Some(ebml_uint(payload))
                                            }
                                            _ => {}
                                        }
                                        Ok(())
                                    })?;
                                    if let Some(cluster) = cluster {
                                        positions.push((track, cluster));
                                    }
                                }
                                _ => {}
                            }
                            Ok(())
                        })?;
                        if let Some(time) = time {
                            let time_us = ((time as u128 * scale as u128) / 1000) as i64;
                            for (track, cluster_position) in positions {
                                headers.cues.push(CuePoint {
                                    time_us,
                                    track,
                                    cluster_position,
                                });
                            }
                        }
                    }
                    Ok(())
                })?;
            }
            ID_CHAPTERS => {
                headers.saw_chapters = true;
                let mut chapters = Vec::new();
                for_each_child(&data, |id, payload| {
                    if id == ID_EDITION_ENTRY && chapters.is_empty() {
                        for_each_child(payload, |id, payload| {
                            if id == ID_CHAPTER_ATOM {
                                if let Some(chapter) = parse_chapter_atom(payload)? {
                                    chapters.push(chapter);
                                }
                            }
                            Ok(())
                        })?;
                    }
                    Ok(())
                })?;
                chapters.sort_by_key(|chapter| chapter.start_us);
                headers.chapters = chapters;
            }
            _ => {}
        }
        Ok(true)
    }

    fn track_index(&self, number: u32) -> Option<usize> {
        self.tracks.iter().position(|track| track.number == number)
    }

    fn probe_missing_codecs(&mut self) -> Result<(), String> {
        let probes: Vec<usize> = self
            .tracks
            .iter()
            .enumerate()
            .filter(|(_, track)| track.needs_codec_probe)
            .map(|(index, _)| index)
            .collect();
        if probes.is_empty() {
            return Ok(());
        }

        let saved_selected = self.selected.clone();
        self.selected = probes.clone();
        self.pos = self.first_cluster;
        self.cluster_timestamp = 0;
        self.pending.clear();
        self.eof = false;
        self.await_video_keyframe = false;

        let start_pos = self.pos;
        let mut resolved = 0usize;
        while resolved < probes.len() && !self.eof && self.pos - start_pos < CODEC_PROBE_LIMIT {
            let (samples, eof) = self.next_samples(1 << 20, 32)?;
            for sample in samples {
                let Some(index) = self.track_index(sample.track_id) else {
                    continue;
                };
                let track = &mut self.tracks[index];
                if !track.needs_codec_probe || !sample.keyframe {
                    continue;
                }
                let params = match track.codec_id.as_str() {
                    "V_VP9" => codec::vp9_params_from_keyframe(&sample.data),
                    "V_AV1" => codec::av1_params_from_temporal_unit(&sample.data),
                    _ => None,
                };
                if let Some(params) = params {
                    track.info.codec = params.codec;
                    track.info.codec_family = params.family;
                }
                track.needs_codec_probe = false;
                resolved += 1;
            }
            if eof {
                break;
            }
        }
        for index in probes {
            self.tracks[index].needs_codec_probe = false;
        }
        self.info.tracks = self.tracks.iter().map(|track| track.info.clone()).collect();

        self.selected = saved_selected;
        self.pos = self.first_cluster;
        self.cluster_timestamp = 0;
        self.pending.clear();
        self.eof = false;
        self.await_video_keyframe = true;
        Ok(())
    }

    fn record_cluster(&mut self, time_us: i64, position: u64) {
        match self
            .cluster_index
            .binary_search_by_key(&position, |entry| entry.1)
        {
            Ok(_) => {}
            Err(insert_at) => self.cluster_index.insert(insert_at, (time_us, position)),
        }
    }

    /// Reads elements until at least one sample has been queued or the segment ends.
    fn fill_pending(&mut self) -> Result<(), String> {
        while self.pending.is_empty() {
            if self.pos >= self.segment_end {
                self.eof = true;
                return Ok(());
            }
            self.reader.seek(self.pos);
            let Some(element) = read_element_header(&mut self.reader)? else {
                self.eof = true;
                return Ok(());
            };
            match element.id {
                ID_CLUSTER => {
                    self.cluster_timestamp = 0;
                    self.pos = element.data_start;
                }
                ID_CLUSTER_TIMESTAMP => {
                    let size = element.size.unwrap_or(0).min(8) as usize;
                    let data = self.reader.read_bytes(size)?;
                    self.cluster_timestamp = ebml_uint(&data) as i64;
                    let cluster_start = self.find_cluster_start(element.start);
                    let time_us = self.units_to_us(self.cluster_timestamp);
                    if let Some(cluster_start) = cluster_start {
                        self.record_cluster(time_us, cluster_start);
                    }
                    self.pos = element.data_start + size as u64;
                }
                ID_SIMPLE_BLOCK => {
                    let Some(size) = element.size else {
                        self.eof = true;
                        return Ok(());
                    };
                    if size > MAX_BLOCK_SIZE {
                        return Err("Matroska block is unexpectedly large.".to_string());
                    }
                    self.pos = element.data_start + size;
                    if self.block_is_selected(element.data_start, size)? {
                        let data = self.reader.read_at(element.data_start, size as usize)?;
                        self.parse_block(&data, true, None, None)?;
                    }
                }
                ID_BLOCK_GROUP => {
                    let Some(size) = element.size else {
                        self.eof = true;
                        return Ok(());
                    };
                    if size > MAX_BLOCK_SIZE {
                        return Err("Matroska block group is unexpectedly large.".to_string());
                    }
                    self.pos = element.data_start + size;
                    let data = self.reader.read_at(element.data_start, size as usize)?;
                    let mut block: Option<Vec<u8>> = None;
                    let mut duration = None;
                    let mut has_reference = false;
                    for_each_child(&data, |id, payload| {
                        match id {
                            ID_BLOCK => block = Some(payload.to_vec()),
                            ID_BLOCK_DURATION => duration = Some(ebml_uint(payload)),
                            ID_REFERENCE_BLOCK => has_reference = true,
                            _ => {}
                        }
                        Ok(())
                    })?;
                    if let Some(block) = block {
                        self.parse_block(&block, false, Some(!has_reference), duration)?;
                    }
                }
                _ => match element.end() {
                    Some(end) => self.pos = end,
                    None => {
                        self.eof = true;
                        return Ok(());
                    }
                },
            }
        }
        Ok(())
    }

    /// Looks back from a cluster child to find the enclosing cluster start.
    fn find_cluster_start(&mut self, child_start: u64) -> Option<u64> {
        // The Timestamp element is normally the first child; walk back over a
        // plausible header length and check for the cluster ID.
        for back in 5..=12u64 {
            let Some(candidate) = child_start.checked_sub(back) else {
                break;
            };
            if let Ok(bytes) = self.reader.read_at(candidate, 4) {
                if bytes == [0x1F, 0x43, 0xB6, 0x75] {
                    return Some(candidate);
                }
            }
        }
        None
    }

    /// Peeks the track number of a block to skip unselected tracks cheaply.
    fn block_is_selected(&mut self, data_start: u64, size: u64) -> Result<bool, String> {
        let head = self.reader.read_at(data_start, size.min(8) as usize)?;
        let mut cursor = ByteCursor::new(&head);
        let (number, _) = cursor_vint(&mut cursor)?;
        Ok(self
            .track_index(number as u32)
            .map(|index| self.selected.contains(&index))
            .unwrap_or(false))
    }

    fn units_to_us(&self, units: i64) -> i64 {
        ((units as i128 * self.timestamp_scale as i128) / 1000) as i64
    }

    fn parse_block(
        &mut self,
        data: &[u8],
        simple: bool,
        group_keyframe: Option<bool>,
        group_duration_units: Option<u64>,
    ) -> Result<(), String> {
        let mut cursor = ByteCursor::new(data);
        let (track_number, _) = cursor_vint(&mut cursor)?;
        let relative = cursor.i16_be()?;
        let flags = cursor.u8()?;
        let Some(track_index) = self.track_index(track_number as u32) else {
            return Ok(());
        };
        if !self.selected.contains(&track_index) {
            return Ok(());
        }

        let lacing = (flags >> 1) & 0x03;
        let payload = cursor.rest();
        let frames = split_laced_frames(payload, lacing)?;
        if frames.is_empty() {
            return Ok(());
        }

        let track = &self.tracks[track_index];
        if track.unsupported_encoding {
            return Ok(());
        }
        let is_video = track.kind == TrackKind::Video;
        let keyframe = if is_video {
            if simple {
                flags & 0x80 != 0
            } else {
                group_keyframe.unwrap_or(true)
            }
        } else {
            true
        };

        if is_video && self.await_video_keyframe {
            if !keyframe {
                return Ok(());
            }
            self.await_video_keyframe = false;
        }

        let codec_delay_us = if track.kind == TrackKind::Audio {
            track.info.codec_delay_us
        } else {
            0
        };
        let base_pts_us =
            self.units_to_us(self.cluster_timestamp + relative as i64) - codec_delay_us;
        let frame_duration_us = match group_duration_units {
            Some(units) if units > 0 => self.units_to_us(units as i64) / frames.len() as i64,
            _ => (track.default_duration_ns / 1000) as i64,
        };

        for (index, frame) in frames.iter().enumerate() {
            let data = track.decode_frame(frame)?;
            self.pending.push_back(Sample {
                track_id: track.number,
                pts_us: base_pts_us + frame_duration_us * index as i64,
                dts_us: base_pts_us + frame_duration_us * index as i64,
                duration_us: frame_duration_us.max(0),
                keyframe,
                data,
            });
        }
        Ok(())
    }

    /// Builds the cluster index up to `target_us` for files without cues.
    fn scan_clusters_until(&mut self, target_us: i64) -> Result<(), String> {
        let mut position = self
            .cluster_index
            .last()
            .map(|entry| entry.1)
            .unwrap_or(self.first_cluster);
        let mut known_last_time = self.cluster_index.last().map(|entry| entry.0).unwrap_or(-1);
        if known_last_time >= target_us {
            return Ok(());
        }
        let mut guard = 0u32;
        while position < self.segment_end && guard < 2_000_000 {
            guard += 1;
            self.reader.seek(position);
            let Some(element) = read_element_header(&mut self.reader)? else {
                break;
            };
            if element.id != ID_CLUSTER {
                match element.end() {
                    Some(end) => position = end,
                    None => break,
                }
                continue;
            }
            // Read the cluster timestamp (normally the first child).
            let mut child_pos = element.data_start;
            let mut cluster_time = None;
            for _ in 0..8 {
                self.reader.seek(child_pos);
                let Some(child) = read_element_header(&mut self.reader)? else {
                    break;
                };
                if child.id == ID_CLUSTER_TIMESTAMP {
                    let size = child.size.unwrap_or(0).min(8) as usize;
                    let data = self.reader.read_bytes(size)?;
                    cluster_time = Some(self.units_to_us(ebml_uint(&data) as i64));
                    break;
                }
                match child.end() {
                    Some(end) => child_pos = end,
                    None => break,
                }
            }
            if let Some(time) = cluster_time {
                self.record_cluster(time, element.start);
                known_last_time = time;
            }
            match element.end() {
                Some(end) => position = end,
                None => {
                    // Unknown-size cluster: walk its children to find the next cluster.
                    position = self.skip_unknown_cluster(element.data_start)?;
                }
            }
            if known_last_time > target_us {
                break;
            }
        }
        Ok(())
    }

    fn skip_unknown_cluster(&mut self, mut position: u64) -> Result<u64, String> {
        while position < self.segment_end {
            self.reader.seek(position);
            let Some(child) = read_element_header(&mut self.reader)? else {
                return Ok(self.segment_end);
            };
            if child.id == ID_CLUSTER || child.id == ID_CUES {
                return Ok(child.start);
            }
            match child.end() {
                Some(end) => position = end,
                None => return Ok(self.segment_end),
            }
        }
        Ok(self.segment_end)
    }
}

impl Demuxer for MkvDemuxer {
    fn info(&self) -> &MediaInfo {
        &self.info
    }

    fn select_tracks(&mut self, ids: &[u32]) {
        self.selected = ids.iter().filter_map(|id| self.track_index(*id)).collect();
        self.pending.retain(|sample| ids.contains(&sample.track_id));
    }

    fn seek(&mut self, target_us: i64) -> Result<i64, String> {
        let target_us = target_us.max(0);
        self.pending.clear();
        self.eof = false;

        if self.info.duration_us > 0 && target_us >= self.info.duration_us {
            self.pos = self.segment_end;
            self.eof = true;
            return Ok(self.info.duration_us);
        }
        if target_us == 0 {
            self.pos = self.first_cluster;
            self.cluster_timestamp = 0;
            self.await_video_keyframe = true;
            return Ok(0);
        }

        let video_number = self
            .selected
            .iter()
            .find(|&&index| self.tracks[index].kind == TrackKind::Video)
            .map(|&index| self.tracks[index].number);

        let mut best: Option<(i64, u64)> = None;
        if !self.cues.is_empty() {
            let mut candidates = self.cues.iter().filter(|cue| cue.time_us <= target_us);
            let preferred = candidates
                .clone()
                .rfind(|cue| video_number.is_none_or(|number| cue.track == number))
                .or_else(|| candidates.next_back());
            if let Some(cue) = preferred {
                best = Some((
                    cue.time_us,
                    self.segment_start.saturating_add(cue.cluster_position),
                ));
            }
        }
        if best.is_none() {
            self.scan_clusters_until(target_us)?;
            best = self
                .cluster_index
                .iter()
                .rfind(|entry| entry.0 <= target_us)
                .copied();
        }

        let (time_us, position) = best.unwrap_or((0, self.first_cluster));
        self.pos = position;
        self.cluster_timestamp = 0;
        self.await_video_keyframe = video_number.is_some();
        Ok(time_us.min(target_us))
    }

    fn next_samples(
        &mut self,
        max_bytes: usize,
        max_samples: usize,
    ) -> Result<(Vec<Sample>, bool), String> {
        let mut out: Vec<Sample> = Vec::new();
        let mut bytes = 0usize;
        loop {
            if let Some(sample) = self.pending.pop_front() {
                if !out.is_empty()
                    && (bytes + sample.data.len() > max_bytes || out.len() >= max_samples)
                {
                    self.pending.push_front(sample);
                    return Ok((out, false));
                }
                bytes += sample.data.len();
                out.push(sample);
                continue;
            }
            if self.eof {
                return Ok((out, true));
            }
            self.fill_pending()?;
            if self.pending.is_empty() && self.eof {
                return Ok((out, true));
            }
        }
    }
}

fn split_laced_frames(payload: &[u8], lacing: u8) -> Result<Vec<&[u8]>, String> {
    if lacing == 0 {
        return Ok(vec![payload]);
    }
    let mut cursor = ByteCursor::new(payload);
    let count = cursor.u8()? as usize + 1;
    let mut sizes: Vec<usize> = Vec::with_capacity(count);
    match lacing {
        1 => {
            for _ in 0..count - 1 {
                let mut size = 0usize;
                loop {
                    let byte = cursor.u8()? as usize;
                    size += byte;
                    if byte != 255 {
                        break;
                    }
                }
                sizes.push(size);
            }
        }
        2 => {
            let total = cursor.remaining();
            if count == 0 || !total.is_multiple_of(count) {
                return Err("Invalid fixed-size lacing.".to_string());
            }
            for _ in 0..count - 1 {
                sizes.push(total / count);
            }
        }
        3 => {
            let (first, _) = cursor_vint(&mut cursor)?;
            let mut previous = first as i64;
            sizes.push(first as usize);
            for _ in 1..count - 1 {
                let delta = cursor_signed_vint(&mut cursor)?;
                previous += delta;
                if previous < 0 {
                    return Err("Invalid EBML lacing.".to_string());
                }
                sizes.push(previous as usize);
            }
        }
        _ => return Ok(vec![payload]),
    }
    let used: usize = sizes.iter().sum();
    if used > cursor.remaining() {
        return Err("Laced frames exceed block size.".to_string());
    }
    sizes.push(cursor.remaining() - used);
    let mut frames = Vec::with_capacity(count);
    for size in sizes {
        frames.push(cursor.bytes(size)?);
    }
    Ok(frames)
}

fn parse_chapter_atom(data: &[u8]) -> Result<Option<ChapterInfo>, String> {
    let mut start = None;
    let mut end = None;
    let mut title = None;
    for_each_child(data, |id, payload| {
        match id {
            ID_CHAPTER_TIME_START => start = Some(ebml_uint(payload)),
            ID_CHAPTER_TIME_END => end = Some(ebml_uint(payload)),
            ID_CHAPTER_DISPLAY if title.is_none() => {
                for_each_child(payload, |id, payload| {
                    if id == ID_CHAP_STRING {
                        title = Some(ebml_string(payload));
                    }
                    Ok(())
                })?;
            }
            _ => {}
        }
        Ok(())
    })?;
    let Some(start) = start else {
        return Ok(None);
    };
    Ok(Some(ChapterInfo {
        start_us: (start / 1000) as i64,
        end_us: end.map(|value| (value / 1000) as i64),
        title: title.unwrap_or_default(),
    }))
}

fn parse_track_entry(
    data: &[u8],
    first_of_kind: &mut Vec<TrackKind>,
) -> Result<Option<MkvTrack>, String> {
    let mut number = 0u32;
    let mut track_type = 0u64;
    let mut enabled = true;
    let mut default = true;
    let mut forced = false;
    let mut default_duration_ns = 0u64;
    let mut name = None;
    let mut language: Option<String> = None;
    let mut language_bcp47: Option<String> = None;
    let mut codec_id = String::new();
    let mut codec_private: Option<Vec<u8>> = None;
    let mut codec_delay_ns = 0u64;
    let mut pixel_width = 0u32;
    let mut pixel_height = 0u32;
    let mut display_width = 0u32;
    let mut display_height = 0u32;
    let mut sampling_frequency = 0f64;
    let mut output_sampling_frequency = 0f64;
    let mut channels = 0u32;
    let mut bit_depth = None;
    let mut header_strip: Vec<u8> = Vec::new();
    let mut zlib = false;
    let mut unsupported_encoding = false;

    for_each_child(data, |id, payload| {
        match id {
            ID_TRACK_NUMBER => number = ebml_uint(payload) as u32,
            ID_TRACK_TYPE => track_type = ebml_uint(payload),
            ID_FLAG_ENABLED => enabled = ebml_uint(payload) != 0,
            ID_FLAG_DEFAULT => default = ebml_uint(payload) != 0,
            ID_FLAG_FORCED => forced = ebml_uint(payload) != 0,
            ID_DEFAULT_DURATION => default_duration_ns = ebml_uint(payload),
            ID_NAME => {
                let value = ebml_string(payload);
                if !value.is_empty() {
                    name = Some(value);
                }
            }
            ID_LANGUAGE => language = Some(ebml_string(payload)),
            ID_LANGUAGE_BCP47 => language_bcp47 = Some(ebml_string(payload)),
            ID_CODEC_ID => codec_id = ebml_string(payload),
            ID_CODEC_PRIVATE => codec_private = Some(payload.to_vec()),
            ID_CODEC_DELAY => codec_delay_ns = ebml_uint(payload),
            ID_VIDEO => {
                for_each_child(payload, |id, payload| {
                    match id {
                        ID_PIXEL_WIDTH => pixel_width = ebml_uint(payload) as u32,
                        ID_PIXEL_HEIGHT => pixel_height = ebml_uint(payload) as u32,
                        ID_DISPLAY_WIDTH => display_width = ebml_uint(payload) as u32,
                        ID_DISPLAY_HEIGHT => display_height = ebml_uint(payload) as u32,
                        _ => {}
                    }
                    Ok(())
                })?;
            }
            ID_AUDIO => {
                for_each_child(payload, |id, payload| {
                    match id {
                        ID_SAMPLING_FREQUENCY => sampling_frequency = ebml_float(payload),
                        ID_OUTPUT_SAMPLING_FREQUENCY => {
                            output_sampling_frequency = ebml_float(payload)
                        }
                        ID_CHANNELS => channels = ebml_uint(payload) as u32,
                        ID_BIT_DEPTH => bit_depth = Some(ebml_uint(payload) as u32),
                        _ => {}
                    }
                    Ok(())
                })?;
            }
            ID_CONTENT_ENCODINGS => {
                for_each_child(payload, |id, payload| {
                    if id != ID_CONTENT_ENCODING {
                        return Ok(());
                    }
                    let mut encoding_type = 0u64;
                    let mut algo = None;
                    let mut settings: Vec<u8> = Vec::new();
                    for_each_child(payload, |id, payload| {
                        match id {
                            ID_CONTENT_ENCODING_TYPE => encoding_type = ebml_uint(payload),
                            ID_CONTENT_COMPRESSION => {
                                for_each_child(payload, |id, payload| {
                                    match id {
                                        ID_CONTENT_COMP_ALGO => algo = Some(ebml_uint(payload)),
                                        ID_CONTENT_COMP_SETTINGS => settings = payload.to_vec(),
                                        _ => {}
                                    }
                                    Ok(())
                                })?;
                            }
                            _ => {}
                        }
                        Ok(())
                    })?;
                    if encoding_type != 0 {
                        unsupported_encoding = true; // encryption
                        return Ok(());
                    }
                    match algo.unwrap_or(0) {
                        0 => zlib = true,
                        3 => header_strip = settings.clone(),
                        _ => unsupported_encoding = true,
                    }
                    Ok(())
                })?;
            }
            _ => {}
        }
        Ok(())
    })?;

    let kind = match track_type {
        1 => TrackKind::Video,
        2 => TrackKind::Audio,
        17 => TrackKind::Subtitle,
        _ => return Ok(None),
    };
    if number == 0 {
        return Ok(None);
    }

    let (
        codec_family,
        codec,
        description,
        subtitle_format,
        needs_codec_probe,
        params_rate,
        params_channels,
    ) = map_codec(&codec_id, codec_private.as_deref(), bit_depth, kind);

    let sample_rate = if output_sampling_frequency > 0.0 {
        output_sampling_frequency.round() as u32
    } else if sampling_frequency > 0.0 {
        sampling_frequency.round() as u32
    } else {
        params_rate.unwrap_or(0)
    };
    let channels = if channels > 0 {
        channels
    } else {
        params_channels.unwrap_or(0)
    };

    let normalized_language = language_bcp47
        .filter(|value| !value.is_empty() && value != "und")
        .or_else(|| language.filter(|value| !value.is_empty() && value != "und"));

    let is_first = !first_of_kind.contains(&kind);
    if is_first {
        first_of_kind.push(kind);
    }

    let info = TrackInfo {
        id: number,
        kind,
        codec_family,
        codec,
        description,
        width: pixel_width,
        height: pixel_height,
        display_width: if display_width > 0 {
            display_width
        } else {
            pixel_width
        },
        display_height: if display_height > 0 {
            display_height
        } else {
            pixel_height
        },
        frame_rate: (kind == TrackKind::Video && default_duration_ns > 0)
            .then(|| 1_000_000_000.0 / default_duration_ns as f64),
        sample_rate,
        channels,
        bit_depth,
        language: normalized_language,
        name,
        default: enabled && default,
        forced,
        default_duration_us: (default_duration_ns / 1000) as i64,
        codec_delay_us: (codec_delay_ns / 1000) as i64,
        sample_count: 0,
        subtitle_format,
    };

    Ok(Some(MkvTrack {
        number,
        kind,
        codec_id,
        default_duration_ns,
        header_strip,
        zlib,
        unsupported_encoding,
        needs_codec_probe,
        info,
    }))
}

type CodecMapping = (
    String,
    Option<String>,
    Option<Vec<u8>>,
    Option<String>,
    bool,
    Option<u32>,
    Option<u32>,
);

fn map_codec(
    codec_id: &str,
    private: Option<&[u8]>,
    bit_depth: Option<u32>,
    kind: TrackKind,
) -> CodecMapping {
    let video = |params: codec::VideoCodecParams, probe: bool| -> CodecMapping {
        (
            params.family,
            params.codec,
            params.description,
            None,
            probe,
            None,
            None,
        )
    };
    let audio = |params: codec::AudioCodecParams| -> CodecMapping {
        (
            params.family,
            params.codec,
            params.description,
            None,
            false,
            params.sample_rate,
            params.channels,
        )
    };

    match kind {
        TrackKind::Video => match codec_id {
            "V_MPEG4/ISO/AVC" => video(
                private
                    .map(codec::avc_params)
                    .unwrap_or_else(|| codec::unsupported_video("h264")),
                false,
            ),
            "V_MPEGH/ISO/HEVC" => video(
                private
                    .map(codec::hevc_params)
                    .unwrap_or_else(|| codec::unsupported_video("hevc")),
                false,
            ),
            "V_VP8" => video(codec::vp8_params(), false),
            "V_VP9" => match private.and_then(codec::vp9_params_from_matroska_private) {
                Some(params) => video(params, false),
                None => video(
                    codec::VideoCodecParams {
                        family: "vp9".to_string(),
                        codec: Some("vp09.00.10.08".to_string()),
                        description: None,
                    },
                    true,
                ),
            },
            "V_AV1" => match private.filter(|data| data.len() >= 4) {
                Some(av1c) => video(codec::av1_params_from_av1c(av1c), false),
                None => video(codec::unsupported_video("av1"), true),
            },
            "V_MPEG4/ISO/ASP" | "V_MPEG4/ISO/SP" | "V_MPEG4/MS/V3" => {
                video(codec::unsupported_video("mpeg4"), false)
            }
            "V_MPEG1" | "V_MPEG2" => video(codec::unsupported_video("mpeg2"), false),
            "V_MS/VFW/FOURCC" => video(codec::unsupported_video("vfw"), false),
            "V_THEORA" => video(codec::unsupported_video("theora"), false),
            "V_PRORES" => video(codec::unsupported_video("prores"), false),
            other => video(codec::unsupported_video(&other.to_ascii_lowercase()), false),
        },
        TrackKind::Audio => match codec_id {
            id if id.starts_with("A_AAC") => {
                let mut params = codec::aac_params(private.unwrap_or(&[]));
                if private.is_none() {
                    let object_type = if id.contains("SBR") { 5 } else { 2 };
                    params.codec = Some(format!("mp4a.40.{object_type}"));
                }
                audio(params)
            }
            "A_OPUS" => audio(codec::opus_params(private.map(|data| data.to_vec()))),
            "A_VORBIS" => audio(codec::vorbis_params(private.map(|data| data.to_vec()))),
            "A_FLAC" => audio(codec::flac_params(private.map(|data| data.to_vec()))),
            "A_MPEG/L3" => audio(codec::mp3_params()),
            "A_MPEG/L2" | "A_MPEG/L1" => {
                let mut params = codec::mp3_params();
                params.family = "mp2".to_string();
                audio(params)
            }
            "A_AC3" | "A_AC3/BSID9" | "A_AC3/BSID10" => audio(codec::ac3_params(false)),
            "A_EAC3" => audio(codec::ac3_params(true)),
            "A_PCM/INT/LIT" => audio(codec::pcm_params(bit_depth.unwrap_or(16), false, true)),
            "A_PCM/INT/BIG" => audio(codec::pcm_params(bit_depth.unwrap_or(16), false, false)),
            "A_PCM/FLOAT/IEEE" => audio(codec::pcm_params(bit_depth.unwrap_or(32), true, true)),
            id if id.starts_with("A_DTS") => audio(codec::unsupported_audio("dts")),
            "A_TRUEHD" | "A_MLP" => audio(codec::unsupported_audio("truehd")),
            "A_ALAC" => audio(codec::unsupported_audio("alac")),
            other => audio(codec::unsupported_audio(&other.to_ascii_lowercase())),
        },
        TrackKind::Subtitle => {
            let format = match codec_id {
                "S_TEXT/UTF8" => Some("srt"),
                "S_TEXT/ASS" | "S_TEXT/SSA" | "S_SSA" | "S_ASS" => Some("ass"),
                "S_TEXT/WEBVTT" => Some("webvtt"),
                _ => None,
            };
            (
                codec_id.to_ascii_lowercase(),
                format.map(ToString::to_string),
                None,
                format.map(ToString::to_string),
                false,
                None,
                None,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_xiph_lacing() {
        // 3 frames: sizes 2, 300 (255 + 45), rest (1).
        let mut payload = vec![2u8, 2, 255, 45];
        payload.extend_from_slice(&[0xaa, 0xbb]);
        payload.extend(std::iter::repeat_n(0xcc, 300));
        payload.push(0xdd);
        let frames = split_laced_frames(&payload, 1).expect("lacing");
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0], &[0xaa, 0xbb]);
        assert_eq!(frames[1].len(), 300);
        assert_eq!(frames[2], &[0xdd]);
    }

    #[test]
    fn splits_fixed_lacing() {
        let payload = [1u8, 1, 2, 3, 4];
        let frames = split_laced_frames(&payload, 2).expect("lacing");
        assert_eq!(frames, vec![&[1u8, 2][..], &[3u8, 4][..]]);
    }

    #[test]
    fn splits_ebml_lacing() {
        // 3 frames: first size 2 (0x82), delta -1 → 1, rest 3.
        let payload = [2u8, 0x82, 0xbe, 9, 9, 8, 7, 7, 7];
        let frames = split_laced_frames(&payload, 3).expect("lacing");
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0], &[9, 9]);
        assert_eq!(frames[1], &[8]);
        assert_eq!(frames[2], &[7, 7, 7]);
    }

    #[test]
    fn signed_vint_bias() {
        let data = [0xbe_u8];
        let mut cursor = ByteCursor::new(&data);
        assert_eq!(cursor_signed_vint(&mut cursor).unwrap(), -1);
        let data = [0x40u8, 0x7e];
        let mut cursor = ByteCursor::new(&data);
        assert_eq!(cursor_signed_vint(&mut cursor).unwrap(), -8065);
    }

    #[test]
    fn maps_common_codecs() {
        let (family, codec, _, _, probe, _, _) = map_codec(
            "V_MPEG4/ISO/AVC",
            Some(&[1, 0x64, 0, 0x28, 0xff]),
            None,
            TrackKind::Video,
        );
        assert_eq!(family, "h264");
        assert_eq!(codec.as_deref(), Some("avc1.640028"));
        assert!(!probe);

        let (_, codec, _, _, probe, _, _) = map_codec("V_VP9", None, None, TrackKind::Video);
        assert_eq!(codec.as_deref(), Some("vp09.00.10.08"));
        assert!(probe);

        let (family, codec, _, _, _, rate, _) =
            map_codec("A_PCM/INT/LIT", None, Some(24), TrackKind::Audio);
        assert_eq!(family, "pcm");
        assert_eq!(codec.as_deref(), Some("pcm-s24"));
        assert_eq!(rate, None);

        let (_, codec, _, format, _, _, _) =
            map_codec("S_TEXT/UTF8", None, None, TrackKind::Subtitle);
        assert_eq!(codec.as_deref(), Some("srt"));
        assert_eq!(format.as_deref(), Some("srt"));
    }
}
