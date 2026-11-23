//! Buffered random-access file reader used by the LMP demuxers.
//!
//! The demuxers alternate between long sequential runs (cluster / mdat reads)
//! and small random reads (box headers, cue tables). A plain `BufReader`
//! throws its buffer away on every `seek`, so this reader keeps one window and
//! only refills it when a request falls outside.

use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

const WINDOW_SIZE: usize = 256 * 1024;

pub struct FileReader {
    file: File,
    len: u64,
    window_start: u64,
    window: Vec<u8>,
    pos: u64,
}

impl FileReader {
    pub fn open(path: &Path) -> Result<Self, String> {
        let file =
            File::open(path).map_err(|error| format!("Could not open media file: {error}"))?;
        let len = file
            .metadata()
            .map_err(|error| format!("Could not read media metadata: {error}"))?
            .len();
        Ok(Self {
            file,
            len,
            window_start: 0,
            window: Vec::new(),
            pos: 0,
        })
    }

    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn position(&self) -> u64 {
        self.pos
    }

    pub fn seek(&mut self, pos: u64) {
        self.pos = pos.min(self.len);
    }

    pub fn skip(&mut self, count: u64) {
        self.pos = self.pos.saturating_add(count).min(self.len);
    }

    pub fn remaining(&self) -> u64 {
        self.len.saturating_sub(self.pos)
    }

    /// Reads exactly `len` bytes at `offset` without moving the cursor.
    pub fn read_at(&mut self, offset: u64, len: usize) -> Result<Vec<u8>, String> {
        if len == 0 {
            return Ok(Vec::new());
        }
        let end = offset
            .checked_add(len as u64)
            .ok_or_else(|| "Read range overflow.".to_string())?;
        if end > self.len {
            return Err(format!(
                "Read past end of file (offset {offset}, len {len}, file {}).",
                self.len
            ));
        }

        if len <= WINDOW_SIZE {
            if !self.window_contains(offset, len) {
                self.fill_window(offset)?;
            }
            let start = (offset - self.window_start) as usize;
            return Ok(self.window[start..start + len].to_vec());
        }

        // Large reads bypass the window entirely.
        let mut buffer = vec![0u8; len];
        self.file
            .seek(SeekFrom::Start(offset))
            .map_err(|error| format!("Seek failed: {error}"))?;
        self.file
            .read_exact(&mut buffer)
            .map_err(|error| format!("Read failed: {error}"))?;
        Ok(buffer)
    }

    pub fn read_bytes(&mut self, len: usize) -> Result<Vec<u8>, String> {
        let data = self.read_at(self.pos, len)?;
        self.pos += len as u64;
        Ok(data)
    }

    pub fn read_u8(&mut self) -> Result<u8, String> {
        Ok(self.read_bytes(1)?[0])
    }

    pub fn read_u32_be(&mut self) -> Result<u32, String> {
        let bytes = self.read_bytes(4)?;
        Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    pub fn read_u64_be(&mut self) -> Result<u64, String> {
        let bytes = self.read_bytes(8)?;
        let mut raw = [0u8; 8];
        raw.copy_from_slice(&bytes);
        Ok(u64::from_be_bytes(raw))
    }

    /// Peeks up to `len` bytes at the cursor without consuming them. Returns a
    /// shorter slice near the end of the file.
    pub fn peek(&mut self, len: usize) -> Result<Vec<u8>, String> {
        let available = self.remaining().min(len as u64) as usize;
        self.read_at(self.pos, available)
    }

    fn window_contains(&self, offset: u64, len: usize) -> bool {
        offset >= self.window_start
            && offset + len as u64 <= self.window_start + self.window.len() as u64
    }

    fn fill_window(&mut self, offset: u64) -> Result<(), String> {
        let size = (self.len - offset).min(WINDOW_SIZE as u64) as usize;
        self.window.resize(size, 0);
        self.file
            .seek(SeekFrom::Start(offset))
            .map_err(|error| format!("Seek failed: {error}"))?;
        self.file
            .read_exact(&mut self.window[..size])
            .map_err(|error| format!("Read failed: {error}"))?;
        self.window_start = offset;
        Ok(())
    }
}

/// Cursor over an in-memory byte slice with big-endian helpers.
pub struct ByteCursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> ByteCursor<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    pub fn position(&self) -> usize {
        self.pos
    }

    pub fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }

    pub fn skip(&mut self, count: usize) -> Result<(), String> {
        if self.remaining() < count {
            return Err("Unexpected end of data.".to_string());
        }
        self.pos += count;
        Ok(())
    }

    pub fn bytes(&mut self, len: usize) -> Result<&'a [u8], String> {
        if self.remaining() < len {
            return Err("Unexpected end of data.".to_string());
        }
        let slice = &self.data[self.pos..self.pos + len];
        self.pos += len;
        Ok(slice)
    }

    pub fn rest(&mut self) -> &'a [u8] {
        let slice = &self.data[self.pos..];
        self.pos = self.data.len();
        slice
    }

    pub fn u8(&mut self) -> Result<u8, String> {
        Ok(self.bytes(1)?[0])
    }

    pub fn u16_be(&mut self) -> Result<u16, String> {
        let b = self.bytes(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    pub fn i16_be(&mut self) -> Result<i16, String> {
        Ok(self.u16_be()? as i16)
    }

    pub fn u24_be(&mut self) -> Result<u32, String> {
        let b = self.bytes(3)?;
        Ok(((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32)
    }

    pub fn u32_be(&mut self) -> Result<u32, String> {
        let b = self.bytes(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn i32_be(&mut self) -> Result<i32, String> {
        Ok(self.u32_be()? as i32)
    }

    pub fn u64_be(&mut self) -> Result<u64, String> {
        let b = self.bytes(8)?;
        let mut raw = [0u8; 8];
        raw.copy_from_slice(b);
        Ok(u64::from_be_bytes(raw))
    }

    pub fn i64_be(&mut self) -> Result<i64, String> {
        Ok(self.u64_be()? as i64)
    }

    pub fn fourcc(&mut self) -> Result<[u8; 4], String> {
        let b = self.bytes(4)?;
        Ok([b[0], b[1], b[2], b[3]])
    }
}

/// MSB-first bit reader for codec headers (VP9 / AV1 / AAC).
pub struct BitReader<'a> {
    data: &'a [u8],
    bit_pos: usize,
}

impl<'a> BitReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, bit_pos: 0 }
    }

    pub fn bits_left(&self) -> usize {
        let total = self.data.len() * 8;
        total - self.bit_pos.min(total)
    }

    pub fn read(&mut self, count: u32) -> Result<u64, String> {
        if count > 64 || self.bits_left() < count as usize {
            return Err("Bitstream ended early.".to_string());
        }
        let mut value = 0u64;
        for _ in 0..count {
            let byte = self.data[self.bit_pos / 8];
            let bit = (byte >> (7 - (self.bit_pos % 8))) & 1;
            value = (value << 1) | bit as u64;
            self.bit_pos += 1;
        }
        Ok(value)
    }

    pub fn flag(&mut self) -> Result<bool, String> {
        Ok(self.read(1)? == 1)
    }

    pub fn skip(&mut self, count: u32) -> Result<(), String> {
        self.read(count).map(|_| ())
    }

    /// AV1 uvlc(): unsigned variable length code.
    pub fn uvlc(&mut self) -> Result<u64, String> {
        let mut leading_zeros = 0u32;
        while !self.flag()? {
            leading_zeros += 1;
            if leading_zeros >= 32 {
                return Ok(u32::MAX as u64);
            }
        }
        if leading_zeros == 0 {
            return Ok(0);
        }
        let value = self.read(leading_zeros)?;
        Ok(value + (1u64 << leading_zeros) - 1)
    }

    /// H.264 / HEVC ue(v): unsigned Exp-Golomb code (same layout as AV1 uvlc).
    pub fn ue(&mut self) -> Result<u64, String> {
        self.uvlc()
    }

    /// H.264 / HEVC se(v): signed Exp-Golomb code.
    pub fn se(&mut self) -> Result<i64, String> {
        let code = self.ue()? as i64;
        Ok(if code % 2 == 1 {
            (code + 1) / 2
        } else {
            -(code / 2)
        })
    }
}

pub fn fourcc_to_string(code: &[u8; 4]) -> String {
    code.iter()
        .map(|byte| {
            if byte.is_ascii_graphic() || *byte == b' ' {
                *byte as char
            } else {
                '?'
            }
        })
        .collect()
}
