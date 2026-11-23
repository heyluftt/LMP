//! Crash-safe drafts for the text editor.
//!
//! Every unsaved document gets its own draft file plus a small summary file so
//! the home screen can list drafts without loading their full text. Drafts a
//! live window is still writing are hidden from other windows.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::Manager;

const DRAFT_SCHEMA_VERSION: u32 = 2;
const LEGACY_SCHEMA_VERSION: u32 = 1;
const MAX_TEXT_BYTES: usize = 16 * 1024 * 1024;
const MAX_PATH_LEN: usize = 32_768;
const MAX_DRAFTS: usize = 24;
const PREVIEW_CHARS: usize = 140;
static DRAFT_IO_LOCK: Mutex<()> = Mutex::new(());

/// Draft id -> label of the window that currently writes it.
#[derive(Default)]
pub struct TextDraftClaims(Mutex<HashMap<String, String>>);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDraftSnapshot {
    version: u32,
    id: String,
    title: String,
    base_content: String,
    draft: String,
    original_path: Option<String>,
    save_path: Option<String>,
    source_type: String,
    suggested_save_path: Option<String>,
    encoding: String,
    line_ending: String,
    language_id: Option<String>,
    base_modified_at: Option<u64>,
    updated_at: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDraftSummary {
    id: String,
    title: String,
    path: Option<String>,
    source_type: String,
    updated_at: u64,
    char_count: usize,
    preview: String,
}

/// Single-draft format written by LMP 0.2.x (one file per window label).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySnapshot {
    version: u32,
    base_content: String,
    draft: String,
    original_path: Option<String>,
    save_path: Option<String>,
    source_type: String,
    suggested_save_path: Option<String>,
    encoding: String,
    line_ending: String,
    updated_at: u64,
}

#[tauri::command]
pub async fn list_text_drafts(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    claims: tauri::State<'_, TextDraftClaims>,
) -> Result<Vec<TextDraftSummary>, String> {
    let root = text_cache_dir(&app)?;
    let mut summaries = tauri::async_runtime::spawn_blocking(move || list_summaries(&root))
        .await
        .map_err(|error| format!("Could not finish listing text drafts: {error}"))??;

    let claimed = claims
        .0
        .lock()
        .map(|claims| claims.clone())
        .unwrap_or_default();
    let label = window.label().to_string();
    summaries.retain(|summary| match claimed.get(&summary.id) {
        Some(owner) if *owner != label => app.get_webview_window(owner).is_none(),
        _ => true,
    });
    Ok(summaries)
}

#[tauri::command]
pub async fn read_text_draft(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    claims: tauri::State<'_, TextDraftClaims>,
    id: String,
) -> Result<Option<TextDraftSnapshot>, String> {
    validate_id(&id)?;
    let root = text_cache_dir(&app)?;
    let draft_id = id.clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || read_snapshot(&root, &draft_id))
        .await
        .map_err(|error| format!("Could not finish loading text draft: {error}"))??;
    if snapshot.is_some() {
        claim(&claims, &id, window.label());
    }
    Ok(snapshot)
}

#[tauri::command]
pub async fn write_text_draft(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    claims: tauri::State<'_, TextDraftClaims>,
    snapshot: TextDraftSnapshot,
) -> Result<(), String> {
    if !valid_snapshot(&snapshot) {
        return Err("Text draft data is invalid or too large.".to_string());
    }
    claim(&claims, &snapshot.id, window.label());
    let root = text_cache_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || write_snapshot(&root, &snapshot))
        .await
        .map_err(|error| format!("Could not finish saving text draft: {error}"))?
}

#[tauri::command]
pub async fn clear_text_draft(
    app: tauri::AppHandle,
    claims: tauri::State<'_, TextDraftClaims>,
    id: String,
) -> Result<(), String> {
    validate_id(&id)?;
    if let Ok(mut claims) = claims.0.lock() {
        claims.remove(&id);
    }
    let root = text_cache_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock_io()?;
        remove_draft_files(&drafts_dir(&root), &id);
        Ok(())
    })
    .await
    .map_err(|error| format!("Could not finish clearing text draft: {error}"))?
}

fn claim(claims: &TextDraftClaims, id: &str, label: &str) {
    if let Ok(mut claims) = claims.0.lock() {
        claims.insert(id.to_string(), label.to_string());
    }
}

fn text_cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|path| path.join("text"))
        .map_err(|error| format!("Could not resolve text draft directory: {error}"))
}

fn drafts_dir(root: &Path) -> PathBuf {
    root.join("drafts")
}

fn lock_io() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    DRAFT_IO_LOCK
        .lock()
        .map_err(|_| "Text draft storage is unavailable.".to_string())
}

fn validate_id(id: &str) -> Result<(), String> {
    let valid = !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'));
    if valid {
        Ok(())
    } else {
        Err("Invalid text draft id.".to_string())
    }
}

fn valid_optional_path(path: &Option<String>) -> bool {
    path.as_ref()
        .map(|path| path.len() <= MAX_PATH_LEN)
        .unwrap_or(true)
}

fn valid_snapshot(snapshot: &TextDraftSnapshot) -> bool {
    snapshot.version == DRAFT_SCHEMA_VERSION
        && validate_id(&snapshot.id).is_ok()
        && snapshot.title.len() <= 1024
        && snapshot.draft.len() <= MAX_TEXT_BYTES
        && snapshot.base_content.len() <= MAX_TEXT_BYTES
        && matches!(
            snapshot.source_type.as_str(),
            "file" | "word-extract" | "untitled"
        )
        && matches!(snapshot.line_ending.as_str(), "lf" | "crlf" | "cr")
        && snapshot.encoding.len() <= 64
        && snapshot
            .language_id
            .as_ref()
            .map(|language| language.len() <= 64)
            .unwrap_or(true)
        && snapshot.updated_at > 0
        && valid_optional_path(&snapshot.original_path)
        && valid_optional_path(&snapshot.save_path)
        && valid_optional_path(&snapshot.suggested_save_path)
}

fn summary_for(snapshot: &TextDraftSnapshot) -> TextDraftSummary {
    let preview = snapshot
        .draft
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(PREVIEW_CHARS)
        .collect::<String>();
    TextDraftSummary {
        id: snapshot.id.clone(),
        title: snapshot.title.clone(),
        path: snapshot
            .save_path
            .clone()
            .or_else(|| snapshot.original_path.clone()),
        source_type: snapshot.source_type.clone(),
        updated_at: snapshot.updated_at,
        char_count: snapshot.draft.chars().count(),
        preview,
    }
}

fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp_path = path.with_extension("tmp");
    fs::write(&temp_path, bytes).map_err(|error| format!("Could not write text draft: {error}"))?;
    fs::rename(&temp_path, path).map_err(|error| format!("Could not finish text draft: {error}"))
}

fn write_snapshot(root: &Path, snapshot: &TextDraftSnapshot) -> Result<(), String> {
    let _guard = lock_io()?;
    let folder = drafts_dir(root);
    fs::create_dir_all(&folder)
        .map_err(|error| format!("Could not create text draft directory: {error}"))?;
    let draft = serde_json::to_vec(snapshot)
        .map_err(|error| format!("Could not serialize text draft: {error}"))?;
    let summary = serde_json::to_vec(&summary_for(snapshot))
        .map_err(|error| format!("Could not serialize text draft summary: {error}"))?;
    write_atomically(&folder.join(format!("{}.json", snapshot.id)), &draft)?;
    write_atomically(&folder.join(format!("{}.meta.json", snapshot.id)), &summary)?;
    prune_old_drafts(&folder);
    Ok(())
}

fn read_snapshot(root: &Path, id: &str) -> Result<Option<TextDraftSnapshot>, String> {
    let _guard = lock_io()?;
    let folder = drafts_dir(root);
    let path = folder.join(format!("{id}.json"));
    if !path.is_file() {
        return Ok(None);
    }
    let snapshot = fs::read(&path)
        .ok()
        .filter(|bytes| bytes.len() <= MAX_TEXT_BYTES * 2 + 1_048_576)
        .and_then(|bytes| serde_json::from_slice::<TextDraftSnapshot>(&bytes).ok())
        .filter(|snapshot| valid_snapshot(snapshot) && snapshot.id == id);
    if snapshot.is_none() {
        remove_draft_files(&folder, id);
    }
    Ok(snapshot)
}

fn list_summaries(root: &Path) -> Result<Vec<TextDraftSummary>, String> {
    let _guard = lock_io()?;
    migrate_legacy_drafts(root);
    let folder = drafts_dir(root);
    let Ok(entries) = fs::read_dir(&folder) else {
        return Ok(Vec::new());
    };

    let mut summaries = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let id = name.strip_suffix(".meta.json")?.to_string();
            let summary = fs::read(entry.path())
                .ok()
                .and_then(|bytes| serde_json::from_slice::<TextDraftSummary>(&bytes).ok())
                .filter(|summary| summary.id == id && folder.join(format!("{id}.json")).is_file());
            if summary.is_none() {
                remove_draft_files(&folder, &id);
            }
            summary
        })
        .collect::<Vec<_>>();
    summaries.sort_by_key(|summary| std::cmp::Reverse(summary.updated_at));
    Ok(summaries)
}

fn remove_draft_files(folder: &Path, id: &str) {
    let _ = fs::remove_file(folder.join(format!("{id}.json")));
    let _ = fs::remove_file(folder.join(format!("{id}.meta.json")));
}

fn prune_old_drafts(folder: &Path) {
    let Ok(entries) = fs::read_dir(folder) else {
        return;
    };
    let mut drafts = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let id = name.strip_suffix(".meta.json")?.to_string();
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()?;
            Some((id, modified))
        })
        .collect::<Vec<_>>();
    if drafts.len() <= MAX_DRAFTS {
        return;
    }
    drafts.sort_by_key(|draft| std::cmp::Reverse(draft.1));
    for (id, _) in drafts.into_iter().skip(MAX_DRAFTS) {
        remove_draft_files(folder, &id);
    }
}

/// Moves `recovery-<window>.json` files from older builds into the draft store.
fn migrate_legacy_drafts(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(label) = name
            .strip_prefix("recovery-")
            .and_then(|rest| rest.strip_suffix(".json"))
        else {
            continue;
        };
        let path = entry.path();
        let legacy = fs::read(&path)
            .ok()
            .filter(|bytes| bytes.len() <= MAX_TEXT_BYTES * 2 + 1_048_576)
            .and_then(|bytes| serde_json::from_slice::<LegacySnapshot>(&bytes).ok())
            .filter(|legacy| {
                legacy.version == LEGACY_SCHEMA_VERSION && legacy.draft != legacy.base_content
            });
        if let Some(legacy) = legacy {
            let clean_label = label
                .chars()
                .map(|character| {
                    if character.is_ascii_alphanumeric() {
                        character
                    } else {
                        '_'
                    }
                })
                .take(60)
                .collect::<String>();
            let document_path = legacy
                .save_path
                .clone()
                .or_else(|| legacy.original_path.clone());
            let title = document_path
                .as_deref()
                .and_then(|path| Path::new(path).file_name())
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "Untitled.txt".to_string());
            let source_type = if legacy.source_type == "file" && document_path.is_none() {
                "untitled".to_string()
            } else {
                legacy.source_type
            };
            let snapshot = TextDraftSnapshot {
                version: DRAFT_SCHEMA_VERSION,
                id: format!("legacy-{clean_label}"),
                title,
                base_content: legacy.base_content,
                draft: legacy.draft,
                original_path: legacy.original_path,
                save_path: legacy.save_path,
                source_type,
                suggested_save_path: legacy.suggested_save_path,
                encoding: legacy.encoding,
                line_ending: legacy.line_ending,
                language_id: None,
                base_modified_at: None,
                updated_at: legacy.updated_at,
            };
            if valid_snapshot(&snapshot) {
                let folder = drafts_dir(root);
                let written = fs::create_dir_all(&folder).is_ok()
                    && serde_json::to_vec(&snapshot)
                        .ok()
                        .map(|bytes| {
                            write_atomically(&folder.join(format!("{}.json", snapshot.id)), &bytes)
                                .is_ok()
                        })
                        .unwrap_or(false)
                    && serde_json::to_vec(&summary_for(&snapshot))
                        .ok()
                        .map(|bytes| {
                            write_atomically(
                                &folder.join(format!("{}.meta.json", snapshot.id)),
                                &bytes,
                            )
                            .is_ok()
                        })
                        .unwrap_or(false);
                if !written {
                    continue;
                }
            }
        }
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("lmp-draft-tests-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("temp root");
        root
    }

    fn snapshot(id: &str, draft: &str, updated_at: u64) -> TextDraftSnapshot {
        TextDraftSnapshot {
            version: DRAFT_SCHEMA_VERSION,
            id: id.to_string(),
            title: format!("{id}.txt"),
            base_content: String::new(),
            draft: draft.to_string(),
            original_path: None,
            save_path: None,
            source_type: "untitled".to_string(),
            suggested_save_path: None,
            encoding: "utf-8".to_string(),
            line_ending: "lf".to_string(),
            language_id: Some("markdown".to_string()),
            base_modified_at: None,
            updated_at,
        }
    }

    #[test]
    fn lists_drafts_newest_first_and_reads_them_back() {
        let root = temp_root("list");
        write_snapshot(&root, &snapshot("new-a", "first   draft\ntext", 10)).expect("write a");
        write_snapshot(&root, &snapshot("new-b", "second", 20)).expect("write b");

        let summaries = list_summaries(&root).expect("list");
        assert_eq!(
            summaries
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["new-b", "new-a"]
        );
        assert_eq!(summaries[1].preview, "first draft text");

        let read = read_snapshot(&root, "new-a").expect("read").expect("draft");
        assert_eq!(read.draft, "first   draft\ntext");
        assert_eq!(read.language_id.as_deref(), Some("markdown"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn migrates_legacy_window_drafts() {
        let root = temp_root("legacy");
        fs::write(
            root.join("recovery-main.json"),
            br#"{"version":1,"baseContent":"","draft":"hello","originalPath":null,"savePath":null,"sourceType":"file","suggestedSavePath":null,"encoding":"utf-8","lineEnding":"lf","updatedAt":5}"#,
        )
        .expect("legacy file");

        let summaries = list_summaries(&root).expect("list");
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, "legacy-main");
        assert_eq!(summaries[0].source_type, "untitled");
        assert!(!root.join("recovery-main.json").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_bad_ids() {
        assert!(validate_id("file-0123abcd").is_ok());
        assert!(validate_id("../escape").is_err());
        assert!(validate_id("").is_err());
    }
}
