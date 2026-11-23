//! Text encoding detection and conversion for the LMP text editor.
//!
//! Unicode encodings are handled here directly. Legacy single- and multi-byte
//! code pages go through the Windows code page API so every encoding the
//! editor offers round-trips exactly the way other Windows editors handle it.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextEncoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    CodePage(u32),
}

/// Legacy code pages the editor offers, keyed by the id the frontend uses.
const CODE_PAGE_ENCODINGS: &[(&str, u32)] = &[
    ("windows-1252", 1252),
    ("windows-1250", 1250),
    ("windows-1251", 1251),
    ("windows-1253", 1253),
    ("windows-1254", 1254),
    ("windows-1257", 1257),
    ("iso-8859-1", 28591),
    ("iso-8859-2", 28592),
    ("iso-8859-15", 28605),
    ("ibm437", 437),
    ("ibm850", 850),
    ("koi8-r", 20866),
    ("shift_jis", 932),
    ("gbk", 936),
    ("euc-kr", 949),
    ("big5", 950),
];

const DETECTION_SAMPLE_BYTES: usize = 64 * 1024;

impl TextEncoding {
    pub fn from_id(id: &str) -> Option<Self> {
        let clean = id.trim().to_ascii_lowercase();
        match clean.as_str() {
            // "utf-8/lossy" and "extracted" are labels older builds stored in drafts.
            "utf-8" | "utf8" | "utf-8/lossy" | "extracted" => Some(Self::Utf8),
            "utf-8 bom" | "utf-8-bom" => Some(Self::Utf8Bom),
            "utf-16 le" | "utf-16le" => Some(Self::Utf16Le),
            "utf-16 be" | "utf-16be" => Some(Self::Utf16Be),
            other => CODE_PAGE_ENCODINGS
                .iter()
                .find(|(name, _)| *name == other)
                .map(|(_, code_page)| Self::CodePage(*code_page)),
        }
    }

    pub fn id(self) -> String {
        match self {
            Self::Utf8 => "utf-8".to_string(),
            Self::Utf8Bom => "utf-8 bom".to_string(),
            Self::Utf16Le => "utf-16 le".to_string(),
            Self::Utf16Be => "utf-16 be".to_string(),
            Self::CodePage(code_page) => CODE_PAGE_ENCODINGS
                .iter()
                .find(|(_, value)| *value == code_page)
                .map(|(name, _)| (*name).to_string())
                .unwrap_or_else(|| format!("cp{code_page}")),
        }
    }

    pub fn label(self) -> String {
        match self {
            Self::Utf8 => "UTF-8".to_string(),
            Self::Utf8Bom => "UTF-8 with BOM".to_string(),
            Self::Utf16Le => "UTF-16 LE".to_string(),
            Self::Utf16Be => "UTF-16 BE".to_string(),
            Self::CodePage(code_page) => match code_page {
                1250..=1258 => format!("Windows-{code_page}"),
                28591..=28605 => format!("ISO 8859-{}", code_page - 28590),
                437 | 850 => format!("CP {code_page}"),
                20866 => "KOI8-R".to_string(),
                932 => "Shift JIS".to_string(),
                936 => "GBK".to_string(),
                949 => "EUC-KR".to_string(),
                950 => "Big5".to_string(),
                _ => self.id().to_ascii_uppercase(),
            },
        }
    }
}

/// How the encoding of a decoded file was chosen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EncodingSource {
    Bom,
    Detected,
    Fallback,
    Forced,
}

impl EncodingSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bom => "bom",
            Self::Detected => "detected",
            Self::Fallback => "fallback",
            Self::Forced => "forced",
        }
    }
}

pub struct DecodedText {
    pub text: String,
    pub encoding: TextEncoding,
    pub source: EncodingSource,
    pub had_errors: bool,
    pub binary: bool,
}

pub fn decode_auto(bytes: &[u8]) -> DecodedText {
    if let Some(encoding) = bom_encoding(bytes) {
        let mut decoded = decode_with(bytes, encoding);
        decoded.source = EncodingSource::Bom;
        return decoded;
    }

    if let Some(encoding) = utf16_without_bom(bytes) {
        let mut decoded = decode_with(bytes, encoding);
        if !decoded.had_errors {
            decoded.source = EncodingSource::Detected;
            return decoded;
        }
    }

    let binary = looks_binary(bytes);
    if let Ok(text) = std::str::from_utf8(bytes) {
        return DecodedText {
            text: text.to_string(),
            encoding: TextEncoding::Utf8,
            source: EncodingSource::Detected,
            had_errors: false,
            binary,
        };
    }

    if binary {
        return DecodedText {
            text: String::from_utf8_lossy(bytes).into_owned(),
            encoding: TextEncoding::Utf8,
            source: EncodingSource::Fallback,
            had_errors: true,
            binary,
        };
    }

    let mut decoded = decode_with(bytes, system_ansi_encoding());
    decoded.source = EncodingSource::Fallback;
    decoded
}

pub fn decode_with(bytes: &[u8], encoding: TextEncoding) -> DecodedText {
    let (text, had_errors) = match encoding {
        TextEncoding::Utf8 | TextEncoding::Utf8Bom => {
            let body = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
            match std::str::from_utf8(body) {
                Ok(text) => (text.to_string(), false),
                Err(_) => (String::from_utf8_lossy(body).into_owned(), true),
            }
        }
        TextEncoding::Utf16Le => {
            decode_utf16(bytes.strip_prefix(&[0xff, 0xfe]).unwrap_or(bytes), true)
        }
        TextEncoding::Utf16Be => {
            decode_utf16(bytes.strip_prefix(&[0xfe, 0xff]).unwrap_or(bytes), false)
        }
        TextEncoding::CodePage(code_page) => decode_code_page(bytes, code_page),
    };

    DecodedText {
        text,
        encoding,
        source: EncodingSource::Forced,
        had_errors,
        binary: !matches!(encoding, TextEncoding::Utf16Le | TextEncoding::Utf16Be)
            && looks_binary(bytes),
    }
}

#[derive(Debug)]
pub struct UnrepresentableText {
    pub count: usize,
    pub first: char,
}

/// Encodes LF-normalized editor text with the requested line ending and encoding.
pub fn encode(
    text: &str,
    line_ending: &str,
    encoding: TextEncoding,
) -> Result<Vec<u8>, UnrepresentableText> {
    let normalized = apply_line_ending(text, line_ending);
    match encoding {
        TextEncoding::Utf8 => Ok(normalized.into_bytes()),
        TextEncoding::Utf8Bom => {
            let mut bytes = Vec::with_capacity(normalized.len() + 3);
            bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
            bytes.extend_from_slice(normalized.as_bytes());
            Ok(bytes)
        }
        TextEncoding::Utf16Le | TextEncoding::Utf16Be => {
            let little_endian = encoding == TextEncoding::Utf16Le;
            let mut bytes = Vec::with_capacity(normalized.len() * 2 + 2);
            bytes.extend_from_slice(if little_endian {
                &[0xff, 0xfe]
            } else {
                &[0xfe, 0xff]
            });
            for unit in normalized.encode_utf16() {
                let pair = if little_endian {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                };
                bytes.extend_from_slice(&pair);
            }
            Ok(bytes)
        }
        TextEncoding::CodePage(code_page) => encode_code_page(&normalized, code_page),
    }
}

pub struct LineEndingInfo {
    pub dominant: &'static str,
    pub mixed: bool,
}

pub fn detect_line_endings(text: &str) -> LineEndingInfo {
    let bytes = text.as_bytes();
    let (mut crlf, mut lf, mut cr) = (0usize, 0usize, 0usize);
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'\r' if bytes.get(index + 1) == Some(&b'\n') => {
                crlf += 1;
                index += 2;
                continue;
            }
            b'\r' => cr += 1,
            b'\n' => lf += 1,
            _ => {}
        }
        index += 1;
    }

    let kinds = [crlf, lf, cr].iter().filter(|count| **count > 0).count();
    let dominant = if crlf > 0 && crlf >= lf && crlf >= cr {
        "crlf"
    } else if cr > lf {
        "cr"
    } else {
        "lf"
    };
    LineEndingInfo {
        dominant,
        mixed: kinds > 1,
    }
}

/// Converts any line ending to LF and drops a leading BOM character.
pub fn normalize_newlines(text: &str) -> String {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    if !text.contains('\r') {
        return text.to_string();
    }
    text.replace("\r\n", "\n").replace('\r', "\n")
}

pub fn longest_line_chars(text: &str) -> usize {
    text.split('\n')
        .map(|line| line.chars().count())
        .max()
        .unwrap_or(0)
}

fn apply_line_ending(text: &str, line_ending: &str) -> String {
    match line_ending {
        "crlf" => text.replace('\n', "\r\n"),
        "cr" => text.replace('\n', "\r"),
        _ => text.to_string(),
    }
}

fn bom_encoding(bytes: &[u8]) -> Option<TextEncoding> {
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        Some(TextEncoding::Utf8Bom)
    } else if bytes.starts_with(&[0xff, 0xfe]) {
        Some(TextEncoding::Utf16Le)
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        Some(TextEncoding::Utf16Be)
    } else {
        None
    }
}

/// Recognizes BOM-less UTF-16 from the zero high bytes of ASCII characters.
fn utf16_without_bom(bytes: &[u8]) -> Option<TextEncoding> {
    if bytes.len() < 4 || !bytes.len().is_multiple_of(2) {
        return None;
    }
    let sample = &bytes[..bytes.len().min(DETECTION_SAMPLE_BYTES)];
    let pairs = sample.len() / 2;
    let even_zero = sample.iter().step_by(2).filter(|byte| **byte == 0).count();
    let odd_zero = sample
        .iter()
        .skip(1)
        .step_by(2)
        .filter(|byte| **byte == 0)
        .count();
    let even_ratio = even_zero as f64 / pairs as f64;
    let odd_ratio = odd_zero as f64 / pairs as f64;
    if odd_ratio > 0.4 && even_ratio < 0.05 {
        Some(TextEncoding::Utf16Le)
    } else if even_ratio > 0.4 && odd_ratio < 0.05 {
        Some(TextEncoding::Utf16Be)
    } else {
        None
    }
}

fn looks_binary(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(DETECTION_SAMPLE_BYTES)];
    if sample.is_empty() {
        return false;
    }
    if sample.contains(&0) {
        return true;
    }
    let control = sample
        .iter()
        .filter(|byte| matches!(**byte, 0x01..=0x08 | 0x0e..=0x1a | 0x1c..=0x1f))
        .count();
    control * 20 > sample.len()
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> (String, bool) {
    let odd_tail = !bytes.len().is_multiple_of(2);
    let units = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|chunk| {
            if little_endian {
                u16::from_le_bytes([chunk[0], chunk[1]])
            } else {
                u16::from_be_bytes([chunk[0], chunk[1]])
            }
        })
        .collect::<Vec<_>>();
    match String::from_utf16(&units) {
        Ok(text) => (text, odd_tail),
        Err(_) => (String::from_utf16_lossy(&units), true),
    }
}

fn system_ansi_encoding() -> TextEncoding {
    let code_page = system_ansi_code_page();
    if CODE_PAGE_ENCODINGS
        .iter()
        .any(|(_, value)| *value == code_page)
    {
        TextEncoding::CodePage(code_page)
    } else {
        TextEncoding::CodePage(1252)
    }
}

#[cfg(windows)]
fn system_ansi_code_page() -> u32 {
    // SAFETY: GetACP has no preconditions.
    unsafe { windows_sys::Win32::Globalization::GetACP() }
}

#[cfg(not(windows))]
fn system_ansi_code_page() -> u32 {
    1252
}

#[cfg(windows)]
fn decode_code_page(bytes: &[u8], code_page: u32) -> (String, bool) {
    use windows_sys::Win32::Globalization::{MultiByteToWideChar, MB_ERR_INVALID_CHARS};

    if bytes.is_empty() {
        return (String::new(), false);
    }
    let Ok(input_len) = i32::try_from(bytes.len()) else {
        return (String::from_utf8_lossy(bytes).into_owned(), true);
    };

    let convert = |flags: u32| -> Option<Vec<u16>> {
        // SAFETY: the input pointer and length describe `bytes`; the first call only
        // measures, the second writes at most `needed` units into `wide`.
        unsafe {
            let needed = MultiByteToWideChar(
                code_page,
                flags,
                bytes.as_ptr(),
                input_len,
                std::ptr::null_mut(),
                0,
            );
            if needed <= 0 {
                return None;
            }
            let mut wide = vec![0u16; needed as usize];
            let written = MultiByteToWideChar(
                code_page,
                flags,
                bytes.as_ptr(),
                input_len,
                wide.as_mut_ptr(),
                needed,
            );
            if written <= 0 {
                return None;
            }
            wide.truncate(written as usize);
            Some(wide)
        }
    };

    if let Some(wide) = convert(MB_ERR_INVALID_CHARS) {
        return (String::from_utf16_lossy(&wide), false);
    }
    match convert(0) {
        Some(wide) => (String::from_utf16_lossy(&wide), true),
        None => (String::from_utf8_lossy(bytes).into_owned(), true),
    }
}

#[cfg(windows)]
fn encode_code_page(text: &str, code_page: u32) -> Result<Vec<u8>, UnrepresentableText> {
    let wide = text.encode_utf16().collect::<Vec<_>>();
    match wide_to_code_page(&wide, code_page) {
        Some(bytes) => Ok(bytes),
        None => Err(find_unrepresentable(text, code_page)),
    }
}

/// Returns `None` when a character has no exact representation in the code page.
#[cfg(windows)]
fn wide_to_code_page(wide: &[u16], code_page: u32) -> Option<Vec<u8>> {
    use windows_sys::Win32::Globalization::{WideCharToMultiByte, WC_NO_BEST_FIT_CHARS};

    if wide.is_empty() {
        return Some(Vec::new());
    }
    let input_len = i32::try_from(wide.len()).ok()?;
    // SAFETY: the input pointer and length describe `wide`; the first call only
    // measures, the second writes at most `needed` bytes into `bytes`.
    unsafe {
        let mut used_default = 0;
        let needed = WideCharToMultiByte(
            code_page,
            WC_NO_BEST_FIT_CHARS,
            wide.as_ptr(),
            input_len,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
            &mut used_default,
        );
        if needed <= 0 || used_default != 0 {
            return None;
        }
        let mut bytes = vec![0u8; needed as usize];
        let written = WideCharToMultiByte(
            code_page,
            WC_NO_BEST_FIT_CHARS,
            wide.as_ptr(),
            input_len,
            bytes.as_mut_ptr(),
            needed,
            std::ptr::null(),
            &mut used_default,
        );
        if written <= 0 || used_default != 0 {
            return None;
        }
        bytes.truncate(written as usize);
        Some(bytes)
    }
}

#[cfg(windows)]
fn find_unrepresentable(text: &str, code_page: u32) -> UnrepresentableText {
    let mut count = 0usize;
    let mut first = '\u{fffd}';
    let mut checked = std::collections::HashMap::<char, bool>::new();
    for character in text.chars() {
        let representable = *checked.entry(character).or_insert_with(|| {
            let mut units = [0u16; 2];
            wide_to_code_page(character.encode_utf16(&mut units), code_page).is_some()
        });
        if !representable {
            if count == 0 {
                first = character;
            }
            count += 1;
        }
    }
    UnrepresentableText {
        count: count.max(1),
        first,
    }
}

// Non-Windows builds only need the Western code pages; Windows uses the OS tables.
#[cfg(not(windows))]
const WINDOWS_1252_HIGH: [u32; 32] = [
    0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
    0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
    0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

#[cfg(not(windows))]
fn decode_code_page(bytes: &[u8], code_page: u32) -> (String, bool) {
    match code_page {
        28591 => (bytes.iter().map(|byte| char::from(*byte)).collect(), false),
        1252 => (
            bytes
                .iter()
                .map(|byte| match byte {
                    0x80..=0x9f => char::from_u32(WINDOWS_1252_HIGH[(*byte - 0x80) as usize])
                        .unwrap_or('\u{fffd}'),
                    _ => char::from(*byte),
                })
                .collect(),
            false,
        ),
        _ => (String::from_utf8_lossy(bytes).into_owned(), true),
    }
}

#[cfg(not(windows))]
fn encode_code_page(text: &str, code_page: u32) -> Result<Vec<u8>, UnrepresentableText> {
    let mut bytes = Vec::with_capacity(text.len());
    let mut failure: Option<UnrepresentableText> = None;
    for character in text.chars() {
        let value = character as u32;
        let encoded = match code_page {
            28591 if value <= 0xff => Some(value as u8),
            1252 if value < 0x80 || (0xa0..=0xff).contains(&value) => Some(value as u8),
            1252 => WINDOWS_1252_HIGH
                .iter()
                .position(|candidate| *candidate == value)
                .map(|index| 0x80 + index as u8),
            _ => None,
        };
        match encoded {
            Some(byte) => bytes.push(byte),
            None => {
                let entry = failure.get_or_insert(UnrepresentableText {
                    count: 0,
                    first: character,
                });
                entry.count += 1;
            }
        }
    }
    match failure {
        Some(failure) => Err(failure),
        None => Ok(bytes),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_utf8_bom_and_crlf() {
        let bytes = encode("one\ntwo", "crlf", TextEncoding::Utf8Bom).expect("encode");
        assert!(bytes.starts_with(&[0xef, 0xbb, 0xbf]));
        let decoded = decode_auto(&bytes);
        assert_eq!(decoded.encoding, TextEncoding::Utf8Bom);
        assert_eq!(decoded.source, EncodingSource::Bom);
        assert_eq!(decoded.text, "one\r\ntwo");
        let endings = detect_line_endings(&decoded.text);
        assert_eq!(endings.dominant, "crlf");
        assert!(!endings.mixed);
    }

    #[test]
    fn round_trips_utf16_with_bom() {
        for encoding in [TextEncoding::Utf16Le, TextEncoding::Utf16Be] {
            let bytes = encode("Grüße\n世界", "lf", encoding).expect("encode");
            let decoded = decode_auto(&bytes);
            assert_eq!(decoded.encoding, encoding);
            assert_eq!(decoded.text, "Grüße\n世界");
            assert!(!decoded.had_errors);
        }
    }

    #[test]
    fn detects_utf16_without_bom() {
        let bytes = "hello world\r\n"
            .encode_utf16()
            .flat_map(|unit| unit.to_le_bytes())
            .collect::<Vec<_>>();
        let decoded = decode_auto(&bytes);
        assert_eq!(decoded.encoding, TextEncoding::Utf16Le);
        assert_eq!(decoded.source, EncodingSource::Detected);
        assert_eq!(decoded.text, "hello world\r\n");
        assert!(!decoded.binary);
    }

    #[test]
    fn falls_back_to_a_code_page_for_invalid_utf8() {
        // "Grüße" in Windows-1252.
        let bytes = [0x47, 0x72, 0xfc, 0xdf, 0x65];
        let decoded = decode_auto(&bytes);
        assert_eq!(decoded.source, EncodingSource::Fallback);
        assert!(matches!(decoded.encoding, TextEncoding::CodePage(_)));
        assert!(!decoded.binary);
        let western = decode_with(&bytes, TextEncoding::CodePage(1252));
        assert_eq!(western.text, "Grüße");
        assert!(!western.had_errors);
    }

    #[test]
    fn round_trips_windows_1252() {
        let bytes = encode("€ „Grüße“\n", "crlf", TextEncoding::CodePage(1252)).expect("encode");
        assert_eq!(bytes[0], 0x80);
        let decoded = decode_with(&bytes, TextEncoding::CodePage(1252));
        assert_eq!(decoded.text, "€ „Grüße“\r\n");
    }

    #[test]
    fn refuses_characters_outside_the_code_page() {
        let error =
            encode("ok 世界 ok", "lf", TextEncoding::CodePage(1252)).expect_err("must fail");
        assert_eq!(error.first, '世');
        assert_eq!(error.count, 2);
    }

    #[test]
    fn flags_binary_content() {
        let decoded = decode_auto(&[
            0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d,
        ]);
        assert!(decoded.binary);
    }

    #[test]
    fn reports_mixed_line_endings() {
        let info = detect_line_endings("a\r\nb\nc\r\n");
        assert_eq!(info.dominant, "crlf");
        assert!(info.mixed);
        assert_eq!(normalize_newlines("\u{feff}a\r\nb\rc"), "a\nb\nc");
    }

    #[test]
    fn maps_legacy_ids() {
        assert_eq!(
            TextEncoding::from_id("utf-8/lossy"),
            Some(TextEncoding::Utf8)
        );
        assert_eq!(
            TextEncoding::from_id("UTF-16 LE"),
            Some(TextEncoding::Utf16Le)
        );
        assert_eq!(
            TextEncoding::from_id("windows-1252"),
            Some(TextEncoding::CodePage(1252))
        );
        assert_eq!(TextEncoding::CodePage(1250).id(), "windows-1250");
        assert_eq!(TextEncoding::CodePage(1252).label(), "Windows-1252");
        assert_eq!(TextEncoding::CodePage(28605).label(), "ISO 8859-15");
        assert_eq!(TextEncoding::from_id("nope"), None);
    }
}
