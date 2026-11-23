//! Binary sample batch format shared with the frontend (`src/player/av/ipc.ts`).
//!
//! Layout (little-endian):
//!
//! ```text
//! header   : u32 magic "LMPS" | u16 version | u16 flags | u32 count | u32 reserved
//! records  : count * 32 bytes
//!            u32 track_id | u8 flags | u8 reserved | u16 reserved | u32 size
//!            i64 pts_us   | i64 duration_us | u32 reserved
//! payload  : concatenated sample data in record order
//! ```
//!
//! Header flag bit 0 marks that the demuxer reached the end of the selected
//! tracks. Record flag bit 0 marks a key frame.

use super::Sample;

pub const BATCH_MAGIC: u32 = 0x5350_4D4C; // "LMPS"
pub const BATCH_VERSION: u16 = 1;
pub const HEADER_SIZE: usize = 16;
pub const RECORD_SIZE: usize = 32;

pub const BATCH_FLAG_EOF: u16 = 1;
pub const SAMPLE_FLAG_KEYFRAME: u8 = 1;

pub fn encode_batch(samples: &[Sample], eof: bool) -> Vec<u8> {
    let payload_len: usize = samples.iter().map(|sample| sample.data.len()).sum();
    let mut out = Vec::with_capacity(HEADER_SIZE + samples.len() * RECORD_SIZE + payload_len);

    out.extend_from_slice(&BATCH_MAGIC.to_le_bytes());
    out.extend_from_slice(&BATCH_VERSION.to_le_bytes());
    out.extend_from_slice(&(if eof { BATCH_FLAG_EOF } else { 0 }).to_le_bytes());
    out.extend_from_slice(&(samples.len() as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());

    for sample in samples {
        out.extend_from_slice(&sample.track_id.to_le_bytes());
        out.push(if sample.keyframe {
            SAMPLE_FLAG_KEYFRAME
        } else {
            0
        });
        out.push(0);
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(sample.data.len() as u32).to_le_bytes());
        out.extend_from_slice(&sample.pts_us.to_le_bytes());
        out.extend_from_slice(&sample.duration_us.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
    }

    for sample in samples {
        out.extend_from_slice(&sample.data);
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_header_records_and_payload() {
        let samples = vec![
            Sample {
                track_id: 1,
                pts_us: 1_000,
                dts_us: 1_000,
                duration_us: 33_333,
                keyframe: true,
                data: vec![1, 2, 3],
            },
            Sample {
                track_id: 2,
                pts_us: -500,
                dts_us: -500,
                duration_us: 0,
                keyframe: false,
                data: vec![9],
            },
        ];
        let bytes = encode_batch(&samples, true);
        assert_eq!(bytes.len(), HEADER_SIZE + 2 * RECORD_SIZE + 4);
        assert_eq!(&bytes[0..4], &BATCH_MAGIC.to_le_bytes());
        assert_eq!(u16::from_le_bytes([bytes[6], bytes[7]]), BATCH_FLAG_EOF);
        assert_eq!(
            u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]),
            2
        );
        let record = &bytes[HEADER_SIZE..HEADER_SIZE + RECORD_SIZE];
        assert_eq!(record[4], SAMPLE_FLAG_KEYFRAME);
        assert_eq!(
            u32::from_le_bytes([record[8], record[9], record[10], record[11]]),
            3
        );
        let second = &bytes[HEADER_SIZE + RECORD_SIZE..HEADER_SIZE + 2 * RECORD_SIZE];
        let pts = i64::from_le_bytes(second[12..20].try_into().unwrap());
        assert_eq!(pts, -500);
        assert_eq!(&bytes[HEADER_SIZE + 2 * RECORD_SIZE..], &[1, 2, 3, 9]);
    }
}
