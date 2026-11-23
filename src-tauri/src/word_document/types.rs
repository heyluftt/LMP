use serde::Serialize;

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
