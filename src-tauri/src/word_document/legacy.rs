use super::{
    converter::{convert_legacy_doc_to_text, LegacyDocConversion},
    open_xml,
    text::{clean_extracted_text, finalize_word_content},
    types::{WordDocumentBlock, WordDocumentContent},
    MAX_BLOCKS, MAX_DOCX_BYTES,
};
use std::{fs, path::Path};

const OLE_COMPOUND_FILE_MAGIC: &[u8] = &[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

pub(crate) fn read_legacy_word_document(path: &Path) -> Result<WordDocumentContent, String> {
    let metadata = path
        .metadata()
        .map_err(|error| format!("Could not read legacy Word document metadata: {error}"))?;
    if metadata.len() > MAX_DOCX_BYTES {
        return Err("Word document is larger than LMP's current 80 MB preview limit.".to_string());
    }

    let bytes =
        fs::read(path).map_err(|error| format!("Could not read legacy Word document: {error}"))?;
    if looks_like_zip_package(&bytes) {
        return open_xml::read_open_xml_word_document(path);
    }

    let fallback_title = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Word document");

    if looks_like_rtf(&bytes) {
        return Ok(finalize_text_preview(
            &extract_rtf_text(&bytes),
            fallback_title,
            legacy_doc_converter_failed_blocks,
        ));
    }

    if let Some(text) = extract_plain_text_document(&bytes) {
        return Ok(finalize_text_preview(
            &text,
            fallback_title,
            legacy_doc_converter_failed_blocks,
        ));
    }

    if is_ole_compound_document(&bytes) {
        return Ok(read_ole_word_document(path, fallback_title));
    }

    Ok(finalize_word_content(
        legacy_doc_converter_missing_blocks(),
        fallback_title,
    ))
}

fn read_ole_word_document(path: &Path, fallback_title: &str) -> WordDocumentContent {
    match convert_legacy_doc_to_text(path) {
        LegacyDocConversion::Converted(text) => {
            finalize_text_preview(&text, fallback_title, legacy_doc_converter_failed_blocks)
        }
        LegacyDocConversion::MissingConverter => {
            finalize_word_content(legacy_doc_converter_missing_blocks(), fallback_title)
        }
        LegacyDocConversion::Failed => {
            finalize_word_content(legacy_doc_converter_failed_blocks(), fallback_title)
        }
    }
}

fn finalize_text_preview(
    text: &str,
    fallback_title: &str,
    fallback_blocks: fn() -> Vec<WordDocumentBlock>,
) -> WordDocumentContent {
    let blocks = text_to_blocks(text).unwrap_or_else(fallback_blocks);
    finalize_word_content(blocks, fallback_title)
}

fn text_to_blocks(text: &str) -> Option<Vec<WordDocumentBlock>> {
    let clean = clean_extracted_text(text);
    let blocks = clean
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(MAX_BLOCKS)
        .map(|line| WordDocumentBlock {
            kind: String::from("paragraph"),
            text: line.to_string(),
        })
        .collect::<Vec<_>>();

    if blocks.is_empty() {
        None
    } else {
        Some(blocks)
    }
}

fn legacy_doc_converter_missing_blocks() -> Vec<WordDocumentBlock> {
    vec![WordDocumentBlock {
        kind: String::from("notice"),
        text: String::from(
            "Legacy .doc preview needs an external converter. Install LibreOffice or convert this file to .docx.",
        ),
    }]
}

fn legacy_doc_converter_failed_blocks() -> Vec<WordDocumentBlock> {
    vec![WordDocumentBlock {
        kind: String::from("notice"),
        text: String::from(
            "Legacy .doc preview could not be converted. Open the file in LibreOffice or save a copy as .docx.",
        ),
    }]
}

fn extract_plain_text_document(bytes: &[u8]) -> Option<String> {
    if is_ole_compound_document(bytes) {
        return None;
    }

    let text = std::str::from_utf8(bytes).ok()?;
    let control_count = text
        .chars()
        .filter(|character| character.is_control() && !matches!(*character, '\n' | '\r' | '\t'))
        .count();
    if control_count > 0 {
        return None;
    }

    Some(clean_extracted_text(text))
}

fn is_ole_compound_document(bytes: &[u8]) -> bool {
    bytes.starts_with(OLE_COMPOUND_FILE_MAGIC)
}

fn looks_like_rtf(bytes: &[u8]) -> bool {
    bytes
        .get(..5)
        .map(|head| head.eq_ignore_ascii_case(br"{\rtf"))
        .unwrap_or(false)
}

fn looks_like_zip_package(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04")
}

fn extract_rtf_text(bytes: &[u8]) -> String {
    let input = String::from_utf8_lossy(bytes);
    let mut output = String::new();
    let mut chars = input.chars().peekable();
    let mut ignored_depth: Option<usize> = None;
    let mut depth = 0usize;

    while let Some(character) = chars.next() {
        match character {
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if ignored_depth
                    .map(|ignored| depth < ignored)
                    .unwrap_or(false)
                {
                    ignored_depth = None;
                }
            }
            '\\' => {
                let control = read_rtf_control(&mut chars);
                if ignored_depth.is_some() {
                    continue;
                }
                if matches!(
                    control.word.as_str(),
                    "fonttbl" | "colortbl" | "stylesheet" | "info" | "pict" | "object"
                ) {
                    ignored_depth = Some(depth);
                    continue;
                }
                match control.word.as_str() {
                    "par" | "line" => output.push('\n'),
                    "tab" => output.push('\t'),
                    "'" => {
                        if let Some(value) = control.hex_byte {
                            output.push(decode_windows_1252_byte(value));
                        }
                    }
                    "u" => {
                        if let Some(value) = control.numeric {
                            if let Some(decoded) = char::from_u32(value.rem_euclid(65536) as u32) {
                                output.push(decoded);
                            }
                            let _ = chars.next();
                        }
                    }
                    _ => {}
                }
            }
            '\n' | '\r' => {}
            _ if ignored_depth.is_none() => output.push(character),
            _ => {}
        }
    }

    clean_extracted_text(&output)
}

struct RtfControl {
    word: String,
    numeric: Option<i32>,
    hex_byte: Option<u8>,
}

fn read_rtf_control<I>(chars: &mut std::iter::Peekable<I>) -> RtfControl
where
    I: Iterator<Item = char>,
{
    if let Some('\'') = chars.peek().copied() {
        let _ = chars.next();
        let hex = [chars.next(), chars.next()];
        let hex_byte = match hex {
            [Some(first), Some(second)] => u8::from_str_radix(&format!("{first}{second}"), 16).ok(),
            _ => None,
        };
        return RtfControl {
            word: String::from("'"),
            numeric: None,
            hex_byte,
        };
    }

    let mut word = String::new();
    while let Some(character) = chars.peek().copied() {
        if character.is_ascii_alphabetic() {
            word.push(character);
            let _ = chars.next();
        } else {
            break;
        }
    }

    let mut number = String::new();
    if matches!(chars.peek().copied(), Some('-')) {
        number.push('-');
        let _ = chars.next();
    }
    while let Some(character) = chars.peek().copied() {
        if character.is_ascii_digit() {
            number.push(character);
            let _ = chars.next();
        } else {
            break;
        }
    }
    if matches!(chars.peek().copied(), Some(' ')) {
        let _ = chars.next();
    }

    RtfControl {
        word,
        numeric: number.parse::<i32>().ok(),
        hex_byte: None,
    }
}

fn decode_windows_1252_byte(byte: u8) -> char {
    let codepoint = match byte {
        0x80 => 0x20ac,
        0x82 => 0x201a,
        0x83 => 0x0192,
        0x84 => 0x201e,
        0x85 => 0x2026,
        0x86 => 0x2020,
        0x87 => 0x2021,
        0x88 => 0x02c6,
        0x89 => 0x2030,
        0x8a => 0x0160,
        0x8b => 0x2039,
        0x8c => 0x0152,
        0x8e => 0x017d,
        0x91 => 0x2018,
        0x92 => 0x2019,
        0x93 => 0x201c,
        0x94 => 0x201d,
        0x95 => 0x2022,
        0x96 => 0x2013,
        0x97 => 0x2014,
        0x98 => 0x02dc,
        0x99 => 0x2122,
        0x9a => 0x0161,
        0x9b => 0x203a,
        0x9c => 0x0153,
        0x9e => 0x017e,
        0x9f => 0x0178,
        _ => return byte as char,
    };
    char::from_u32(codepoint).unwrap_or('\u{fffd}')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_blocks_keep_readable_plain_content() {
        let blocks = text_to_blocks("Lebenslauf\nMax Mustermann\nBerufserfahrung")
            .expect("plain text should be readable");
        let values = blocks
            .iter()
            .map(|block| block.text.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            values,
            vec!["Lebenslauf", "Max Mustermann", "Berufserfahrung"]
        );
    }

    #[test]
    fn ole_document_is_not_treated_as_plain_text() {
        let mut bytes = OLE_COMPOUND_FILE_MAGIC.to_vec();
        bytes.extend_from_slice(b"LEBENSLAUF");
        assert!(extract_plain_text_document(&bytes).is_none());
        assert!(is_ole_compound_document(&bytes));
    }

    #[test]
    fn legacy_doc_missing_converter_notice_is_clear() {
        let content = legacy_doc_converter_missing_blocks()
            .into_iter()
            .map(|block| block.text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(content.contains("Legacy .doc preview needs an external converter"));
        assert!(!content.contains("[Content_Types].xml"));
        assert!(!content.contains("Word.Document.8"));
        assert!(!content.contains("MSWordDoc"));
    }

    #[test]
    fn extracts_basic_rtf_text() {
        let text = extract_rtf_text(br"{\rtf1\ansi Lebenslauf\par Max Mustermann\par}");
        assert!(text.contains("Lebenslauf"));
        assert!(text.contains("Max Mustermann"));
    }

    #[test]
    fn detects_zip_package_signature() {
        assert!(looks_like_zip_package(b"PK\x03\x04docx data"));
        assert!(!looks_like_zip_package(OLE_COMPOUND_FILE_MAGIC));
    }

    #[test]
    fn detects_ole_binary_doc_magic() {
        assert!(is_ole_compound_document(OLE_COMPOUND_FILE_MAGIC));
    }
}
