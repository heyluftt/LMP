# LMP Project Status

Last updated: 2026-06-21

## Overview

LMP is a Windows-first media player and file viewer suite built with Tauri, React, TypeScript, and Rust. It uses platform and helper tools for low-level media and document work, while the project code focuses on the app shell, routing, controls, viewer state, Windows integration, and UI.

Current public alpha: `v0.2.2-alpha`.

## Current Modules

- Video: native WebView playback, queue, repeat current, subtitles, tracks/info shelves, A-B loop, moments, mini-player, compact controls, and accurate MP4 clip export.
- Audio: native playback, compact now-playing UI, metadata/artwork helpers, speed, volume, recents, and library.
- Image/GIF: open/view, zoom, fit, rotate, and navigation.
- PDF/document: pdf.js rendering, page navigation, zoom, page overview, drag/pan, smooth scroll, and print flow.
- Text/code: CodeMirror 6 editor with syntax highlighting, search/replace, save/save-as, revert, undo/redo, word wrap, line numbers, tab/font settings, writing layout, paste cleanup, and text statistics.
- Integrated terminal: optional terminal for saved text/code files, disabled by default.
- Word documents: DOCX files open as editable extracted text copies. Legacy DOC files use an external converter when available.
- Updates: Settings-based updater UI with signed update manifest support for later alpha builds.
- Playback Engine v2: shared playback control layer and early embedded helper runtime work, kept behind the main playback path.
- Cache controls: preview, prepared video, and media probe caches can be reviewed and cleared from Settings.

## Architecture

- Tauri 2 desktop shell with Rust commands for Windows integration, file routing, helper tooling, and native dialogs.
- React frontend with viewer-specific modules under `src/viewers`.
- Shared player logic under `src/player`.
- UI components under `src/ui`.
- File-kind and window-profile helpers under `src/lib`.

Important files:

- `src/App.tsx`
- `src/player/settings.ts`
- `src/player/memory.ts`
- `src/player/capabilities.ts`
- `src/ui/TransportDock.tsx`
- `src/ui/MediaShelves.tsx`
- `src/ui/WindowChrome.tsx`
- `src-tauri/src/main.rs`
- `src-tauri/nsis/installer-hooks.nsh`

## Helper Tools

Release packages can bundle FFmpeg and FFprobe from `src-tauri/binaries/tools` for metadata, artwork, thumbnails, remux helpers, and accurate clip export. The large `.exe` files are packaging resources and are not committed to the source repository.

Helper-engine detection is early alpha. It is not a complete playback backend replacement yet.

## Windows Integration

- File associations are declared in `src-tauri/tauri.conf.json`.
- NSIS installer hooks register/unregister Open With capabilities.
- Per-filetype ProgIDs provide separate fallback icons for video, audio, image, PDF, text/code, and Word/document files.
- Windows `UserChoice` defaults are not modified directly.
- Real Explorer thumbnails are left to Windows and installed preview/codec providers.

## Current Limitations

- Native playback depends on Windows/WebView codec availability.
- MKV, TS, WebM, and less common codecs can vary by machine.
- Helper-engine fallback work is not yet a full embedded playback backend.
- DOC/DOCX handling is extraction-based and does not round-trip Word formatting.
- Legacy DOC preview needs LibreOffice or conversion to DOCX.
- PDF printing depends on the WebView/system print path and should be tested with real documents and printers.
- Automated regression coverage is still limited; alpha validation relies on the smoke checklist and practical testing.

## Source and Release Policy

- Users should download the latest Windows package from GitHub Releases.
- Source commits should not include installers, packaged ZIPs, `dist/`, Tauri `target/`, smoke media, logs, caches, local release artifacts, or FFmpeg/FFprobe `.exe` files.
- `src-tauri/binaries/tools/LICENSE-FFmpeg.txt` stays in the repository to document the helper license.
- Packaged installers and sendable ZIPs belong in GitHub Releases.
