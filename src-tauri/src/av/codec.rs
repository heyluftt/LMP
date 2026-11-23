//! Codec parameter parsing for the LMP demuxers.
//!
//! Everything here turns container-level codec configuration (avcC, hvcC,
//! vpcC, av1C, esds, dOps, dfLa, Matroska CodecPrivate) into the WebCodecs
//! `codec` string plus the `description` bytes the frontend decoder needs.

use super::reader::{BitReader, ByteCursor};

#[derive(Clone, Debug, Default)]
pub struct VideoCodecParams {
    pub family: String,
    pub codec: Option<String>,
    pub description: Option<Vec<u8>>,
}

#[derive(Clone, Debug, Default)]
pub struct AudioCodecParams {
    pub family: String,
    pub codec: Option<String>,
    pub description: Option<Vec<u8>>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
}

// ---------------------------------------------------------------------------
// H.264 / AVC
// ---------------------------------------------------------------------------

pub fn avc_params(avcc: &[u8]) -> VideoCodecParams {
    let codec = if avcc.len() >= 4 {
        Some(format!(
            "avc1.{:02x}{:02x}{:02x}",
            avcc[1], avcc[2], avcc[3]
        ))
    } else {
        None
    };
    VideoCodecParams {
        family: "h264".to_string(),
        codec,
        description: (avcc.len() >= 4).then(|| avcc.to_vec()),
    }
}

// ---------------------------------------------------------------------------
// H.265 / HEVC
// ---------------------------------------------------------------------------

pub fn hevc_params(hvcc: &[u8]) -> VideoCodecParams {
    let codec = hevc_codec_string(hvcc);
    VideoCodecParams {
        family: "hevc".to_string(),
        codec,
        description: (hvcc.len() >= 23).then(|| hvcc.to_vec()),
    }
}

pub fn hevc_codec_string(hvcc: &[u8]) -> Option<String> {
    if hvcc.len() < 13 {
        return None;
    }
    let profile_space = hvcc[1] >> 6;
    let tier = (hvcc[1] >> 5) & 1;
    let profile_idc = hvcc[1] & 0x1f;
    let compat = u32::from_be_bytes([hvcc[2], hvcc[3], hvcc[4], hvcc[5]]);
    let constraints = &hvcc[6..12];
    let level_idc = hvcc[12];

    let mut reversed = 0u32;
    for bit in 0..32 {
        if compat & (1 << bit) != 0 {
            reversed |= 1 << (31 - bit);
        }
    }

    let space = match profile_space {
        1 => "A",
        2 => "B",
        3 => "C",
        _ => "",
    };
    let mut codec = format!(
        "hvc1.{space}{profile_idc}.{:X}.{}{level_idc}",
        reversed,
        if tier == 1 { "H" } else { "L" }
    );

    let mut trailing = constraints.len();
    while trailing > 0 && constraints[trailing - 1] == 0 {
        trailing -= 1;
    }
    for byte in &constraints[..trailing] {
        codec.push_str(&format!(".{byte:X}"));
    }
    Some(codec)
}

// ---------------------------------------------------------------------------
// VP8 / VP9
// ---------------------------------------------------------------------------

pub fn vp8_params() -> VideoCodecParams {
    VideoCodecParams {
        family: "vp8".to_string(),
        codec: Some("vp8".to_string()),
        description: None,
    }
}

/// `vpcC` payload after the FullBox version/flags bytes.
pub fn vp9_params_from_vpcc(vpcc: &[u8]) -> VideoCodecParams {
    let codec = if vpcc.len() >= 3 {
        let profile = vpcc[0];
        let level = vpcc[1];
        let bit_depth = vpcc[2] >> 4;
        Some(format!("vp09.{profile:02}.{level:02}.{bit_depth:02}"))
    } else {
        None
    };
    VideoCodecParams {
        family: "vp9".to_string(),
        codec,
        description: None,
    }
}

/// Matroska `V_VP9` CodecPrivate: a list of {id, length, value} features.
pub fn vp9_params_from_matroska_private(private: &[u8]) -> Option<VideoCodecParams> {
    let mut cursor = ByteCursor::new(private);
    let mut profile = None;
    let mut level = None;
    let mut bit_depth = None;
    while cursor.remaining() >= 2 {
        let id = cursor.u8().ok()?;
        let len = cursor.u8().ok()? as usize;
        let value = cursor.bytes(len).ok()?;
        let number = value
            .iter()
            .fold(0u32, |acc, byte| (acc << 8) | *byte as u32);
        match id {
            1 => profile = Some(number),
            2 => level = Some(number),
            3 => bit_depth = Some(number),
            _ => {}
        }
    }
    let profile = profile?;
    Some(VideoCodecParams {
        family: "vp9".to_string(),
        codec: Some(format!(
            "vp09.{profile:02}.{:02}.{:02}",
            level.unwrap_or(10),
            bit_depth.unwrap_or(8)
        )),
        description: None,
    })
}

/// Derives the VP9 profile and bit depth from an uncompressed key frame header.
pub fn vp9_params_from_keyframe(frame: &[u8]) -> Option<VideoCodecParams> {
    let mut bits = BitReader::new(frame);
    let marker = bits.read(2).ok()?;
    if marker != 2 {
        return None;
    }
    let profile_low = bits.read(1).ok()?;
    let profile_high = bits.read(1).ok()?;
    let mut profile = (profile_high << 1) | profile_low;
    if profile == 3 {
        bits.skip(1).ok()?;
    }
    let show_existing_frame = bits.flag().ok()?;
    if show_existing_frame {
        return None;
    }
    let frame_type = bits.read(1).ok()?;
    if frame_type != 0 {
        return None;
    }
    bits.skip(2).ok()?; // show_frame, error_resilient_mode
    let sync = bits.read(24).ok()?;
    if sync != 0x49_83_42 {
        return None;
    }
    let bit_depth = if profile >= 2 {
        if bits.flag().ok()? {
            12
        } else {
            10
        }
    } else {
        8
    };
    if profile > 3 {
        profile = 0;
    }
    Some(VideoCodecParams {
        family: "vp9".to_string(),
        codec: Some(format!("vp09.{profile:02}.10.{bit_depth:02}")),
        description: None,
    })
}

// ---------------------------------------------------------------------------
// AV1
// ---------------------------------------------------------------------------

/// `av1C` box payload (starts with the 0x81 marker/version byte).
pub fn av1_params_from_av1c(av1c: &[u8]) -> VideoCodecParams {
    let codec = if av1c.len() >= 4 && av1c[0] & 0x80 != 0 {
        let profile = av1c[1] >> 5;
        let level = av1c[1] & 0x1f;
        let tier = (av1c[2] >> 7) & 1;
        let high_bitdepth = (av1c[2] >> 6) & 1;
        let twelve_bit = (av1c[2] >> 5) & 1;
        let bit_depth = if high_bitdepth == 1 {
            if twelve_bit == 1 {
                12
            } else {
                10
            }
        } else {
            8
        };
        Some(format!(
            "av01.{profile}.{level:02}{}.{bit_depth:02}",
            if tier == 1 { "H" } else { "M" }
        ))
    } else {
        None
    };
    VideoCodecParams {
        family: "av1".to_string(),
        codec,
        description: (av1c.len() >= 4).then(|| av1c.to_vec()),
    }
}

/// Finds the sequence header OBU inside a temporal unit and derives the codec
/// string from it. Used when the container does not carry an `av1C` record.
pub fn av1_params_from_temporal_unit(data: &[u8]) -> Option<VideoCodecParams> {
    let mut cursor = ByteCursor::new(data);
    while cursor.remaining() >= 2 {
        let header = cursor.u8().ok()?;
        let obu_type = (header >> 3) & 0x0f;
        let extension = (header >> 2) & 1 == 1;
        let has_size = (header >> 1) & 1 == 1;
        if extension {
            cursor.u8().ok()?;
        }
        let size = if has_size {
            read_leb128(&mut cursor)? as usize
        } else {
            cursor.remaining()
        };
        let payload = cursor.bytes(size.min(cursor.remaining())).ok()?;
        if obu_type == 1 {
            return parse_av1_sequence_header(payload);
        }
    }
    None
}

fn read_leb128(cursor: &mut ByteCursor) -> Option<u64> {
    let mut value = 0u64;
    for index in 0..8 {
        let byte = cursor.u8().ok()?;
        value |= ((byte & 0x7f) as u64) << (index * 7);
        if byte & 0x80 == 0 {
            return Some(value);
        }
    }
    Some(value)
}

fn parse_av1_sequence_header(payload: &[u8]) -> Option<VideoCodecParams> {
    let mut bits = BitReader::new(payload);
    let seq_profile = bits.read(3).ok()?;
    let _still_picture = bits.flag().ok()?;
    let reduced_still_picture_header = bits.flag().ok()?;

    let mut seq_level_idx = 0u64;
    let mut seq_tier = 0u64;
    let mut decoder_model_info_present = false;
    let mut buffer_delay_length_minus_1 = 0u64;

    if reduced_still_picture_header {
        seq_level_idx = bits.read(5).ok()?;
    } else {
        let timing_info_present = bits.flag().ok()?;
        if timing_info_present {
            bits.skip(32).ok()?; // num_units_in_display_tick
            bits.skip(32).ok()?; // time_scale
            let equal_picture_interval = bits.flag().ok()?;
            if equal_picture_interval {
                bits.uvlc().ok()?;
            }
            decoder_model_info_present = bits.flag().ok()?;
            if decoder_model_info_present {
                buffer_delay_length_minus_1 = bits.read(5).ok()?;
                bits.skip(32).ok()?; // num_units_in_decoding_tick
                bits.skip(5).ok()?; // buffer_removal_time_length_minus_1
                bits.skip(5).ok()?; // frame_presentation_time_length_minus_1
            }
        }
        let initial_display_delay_present = bits.flag().ok()?;
        let operating_points_cnt_minus_1 = bits.read(5).ok()?;
        for index in 0..=operating_points_cnt_minus_1 {
            bits.skip(12).ok()?; // operating_point_idc
            let level = bits.read(5).ok()?;
            let mut tier = 0;
            if level > 7 {
                tier = bits.read(1).ok()?;
            }
            if decoder_model_info_present {
                let present = bits.flag().ok()?;
                if present {
                    let n = (buffer_delay_length_minus_1 + 1) as u32;
                    bits.skip(n).ok()?; // decoder_buffer_delay
                    bits.skip(n).ok()?; // encoder_buffer_delay
                    bits.skip(1).ok()?; // low_delay_mode_flag
                }
            }
            if initial_display_delay_present {
                let present = bits.flag().ok()?;
                if present {
                    bits.skip(4).ok()?;
                }
            }
            if index == 0 {
                seq_level_idx = level;
                seq_tier = tier;
            }
        }
    }

    let frame_width_bits = bits.read(4).ok()? as u32 + 1;
    let frame_height_bits = bits.read(4).ok()? as u32 + 1;
    bits.skip(frame_width_bits).ok()?;
    bits.skip(frame_height_bits).ok()?;

    if !reduced_still_picture_header {
        let frame_id_numbers_present = bits.flag().ok()?;
        if frame_id_numbers_present {
            bits.skip(4).ok()?;
            bits.skip(3).ok()?;
        }
    }
    bits.skip(3).ok()?; // use_128x128_superblock, enable_filter_intra, enable_intra_edge_filter

    if !reduced_still_picture_header {
        bits.skip(4).ok()?; // interintra, masked, warped, dual_filter
        let enable_order_hint = bits.flag().ok()?;
        if enable_order_hint {
            bits.skip(2).ok()?; // jnt_comp, ref_frame_mvs
        }
        let seq_choose_screen_content_tools = bits.flag().ok()?;
        let seq_force_screen_content_tools = if seq_choose_screen_content_tools {
            2
        } else {
            bits.read(1).ok()?
        };
        if seq_force_screen_content_tools > 0 {
            let seq_choose_integer_mv = bits.flag().ok()?;
            if !seq_choose_integer_mv {
                bits.skip(1).ok()?;
            }
        }
        if enable_order_hint {
            bits.skip(3).ok()?;
        }
    }
    bits.skip(3).ok()?; // enable_superres, enable_cdef, enable_restoration

    // color_config()
    let high_bitdepth = bits.flag().ok()?;
    let bit_depth = if seq_profile == 2 && high_bitdepth {
        if bits.flag().ok()? {
            12
        } else {
            10
        }
    } else if high_bitdepth {
        10
    } else {
        8
    };

    Some(VideoCodecParams {
        family: "av1".to_string(),
        codec: Some(format!(
            "av01.{seq_profile}.{seq_level_idx:02}{}.{bit_depth:02}",
            if seq_tier == 1 { "H" } else { "M" }
        )),
        description: None,
    })
}

// ---------------------------------------------------------------------------
// AAC / MPEG-4 audio
// ---------------------------------------------------------------------------

const AAC_SAMPLE_RATES: [u32; 13] = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/// Parses an AudioSpecificConfig (esds DecoderSpecificInfo / Matroska A_AAC CodecPrivate).
pub fn aac_params(asc: &[u8]) -> AudioCodecParams {
    let mut params = AudioCodecParams {
        family: "aac".to_string(),
        codec: Some("mp4a.40.2".to_string()),
        description: (!asc.is_empty()).then(|| asc.to_vec()),
        sample_rate: None,
        channels: None,
    };
    let mut bits = BitReader::new(asc);
    let Ok(mut object_type) = bits.read(5) else {
        return params;
    };
    if object_type == 31 {
        object_type = 32 + bits.read(6).unwrap_or(0);
    }
    let frequency_index = bits.read(4).unwrap_or(15);
    let sample_rate = if frequency_index == 15 {
        bits.read(24).ok().map(|value| value as u32)
    } else {
        AAC_SAMPLE_RATES.get(frequency_index as usize).copied()
    };
    let channel_config = bits.read(4).unwrap_or(0) as u32;
    let mut channels = match channel_config {
        1..=6 => Some(channel_config),
        7 => Some(8),
        _ => None,
    };
    let mut effective_rate = sample_rate;
    if object_type == 5 || object_type == 29 {
        // Explicit SBR / PS: the extension sampling frequency is the output rate.
        let extension_index = bits.read(4).unwrap_or(15);
        if extension_index == 15 {
            effective_rate = bits.read(24).ok().map(|value| value as u32);
        } else {
            effective_rate = AAC_SAMPLE_RATES.get(extension_index as usize).copied();
        }
        if object_type == 29 && channels == Some(1) {
            channels = Some(2);
        }
    }
    params.codec = Some(format!("mp4a.40.{object_type}"));
    params.sample_rate = effective_rate.or(sample_rate);
    params.channels = channels;
    params
}

/// Walks an `esds` payload (after the FullBox version/flags) to find the
/// object type indication and decoder specific info.
pub fn parse_esds(esds: &[u8]) -> Option<(u8, Option<Vec<u8>>)> {
    let mut cursor = ByteCursor::new(esds);
    let (tag, _) = read_descriptor_header(&mut cursor)?;
    if tag != 0x03 {
        return None;
    }
    cursor.skip(2).ok()?; // ES_ID
    let flags = cursor.u8().ok()?;
    if flags & 0x80 != 0 {
        cursor.skip(2).ok()?;
    }
    if flags & 0x40 != 0 {
        let url_len = cursor.u8().ok()? as usize;
        cursor.skip(url_len).ok()?;
    }
    if flags & 0x20 != 0 {
        cursor.skip(2).ok()?;
    }
    let (tag, size) = read_descriptor_header(&mut cursor)?;
    if tag != 0x04 {
        return None;
    }
    let decoder_config_end = cursor.position() + size;
    let object_type = cursor.u8().ok()?;
    cursor.skip(1).ok()?; // streamType
    cursor.skip(3).ok()?; // bufferSizeDB
    cursor.skip(4).ok()?; // maxBitrate
    cursor.skip(4).ok()?; // avgBitrate
    let mut specific_info = None;
    while cursor.position() < decoder_config_end && cursor.remaining() >= 2 {
        let Some((tag, size)) = read_descriptor_header(&mut cursor) else {
            break;
        };
        let data = cursor.bytes(size.min(cursor.remaining())).ok()?;
        if tag == 0x05 {
            specific_info = Some(data.to_vec());
            break;
        }
    }
    Some((object_type, specific_info))
}

fn read_descriptor_header(cursor: &mut ByteCursor) -> Option<(u8, usize)> {
    let tag = cursor.u8().ok()?;
    let mut size = 0usize;
    for _ in 0..4 {
        let byte = cursor.u8().ok()?;
        size = (size << 7) | (byte & 0x7f) as usize;
        if byte & 0x80 == 0 {
            break;
        }
    }
    Some((tag, size))
}

// ---------------------------------------------------------------------------
// Opus / FLAC / PCM helpers
// ---------------------------------------------------------------------------

/// Converts an MP4 `dOps` box payload into an `OpusHead` description.
pub fn opus_head_from_dops(dops: &[u8]) -> Option<Vec<u8>> {
    if dops.len() < 11 {
        return None;
    }
    let channels = dops[1];
    let pre_skip = u16::from_be_bytes([dops[2], dops[3]]);
    let input_rate = u32::from_be_bytes([dops[4], dops[5], dops[6], dops[7]]);
    let output_gain = i16::from_be_bytes([dops[8], dops[9]]);
    let mapping_family = dops[10];

    let mut head = Vec::with_capacity(19 + dops.len());
    head.extend_from_slice(b"OpusHead");
    head.push(1);
    head.push(channels);
    head.extend_from_slice(&pre_skip.to_le_bytes());
    head.extend_from_slice(&input_rate.to_le_bytes());
    head.extend_from_slice(&output_gain.to_le_bytes());
    head.push(mapping_family);
    if mapping_family != 0 {
        head.extend_from_slice(&dops[11..]);
    }
    Some(head)
}

pub fn opus_params(head: Option<Vec<u8>>) -> AudioCodecParams {
    let channels = head
        .as_ref()
        .filter(|head| head.len() >= 10 && head.starts_with(b"OpusHead"))
        .map(|head| head[9] as u32);
    AudioCodecParams {
        family: "opus".to_string(),
        codec: Some("opus".to_string()),
        description: head,
        sample_rate: Some(48000),
        channels,
    }
}

/// `dfLa` payload after the FullBox version/flags.
pub fn flac_description_from_dfla(dfla: &[u8]) -> Vec<u8> {
    let mut description = Vec::with_capacity(4 + dfla.len());
    description.extend_from_slice(b"fLaC");
    description.extend_from_slice(dfla);
    description
}

pub fn flac_params(description: Option<Vec<u8>>) -> AudioCodecParams {
    let mut params = AudioCodecParams {
        family: "flac".to_string(),
        codec: Some("flac".to_string()),
        description: None,
        sample_rate: None,
        channels: None,
    };
    if let Some(description) = description {
        // STREAMINFO: after "fLaC" + 4-byte block header, bytes 10..13 carry
        // the 20-bit sample rate, 3-bit channels-1 and 5-bit bits-per-sample-1.
        if description.len() >= 4 + 4 + 18 && description.starts_with(b"fLaC") {
            let info = &description[8..];
            let rate =
                ((info[10] as u32) << 12) | ((info[11] as u32) << 4) | ((info[12] as u32) >> 4);
            let channels = ((info[12] >> 1) & 0x07) as u32 + 1;
            params.sample_rate = Some(rate);
            params.channels = Some(channels);
        }
        params.description = Some(description);
    }
    params
}

pub fn vorbis_params(private: Option<Vec<u8>>) -> AudioCodecParams {
    AudioCodecParams {
        family: "vorbis".to_string(),
        codec: Some("vorbis".to_string()),
        description: private,
        sample_rate: None,
        channels: None,
    }
}

pub fn mp3_params() -> AudioCodecParams {
    AudioCodecParams {
        family: "mp3".to_string(),
        codec: Some("mp3".to_string()),
        description: None,
        sample_rate: None,
        channels: None,
    }
}

pub fn ac3_params(enhanced: bool) -> AudioCodecParams {
    AudioCodecParams {
        family: if enhanced { "eac3" } else { "ac3" }.to_string(),
        codec: Some(if enhanced { "ec-3" } else { "ac-3" }.to_string()),
        description: None,
        sample_rate: None,
        channels: None,
    }
}

pub fn pcm_params(bit_depth: u32, float: bool, little_endian: bool) -> AudioCodecParams {
    let codec = match (float, little_endian, bit_depth) {
        (true, true, 32) => Some("pcm-f32"),
        (false, true, 16) => Some("pcm-s16"),
        (false, true, 24) => Some("pcm-s24"),
        (false, true, 32) => Some("pcm-s32"),
        (false, _, 8) => Some("pcm-u8"),
        _ => None,
    };
    AudioCodecParams {
        family: "pcm".to_string(),
        codec: codec.map(ToString::to_string),
        description: None,
        sample_rate: None,
        channels: None,
    }
}

// ---------------------------------------------------------------------------
// Elementary stream headers (MPEG-TS carries codec parameters in-band)
// ---------------------------------------------------------------------------

/// Removes H.264 / HEVC emulation prevention bytes (`00 00 03` -> `00 00`).
pub fn nal_to_rbsp(nal: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(nal.len());
    let mut zeros = 0usize;
    for &byte in nal {
        if zeros >= 2 && byte == 3 {
            zeros = 0;
            continue;
        }
        out.push(byte);
        if byte == 0 {
            zeros += 1;
        } else {
            zeros = 0;
        }
    }
    out
}

fn sar_from_idc(idc: u8) -> Option<(u32, u32)> {
    const TABLE: [(u32, u32); 17] = [
        (1, 1),
        (1, 1),
        (12, 11),
        (10, 11),
        (16, 11),
        (40, 33),
        (24, 11),
        (20, 11),
        (32, 11),
        (80, 33),
        (18, 11),
        (15, 11),
        (64, 33),
        (160, 99),
        (4, 3),
        (3, 2),
        (2, 1),
    ];
    TABLE.get(idc as usize).copied()
}

#[derive(Clone, Debug, Default)]
pub struct AvcSps {
    pub id: u32,
    pub profile_idc: u8,
    pub constraint_flags: u8,
    pub level_idc: u8,
    pub chroma_format_idc: u32,
    pub bit_depth_luma: u32,
    pub bit_depth_chroma: u32,
    pub width: u32,
    pub height: u32,
    pub sar: (u32, u32),
    pub frame_rate: Option<f64>,
}

fn skip_avc_scaling_list(bits: &mut BitReader, size: usize) -> Option<()> {
    let mut last = 8i64;
    let mut next = 8i64;
    for _ in 0..size {
        if next != 0 {
            let delta = bits.se().ok()?;
            next = (last + delta + 256).rem_euclid(256);
        }
        if next != 0 {
            last = next;
        }
    }
    Some(())
}

/// Parses an H.264 sequence parameter set NAL unit (including its header byte).
pub fn parse_avc_sps(nal: &[u8]) -> Option<AvcSps> {
    if nal.len() < 4 || nal[0] & 0x1f != 7 {
        return None;
    }
    let rbsp = nal_to_rbsp(&nal[1..]);
    let mut bits = BitReader::new(&rbsp);
    let profile_idc = bits.read(8).ok()? as u8;
    let constraint_flags = bits.read(8).ok()? as u8;
    let level_idc = bits.read(8).ok()? as u8;
    let id = bits.ue().ok()? as u32;

    let mut chroma_format_idc = 1u32;
    let mut bit_depth_luma = 8u32;
    let mut bit_depth_chroma = 8u32;
    if matches!(
        profile_idc,
        100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135
    ) {
        chroma_format_idc = bits.ue().ok()? as u32;
        if chroma_format_idc == 3 {
            bits.skip(1).ok()?; // separate_colour_plane_flag
        }
        bit_depth_luma = bits.ue().ok()? as u32 + 8;
        bit_depth_chroma = bits.ue().ok()? as u32 + 8;
        bits.skip(1).ok()?; // qpprime_y_zero_transform_bypass_flag
        if bits.flag().ok()? {
            let lists = if chroma_format_idc != 3 { 8 } else { 12 };
            for index in 0..lists {
                if bits.flag().ok()? {
                    skip_avc_scaling_list(&mut bits, if index < 6 { 16 } else { 64 })?;
                }
            }
        }
    }
    bits.ue().ok()?; // log2_max_frame_num_minus4
    let poc_type = bits.ue().ok()?;
    if poc_type == 0 {
        bits.ue().ok()?;
    } else if poc_type == 1 {
        bits.skip(1).ok()?;
        bits.se().ok()?;
        bits.se().ok()?;
        let cycle = bits.ue().ok()?;
        if cycle > 255 {
            return None;
        }
        for _ in 0..cycle {
            bits.se().ok()?;
        }
    }
    bits.ue().ok()?; // max_num_ref_frames
    bits.skip(1).ok()?; // gaps_in_frame_num_value_allowed_flag
    let width_mbs = bits.ue().ok()? as u32 + 1;
    let height_units = bits.ue().ok()? as u32 + 1;
    let frame_mbs_only = bits.flag().ok()?;
    if !frame_mbs_only {
        bits.skip(1).ok()?; // mb_adaptive_frame_field_flag
    }
    bits.skip(1).ok()?; // direct_8x8_inference_flag
    let field_factor = if frame_mbs_only { 1 } else { 2 };
    let mut width = width_mbs * 16;
    let mut height = field_factor * height_units * 16;
    if bits.flag().ok()? {
        let left = bits.ue().ok()? as u32;
        let right = bits.ue().ok()? as u32;
        let top = bits.ue().ok()? as u32;
        let bottom = bits.ue().ok()? as u32;
        let (sub_w, sub_h) = match chroma_format_idc {
            0 => (1, 1),
            1 => (2, 2),
            2 => (2, 1),
            _ => (1, 1),
        };
        width = width.saturating_sub((left + right) * sub_w);
        height = height.saturating_sub((top + bottom) * sub_h * field_factor);
    }
    let mut sps = AvcSps {
        id,
        profile_idc,
        constraint_flags,
        level_idc,
        chroma_format_idc,
        bit_depth_luma,
        bit_depth_chroma,
        width,
        height,
        sar: (1, 1),
        frame_rate: None,
    };
    if bits.flag().ok()? {
        let _ = parse_avc_vui(&mut bits, &mut sps);
    }
    Some(sps)
}

fn parse_avc_vui(bits: &mut BitReader, sps: &mut AvcSps) -> Result<(), String> {
    if bits.flag()? {
        let idc = bits.read(8)?;
        if idc == 255 {
            let w = bits.read(16)? as u32;
            let h = bits.read(16)? as u32;
            if w > 0 && h > 0 {
                sps.sar = (w, h);
            }
        } else if let Some(sar) = sar_from_idc(idc as u8) {
            sps.sar = sar;
        }
    }
    if bits.flag()? {
        bits.skip(1)?; // overscan_appropriate_flag
    }
    if bits.flag()? {
        bits.skip(4)?; // video_format, video_full_range_flag
        if bits.flag()? {
            bits.skip(24)?; // colour primaries, transfer, matrix
        }
    }
    if bits.flag()? {
        bits.ue()?;
        bits.ue()?;
    }
    if bits.flag()? {
        let num_units = bits.read(32)? as f64;
        let time_scale = bits.read(32)? as f64;
        if num_units > 0.0 && time_scale > 0.0 {
            let fps = time_scale / (2.0 * num_units);
            if fps > 1.0 && fps <= 1000.0 {
                sps.frame_rate = Some(fps);
            }
        }
    }
    Ok(())
}

/// Picture parameter set id of an H.264 PPS NAL unit.
pub fn avc_pps_id(nal: &[u8]) -> Option<u32> {
    if nal.len() < 2 || nal[0] & 0x1f != 8 {
        return None;
    }
    let rbsp = nal_to_rbsp(&nal[1..nal.len().min(8)]);
    BitReader::new(&rbsp).ue().ok().map(|value| value as u32)
}

pub fn avc_params_from_sps(sps: &AvcSps) -> VideoCodecParams {
    VideoCodecParams {
        family: "h264".to_string(),
        codec: Some(format!(
            "avc1.{:02x}{:02x}{:02x}",
            sps.profile_idc, sps.constraint_flags, sps.level_idc
        )),
        description: None,
    }
}

#[derive(Clone, Debug, Default)]
pub struct HevcSps {
    pub id: u32,
    pub profile_space: u8,
    pub tier: u8,
    pub profile_idc: u8,
    pub compat_flags: u32,
    pub constraint_flags: [u8; 6],
    pub level_idc: u8,
    pub chroma_format_idc: u32,
    pub bit_depth_luma: u32,
    pub bit_depth_chroma: u32,
    pub width: u32,
    pub height: u32,
    pub sar: (u32, u32),
    pub frame_rate: Option<f64>,
}

/// Parses an HEVC sequence parameter set NAL unit (including its two header bytes).
pub fn parse_hevc_sps(nal: &[u8]) -> Option<HevcSps> {
    if nal.len() < 6 || (nal[0] >> 1) & 0x3f != 33 {
        return None;
    }
    let rbsp = nal_to_rbsp(&nal[2..]);
    let mut bits = BitReader::new(&rbsp);
    bits.skip(4).ok()?; // sps_video_parameter_set_id
    let max_sub_layers_minus1 = bits.read(3).ok()? as u32;
    bits.skip(1).ok()?; // sps_temporal_id_nesting_flag

    // profile_tier_level(1, max_sub_layers_minus1)
    let profile_space = bits.read(2).ok()? as u8;
    let tier = bits.read(1).ok()? as u8;
    let profile_idc = bits.read(5).ok()? as u8;
    let compat_flags = bits.read(32).ok()? as u32;
    let mut constraint_flags = [0u8; 6];
    for byte in constraint_flags.iter_mut() {
        *byte = bits.read(8).ok()? as u8;
    }
    let level_idc = bits.read(8).ok()? as u8;
    let mut profile_present = [false; 8];
    let mut level_present = [false; 8];
    for index in 0..max_sub_layers_minus1 as usize {
        profile_present[index] = bits.flag().ok()?;
        level_present[index] = bits.flag().ok()?;
    }
    if max_sub_layers_minus1 > 0 {
        for _ in max_sub_layers_minus1..8 {
            bits.skip(2).ok()?;
        }
    }
    for index in 0..max_sub_layers_minus1 as usize {
        if profile_present[index] {
            bits.skip(88).ok()?;
        }
        if level_present[index] {
            bits.skip(8).ok()?;
        }
    }

    let id = bits.ue().ok()? as u32;
    let chroma_format_idc = bits.ue().ok()? as u32;
    if chroma_format_idc == 3 {
        bits.skip(1).ok()?; // separate_colour_plane_flag
    }
    let mut width = bits.ue().ok()? as u32;
    let mut height = bits.ue().ok()? as u32;
    if bits.flag().ok()? {
        let left = bits.ue().ok()? as u32;
        let right = bits.ue().ok()? as u32;
        let top = bits.ue().ok()? as u32;
        let bottom = bits.ue().ok()? as u32;
        let (sub_w, sub_h) = match chroma_format_idc {
            1 => (2, 2),
            2 => (2, 1),
            _ => (1, 1),
        };
        width = width.saturating_sub((left + right) * sub_w);
        height = height.saturating_sub((top + bottom) * sub_h);
    }
    let bit_depth_luma = bits.ue().ok()? as u32 + 8;
    let bit_depth_chroma = bits.ue().ok()? as u32 + 8;

    let mut sps = HevcSps {
        id,
        profile_space,
        tier,
        profile_idc,
        compat_flags,
        constraint_flags,
        level_idc,
        chroma_format_idc,
        bit_depth_luma,
        bit_depth_chroma,
        width,
        height,
        sar: (1, 1),
        frame_rate: None,
    };
    // Everything after this point only refines SAR / frame rate; a parse
    // failure keeps the geometry and profile information above.
    let _ = parse_hevc_sps_tail(&mut bits, max_sub_layers_minus1, &mut sps);
    Some(sps)
}

fn parse_hevc_sps_tail(
    bits: &mut BitReader,
    max_sub_layers_minus1: u32,
    sps: &mut HevcSps,
) -> Result<(), String> {
    let log2_max_poc_lsb = bits.ue()? as u32 + 4;
    let ordering_info_present = bits.flag()?;
    let start = if ordering_info_present {
        0
    } else {
        max_sub_layers_minus1
    };
    for _ in start..=max_sub_layers_minus1 {
        bits.ue()?;
        bits.ue()?;
        bits.ue()?;
    }
    for _ in 0..6 {
        bits.ue()?; // coding block / transform block sizes, hierarchy depths
    }
    if bits.flag()? && bits.flag()? {
        skip_hevc_scaling_list_data(bits)?;
    }
    bits.skip(2)?; // amp_enabled_flag, sample_adaptive_offset_enabled_flag
    if bits.flag()? {
        bits.skip(8)?; // pcm bit depths
        bits.ue()?;
        bits.ue()?;
        bits.skip(1)?; // pcm_loop_filter_disabled_flag
    }
    let num_sets = bits.ue()? as usize;
    if num_sets > 64 {
        return Err("Too many short-term reference picture sets.".to_string());
    }
    let mut num_delta_pocs = vec![0u64; num_sets];
    for index in 0..num_sets {
        num_delta_pocs[index] = skip_hevc_st_ref_pic_set(bits, index, &num_delta_pocs)?;
    }
    if bits.flag()? {
        let count = bits.ue()?;
        if count > 32 {
            return Err("Too many long-term reference pictures.".to_string());
        }
        for _ in 0..count {
            bits.skip(log2_max_poc_lsb)?;
            bits.skip(1)?;
        }
    }
    bits.skip(2)?; // sps_temporal_mvp_enabled_flag, strong_intra_smoothing_enabled_flag
    if !bits.flag()? {
        return Ok(());
    }
    // vui_parameters()
    if bits.flag()? {
        let idc = bits.read(8)?;
        if idc == 255 {
            let w = bits.read(16)? as u32;
            let h = bits.read(16)? as u32;
            if w > 0 && h > 0 {
                sps.sar = (w, h);
            }
        } else if let Some(sar) = sar_from_idc(idc as u8) {
            sps.sar = sar;
        }
    }
    if bits.flag()? {
        bits.skip(1)?;
    }
    if bits.flag()? {
        bits.skip(4)?;
        if bits.flag()? {
            bits.skip(24)?;
        }
    }
    if bits.flag()? {
        bits.ue()?;
        bits.ue()?;
    }
    bits.skip(3)?; // neutral_chroma, field_seq, frame_field_info_present
    if bits.flag()? {
        for _ in 0..4 {
            bits.ue()?;
        }
    }
    if bits.flag()? {
        let num_units = bits.read(32)? as f64;
        let time_scale = bits.read(32)? as f64;
        if num_units > 0.0 && time_scale > 0.0 {
            let fps = time_scale / num_units;
            if fps > 1.0 && fps <= 1000.0 {
                sps.frame_rate = Some(fps);
            }
        }
    }
    Ok(())
}

fn skip_hevc_scaling_list_data(bits: &mut BitReader) -> Result<(), String> {
    for size_id in 0..4u32 {
        let step = if size_id == 3 { 3 } else { 1 };
        let mut matrix_id = 0;
        while matrix_id < 6 {
            if !bits.flag()? {
                bits.ue()?; // scaling_list_pred_matrix_id_delta
            } else {
                let coef_num = 64.min(1u32 << (4 + (size_id << 1)));
                if size_id > 1 {
                    bits.se()?;
                }
                for _ in 0..coef_num {
                    bits.se()?;
                }
            }
            matrix_id += step;
        }
    }
    Ok(())
}

/// Skips one st_ref_pic_set() and returns its NumDeltaPocs.
fn skip_hevc_st_ref_pic_set(
    bits: &mut BitReader,
    index: usize,
    num_delta_pocs: &[u64],
) -> Result<u64, String> {
    let inter = index != 0 && bits.flag()?;
    if inter {
        bits.skip(1)?; // delta_rps_sign
        bits.ue()?; // abs_delta_rps_minus1
        let reference = num_delta_pocs
            .get(index - 1)
            .copied()
            .ok_or_else(|| "Invalid reference picture set.".to_string())?;
        if reference > 64 {
            return Err("Reference picture set is too large.".to_string());
        }
        let mut count = 0;
        for _ in 0..=reference {
            let used = bits.flag()?;
            let use_delta = if used { true } else { bits.flag()? };
            if use_delta {
                count += 1;
            }
        }
        Ok(count)
    } else {
        let negative = bits.ue()?;
        let positive = bits.ue()?;
        if negative + positive > 64 {
            return Err("Reference picture set is too large.".to_string());
        }
        for _ in 0..negative + positive {
            bits.ue()?;
            bits.skip(1)?;
        }
        Ok(negative + positive)
    }
}

/// Picture parameter set id of an HEVC PPS NAL unit.
pub fn hevc_pps_id(nal: &[u8]) -> Option<u32> {
    if nal.len() < 3 || (nal[0] >> 1) & 0x3f != 34 {
        return None;
    }
    let rbsp = nal_to_rbsp(&nal[2..nal.len().min(9)]);
    BitReader::new(&rbsp).ue().ok().map(|value| value as u32)
}

pub fn hevc_params_from_sps(sps: &HevcSps) -> VideoCodecParams {
    let mut head = vec![
        1u8,
        (sps.profile_space << 6) | (sps.tier << 5) | (sps.profile_idc & 0x1f),
    ];
    head.extend_from_slice(&sps.compat_flags.to_be_bytes());
    head.extend_from_slice(&sps.constraint_flags);
    head.push(sps.level_idc);
    VideoCodecParams {
        family: "hevc".to_string(),
        codec: hevc_codec_string(&head),
        description: None,
    }
}

#[derive(Clone, Copy, Debug)]
pub struct AdtsHeader {
    pub header_len: usize,
    pub frame_len: usize,
    pub object_type: u8,
    pub sample_rate_index: u8,
    pub sample_rate: u32,
    pub channel_config: u8,
    pub raw_blocks: u32,
}

/// Parses an ADTS frame header (7 or 9 bytes).
pub fn parse_adts_header(data: &[u8]) -> Option<AdtsHeader> {
    if data.len() < 7 || data[0] != 0xff || data[1] & 0xf6 != 0xf0 {
        return None;
    }
    let protection_absent = data[1] & 1 == 1;
    let profile = data[2] >> 6;
    let sample_rate_index = (data[2] >> 2) & 0x0f;
    let channel_config = ((data[2] & 1) << 2) | (data[3] >> 6);
    let frame_len =
        (((data[3] & 3) as usize) << 11) | ((data[4] as usize) << 3) | ((data[5] as usize) >> 5);
    let raw_blocks = (data[6] & 3) as u32 + 1;
    let header_len = if protection_absent { 7 } else { 9 };
    let sample_rate = *AAC_SAMPLE_RATES.get(sample_rate_index as usize)?;
    if frame_len <= header_len {
        return None;
    }
    Some(AdtsHeader {
        header_len,
        frame_len,
        object_type: profile + 1,
        sample_rate_index,
        sample_rate,
        channel_config,
        raw_blocks,
    })
}

/// Builds the two-byte AudioSpecificConfig equivalent to an ADTS header.
pub fn adts_audio_specific_config(header: &AdtsHeader) -> Vec<u8> {
    vec![
        (header.object_type << 3) | (header.sample_rate_index >> 1),
        ((header.sample_rate_index & 1) << 7) | (header.channel_config << 3),
    ]
}

#[derive(Clone, Copy, Debug)]
pub struct MpegAudioHeader {
    /// 1, 2 or 3.
    pub layer: u8,
    pub frame_len: usize,
    pub sample_rate: u32,
    pub channels: u32,
    pub samples_per_frame: u32,
}

/// Parses an MPEG-1/2/2.5 audio frame header (4 bytes).
pub fn parse_mpeg_audio_header(data: &[u8]) -> Option<MpegAudioHeader> {
    const BITRATES: [[u32; 16]; 5] = [
        [
            0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0,
        ],
        [
            0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0,
        ],
        [
            0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
        ],
        [
            0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0,
        ],
        [
            0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
        ],
    ];
    if data.len() < 4 || data[0] != 0xff || data[1] & 0xe0 != 0xe0 {
        return None;
    }
    let version_bits = (data[1] >> 3) & 3; // 0 = MPEG-2.5, 2 = MPEG-2, 3 = MPEG-1
    let layer_bits = (data[1] >> 1) & 3; // 1 = III, 2 = II, 3 = I
    if version_bits == 1 || layer_bits == 0 {
        return None;
    }
    let bitrate_index = (data[2] >> 4) as usize;
    let rate_index = ((data[2] >> 2) & 3) as usize;
    if bitrate_index == 0 || bitrate_index == 15 || rate_index == 3 {
        return None;
    }
    let padding = ((data[2] >> 1) & 1) as usize;
    let channels = if data[3] >> 6 == 3 { 1 } else { 2 };
    let layer = 4 - layer_bits;
    let mpeg1 = version_bits == 3;
    let sample_rate = match version_bits {
        3 => [44100, 48000, 32000],
        2 => [22050, 24000, 16000],
        _ => [11025, 12000, 8000],
    }[rate_index];
    let table = match (mpeg1, layer) {
        (true, 1) => 0,
        (true, 2) => 1,
        (true, _) => 2,
        (false, 1) => 3,
        (false, _) => 4,
    };
    let bitrate = BITRATES[table][bitrate_index] as usize * 1000;
    let rate = sample_rate as usize;
    let (frame_len, samples_per_frame) = match layer {
        1 => ((12 * bitrate / rate + padding) * 4, 384),
        2 => (144 * bitrate / rate + padding, 1152),
        _ if mpeg1 => (144 * bitrate / rate + padding, 1152),
        _ => (72 * bitrate / rate + padding, 576),
    };
    if frame_len < 4 {
        return None;
    }
    Some(MpegAudioHeader {
        layer,
        frame_len,
        sample_rate,
        channels,
        samples_per_frame,
    })
}

#[derive(Clone, Copy, Debug)]
pub struct Ac3Header {
    pub enhanced: bool,
    pub frame_len: usize,
    pub sample_rate: u32,
    pub channels: u32,
    pub samples: u32,
    /// E-AC-3 dependent substream (belongs to the preceding independent frame).
    pub dependent: bool,
}

/// Parses an AC-3 or E-AC-3 sync frame header.
pub fn parse_ac3_header(data: &[u8]) -> Option<Ac3Header> {
    const BITRATES: [u32; 19] = [
        32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640,
    ];
    const CHANNELS: [u32; 8] = [2, 1, 2, 3, 3, 4, 4, 5];
    if data.len() < 7 || data[0] != 0x0b || data[1] != 0x77 {
        return None;
    }
    let bsid = data[5] >> 3;
    if bsid <= 8 {
        let fscod = (data[4] >> 6) as usize;
        let frmsizecod = (data[4] & 0x3f) as usize;
        if fscod == 3 || frmsizecod >= 38 {
            return None;
        }
        let bitrate = BITRATES[frmsizecod >> 1];
        let words = match fscod {
            0 => bitrate * 2,
            1 => bitrate * 96000 / 44100 + (frmsizecod & 1) as u32,
            _ => bitrate * 3,
        };
        let mut bits = BitReader::new(&data[6..]);
        let acmod = bits.read(3).ok()? as usize;
        if acmod & 1 != 0 && acmod != 1 {
            bits.skip(2).ok()?; // cmixlev
        }
        if acmod & 4 != 0 {
            bits.skip(2).ok()?; // surmixlev
        }
        if acmod == 2 {
            bits.skip(2).ok()?; // dsurmod
        }
        let lfe = bits.flag().ok()? as u32;
        Some(Ac3Header {
            enhanced: false,
            frame_len: words as usize * 2,
            sample_rate: [48000, 44100, 32000][fscod],
            channels: CHANNELS[acmod] + lfe,
            samples: 1536,
            dependent: false,
        })
    } else if (11..=16).contains(&bsid) {
        let strmtyp = data[2] >> 6;
        let frmsiz = (((data[2] & 7) as usize) << 8) | data[3] as usize;
        let fscod = (data[4] >> 6) as usize;
        let (sample_rate, blocks) = if fscod == 3 {
            let fscod2 = ((data[4] >> 4) & 3) as usize;
            if fscod2 == 3 {
                return None;
            }
            ([24000, 22050, 16000][fscod2], 6)
        } else {
            (
                [48000, 44100, 32000][fscod],
                [1, 2, 3, 6][((data[4] >> 4) & 3) as usize],
            )
        };
        let acmod = ((data[4] >> 1) & 7) as usize;
        let lfe = (data[4] & 1) as u32;
        Some(Ac3Header {
            enhanced: true,
            frame_len: (frmsiz + 1) * 2,
            sample_rate,
            channels: CHANNELS[acmod] + lfe,
            samples: 256 * blocks,
            dependent: strmtyp == 1,
        })
    } else {
        None
    }
}

pub fn unsupported_video(family: &str) -> VideoCodecParams {
    VideoCodecParams {
        family: family.to_string(),
        codec: None,
        description: None,
    }
}

pub fn unsupported_audio(family: &str) -> AudioCodecParams {
    AudioCodecParams {
        family: family.to_string(),
        codec: None,
        description: None,
        sample_rate: None,
        channels: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn avc_codec_string_uses_profile_constraints_level() {
        let avcc = [1u8, 0x64, 0x00, 0x1f, 0xff];
        let params = avc_params(&avcc);
        assert_eq!(params.codec.as_deref(), Some("avc1.64001f"));
        assert_eq!(params.family, "h264");
    }

    #[test]
    fn hevc_codec_string_matches_main_profile_example() {
        // Main profile, compatibility flags 0x60000000, main tier level 93 (3.1).
        let mut hvcc = vec![1u8, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 93];
        hvcc.extend_from_slice(&[0u8; 10]);
        assert_eq!(hevc_codec_string(&hvcc).as_deref(), Some("hvc1.1.6.L93.90"));
    }

    #[test]
    fn vpcc_codec_string() {
        let vpcc = [2u8, 31, 0x80 | 0x02, 1, 1, 1, 0, 0];
        assert_eq!(
            vp9_params_from_vpcc(&vpcc).codec.as_deref(),
            Some("vp09.02.31.08")
        );
    }

    #[test]
    fn vp9_keyframe_header_detects_profile_two() {
        // frame_marker=2, profile bits (low=0, high=1) => profile 2,
        // show_existing=0, frame_type=0 (key), show_frame=1, error_res=0,
        // sync code, ten_or_twelve_bit=0 => 10-bit.
        let mut bits = Vec::new();
        bits.extend_from_slice(&[1, 0, 0, 1, 0, 0, 1, 0]);
        for byte in [0x49u8, 0x83, 0x42] {
            for shift in (0..8).rev() {
                bits.push((byte >> shift) & 1);
            }
        }
        bits.push(0);
        while bits.len() % 8 != 0 {
            bits.push(0);
        }
        let bytes: Vec<u8> = bits
            .chunks(8)
            .map(|chunk| chunk.iter().fold(0u8, |acc, bit| (acc << 1) | bit))
            .collect();
        let params = vp9_params_from_keyframe(&bytes).expect("vp9 header");
        assert_eq!(params.codec.as_deref(), Some("vp09.02.10.10"));
    }

    #[test]
    fn av1c_codec_string() {
        let av1c = [0x81u8, 0x08, 0x0c, 0x00];
        assert_eq!(
            av1_params_from_av1c(&av1c).codec.as_deref(),
            Some("av01.0.08M.08")
        );
    }

    #[test]
    fn aac_asc_decodes_rate_and_channels() {
        // AOT 2, frequency index 3 (48000), channel config 2.
        let asc = [0x11u8, 0x90];
        let params = aac_params(&asc);
        assert_eq!(params.codec.as_deref(), Some("mp4a.40.2"));
        assert_eq!(params.sample_rate, Some(48000));
        assert_eq!(params.channels, Some(2));
    }

    #[test]
    fn esds_extracts_decoder_specific_info() {
        let esds = [
            0x03, 0x19, 0x00, 0x01, 0x00, 0x04, 0x11, 0x40, 0x15, 0x00, 0x00, 0x00, 0x00, 0x01,
            0xf4, 0x00, 0x00, 0x01, 0xf4, 0x00, 0x05, 0x02, 0x11, 0x90, 0x06, 0x01, 0x02,
        ];
        let (object_type, info) = parse_esds(&esds).expect("esds");
        assert_eq!(object_type, 0x40);
        assert_eq!(info, Some(vec![0x11, 0x90]));
    }

    #[test]
    fn adts_header_yields_audio_specific_config() {
        // MPEG-4 AAC-LC, 48 kHz, stereo, frame length 100, no CRC.
        let adts = [0xffu8, 0xf1, 0x4c, 0x80, 0x0c, 0x9f, 0xfc];
        let header = parse_adts_header(&adts).expect("adts");
        assert_eq!(header.header_len, 7);
        assert_eq!(header.frame_len, 100);
        assert_eq!(header.sample_rate, 48000);
        assert_eq!(header.channel_config, 2);
        assert_eq!(header.object_type, 2);
        assert_eq!(adts_audio_specific_config(&header), vec![0x11, 0x90]);
    }

    #[test]
    fn mpeg_audio_header_layer_two() {
        // MPEG-1 Layer II, 192 kbit/s, 48 kHz, stereo.
        let header = parse_mpeg_audio_header(&[0xff, 0xfd, 0xa4, 0x00]).expect("mpa");
        assert_eq!(header.layer, 2);
        assert_eq!(header.frame_len, 576);
        assert_eq!(header.sample_rate, 48000);
        assert_eq!(header.channels, 2);
        assert_eq!(header.samples_per_frame, 1152);
    }

    #[test]
    fn ac3_header_frame_size_and_channels() {
        // AC-3, 48 kHz, 192 kbit/s (frmsizecod 20), stereo without LFE.
        let header = parse_ac3_header(&[0x0b, 0x77, 0x00, 0x00, 0x14, 0x40, 0x40]).expect("ac3");
        assert!(!header.enhanced);
        assert_eq!(header.frame_len, 768);
        assert_eq!(header.sample_rate, 48000);
        assert_eq!(header.channels, 2);
        assert_eq!(header.samples, 1536);
        // E-AC-3: strmtyp 0, frmsiz 0x17f (768 bytes), 48 kHz, 6 blocks, 5.1.
        let eac3 = parse_ac3_header(&[0x0b, 0x77, 0x01, 0x7f, 0x3f, 0x80, 0x00]).expect("eac3");
        assert!(eac3.enhanced);
        assert_eq!(eac3.frame_len, 768);
        assert_eq!(eac3.samples, 1536);
        assert_eq!(eac3.channels, 6);
        assert!(!eac3.dependent);
    }

    #[test]
    fn rbsp_strips_emulation_prevention_bytes() {
        assert_eq!(
            nal_to_rbsp(&[0x00, 0x00, 0x03, 0x01, 0x00, 0x00, 0x03]),
            vec![0, 0, 1, 0, 0]
        );
    }

    #[test]
    fn dops_converts_to_opus_head() {
        let dops = [0u8, 2, 0x01, 0x38, 0x00, 0x00, 0xbb, 0x80, 0x00, 0x00, 0];
        let head = opus_head_from_dops(&dops).expect("head");
        assert!(head.starts_with(b"OpusHead"));
        assert_eq!(head[9], 2);
        assert_eq!(u16::from_le_bytes([head[10], head[11]]), 312);
        assert_eq!(
            u32::from_le_bytes([head[12], head[13], head[14], head[15]]),
            48000
        );
    }
}
