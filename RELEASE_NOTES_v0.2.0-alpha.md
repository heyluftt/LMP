# LMP v0.2.0 Alpha

Patch/feature alpha after v0.1.3-alpha.

## Changes

- Adds LMP Home hub.
- Adds quick New Text flow.
- Improves video window sizing.
- Improves transparent video titlebar.
- Improves overlay controls.
- Adds Playback Engine v2 foundation.
- Improves playback startup and resume behavior.
- Adds optional MPV fallback detection.
- Improves updater support.
- Improves settings polish.
- Improves Home file picker filters.
- Improves media inspection caching and cache controls.
- Improves PDF viewer rendering and thumbnail stability.
- Improves Open With and secondary process cleanup.
- Improves terminal session cleanup and event handling.

## Known Limitations

- Unsigned alpha build.
- Native playback still depends on Windows/WebView codec support.
- MPV is optional and must be available locally or in PATH.
- Terminal execution uses saved files, not unsaved drafts.
- Shell scripts require bash in PATH.
- DOC/DOCX handling extracts editable text copies; it is not full Word editing.
