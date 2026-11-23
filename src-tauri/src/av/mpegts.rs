//! MPEG-2 transport stream demuxer (ISO/IEC 13818-1) for LMP AV.
//!
//! Handles plain 188-byte packets plus the 192-byte M2TS variant (4-byte
//! timestamp prefix) and 204-byte packets with a Reed-Solomon trailer. PAT
//! and PMT describe the program, PES packets are reassembled per PID and the
//! elementary streams are cut into access units / audio frames by small
//! stream parsers:
//!
//! * H.264 and HEVC stay in Annex B form. WebCodecs decodes Annex B when no
//!   `description` is configured, so `TrackInfo.description` is left empty
//!   on purpose and the codec string is derived from the SPS. Key frames
//!   that lack in-band parameter sets get the cached VPS/SPS/PPS prepended.
//! * ADTS headers are stripped and turned into an AudioSpecificConfig.
//! * MPEG audio, AC-3 and E-AC-3 are passed through one sync frame at a time.
//!
//! Transport streams carry no index. Seeking estimates a byte offset from the
//! average bitrate, backs off a little and scans forward to the last key
//! frame at or before the target.

use std::collections::{BTreeMap, HashMap, VecDeque};

use super::{codec, reader::FileReader, Demuxer, MediaInfo, Sample, TrackInfo, TrackKind};

const SYNC_BYTE: u8 = 0x47;
const TS_PACKET: usize = 188;
/// (packet size, offset of the sync byte inside the packet)
const PACKET_LAYOUTS: [(u64, u64); 3] = [(188, 0), (192, 4), (204, 0)];
const SYNC_SEARCH_BYTES: usize = 64 * 1024;
const PROBE_LIMIT_BYTES: u64 = 8 * 1024 * 1024;
const TAIL_SCAN_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PES_BYTES: usize = 32 * 1024 * 1024;
const MAX_SECTION_BYTES: usize = 16 * 1024;
const MAX_AUDIO_BUFFER: usize = 1024 * 1024;
const PTS_WRAP: i64 = 1 << 33;
const NULL_PID: u16 = 0x1fff;
const PROBE_MIN_VIDEO_SAMPLES: usize = 12;
const SEEK_BACKOFF_US: i64 = 2_000_000;
const SEEK_MAX_ATTEMPTS: usize = 6;
/// PES packets of an unidentified private stream inspected before it is dropped.
const PRIVATE_PROBE_PES: u8 = 8;

// ---------------------------------------------------------------------------
// Packet layer
// ---------------------------------------------------------------------------

/// Looks for `count` packets at a fixed stride and returns
/// (packet size, sync offset, offset of the first packet).
fn detect_sync(data: &[u8]) -> Option<(u64, u64, u64)> {
    for offset in 0..data.len().min(SYNC_SEARCH_BYTES) {
        if data[offset] != SYNC_BYTE {
            continue;
        }
        for &(size, sync_offset) in &PACKET_LAYOUTS {
            let (size, sync_offset) = (size as usize, sync_offset as usize);
            if offset < sync_offset {
                continue;
            }
            let available = (data.len() - offset) / size;
            let required = available.min(4);
            if required == 0 && data.len() - offset < size {
                // Less than one packet after the candidate: accept only when
                // the file itself is that short.
                if data.len() >= size {
                    continue;
                }
            }
            let mut matched = 0;
            for step in 1..=required {
                let position = offset + step * size;
                if position >= data.len() || data[position] != SYNC_BYTE {
                    break;
                }
                matched += 1;
            }
            if matched == required {
                return Some((
                    size as u64,
                    sync_offset as u64,
                    (offset - sync_offset) as u64,
                ));
            }
        }
    }
    None
}

/// Quick magic check used by `open_demuxer`: the file must start with
/// packets (an M2TS timestamp prefix is allowed).
pub fn looks_like_transport_stream(head: &[u8]) -> bool {
    matches!(detect_sync(head), Some((_, _, first)) if first <= 4)
}

struct Packet<'a> {
    pid: u16,
    pusi: bool,
    cc: u8,
    discontinuity: bool,
    scrambled: bool,
    error: bool,
    payload: &'a [u8],
}

fn parse_packet(data: &[u8]) -> Option<Packet<'_>> {
    if data.len() < TS_PACKET || data[0] != SYNC_BYTE {
        return None;
    }
    let error = data[1] & 0x80 != 0;
    let pusi = data[1] & 0x40 != 0;
    let pid = (((data[1] & 0x1f) as u16) << 8) | data[2] as u16;
    let scrambled = data[3] & 0xc0 != 0;
    let afc = (data[3] >> 4) & 3;
    let cc = data[3] & 0x0f;
    let mut offset = 4;
    let mut discontinuity = false;
    if afc & 2 != 0 {
        let length = data[4] as usize;
        if length > 0 {
            discontinuity = data[5] & 0x80 != 0;
        }
        offset = 5 + length;
        if offset > TS_PACKET {
            return None;
        }
    }
    let payload = if afc & 1 != 0 {
        &data[offset..TS_PACKET]
    } else {
        &data[TS_PACKET..]
    };
    Some(Packet {
        pid,
        pusi,
        cc,
        discontinuity,
        scrambled,
        error,
        payload,
    })
}

// ---------------------------------------------------------------------------
// PSI (PAT / PMT)
// ---------------------------------------------------------------------------

#[derive(Default)]
struct SectionBuffer {
    data: Vec<u8>,
    active: bool,
}

impl SectionBuffer {
    fn push(&mut self, payload: &[u8], pusi: bool) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        let mut rest = payload;
        if pusi {
            if rest.is_empty() {
                return out;
            }
            let pointer = rest[0] as usize;
            rest = &rest[1..];
            if pointer > rest.len() {
                self.active = false;
                self.data.clear();
                return out;
            }
            if self.active {
                self.data.extend_from_slice(&rest[..pointer]);
                self.collect(&mut out);
            }
            rest = &rest[pointer..];
            self.data.clear();
            self.active = true;
        } else if !self.active {
            return out;
        }
        self.data.extend_from_slice(rest);
        if self.data.len() > MAX_SECTION_BYTES {
            self.data.clear();
            self.active = false;
            return out;
        }
        self.collect(&mut out);
        out
    }

    fn collect(&mut self, out: &mut Vec<Vec<u8>>) {
        loop {
            if self.data.first() == Some(&0xff) {
                // Stuffing after the last section of this packet.
                self.data.clear();
                self.active = false;
                return;
            }
            if self.data.len() < 3 {
                return;
            }
            let length = (((self.data[1] & 0x0f) as usize) << 8) | self.data[2] as usize;
            let total = 3 + length;
            if self.data.len() < total {
                return;
            }
            out.push(self.data[..total].to_vec());
            self.data.drain(..total);
        }
    }
}

fn section_body_end(section: &[u8]) -> usize {
    let length = (((section[1] & 0x0f) as usize) << 8) | section[2] as usize;
    (3 + length).min(section.len()).saturating_sub(4) // strip CRC32
}

fn parse_pat(section: &[u8]) -> Vec<(u16, u16)> {
    let mut programs = Vec::new();
    if section.len() < 12 || section[0] != 0 {
        return programs;
    }
    let end = section_body_end(section);
    let mut pos = 8;
    while pos + 4 <= end {
        let program = u16::from_be_bytes([section[pos], section[pos + 1]]);
        let pid = u16::from_be_bytes([section[pos + 2] & 0x1f, section[pos + 3]]);
        if program != 0 {
            programs.push((program, pid));
        }
        pos += 4;
    }
    programs
}

struct PmtStream {
    pid: u16,
    stream_type: u8,
    descriptors: Vec<(u8, Vec<u8>)>,
}

fn parse_descriptors(mut data: &[u8]) -> Vec<(u8, Vec<u8>)> {
    let mut out = Vec::new();
    while data.len() >= 2 {
        let tag = data[0];
        let length = data[1] as usize;
        let body = &data[2..(2 + length).min(data.len())];
        out.push((tag, body.to_vec()));
        data = &data[(2 + length).min(data.len())..];
    }
    out
}

fn parse_pmt(section: &[u8]) -> Option<Vec<PmtStream>> {
    if section.len() < 16 || section[0] != 2 {
        return None;
    }
    let end = section_body_end(section);
    let info_length = (((section[10] & 0x0f) as usize) << 8) | section[11] as usize;
    let mut pos = 12 + info_length;
    let mut streams = Vec::new();
    while pos + 5 <= end {
        let stream_type = section[pos];
        let pid = u16::from_be_bytes([section[pos + 1] & 0x1f, section[pos + 2]]);
        let es_length = (((section[pos + 3] & 0x0f) as usize) << 8) | section[pos + 4] as usize;
        pos += 5;
        let descriptor_end = (pos + es_length).min(end);
        let descriptors = parse_descriptors(&section[pos..descriptor_end]);
        pos = descriptor_end;
        streams.push(PmtStream {
            pid,
            stream_type,
            descriptors,
        });
    }
    Some(streams)
}

fn descriptor_language(descriptors: &[(u8, Vec<u8>)]) -> Option<String> {
    descriptors
        .iter()
        .find(|(tag, body)| *tag == 0x0a && body.len() >= 3)
        .map(|(_, body)| {
            body[..3]
                .iter()
                .map(|byte| (*byte as char).to_ascii_lowercase())
                .collect::<String>()
        })
        .filter(|language| language.chars().all(|c| c.is_ascii_alphabetic()))
}

fn has_registration(descriptors: &[(u8, Vec<u8>)], tag: &[u8; 4]) -> bool {
    descriptors
        .iter()
        .any(|(id, body)| *id == 0x05 && body.len() >= 4 && &body[..4] == tag)
}

enum StreamClass {
    H264,
    Hevc,
    Adts,
    MpegAudio,
    Ac3 {
        enhanced: bool,
    },
    /// Private data without an identifying descriptor; the payload decides.
    PrivateData,
    /// Listed for the UI, but LMP cannot decode it.
    Other {
        kind: TrackKind,
        family: &'static str,
    },
    Skip,
}

fn classify_stream(stream_type: u8, descriptors: &[(u8, Vec<u8>)]) -> StreamClass {
    let has_tag = |tag: u8| descriptors.iter().any(|(id, _)| *id == tag);
    match stream_type {
        0x1b => StreamClass::H264,
        0x24 => StreamClass::Hevc,
        0x0f => StreamClass::Adts,
        0x03 | 0x04 => StreamClass::MpegAudio,
        0x81 => StreamClass::Ac3 { enhanced: false },
        0x84 | 0x87 | 0xa1 => StreamClass::Ac3 { enhanced: true },
        0x06 => {
            if has_tag(0x7a) || has_registration(descriptors, b"EAC3") {
                StreamClass::Ac3 { enhanced: true }
            } else if has_tag(0x6a) || has_registration(descriptors, b"AC-3") {
                StreamClass::Ac3 { enhanced: false }
            } else if has_tag(0x7b)
                || has_registration(descriptors, b"DTS1")
                || has_registration(descriptors, b"DTS2")
                || has_registration(descriptors, b"DTS3")
            {
                StreamClass::Other {
                    kind: TrackKind::Audio,
                    family: "dts",
                }
            } else if has_registration(descriptors, b"Opus") {
                StreamClass::Other {
                    kind: TrackKind::Audio,
                    family: "opus",
                }
            } else if descriptors
                .iter()
                .any(|(id, _)| matches!(*id, 0x45 | 0x46 | 0x56 | 0x59))
            {
                // VBI data, teletext and DVB subtitles.
                StreamClass::Skip
            } else {
                // FFmpeg writes AAC and MPEG audio this way into M2TS files.
                StreamClass::PrivateData
            }
        }
        0x01 | 0x02 => StreamClass::Other {
            kind: TrackKind::Video,
            family: "mpeg2",
        },
        0x10 => StreamClass::Other {
            kind: TrackKind::Video,
            family: "mpeg4",
        },
        0xea => StreamClass::Other {
            kind: TrackKind::Video,
            family: "vc1",
        },
        0x11 => StreamClass::Other {
            kind: TrackKind::Audio,
            family: "aac",
        },
        0x80 => StreamClass::Other {
            kind: TrackKind::Audio,
            family: "pcm",
        },
        0x82 | 0x85 | 0x86 | 0xa2 => StreamClass::Other {
            kind: TrackKind::Audio,
            family: "dts",
        },
        0x83 => StreamClass::Other {
            kind: TrackKind::Audio,
            family: "truehd",
        },
        _ => StreamClass::Skip,
    }
}

// ---------------------------------------------------------------------------
// PES layer
// ---------------------------------------------------------------------------

struct PesPacket {
    payload: Vec<u8>,
    /// Raw 33-bit timestamps in 90 kHz units.
    pts: Option<i64>,
    dts: Option<i64>,
    /// File offset of the TS packet that started this PES packet.
    start_pos: u64,
}

#[derive(Default)]
struct PesAssembler {
    buf: Vec<u8>,
    active: bool,
    corrupt: bool,
    start_pos: u64,
    expected: Option<usize>,
}

impl PesAssembler {
    fn push(&mut self, payload: &[u8], pusi: bool, packet_pos: u64, out: &mut Vec<PesPacket>) {
        if pusi {
            self.finish(out);
            self.active = true;
            self.corrupt = false;
            self.start_pos = packet_pos;
            self.buf.extend_from_slice(payload);
            if self.buf.len() >= 6 {
                let length = u16::from_be_bytes([self.buf[4], self.buf[5]]) as usize;
                if length > 0 {
                    self.expected = Some(6 + length);
                }
            }
        } else if self.active {
            self.buf.extend_from_slice(payload);
        } else {
            return;
        }
        if let Some(expected) = self.expected {
            if self.buf.len() >= expected {
                self.finish(out);
                return;
            }
        }
        if self.buf.len() > MAX_PES_BYTES {
            self.reset();
        }
    }

    fn finish(&mut self, out: &mut Vec<PesPacket>) {
        if self.active && !self.corrupt {
            if let Some(packet) = parse_pes(&self.buf, self.start_pos) {
                out.push(packet);
            }
        }
        self.reset();
    }

    fn reset(&mut self) {
        self.buf.clear();
        self.active = false;
        self.corrupt = false;
        self.expected = None;
    }
}

fn read_pes_timestamp(bytes: &[u8]) -> i64 {
    (((bytes[0] >> 1) & 7) as i64) << 30
        | (bytes[1] as i64) << 22
        | ((bytes[2] >> 1) as i64) << 15
        | (bytes[3] as i64) << 7
        | (bytes[4] >> 1) as i64
}

/// Parses the PES header; `payload_start` is `None` when the optional header
/// runs past the available bytes (used for timestamp-only peeks).
fn parse_pes_header(buf: &[u8]) -> Option<(Option<i64>, Option<i64>, Option<usize>, usize)> {
    if buf.len() < 6 || buf[0] != 0 || buf[1] != 0 || buf[2] != 1 {
        return None;
    }
    let stream_id = buf[3];
    let length = u16::from_be_bytes([buf[4], buf[5]]) as usize;
    let end = if length > 0 {
        (6 + length).min(buf.len())
    } else {
        buf.len()
    };
    if matches!(
        stream_id,
        0xbc | 0xbe | 0xbf | 0xf0 | 0xf1 | 0xf2 | 0xf8 | 0xff
    ) {
        return Some((None, None, Some(6), end));
    }
    if buf.len() < 9 || buf[6] & 0xc0 != 0x80 {
        return None;
    }
    let flags = buf[7];
    let header_length = buf[8] as usize;
    let data_start = 9 + header_length;
    let mut pts = None;
    let mut dts = None;
    if flags & 0x80 != 0 && buf.len() >= 14 {
        pts = Some(read_pes_timestamp(&buf[9..14]));
    }
    if flags & 0xc0 == 0xc0 && buf.len() >= 19 {
        dts = Some(read_pes_timestamp(&buf[14..19]));
    }
    let payload_start = (data_start <= end).then_some(data_start);
    Some((pts, dts, payload_start, end))
}

fn parse_pes(buf: &[u8], start_pos: u64) -> Option<PesPacket> {
    let (pts, dts, payload_start, end) = parse_pes_header(buf)?;
    let payload_start = payload_start?;
    Some(PesPacket {
        payload: buf[payload_start..end].to_vec(),
        pts,
        dts,
        start_pos,
    })
}

/// Moves `raw` (33-bit) onto the lap closest to `reference`.
fn unwrap_ticks(raw: i64, reference: i64) -> i64 {
    let laps = (reference - raw + PTS_WRAP / 2).div_euclid(PTS_WRAP);
    raw + laps * PTS_WRAP
}

fn ticks_to_us(ticks: i64) -> i64 {
    ((ticks as i128 * 100) / 9) as i64
}

fn us_to_ticks(us: i64) -> i64 {
    ((us as i128 * 9) / 100) as i64
}

// ---------------------------------------------------------------------------
// Elementary stream parsers
// ---------------------------------------------------------------------------

struct Frame {
    data: Vec<u8>,
    /// Unwrapped 90 kHz timestamps.
    pts: Option<i64>,
    dts: Option<i64>,
    duration_ticks: i64,
    keyframe: bool,
}

struct NalRef {
    /// Start of the start code (including one zero_byte when present).
    boundary: usize,
    /// First byte of the NAL unit header.
    start: usize,
    /// Exclusive end of the NAL unit body.
    end: usize,
}

fn scan_nals(data: &[u8]) -> Vec<NalRef> {
    let mut out: Vec<NalRef> = Vec::new();
    let mut i = 0;
    let n = data.len();
    while i + 3 <= n {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            let boundary = if i > 0 && data[i - 1] == 0 { i - 1 } else { i };
            if let Some(last) = out.last_mut() {
                last.end = boundary.max(last.start);
            }
            out.push(NalRef {
                boundary,
                start: i + 3,
                end: n,
            });
            i += 3;
        } else {
            i += 1;
        }
    }
    out
}

/// True when an H.264 SEI NAL body (after the header byte) carries a
/// recovery point message, which FFmpeg also treats as a key frame marker.
fn sei_has_recovery_point(body: &[u8]) -> bool {
    let rbsp = codec::nal_to_rbsp(body);
    let mut pos = 0;
    while pos < rbsp.len() {
        let mut payload_type = 0usize;
        while pos < rbsp.len() && rbsp[pos] == 0xff {
            payload_type += 255;
            pos += 1;
        }
        if pos >= rbsp.len() {
            break;
        }
        payload_type += rbsp[pos] as usize;
        pos += 1;
        let mut size = 0usize;
        while pos < rbsp.len() && rbsp[pos] == 0xff {
            size += 255;
            pos += 1;
        }
        if pos >= rbsp.len() {
            break;
        }
        size += rbsp[pos] as usize;
        pos += 1;
        if payload_type == 6 {
            return true;
        }
        pos += size;
        if pos < rbsp.len() && rbsp[pos] == 0x80 {
            break;
        }
    }
    false
}

struct VideoEs {
    hevc: bool,
    vps: BTreeMap<u32, Vec<u8>>,
    sps: BTreeMap<u32, Vec<u8>>,
    pps: BTreeMap<u32, Vec<u8>>,
    avc_sps: Option<codec::AvcSps>,
    hevc_sps: Option<codec::HevcSps>,
    last_dts: Option<i64>,
    frame_ticks: i64,
}

impl VideoEs {
    fn new(hevc: bool) -> Self {
        Self {
            hevc,
            vps: BTreeMap::new(),
            sps: BTreeMap::new(),
            pps: BTreeMap::new(),
            avc_sps: None,
            hevc_sps: None,
            last_dts: None,
            frame_ticks: 0,
        }
    }

    fn reset(&mut self) {
        self.last_dts = None;
    }

    fn has_parameters(&self) -> bool {
        if self.hevc {
            self.hevc_sps.is_some()
        } else {
            self.avc_sps.is_some()
        }
    }

    fn params(&self) -> codec::VideoCodecParams {
        if self.hevc {
            self.hevc_sps
                .as_ref()
                .map(codec::hevc_params_from_sps)
                .unwrap_or_else(|| codec::unsupported_video("hevc"))
        } else {
            self.avc_sps
                .as_ref()
                .map(codec::avc_params_from_sps)
                .unwrap_or_else(|| codec::unsupported_video("h264"))
        }
    }

    /// (width, height, sample aspect ratio, VUI frame rate)
    fn geometry(&self) -> (u32, u32, (u32, u32), Option<f64>) {
        if let Some(sps) = &self.hevc_sps {
            return (sps.width, sps.height, sps.sar, sps.frame_rate);
        }
        if let Some(sps) = &self.avc_sps {
            return (sps.width, sps.height, sps.sar, sps.frame_rate);
        }
        (0, 0, (1, 1), None)
    }

    /// Luma bit depth, or `None` when the chroma layout is something the
    /// WebCodecs decoders will not take anyway (4:2:2 / 4:4:4).
    fn bit_depth(&self) -> Option<u32> {
        let (chroma, depth) = if let Some(sps) = &self.hevc_sps {
            (
                sps.chroma_format_idc,
                sps.bit_depth_luma.max(sps.bit_depth_chroma),
            )
        } else if let Some(sps) = &self.avc_sps {
            (
                sps.chroma_format_idc,
                sps.bit_depth_luma.max(sps.bit_depth_chroma),
            )
        } else {
            return None;
        };
        (chroma <= 1).then_some(depth)
    }

    fn note_parameter_set(&mut self, nal: &[u8]) {
        if self.hevc {
            match (nal[0] >> 1) & 0x3f {
                32 => {
                    self.vps
                        .insert((nal.get(2).copied().unwrap_or(0) >> 4) as u32, nal.to_vec());
                }
                33 => {
                    if let Some(sps) = codec::parse_hevc_sps(nal) {
                        self.sps.insert(sps.id, nal.to_vec());
                        self.hevc_sps = Some(sps);
                    } else if self.sps.is_empty() {
                        self.sps.insert(0, nal.to_vec());
                    }
                }
                34 => {
                    let id = codec::hevc_pps_id(nal).unwrap_or(0);
                    self.pps.insert(id, nal.to_vec());
                }
                _ => {}
            }
        } else {
            match nal[0] & 0x1f {
                7 => {
                    if let Some(sps) = codec::parse_avc_sps(nal) {
                        self.sps.insert(sps.id, nal.to_vec());
                        self.avc_sps = Some(sps);
                    } else if self.sps.is_empty() {
                        self.sps.insert(0, nal.to_vec());
                    }
                }
                8 => {
                    let id = codec::avc_pps_id(nal).unwrap_or(0);
                    self.pps.insert(id, nal.to_vec());
                }
                _ => {}
            }
        }
    }

    /// Splits one PES payload into access units; the first one carries the
    /// PES timestamps, later ones are extrapolated.
    fn push(&mut self, payload: Vec<u8>, pts: Option<i64>, dts: Option<i64>) -> Vec<Frame> {
        let nals = scan_nals(&payload);
        if nals.is_empty() {
            return Vec::new();
        }

        // Access unit boundaries.
        let mut units: Vec<(usize, usize)> = Vec::new();
        let mut unit_start = 0usize;
        let mut seen_vcl = false;
        for nal in &nals {
            let Some(&header) = payload.get(nal.start) else {
                continue;
            };
            let (is_vcl, starts_unit) = if self.hevc {
                let nal_type = (header >> 1) & 0x3f;
                let vcl = nal_type < 32;
                let first_slice = vcl
                    && payload
                        .get(nal.start + 2)
                        .map(|b| b >> 7 == 1)
                        .unwrap_or(false);
                (
                    vcl,
                    first_slice || matches!(nal_type, 32..=37 | 39 | 41..=44 | 48..=55),
                )
            } else {
                let nal_type = header & 0x1f;
                let vcl = (1..=5).contains(&nal_type);
                let first_mb = vcl
                    && payload
                        .get(nal.start + 1)
                        .map(|b| b & 0x80 != 0)
                        .unwrap_or(false);
                (vcl, first_mb || matches!(nal_type, 6..=9 | 14..=18))
            };
            if seen_vcl && starts_unit && nal.boundary > unit_start {
                units.push((unit_start, nal.boundary));
                unit_start = nal.boundary;
                seen_vcl = false;
            }
            if is_vcl {
                seen_vcl = true;
            }
        }
        units.push((unit_start, payload.len()));

        let mut frames = Vec::with_capacity(units.len());
        let single = units.len() == 1;
        let mut payload = Some(payload);
        for (index, (start, end)) in units.iter().copied().enumerate() {
            let data = payload.as_ref().expect("payload available");
            let unit = &data[start..end];
            let mut has_key = false;
            let mut has_sps = false;
            let mut has_pps = false;
            let mut recovery = false;
            let mut aud_end: Option<usize> = None;
            for nal in nals
                .iter()
                .filter(|nal| nal.start >= start && nal.start < end)
            {
                let body = &data[nal.start..nal.end.min(end)];
                if body.is_empty() {
                    continue;
                }
                if self.hevc {
                    let nal_type = (body[0] >> 1) & 0x3f;
                    match nal_type {
                        16..=23 => has_key = true,
                        32 | 34 => {
                            if nal_type == 34 {
                                has_pps = true;
                            }
                            self.note_parameter_set(body);
                        }
                        33 => {
                            has_sps = true;
                            self.note_parameter_set(body);
                        }
                        35 => aud_end = Some(nal.end.min(end) - start),
                        _ => {}
                    }
                } else {
                    match body[0] & 0x1f {
                        5 => has_key = true,
                        7 => {
                            has_sps = true;
                            self.note_parameter_set(body);
                        }
                        8 => {
                            has_pps = true;
                            self.note_parameter_set(body);
                        }
                        9 => aud_end = Some(nal.end.min(end) - start),
                        6 if !has_key && body.len() > 1 => {
                            recovery |= sei_has_recovery_point(&body[1..]);
                        }
                        _ => {}
                    }
                }
            }
            let keyframe = has_key || (!self.hevc && recovery);
            let inject =
                keyframe && !(has_sps && has_pps) && !self.sps.is_empty() && !self.pps.is_empty();

            let bytes = if inject {
                let insert_at = aud_end.unwrap_or(0);
                let mut injected = Vec::with_capacity(unit.len() + 512);
                injected.extend_from_slice(&unit[..insert_at]);
                for set in self
                    .vps
                    .values()
                    .chain(self.sps.values())
                    .chain(self.pps.values())
                {
                    injected.extend_from_slice(&[0, 0, 0, 1]);
                    injected.extend_from_slice(set);
                }
                injected.extend_from_slice(&unit[insert_at..]);
                injected
            } else if single {
                payload.take().expect("payload available")
            } else {
                unit.to_vec()
            };

            let (frame_pts, frame_dts) = if index == 0 {
                let dts = dts.or(pts);
                (pts.or(dts), dts)
            } else {
                let dts = self.last_dts.map(|last| last + self.frame_ticks);
                (dts, dts)
            };
            if let Some(dts) = frame_dts {
                self.last_dts = Some(dts);
            }
            frames.push(Frame {
                data: bytes,
                pts: frame_pts,
                dts: frame_dts,
                duration_ticks: self.frame_ticks,
                keyframe,
            });
        }
        frames
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AudioSyntax {
    Adts,
    MpegAudio,
    Ac3,
}

struct AudioFrameHeader {
    header_len: usize,
    frame_len: usize,
    samples: u32,
    sample_rate: u32,
    dependent: bool,
}

struct AudioEs {
    syntax: AudioSyntax,
    buf: Vec<u8>,
    /// (buffer offset, pts) of the most recent PES packet that carried a PTS.
    anchor: Option<(usize, i64)>,
    /// (anchor pts, samples emitted since that anchor)
    clock: Option<(i64, i64)>,
    params: Option<codec::AudioCodecParams>,
    sample_rate: u32,
    frame_samples: u32,
}

impl AudioEs {
    fn new(syntax: AudioSyntax) -> Self {
        Self {
            syntax,
            buf: Vec::new(),
            anchor: None,
            clock: None,
            params: None,
            sample_rate: 0,
            frame_samples: 0,
        }
    }

    fn reset(&mut self) {
        self.buf.clear();
        self.anchor = None;
        self.clock = None;
    }

    /// Parses a frame header at `pos`; `commit` lets the first header define
    /// the track parameters (skipped while re-synchronising).
    fn header_at(&mut self, pos: usize, commit: bool) -> Option<AudioFrameHeader> {
        let data = &self.buf[pos..];
        match self.syntax {
            AudioSyntax::Adts => {
                let header = codec::parse_adts_header(data)?;
                if commit && self.params.is_none() {
                    let asc = codec::adts_audio_specific_config(&header);
                    let mut params = codec::aac_params(&asc);
                    if params.channels.is_none() && header.channel_config == 0 {
                        params.channels = Some(2);
                    }
                    self.params = Some(params);
                }
                Some(AudioFrameHeader {
                    header_len: header.header_len,
                    frame_len: header.frame_len,
                    samples: 1024 * header.raw_blocks,
                    sample_rate: header.sample_rate,
                    dependent: false,
                })
            }
            AudioSyntax::MpegAudio => {
                let header = codec::parse_mpeg_audio_header(data)?;
                if commit && self.params.is_none() {
                    let mut params = codec::mp3_params();
                    if header.layer != 3 {
                        params.family = format!("mp{}", header.layer);
                    }
                    params.sample_rate = Some(header.sample_rate);
                    params.channels = Some(header.channels);
                    self.params = Some(params);
                }
                Some(AudioFrameHeader {
                    header_len: 0,
                    frame_len: header.frame_len,
                    samples: header.samples_per_frame,
                    sample_rate: header.sample_rate,
                    dependent: false,
                })
            }
            AudioSyntax::Ac3 => {
                let header = codec::parse_ac3_header(data)?;
                if commit && self.params.is_none() && !header.dependent {
                    let mut params = codec::ac3_params(header.enhanced);
                    params.sample_rate = Some(header.sample_rate);
                    params.channels = Some(header.channels);
                    self.params = Some(params);
                }
                Some(AudioFrameHeader {
                    header_len: 0,
                    frame_len: header.frame_len,
                    samples: header.samples,
                    sample_rate: header.sample_rate,
                    dependent: header.dependent,
                })
            }
        }
    }

    fn is_sync_candidate(&self, pos: usize) -> bool {
        match self.syntax {
            AudioSyntax::Adts | AudioSyntax::MpegAudio => self.buf[pos] == 0xff,
            AudioSyntax::Ac3 => self.buf[pos] == 0x0b,
        }
    }

    fn push(&mut self, payload: &[u8], pts: Option<i64>) -> Vec<Frame> {
        if let Some(pts) = pts {
            self.anchor = Some((self.buf.len(), pts));
        }
        self.buf.extend_from_slice(payload);
        let mut frames: Vec<Frame> = Vec::new();
        let mut pos = 0usize;
        let mut resynced = false;
        while pos < self.buf.len() {
            let Some(header) = self.header_at(pos, !resynced) else {
                // Lost sync: skip to the next candidate byte.
                pos += 1;
                while pos < self.buf.len() && !self.is_sync_candidate(pos) {
                    pos += 1;
                }
                resynced = true;
                continue;
            };
            if pos + header.frame_len > self.buf.len() {
                break;
            }
            if resynced {
                // After a resync the candidate only counts when another
                // header follows it; otherwise wait for more data.
                let next = pos + header.frame_len;
                if next + 7 > self.buf.len() {
                    break;
                }
                if self.header_at(next, false).is_none() {
                    pos += 1;
                    while pos < self.buf.len() && !self.is_sync_candidate(pos) {
                        pos += 1;
                    }
                    continue;
                }
                resynced = false;
                let _ = self.header_at(pos, true);
            }
            let body = &self.buf[pos + header.header_len..pos + header.frame_len];
            if header.dependent {
                // E-AC-3 dependent substreams travel with the preceding frame.
                if let Some(last) = frames.last_mut() {
                    last.data.extend_from_slice(body);
                }
                pos += header.frame_len;
                continue;
            }
            if let Some((offset, anchor_pts)) = self.anchor {
                if pos >= offset {
                    self.clock = Some((anchor_pts, 0));
                    self.anchor = None;
                }
            }
            self.sample_rate = header.sample_rate;
            self.frame_samples = header.samples;
            let rate = header.sample_rate.max(1) as i64;
            let frame_pts = self
                .clock
                .map(|(base, samples)| base + samples * 90000 / rate);
            if let Some((_, samples)) = self.clock.as_mut() {
                *samples += header.samples as i64;
            }
            frames.push(Frame {
                data: body.to_vec(),
                pts: frame_pts,
                dts: frame_pts,
                duration_ticks: header.samples as i64 * 90000 / rate,
                keyframe: true,
            });
            pos += header.frame_len;
        }
        if pos > 0 {
            self.buf.drain(..pos);
            if let Some((offset, pts)) = self.anchor {
                self.anchor = Some((offset.saturating_sub(pos), pts));
            }
        }
        if self.buf.len() > MAX_AUDIO_BUFFER {
            self.buf.clear();
            self.anchor = None;
        }
        frames
    }

    fn frame_ticks(&self) -> i64 {
        if self.sample_rate == 0 {
            0
        } else {
            self.frame_samples as i64 * 90000 / self.sample_rate as i64
        }
    }
}

enum Es {
    Video(VideoEs),
    Audio(AudioEs),
    /// Private data stream whose payload was not recognised yet.
    Private {
        pes_seen: u8,
    },
    Unsupported,
}

impl Es {
    fn reset(&mut self) {
        match self {
            Es::Video(es) => es.reset(),
            Es::Audio(es) => es.reset(),
            Es::Private { .. } | Es::Unsupported => {}
        }
    }

    fn probe_complete(&self, probe_pts: usize) -> bool {
        match self {
            Es::Video(es) => es.has_parameters() && probe_pts >= PROBE_MIN_VIDEO_SAMPLES,
            Es::Audio(es) => es.params.is_some(),
            Es::Private { pes_seen } => *pes_seen >= PRIVATE_PROBE_PES,
            Es::Unsupported => true,
        }
    }
}

/// Recognises audio in a private data stream from its first bytes. The PES
/// packet must start with a frame that either fills it or is followed by a
/// second frame of the same syntax.
fn sniff_private_audio(payload: &[u8]) -> Option<(AudioSyntax, &'static str)> {
    let frame_len = |syntax: AudioSyntax, data: &[u8]| match syntax {
        AudioSyntax::Adts => codec::parse_adts_header(data).map(|header| header.frame_len),
        AudioSyntax::MpegAudio => {
            codec::parse_mpeg_audio_header(data).map(|header| header.frame_len)
        }
        AudioSyntax::Ac3 => codec::parse_ac3_header(data).map(|header| header.frame_len),
    };
    [
        (AudioSyntax::Adts, "aac"),
        (AudioSyntax::Ac3, "ac3"),
        (AudioSyntax::MpegAudio, "mp2"),
    ]
    .into_iter()
    .find(|(syntax, _)| {
        frame_len(*syntax, payload).is_some_and(|len| {
            len == payload.len()
                || payload
                    .get(len..)
                    .is_some_and(|rest| frame_len(*syntax, rest).is_some())
        })
    })
}

// ---------------------------------------------------------------------------
// Demuxer
// ---------------------------------------------------------------------------

struct TsTrack {
    pid: u16,
    info: TrackInfo,
    es: Es,
    pes: PesAssembler,
    last_cc: Option<u8>,
    /// Latest unwrapped timestamp on this PID (unwrap reference).
    last_ticks: Option<i64>,
    /// Smallest timestamp seen while probing.
    first_ticks: Option<i64>,
    probe_pts: Vec<i64>,
    /// Nominal frame duration in 90 kHz ticks.
    frame_ticks: i64,
    /// Fallback timestamp for frames that carry none.
    next_ticks: Option<i64>,
    scrambled: bool,
}

struct Emitted {
    track: usize,
    frame: Frame,
    pes_start: u64,
}

fn blank_track_info(id: u32, kind: TrackKind, family: &str) -> TrackInfo {
    TrackInfo {
        id,
        kind,
        codec_family: family.to_string(),
        codec: None,
        description: None,
        width: 0,
        height: 0,
        display_width: 0,
        display_height: 0,
        frame_rate: None,
        sample_rate: 0,
        channels: 0,
        bit_depth: None,
        language: None,
        name: None,
        default: false,
        forced: false,
        default_duration_us: 0,
        codec_delay_us: 0,
        sample_count: 0,
        subtitle_format: None,
    }
}

fn median_interval(values: &mut Vec<i64>) -> Option<i64> {
    values.sort_unstable();
    values.dedup();
    if values.len() < 4 {
        return None;
    }
    let mut deltas: Vec<i64> = values
        .windows(2)
        .map(|pair| pair[1] - pair[0])
        .filter(|delta| *delta > 0)
        .collect();
    if deltas.is_empty() {
        return None;
    }
    deltas.sort_unstable();
    Some(deltas[deltas.len() / 2])
}

pub struct TsDemuxer {
    reader: FileReader,
    info: MediaInfo,
    packet_size: u64,
    sync_offset: u64,
    data_start: u64,
    file_len: u64,
    tracks: Vec<TsTrack>,
    pid_index: HashMap<u16, usize>,
    pmt_pids: Vec<u16>,
    sections: HashMap<u16, SectionBuffer>,
    program_ready: bool,
    probing: bool,
    selected: Vec<usize>,
    pending: VecDeque<Sample>,
    pos: u64,
    eof: bool,
    flushed: bool,
    await_video_keyframe: bool,
    base_ticks: i64,
    reference_ticks: i64,
    bytes_per_us: f64,
    discontinuities: u64,
}

impl TsDemuxer {
    pub fn open(reader: FileReader) -> Result<Self, String> {
        let mut reader = reader;
        let file_len = reader.len();
        let head_len = file_len.min(SYNC_SEARCH_BYTES as u64 + 1024) as usize;
        let head = reader.read_at(0, head_len)?;
        let Some((packet_size, sync_offset, data_start)) = detect_sync(&head) else {
            return Err("Not an MPEG transport stream (no packet sync found).".to_string());
        };
        let mut demuxer = Self {
            reader,
            info: MediaInfo {
                container: "mpegts".to_string(),
                duration_us: 0,
                tracks: Vec::new(),
                chapters: Vec::new(),
                title: None,
                seekable: true,
            },
            packet_size,
            sync_offset,
            data_start,
            file_len,
            tracks: Vec::new(),
            pid_index: HashMap::new(),
            pmt_pids: Vec::new(),
            sections: HashMap::new(),
            program_ready: false,
            probing: true,
            selected: Vec::new(),
            pending: VecDeque::new(),
            pos: data_start,
            eof: false,
            flushed: false,
            await_video_keyframe: true,
            base_ticks: 0,
            reference_ticks: 0,
            bytes_per_us: 0.0,
            discontinuities: 0,
        };
        demuxer.probe()?;
        Ok(demuxer)
    }

    fn align(&self, offset: u64) -> u64 {
        if offset <= self.data_start {
            return self.data_start;
        }
        let relative = offset - self.data_start;
        self.data_start + (relative / self.packet_size) * self.packet_size
    }

    fn track_index(&self, id: u32) -> Option<usize> {
        u16::try_from(id)
            .ok()
            .and_then(|pid| self.pid_index.get(&pid).copied())
    }

    fn supported(track: &TsTrack) -> bool {
        !matches!(track.es, Es::Unsupported)
    }

    // -- probing -----------------------------------------------------------

    fn probe(&mut self) -> Result<(), String> {
        let limit = self
            .data_start
            .saturating_add(PROBE_LIMIT_BYTES)
            .min(self.file_len);
        let mut emitted = Vec::new();
        while self.pos < limit && !self.eof {
            emitted.clear();
            self.step(&mut emitted, true)?;
            if self.probe_complete() {
                break;
            }
        }
        self.probing = false;

        // Private streams that never looked like audio are not offered.
        if self
            .tracks
            .iter()
            .any(|track| matches!(track.es, Es::Private { .. }))
        {
            self.tracks
                .retain(|track| !matches!(track.es, Es::Private { .. }));
            self.pid_index = self
                .tracks
                .iter()
                .enumerate()
                .map(|(index, track)| (track.pid, index))
                .collect();
        }

        if !self.program_ready {
            return Err("No program table found in the transport stream.".to_string());
        }
        if self.tracks.is_empty() {
            return Err("The transport stream has no playable streams.".to_string());
        }
        if self.tracks.iter().all(|track| track.scrambled) {
            return Err("The transport stream is scrambled.".to_string());
        }

        let base = self
            .tracks
            .iter()
            .filter(|track| Self::supported(track))
            .filter_map(|track| track.first_ticks)
            .min()
            .or_else(|| {
                self.tracks
                    .iter()
                    .filter_map(|track| track.first_ticks)
                    .min()
            })
            .unwrap_or(0);
        self.base_ticks = base;

        self.finalize_tracks();
        self.info.tracks = self.tracks.iter().map(|track| track.info.clone()).collect();

        let last_ticks = self.scan_tail_for_last_pts()?;
        let end_ticks = last_ticks.unwrap_or(0).max(
            self.tracks
                .iter()
                .filter_map(|track| track.last_ticks.map(|last| last + track.frame_ticks))
                .max()
                .unwrap_or(0),
        );
        self.info.duration_us = ticks_to_us((end_ticks - base).max(0));
        if self.info.duration_us > 0 {
            self.bytes_per_us =
                (self.file_len - self.data_start) as f64 / self.info.duration_us as f64;
        }

        self.reset_position(self.data_start, base);
        Ok(())
    }

    fn probe_complete(&self) -> bool {
        self.program_ready
            && !self.tracks.is_empty()
            && self.tracks.iter().all(|track| {
                !Self::supported(track)
                    || track.scrambled
                    || (track.first_ticks.is_some()
                        && track.es.probe_complete(track.probe_pts.len()))
            })
    }

    fn finalize_tracks(&mut self) {
        let mut saw_video = false;
        let mut saw_audio = false;
        for track in &mut self.tracks {
            match &mut track.es {
                Es::Video(es) => {
                    let params = es.params();
                    let (width, height, sar, vui_fps) = es.geometry();
                    let bit_depth = es.bit_depth();
                    let measured =
                        median_interval(&mut track.probe_pts).map(|ticks| 90000.0 / ticks as f64);
                    let fps = match (vui_fps, measured) {
                        (Some(vui), Some(measured))
                            if ((vui - measured) / measured).abs() > 0.2 =>
                        {
                            Some(measured)
                        }
                        (Some(vui), _) => Some(vui),
                        (None, measured) => measured,
                    }
                    .filter(|fps| *fps > 0.5 && *fps <= 1000.0);
                    track.frame_ticks = fps.map(|fps| (90000.0 / fps).round() as i64).unwrap_or(0);
                    es.frame_ticks = track.frame_ticks;

                    let info = &mut track.info;
                    info.codec_family = params.family;
                    info.codec = params.codec;
                    info.description = params.description;
                    info.width = width;
                    info.height = height;
                    info.display_width = if sar.1 > 0 {
                        ((width as u64 * sar.0 as u64 + sar.1 as u64 / 2) / sar.1 as u64) as u32
                    } else {
                        width
                    };
                    info.display_height = height;
                    info.bit_depth = bit_depth;
                    info.frame_rate = fps;
                    info.default_duration_us = fps
                        .map(|fps| (1_000_000.0 / fps).round() as i64)
                        .unwrap_or(0);
                    info.default = !saw_video;
                    saw_video = true;
                }
                Es::Audio(es) => {
                    track.frame_ticks = es.frame_ticks();
                    let info = &mut track.info;
                    if let Some(params) = &es.params {
                        info.codec_family = params.family.clone();
                        info.codec = params.codec.clone();
                        info.description = params.description.clone();
                        info.sample_rate = params.sample_rate.unwrap_or(0);
                        info.channels = params.channels.unwrap_or(0);
                    }
                    info.default_duration_us = ticks_to_us(track.frame_ticks);
                    info.default = !saw_audio;
                    saw_audio = true;
                }
                Es::Private { .. } | Es::Unsupported => {}
            }
        }
    }

    /// Reads PES headers near the end of the file for the last presentation time.
    fn scan_tail_for_last_pts(&mut self) -> Result<Option<i64>, String> {
        if self.file_len <= self.data_start + self.packet_size {
            return Ok(None);
        }
        let span = TAIL_SCAN_BYTES.min(self.file_len - self.data_start);
        let mut pos = self.align(self.file_len - span);
        let mut last: Option<i64> = None;
        while pos + self.packet_size <= self.file_len {
            let raw = self.reader.read_at(pos + self.sync_offset, TS_PACKET)?;
            pos += self.packet_size;
            let Some(packet) = parse_packet(&raw) else {
                continue;
            };
            if !packet.pusi || packet.payload.len() < 14 {
                continue;
            }
            let Some(&index) = self.pid_index.get(&packet.pid) else {
                continue;
            };
            let Some((pts, dts, _, _)) = parse_pes_header(packet.payload) else {
                continue;
            };
            let track = &self.tracks[index];
            for raw_ticks in [pts, dts].into_iter().flatten() {
                let mut ticks = unwrap_ticks(raw_ticks, self.base_ticks);
                if ticks < self.base_ticks - 90_000 * 2 {
                    ticks += PTS_WRAP;
                }
                let end = ticks + track.frame_ticks;
                last = Some(last.map_or(end, |value| value.max(end)));
            }
        }
        Ok(last)
    }

    // -- packet handling ---------------------------------------------------

    fn reset_position(&mut self, pos: u64, reference_ticks: i64) {
        self.pos = pos.min(self.file_len);
        self.eof = false;
        self.flushed = false;
        self.pending.clear();
        self.reference_ticks = reference_ticks;
        self.sections.clear();
        self.await_video_keyframe = true;
        for track in &mut self.tracks {
            track.pes.reset();
            track.last_cc = None;
            track.last_ticks = None;
            track.next_ticks = None;
            track.es.reset();
        }
    }

    fn resync(&mut self, from: u64) -> Result<(), String> {
        for track in &mut self.tracks {
            if track.pes.active {
                track.pes.corrupt = true;
            }
        }
        if from >= self.file_len {
            self.pos = self.file_len;
            return Ok(());
        }
        let len = (self.file_len - from).min(SYNC_SEARCH_BYTES as u64) as usize;
        let data = self.reader.read_at(from, len)?;
        let size = self.packet_size as usize;
        // Candidates start at `sync_offset` so the packet start never moves
        // before `from`, which guarantees forward progress.
        for offset in self.sync_offset as usize..data.len() {
            if data[offset] != SYNC_BYTE {
                continue;
            }
            let mut ok = true;
            for step in 1..=2 {
                let position = offset + step * size;
                if position < data.len() && data[position] != SYNC_BYTE {
                    ok = false;
                    break;
                }
            }
            if ok {
                let absolute = from + offset as u64;
                self.pos = absolute.saturating_sub(self.sync_offset);
                return Ok(());
            }
        }
        self.pos = self.file_len;
        Ok(())
    }

    fn handle_psi(&mut self, pid: u16, payload: &[u8], pusi: bool) {
        let sections = self.sections.entry(pid).or_default().push(payload, pusi);
        for section in sections {
            if pid == 0 {
                if self.program_ready {
                    continue;
                }
                for (_, pmt_pid) in parse_pat(&section) {
                    if pmt_pid != 0 && !self.pmt_pids.contains(&pmt_pid) {
                        self.pmt_pids.push(pmt_pid);
                    }
                }
            } else if !self.program_ready {
                if let Some(streams) = parse_pmt(&section) {
                    if self.adopt_program(streams) {
                        self.program_ready = true;
                    }
                }
            }
        }
    }

    fn adopt_program(&mut self, streams: Vec<PmtStream>) -> bool {
        let mut tracks = Vec::new();
        for stream in streams {
            if tracks.iter().any(|track: &TsTrack| track.pid == stream.pid) {
                continue;
            }
            let language = descriptor_language(&stream.descriptors);
            let (kind, family, es) = match classify_stream(stream.stream_type, &stream.descriptors)
            {
                StreamClass::H264 => (TrackKind::Video, "h264", Es::Video(VideoEs::new(false))),
                StreamClass::Hevc => (TrackKind::Video, "hevc", Es::Video(VideoEs::new(true))),
                StreamClass::Adts => (
                    TrackKind::Audio,
                    "aac",
                    Es::Audio(AudioEs::new(AudioSyntax::Adts)),
                ),
                StreamClass::MpegAudio => (
                    TrackKind::Audio,
                    "mp2",
                    Es::Audio(AudioEs::new(AudioSyntax::MpegAudio)),
                ),
                StreamClass::Ac3 { enhanced } => (
                    TrackKind::Audio,
                    if enhanced { "eac3" } else { "ac3" },
                    Es::Audio(AudioEs::new(AudioSyntax::Ac3)),
                ),
                StreamClass::PrivateData => {
                    (TrackKind::Audio, "private", Es::Private { pes_seen: 0 })
                }
                StreamClass::Other { kind, family } => (kind, family, Es::Unsupported),
                StreamClass::Skip => continue,
            };
            let mut info = blank_track_info(stream.pid as u32, kind, family);
            info.language = language;
            tracks.push(TsTrack {
                pid: stream.pid,
                info,
                es,
                pes: PesAssembler::default(),
                last_cc: None,
                last_ticks: None,
                first_ticks: None,
                probe_pts: Vec::new(),
                frame_ticks: 0,
                next_ticks: None,
                scrambled: false,
            });
        }
        if tracks.is_empty() {
            return false;
        }
        self.pid_index = tracks
            .iter()
            .enumerate()
            .map(|(index, track)| (track.pid, index))
            .collect();
        self.tracks = tracks;
        true
    }

    /// Reads one TS packet and appends any frames it completes to `out`.
    /// With `all_pids` every known elementary stream is assembled, otherwise
    /// only the selected tracks.
    fn step(&mut self, out: &mut Vec<Emitted>, all_pids: bool) -> Result<(), String> {
        if self.pos.saturating_add(self.packet_size) > self.file_len {
            self.pos = self.file_len;
            if !self.flushed {
                self.flushed = true;
                self.flush_all(out);
            }
            self.eof = true;
            return Ok(());
        }
        let packet_pos = self.pos;
        let raw = self
            .reader
            .read_at(packet_pos + self.sync_offset, TS_PACKET)?;
        self.pos += self.packet_size;
        let Some(packet) = parse_packet(&raw) else {
            return self.resync(packet_pos + 1);
        };
        if packet.error || packet.pid == NULL_PID || packet.payload.is_empty() {
            return Ok(());
        }
        if packet.pid == 0 || self.pmt_pids.contains(&packet.pid) {
            self.handle_psi(packet.pid, packet.payload, packet.pusi);
            return Ok(());
        }
        let Some(&index) = self.pid_index.get(&packet.pid) else {
            return Ok(());
        };
        if !all_pids && !self.selected.contains(&index) {
            return Ok(());
        }
        if packet.scrambled {
            self.tracks[index].scrambled = true;
            return Ok(());
        }
        let mut pes_packets = Vec::new();
        let mut discontinuity = false;
        {
            let track = &mut self.tracks[index];
            if let Some(last) = track.last_cc {
                if packet.cc == last {
                    return Ok(()); // duplicate packet
                }
                if packet.cc != (last + 1) & 0x0f && !packet.discontinuity {
                    discontinuity = true;
                    if !packet.pusi {
                        track.pes.corrupt = true;
                    }
                }
            }
            track.last_cc = Some(packet.cc);
            track
                .pes
                .push(packet.payload, packet.pusi, packet_pos, &mut pes_packets);
        }
        if discontinuity {
            self.discontinuities += 1;
        }
        for pes in pes_packets {
            self.handle_pes(index, pes, out);
        }
        Ok(())
    }

    fn flush_all(&mut self, out: &mut Vec<Emitted>) {
        for index in 0..self.tracks.len() {
            let mut pes_packets = Vec::new();
            self.tracks[index].pes.finish(&mut pes_packets);
            for pes in pes_packets {
                self.handle_pes(index, pes, out);
            }
        }
    }

    fn handle_pes(&mut self, index: usize, pes: PesPacket, out: &mut Vec<Emitted>) {
        let probing = self.probing;
        let reference = self.tracks[index]
            .last_ticks
            .unwrap_or(self.reference_ticks);
        let pts = pes.pts.map(|raw| unwrap_ticks(raw, reference));
        let dts = pes
            .dts
            .map(|raw| unwrap_ticks(raw, pts.unwrap_or(reference)));
        let pes_start = pes.start_pos;

        let track = &mut self.tracks[index];
        let mut latest = None;
        for ticks in [pts, dts].into_iter().flatten() {
            if probing {
                track.first_ticks = Some(track.first_ticks.map_or(ticks, |first| first.min(ticks)));
            }
            latest = Some(latest.map_or(ticks, |value: i64| value.max(ticks)));
        }
        if let Some(ticks) = dts.or(pts) {
            track.last_ticks = Some(ticks);
        }
        let is_video = track.info.kind == TrackKind::Video;
        let frames = match &mut track.es {
            Es::Video(es) => es.push(pes.payload, pts, dts),
            Es::Audio(es) => es.push(&pes.payload, pts),
            Es::Private { pes_seen } => match sniff_private_audio(&pes.payload) {
                Some((syntax, family)) => {
                    let mut es = AudioEs::new(syntax);
                    let frames = es.push(&pes.payload, pts);
                    track.es = Es::Audio(es);
                    track.info.codec_family = family.to_string();
                    frames
                }
                None => {
                    *pes_seen = pes_seen.saturating_add(1);
                    Vec::new()
                }
            },
            Es::Unsupported => Vec::new(),
        };
        for frame in frames {
            if probing && is_video {
                if let Some(pts) = frame.pts {
                    track.probe_pts.push(pts);
                }
            }
            out.push(Emitted {
                track: index,
                frame,
                pes_start,
            });
        }
        if let Some(ticks) = latest {
            self.reference_ticks = ticks;
        }
    }

    fn push_sample(&mut self, emitted: Emitted) {
        let base = self.base_ticks;
        let track = &mut self.tracks[emitted.track];
        let frame = emitted.frame;
        let is_video = track.info.kind == TrackKind::Video;
        if is_video && self.await_video_keyframe {
            if !frame.keyframe {
                return;
            }
            self.await_video_keyframe = false;
        }
        let fallback = track.next_ticks.unwrap_or(base);
        let pts_ticks = frame.pts.or(frame.dts).unwrap_or(fallback);
        let dts_ticks = frame.dts.or(frame.pts).unwrap_or(fallback);
        let duration_ticks = if frame.duration_ticks > 0 {
            frame.duration_ticks
        } else {
            track.frame_ticks
        };
        track.next_ticks = Some(pts_ticks + duration_ticks);
        self.pending.push_back(Sample {
            track_id: track.pid as u32,
            pts_us: ticks_to_us(pts_ticks - base),
            dts_us: ticks_to_us(dts_ticks - base),
            duration_us: ticks_to_us(duration_ticks).max(0),
            keyframe: frame.keyframe,
            data: frame.data,
        });
    }

    fn fill_pending(&mut self) -> Result<(), String> {
        let mut emitted = Vec::new();
        while self.pending.is_empty() && !self.eof {
            emitted.clear();
            self.step(&mut emitted, false)?;
            for item in emitted.drain(..) {
                self.push_sample(item);
            }
        }
        Ok(())
    }

    // -- seeking -----------------------------------------------------------

    /// Scans forward from the current position and returns the PES start and
    /// presentation time of the last key frame at or before `target_us`.
    fn scan_for_keyframe(
        &mut self,
        anchor: usize,
        target_us: i64,
    ) -> Result<Option<(u64, i64)>, String> {
        let is_video = self.tracks[anchor].info.kind == TrackKind::Video;
        let base = self.base_ticks;
        let mut best: Option<(u64, i64)> = None;
        let mut current_pes: Option<(u64, i64)> = None;
        let mut emitted = Vec::new();
        while !self.eof {
            emitted.clear();
            self.step(&mut emitted, false)?;
            for item in emitted.drain(..) {
                if item.track != anchor {
                    continue;
                }
                let Some(pts_ticks) = item.frame.pts.or(item.frame.dts) else {
                    continue;
                };
                let dts_ticks = item.frame.dts.unwrap_or(pts_ticks);
                let pts_us = ticks_to_us(pts_ticks - base);
                let dts_us = ticks_to_us(dts_ticks - base);
                if current_pes.is_none_or(|(start, _)| start != item.pes_start) {
                    current_pes = Some((item.pes_start, pts_us));
                }
                if pts_us <= target_us && (item.frame.keyframe || !is_video) {
                    best = if is_video {
                        Some((item.pes_start, pts_us))
                    } else {
                        current_pes
                    };
                }
                if dts_us > target_us {
                    return Ok(best);
                }
            }
        }
        Ok(best)
    }
}

impl Demuxer for TsDemuxer {
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

        if self.info.duration_us > 0 && target_us >= self.info.duration_us {
            self.reset_position(self.file_len, self.base_ticks + us_to_ticks(target_us));
            self.flushed = true;
            self.eof = true;
            return Ok(self.info.duration_us);
        }

        let anchor = self
            .selected
            .iter()
            .copied()
            .find(|&index| self.tracks[index].info.kind == TrackKind::Video)
            .or_else(|| self.selected.first().copied());
        let (Some(anchor), true) = (anchor, target_us > 0 && self.bytes_per_us > 0.0) else {
            self.reset_position(self.data_start, self.base_ticks);
            return Ok(0);
        };

        let estimate = self
            .data_start
            .saturating_add((target_us as f64 * self.bytes_per_us) as u64);
        let saved_selected = std::mem::replace(&mut self.selected, vec![anchor]);
        let mut backoff_us = SEEK_BACKOFF_US;
        let mut found: Option<(u64, i64)> = None;
        let mut outcome = Ok(());
        for _ in 0..SEEK_MAX_ATTEMPTS {
            let back = (backoff_us as f64 * self.bytes_per_us) as u64;
            let start = self.align(estimate.saturating_sub(back));
            let reference = self.base_ticks + us_to_ticks((target_us - backoff_us).max(0));
            self.reset_position(start, reference);
            match self.scan_for_keyframe(anchor, target_us) {
                Ok(Some(hit)) => {
                    found = Some(hit);
                    break;
                }
                Ok(None) => {}
                Err(error) => {
                    outcome = Err(error);
                    break;
                }
            }
            if start <= self.data_start {
                break;
            }
            backoff_us = backoff_us.saturating_mul(4);
        }
        self.selected = saved_selected;
        outcome?;

        match found {
            Some((position, pts_us)) => {
                self.reset_position(position, self.base_ticks + us_to_ticks(pts_us));
                Ok(pts_us.clamp(0, target_us))
            }
            None => {
                self.reset_position(self.data_start, self.base_ticks);
                Ok(0)
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(pid: u16, pusi: bool, cc: u8, payload: &[u8]) -> Vec<u8> {
        let mut out = vec![
            SYNC_BYTE,
            ((pusi as u8) << 6) | (pid >> 8) as u8,
            pid as u8,
            0x10 | cc,
        ];
        out.extend_from_slice(payload);
        out.resize(TS_PACKET, 0xff);
        out
    }

    #[test]
    fn detects_188_and_192_byte_layouts() {
        let plain: Vec<u8> = (0..6).flat_map(|i| packet(0x100, false, i, &[])).collect();
        assert_eq!(detect_sync(&plain), Some((188, 0, 0)));
        assert!(looks_like_transport_stream(&plain));
        let m2ts: Vec<u8> = (0..6)
            .flat_map(|i| {
                let mut p = vec![0, 0, 0, 0];
                p.extend(packet(0x100, false, i, &[]));
                p
            })
            .collect();
        assert_eq!(detect_sync(&m2ts), Some((192, 4, 0)));
        assert!(!looks_like_transport_stream(
            b"not a transport stream at all"
        ));
    }

    #[test]
    fn parses_pat_and_pmt_sections() {
        // PAT: program 1 -> PMT PID 0x1000
        let pat = [
            0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xf0, 0x00, 0, 0, 0, 0,
        ];
        assert_eq!(parse_pat(&pat), vec![(1, 0x1000)]);
        // PMT: H.264 on 0x100, ADTS with language "deu" on 0x101
        let pmt = [
            0x02, 0xb0, 0x1d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x00, 0xf0, 0x00, 0x1b, 0xe1,
            0x00, 0xf0, 0x00, 0x0f, 0xe1, 0x01, 0xf0, 0x06, 0x0a, 0x04, b'd', b'e', b'u', 0x00, 0,
            0, 0, 0,
        ];
        let streams = parse_pmt(&pmt).expect("pmt");
        assert_eq!(streams.len(), 2);
        assert_eq!((streams[0].pid, streams[0].stream_type), (0x100, 0x1b));
        assert_eq!((streams[1].pid, streams[1].stream_type), (0x101, 0x0f));
        assert_eq!(
            descriptor_language(&streams[1].descriptors).as_deref(),
            Some("deu")
        );
    }

    #[test]
    fn section_buffer_handles_pointer_field_and_stuffing() {
        let mut buffer = SectionBuffer::default();
        let mut payload = vec![0u8]; // pointer_field 0
        payload.extend_from_slice(&[0x00, 0xb0, 0x05, 1, 2, 3, 4, 5, 0xff, 0xff]);
        let sections = buffer.push(&payload, true);
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].len(), 8);
        assert!(!buffer.active);
    }

    #[test]
    fn pes_header_extracts_pts_and_dts() {
        // PTS = 0x1ABCDE (90 kHz), DTS = PTS - 3000
        let pts: i64 = 0x1ABCDE;
        let dts: i64 = pts - 3000;
        let encode = |prefix: u8, value: i64| {
            [
                prefix | (((value >> 30) & 7) as u8) << 1 | 1,
                ((value >> 22) & 0xff) as u8,
                (((value >> 15) & 0x7f) as u8) << 1 | 1,
                ((value >> 7) & 0xff) as u8,
                ((value & 0x7f) as u8) << 1 | 1,
            ]
        };
        let mut pes = vec![0, 0, 1, 0xe0, 0, 0, 0x80, 0xc0, 10];
        pes.extend_from_slice(&encode(0x30, pts));
        pes.extend_from_slice(&encode(0x10, dts));
        pes.extend_from_slice(&[9, 9, 9]);
        let packet = parse_pes(&pes, 42).expect("pes");
        assert_eq!(packet.pts, Some(pts));
        assert_eq!(packet.dts, Some(dts));
        assert_eq!(packet.payload, vec![9, 9, 9]);
        assert_eq!(packet.start_pos, 42);
    }

    #[test]
    fn unwraps_33_bit_timestamps() {
        assert_eq!(unwrap_ticks(100, PTS_WRAP + 50), PTS_WRAP + 100);
        assert_eq!(unwrap_ticks(PTS_WRAP - 10, 5), -10);
        assert_eq!(unwrap_ticks(5_000, 4_000), 5_000);
    }

    #[test]
    fn splits_annex_b_access_units_and_flags_idr() {
        let mut es = VideoEs::new(false);
        // AUD, SPS, PPS, IDR slice | AUD, non-IDR slice (first_mb_in_slice = 0)
        let mut payload = Vec::new();
        payload.extend_from_slice(&[0, 0, 0, 1, 0x09, 0xf0]);
        payload.extend_from_slice(&[0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1e, 0xd9, 0x00]);
        payload.extend_from_slice(&[0, 0, 0, 1, 0x68, 0xce, 0x38, 0x80]);
        payload.extend_from_slice(&[0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00]);
        let first_len = payload.len();
        payload.extend_from_slice(&[0, 0, 0, 1, 0x09, 0xf0]);
        payload.extend_from_slice(&[0, 0, 0, 1, 0x41, 0x9a, 0x00]);
        es.frame_ticks = 3000;
        let frames = es.push(payload, Some(90_000), Some(87_000));
        assert_eq!(frames.len(), 2);
        assert!(frames[0].keyframe);
        assert_eq!(frames[0].data.len(), first_len);
        assert_eq!(frames[0].pts, Some(90_000));
        assert!(!frames[1].keyframe);
        assert_eq!(frames[1].dts, Some(90_000));
        assert!(!es.sps.is_empty() && !es.pps.is_empty());

        // A key frame without parameter sets gets them injected after the AUD.
        let bare = vec![0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00];
        let frames = es.push(bare.clone(), Some(93_000), None);
        assert_eq!(frames.len(), 1);
        assert!(frames[0].keyframe);
        assert!(frames[0].data.len() > bare.len());
        assert_eq!(&frames[0].data[..6], &bare[..6]);
        assert_eq!(frames[0].data[10], 0x67);
    }

    #[test]
    fn adts_frames_are_stripped_and_timed() {
        let mut es = AudioEs::new(AudioSyntax::Adts);
        let frame = |len: usize| {
            let mut out = vec![
                0xffu8,
                0xf1,
                0x4c,
                0x80,
                (len >> 3) as u8,
                ((len & 7) as u8) << 5 | 0x1f,
                0xfc,
            ];
            out.resize(len, 0xaa);
            out
        };
        let mut payload = frame(20);
        payload.extend(frame(24));
        let partial = frame(30);
        payload.extend_from_slice(&partial[..10]);
        let frames = es.push(&payload, Some(180_000));
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].data.len(), 13);
        assert_eq!(frames[1].data.len(), 17);
        assert_eq!(frames[0].pts, Some(180_000));
        assert_eq!(frames[1].pts, Some(180_000 + 1920));
        assert_eq!(frames[0].duration_ticks, 1920);
        let frames = es.push(&partial[10..], None);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].pts, Some(180_000 + 2 * 1920));
        assert_eq!(
            es.params.as_ref().and_then(|p| p.codec.clone()).as_deref(),
            Some("mp4a.40.2")
        );
    }

    #[test]
    fn private_streams_are_classified_by_descriptor_then_content() {
        assert!(matches!(
            classify_stream(0x06, &[]),
            StreamClass::PrivateData
        ));
        assert!(matches!(
            classify_stream(0x06, &[(0x59, vec![0; 8])]),
            StreamClass::Skip
        ));
        assert!(matches!(
            classify_stream(0x06, &[(0x56, vec![0; 5])]),
            StreamClass::Skip
        ));
        assert!(matches!(
            classify_stream(0x06, &[(0x6a, vec![])]),
            StreamClass::Ac3 { enhanced: false }
        ));

        let adts = |len: usize| {
            let mut out = vec![
                0xffu8,
                0xf1,
                0x4c,
                0x40,
                (len >> 3) as u8,
                ((len & 7) as u8) << 5 | 0x1f,
                0xfc,
            ];
            out.resize(len, 0x21);
            out
        };
        let mut two = adts(40);
        two.extend(adts(36));
        assert!(matches!(
            sniff_private_audio(&two),
            Some((AudioSyntax::Adts, "aac"))
        ));
        assert!(matches!(
            sniff_private_audio(&adts(40)),
            Some((AudioSyntax::Adts, "aac"))
        ));
        // AC-3, 48 kHz, 32 kbit/s: 64-word frames.
        let mut ac3 = vec![0x0bu8, 0x77, 0x00, 0x00, 0x00, 0x40, 0x40];
        ac3.resize(128, 0);
        assert!(matches!(
            sniff_private_audio(&ac3),
            Some((AudioSyntax::Ac3, "ac3"))
        ));
        // MPEG-1 Layer II, 128 kbit/s, 48 kHz: 384-byte frames.
        let mut mp2 = vec![0xffu8, 0xfd, 0x84, 0x44];
        mp2.resize(384, 0x55);
        mp2.extend_from_slice(&[0xff, 0xfd, 0x84, 0x44]);
        mp2.resize(768, 0x55);
        assert!(matches!(
            sniff_private_audio(&mp2),
            Some((AudioSyntax::MpegAudio, "mp2"))
        ));
        // A valid header followed by bytes that are no second frame is not audio.
        let mut broken = adts(40);
        broken.extend_from_slice(&[0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
        assert!(sniff_private_audio(&broken).is_none());
        assert!(sniff_private_audio(b"data carousel bytes").is_none());
        assert!(sniff_private_audio(&[]).is_none());
    }
}
