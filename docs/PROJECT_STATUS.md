# LMP Project Status

Last updated: 2026-11-23

## Overview

LMP is a Windows-first media player and file viewer suite built with Tauri, React, TypeScript, and Rust. It uses platform and helper tools for low-level media and document work, while the project code focuses on the app shell, routing, controls, viewer state, Windows integration, and UI.

Current public alpha: `v0.3.0-alpha`.

## Current Modules

- Video: LMP AV engine (own MP4/MOV, Matroska/WebM and MPEG-TS demuxers, WebCodecs decode, own clock and renderer) plus native WebView playback, queue, repeat current, embedded and sidecar subtitles, audio/subtitle track switching, tracks/info shelves, A-B loop, moments, mini-player, compact controls, and accurate MP4 clip export.
- Audio: native playback, compact now-playing UI, metadata/artwork helpers, speed, volume, recents, and library.
- Image/GIF: open/view, zoom, fit, rotate, and navigation.
- PDF/document: pdf.js rendering, page navigation, zoom, page overview, drag/pan, smooth scroll, and print flow.
- Text/code: CodeMirror 6 editor rebuilt around LMP's own components (menu bar, find/replace bar with regex, go-to-line box, status bar, notices). CodeMirror owns the document, so typing no longer copies the whole text through the app. Includes encoding detection and switching, line ending and indentation control, language override, read-only/binary locking, external change detection, Save / Don't Save / Cancel guards, per-document crash drafts, a large-file mode, cursor memory per file (only while recent files are remembered), writing layout, paste cleanup, and text statistics.
- Integrated terminal: optional terminal for saved text/code files, disabled by default.
- Word documents: DOCX files open as editable extracted text copies. Legacy DOC files use an external converter when available.
- Updates: Settings-based updater UI with signed update manifest support for later alpha builds.
- Playback Engine v2: LMP AV is live as a selectable engine (Auto / LMP AV / Native in Settings - Engine); see `docs/PLAYBACK_ENGINE_V2.md`.
- Cache controls: preview, prepared video, and media probe caches can be reviewed and cleared from Settings.

## Architecture

- Tauri 2 desktop shell with Rust commands for Windows integration, file routing, helper tooling, and native dialogs.
- React frontend with viewer-specific modules under `src/viewers`.
- Shared player logic under `src/player`; the LMP AV playback core under `src/player/av` and `src-tauri/src/av`.
- UI components under `src/ui`.
- Text editor: UI and editor modules under `src/viewers/text`, the app-level controller in `src/app/useTextEditor.ts` with drafts in `src/app/useTextDraftRecovery.ts`, and Rust commands in `src-tauri/src/text_document.rs` (read, stat, save, Save As dialog), `src-tauri/src/text_encoding.rs` (detection, code pages through the Windows API) and `src-tauri/src/text_recovery.rs` (draft store).
- File-kind and window-profile helpers under `src/lib`; `src-tauri/src/media_sniff.rs` decides from the first 4 KB whether a `.ts`/`.mts` file is a transport stream or TypeScript.

Important files:

- `src/App.tsx`
- `src/app/useTextEditor.ts`
- `src/viewers/text/TextWorkspace.tsx`
- `src/player/settings.ts`
- `src/player/memory.ts`
- `src/player/capabilities.ts`
- `src/player/playbackEnginePolicy.ts`
- `src/player/av/pipeline.ts`
- `src-tauri/src/av/mod.rs`
- `src/ui/TransportDock.tsx`
- `src/ui/MediaShelves.tsx`
- `src/ui/WindowChrome.tsx`
- `src-tauri/src/main.rs`
- `src-tauri/nsis/installer-hooks.nsh`

## Helper Tools

Release packages can bundle FFmpeg and FFprobe from `src-tauri/binaries/tools` for metadata, artwork, thumbnails, remux helpers, and accurate clip export. The large `.exe` files are packaging resources and are not committed to the source repository.

FFmpeg is a helper only: thumbnails, artwork, media inspection, clip export and the remux fallback for the native engine (for example MPEG-2 video in a transport stream). Playback itself runs through LMP AV or the WebView element.

## Windows Integration

- File associations are declared in `src-tauri/tauri.conf.json`.
- NSIS installer hooks register/unregister Open With capabilities.
- Per-filetype ProgIDs provide separate fallback icons for video, audio, image, PDF, text/code, and Word/document files.
- Text/code extensions also get an "Edit with LMP" verb under `HKCU\Software\Classes\SystemFileAssociations\.<ext>\shell\LMP.Edit`, so scripts such as `.ps1`, `.bat` or `.reg` can be edited without changing their default action.
- The text extension list lives in five places that must stay in sync: `src-tauri/tauri.conf.json`, `src-tauri/nsis/installer-hooks.nsh`, the scripts under `scripts/`, `src-tauri/src/main.rs` and `src/lib/playerBrain.ts`.
- Windows' own "New > Text Document" creates an empty `.txt` that LMP opens like any other text file; LMP adds no extra "New" entries.
- Files can be dropped onto any LMP window. Several text files picked or dropped at once open in one window each.
- Windows `UserChoice` defaults are not modified directly.
- Real Explorer thumbnails are left to Windows and installed preview/codec providers.

## Current Limitations

- Decoding depends on the system WebCodecs/Media Foundation decoders; HEVC and AV1 need the Windows extensions or hardware support.
- AVI and other rare containers still use the WebView element; LMP AV reads MP4/MOV, MKV/WebM and MPEG-TS/M2TS.
- Bitmap subtitles (PGS/VobSub) and DTS/TrueHD audio are not supported by LMP AV.
- DOC/DOCX handling is extraction-based and does not round-trip Word formatting.
- The text editor opens files up to 64 MB and keeps drafts for documents up to 16 MB. `.ts`/`.mts` files are routed by content: readable text opens in the editor, anything binary plays as video.
- The editor shows one document per window; there are no tabs.
- Legacy DOC preview needs LibreOffice or conversion to DOCX.
- PDF printing depends on the WebView/system print path and should be tested with real documents and printers.
- Automated regression coverage is still limited; alpha validation relies on the smoke checklist and practical testing.

## Source and Release Policy

- Users should download the latest Windows package from GitHub Releases.
- Source commits should not include installers, packaged ZIPs, `dist/`, Tauri `target/`, smoke media, logs, caches, local release artifacts, or FFmpeg/FFprobe `.exe` files.
- `src-tauri/binaries/tools/LICENSE-FFmpeg.txt` stays in the repository to document the helper license.
- Packaged installers and sendable ZIPs belong in GitHub Releases.
