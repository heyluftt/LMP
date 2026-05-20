# LMP

LMP is a Windows-first media player and file viewer suite built with Tauri, React, TypeScript, and Rust.

When `v0.1.0-alpha` is available, use the files attached to the GitHub Release. The first alpha will be a Windows x64 build and will be unsigned, so Windows SmartScreen may show a warning during download or installation.

## What It Does

LMP opens everyday media and document files from Windows Explorer or from inside the app:

- video playback
- audio playback
- image and GIF viewing
- PDF viewing
- text/code editing
- DOC/DOCX extracted text copy handling
- recent files, library navigation, and multi-window Open With routing

The first playback path uses the Windows/WebView media stack. LMP does not bundle mpv or VLC.

## Alpha Features

- Video controls, queue, repeat current, subtitles, tracks/info shelves, A-B loop, moments, and accurate MP4 clip export.
- Audio playback with compact now-playing UI, metadata/artwork helpers, speed, volume, recents, and library.
- Image/GIF viewer with zoom, fit, rotate, and navigation.
- PDF viewer with page navigation, zoom, page overview, smooth scrolling, drag/pan, and print dialog.
- Text/code editor with CodeMirror 6, syntax highlighting, search/replace, save/save-as, revert, undo/redo, line numbers, word wrap, and editor settings.
- Optional integrated terminal for saved text/code files, disabled by default.
- DOC/DOCX files open as extracted editable text. The original document is not modified.
- Windows file associations and separate fallback icons for video, audio, image, PDF, text/code, and Word/document files.

## Helpers and Limits

Release packages bundle FFmpeg and FFprobe helper tools for metadata, artwork, thumbnails, remux helpers, and clip export. The large helper binaries are not committed to the source repository.

GStreamer is optional and not bundled. LMP can detect an installed runtime, but it is not a complete in-app fallback backend in this alpha.

Playback support depends on Windows/WebView codec availability. MP4/H.264 and common audio formats are the most reliable. MKV, TS, WebM, and less common codecs can vary by machine.

DOC/DOCX support is extraction-based and is not a full Word replacement. PDF printing uses the WebView/system print path and should be tested with real documents and printers.

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

Windows Open With registration is handled by the installer. For development or unpackaged release testing:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-windows-open-with.ps1
npm.cmd run verify:windows
```

## Documentation

- [Project status](docs/PROJECT_STATUS.md)
- [Alpha smoke checklist](docs/ALPHA_SMOKE_CHECKLIST.md)
- [v0.1.0 alpha release notes](docs/RELEASE_NOTES_v0.1.0-alpha.md)

Release installers, packaged ZIPs, build output, smoke media, caches, and local helper binaries are intentionally not committed. Packaged installers belong in GitHub Releases.
