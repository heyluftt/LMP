# LMP v0.1.0 Alpha

Prepared release notes for the first public alpha of LMP. The GitHub Release has not been published yet.

## What is LMP?

LMP is a Windows-first media player and file viewer suite built with Tauri, React, TypeScript, and Rust.

It currently focuses on opening everyday files quickly from Windows Explorer: video, audio, images/GIFs, PDFs, text/code files, and DOC/DOCX files as editable extracted text copies.

## Highlights

- Native Windows/WebView-first video and audio playback.
- Multi-window Open With routing for video, image, PDF, text, and document files.
- Optional single-window replacement behavior for audio files.
- Custom LMP UI with compact controls, shelves, recents, library, and viewer-specific tools.
- Text/code editor based on CodeMirror 6 with search, replace, save, revert, word wrap, line numbers, syntax highlighting, and basic programmer settings.
- Optional integrated terminal for saved text/code files, disabled by default.
- DOC/DOCX opens as an editable extracted text copy. The original document remains unchanged.
- FFmpeg/FFprobe helper tools for probing, thumbnails, remux helpers, and MP4 clip export.
- Separate Windows filetype icons for video, audio, image, PDF, text/code, and Word/document files.

## Included Features

- Video playback with queue, repeat current, autoplay-next setting, subtitles, A-B loop, info/tracks shelves, moments, and trim/export.
- Audio playback with compact now-playing view, metadata/artwork helpers, speed/volume controls, queue, recents, and library.
- Image/GIF viewer with zoom, fit, rotate, navigation, recents, and library.
- PDF viewer with page navigation, zoom, page overview, smooth scroll, drag/pan behavior, and print dialog.
- Text/code editor with lazy-loaded language highlighting, save/save-as, revert, search/replace, go-to-line, undo/redo, line/column status, configurable font, line numbers, tab size, and word wrap.
- Optional integrated terminal for running saved text/code files, disabled by default.
- DOCX/DOC-style document handling through editable extracted text copies.
- Windows Open With integration and per-filetype fallback icons.

## Helper Tools

The Windows alpha installer bundles FFmpeg and FFprobe helper binaries for:

- metadata and media probing
- audio artwork extraction
- video thumbnails and preview helpers
- TS/MTS/M2TS remux helpers
- accurate MP4 clip export

GStreamer is not bundled. LMP can detect a separately installed GStreamer runtime, but it is not a complete in-app fallback backend in this alpha.

## Known Limitations

- This build is unsigned. Windows SmartScreen or the browser may warn before installation.
- Native playback depends on Windows/WebView codec support. MP4/H.264 and common audio formats are most reliable.
- MKV, TS, WebM, and other containers may vary by codec and machine. Some files may need helper paths or future fallback work.
- Integrated terminal execution uses saved files, not unsaved editor drafts.
- `.sh` execution requires `bash` to be available in `PATH`.
- DOC/DOCX support is not a Word replacement. LMP extracts readable text into an editable copy and never overwrites the original document.
- PDF printing works through the WebView/system print path and still needs broader printer/document testing.
- Create Clip uses accurate MP4 export with re-encoding. It is designed for precise/compatible clips, not lossless editing.
- Explorer thumbnails are delegated to Windows and installed codec/preview providers. LMP provides fallback filetype icons.

## Release Assets

When the release is published, use the files attached to the GitHub Release. Expected user-facing files:

- `LMP_0.1.0_x64-setup.exe`
- `README-FIRST.txt` or `README.txt`
- `KNOWN-LIMITATIONS.txt`
- `LICENSE-FFmpeg.txt`
- `RELEASE_NOTES_v0.1.0-alpha.md`

## Tester Checklist

Please test with files you actually use:

- Open MP4/MKV/TS video files from Explorer.
- Open MP3/WAV/FLAC audio files and try opening a second audio file with multiple-audio-windows on/off.
- Open JPG/PNG/GIF images and try zoom/fit/rotate.
- Open PDFs and test scrolling, zooming, page overview, and print preview.
- Open TXT/MD/JSON/code-like files and test editing, save, save as, revert, search, and syntax highlighting.
- Open DOCX/DOC files and confirm they open as editable extracted text copies.
- Create a short video clip and confirm the original video is unchanged.
- Try opening multiple unrelated files at the same time and confirm existing windows stay stable.

Please report:

- the file type/container/codec if playback fails
- whether the file opened from Explorer or inside LMP
- any window that cannot move/close
- broken file icons or wrong default-app behavior
- print preview problems
- text editor save/revert issues
