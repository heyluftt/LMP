import { invoke } from "@tauri-apps/api/core";
import type { GstreamerPlaybackSession, GstreamerProbe } from "./types";

export const emptyGstreamerSession: GstreamerPlaybackSession = {
  active: false,
  path: null,
  pid: null,
  started_at: null,
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
