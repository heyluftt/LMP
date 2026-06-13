import { invoke } from "@tauri-apps/api/core";
import type {
  GstreamerPlaybackSession,
  GstreamerProbe,
  LibMpvCoreSession,
  LibMpvRenderFrameProbe,
  LibMpvRenderStatus,
  MpvPlaybackSession,
  NativeVideoSurfaceRect,
  NativeVideoSurfaceStatus,
} from "./types";

export const emptyGstreamerSession: GstreamerPlaybackSession = {
  active: false,
  path: null,
  pid: null,
  started_at: null,
};

export const emptyMpvSession: MpvPlaybackSession = {
  active: false,
  path: null,
  pid: null,
  started_at: null,
};

export const emptyLibMpvCoreSession: LibMpvCoreSession = {
  active: false,
  path: null,
  startedAt: null,
  ready: false,
  paused: true,
  position: 0,
  duration: 0,
  width: 0,
  height: 0,
  volume: 0,
  speed: 1,
  ended: false,
  error: null,
};

export function compactProbeSummary(probe: GstreamerProbe) {
  const summary = probe.summary
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" - ");

  return summary || "media recognized";
}

export function isGstreamerActiveFor(session: GstreamerPlaybackSession, path: string | null) {
  return Boolean(session.active && path && session.path === path);
}

export function isMpvActiveFor(session: MpvPlaybackSession, path: string | null) {
  return Boolean(session.active && path && session.path === path);
}

export function isLibMpvActiveFor(session: LibMpvCoreSession, path: string | null) {
  return Boolean(session.active && path && session.path === path);
}

export function probeGstreamer(path: string) {
  return invoke<GstreamerProbe>("probe_media_with_gstreamer", { path });
}

export function startGstreamerPlayback(path: string) {
  return invoke<GstreamerPlaybackSession>("start_gstreamer_playback", { path });
}

export function stopGstreamerPlayback() {
  return invoke<GstreamerPlaybackSession>("stop_gstreamer_playback");
}

export function readGstreamerPlaybackSession() {
  return invoke<GstreamerPlaybackSession>("get_gstreamer_playback_session");
}

export function startMpvPlayback(path: string, startSeconds?: number | null) {
  return invoke<MpvPlaybackSession>("start_mpv_playback", {
    path,
    startSeconds: startSeconds ?? null,
  });
}

export function stopMpvPlayback() {
  return invoke<MpvPlaybackSession>("stop_mpv_playback");
}

export function readMpvPlaybackSession() {
  return invoke<MpvPlaybackSession>("get_mpv_playback_session");
}

export function startLibMpvCoreSession(
  path: string,
  startSeconds?: number | null,
  volume?: number | null,
  speed?: number | null,
) {
  return invoke<LibMpvCoreSession>("start_libmpv_core_session", {
    path,
    startSeconds: startSeconds ?? null,
    volume: volume ?? null,
    speed: speed ?? null,
  });
}

export function startLibMpvSurfaceSession(
  path: string,
  rect: NativeVideoSurfaceRect,
  startSeconds?: number | null,
  volume?: number | null,
  speed?: number | null,
) {
  return invoke<LibMpvCoreSession>("start_libmpv_surface_session", {
    path,
    rect,
    startSeconds: startSeconds ?? null,
    volume: volume ?? null,
    speed: speed ?? null,
  });
}

export function startLibMpvRenderSession(
  path: string,
  rect: NativeVideoSurfaceRect,
  startSeconds?: number | null,
  volume?: number | null,
  speed?: number | null,
) {
  return invoke<LibMpvCoreSession>("start_libmpv_render_session", {
    path,
    rect,
    startSeconds: startSeconds ?? null,
    volume: volume ?? null,
    speed: speed ?? null,
  });
}

export function stopLibMpvCoreSession() {
  return invoke<LibMpvCoreSession>("stop_libmpv_core_session");
}

export function stopLibMpvSurfaceSession() {
  return invoke<LibMpvCoreSession>("stop_libmpv_surface_session");
}

export function stopLibMpvRenderSession() {
  return invoke<LibMpvCoreSession>("stop_libmpv_render_session");
}

export function readLibMpvCoreSession() {
  return invoke<LibMpvCoreSession>("get_libmpv_core_session");
}

export function readLibMpvRenderStatus() {
  return invoke<LibMpvRenderStatus>("get_libmpv_render_status");
}

export function probeLibMpvRenderFrame(path: string) {
  return invoke<LibMpvRenderFrameProbe>("probe_libmpv_render_frame", { path });
}

export function showNativeVideoSurface(rect: NativeVideoSurfaceRect) {
  return invoke<NativeVideoSurfaceStatus>("show_native_video_surface", { rect });
}

export function hideNativeVideoSurface() {
  return invoke<NativeVideoSurfaceStatus>("hide_native_video_surface");
}

export function destroyNativeVideoSurface() {
  return invoke<NativeVideoSurfaceStatus>("destroy_native_video_surface");
}

export function setLibMpvCorePaused(paused: boolean) {
  return invoke<LibMpvCoreSession>("set_libmpv_core_paused", { paused });
}

export function seekLibMpvCore(seconds: number) {
  return invoke<LibMpvCoreSession>("seek_libmpv_core", { seconds });
}

export function setLibMpvCoreVolume(volume: number) {
  return invoke<LibMpvCoreSession>("set_libmpv_core_volume", { volume });
}

export function setLibMpvCoreSpeed(speed: number) {
  return invoke<LibMpvCoreSession>("set_libmpv_core_speed", { speed });
}
