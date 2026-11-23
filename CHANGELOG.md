# Changelog

## 0.3.0 alpha (2026-11-23)

This release starts a new repository. Installers of earlier versions are no longer published.

Playback

- New playback engine, LMP AV. LMP reads MP4/MOV, Matroska/WebM and MPEG-TS/M2TS files with its own demuxers, decodes through WebCodecs with hardware acceleration, and keeps its own clock, A/V sync, audio output and video renderer.
- Settings has an Engine page with Auto, LMP AV and Native. Auto uses LMP AV for MKV, WebM and transport streams and the WebView player first for MP4 and audio files, and each falls back to the other.
- Audio and embedded subtitle tracks can be switched while playing. Subtitles come from SRT, ASS/SSA, WebVTT and tx3g tracks or sidecar SRT/VTT files.
- Speeds from 0.5x to 2x keep the pitch.
- Seeking lands on the exact frame, also when the timeline is dragged quickly.
- AVCHD and other M2TS files with AAC or MP2 audio now play with sound.
- The embedded libmpv player, the native child-window surface and the external GStreamer and MPV paths were removed.

Text editor

- The editor was rebuilt with a File/Edit/View menu bar, a find and replace bar with regex and `$1` groups, go to `line:column`, multiple cursors, folding and a status bar for language, encoding, line endings and indentation.
- Encodings are detected on open, including UTF-16 without BOM and Windows code pages, and can be changed with "Reopen with Encoding" and "Save with Encoding".
- Unsaved changes ask Save, Don't Save or Cancel before another file opens or the window closes. Changes made by other programs are detected.
- Each document keeps its own crash-safe draft. Drafts are offered again when the file is reopened and are listed on the home screen.
- Read-only and binary files open locked. Files up to 64 MB open; large files use a lighter mode.
- `.ts` and `.mts` files are recognized by content, so TypeScript sources open in the editor and transport streams in the player.
- Text and code files get an "Edit with LMP" entry in the Explorer context menu.

Interface

- Scrollbars, text selection and the library sort menu follow the app colors.
- Focus rings on buttons and sliders appear only during keyboard navigation.
- Buttons give a small press feedback; animation timings use shared tokens.

## 0.2.2 alpha (2026-06-21)

- Improved the text and writing workspace, with word and character counts and cleaner web and code paste.
- Improved settings layout, cache separation and queue controls.
- Improved video control hover behavior and Word document extraction. Legacy `.doc` files use LibreOffice when it is installed.

## 0.2.1 alpha (2026-06-13)

- Refined the compact playback bar and the mini player, which stays on top only while active.
- Polished the video overlay and startup.

## 0.2.0 alpha (2026-06-08)

- Added the LMP home screen and a quick New Text flow.
- Improved video window sizing, the transparent video title bar and the overlay controls.
- Improved playback startup and resume, the updater, settings, PDF rendering and Open With handling.

## 0.1.3 alpha (2026-05-23)

- First build with in-app updates through signed update manifests.
- Added cache controls and a media probe cache.

## 0.1.2 alpha (2026-05-21)

- Fixed jumps when playback starts or resumes.
- Cleaned up terminal sessions and window closing, and moved blocking file work off the IPC path.

## 0.1.0 alpha (2026-05-20)

- First public alpha: video and audio player, image and GIF viewer, PDF viewer, text and code editor, DOC/DOCX text extraction, optional terminal for saved files, Windows Open With integration and per-type file icons.
