# LMP Alpha Smoke Checklist

Quick regression checks for LMP alpha builds and larger changes.

## Build Gate

- `npm.cmd run build` passes.
- `cargo check --manifest-path src-tauri\Cargo.toml` passes.
- `npm.cmd run tauri -- build` produces a release executable and NSIS/MSI bundles.
- The NSIS installer installs successfully.
- `npm.cmd run verify:windows` passes after installing through NSIS, or after manually registering an unpackaged release executable.

## Module Smoke

Video:

- Opens MP4 from Open With/startup argument.
- Opens MKV/TS recognized files without replacing unrelated open windows.
- Play/pause, seek, speed, volume, fullscreen, mini-player, queue next/previous work.
- Create Clip/Trim can export a short MP4 from MP4, MKV, and TS inputs without overwriting the original.
- Trim export rejects invalid ranges and keeps audio roughly in sync.
- Unsupported native playback shows a useful fallback/error path instead of getting stuck.

Audio:

- Opens MP3 from Open With/startup argument.
- Does not auto-resume audio files.
- Compact window can be resized small without visible overlap or odd vertical drift.
- Play/pause, seek, speed, volume, queue, recents, library and info work.
- Audio tools do not show video-only actions such as captions, tracks, moments or A-B loop.

Image/GIF:

- Opens PNG/JPG/GIF.
- Zoom, fit, rotate, next/previous and library/recents work.
- Viewer stays non-scrollable at small window sizes.

PDF/Document:

- Opens PDF and keeps document scrolling internal to the viewer.
- Page next/previous, page overview, zoom, fit, reset and print dialog work.
- Print preview does not include LMP controls/chrome.
- DOCX opens directly as an editable extracted text copy.
- Saving an extracted DOCX copy creates or asks for a separate text file and does not modify the original Word document.

Text:

- Opens TXT/MD/JSON/code-like files.
- Editor scrolls normally.
- Search jumps to the active match.
- Save, Save As, Revert, undo/redo, word wrap, line numbers and syntax highlighting work.
- Unsaved-change close/open guard appears when expected.
- Plain-text metadata stays understandable for normal users, while line/column status remains visible.
- Optional integrated terminal is off by default, can be enabled, runs saved files, and handles missing shell/runtime messages cleanly.

Shared:

- Custom titlebar can move, minimize, maximize and close every viewer.
- More/tools panels close cleanly and do not break auto-hide.
- Recent, queue, library and info shelves do not overlap controls in small windows.
- Multiple Open With launches can create separate windows for unrelated files.

## Current Alpha Risks

Blockers:

- No hard blocker is known from the latest smoke pass.

High priority:

- Repeat the clean install/Open With test on a second Windows profile or VM before publishing a public alpha.
- GStreamer fallback is detected and callable, but not yet a seamless embedded playback backend.
- PDF printing needs a few real-world documents/printers checked after each print-flow change.
- Native/WebView codec support still varies by machine; release notes must state this clearly.
- Integrated terminal execution uses saved files, not unsaved editor drafts.

Medium priority:

- Library indexing is usable but not yet optimized for very large folders.
- Explorer icon/default-app cache can lag after association changes.
- Manual smoke coverage is still heavier than automated regression coverage.
