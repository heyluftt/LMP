# LMP Alpha Smoke Checklist

Quick regression checks for LMP alpha builds and larger changes. Current public alpha: `v0.3.0-alpha`.

## Build Gate

- `npm.cmd run build` passes.
- `cargo check --manifest-path src-tauri\Cargo.toml` passes.
- `cargo test --manifest-path src-tauri\Cargo.toml` passes (demuxers, encoding detection and conversion, save guards, draft store, `.ts` detection).
- `npm.cmd run tauri -- build` produces a release executable and NSIS/MSI bundles.
- The NSIS installer installs successfully.
- `npm.cmd run verify:windows` passes after installing through NSIS, or after manually registering an unpackaged release executable.

## Module Smoke

Video:

- Opens MP4 from Open With/startup argument.
- Opens MKV/TS recognized files without replacing unrelated open windows.
- MKV, WebM, TS and M2TS files play through LMP AV (Tracks shelf shows "LMP AV"); audio and embedded subtitle tracks can be switched.
- Dragging the timeline quickly lands on the last position, not an earlier one.
- Switching Settings - Engine between Auto, LMP AV and Native re-opens the current file with the chosen engine.
- `cargo test av::` passes (demuxer fixtures are generated with the bundled FFmpeg).
- Play/pause, seek, speed, volume, fullscreen, mini-player, compact controls, queue next/previous work.
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

- Opens PDF and keeps document scrolling inside the viewer.
- Page next/previous, page overview, zoom, fit, reset and print dialog work.
- Print preview does not include LMP controls/chrome.
- DOCX opens directly as an editable extracted text copy.
- Legacy DOC shows extracted text through an available converter or a clear converter-needed message.
- Saving an extracted DOCX copy creates or asks for a separate text file and does not modify the original Word document.

Text:

- Opens TXT/MD/JSON/code-like files from Open With, the file dialog, drag and drop, and extensionless names such as `Dockerfile` or `.gitignore`.
- A TypeScript `.ts` file opens in the editor with TypeScript highlighting; an MPEG-TS `.ts` video opens in the player.
- An empty file created with Windows "New > Text Document" opens and saves.
- Encoding: UTF-8, UTF-8 BOM and UTF-16 files keep their encoding on save; a Windows-1252 file opens with readable umlauts and euro signs plus a "not valid UTF-8" notice; "Reopen with Encoding" and "Save with Encoding" work from the status bar; saving characters that do not fit the encoding offers "Save as UTF-8".
- Line endings: CRLF/LF are kept on save, mixed files show a notice and are unified, the status bar switches LF/CRLF.
- New Text / Ctrl+N creates `Untitled.txt`; choosing a language renames it (for example `Untitled.md`) and Save As suggests that extension.
- Save, Save As, Revert, undo/redo, word wrap, line numbers, whitespace and syntax highlighting work; Ctrl+S on an untitled document opens Save As.
- Find/replace: case, whole word and regex options, F3/Shift+F3, replace all with `$1` is one undo step; Ctrl+G accepts `line:column`.
- Opening another file, going home (Ctrl+W) or closing the window with unsaved changes asks Save / Don't Save / Cancel; Cancel keeps the text.
- Read-only files open locked; "Edit anyway" plus save offers "Remove read-only and save". Binary files open locked with a warning.
- Changing the open file in another program: a clean document reloads on focus, a dirty one shows "Changed on disk" and saving asks Overwrite / Reload.
- Drafts: after a crash or reload the newest draft reopens with a "Draft restored" notice; other drafts are listed on the home screen; reopening a file with a draft asks Restore / Discard / Not now.
- A file above 8 MB opens in large-file mode within about a second and stays responsive; files above 64 MB are refused with a clear message.
- Web prose paste and code paste keep clean line structure.
- Status bar shows line/column, selection, counts, indentation, encoding, line ending and language.
- Optional integrated terminal is off by default, can be enabled, runs saved files, and handles missing shell/runtime messages cleanly.
- Settings update panel can check for updates without blocking normal Settings use.
- Cache controls show preview, prepared video, and media probe cache actions clearly.

Shared:

- Custom titlebar can move, minimize, maximize and close every viewer.
- More/tools panels close cleanly and do not break auto-hide.
- Recent, queue, library and info shelves do not overlap controls in small windows.
- Mini-player stays on top only while active and returns to normal window behavior after exit.
- Multiple Open With launches can create separate windows for unrelated files.
- Dropping files onto a window opens them; several text files open in separate windows.
- Explorer shows "Edit with LMP" for text/code files after installation (Windows 11: "Show more options").

## Current Alpha Risks

Blockers:

- No hard blocker is known from the latest smoke pass.

High priority:

- Repeat the clean install/Open With test on a second Windows profile or VM before publishing a public alpha.
- LMP AV is new: watch A/V sync after long seeks, speed changes and audio track switches on real-world files.
- PDF printing needs a few real-world documents/printers checked after each print-flow change.
- Native/WebView codec support still varies by machine; release notes must state this clearly.
- Integrated terminal execution uses saved files, not unsaved editor drafts.
- The rebuilt text editor is new: watch draft restore, external change detection and code page saving on real files.

Medium priority:

- Library indexing is usable but not yet optimized for very large folders.
- Explorer icon/default-app cache can lag after association changes.
- Manual smoke coverage is still heavier than automated regression coverage.
