# LMP v0.2.1 Alpha

Patch alpha after v0.2.0-alpha.

## Changes

- Refines the optional compact playback bar.
- Improves mini-player behavior and keeps it on top only while active.
- Reduces mini-player chrome and metadata overlays.
- Improves video overlay polish and startup smoothness.
- Continues Playback Engine v2 and embedded helper runtime groundwork.
- Keeps the main playback path stable while fallback work remains opt-in.

## Known Limitations

- Unsigned alpha build.
- Native playback still depends on Windows/WebView codec support.
- Helper-engine fallback work is early alpha and not the default playback path.
- Terminal execution uses saved files, not unsaved drafts.
- Shell scripts require bash in PATH.
- DOC/DOCX handling extracts editable text copies; it is not full Word editing.
