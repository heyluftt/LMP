# LMP v0.2.2 Alpha

Patch alpha after v0.2.1-alpha.

## Changes

- Improves the text and writing workspace.
- Fixes web and code paste behavior in the text editor.
- Adds word and character counts.
- Improves settings layout and cache separation.
- Improves queue controls and queue settings behavior.
- Improves video chrome hover behavior.
- Improves document extraction handling for Word files.
- Uses LibreOffice as an optional converter for legacy `.doc` files when available.

## Known Limitations

- Unsigned alpha build.
- Native playback still depends on Windows/WebView codec support.
- Helper-engine fallback work is early alpha and not the default playback path.
- Legacy `.doc` preview needs LibreOffice or conversion to `.docx`.
- Terminal execution uses saved files, not unsaved drafts.
- Shell scripts require bash in PATH.
- DOC/DOCX handling extracts editable text copies; it is not full Word editing.
