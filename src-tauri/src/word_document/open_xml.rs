use super::{
    text::finalize_word_content,
    types::{WordDocumentBlock, WordDocumentContent},
    MAX_BLOCKS, MAX_DOCUMENT_XML_BYTES, MAX_DOCX_BYTES,
};
use quick_xml::{
    events::{BytesStart, Event},
    Reader,
};
use std::{fs::File, io::Read, path::Path};
use zip::ZipArchive;

const WORD_DOCUMENT_XML: &str = "word/document.xml";

pub(crate) fn read_open_xml_word_document(path: &Path) -> Result<WordDocumentContent, String> {
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
