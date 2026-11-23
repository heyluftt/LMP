//! Reading, saving and inspecting files for the LMP text editor.
//!
//! Errors that the editor reacts to carry a `[text:<code>]` prefix so the
//! frontend can offer the matching follow-up (overwrite, reload, Save As).

use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::Serialize;

use crate::text_encoding::{self, TextEncoding};
use crate::{
    is_known_extensionless_text_file, media_extension, media_kind_label, media_sniff,
    run_blocking_command, TEXT_FILE_EXTENSIONS,
};

/// Files above this size are refused; the editor keeps the whole document in memory.
const MAX_TEXT_FILE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFileContent {
    content: String,
    encoding: String,
    encoding_source: &'static str,
    line_ending: &'static str,
    mixed_line_endings: bool,
    decode_errors: bool,
    binary: bool,
    longest_line: usize,
    stat: TextFileStat,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFileStat {
    path: String,
    byte_len: u64,
    modified_at: Option<u64>,
    read_only: bool,
}

#[tauri::command]
pub async fn read_text_file(
    path: String,
    encoding: Option<String>,
) -> Result<TextFileContent, String> {
    run_blocking_command("Could not finish reading text file", move || {
        read_text_file_sync(PathBuf::from(path), encoding.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn stat_text_file(path: String) -> Result<Option<TextFileStat>, String> {
    run_blocking_command("Could not check text file", move || {
        let file = PathBuf::from(path);
        match fs::metadata(&file) {
            Ok(metadata) if metadata.is_file() => Ok(Some(stat_from_metadata(&file, &metadata))),
            Ok(_) => Ok(None),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("Could not check text file: {error}")),
        }
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn write_text_file(
    path: String,
    content: String,
    line_ending: Option<String>,
    encoding: Option<String>,
    expected_modified_at: Option<u64>,
    overwrite_read_only: Option<bool>,
    create: Option<bool>,
) -> Result<TextFileStat, String> {
    run_blocking_command("Could not finish saving text file", move || {
        write_text_file_sync(
            PathBuf::from(path),
            &content,
            line_ending.as_deref().unwrap_or("lf"),
            encoding.as_deref().unwrap_or("utf-8"),
            expected_modified_at,
            overwrite_read_only.unwrap_or(false),
            create.unwrap_or(false),
        )
    })
    .await
}

/// Shows the Save As dialog and returns the chosen path without writing anything.
#[tauri::command]
pub fn choose_text_save_path(
    directory_hint: Option<String>,
    file_name: Option<String>,
    filter_name: Option<String>,
    filter_extensions: Option<Vec<String>>,
) -> Result<Option<String>, String> {
    let preferred_extensions = filter_extensions
        .unwrap_or_default()
        .into_iter()
        .map(|extension| {
            extension
                .trim()
                .trim_start_matches('.')
                .to_ascii_lowercase()
        })
        .filter(|extension| !extension.is_empty())
        .collect::<Vec<_>>();

    let mut dialog = rfd::FileDialog::new();
    if !preferred_extensions.is_empty() {
        let name = filter_name.unwrap_or_else(|| "Text".to_string());
        dialog = dialog.add_filter(name, &preferred_extensions);
    }
    dialog = dialog
        .add_filter("Text and code files", TEXT_FILE_EXTENSIONS)
        .add_filter("All files", &["*"]);

    if let Some(directory) = directory_hint
        .map(PathBuf::from)
        .filter(|directory| directory.is_dir())
    {
        dialog = dialog.set_directory(directory);
    }
    dialog = dialog.set_file_name(
        file_name
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "Untitled.txt".to_string()),
    );

    let Some(mut file) = dialog.save_file() else {
        return Ok(None);
    };
    if file.extension().is_none() && !is_known_extensionless_text_file(&file) {
        file.set_extension(
            preferred_extensions
                .first()
                .map(String::as_str)
                .unwrap_or("txt"),
        );
    }
    check_text_save_target(&file)?;
    Ok(Some(file.display().to_string()))
}

/// Paths the editor may save to. A `.ts` or `.mts` file that does not exist yet
/// becomes TypeScript; an existing one must already hold text, so an MPEG-TS
/// video is never overwritten.
fn check_text_save_target(file: &Path) -> Result<(), String> {
    if media_kind_label(file) == "text" {
        return Ok(());
    }
    if media_sniff::has_shared_extension(&media_extension(file)) {
        if !file.exists() {
            return Ok(());
        }
        return Err(
            "[text:unsupported-extension] This file is an MPEG-TS video. LMP does not overwrite it with text."
                .to_string(),
        );
    }
    Err(
        "[text:unsupported-extension] LMP can only save text with a text or code file extension."
            .to_string(),
    )
}

fn read_text_file_sync(file: PathBuf, encoding: Option<&str>) -> Result<TextFileContent, String> {
    let metadata = fs::metadata(&file).map_err(|error| match error.kind() {
        ErrorKind::NotFound => format!("[text:missing] File does not exist: {}", file.display()),
        ErrorKind::PermissionDenied => {
            format!(
                "[text:access-denied] Windows denied access to {}.",
                file.display()
            )
        }
        _ => format!("Could not open text file: {error}"),
    })?;
    if !metadata.is_file() {
        return Err(format!("Path is not a file: {}", file.display()));
    }
    if media_kind_label(&file) != "text" {
        return Err("This file is not registered as a text file.".to_string());
    }
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err(format!(
            "[text:too-large] This file is {} MB. The LMP editor opens text files up to {} MB.",
            metadata.len() / (1024 * 1024),
            MAX_TEXT_FILE_BYTES / (1024 * 1024)
        ));
    }

    let bytes = fs::read(&file).map_err(|error| match error.kind() {
        ErrorKind::PermissionDenied => {
            format!(
                "[text:access-denied] Windows denied access to {}.",
                file.display()
            )
        }
        _ => format!("Could not read text file: {error}"),
    })?;

    let decoded = match encoding {
        Some(id) => {
            let encoding = TextEncoding::from_id(id)
                .ok_or_else(|| format!("[text:unknown-encoding] Unknown text encoding: {id}"))?;
            text_encoding::decode_with(&bytes, encoding)
        }
        None => text_encoding::decode_auto(&bytes),
    };
    let line_endings = text_encoding::detect_line_endings(&decoded.text);
    let content = text_encoding::normalize_newlines(&decoded.text);
    let longest_line = text_encoding::longest_line_chars(&content);

    Ok(TextFileContent {
        content,
        encoding: decoded.encoding.id(),
        encoding_source: decoded.source.as_str(),
        line_ending: line_endings.dominant,
        mixed_line_endings: line_endings.mixed,
        decode_errors: decoded.had_errors,
        binary: decoded.binary,
        longest_line,
        stat: stat_from_metadata(&file, &metadata),
    })
}

fn write_text_file_sync(
    file: PathBuf,
    content: &str,
    line_ending: &str,
    encoding_id: &str,
    expected_modified_at: Option<u64>,
    overwrite_read_only: bool,
    create: bool,
) -> Result<TextFileStat, String> {
    check_text_save_target(&file)?;
    let encoding = TextEncoding::from_id(encoding_id)
        .ok_or_else(|| format!("[text:unknown-encoding] Unknown text encoding: {encoding_id}"))?;

    match fs::metadata(&file) {
        Ok(metadata) => {
            if !metadata.is_file() {
                return Err(format!("Path is not a file: {}", file.display()));
            }
            if let Some(expected) = expected_modified_at {
                if modified_millis(&metadata).is_some_and(|actual| actual != expected) {
                    return Err(
                        "[text:changed] The file was changed outside LMP after it was opened."
                            .to_string(),
                    );
                }
            }
            if metadata.permissions().readonly() {
                if !overwrite_read_only {
                    return Err("[text:read-only] The file is marked read-only.".to_string());
                }
                let mut permissions = metadata.permissions();
                #[allow(clippy::permissions_set_readonly_false)]
                permissions.set_readonly(false);
                fs::set_permissions(&file, permissions).map_err(|error| {
                    format!("[text:access-denied] Could not remove the read-only flag: {error}")
                })?;
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            if !create {
                return Err(format!(
                    "[text:missing] The file no longer exists: {}",
                    file.display()
                ));
            }
        }
        Err(error) => return Err(format!("Could not check text file: {error}")),
    }

    let bytes = text_encoding::encode(content, line_ending, encoding).map_err(|failure| {
        format!(
            "[text:unrepresentable] {} character{} cannot be stored as {} (first: \"{}\", U+{:04X}). Save with UTF-8 instead.",
            failure.count,
            if failure.count == 1 { "" } else { "s" },
            encoding.label(),
            failure.first,
            failure.first as u32
        )
    })?;

    write_bytes(&file, &bytes)?;
    let metadata =
        fs::metadata(&file).map_err(|error| format!("Could not check saved file: {error}"))?;
    Ok(stat_from_metadata(&file, &metadata))
}

fn write_bytes(file: &Path, bytes: &[u8]) -> Result<(), String> {
    let map_error = |error: std::io::Error| match error.kind() {
        ErrorKind::PermissionDenied => format!(
            "[text:access-denied] Windows denied write access to {}.",
            file.display()
        ),
        _ => format!("Could not save text file: {error}"),
    };
    let mut handle = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(file)
        .map_err(map_error)?;
    handle.write_all(bytes).map_err(map_error)?;
    handle.sync_all().map_err(map_error)
}

fn stat_from_metadata(file: &Path, metadata: &fs::Metadata) -> TextFileStat {
    TextFileStat {
        path: file.display().to_string(),
        byte_len: metadata.len(),
        modified_at: modified_millis(metadata),
        read_only: metadata.permissions().readonly(),
    }
}

fn modified_millis(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!("lmp-text-tests-{}", std::process::id()));
        fs::create_dir_all(&folder).expect("temp folder");
        folder.join(name)
    }

    #[test]
    fn saves_and_reads_back_with_encoding_and_line_endings() {
        let file = temp_file("roundtrip.txt");
        let stat = write_text_file_sync(
            file.clone(),
            "Grüße\nWelt",
            "crlf",
            "windows-1252",
            None,
            false,
            true,
        )
        .expect("write");
        // "Grüße\r\nWelt" is one byte per character in Windows-1252.
        assert_eq!(stat.byte_len, 11);

        let read = read_text_file_sync(file.clone(), Some("windows-1252")).expect("read");
        assert_eq!(read.content, "Grüße\nWelt");
        assert_eq!(read.line_ending, "crlf");
        assert_eq!(read.encoding, "windows-1252");
        let _ = fs::remove_file(file);
    }

    #[test]
    fn refuses_stale_writes_and_read_only_files() {
        let file = temp_file("guarded.md");
        let stat = write_text_file_sync(file.clone(), "one", "lf", "utf-8", None, false, true)
            .expect("write");
        let stale = stat.modified_at.map(|value| value.saturating_sub(5_000));
        let error = write_text_file_sync(file.clone(), "two", "lf", "utf-8", stale, false, false)
            .expect_err("stale write");
        assert!(error.starts_with("[text:changed]"));

        let mut permissions = fs::metadata(&file).expect("metadata").permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&file, permissions).expect("set read-only");
        let error = write_text_file_sync(file.clone(), "two", "lf", "utf-8", None, false, false)
            .expect_err("read-only write");
        assert!(error.starts_with("[text:read-only]"));
        let stat = write_text_file_sync(file.clone(), "two", "lf", "utf-8", None, true, false)
            .expect("overwrite read-only");
        assert!(!stat.read_only);
        let _ = fs::remove_file(file);
    }

    #[test]
    fn refuses_missing_files_unless_created() {
        let file = temp_file("missing.json");
        let _ = fs::remove_file(&file);
        let error = write_text_file_sync(file.clone(), "{}", "lf", "utf-8", None, false, false)
            .expect_err("missing");
        assert!(error.starts_with("[text:missing]"));
    }

    #[test]
    fn saves_typescript_ts_files_but_never_over_transport_streams() {
        let source = temp_file("module.ts");
        let _ = fs::remove_file(&source);
        write_text_file_sync(
            source.clone(),
            "export const a = 1;\n",
            "lf",
            "utf-8",
            None,
            false,
            true,
        )
        .expect("create .ts");
        let read = read_text_file_sync(source.clone(), None).expect("read .ts");
        assert_eq!(read.content, "export const a = 1;\n");
        let _ = fs::remove_file(source);

        let video = temp_file("recording.ts");
        let mut packets = vec![0xffu8; 188 * 8];
        for packet in 0..8 {
            packets[packet * 188] = 0x47;
        }
        fs::write(&video, &packets).expect("write video");
        let error = write_text_file_sync(video.clone(), "text", "lf", "utf-8", None, false, false)
            .expect_err("overwrite video");
        assert!(error.contains("MPEG-TS video"));
        assert!(read_text_file_sync(video.clone(), None).is_err());
        assert_eq!(fs::read(&video).expect("video bytes"), packets);
        let _ = fs::remove_file(video);
    }

    #[test]
    fn opens_extensionless_text_names() {
        let file = temp_file("Dockerfile");
        fs::write(&file, b"FROM scratch\r\n").expect("write");
        let read = read_text_file_sync(file.clone(), None).expect("read dockerfile");
        assert_eq!(read.content, "FROM scratch\n");
        assert_eq!(read.line_ending, "crlf");
        let _ = fs::remove_file(file);
    }
}
