mod converter;
mod legacy;
mod open_xml;
mod text;
mod types;

use std::path::Path;

pub use types::WordDocumentContent;

const MAX_DOCX_BYTES: u64 = 80 * 1024 * 1024;
const MAX_DOCUMENT_XML_BYTES: usize = 32 * 1024 * 1024;
const MAX_BLOCKS: usize = 5_000;

pub fn read_word_document(path: &Path) -> Result<WordDocumentContent, String> {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("doc"))
        .unwrap_or(false)
    {
        return legacy::read_legacy_word_document(path);
    }

    open_xml::read_open_xml_word_document(path)
}
