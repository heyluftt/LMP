# LMP v0.1.2 Alpha

Patch alpha after v0.1.1-alpha.

## Changes

- Fixes playback startup and resume jumps for audio and video.
- Improves terminal session cleanup.
- Improves terminal event listener cleanup.
- Hardens window close cleanup.
- Throttles playback state updates.
- Moves blocking file operations off the IPC path.
- Delays non-critical startup checks.
- Improves PDF thumbnail and text-file detection stability.

## Known Limitations

- Still an unsigned alpha build.
- Native playback depends on Windows/WebView codec support.
- Terminal execution uses saved files, not unsaved drafts.
- Shell scripts require bash in PATH.
- DOC/DOCX handling extracts editable text copies; it is not full Word editing.
