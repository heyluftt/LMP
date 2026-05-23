#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod paths;
mod window_state;
mod word_document;
mod terminal;

use paths::lmp_data_dir;
use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::DefaultHasher, HashMap, HashSet},
    env, fs,
    hash::{Hash, Hasher},
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, WindowEvent};
use window_state::{restore_window_state, save_window_state, watch_window_state};
use word_document::{read_word_document as read_word_document_file, WordDocumentContent};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, HWND, INVALID_HANDLE_VALUE,
    },
    System::{
        DataExchange::COPYDATASTRUCT,
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        Environment::GetCommandLineW,
        Threading::{CreateMutexW, OpenMutexW, MUTEX_ALL_ACCESS},
    },
    UI::WindowsAndMessaging::{FindWindowW, SendMessageW, WM_COPYDATA},
};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(windows)]
const SINGLE_INSTANCE_CLASS_NAME: &str = "com.heyluftt.lmp-sic";
#[cfg(windows)]
const SINGLE_INSTANCE_WINDOW_NAME: &str = "com.heyluftt.lmp-siw";
#[cfg(windows)]
const SINGLE_INSTANCE_MUTEX_NAME: &str = "com.heyluftt.lmp-sim";
#[cfg(windows)]
const STARTUP_GUARD_MUTEX_NAME: &str = "com.heyluftt.lmp-startup-guard";
#[cfg(windows)]
const WMCOPYDATA_SINGLE_INSTANCE_DATA: usize = 1542;
#[cfg(windows)]
const SECONDARY_FORWARD_WAIT_ATTEMPTS: usize = 80;
#[cfg(windows)]
const SECONDARY_FORWARD_WAIT_MS: u64 = 50;

const SUPPORTED_MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "webm", "mov", "wmv", "mkv", "avi", "ts", "mts", "m2ts", "mpeg", "mpg", "mpe",
    "ogv", "3gp", "3g2", "flv", "f4v", "asf", "vob", "divx", "mxf", "mp3", "flac", "wav", "m4a",
    "aac", "ogg", "opus", "wma", "aiff", "aif", "oga", "weba", "caf", "amr", "jpg", "jpeg", "jfif",
    "png", "gif", "webp", "bmp", "avif", "svg", "ico", "tif", "tiff", "pdf", "doc", "docx", "docm",
    "dotx", "dotm", "txt", "md", "markdown", "log", "json", "jsonc", "csv", "tsv", "xml", "yaml",
    "yml", "toml", "ini", "conf", "cfg", "css", "scss", "sass", "less", "html", "htm", "xhtml",
    "js", "jsx", "tsx", "mjs", "cjs", "vue", "svelte", "astro", "rs", "py", "java", "c", "cpp",
    "h", "hpp", "cs", "go", "php", "rb", "sh", "ps1", "bat", "cmd", "sql", "lua", "dart", "kt",
    "kts", "swift", "pl", "r", "gradle", "mka", "mp2", "mpa", "ac3", "eac3", "dts", "dtshd", "ape",
    "alac", "au", "snd",
];

const THUMBNAIL_CACHE_MAX_BYTES: u64 = 512 * 1024 * 1024;
const PROBE_CACHE_SCHEMA_VERSION: u32 = 1;
const PROBE_FORMAT_VERSION: u32 = 1;
static THUMBNAIL_GENERATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

const TEXT_FILE_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "log", "json", "jsonc", "csv", "tsv", "xml", "yaml", "yml", "toml",
    "ini", "conf", "cfg", "css", "scss", "sass", "less", "html", "htm", "xhtml", "js", "jsx",
    "tsx", "mjs", "cjs", "vue", "svelte", "astro", "rs", "py", "java", "c", "cpp", "h", "hpp",
    "cs", "go", "php", "rb", "sh", "ps1", "bat", "cmd", "sql", "lua", "dart", "kt", "kts", "swift",
    "pl", "r", "gradle",
];
const TEXT_FILE_NAMES: &[&str] = &[
    ".editorconfig",
    ".eslintrc",
    ".gitattributes",
    ".gitignore",
    ".npmrc",
    ".prettierrc",
    "dockerfile",
    "license",
    "makefile",
    "readme",
];

#[derive(Clone)]
struct AppState {
    pending_files: Arc<Mutex<Vec<String>>>,
    window_files: Arc<Mutex<HashMap<String, Vec<String>>>>,
    window_media_files: Arc<Mutex<HashMap<String, Vec<String>>>>,
    window_media_kinds: Arc<Mutex<HashMap<String, String>>>,
    audio_multi_window: Arc<Mutex<bool>>,
    clip_export_cancellations: Arc<Mutex<HashSet<String>>>,
    window_counter: Arc<Mutex<u64>>,
    gstreamer_session: Arc<Mutex<Option<GstreamerPlaybackState>>>,
}

impl AppState {
    fn new(pending_files: Vec<String>) -> Self {
        Self {
            pending_files: Arc::new(Mutex::new(pending_files)),
            window_files: Arc::new(Mutex::new(HashMap::new())),
            window_media_files: Arc::new(Mutex::new(HashMap::new())),
            window_media_kinds: Arc::new(Mutex::new(HashMap::new())),
            audio_multi_window: Arc::new(Mutex::new(false)),
            clip_export_cancellations: Arc::new(Mutex::new(HashSet::new())),
            window_counter: Arc::new(Mutex::new(0)),
            gstreamer_session: Arc::new(Mutex::new(None)),
        }
    }
}

struct GstreamerPlaybackState {
    path: String,
    pid: u32,
    started_at: u64,
    child: Child,
}

impl Drop for GstreamerPlaybackState {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Serialize)]
struct EngineStatus {
    available: bool,
    name: String,
    hint: Option<String>,
}

#[derive(Serialize)]
struct PlaybackBackendStatus {
    id: String,
    name: String,
    role: String,
    available: bool,
    version: Option<String>,
    path: Option<String>,
    hint: Option<String>,
}

#[derive(Serialize)]
struct GstreamerProbe {
    summary: Vec<String>,
    details: String,
}

#[derive(Serialize)]
struct GstreamerPlaybackSession {
    active: bool,
    path: Option<String>,
    pid: Option<u32>,
    started_at: Option<u64>,
}

#[derive(Deserialize, Serialize)]
struct MediaInspectionItem {
    label: String,
    value: String,
    detail: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct MediaInspection {
    source: String,
    summary: Vec<MediaInspectionItem>,
    details: String,
}

#[derive(Deserialize, Serialize)]
struct CachedMediaInspection {
    schema_version: u32,
    probe_format_version: u32,
    inspection: MediaInspection,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailCacheStatus {
    path: String,
    file_count: usize,
    byte_len: u64,
    max_byte_len: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheStatus {
    file_count: usize,
    byte_len: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsCacheStatus {
    preview: CacheStatus,
    prepared_video: CacheStatus,
    media_probe: CacheStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaThumbnail {
    kind: String,
    path: Option<String>,
    source: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ClipExportProgress {
    job_id: String,
    progress: f64,
    status: String,
    message: Option<String>,
}

struct ClipExportPreset {
    name: &'static str,
    video_preset: &'static str,
    crf: &'static str,
    audio_bitrate: &'static str,
}

#[derive(Serialize)]
struct MediaFile {
    path: String,
    display_name: String,
    extension: String,
    byte_len: u64,
}

#[derive(Serialize)]
struct MediaFolderItem {
    path: String,
    display_name: String,
    extension: String,
    byte_len: u64,
    kind: String,
    modified_at: Option<u64>,
}

#[derive(Serialize)]
struct MediaFolder {
    path: String,
    parent: Option<String>,
    items: Vec<MediaFolderItem>,
}

#[derive(Serialize)]
struct SubtitleFile {
    path: String,
    display_name: String,
    extension: String,
    content: String,
}

#[derive(Serialize)]
struct TextFileContent {
    content: String,
    line_count: usize,
    encoding: String,
    line_ending: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaOpenRequest {
    target_label: String,
    files: Vec<String>,
}

fn main() {
    stabilize_installer_launch_environment();

    let raw_startup_args = env::args().collect::<Vec<_>>();
    let startup_files = media_args(raw_startup_args.iter().skip(1).cloned());
    log_instance_event_with_args(
        "process-start",
        "candidate",
        "shouldExit=false",
        &raw_startup_args,
        &startup_files,
    );
    let _windows_launch_guard =
        forward_to_existing_instance_or_acquire_startup_guard(&raw_startup_args, &startup_files);
    let reveal_main_immediately = startup_files.is_empty();
    let main_startup_files = startup_files.clone();
    let main_startup_kind = startup_files
        .first()
        .map(Path::new)
        .map(media_kind_label)
        .unwrap_or("unknown")
        .to_string();
    let state = AppState::new(startup_files);
    let single_instance_state = state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_single_instance::init(
            move |app, args, _cwd| {
                let files = media_args(args.iter().cloned());
                log_instance_event_with_args(
                    "single-instance-callback",
                    "primary",
                    &format!("cwd=\"{}\" shouldExit=false", compact_log_value(&_cwd)),
                    &args,
                    &files,
                );
                if !files.is_empty() {
                    defer_single_instance_files(app, single_instance_state.clone(), files);
                } else {
                    defer_single_instance_reveal(app);
                }
            },
        ))
        .manage(state)
        .manage(terminal::TerminalState::default())
        .setup(move |app| {
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            if let Some(window) = app.get_webview_window("main") {
                log_instance_event(
                    "window-setup",
                    "primary",
                    &format!(
                        "windowLabel={} startupKind={} revealMain={} shouldExit=false",
                        window.label(),
                        main_startup_kind,
                        reveal_main_immediately
                    ),
                    &main_startup_files,
                );
                restore_window_state(&window);
                watch_window_state(&window);
                let app_state = app.state::<AppState>();
                watch_window_registry_cleanup(&window, app_state.inner());
                if main_startup_kind != "unknown" {
                    let window_media_kinds = app_state.window_media_kinds.clone();
                    let window_media_files = app_state.window_media_files.clone();
                    if let Ok(mut kinds) = window_media_kinds.lock() {
                        kinds.insert("main".to_string(), main_startup_kind.clone());
                    };
                    if let Ok(mut files) = window_media_files.lock() {
                        files.insert("main".to_string(), main_startup_files.clone());
                    };
                }
                if reveal_main_immediately {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_engine_status,
            get_playback_backends,
            inspect_media,
            probe_media_with_gstreamer,
            open_file_dialog,
            open_files_dialog,
            open_media_folder_dialog,
            open_subtitle_dialog,
            find_sidecar_subtitle,
            browse_media_folder,
            list_sibling_media,
            prepare_media,
            open_with_gstreamer,
            start_gstreamer_playback,
            stop_gstreamer_playback,
            get_gstreamer_playback_session,
            transmux_for_native,
            choose_clip_output_path,
            export_video_clip,
            cancel_clip_export,
            show_path_in_explorer,
            extract_audio_artwork,
            get_media_thumbnail,
            get_thumbnail_cache_status,
            clear_thumbnail_cache,
            get_settings_cache_status,
            clear_preview_cache,
            clear_prepared_video_cache,
            clear_media_probe_cache,
            print_file,
            read_word_document,
            read_text_file,
            save_text_file_dialog,
            write_text_file,
            set_window_media_kind,
            set_audio_multi_window,
            log_media_open_event,
            close_current_window,
            reveal_current_window,
            open_files_in_window,
            terminal::terminal_open,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
            take_startup_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running LMP");
}

#[cfg(windows)]
fn stabilize_installer_launch_environment() {
    let local_app_data = env::var("LOCALAPPDATA").unwrap_or_default();
    if !local_app_data
        .to_ascii_lowercase()
        .contains(r"\windows\system32\config\systemprofile\")
    {
        return;
    }

    let fallback = env::temp_dir().join("LMP").join("LocalAppData");
    if fs::create_dir_all(&fallback).is_ok() {
        env::set_var("LOCALAPPDATA", &fallback);
        env::set_var(
            "WEBVIEW2_USER_DATA_FOLDER",
            fallback.join("com.heyluftt.lmp").join("EBWebView"),
        );
    }
}

#[cfg(not(windows))]
fn stabilize_installer_launch_environment() {}

#[tauri::command]
fn set_window_media_kind(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    kind: String,
    path: Option<String>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let requested_kind = normalize_media_kind(&kind);
    let clean_kind = path
        .as_deref()
        .map(Path::new)
        .map(|path| {
            if requested_kind == "text"
                && matches!(
                    media_extension(path).as_str(),
                    "doc" | "docx" | "docm" | "dotx" | "dotm"
                )
            {
                "text"
            } else {
                media_kind_label(path)
            }
        })
        .filter(|path_kind| *path_kind != "unknown")
        .unwrap_or(requested_kind);
    if let Some(path) = path.filter(|path| !path.trim().is_empty()) {
        if let Ok(mut files) = state.window_media_files.lock() {
            files.insert(label.clone(), vec![path]);
        };
    }
    let has_assigned_files = window_has_assigned_files(state.inner(), &label);
    let mut kinds = state
        .window_media_kinds
        .lock()
        .map_err(|_| "Could not update window media kind.".to_string())?;
    if clean_kind == "unknown" {
        if !has_assigned_files {
            kinds.remove(&label);
        }
    } else {
        kinds.insert(label, clean_kind.to_string());
    }
    Ok(())
}

#[tauri::command]
fn set_audio_multi_window(state: tauri::State<'_, AppState>, enabled: bool) -> Result<(), String> {
    let mut value = state
        .audio_multi_window
        .lock()
        .map_err(|_| "Could not update audio window setting.".to_string())?;
    *value = enabled;
    Ok(())
}

#[tauri::command]
fn log_media_open_event(
    current_label: String,
    target_label: String,
    accepted: bool,
    files: Vec<String>,
) -> Result<(), String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    let incoming = files
        .iter()
        .map(|path| {
            let kind = media_kind_label(Path::new(path));
            format!("{path} [{kind}]")
        })
        .collect::<Vec<_>>()
        .join(", ");
    append_routing_log(&format!(
        "{timestamp} frontend-event current={current_label} target={target_label} accepted={accepted} incoming=\"{incoming}\"\n",
    ));
    Ok(())
}

#[tauri::command]
fn close_current_window(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    log_instance_event(
        "window-close-request",
        "primary",
        &format!("windowLabel={} shouldExit=false", window.label()),
        &[],
    );
    save_window_state(&window);
    cleanup_window_registry(state.inner(), window.label());
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(20));
        let _ = window.destroy();
    });
    Ok(())
}

fn defer_single_instance_files(app: &tauri::AppHandle, state: AppState, files: Vec<String>) {
    let app_handle = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(25));
        let scheduler = app_handle.clone();
        let route_app = app_handle;
        let _ = scheduler.run_on_main_thread(move || {
            log_instance_event(
                "single-instance-dispatch",
                "primary",
                "kind=files shouldExit=false",
                &files,
            );
            let _ = route_single_instance_files(&route_app, &state, files);
        });
    });
}

fn defer_single_instance_reveal(app: &tauri::AppHandle) {
    let app_handle = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(25));
        let scheduler = app_handle.clone();
        let reveal_app = app_handle;
        let _ = scheduler.run_on_main_thread(move || {
            if let Some(window) = reveal_app.get_webview_window("main") {
                log_instance_event(
                    "single-instance-dispatch",
                    "primary",
                    &format!("kind=reveal windowLabel={} shouldExit=false", window.label()),
                    &[],
                );
                if window.is_minimized().unwrap_or(false) {
                    let _ = window.unminimize();
                }
                let _ = window.show();
                let _ = window.set_focus();
            }
        });
    });
}

fn route_single_instance_files(
    app: &tauri::AppHandle,
    state: &AppState,
    files: Vec<String>,
) -> Result<(), String> {
    if let Some(label) = target_window_label_for_files(state, &files) {
        if let Some(window) = app.get_webview_window(&label) {
            log_routing_decision(state, &files, "replace-audio-or-use-empty", Some(&label));
            reveal_and_emit_files(state, &window, files);
            return Ok(());
        }
    }

    log_routing_decision(state, &files, "new-window", None);
    open_files_in_new_window(app, state, files)
}

fn target_window_label_for_files(state: &AppState, files: &[String]) -> Option<String> {
    let incoming_kinds: Vec<&'static str> = files
        .iter()
        .map(Path::new)
        .map(media_kind_label)
        .filter(|kind| *kind != "unknown")
        .collect();
    if incoming_kinds.is_empty() {
        return empty_main_target(state);
    }

    let incoming_audio_only = incoming_kinds.iter().all(|kind| *kind == "audio");
    let incoming_kind = if incoming_audio_only {
        "audio"
    } else {
        "non-audio"
    };
    let kinds = state
        .window_media_kinds
        .lock()
        .ok()
        .map(|value| value.clone())
        .unwrap_or_default();
    if incoming_kind == "audio" {
        let audio_multi_window = state
            .audio_multi_window
            .lock()
            .map(|value| *value)
            .unwrap_or(false);
        if !audio_multi_window {
            if let Some((label, _)) = kinds.iter().find(|(_, kind)| kind.as_str() == "audio") {
                return Some(label.clone());
            }
        }

        return empty_main_target(state);
    }

    empty_main_target(state)
}

fn reveal_and_emit_files(state: &AppState, window: &tauri::WebviewWindow, files: Vec<String>) {
    let target_label = window.label().to_string();
    record_window_files(state, &target_label, &files);
    if let Ok(mut pending) = state.window_files.lock() {
        pending.insert(target_label.clone(), files.clone());
    }
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.emit(
        "media-open-request",
        MediaOpenRequest {
            target_label,
            files,
        },
    );
}

fn normalize_media_kind(kind: &str) -> &'static str {
    match kind {
        "audio" => "audio",
        "video" => "video",
        "image" => "image",
        "document" => "document",
        "text" => "text",
        _ => "unknown",
    }
}

fn record_window_files(state: &AppState, label: &str, files: &[String]) {
    if files.is_empty() {
        return;
    }

    if let Ok(mut paths) = state.window_media_files.lock() {
        paths.insert(label.to_string(), files.to_vec());
    }

    if let Some(kind) = files
        .first()
        .map(Path::new)
        .map(media_kind_label)
        .filter(|kind| *kind != "unknown")
    {
        if let Ok(mut kinds) = state.window_media_kinds.lock() {
            kinds.insert(label.to_string(), kind.to_string());
        };
    }
}

fn cleanup_window_registry(state: &AppState, label: &str) {
    if let Ok(mut kinds) = state.window_media_kinds.lock() {
        kinds.remove(label);
    }
    if let Ok(mut files) = state.window_media_files.lock() {
        files.remove(label);
    }
    if let Ok(mut files) = state.window_files.lock() {
        files.remove(label);
    }
}

fn watch_window_registry_cleanup(window: &tauri::WebviewWindow, state: &AppState) {
    let label = window.label().to_string();
    let state = state.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            cleanup_window_registry(&state, &label);
            log_instance_event(
                "window-destroy-cleanup",
                "primary",
                &format!("windowLabel={label} shouldExit=false"),
                &[],
            );
        }
    });
}

fn window_has_assigned_files(state: &AppState, label: &str) -> bool {
    let has_active_files = state
        .window_media_files
        .lock()
        .ok()
        .and_then(|files| files.get(label).cloned())
        .map(|files| !files.is_empty())
        .unwrap_or(false);
    if has_active_files {
        return true;
    }

    let has_pending_window_files = state
        .window_files
        .lock()
        .ok()
        .and_then(|files| files.get(label).cloned())
        .map(|files| !files.is_empty())
        .unwrap_or(false);
    if has_pending_window_files {
        return true;
    }

    label == "main"
        && state
            .pending_files
            .lock()
            .map(|files| !files.is_empty())
            .unwrap_or(false)
}

fn empty_main_target(state: &AppState) -> Option<String> {
    let main_has_kind = state
        .window_media_kinds
        .lock()
        .map(|kinds| kinds.contains_key("main"))
        .unwrap_or(false);

    if !main_has_kind && !window_has_assigned_files(state, "main") {
        Some("main".to_string())
    } else {
        None
    }
}

fn log_routing_decision(
    state: &AppState,
    files: &[String],
    action: &str,
    target_label: Option<&str>,
) {
    let audio_multi_window = state
        .audio_multi_window
        .lock()
        .map(|value| *value)
        .unwrap_or(false);
    let known_kinds = state
        .window_media_kinds
        .lock()
        .map(|kinds| kinds.clone())
        .unwrap_or_default();
    let known_files = state
        .window_media_files
        .lock()
        .map(|paths| paths.clone())
        .unwrap_or_default();
    let incoming = files
        .iter()
        .map(|path| {
            let kind = media_kind_label(Path::new(path));
            format!("{path} [{kind}]")
        })
        .collect::<Vec<_>>()
        .join(", ");
    let windows = known_kinds
        .iter()
        .map(|(label, kind)| {
            let path = known_files
                .get(label)
                .and_then(|paths| paths.first())
                .map(String::as_str)
                .unwrap_or("-");
            format!("{label}:{kind}:{path}")
        })
        .collect::<Vec<_>>()
        .join(" | ");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    let line = format!(
        "{timestamp} action={action} target={} audioMulti={} incoming=\"{}\" windows=\"{}\"\n",
        target_label.unwrap_or("-"),
        audio_multi_window,
        incoming,
        windows
    );

    append_routing_log(&line);
}

fn append_routing_log(line: &str) {
    if let Ok(log_dir) = lmp_data_dir().map(|dir| dir.join("logs")) {
        let _ = fs::create_dir_all(&log_dir);
        if let Ok(mut file) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("routing.log"))
        {
            use std::io::Write;
            let _ = file.write_all(line.as_bytes());
        }
    }
}

fn log_instance_event(phase: &str, role: &str, detail: &str, files: &[String]) {
    let args = env::args().collect::<Vec<_>>();
    log_instance_event_with_args(phase, role, detail, &args, files);
}

fn log_instance_event_with_args(
    phase: &str,
    role: &str,
    detail: &str,
    args: &[String],
    files: &[String],
) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    let pid = std::process::id();
    let parent = parent_process_id()
        .map(|value| value.to_string())
        .unwrap_or_else(|| "-".to_string());
    let args = format_log_list(args);
    let files = format_log_list(files);
    let command_line = compact_log_value(&process_command_line());
    append_routing_log(&format!(
        "{timestamp} phase={phase} pid={pid} ppid={parent} role={role} commandLine=\"{command_line}\" args=\"{args}\" startupFiles=\"{files}\" {detail}\n",
    ));
}

fn format_log_list(items: &[String]) -> String {
    if items.is_empty() {
        "-".to_string()
    } else {
        compact_log_value(&items.join(" || "))
    }
}

fn compact_log_value(value: &str) -> String {
    value
        .replace('\r', " ")
        .replace('\n', " ")
        .replace('"', "'")
}

#[cfg(windows)]
struct WindowsLaunchGuard(HANDLE);

#[cfg(windows)]
impl Drop for WindowsLaunchGuard {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn forward_to_existing_instance_or_acquire_startup_guard(
    args: &[String],
    startup_files: &[String],
) -> Option<WindowsLaunchGuard> {
    if let Some(hwnd) = find_single_instance_window() {
        forward_to_single_instance_and_exit(hwnd, args, startup_files, "window-present", 0);
    }

    if single_instance_mutex_exists() {
        wait_for_single_instance_window_and_exit(args, startup_files, "plugin-mutex-present");
    }

    let guard_name = encode_wide(STARTUP_GUARD_MUTEX_NAME);
    let guard = unsafe { CreateMutexW(std::ptr::null(), true.into(), guard_name.as_ptr()) };
    if guard.is_null() {
        log_instance_event_with_args(
            "startup-guard-unavailable",
            "primary-candidate",
            "shouldExit=false",
            args,
            startup_files,
        );
        return None;
    }

    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        wait_for_single_instance_window_and_exit(args, startup_files, "startup-guard-present");
    }

    log_instance_event_with_args(
        "startup-guard-acquired",
        "primary",
        "shouldExit=false",
        args,
        startup_files,
    );
    Some(WindowsLaunchGuard(guard))
}

#[cfg(not(windows))]
fn forward_to_existing_instance_or_acquire_startup_guard(
    _args: &[String],
    _startup_files: &[String],
) -> Option<()> {
    None
}

#[cfg(windows)]
fn wait_for_single_instance_window_and_exit(
    args: &[String],
    startup_files: &[String],
    reason: &str,
) -> ! {
    for attempt in 1..=SECONDARY_FORWARD_WAIT_ATTEMPTS {
        if let Some(hwnd) = find_single_instance_window() {
            forward_to_single_instance_and_exit(hwnd, args, startup_files, reason, attempt);
        }
        thread::sleep(Duration::from_millis(SECONDARY_FORWARD_WAIT_MS));
    }

    log_instance_event_with_args(
        "secondary-exit-no-target",
        "secondary",
        &format!("reason={reason} shouldExit=true"),
        args,
        startup_files,
    );
    std::process::exit(0);
}

#[cfg(windows)]
fn forward_to_single_instance_and_exit(
    hwnd: HWND,
    args: &[String],
    startup_files: &[String],
    reason: &str,
    attempt: usize,
) -> ! {
    let delivered = send_single_instance_args(hwnd, args);
    log_instance_event_with_args(
        "secondary-forward-exit",
        "secondary",
        &format!("reason={reason} attempt={attempt} delivered={delivered} shouldExit=true"),
        args,
        startup_files,
    );
    std::process::exit(0);
}

#[cfg(windows)]
fn find_single_instance_window() -> Option<HWND> {
    let class_name = encode_wide(SINGLE_INSTANCE_CLASS_NAME);
    let window_name = encode_wide(SINGLE_INSTANCE_WINDOW_NAME);
    let hwnd = unsafe { FindWindowW(class_name.as_ptr(), window_name.as_ptr()) };
    if hwnd.is_null() {
        None
    } else {
        Some(hwnd)
    }
}

#[cfg(windows)]
fn single_instance_mutex_exists() -> bool {
    let mutex_name = encode_wide(SINGLE_INSTANCE_MUTEX_NAME);
    let handle = unsafe { OpenMutexW(MUTEX_ALL_ACCESS, false.into(), mutex_name.as_ptr()) };
    if handle.is_null() {
        false
    } else {
        unsafe {
            CloseHandle(handle);
        }
        true
    }
}

#[cfg(windows)]
fn send_single_instance_args(hwnd: HWND, args: &[String]) -> bool {
    let cwd = env::current_dir().unwrap_or_default();
    let cwd = cwd.to_string_lossy();
    let data = format!("{cwd}|{}\0", args.join("|"));
    let bytes = data.as_bytes();
    let cds = COPYDATASTRUCT {
        dwData: WMCOPYDATA_SINGLE_INSTANCE_DATA,
        cbData: bytes.len() as _,
        lpData: bytes.as_ptr() as _,
    };
    unsafe { SendMessageW(hwnd, WM_COPYDATA, 0, &cds as *const _ as _) != 0 }
}

#[cfg(windows)]
fn encode_wide(string: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    std::os::windows::prelude::OsStrExt::encode_wide(string.as_ref())
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(windows)]
fn parent_process_id() -> Option<u32> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return None;
    }

    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let current_pid = std::process::id();
    let mut parent = None;

    let mut has_entry = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while has_entry {
        if entry.th32ProcessID == current_pid {
            parent = Some(entry.th32ParentProcessID);
            break;
        }
        has_entry = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }

    unsafe {
        CloseHandle(snapshot);
    }
    parent
}

#[cfg(not(windows))]
fn parent_process_id() -> Option<u32> {
    None
}

#[cfg(windows)]
fn process_command_line() -> String {
    unsafe {
        let ptr = GetCommandLineW();
        if ptr.is_null() {
            return env::args().collect::<Vec<_>>().join(" ");
        }
        let mut len = 0usize;
        while *ptr.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
    }
}

#[cfg(not(windows))]
fn process_command_line() -> String {
    env::args().collect::<Vec<_>>().join(" ")
}

#[tauri::command]
fn open_files_in_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    files: Vec<String>,
) -> Result<(), String> {
    let supported_files = media_args(files);
    if supported_files.is_empty() {
        return Ok(());
    }

    route_single_instance_files(&app, state.inner(), supported_files)
}

fn open_files_in_new_window(
    app: &tauri::AppHandle,
    state: &AppState,
    files: Vec<String>,
) -> Result<(), String> {
    let profile = window_profile_for_files(&files);
    let title = window_title_for_files(&files);
    let counter = {
        let mut counter = state
            .window_counter
            .lock()
            .map_err(|_| "Could not allocate media window.".to_string())?;
        *counter += 1;
        *counter
    };
    let label = format!("media-{counter}");
    log_instance_event(
        "window-create",
        "primary",
        &format!("windowLabel={label} shouldExit=false"),
        &files,
    );

    {
        let mut pending_windows = state
            .window_files
            .lock()
            .map_err(|_| "Could not queue files for media window.".to_string())?;
        pending_windows.insert(label.clone(), files.clone());
    }
    record_window_files(state, &label, &files);

    let window = tauri::WebviewWindowBuilder::new(
        app,
        label.clone(),
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title(title)
    .inner_size(profile.preferred_width, profile.preferred_height)
    .min_inner_size(profile.min_width, profile.min_height)
    .resizable(true)
    .decorations(false)
    .visible(false)
    .center()
    .build()
    .map_err(|error| {
        if let Ok(mut pending_windows) = state.window_files.lock() {
            pending_windows.remove(&label);
        }
        if let Ok(mut kinds) = state.window_media_kinds.lock() {
            kinds.remove(&label);
        }
        if let Ok(mut files) = state.window_media_files.lock() {
            files.remove(&label);
        }
        format!("Could not open media window: {error}")
    })?;
    watch_window_state(&window);
    watch_window_registry_cleanup(&window, state);

    let reveal_window = window.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(900));
        if reveal_window.is_visible().unwrap_or(false) {
            return;
        }
        let _ = reveal_window.show();
        let _ = reveal_window.set_focus();
    });

    Ok(())
}

fn window_title_for_files(files: &[String]) -> String {
    files
        .first()
        .and_then(|path| Path::new(path).file_name())
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("LMP")
        .to_string()
}

struct WindowProfile {
    preferred_width: f64,
    preferred_height: f64,
    min_width: f64,
    min_height: f64,
}

fn window_profile_for_files(files: &[String]) -> WindowProfile {
    let kind = files
        .first()
        .map(Path::new)
        .map(media_kind_label)
        .unwrap_or("unknown");

    match kind {
        "audio" => WindowProfile {
            preferred_width: 540.0,
            preferred_height: 330.0,
            min_width: 360.0,
            min_height: 240.0,
        },
        "image" | "text" => WindowProfile {
            preferred_width: 1100.0,
            preferred_height: 700.0,
            min_width: 720.0,
            min_height: 460.0,
        },
        "document" | "video" => WindowProfile {
            preferred_width: 1200.0,
            preferred_height: 760.0,
            min_width: 820.0,
            min_height: 560.0,
        },
        _ => WindowProfile {
            preferred_width: 1200.0,
            preferred_height: 760.0,
            min_width: 430.0,
            min_height: 310.0,
        },
    }
}

#[tauri::command]
fn get_engine_status() -> EngineStatus {
    let gstreamer = detect_gstreamer();
    let fallback_hint = if gstreamer.available {
        "GStreamer fallback tools are detected and ready for the next playback path.".to_string()
    } else {
        "GStreamer fallback is not configured yet; native WebView playback stays primary."
            .to_string()
    };

    EngineStatus {
        available: true,
        name: "Native WebView media engine".to_string(),
        hint: Some(format!(
            "Uses the OS/WebView media stack; no mpv binary is bundled. {fallback_hint}"
        )),
    }
}

#[tauri::command]
fn get_playback_backends() -> Vec<PlaybackBackendStatus> {
    vec![
        detect_native_backend(),
        detect_gstreamer(),
        detect_ffmpeg_helper(),
    ]
}

#[tauri::command]
async fn probe_media_with_gstreamer(path: String) -> Result<GstreamerProbe, String> {
    tauri::async_runtime::spawn_blocking(move || probe_media_with_gstreamer_sync(path))
        .await
        .map_err(|error| format!("Could not run GStreamer probe: {error}"))?
}

#[tauri::command]
async fn inspect_media(path: String) -> Result<MediaInspection, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_media_sync(path))
        .await
        .map_err(|error| format!("Could not inspect media: {error}"))?
}

#[tauri::command]
async fn extract_audio_artwork(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || extract_audio_artwork_sync(path))
        .await
        .map_err(|error| format!("Could not extract audio artwork: {error}"))?
}

#[tauri::command]
async fn get_media_thumbnail(path: String) -> Result<MediaThumbnail, String> {
    tauri::async_runtime::spawn_blocking(move || get_media_thumbnail_sync(path))
        .await
        .map_err(|error| format!("Could not generate thumbnail: {error}"))?
}

async fn run_blocking_command<T, F>(context: &'static str, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("{context}: {error}"))?
}

#[tauri::command]
fn get_thumbnail_cache_status() -> Result<ThumbnailCacheStatus, String> {
    thumbnail_cache_status()
}

#[tauri::command]
fn clear_thumbnail_cache() -> Result<ThumbnailCacheStatus, String> {
    let cache_dir = thumbnail_cache_dir()?;
    clear_cache_directory(&cache_dir)?;
    thumbnail_cache_status()
}

#[tauri::command]
fn get_settings_cache_status() -> Result<SettingsCacheStatus, String> {
    settings_cache_status()
}

#[tauri::command]
fn clear_preview_cache() -> Result<SettingsCacheStatus, String> {
    clear_cache_directories(&[thumbnail_cache_dir()?, artwork_cache_dir()?])?;
    settings_cache_status()
}

#[tauri::command]
fn clear_prepared_video_cache() -> Result<SettingsCacheStatus, String> {
    let cache_dir = transmux_cache_dir()?;
    clear_cache_directory(&cache_dir)?;
    settings_cache_status()
}

#[tauri::command]
fn clear_media_probe_cache() -> Result<SettingsCacheStatus, String> {
    let cache_dir = probe_cache_dir()?;
    clear_cache_directory(&cache_dir)?;
    settings_cache_status()
}

#[tauri::command]
fn open_file_dialog() -> Result<Option<String>, String> {
    let file = rfd::FileDialog::new()
        .add_filter("Media", SUPPORTED_MEDIA_EXTENSIONS)
        .pick_file();

    Ok(file
        .filter(|path| is_supported_media_path(path))
        .map(|path| path.display().to_string()))
}

#[tauri::command]
fn open_files_dialog() -> Result<Vec<String>, String> {
    let files = rfd::FileDialog::new()
        .add_filter("Media", SUPPORTED_MEDIA_EXTENSIONS)
        .pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter(|path| is_supported_media_path(path))
        .map(|path| path.display().to_string())
        .collect();

    Ok(files)
}

#[tauri::command]
fn open_media_folder_dialog() -> Result<Option<String>, String> {
    Ok(rfd::FileDialog::new()
        .pick_folder()
        .filter(|path| path.is_dir())
        .map(|path| path.display().to_string()))
}

#[tauri::command]
fn open_subtitle_dialog(media_path: Option<String>) -> Result<Option<SubtitleFile>, String> {
    let mut dialog = rfd::FileDialog::new().add_filter("Subtitles", &["srt", "vtt"]);

    if let Some(path) = media_path {
        if let Some(parent) = Path::new(&path).parent() {
            dialog = dialog.set_directory(parent);
        }
    }

    dialog
        .pick_file()
        .map(|path| read_subtitle_file(&path))
        .transpose()
}

#[tauri::command]
async fn browse_media_folder(
    folder_path: Option<String>,
    media_path: Option<String>,
) -> Result<MediaFolder, String> {
    run_blocking_command("Could not finish folder scan", move || {
        browse_media_folder_sync(folder_path, media_path)
    })
    .await
}

fn browse_media_folder_sync(
    folder_path: Option<String>,
    media_path: Option<String>,
) -> Result<MediaFolder, String> {
    let folder = if let Some(path) = folder_path.filter(|value| !value.trim().is_empty()) {
        PathBuf::from(path)
    } else if let Some(path) = media_path.filter(|value| !value.trim().is_empty()) {
        let media = PathBuf::from(path);
        media
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "Could not locate media folder.".to_string())?
    } else {
        env::current_dir().map_err(|error| format!("Could not open current folder: {error}"))?
    };

    if !folder.exists() || !folder.is_dir() {
        return Err(format!("Folder does not exist: {}", folder.display()));
    }

    let mut items = fs::read_dir(&folder)
        .map_err(|error| format!("Could not read folder: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| media_folder_item(entry.path()))
        .collect::<Vec<_>>();

    items.sort_by(|left, right| {
        let left_folder = left.kind == "folder";
        let right_folder = right.kind == "folder";
        right_folder.cmp(&left_folder).then_with(|| {
            left.display_name
                .to_lowercase()
                .cmp(&right.display_name.to_lowercase())
        })
    });

    Ok(MediaFolder {
        path: folder.display().to_string(),
        parent: folder.parent().map(|path| path.display().to_string()),
        items,
    })
}

#[tauri::command]
async fn find_sidecar_subtitle(media_path: String) -> Result<Option<SubtitleFile>, String> {
    run_blocking_command("Could not finish subtitle sidecar scan", move || {
        find_sidecar_subtitle_sync(media_path)
    })
    .await
}

fn find_sidecar_subtitle_sync(media_path: String) -> Result<Option<SubtitleFile>, String> {
    let media = PathBuf::from(media_path);
    if !media.exists() || !media.is_file() {
        return Ok(None);
    }

    let Some(parent) = media.parent() else {
        return Ok(None);
    };
    let Some(stem) = media.file_stem().and_then(|value| value.to_str()) else {
        return Ok(None);
    };

    for extension in ["srt", "vtt"] {
        let exact = parent.join(format!("{stem}.{extension}"));
        if exact.exists() && exact.is_file() {
            return read_subtitle_file(&exact).map(Some);
        }
    }

    let mut fuzzy_matches = fs::read_dir(parent)
        .map_err(|error| format!("Could not scan subtitle sidecars: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_subtitle_path(path))
        .filter(|path| {
            path.file_stem()
                .and_then(|value| value.to_str())
                .map(|candidate| {
                    candidate.starts_with(&format!("{stem}."))
                        || candidate.starts_with(&format!("{stem} "))
                        || candidate.starts_with(&format!("{stem}-"))
                })
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();

    fuzzy_matches.sort_by_key(|path| path.display().to_string().to_lowercase());

    fuzzy_matches
        .first()
        .map(|path| read_subtitle_file(path))
        .transpose()
}

#[tauri::command]
async fn list_sibling_media(media_path: String) -> Result<Vec<String>, String> {
    run_blocking_command("Could not finish sibling media scan", move || {
        list_sibling_media_sync(media_path)
    })
    .await
}

fn list_sibling_media_sync(media_path: String) -> Result<Vec<String>, String> {
    let media = PathBuf::from(media_path);
    if !media.exists() || !media.is_file() || !is_supported_media_path(&media) {
        return Ok(Vec::new());
    }

    let Some(parent) = media.parent() else {
        return Ok(vec![media.display().to_string()]);
    };

    let mut files = fs::read_dir(parent)
        .map_err(|error| format!("Could not scan folder: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_supported_media_path(path))
        .collect::<Vec<_>>();

    files.sort_by(|left, right| {
        let left_name = left
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_lowercase();
        let right_name = right
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_lowercase();
        left_name.cmp(&right_name)
    });

    Ok(files
        .into_iter()
        .map(|path| path.display().to_string())
        .collect())
}

#[tauri::command]
fn take_startup_files(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let label = window.label().to_string();
    if label != "main" {
        let mut pending_windows = state
            .window_files
            .lock()
            .map_err(|_| "Could not read window startup files.".to_string())?;
        if let Some(files) = pending_windows.remove(&label) {
            record_window_files(state.inner(), &label, &files);
            log_instance_event(
                "take-startup-files",
                "primary",
                &format!("windowLabel={label} source=window_files shouldExit=false"),
                &files,
            );
            return Ok(files);
        }
        log_instance_event(
            "take-startup-files",
            "primary",
            &format!("windowLabel={label} source=window_files-empty shouldExit=false"),
            &[],
        );
        return Ok(Vec::new());
    }

    let mut pending = state
        .pending_files
        .lock()
        .map_err(|_| "Could not read startup files.".to_string())?;
    let files: Vec<String> = pending.drain(..).collect();
    if let Some(kind) = files
        .first()
        .map(Path::new)
        .map(media_kind_label)
        .filter(|kind| *kind != "unknown")
    {
        if let Ok(mut kinds) = state.window_media_kinds.lock() {
            kinds.insert(label.clone(), kind.to_string());
        }
    }
    if !files.is_empty() {
        if let Ok(mut active_files) = state.window_media_files.lock() {
            active_files.insert(label, files.clone());
        }
    }
    log_instance_event(
        "take-startup-files",
        "primary",
        "windowLabel=main source=pending_files shouldExit=false",
        &files,
    );
    Ok(files)
}

#[tauri::command]
fn reveal_current_window(window: tauri::WebviewWindow) -> Result<(), String> {
    log_instance_event(
        "window-reveal",
        "primary",
        &format!("windowLabel={} shouldExit=false", window.label()),
        &[],
    );
    if window.is_minimized().unwrap_or(false) {
        window
            .unminimize()
            .map_err(|error| format!("Could not unminimize window: {error}"))?;
    }
    window
        .show()
        .map_err(|error| format!("Could not show window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("Could not focus window: {error}"))?;
    Ok(())
}

#[tauri::command]
fn prepare_media(path: String) -> Result<MediaFile, String> {
    media_file_from_path(PathBuf::from(path))
}

#[tauri::command]
async fn transmux_for_native(path: String) -> Result<MediaFile, String> {
    tauri::async_runtime::spawn_blocking(move || transmux_for_native_sync(path))
        .await
        .map_err(|error| format!("Could not run remux fallback: {error}"))?
}

#[tauri::command]
fn choose_clip_output_path(
    input_path: String,
    start_seconds: f64,
    end_seconds: f64,
) -> Result<Option<String>, String> {
    validate_clip_range(start_seconds, end_seconds)?;
    let input = PathBuf::from(input_path);
    validate_clip_input(&input)?;

    let mut dialog = rfd::FileDialog::new()
        .add_filter("MP4 video", &["mp4"])
        .set_file_name(suggest_clip_file_name(&input, start_seconds, end_seconds));

    if let Some(parent) = input.parent() {
        dialog = dialog.set_directory(parent);
    }

    Ok(dialog.save_file().map(|mut path| {
        if path.extension().is_none() {
            path.set_extension("mp4");
        }
        path.display().to_string()
    }))
}

#[tauri::command]
async fn export_video_clip(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    job_id: String,
    input_path: String,
    output_path: String,
    start_seconds: f64,
    end_seconds: f64,
    preset: String,
) -> Result<MediaFile, String> {
    let cancellations = state.clip_export_cancellations.clone();
    tauri::async_runtime::spawn_blocking(move || {
        export_video_clip_sync(
            window,
            cancellations,
            job_id,
            input_path,
            output_path,
            start_seconds,
            end_seconds,
            preset,
        )
    })
    .await
    .map_err(|error| format!("Could not export clip: {error}"))?
}

#[tauri::command]
fn cancel_clip_export(state: tauri::State<'_, AppState>, job_id: String) -> Result<(), String> {
    if job_id.trim().is_empty() {
        return Err("Missing clip export job id.".to_string());
    }
    let mut cancellations = state
        .clip_export_cancellations
        .lock()
        .map_err(|_| "Could not lock clip export state.".to_string())?;
    cancellations.insert(job_id);
    Ok(())
}

#[tauri::command]
fn show_path_in_explorer(path: String) -> Result<(), String> {
    let file = PathBuf::from(path);
    if !file.exists() {
        return Err(format!("File does not exist: {}", file.display()));
    }

    #[cfg(windows)]
    {
        let mut command = Command::new("explorer.exe");
        command.arg(format!("/select,{}", file.display()));
        command.creation_flags(CREATE_NO_WINDOW);
        command
            .spawn()
            .map_err(|error| format!("Could not open Explorer: {error}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(&file)
            .spawn()
            .map_err(|error| format!("Could not reveal file: {error}"))?;
        return Ok(());
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        let folder = file.parent().unwrap_or_else(|| Path::new("."));
        Command::new("xdg-open")
            .arg(folder)
            .spawn()
            .map_err(|error| format!("Could not open file folder: {error}"))?;
        Ok(())
    }
}

#[tauri::command]
fn open_with_gstreamer(path: String) -> Result<(), String> {
    let media = validated_gstreamer_media(&path)?;
    let _ = spawn_gstreamer_child(&media)?;

    Ok(())
}

#[tauri::command]
fn start_gstreamer_playback(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<GstreamerPlaybackSession, String> {
    let media = validated_gstreamer_media(&path)?;
    let child = spawn_gstreamer_child(&media)?;
    let pid = child.id();
    let started_at = unix_now_seconds();

    let mut session = state
        .gstreamer_session
        .lock()
        .map_err(|_| "Could not update GStreamer session.".to_string())?;

    *session = Some(GstreamerPlaybackState {
        path: media.display().to_string(),
        pid,
        started_at,
        child,
    });

    Ok(gstreamer_session_snapshot(&mut session))
}

#[tauri::command]
fn stop_gstreamer_playback(
    state: tauri::State<'_, AppState>,
) -> Result<GstreamerPlaybackSession, String> {
    let mut session = state
        .gstreamer_session
        .lock()
        .map_err(|_| "Could not stop GStreamer session.".to_string())?;

    *session = None;
    Ok(empty_gstreamer_session())
}

#[tauri::command]
fn get_gstreamer_playback_session(
    state: tauri::State<'_, AppState>,
) -> Result<GstreamerPlaybackSession, String> {
    let mut session = state
        .gstreamer_session
        .lock()
        .map_err(|_| "Could not read GStreamer session.".to_string())?;

    Ok(gstreamer_session_snapshot(&mut session))
}

#[tauri::command]
fn print_file(path: String) -> Result<(), String> {
    let file = PathBuf::from(path);
    if !file.exists() || !file.is_file() {
        return Err(format!("File does not exist: {}", file.display()));
    }
    if media_kind_label(&file) != "document" {
        return Err("Printing is currently available for document files.".to_string());
    }

    #[cfg(windows)]
    {
        let mut command = Command::new("powershell.exe");
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "$ErrorActionPreference = 'Stop'; $process = Start-Process -FilePath $args[0] -Verb Print -PassThru; if ($null -eq $process) { throw 'The Windows print handler did not start.' }",
            ])
            .arg(file.to_string_lossy().to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);

        let output = command
            .output()
            .map_err(|error| format!("Could not start the system print handler: {error}"))?;
        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let details = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "The default PDF app did not accept Windows' Print action.".to_string()
        };
        return Err(format!("Could not print through Windows: {details}"));
    }

    #[cfg(not(windows))]
    {
        let printer = find_tool("lp").ok_or_else(|| {
            "No system print helper was found. Install lp/CUPS first.".to_string()
        })?;
        let status = Command::new(printer)
            .arg(&file)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("Could not send document to printer: {error}"))?;
        if status.success() {
            Ok(())
        } else {
            Err("The system print helper could not print this document.".to_string())
        }
    }
}

#[tauri::command]
async fn read_word_document(path: String) -> Result<WordDocumentContent, String> {
    run_blocking_command("Could not finish reading Word document", move || {
        read_word_document_sync(path)
    })
    .await
}

fn read_word_document_sync(path: String) -> Result<WordDocumentContent, String> {
    let file = PathBuf::from(path);
    if !file.exists() || !file.is_file() {
        return Err(format!("File does not exist: {}", file.display()));
    }
    if media_kind_label(&file) != "document" {
        return Err("This file is not registered as a document file.".to_string());
    }
    if !matches!(
        media_extension(&file).as_str(),
        "doc" | "docx" | "docm" | "dotx" | "dotm"
    ) {
        return Err("Only Word documents are supported in this preview.".to_string());
    }

    read_word_document_file(&file)
}

#[tauri::command]
async fn read_text_file(path: String) -> Result<TextFileContent, String> {
    run_blocking_command("Could not finish reading text file", move || {
        read_text_file_sync(path)
    })
    .await
}

fn read_text_file_sync(path: String) -> Result<TextFileContent, String> {
    let file = PathBuf::from(path);
    if !file.exists() || !file.is_file() {
        return Err(format!("File does not exist: {}", file.display()));
    }
    if media_kind_label(&file) != "text" {
        return Err("This file is not registered as a plain text file.".to_string());
    }

    let bytes = fs::read(&file).map_err(|error| format!("Could not read text file: {error}"))?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("Text file is larger than LMP's current 16 MB editor limit.".to_string());
    }

    let line_ending = detect_text_line_ending(&bytes);
    let encoding = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        "utf-8 bom"
    } else if std::str::from_utf8(&bytes).is_ok() {
        "utf-8"
    } else {
        "utf-8/lossy"
    };
    let content = String::from_utf8_lossy(&bytes)
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim_start_matches('\u{feff}')
        .to_string();
    let line_count = if content.is_empty() {
        0
    } else {
        content.lines().count()
    };

    Ok(TextFileContent {
        content,
        line_count,
        encoding: encoding.to_string(),
        line_ending,
    })
}

#[tauri::command]
async fn write_text_file(
    path: String,
    content: String,
    line_ending: Option<String>,
    encoding: Option<String>,
) -> Result<(), String> {
    run_blocking_command("Could not finish saving text file", move || {
        write_text_file_sync(path, content, line_ending, encoding)
    })
    .await
}

fn write_text_file_sync(
    path: String,
    content: String,
    line_ending: Option<String>,
    encoding: Option<String>,
) -> Result<(), String> {
    let file = PathBuf::from(path);
    if !file.exists() || !file.is_file() {
        return Err(format!("File does not exist: {}", file.display()));
    }
    if media_kind_label(&file) != "text" {
        return Err("This file is not registered as a plain text file.".to_string());
    }

    write_text_content(&file, &content, line_ending.as_deref(), encoding.as_deref())
}

#[tauri::command]
fn save_text_file_dialog(
    path: Option<String>,
    content: String,
    line_ending: Option<String>,
    encoding: Option<String>,
) -> Result<Option<MediaFile>, String> {
    let mut dialog = rfd::FileDialog::new().add_filter("Text", TEXT_FILE_EXTENSIONS);

    if let Some(path) = path.filter(|value| !value.trim().is_empty()) {
        let file = PathBuf::from(path);
        if let Some(parent) = file.parent() {
            dialog = dialog.set_directory(parent);
        }
        if let Some(name) = suggested_text_save_name(&file) {
            dialog = dialog.set_file_name(name);
        }
    } else {
        dialog = dialog.set_file_name("Untitled.txt");
    }

    let Some(mut file) = dialog.save_file() else {
        return Ok(None);
    };

    if file.extension().is_none() {
        file.set_extension("txt");
    }
    if media_kind_label(&file) != "text" {
        return Err("Save As needs a supported text file extension.".to_string());
    }

    write_text_content(&file, &content, line_ending.as_deref(), encoding.as_deref())?;
    media_file_from_path(file).map(Some)
}

fn suggested_text_save_name(file: &Path) -> Option<String> {
    if media_kind_label(file) == "text" {
        return file
            .file_name()
            .and_then(|value| value.to_str())
            .map(|value| value.to_string());
    }

    if matches!(
        media_extension(file).as_str(),
        "doc" | "docx" | "docm" | "dotx" | "dotm"
    ) {
        let stem = file
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("document");
        return Some(format!("{stem}.extracted.txt"));
    }

    file.file_stem()
        .and_then(|value| value.to_str())
        .map(|stem| format!("{stem}.txt"))
}

fn write_text_content(
    file: &Path,
    content: &str,
    line_ending: Option<&str>,
    encoding: Option<&str>,
) -> Result<(), String> {
    let normalized = apply_text_line_ending(content, line_ending.unwrap_or("lf"));
    let mut bytes = Vec::new();
    if encoding
        .map(|value| value.eq_ignore_ascii_case("utf-8 bom"))
        .unwrap_or(false)
    {
        bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
    }
    bytes.extend_from_slice(normalized.as_bytes());
    fs::write(file, bytes).map_err(|error| format!("Could not save text file: {error}"))
}

fn detect_text_line_ending(bytes: &[u8]) -> String {
    let mut crlf = 0usize;
    let mut lf = 0usize;
    let mut cr = 0usize;
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'\r' if bytes.get(index + 1) == Some(&b'\n') => {
                crlf += 1;
                index += 2;
            }
            b'\r' => {
                cr += 1;
                index += 1;
            }
            b'\n' => {
                lf += 1;
                index += 1;
            }
            _ => index += 1,
        }
    }

    if crlf >= lf && crlf >= cr && crlf > 0 {
        "crlf".to_string()
    } else if cr > lf && cr > 0 {
        "cr".to_string()
    } else {
        "lf".to_string()
    }
}

fn apply_text_line_ending(content: &str, line_ending: &str) -> String {
    match line_ending {
        "crlf" => content.replace('\n', "\r\n"),
        "cr" => content.replace('\n', "\r"),
        _ => content.to_string(),
    }
}

fn validated_gstreamer_media(path: &str) -> Result<PathBuf, String> {
    let media = PathBuf::from(path);
    if !media.exists() || !media.is_file() {
        return Err(format!("File does not exist: {path}"));
    }
    if !is_supported_media_path(&media) {
        return Err(format!("Unsupported file type: {}", media.display()));
    }
    if matches!(media_kind_label(&media), "image" | "document") {
        return Err("GStreamer fallback is only used for audio and video files.".to_string());
    }

    Ok(media)
}

fn spawn_gstreamer_child(media: &Path) -> Result<Child, String> {
    let player = find_tool("gst-play-1.0").ok_or_else(|| {
        "gst-play-1.0 was not found. Install GStreamer runtime tools first.".to_string()
    })?;

    let mut command = Command::new(player);
    command
        .arg("--no-interactive")
        .arg(media)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    command
        .spawn()
        .map_err(|error| format!("Could not start GStreamer playback: {error}"))
}

fn gstreamer_session_snapshot(
    session: &mut Option<GstreamerPlaybackState>,
) -> GstreamerPlaybackSession {
    let finished = match session.as_mut() {
        Some(current) => matches!(current.child.try_wait(), Ok(Some(_))),
        None => false,
    };

    if finished {
        *session = None;
    }

    match session.as_ref() {
        Some(current) => GstreamerPlaybackSession {
            active: true,
            path: Some(current.path.clone()),
            pid: Some(current.pid),
            started_at: Some(current.started_at),
        },
        None => empty_gstreamer_session(),
    }
}

fn empty_gstreamer_session() -> GstreamerPlaybackSession {
    GstreamerPlaybackSession {
        active: false,
        path: None,
        pid: None,
        started_at: None,
    }
}

fn unix_now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn export_video_clip_sync(
    window: tauri::WebviewWindow,
    cancellations: Arc<Mutex<HashSet<String>>>,
    job_id: String,
    input_path: String,
    output_path: String,
    start_seconds: f64,
    end_seconds: f64,
    preset_id: String,
) -> Result<MediaFile, String> {
    validate_clip_range(start_seconds, end_seconds)?;
    let input = PathBuf::from(input_path);
    let mut output = PathBuf::from(output_path);
    validate_clip_input(&input)?;

    if output.extension().is_none() {
        output.set_extension("mp4");
    }
    if output
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| !value.eq_ignore_ascii_case("mp4"))
        .unwrap_or(true)
    {
        return Err("Clip export currently writes MP4 files only.".to_string());
    }
    if same_file_path(&input, &output) {
        return Err("LMP will not overwrite the original video. Choose a new MP4 path.".to_string());
    }

    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create clip output folder: {error}"))?;
    }

    clear_clip_cancellation(&cancellations, &job_id);
    let preset = clip_export_preset(&preset_id);
    let duration = end_seconds - start_seconds;
    emit_clip_progress(
        &window,
        &job_id,
        0.0,
        "running",
        Some(format!("Exporting with {} preset...", preset.name)),
    );

    let safe_job_id: String = job_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(32)
        .collect();
    let temp_output = output.with_file_name(format!(
        ".{}.{}.tmp.mp4",
        output
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("clip"),
        safe_job_id
    ));
    let _ = fs::remove_file(&temp_output);

    let ffmpeg = find_tool("ffmpeg").unwrap_or_else(|| PathBuf::from(ffmpeg_command_name()));
    let has_audio = clip_input_has_audio(&input);
    let start_arg = format_ffmpeg_seconds(start_seconds);
    let duration_arg = format_ffmpeg_seconds(duration);
    let mut command = Command::new(ffmpeg);
    command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-y")
        .arg("-i")
        .arg(&input)
        .arg("-ss")
        .arg(&start_arg)
        .arg("-t")
        .arg(&duration_arg)
        .arg("-map")
        .arg("0:v:0")
        .arg("-map")
        .arg("0:a?")
        .arg("-vf")
        .arg("setpts=PTS-STARTPTS")
        .arg("-c:v")
        .arg("libx264")
        .arg("-preset")
        .arg(preset.video_preset)
        .arg("-crf")
        .arg(preset.crf)
        .arg("-pix_fmt")
        .arg("yuv420p");

    if has_audio {
        command.arg("-af").arg("asetpts=PTS-STARTPTS");
    }

    command
        .arg("-c:a")
        .arg("aac")
        .arg("-b:a")
        .arg(preset.audio_bitrate)
        .arg("-avoid_negative_ts")
        .arg("make_zero")
        .arg("-reset_timestamps")
        .arg("1")
        .arg("-movflags")
        .arg("+faststart")
        .arg("-stats_period")
        .arg("0.25")
        .arg("-progress")
        .arg("pipe:1")
        .arg("-nostats")
        .arg(&temp_output)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|error| format!("FFmpeg was not found or could not start: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read FFmpeg progress output.".to_string())?;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let mut last_progress: f64 = -1.0;

    loop {
        if is_clip_cancelled(&cancellations, &job_id) {
            emit_clip_progress(&window, &job_id, last_progress.max(0.0), "canceling", Some("Canceling export...".to_string()));
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&temp_output);
            clear_clip_cancellation(&cancellations, &job_id);
            emit_clip_progress(&window, &job_id, last_progress.max(0.0), "canceled", Some("Clip export canceled.".to_string()));
            return Err("Clip export canceled.".to_string());
        }

        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                if let Some(seconds) = parse_ffmpeg_progress_seconds(line.trim()) {
                    let progress = (seconds / duration).clamp(0.0, 0.995);
                    if progress - last_progress >= 0.015 || last_progress < 0.0 {
                        last_progress = progress;
                        emit_clip_progress(
                            &window,
                            &job_id,
                            progress,
                            "running",
                            Some(format!("Exporting clip... {}%", (progress * 100.0).round())),
                        );
                    }
                }
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = fs::remove_file(&temp_output);
                clear_clip_cancellation(&cancellations, &job_id);
                return Err(format!("Could not read FFmpeg progress: {error}"));
            }
        }
    }

    let status = child
        .wait()
        .map_err(|error| format!("Could not finish FFmpeg export: {error}"))?;
    let mut stderr = String::new();
    if let Some(mut stream) = child.stderr.take() {
        let _ = stream.read_to_string(&mut stderr);
    }
    clear_clip_cancellation(&cancellations, &job_id);

    if !status.success() {
        let _ = fs::remove_file(&temp_output);
        let message = if stderr.trim().is_empty() {
            "FFmpeg could not export this clip.".to_string()
        } else {
            compact_tool_output(&stderr, 1600)
        };
        emit_clip_progress(&window, &job_id, last_progress.max(0.0), "error", Some(message.clone()));
        return Err(message);
    }

    if output.exists() {
        fs::remove_file(&output)
            .map_err(|error| format!("Could not replace existing output file: {error}"))?;
    }
    fs::rename(&temp_output, &output)
        .map_err(|error| format!("Could not save exported clip: {error}"))?;

    emit_clip_progress(&window, &job_id, 1.0, "done", Some("Clip export complete.".to_string()));
    media_file_from_path(output)
}

fn validate_clip_input(input: &Path) -> Result<(), String> {
    if !input.exists() {
        return Err(format!("File does not exist: {}", input.display()));
    }
    if !input.is_file() {
        return Err(format!("Path is not a file: {}", input.display()));
    }
    if media_kind_label(input) != "video" {
        return Err("Create Clip is only available for video files.".to_string());
    }
    Ok(())
}

fn clip_input_has_audio(input: &Path) -> bool {
    let Some(ffprobe) = find_tool("ffprobe") else {
        return false;
    };
    let path_arg = input.display().to_string();
    command_output_text(
        &ffprobe,
        &[
            "-hide_banner",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
            path_arg.as_str(),
        ],
    )
    .map(|output| !output.trim().is_empty())
    .unwrap_or(false)
}

fn validate_clip_range(start_seconds: f64, end_seconds: f64) -> Result<(), String> {
    if !start_seconds.is_finite() || !end_seconds.is_finite() {
        return Err("Clip start and end must be valid times.".to_string());
    }
    if start_seconds < 0.0 {
        return Err("Clip start cannot be negative.".to_string());
    }
    if end_seconds <= start_seconds {
        return Err("Clip end must be after clip start.".to_string());
    }
    if end_seconds - start_seconds < 0.2 {
        return Err("Clip range is too short. Use at least 0.2 seconds.".to_string());
    }
    Ok(())
}

fn clip_export_preset(id: &str) -> ClipExportPreset {
    match id {
        "highQuality" => ClipExportPreset {
            name: "High Quality",
            video_preset: "fast",
            crf: "18",
            audio_bitrate: "192k",
        },
        "smallFile" => ClipExportPreset {
            name: "Small File",
            video_preset: "veryfast",
            crf: "24",
            audio_bitrate: "128k",
        },
        _ => ClipExportPreset {
            name: "Balanced",
            video_preset: "veryfast",
            crf: "20",
            audio_bitrate: "160k",
        },
    }
}

fn suggest_clip_file_name(input: &Path, start_seconds: f64, end_seconds: f64) -> String {
    format!(
        "{}_clip_{}_to_{}.mp4",
        safe_file_stem(input),
        format_clip_stamp(start_seconds),
        format_clip_stamp(end_seconds)
    )
}

fn format_clip_stamp(seconds: f64) -> String {
    let total = seconds.max(0.0).floor() as u64;
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let seconds = total % 60;
    format!("{hours:02}-{minutes:02}-{seconds:02}")
}

fn format_ffmpeg_seconds(seconds: f64) -> String {
    format!("{:.3}", seconds.max(0.0))
}

fn parse_ffmpeg_progress_seconds(line: &str) -> Option<f64> {
    let (key, value) = line.split_once('=')?;
    match key {
        "out_time_ms" | "out_time_us" => value.parse::<f64>().ok().map(|value| value / 1_000_000.0),
        "out_time" => parse_ffmpeg_clock(value),
        _ => None,
    }
}

fn parse_ffmpeg_clock(value: &str) -> Option<f64> {
    let mut parts = value.split(':');
    let hours = parts.next()?.parse::<f64>().ok()?;
    let minutes = parts.next()?.parse::<f64>().ok()?;
    let seconds = parts.next()?.parse::<f64>().ok()?;
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

fn same_file_path(left: &Path, right: &Path) -> bool {
    let left = fs::canonicalize(left).unwrap_or_else(|_| left.to_path_buf());
    let right = fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
    left == right
}

fn is_clip_cancelled(cancellations: &Arc<Mutex<HashSet<String>>>, job_id: &str) -> bool {
    cancellations
        .lock()
        .map(|set| set.contains(job_id))
        .unwrap_or(false)
}

fn clear_clip_cancellation(cancellations: &Arc<Mutex<HashSet<String>>>, job_id: &str) {
    if let Ok(mut set) = cancellations.lock() {
        set.remove(job_id);
    }
}

fn emit_clip_progress(
    window: &tauri::WebviewWindow,
    job_id: &str,
    progress: f64,
    status: &str,
    message: Option<String>,
) {
    let _ = window.emit(
        "clip-export-progress",
        ClipExportProgress {
            job_id: job_id.to_string(),
            progress: progress.clamp(0.0, 1.0),
            status: status.to_string(),
            message,
        },
    );
}

fn transmux_for_native_sync(path: String) -> Result<MediaFile, String> {
    let media = PathBuf::from(&path);
    if !media.exists() {
        return Err(format!("File does not exist: {path}"));
    }
    if !media.is_file() {
        return Err(format!("Path is not a file: {path}"));
    }

    let extension = media_extension(&media);
    if !matches!(extension.as_str(), "ts" | "mts" | "m2ts") {
        return Err("The native remux fallback is only enabled for TS/MTS/M2TS files.".to_string());
    }

    let metadata = media
        .metadata()
        .map_err(|error| format!("Could not read file metadata: {error}"))?;
    let cache_dir = transmux_cache_dir()?;
    fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("Could not create remux cache: {error}"))?;

    let stem = safe_file_stem(&media);
    let cache_key = media_cache_key(&media, &metadata);
    let output = cache_dir.join(format!("{stem}-{cache_key}.mp4"));
    if output.exists() && output.metadata().map(|item| item.len()).unwrap_or(0) > 0 {
        return media_file_from_path(output);
    }

    let temp_output = cache_dir.join(format!("{stem}-{cache_key}.tmp.mp4"));
    if temp_output.exists() {
        let _ = fs::remove_file(&temp_output);
    }

    let ffmpeg = find_tool("ffmpeg").unwrap_or_else(|| PathBuf::from(ffmpeg_command_name()));
    let mut command = Command::new(ffmpeg);
    command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-y")
        .arg("-fflags")
        .arg("+genpts")
        .arg("-i")
        .arg(&media)
        .arg("-map")
        .arg("0:v:0?")
        .arg("-map")
        .arg("0:a:0?")
        .arg("-c")
        .arg("copy")
        .arg("-movflags")
        .arg("+faststart")
        .arg(&temp_output);

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let result = command
        .output()
        .map_err(|error| format!("FFmpeg was not found or could not start: {error}"))?;

    if !result.status.success() {
        let _ = fs::remove_file(&temp_output);
        let details = String::from_utf8_lossy(&result.stderr).trim().to_string();
        let hint = if details.is_empty() {
            "FFmpeg could not remux this transport stream.".to_string()
        } else {
            details
        };
        return Err(hint);
    }

    fs::rename(&temp_output, &output)
        .map_err(|error| format!("Could not save remuxed media: {error}"))?;

    media_file_from_path(output)
}

fn media_file_from_path(media: PathBuf) -> Result<MediaFile, String> {
    if !media.exists() {
        return Err(format!("File does not exist: {}", media.display()));
    }
    if !media.is_file() {
        return Err(format!("Path is not a file: {}", media.display()));
    }
    if !is_supported_media_path(&media) {
        return Err(format!("Unsupported file type: {}", media.display()));
    }

    let metadata = media
        .metadata()
        .map_err(|error| format!("Could not read file metadata: {error}"))?;
    let display_name = media
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled media")
        .to_string();
    let extension = media_extension(&media);

    Ok(MediaFile {
        path: media.display().to_string(),
        display_name,
        extension,
        byte_len: metadata.len(),
    })
}

fn extract_audio_artwork_sync(path: String) -> Result<Option<String>, String> {
    let media = PathBuf::from(&path);
    if !media.exists() || !media.is_file() || media_kind_label(&media) != "audio" {
        return Ok(None);
    }

    let Some(ffmpeg) = find_tool("ffmpeg") else {
        return Ok(None);
    };

    let metadata = media
        .metadata()
        .map_err(|error| format!("Could not read file metadata: {error}"))?;
    let cache_dir = artwork_cache_dir()?;
    fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("Could not create artwork cache: {error}"))?;

    let stem = safe_file_stem(&media);
    let cache_key = media_cache_key(&media, &metadata);
    let output = cache_dir.join(format!("{stem}-{cache_key}.jpg"));
    if output.exists() && output.metadata().map(|item| item.len()).unwrap_or(0) > 0 {
        return Ok(Some(output.display().to_string()));
    }

    let temp_output = cache_dir.join(format!("{stem}-{cache_key}.tmp.jpg"));
    if temp_output.exists() {
        let _ = fs::remove_file(&temp_output);
    }

    let mut command = Command::new(ffmpeg);
    command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-y")
        .arg("-i")
        .arg(&media)
        .arg("-map")
        .arg("0:v:0")
        .arg("-frames:v")
        .arg("1")
        .arg("-q:v")
        .arg("3")
        .arg(&temp_output);

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let result = command
        .output()
        .map_err(|error| format!("FFmpeg could not start for artwork extraction: {error}"))?;

    if !result.status.success() || !temp_output.exists() {
        let _ = fs::remove_file(&temp_output);
        return Ok(None);
    }

    fs::rename(&temp_output, &output)
        .map_err(|error| format!("Could not save extracted artwork: {error}"))?;
    Ok(Some(output.display().to_string()))
}

fn get_media_thumbnail_sync(path: String) -> Result<MediaThumbnail, String> {
    let media = PathBuf::from(&path);
    if !media.exists() || !media.is_file() || !is_supported_media_path(&media) {
        return Ok(MediaThumbnail {
            kind: "unknown".to_string(),
            path: None,
            source: "fallback".to_string(),
        });
    }

    let kind = media_kind_label(&media).to_string();
    let extension = media_extension(&media);
    let metadata = media
        .metadata()
        .map_err(|error| format!("Could not read file metadata: {error}"))?;

    if matches!(kind.as_str(), "document" | "text") {
        return Ok(MediaThumbnail {
            kind,
            path: None,
            source: "fallback".to_string(),
        });
    }

    let cache_dir = thumbnail_cache_dir()?;
    fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("Could not create thumbnail cache: {error}"))?;

    let cache_key = media_cache_key(&media, &metadata);
    let output = thumbnail_output_path(&cache_dir, &media, &kind, &cache_key);
    if output.exists() && output.metadata().map(|item| item.len()).unwrap_or(0) > 0 {
        return Ok(MediaThumbnail {
            kind,
            path: Some(output.display().to_string()),
            source: "cache".to_string(),
        });
    }

    let Some(ffmpeg) = find_tool("ffmpeg") else {
        return Ok(MediaThumbnail {
            kind,
            path: if media_kind_label(&media) == "image" {
                Some(media.display().to_string())
            } else {
                None
            },
            source: if media_kind_label(&media) == "image" {
                "source".to_string()
            } else {
                "fallback".to_string()
            },
        });
    };

    let _generation_guard = THUMBNAIL_GENERATION_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Thumbnail generator lock is unavailable.".to_string())?;
    if output.exists() && output.metadata().map(|item| item.len()).unwrap_or(0) > 0 {
        return Ok(MediaThumbnail {
            kind,
            path: Some(output.display().to_string()),
            source: "cache".to_string(),
        });
    }

    let generated = match kind.as_str() {
        "video" => generate_video_thumbnail(&ffmpeg, &media, &output),
        "audio" => generate_audio_thumbnail(&ffmpeg, &media, &output),
        "image" => generate_image_thumbnail(&ffmpeg, &media, &output, &extension),
        _ => Ok(false),
    }?;

    if generated {
        let _ = enforce_thumbnail_cache_limit(&cache_dir, THUMBNAIL_CACHE_MAX_BYTES);
        return Ok(MediaThumbnail {
            kind,
            path: Some(output.display().to_string()),
            source: "generated".to_string(),
        });
    }

    Ok(MediaThumbnail {
        kind,
        path: if media_kind_label(&media) == "image" {
            Some(media.display().to_string())
        } else {
            None
        },
        source: if media_kind_label(&media) == "image" {
            "source".to_string()
        } else {
            "fallback".to_string()
        },
    })
}

fn thumbnail_output_path(cache_dir: &Path, media: &Path, kind: &str, cache_key: &str) -> PathBuf {
    let stem = safe_file_stem(media);
    cache_dir.join(format!("{stem}-{kind}-{cache_key}.jpg"))
}

fn generate_video_thumbnail(ffmpeg: &Path, media: &Path, output: &Path) -> Result<bool, String> {
    let first_try = run_ffmpeg_thumbnail(
        ffmpeg,
        &[
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            "1",
            "-i",
            media.to_string_lossy().as_ref(),
            "-frames:v",
            "1",
            "-vf",
            "scale=360:-2:force_original_aspect_ratio=decrease",
            "-q:v",
            "4",
        ],
        output,
    )?;

    if first_try {
        return Ok(true);
    }

    run_ffmpeg_thumbnail(
        ffmpeg,
        &[
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            "0",
            "-i",
            media.to_string_lossy().as_ref(),
            "-frames:v",
            "1",
            "-vf",
            "scale=360:-2:force_original_aspect_ratio=decrease",
            "-q:v",
            "4",
        ],
        output,
    )
}

fn generate_audio_thumbnail(ffmpeg: &Path, media: &Path, output: &Path) -> Result<bool, String> {
    run_ffmpeg_thumbnail(
        ffmpeg,
        &[
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            media.to_string_lossy().as_ref(),
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-vf",
            "scale=360:-2:force_original_aspect_ratio=decrease",
            "-q:v",
            "4",
        ],
        output,
    )
}

fn generate_image_thumbnail(
    ffmpeg: &Path,
    media: &Path,
    output: &Path,
    extension: &str,
) -> Result<bool, String> {
    if matches!(extension, "svg" | "ico") {
        return Ok(false);
    }

    run_ffmpeg_thumbnail(
        ffmpeg,
        &[
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            media.to_string_lossy().as_ref(),
            "-frames:v",
            "1",
            "-vf",
            "scale=360:-2:force_original_aspect_ratio=decrease",
            "-q:v",
            "4",
        ],
        output,
    )
}

fn run_ffmpeg_thumbnail(ffmpeg: &Path, args: &[&str], output: &Path) -> Result<bool, String> {
    let temp_output = output.with_extension("tmp.jpg");
    if temp_output.exists() {
        let _ = fs::remove_file(&temp_output);
    }

    let mut command = Command::new(ffmpeg);
    command.args(args).arg(&temp_output).stdin(Stdio::null());

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let result = command
        .output()
        .map_err(|error| format!("FFmpeg could not start for thumbnail generation: {error}"))?;

    if !result.status.success() || !temp_output.exists() {
        let _ = fs::remove_file(&temp_output);
        return Ok(false);
    }

    if temp_output.metadata().map(|item| item.len()).unwrap_or(0) == 0 {
        let _ = fs::remove_file(&temp_output);
        return Ok(false);
    }

    if output.exists() {
        let _ = fs::remove_file(output);
    }
    fs::rename(&temp_output, output)
        .map_err(|error| format!("Could not save generated thumbnail: {error}"))?;
    Ok(true)
}

fn enforce_thumbnail_cache_limit(cache_dir: &Path, max_bytes: u64) -> Result<(), String> {
    let (_, byte_len) = directory_size(cache_dir)?;
    if byte_len <= max_bytes {
        return Ok(());
    }

    let mut files = fs::read_dir(cache_dir)
        .map_err(|error| format!("Could not read thumbnail cache: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file() {
                return None;
            }
            let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
            Some((entry.path(), metadata.len(), modified))
        })
        .collect::<Vec<_>>();

    files.sort_by_key(|(_, _, modified)| *modified);

    let mut remaining = byte_len;
    for (path, len, _) in files {
        if remaining <= max_bytes {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            remaining = remaining.saturating_sub(len);
        }
    }

    Ok(())
}

fn media_folder_item(path: PathBuf) -> Option<MediaFolderItem> {
    let metadata = path.metadata().ok()?;
    let display_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled")
        .to_string();

    if path.is_dir() {
        return Some(MediaFolderItem {
            path: path.display().to_string(),
            display_name,
            extension: String::new(),
            byte_len: 0,
            kind: "folder".to_string(),
            modified_at: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs()),
        });
    }

    if !path.is_file() || !is_supported_media_path(&path) {
        return None;
    }

    Some(MediaFolderItem {
        extension: media_extension(&path),
        kind: media_kind_label(&path).to_string(),
        path: path.display().to_string(),
        display_name,
        byte_len: metadata.len(),
        modified_at: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs()),
    })
}

fn read_subtitle_file(path: &Path) -> Result<SubtitleFile, String> {
    if !path.exists() {
        return Err(format!("Subtitle file does not exist: {}", path.display()));
    }
    if !path.is_file() {
        return Err(format!("Subtitle path is not a file: {}", path.display()));
    }
    if !is_subtitle_path(path) {
        return Err("Only SRT and VTT subtitles are supported right now.".to_string());
    }

    let bytes = fs::read(path).map_err(|error| format!("Could not read subtitle: {error}"))?;
    let content = decode_subtitle_text(&bytes);
    let display_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Subtitle")
        .to_string();

    Ok(SubtitleFile {
        path: path.display().to_string(),
        display_name,
        extension: media_extension(path),
        content,
    })
}

fn is_subtitle_path(path: &Path) -> bool {
    matches!(media_extension(path).as_str(), "srt" | "vtt")
}

fn decode_subtitle_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return String::from_utf8_lossy(&bytes[3..]).to_string();
    }

    if bytes.starts_with(&[0xff, 0xfe]) {
        let values = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16_lossy(&values);
    }

    if bytes.starts_with(&[0xfe, 0xff]) {
        let values = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16_lossy(&values);
    }

    String::from_utf8_lossy(bytes).to_string()
}

fn media_extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase()
}

fn is_supported_media_path(path: &Path) -> bool {
    let extension = media_extension(path);
    if SUPPORTED_MEDIA_EXTENSIONS
        .iter()
        .any(|supported| *supported == extension)
    {
        return true;
    }

    is_known_extensionless_text_file(path)
}

fn is_known_extensionless_text_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    let normalized = name.to_lowercase();
    TEXT_FILE_NAMES
        .iter()
        .any(|supported| *supported == normalized)
        || normalized.starts_with(".env")
}

fn transmux_cache_dir() -> Result<PathBuf, String> {
    Ok(lmp_data_dir()?.join("cache").join("transmux"))
}

fn artwork_cache_dir() -> Result<PathBuf, String> {
    Ok(lmp_data_dir()?.join("cache").join("artwork"))
}

fn thumbnail_cache_dir() -> Result<PathBuf, String> {
    Ok(lmp_data_dir()?.join("cache").join("thumbnails"))
}

fn probe_cache_dir() -> Result<PathBuf, String> {
    Ok(lmp_data_dir()?.join("cache").join("probe"))
}

fn probe_cache_file_path(path: &Path, metadata: &fs::Metadata) -> Result<PathBuf, String> {
    let cache_dir = probe_cache_dir()?;
    fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("Could not create probe cache: {error}"))?;
    Ok(cache_dir.join(format!("{}.json", media_probe_cache_key(path, metadata))))
}

fn read_probe_cache(path: &Path) -> Option<MediaInspection> {
    if let Ok(content) = fs::read_to_string(path) {
        if let Ok(cached) = serde_json::from_str::<CachedMediaInspection>(&content) {
            if cached.schema_version == PROBE_CACHE_SCHEMA_VERSION
                && cached.probe_format_version == PROBE_FORMAT_VERSION
            {
                return Some(cached.inspection);
            }
        }
    }
    let _ = fs::remove_file(path);
    None
}

fn write_probe_cache(path: &Path, inspection: &MediaInspection) -> Result<(), String> {
    let cached = CachedMediaInspection {
        schema_version: PROBE_CACHE_SCHEMA_VERSION,
        probe_format_version: PROBE_FORMAT_VERSION,
        inspection: MediaInspection {
            source: inspection.source.clone(),
            summary: inspection
                .summary
                .iter()
                .map(|item| MediaInspectionItem {
                    label: item.label.clone(),
                    value: item.value.clone(),
                    detail: item.detail.clone(),
                })
                .collect(),
            details: inspection.details.clone(),
        },
    };
    let content = serde_json::to_string(&cached)
        .map_err(|error| format!("Could not encode probe cache: {error}"))?;
    let temp_path = path.with_extension("tmp");
    fs::write(&temp_path, content)
        .map_err(|error| format!("Could not write probe cache: {error}"))?;
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&temp_path, path).map_err(|error| format!("Could not save probe cache: {error}"))?;
    Ok(())
}

fn thumbnail_cache_status() -> Result<ThumbnailCacheStatus, String> {
    let cache_dir = thumbnail_cache_dir()?;
    fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("Could not create thumbnail cache: {error}"))?;
    let (file_count, byte_len) = directory_size(&cache_dir)?;

    Ok(ThumbnailCacheStatus {
        path: cache_dir.display().to_string(),
        file_count,
        byte_len,
        max_byte_len: THUMBNAIL_CACHE_MAX_BYTES,
    })
}

fn settings_cache_status() -> Result<SettingsCacheStatus, String> {
    Ok(SettingsCacheStatus {
        preview: combined_cache_status(&[thumbnail_cache_dir()?, artwork_cache_dir()?])?,
        prepared_video: cache_status_for_dir(&transmux_cache_dir()?)?,
        media_probe: cache_status_for_dir(&probe_cache_dir()?)?,
    })
}

fn cache_status_for_dir(path: &Path) -> Result<CacheStatus, String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("Could not create cache directory {}: {error}", path.display()))?;
    let (file_count, byte_len) = directory_size(path)?;
    Ok(CacheStatus {
        file_count,
        byte_len,
    })
}

fn combined_cache_status(paths: &[PathBuf]) -> Result<CacheStatus, String> {
    let mut file_count = 0usize;
    let mut byte_len = 0u64;
    for path in paths {
        let status = cache_status_for_dir(path)?;
        file_count += status.file_count;
        byte_len = byte_len.saturating_add(status.byte_len);
    }
    Ok(CacheStatus {
        file_count,
        byte_len,
    })
}

fn directory_size(path: &Path) -> Result<(usize, u64), String> {
    if !path.exists() {
        return Ok((0, 0));
    }

    let mut file_count = 0usize;
    let mut byte_len = 0u64;
    let entries = fs::read_dir(path)
        .map_err(|error| format!("Could not read cache directory {}: {error}", path.display()))?;

    for entry in entries {
        let entry = entry.map_err(|error| format!("Could not read cache entry: {error}"))?;
        let entry_path = entry.path();
        let metadata = entry
            .metadata()
            .map_err(|error| format!("Could not read cache metadata: {error}"))?;
        if metadata.is_dir() {
            let (nested_count, nested_size) = directory_size(&entry_path)?;
            file_count += nested_count;
            byte_len = byte_len.saturating_add(nested_size);
        } else if metadata.is_file() {
            file_count += 1;
            byte_len = byte_len.saturating_add(metadata.len());
        }
    }

    Ok((file_count, byte_len))
}

fn clear_cache_directory(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(path)
        .map_err(|error| format!("Could not read cache directory {}: {error}", path.display()))?
    {
        let entry = entry.map_err(|error| format!("Could not read cache entry: {error}"))?;
        let entry_path = entry.path();
        let metadata = entry
            .metadata()
            .map_err(|error| format!("Could not read cache metadata: {error}"))?;
        if metadata.is_dir() {
            fs::remove_dir_all(&entry_path).map_err(|error| {
                format!(
                    "Could not remove cache folder {}: {error}",
                    entry_path.display()
                )
            })?;
        } else {
            fs::remove_file(&entry_path).map_err(|error| {
                format!(
                    "Could not remove cache file {}: {error}",
                    entry_path.display()
                )
            })?;
        }
    }

    Ok(())
}

fn clear_cache_directories(paths: &[PathBuf]) -> Result<(), String> {
    for path in paths {
        clear_cache_directory(path)?;
    }
    Ok(())
}

fn media_cache_key(path: &Path, metadata: &fs::Metadata) -> String {
    let mut hasher = DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    metadata.len().hash(&mut hasher);

    if let Ok(modified) = metadata.modified() {
        if let Ok(age) = modified.duration_since(UNIX_EPOCH) {
            age.as_secs().hash(&mut hasher);
            age.subsec_nanos().hash(&mut hasher);
        }
    }

    format!("{:016x}", hasher.finish())
}

fn media_probe_cache_key(path: &Path, metadata: &fs::Metadata) -> String {
    let mut hasher = DefaultHasher::new();
    normalized_cache_path(path).hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    PROBE_CACHE_SCHEMA_VERSION.hash(&mut hasher);
    PROBE_FORMAT_VERSION.hash(&mut hasher);

    if let Ok(modified) = metadata.modified() {
        if let Ok(age) = modified.duration_since(UNIX_EPOCH) {
            age.as_secs().hash(&mut hasher);
            age.subsec_nanos().hash(&mut hasher);
        }
    }

    format!("{:016x}", hasher.finish())
}

fn normalized_cache_path(path: &Path) -> String {
    let normalized = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let value = normalized.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    {
        value.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        value
    }
}

fn safe_file_stem(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("media");
    let safe: String = stem
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .take(48)
        .collect();

    if safe.is_empty() {
        "media".to_string()
    } else {
        safe
    }
}

fn ffmpeg_command_name() -> &'static str {
    if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

fn detect_native_backend() -> PlaybackBackendStatus {
    PlaybackBackendStatus {
        id: "native-webview".to_string(),
        name: "Native WebView".to_string(),
        role: "primary".to_string(),
        available: true,
        version: None,
        path: None,
        hint: Some(
            "Uses the OS media stack through WebView. Fast startup, clean embedding.".to_string(),
        ),
    }
}

fn detect_gstreamer() -> PlaybackBackendStatus {
    let launch = find_tool("gst-launch-1.0");
    let play = find_tool("gst-play-1.0");
    let discoverer = find_tool("gst-discoverer-1.0");
    let version = launch
        .as_ref()
        .and_then(|path| command_first_line(path, &["--version"]))
        .or_else(|| {
            play.as_ref()
                .and_then(|path| command_first_line(path, &["--version"]))
        });

    let mut missing = Vec::new();
    if launch.is_none() {
        missing.push("gst-launch-1.0");
    }
    if play.is_none() {
        missing.push("gst-play-1.0");
    }
    if discoverer.is_none() {
        missing.push("gst-discoverer-1.0");
    }

    let available = launch.is_some() || play.is_some();
    let hint = if available {
        let mut parts =
            vec!["Detected. We can start wiring it as an optional fallback engine.".to_string()];
        if !missing.is_empty() {
            parts.push(format!("Missing optional tools: {}.", missing.join(", ")));
        }
        Some(parts.join(" "))
    } else {
        Some(
            "Install the GStreamer runtime and add its bin folder to PATH, or set a GSTREAMER_1_0_ROOT_* environment variable."
                .to_string(),
        )
    };

    PlaybackBackendStatus {
        id: "gstreamer".to_string(),
        name: "GStreamer".to_string(),
        role: "fallback".to_string(),
        available,
        version,
        path: launch.or(play).map(|path| path.display().to_string()),
        hint,
    }
}

fn detect_ffmpeg_helper() -> PlaybackBackendStatus {
    let ffmpeg = find_tool("ffmpeg");
    let version = ffmpeg
        .as_ref()
        .and_then(|path| command_first_line(path, &["-version"]));

    PlaybackBackendStatus {
        id: "ffmpeg-helper".to_string(),
        name: "FFmpeg helper".to_string(),
        role: "helper".to_string(),
        available: ffmpeg.is_some(),
        version,
        path: ffmpeg.map(|path| path.display().to_string()),
        hint: Some("Used for probe/remux/cache work, not as the main playback engine.".to_string()),
    }
}

fn inspect_media_sync(path: String) -> Result<MediaInspection, String> {
    let media = PathBuf::from(&path);
    if !media.exists() {
        return Err(format!("File does not exist: {path}"));
    }
    if !media.is_file() {
        return Err(format!("Path is not a file: {path}"));
    }
    if !is_supported_media_path(&media) {
        return Err(format!("Unsupported file type: {}", media.display()));
    }
    let metadata = media
        .metadata()
        .map_err(|error| format!("Could not read file metadata: {error}"))?;

    if let Some(ffprobe) = find_tool("ffprobe") {
        let cache_path = probe_cache_file_path(&media, &metadata).ok();
        if let Some(cache_path) = cache_path.as_ref() {
            if let Some(inspection) = read_probe_cache(cache_path) {
                return Ok(inspection);
            }
        }

        let path_arg = media.display().to_string();
        let output = command_output_text(
            &ffprobe,
            &[
                "-hide_banner",
                "-v",
                "error",
                "-show_entries",
                "format=format_name,duration,size,bit_rate:format_tags=title,artist,album,album_artist,genre,date,track,composer:stream=index,codec_type,codec_name,profile,width,height,channels,sample_rate,avg_frame_rate,bit_rate:stream_tags=language,title",
                "-of",
                "compact=p=1:nk=0",
                path_arg.as_str(),
            ],
        );

        if let Ok(details) = output {
            let inspection = MediaInspection {
                source: "FFprobe".to_string(),
                summary: summarize_ffprobe_compact(&details, &media),
                details: compact_tool_output(&details, 4600),
            };
            if let Some(cache_path) = cache_path.as_ref() {
                let _ = write_probe_cache(cache_path, &inspection);
            }
            return Ok(inspection);
        }
    }

    let summary = vec![
        MediaInspectionItem {
            label: "Kind".to_string(),
            value: media_kind_label(&media).to_string(),
            detail: Some(media_extension(&media)),
        },
        MediaInspectionItem {
            label: "Size".to_string(),
            value: format_bytes(metadata.len()),
            detail: None,
        },
    ];

    Ok(MediaInspection {
        source: "LMP".to_string(),
        summary,
        details: "FFprobe is not available, so LMP is showing lightweight file metadata only."
            .to_string(),
    })
}

fn summarize_ffprobe_compact(output: &str, path: &Path) -> Vec<MediaInspectionItem> {
    let mut format_fields: Option<std::collections::HashMap<String, String>> = None;
    let mut streams: std::collections::BTreeMap<String, std::collections::HashMap<String, String>> =
        std::collections::BTreeMap::new();
    let mut orphan_stream_count = 0usize;

    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Some((section, values)) = line.split_once('|') else {
            continue;
        };
        let fields = parse_compact_fields(values);

        if section == "format" {
            format_fields
                .get_or_insert_with(std::collections::HashMap::new)
                .extend(fields);
        } else if section == "stream" {
            let key = fields.get("index").cloned().unwrap_or_else(|| {
                orphan_stream_count += 1;
                format!("unknown-{orphan_stream_count}")
            });
            streams.entry(key).or_default().extend(fields);
        }
    }

    let mut summary = Vec::new();

    if let Some(fields) = format_fields {
        let format_name = fields
            .get("format_name")
            .cloned()
            .unwrap_or_else(|| media_extension(path));
        let duration = fields
            .get("duration")
            .and_then(|value| format_duration(value))
            .unwrap_or_else(|| "unknown duration".to_string());
        let detail = [
            fields
                .get("size")
                .and_then(|value| value.parse::<u64>().ok())
                .map(format_bytes),
            fields
                .get("bit_rate")
                .and_then(|value| format_bitrate(value)),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" - ");

        summary.push(MediaInspectionItem {
            label: "Container".to_string(),
            value: format_name,
            detail: Some(if detail.is_empty() {
                duration
            } else {
                format!("{duration} - {detail}")
            }),
        });

        if media_kind_label(path) == "audio" {
            push_format_tag_item(&mut summary, &fields, "title", "Title");
            push_format_tag_item(&mut summary, &fields, "artist", "Artist");
            push_format_tag_item(&mut summary, &fields, "album", "Album");
            push_format_tag_item(&mut summary, &fields, "album_artist", "Album artist");
            push_format_tag_item(&mut summary, &fields, "genre", "Genre");
            push_format_tag_item(&mut summary, &fields, "date", "Date");
            push_format_tag_item(&mut summary, &fields, "track", "Track");
        }
    } else {
        summary.push(MediaInspectionItem {
            label: "Kind".to_string(),
            value: media_kind_label(path).to_string(),
            detail: Some(media_extension(path)),
        });
    }

    for (key, fields) in streams {
        let index = fields.get("index").cloned().unwrap_or_else(|| {
            if key.starts_with("unknown-") {
                "?".to_string()
            } else {
                key
            }
        });
        let kind = fields
            .get("codec_type")
            .cloned()
            .unwrap_or_else(|| "stream".to_string());
        let codec = fields
            .get("codec_name")
            .cloned()
            .unwrap_or_else(|| "unknown".to_string());
        let title = fields
            .get("tag:title")
            .or_else(|| fields.get("title"))
            .cloned();
        let language = fields
            .get("tag:language")
            .or_else(|| fields.get("language"))
            .cloned();
        let value = if let Some(title) = title.filter(|item| !item.is_empty()) {
            format!("{codec} - {title}")
        } else {
            codec
        };

        summary.push(MediaInspectionItem {
            label: format!("{} {}", capitalize_ascii(&kind), index),
            value,
            detail: stream_detail(&kind, &fields, language),
        });
    }

    if summary.is_empty() {
        summary.push(MediaInspectionItem {
            label: "Kind".to_string(),
            value: media_kind_label(path).to_string(),
            detail: Some(media_extension(path)),
        });
    }

    summary.into_iter().take(12).collect()
}

fn push_format_tag_item(
    summary: &mut Vec<MediaInspectionItem>,
    fields: &std::collections::HashMap<String, String>,
    tag: &str,
    label: &str,
) {
    let tag_key = format!("tag:{tag}");
    let value = fields
        .get(&tag_key)
        .or_else(|| fields.get(tag))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());

    if let Some(value) = value {
        summary.push(MediaInspectionItem {
            label: label.to_string(),
            value: value.to_string(),
            detail: None,
        });
    }
}

fn parse_compact_fields(values: &str) -> std::collections::HashMap<String, String> {
    values
        .split('|')
        .filter_map(|part| part.split_once('='))
        .map(|(key, value)| (key.to_string(), value.replace("\\|", "|")))
        .collect()
}

fn stream_detail(
    kind: &str,
    fields: &std::collections::HashMap<String, String>,
    language: Option<String>,
) -> Option<String> {
    let mut parts = Vec::new();

    if kind == "video" {
        if let (Some(width), Some(height)) = (fields.get("width"), fields.get("height")) {
            if width != "0" && height != "0" {
                parts.push(format!("{width}x{height}"));
            }
        }
        if let Some(rate) = fields
            .get("avg_frame_rate")
            .and_then(|value| format_framerate(value))
        {
            parts.push(rate);
        }
    }

    if kind == "audio" {
        if let Some(channels) = fields.get("channels").filter(|value| !value.is_empty()) {
            parts.push(format!("{channels} channels"));
        }
        if let Some(sample_rate) = fields.get("sample_rate").filter(|value| !value.is_empty()) {
            parts.push(format!(
                "{} kHz",
                sample_rate.parse::<f64>().unwrap_or(0.0) / 1000.0
            ));
        }
    }

    if let Some(profile) = fields.get("profile").filter(|value| !value.is_empty()) {
        parts.push(profile.clone());
    }
    if let Some(bit_rate) = fields
        .get("bit_rate")
        .and_then(|value| format_bitrate(value))
    {
        parts.push(bit_rate);
    }
    if let Some(language) = language.filter(|value| !value.is_empty() && value != "und") {
        parts.push(language);
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" - "))
    }
}

fn media_kind_label(path: &Path) -> &'static str {
    match media_extension(path).as_str() {
        "jpg" | "jpeg" | "jfif" | "png" | "gif" | "webp" | "bmp" | "avif" | "svg" | "ico"
        | "tif" | "tiff" => "image",
        "pdf" | "doc" | "docx" | "docm" | "dotx" | "dotm" => "document",
        "txt" | "md" | "markdown" | "log" | "json" | "jsonc" | "csv" | "tsv" | "xml" | "yaml"
        | "yml" | "toml" | "ini" | "conf" | "cfg" | "css" | "scss" | "sass" | "less" | "html"
        | "htm" | "xhtml" | "js" | "jsx" | "tsx" | "mjs" | "cjs" | "vue" | "svelte" | "astro"
        | "rs" | "py" | "java" | "c" | "cpp" | "h" | "hpp" | "cs" | "go" | "php" | "rb" | "sh"
        | "ps1" | "bat" | "cmd" | "sql" | "lua" | "dart" | "kt" | "kts" | "swift" | "pl" | "r"
        | "gradle" => "text",
        "mp3" | "flac" | "wav" | "m4a" | "aac" | "ogg" | "opus" | "wma" | "aiff" | "aif"
        | "oga" | "weba" | "caf" | "amr" | "mka" | "mp2" | "mpa" | "ac3" | "eac3" | "dts"
        | "dtshd" | "ape" | "alac" | "au" | "snd" => "audio",
        _ => "video",
    }
}

fn format_duration(value: &str) -> Option<String> {
    let seconds = value.parse::<f64>().ok()?;
    if !seconds.is_finite() || seconds <= 0.0 {
        return None;
    }

    let rounded = seconds.floor() as u64;
    let hours = rounded / 3600;
    let minutes = (rounded % 3600) / 60;
    let seconds = rounded % 60;

    if hours > 0 {
        Some(format!("{hours}:{minutes:02}:{seconds:02}"))
    } else {
        Some(format!("{minutes:02}:{seconds:02}"))
    }
}

fn format_bitrate(value: &str) -> Option<String> {
    let bits = value.parse::<f64>().ok()?;
    if !bits.is_finite() || bits <= 0.0 {
        return None;
    }

    if bits >= 1_000_000.0 {
        Some(format!("{:.1} Mbps", bits / 1_000_000.0))
    } else {
        Some(format!("{:.0} kbps", bits / 1000.0))
    }
}

fn format_framerate(value: &str) -> Option<String> {
    let (left, right) = value.split_once('/')?;
    let numerator = left.parse::<f64>().ok()?;
    let denominator = right.parse::<f64>().ok()?;
    if denominator <= 0.0 {
        return None;
    }

    let fps = numerator / denominator;
    if fps.is_finite() && fps > 0.0 {
        Some(format!("{fps:.2} fps"))
    } else {
        None
    }
}

fn format_bytes(bytes: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut index = 0;
    while value >= 1024.0 && index < units.len() - 1 {
        value /= 1024.0;
        index += 1;
    }

    if value >= 10.0 || index == 0 {
        format!("{value:.0} {}", units[index])
    } else {
        format!("{value:.1} {}", units[index])
    }
}

fn capitalize_ascii(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
        None => "Stream".to_string(),
    }
}

fn probe_media_with_gstreamer_sync(path: String) -> Result<GstreamerProbe, String> {
    let media = PathBuf::from(&path);
    if !media.exists() {
        return Err(format!("File does not exist: {path}"));
    }
    if !media.is_file() {
        return Err(format!("Path is not a file: {path}"));
    }
    if !is_supported_media_path(&media) {
        return Err(format!("Unsupported file type: {}", media.display()));
    }

    let discoverer = find_tool("gst-discoverer-1.0").ok_or_else(|| {
        "gst-discoverer-1.0 was not found. Install GStreamer runtime tools first.".to_string()
    })?;

    let path_arg = media.display().to_string();
    let output = command_output_text(&discoverer, &[path_arg.as_str()])
        .or_else(|_| {
            let uri = file_uri(&media);
            command_output_text(&discoverer, &[uri.as_str()])
        })
        .map_err(|error| format!("GStreamer could not inspect this media: {error}"))?;

    let summary = summarize_gstreamer_probe(&output);

    Ok(GstreamerProbe {
        summary,
        details: compact_tool_output(&output, 3800),
    })
}

fn summarize_gstreamer_probe(output: &str) -> Vec<String> {
    let interesting = [
        "duration:",
        "container:",
        "video:",
        "audio:",
        "subtitle:",
        "codec:",
        "mpeg",
        "matroska",
        "quicktime",
        "h.264",
        "h.265",
        "hevc",
        "aac",
        "opus",
        "vorbis",
        "ac-3",
    ];

    let mut summary = output
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .filter(|line| {
            let lower = line.to_lowercase();
            interesting.iter().any(|marker| lower.contains(marker))
        })
        .map(|line| line.replace('\t', " "))
        .take(6)
        .collect::<Vec<_>>();

    if summary.is_empty() {
        summary = output
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .take(3)
            .map(ToString::to_string)
            .collect();
    }

    summary
}

fn command_output_text(path: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(path);
    command.args(args).stdin(Stdio::null());

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command
        .output()
        .map_err(|error| format!("Could not start {}: {error}", path.display()))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let text = [stdout.trim(), stderr.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    if output.status.success() {
        Ok(text)
    } else if text.is_empty() {
        Err(format!(
            "{} exited with status {}",
            path.display(),
            output.status
        ))
    } else {
        Err(text)
    }
}

fn compact_tool_output(output: &str, max_len: usize) -> String {
    let compact = output
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    if compact.len() <= max_len {
        compact
    } else {
        let shortened = compact.chars().take(max_len).collect::<String>();
        format!("{shortened}...")
    }
}

fn file_uri(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let mut uri = if cfg!(windows) {
        format!("file:///{}", normalized)
    } else {
        format!("file://{}", normalized)
    };

    uri = uri
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b':' | b'/' => {
                vec![byte as char]
            }
            other => format!("%{other:02X}").chars().collect(),
        })
        .collect();

    uri
}

fn find_tool(name: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    let executable = executable_name(name);

    if let Ok(current_exe) = env::current_exe() {
        if let Some(app_dir) = current_exe.parent() {
            candidates.push(app_dir.join("tools").join(&executable));
            candidates.push(app_dir.join("binaries").join("tools").join(&executable));
            candidates.push(app_dir.join("resources").join("tools").join(&executable));
            candidates.push(
                app_dir
                    .join("resources")
                    .join("binaries")
                    .join("tools")
                    .join(&executable),
            );
            candidates.push(app_dir.join(&executable));
        }
    }

    if let Ok(current_dir) = env::current_dir() {
        candidates.push(
            current_dir
                .join("src-tauri")
                .join("binaries")
                .join("tools")
                .join(&executable),
        );
        candidates.push(current_dir.join("binaries").join("tools").join(&executable));
        candidates.push(current_dir.join("tools").join(&executable));
    }

    for root in gstreamer_roots() {
        candidates.push(root.join("bin").join(&executable));
        candidates.push(root.join(&executable));
    }

    if let Some(paths) = env::var_os("PATH") {
        for dir in env::split_paths(&paths) {
            candidates.push(dir.join(&executable));
            if cfg!(windows) && !executable.ends_with(".exe") {
                candidates.push(dir.join(format!("{executable}.exe")));
            }
        }
    }

    candidates
        .into_iter()
        .find(|path| path.exists() && path.is_file())
}

fn executable_name(name: &str) -> String {
    if cfg!(windows) && !name.ends_with(".exe") {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn gstreamer_roots() -> Vec<PathBuf> {
    let mut roots = [
        "GSTREAMER_1_0_ROOT_X86_64",
        "GSTREAMER_1_0_ROOT_MSVC_X86_64",
        "GSTREAMER_1_0_ROOT_MINGW_X86_64",
        "GSTREAMER_ROOT",
    ]
    .iter()
    .filter_map(|key| env::var_os(key).map(PathBuf::from))
    .collect::<Vec<_>>();

    if cfg!(windows) {
        for base in [
            env::var_os("ProgramFiles").map(PathBuf::from),
            env::var_os("ProgramFiles(x86)").map(PathBuf::from),
            Some(PathBuf::from("C:\\")),
        ]
        .into_iter()
        .flatten()
        {
            roots.push(base.join("gstreamer").join("1.0").join("msvc_x86_64"));
            roots.push(base.join("gstreamer").join("1.0").join("mingw_x86_64"));
            roots.push(base.join("GStreamer").join("1.0").join("msvc_x86_64"));
            roots.push(base.join("GStreamer").join("1.0").join("mingw_x86_64"));
        }
    }

    roots
}

fn command_first_line(path: &Path, args: &[&str]) -> Option<String> {
    let mut command = Command::new(path);
    command.args(args).stdin(Stdio::null());

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToString::to_string)
}

fn media_args<I>(args: I) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    args.into_iter()
        .filter(|arg| {
            let path = Path::new(arg);
            path.exists() && path.is_file() && is_supported_media_path(path)
        })
        .collect()
}
