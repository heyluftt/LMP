use quick_xml::{
    events::{BytesStart, Event},
    Reader,
};
use serde::Serialize;
use std::{fs, fs::File, io::Read, path::Path};
use zip::ZipArchive;

const MAX_DOCX_BYTES: u64 = 80 * 1024 * 1024;
const MAX_DOCUMENT_XML_BYTES: usize = 32 * 1024 * 1024;
const MAX_LEGACY_TEXT_CHARS: usize = 512 * 1024;
const MAX_BLOCKS: usize = 5_000;
const WORD_DOCUMENT_XML: &str = "word/document.xml";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordDocumentContent {
    pub title: String,
    pub block_count: usize,
    pub word_count: usize,
    pub blocks: Vec<WordDocumentBlock>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordDocumentBlock {
    pub kind: String,
    pub text: String,
}

pub fn read_word_document(path: &Path) -> Result<WordDocumentContent, String> {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("doc"))
        .unwrap_or(false)
    {
        return read_legacy_word_document(path);
    }

    read_open_xml_word_document(path)
}

fn read_open_xml_word_document(path: &Path) -> Result<WordDocumentContent, String> {
    let metadata = path
        .metadata()
        .map_err(|error| format!("Could not read Word document metadata: {error}"))?;
    if metadata.len() > MAX_DOCX_BYTES {
        return Err("Word document is larger than LMP's current 80 MB preview limit.".to_string());
    }

    let file =
        File::open(path).map_err(|error| format!("Could not open Word document: {error}"))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| format!("This Word document is not a readable DOCX/ZIP file: {error}"))?;
    let mut document = archive
        .by_name(WORD_DOCUMENT_XML)
        .map_err(|_| "Word document does not contain word/document.xml.".to_string())?;
    if document.size() > MAX_DOCUMENT_XML_BYTES as u64 {
        return Err("Word document XML is larger than LMP can preview.".to_string());
    }

    let mut xml = String::new();
    document
        .read_to_string(&mut xml)
        .map_err(|error| format!("Could not read Word document XML: {error}"))?;
    if xml.len() > MAX_DOCUMENT_XML_BYTES {
        return Err("Word document XML is larger than LMP can preview.".to_string());
    }

    let fallback_title = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Word document");

    parse_word_document_xml(&xml, fallback_title)
}

fn read_legacy_word_document(path: &Path) -> Result<WordDocumentContent, String> {
    let metadata = path
        .metadata()
        .map_err(|error| format!("Could not read legacy Word document metadata: {error}"))?;
    if metadata.len() > MAX_DOCX_BYTES {
        return Err("Word document is larger than LMP's current 80 MB preview limit.".to_string());
    }

    let bytes =
        fs::read(path).map_err(|error| format!("Could not read legacy Word document: {error}"))?;
    let fallback_title = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Word document");
    let text = extract_legacy_doc_text(&bytes);
    let mut blocks = text
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
        blocks.push(WordDocumentBlock {
            kind: String::from("notice"),
            text: String::from(
                "This legacy .doc file uses Microsoft's old binary Word format. LMP can register and open it, but exact text extraction is not reliable yet. Saving it as .docx will give a much better in-app preview.",
            ),
        });
    }

    Ok(finalize_word_content(blocks, fallback_title))
}

fn extract_legacy_doc_text(bytes: &[u8]) -> String {
    let candidates = [
        collect_utf16_strings(bytes, 0),
        collect_utf16_strings(bytes, 1),
        collect_ascii_strings(bytes),
    ];
    let best = candidates
        .into_iter()
        .max_by_key(|value| meaningful_text_score(value))
        .unwrap_or_default();
    clean_extracted_text(&best)
}

fn collect_utf16_strings(bytes: &[u8], start: usize) -> String {
    let mut output = String::new();
    let mut run = String::new();
    let mut index = start;

    while index + 1 < bytes.len() && output.len() < MAX_LEGACY_TEXT_CHARS {
        let unit = u16::from_le_bytes([bytes[index], bytes[index + 1]]);
        let character = char::from_u32(unit as u32);
        if character.map(is_document_text_char).unwrap_or(false) {
            run.push(character.unwrap());
        } else {
            flush_text_run(&mut output, &mut run, 4);
        }
        index += 2;
    }

    flush_text_run(&mut output, &mut run, 4);
    output
}

fn collect_ascii_strings(bytes: &[u8]) -> String {
    let mut output = String::new();
    let mut run = String::new();

    for byte in bytes {
        if output.len() >= MAX_LEGACY_TEXT_CHARS {
            break;
        }
        let character = *byte as char;
        if character.is_ascii() && is_document_text_char(character) {
            run.push(character);
        } else {
            flush_text_run(&mut output, &mut run, 5);
        }
    }

    flush_text_run(&mut output, &mut run, 5);
    output
}

fn flush_text_run(output: &mut String, run: &mut String, min_len: usize) {
    if run.trim().chars().count() >= min_len {
        output.push_str(run.trim());
        output.push('\n');
    }
    run.clear();
}

fn is_document_text_char(character: char) -> bool {
    matches!(character, '\n' | '\r' | '\t')
        || (!character.is_control() && character != '\u{0}' && character != '\u{fffd}')
}

fn meaningful_text_score(value: &str) -> usize {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .count()
}

fn clean_extracted_text(value: &str) -> String {
    let mut lines = Vec::new();
    let mut previous = String::new();
    for line in value.replace('\r', "\n").lines() {
        let clean = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if clean.chars().count() < 2 || clean == previous {
            continue;
        }
        if meaningful_text_score(&clean) == 0 {
            continue;
        }
        previous = clean.clone();
        lines.push(clean);
        if lines.len() >= MAX_BLOCKS {
            break;
        }
    }
    lines.join("\n")
}

fn parse_word_document_xml(xml: &str, fallback_title: &str) -> Result<WordDocumentContent, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut buffer = Vec::new();
    let mut blocks = Vec::new();
    let mut paragraph = String::new();
    let mut paragraph_kind = String::from("paragraph");
    let mut in_paragraph = false;

    loop {
        match reader
            .read_event_into(&mut buffer)
            .map_err(|error| format!("Could not parse Word document XML: {error}"))?
        {
            Event::Start(start) => {
                let name = start.local_name();
                let name = name.as_ref();
                if name == b"p" {
                    flush_paragraph(&mut blocks, &mut paragraph, &paragraph_kind);
                    paragraph_kind = String::from("paragraph");
                    in_paragraph = true;
                } else if in_paragraph {
                    handle_word_paragraph_tag(
                        &reader,
                        &start,
                        name,
                        &mut paragraph,
                        &mut paragraph_kind,
                    );
                }
            }
            Event::Empty(start) => {
                let name = start.local_name();
                let name = name.as_ref();
                if name == b"p" {
                    flush_paragraph(&mut blocks, &mut paragraph, &paragraph_kind);
                    paragraph_kind = String::from("paragraph");
                    in_paragraph = false;
                } else if in_paragraph {
                    handle_word_paragraph_tag(
                        &reader,
                        &start,
                        name,
                        &mut paragraph,
                        &mut paragraph_kind,
                    );
                }
            }
            Event::Text(text) => {
                if in_paragraph {
                    let decoded = text
                        .xml_content()
                        .map_err(|error| format!("Could not decode Word document text: {error}"))?;
                    paragraph.push_str(&decoded);
                }
            }
            Event::CData(text) => {
                if in_paragraph {
                    let decoded = text
                        .decode()
                        .map_err(|error| format!("Could not decode Word document text: {error}"))?;
                    paragraph.push_str(&decoded);
                }
            }
            Event::End(end) => {
                let name = end.local_name();
                if name.as_ref() == b"p" {
                    flush_paragraph(&mut blocks, &mut paragraph, &paragraph_kind);
                    paragraph_kind = String::from("paragraph");
                    in_paragraph = false;
                    if blocks.len() >= MAX_BLOCKS {
                        break;
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }

    flush_paragraph(&mut blocks, &mut paragraph, &paragraph_kind);
    Ok(finalize_word_content(blocks, fallback_title))
}

fn handle_word_paragraph_tag(
    reader: &Reader<&[u8]>,
    start: &BytesStart<'_>,
    name: &[u8],
    paragraph: &mut String,
    paragraph_kind: &mut String,
) {
    match name {
        b"tab" => paragraph.push('\t'),
        b"br" | b"cr" => paragraph.push('\n'),
        b"numPr" => {
            if paragraph_kind == "paragraph" {
                *paragraph_kind = String::from("list");
            }
        }
        b"pStyle" => {
            if let Some(value) = word_attr_value(reader, start, b"val") {
                let style = value.to_ascii_lowercase();
                if style.starts_with("heading") || style == "title" || style == "subtitle" {
                    let heading_level = style
                        .chars()
                        .filter(|character| character.is_ascii_digit())
                        .collect::<String>();
                    *paragraph_kind = if heading_level.is_empty() {
                        String::from("heading")
                    } else {
                        format!("heading{}", heading_level)
                    };
                }
            }
        }
        _ => {}
    }
}

fn flush_paragraph(blocks: &mut Vec<WordDocumentBlock>, paragraph: &mut String, kind: &str) {
    let text = paragraph
        .replace('\u{00a0}', " ")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    paragraph.clear();
    if text.is_empty() || blocks.len() >= MAX_BLOCKS {
        return;
    }

    blocks.push(WordDocumentBlock {
        kind: kind.to_string(),
        text,
    });
}

fn word_attr_value(
    reader: &Reader<&[u8]>,
    start: &BytesStart<'_>,
    local_name: &[u8],
) -> Option<String> {
    start.attributes().flatten().find_map(|attribute| {
        if strip_xml_prefix(attribute.key.as_ref()) == local_name {
            attribute
                .decode_and_unescape_value(reader.decoder())
                .ok()
                .map(|value| value.into_owned())
        } else {
            None
        }
    })
}

fn strip_xml_prefix(name: &[u8]) -> &[u8] {
    name.iter()
        .position(|byte| *byte == b':')
        .map(|index| &name[index + 1..])
        .unwrap_or(name)
}

fn truncate_title(value: &str) -> String {
    let mut title = value.replace('\n', " ");
    if title.chars().count() > 96 {
        title = title.chars().take(93).collect::<String>();
        title.push_str("...");
    }
    title
}

fn finalize_word_content(
    blocks: Vec<WordDocumentBlock>,
    fallback_title: &str,
) -> WordDocumentContent {
    let word_count = blocks
        .iter()
        .map(|block| block.text.split_whitespace().count())
        .sum();
    let title = blocks
        .iter()
        .find(|block| block.kind.starts_with("heading"))
        .or_else(|| blocks.iter().find(|block| block.kind != "notice"))
        .or_else(|| blocks.first())
        .map(|block| truncate_title(&block.text))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback_title.to_string());

    WordDocumentContent {
        title,
        block_count: blocks.len(),
        word_count,
        blocks,
    }
}
