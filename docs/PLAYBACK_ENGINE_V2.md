# Playback Engine v2: LMP AV

LMP AV is LMP's own playback core. It replaces the earlier embedded libmpv,
native child-window and external GStreamer/MPV experiments, which were removed
because none of them composed with the WebView overlays or kept LMP in control
of the pipeline.

## What LMP owns

| Layer | Where | Notes |
| --- | --- | --- |
| Container parsing | `src-tauri/src/av/isobmff.rs`, `src-tauri/src/av/matroska.rs`, `src-tauri/src/av/mpegts.rs` | MP4/MOV/M4V/M4A (plain and fragmented), Matroska/WebM (cues, lacing, header stripping, zlib, chapters), MPEG-TS/M2TS (188/192/204-byte packets, PAT/PMT, PES, 33-bit timestamp unwrap, continuity checks) |
| Codec description | `src-tauri/src/av/codec.rs` | avcC, hvcC, vpcC, av1C, esds/AudioSpecificConfig, dOps, dfLa; VP9 and AV1 header parsers when the container carries no record; H.264/HEVC SPS parsers and ADTS/MPEG-audio/AC-3 header parsers for transport streams |
| Sample transport | `src-tauri/src/av/batch.rs`, `src/player/av/ipc.ts` | Binary batches over Tauri IPC, no JSON per sample |
| Sample feeding and buffering | `src/player/av/pipeline.ts` | ~3 s target buffer, byte cap, decode-queue backpressure |
| Media clock and A/V sync | `src/player/av/pipeline.ts`, `src/player/av/audioOutput.ts` | Audio clock derived from frames consumed by the worklet; wall clock for silent files |
| Audio output | `src/player/av/audioOutputWorklet.ts` | Own ring buffer, linear resampler, WSOLA pitch-preserving time stretch for 0.5x to 2x |
| Video presentation | `src/player/av/videoRenderer.ts` | Frame scheduling against the clock, late-frame dropping, cover/contain fit on a canvas |
| Seeking | both sides | Demuxer jumps to the key frame before the target (cues/sample tables, bitrate estimate plus forward scan for TS); the pipeline decodes and drops until the exact time. Seeks reach the backend strictly in order and block reads while they run |
| Tracks and subtitles | `src/player/av/subtitles.ts`, Tracks shelf | Audio and embedded subtitle track switching, SRT/ASS/WebVTT/tx3g cues, sidecar SRT/VTT |

Decoding of the compressed bitstreams goes through WebCodecs, which uses the
system hardware decoders. Writing H.264/HEVC/AV1 decoders from scratch is not a
realistic goal for this project, and software decoders would not keep up with
4K material anyway; everything around the decoder is LMP code.

## Engine selection

Settings - Engine offers three modes (`playbackEngine` in the settings file):

- **Auto** (default): LMP AV for MKV, MKA, WebM and MPEG-TS/M2TS, native
  WebView first for MP4/MOV and audio files. If the WebView reports an
  unsupported source, LMP AV takes over; if LMP AV cannot open a file (for
  example MPEG-2 video in a TS), the native path with the FFmpeg remux helper
  is used.
- **LMP AV**: prefer LMP AV for every container it understands.
- **Native**: always use the WebView media element.

`src/player/playbackEnginePolicy.ts` holds the rules. `src/app/useLmpAvEngine.ts`
bridges the player into the React app, `src/player/av/engine.ts` adapts it to
the shared `PlaybackEngine` contract used by transport controls, keyboard
handling, resume and progress saving.

## Supported today

- Containers: MP4, M4V, MOV, 3GP, M4A, MKV, MKA, WebM, WebA, TS, M2TS, MTS.
- Video: H.264, HEVC (with the Windows HEVC extension or hardware support), VP8,
  VP9, AV1 (where the system decodes them).
- Audio: AAC (also ADTS in TS and M2TS private streams without a format descriptor), Opus, Vorbis, FLAC, MP3, MPEG Layer II, PCM;
  AC-3/E-AC-3 only where the system WebCodecs implementation supports them.
  Files whose only audio is DTS or TrueHD play without sound and show a notice.
- Subtitles: embedded SRT, ASS/SSA (text only), WebVTT, tx3g; sidecar SRT/VTT.
- Chapters are parsed (Matroska, Nero `chpl`) and exposed in the media info.

## Not covered yet

- AVI, OGG and other containers still go through the native element.
- Interlaced H.264 (PAFF) and real broadcast or Blu-ray recordings are untested
  in the TS demuxer.
- Bitmap subtitles (PGS, VobSub), DTS/TrueHD audio, MPEG-2/MPEG-4 Part 2 video.
- A chapter UI and per-track delay controls.
- Outside 0.5x to 2x, playback falls back to plain resampling without pitch correction.

## Rules

- LMP controls stay the source of truth for volume, speed, seek, pause, resume,
  fullscreen and queue; the engine never bypasses settings or window behavior.
- The native WebView path stays available as a fallback and as the player for
  containers LMP AV does not read.
- Demuxer changes must keep `cargo test av::` green; the tests compare every
  packet against `ffprobe` for the generated fixtures.

## Debugging

- Dev builds expose the player as `window.__lmpAvPlayer`; `stats()` reports the
  active decoders, hardware acceleration, dropped frames, buffer levels and
  audio underruns, `snapshot()` the clock state.
- Start a dev build with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`
  to drive the WebView through the Chrome DevTools Protocol (screenshots,
  console, key events) without touching the window.
- Demuxer fixtures live in `src-tauri/target/av-fixtures` after `cargo test av::`.
