# Playback Engine v2

Playback Engine v2 is the long-term path for making LMP less dependent on WebView codec behavior while keeping the LMP window, controls, settings, queue, resume, and file workflow intact.

## Direction

- Keep the current native WebView playback as the default engine.
- Move playback commands and state behind a small shared engine contract.
- Add future engines behind the same contract instead of wiring them directly into the app shell.
- Prefer embedded playback cores over separate player windows.
- Keep engine selection behind a playback policy layer so unstable render paths cannot replace the user-facing player by accident.

## Phases

1. Define the shared engine contract and adapt the existing native playback path to it.
2. Move startup, resume, seek, volume, speed, and error handling toward the shared contract.
3. Add an embedded libmpv backend for formats where WebView playback is weak.
4. Consider a deeper LMP AV backend later, based on demux/decode/render pieces that LMP can control directly.

## Current Status

- The native WebView path implements the shared playback contract.
- Native engine access is centralized through the engine module.
- Startup load, resume seek, progress saving, transport seek, loop, repeat, trim preview, volume, and speed now go through that contract.
- Native media events still provide metadata, readiness, duration, and track details.
- The embedded MPV runtime can be detected and a paused in-process core session can be started, controlled, and stopped.
- The embedded MPV Render API can be loaded and a render context can be created and released for lifecycle validation.
- A small software frame probe can render one MPV frame into memory for backend validation.
- LMP can create, move, hide, and destroy a native Windows video surface inside the app window.
- LMP can start a libmpv session that targets the native video surface instead of an external MPV window.
- LMP has a first Render API worker that owns a WGL/OpenGL context on that surface and drives libmpv frames through LMP commands.
- The native child-window Render API path is not promoted to automatic playback because it does not compose reliably with WebView overlays.
- The user-facing Auto path currently means native WebView playback plus FFmpeg remux preparation where needed.
- The embedded path is not the default player yet; external fallback windows remain diagnostic only.

## Next Render Step

The next libmpv render target should be visible inside the WebView composition model instead of relying on a child HWND behind or above the WebView. Good candidates:

- software-frame bridge to a canvas as the first correctness target;
- GPU-backed D3D/ANGLE bridge after the frame ownership and timing model are stable.

Do not enable libmpv as the automatic playback path again until video, overlays, controls, volume, seek, resume, fullscreen, and window sizing all run through LMP without a separate native player surface.

## Rules

- LMP controls remain the source of truth for volume, speed, seek, pause, resume, fullscreen, and queue.
- External fallback windows are diagnostic only, not a normal playback experience.
- Engine changes should be incremental and keep the current native path stable.
- New backends should not bypass LMP settings or window behavior.
- Embedded rendering must be visible inside the LMP player area before it becomes a selectable default path.
- The Render API path needs overlay, timing, and lifecycle validation before replacing WebView playback.
