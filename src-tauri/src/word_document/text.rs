use super::{
    types::{WordDocumentBlock, WordDocumentContent},
    MAX_BLOCKS,
};

pub(crate) fn clean_extracted_text(value: &str) -> String {
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

pub(crate) fn meaningful_text_score(value: &str) -> usize {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .count()
}

fn truncate_title(value: &str) -> String {
    let mut title = value.replace('\n', " ");
    if title.chars().count() > 96 {
        title = title.chars().take(93).collect::<String>();
        title.push_str("...");
    }
    title
}

pub(crate) fn finalize_word_content(
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
