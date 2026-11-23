# LMP

LMP is a Windows-first media player and file viewer suite built with Tauri, React, TypeScript, and Rust.

Current alpha: `v0.3.0-alpha`. Download the Windows installer from the GitHub Releases page. Alpha builds are unsigned, so Windows SmartScreen may show a warning during download or installation.

## What It Does

LMP opens everyday media and document files from Windows Explorer or from inside the app:

- video playback
- audio playback
- image and GIF viewing
- PDF viewing
- text/code editing
- DOC/DOCX extracted text copy handling
- recent files, library navigation, drag and drop, and multi-window Open With routing

Video and audio play through LMP AV, the player's own engine: LMP reads MP4/MOV, MKV/WebM and MPEG-TS files with its own demuxers, keeps its own clock, A/V sync and renderer, and decodes through WebCodecs. The Windows/WebView media stack remains available as a second engine.

## Alpha Features

- Video controls, queue, repeat current, embedded and sidecar subtitles, audio and subtitle track switching, tracks/info shelves, A-B loop, moments, frame stepping, and accurate MP4 clip export.
- Engine choice per settings: Auto (LMP AV for MKV/WebM/TS, native first for MP4), LMP AV, or Native.
- Compact optional playback controls and a focused mini-player mode.
- Audio playback with compact now-playing UI, metadata/artwork helpers, speed, volume, recents, and library.
- Image/GIF viewer with zoom, fit, rotate, and navigation.
- PDF viewer with page navigation, zoom, page overview, smooth scrolling, drag/pan, and print dialog.
- Text/code editor with CodeMirror 6: File/Edit/View menus, find and replace with case, whole-word and regex options (including `$1` groups), go to line (`line:column`), multiple cursors, folding, comment toggling, line moves, sort/case/whitespace transforms, zoom, and a status bar for language, encoding, line endings and indentation.
- Encodings: UTF-8 (with or without BOM), UTF-16 LE/BE (also without BOM) and common Windows, ISO, DOS and Asian code pages. Files that are not valid UTF-8 open with the Windows default code page. "Reopen with Encoding" reinterprets a file and "Save with Encoding" converts it; characters the target encoding cannot store are reported before anything is written.
- New documents with a chosen language; Save As suggests a matching extension. Unsaved changes ask Save / Don't Save / Cancel before another file opens, before going home and before the window closes.
- Read-only and binary files open locked with an "Edit anyway" option; saving a read-only file can clear the flag. Changes made by other programs are detected when the window gets focus and before saving.
- Crash-safe drafts per document: unsaved text comes back after a crash, is offered again when the file is reopened, and is listed on the home screen.
- Files up to 64 MB open; above 8 MB or with very long lines the editor switches to a lighter mode without highlighting, folding and drafts.
- Optional integrated terminal for saved text/code files, disabled by default.
- DOC/DOCX files open as extracted editable text. The original document is not modified.
- In-app updates: Settings checks the signed update manifest in this repository and installs newer releases.
- Windows file associations and separate fallback icons for video, audio, image, PDF, text/code, and Word/document files, plus an "Edit with LMP" Explorer context menu entry for text/code files.

## Helpers and Limits

Release packages bundle FFmpeg and FFprobe helper tools for metadata, artwork, thumbnails, the remux fallback for the native engine, and clip export. They are not part of the playback path. The large helper binaries are not committed to the source repository.

Decoding uses the system WebCodecs decoders. H.264, VP8/VP9, AAC, Opus, Vorbis, FLAC and MP3 are available everywhere; HEVC and AV1 need the Windows extensions or hardware support. AVI and other rare containers still go through the WebView element.

DOC/DOCX support is extraction-based and is not a full Word replacement. The text editor opens files up to 64 MB. `.ts` and `.mts` files are recognized by their content: transport streams play as video, TypeScript sources open in the editor. PDF printing uses the WebView/system print path and should be tested with real documents and printers.

## Development

```powershell
npm.cmd install
npm.cmd run tauri dev
```

Build checks:

```powershell
npm.cmd run build
cargo check --manifest-path src-tauri\Cargo.toml
npm.cmd run tauri -- build
```

A release build needs the updater signing key. This script asks for its password, builds the signed NSIS installer and writes `updater/latest.json` from the matching `CHANGELOG.md` section:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-release.ps1
```

Windows Open With registration is handled by the installer. For development or unpackaged release testing:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-windows-open-with.ps1
npm.cmd run verify:windows
```

## Documentation

- [Project status](docs/PROJECT_STATUS.md)
- [Playback engine (LMP AV)](docs/PLAYBACK_ENGINE_V2.md)
- [Alpha smoke checklist](docs/ALPHA_SMOKE_CHECKLIST.md)
- [Design notes](DESIGN.md)
- [Changelog](CHANGELOG.md)

Release installers, packaged ZIPs, build output, smoke media, caches, and local helper binaries are intentionally not committed. Packaged installers belong in GitHub Releases.
