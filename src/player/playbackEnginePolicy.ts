import { extension as mediaExtension, type MediaKind } from "../lib/playerBrain";
import type { PlayerSettings } from "./settings";
import type { PlaybackBackendStatus } from "./types";

const remuxBeforeNativeExtensions = new Set(["ts", "mts", "m2ts", "mkv"]);
const remuxFallbackExtensions = new Set(["ts", "mts", "m2ts", "mp4", "m4v", "mov", "mkv"]);

export type PlaybackStartupPlan = {
  mode: "native" | "embedded-mpv" | "gstreamer";
  prepareForNative: boolean;
  useEmbeddedRenderer: boolean;
  embeddedRendererReason: string | null;
};

export function canTryRemuxFallback(path: string | null) {
  return Boolean(path && remuxFallbackExtensions.has(mediaExtension(path)));
}

export function canUseDirectAfterPrepFailure(path: string | null) {
  return Boolean(path && mediaExtension(path) === "mkv");
}

export function resolvePlaybackStartupPlan(
  path: string,
  kind: MediaKind,
  fallbackEngine: PlayerSettings["fallbackEngine"],
): PlaybackStartupPlan {
  const staticKind = kind === "image" || kind === "document" || kind === "text";
  const videoOrAudio = kind === "video" || kind === "audio";
  const embeddedPath = fallbackEngine === "embedded-mpv" && kind === "video";
  const gstreamerPath = fallbackEngine === "gstreamer" && videoOrAudio && !staticKind;
  const nativePath = !embeddedPath && !gstreamerPath;

  return {
    mode: embeddedPath ? "embedded-mpv" : gstreamerPath ? "gstreamer" : "native",
    prepareForNative:
      nativePath &&
      fallbackEngine !== "off" &&
      videoOrAudio &&
      remuxBeforeNativeExtensions.has(mediaExtension(path)),
    useEmbeddedRenderer: embeddedPath,
    embeddedRendererReason:
      kind === "video"
        ? embeddedPath
          ? "Embedded MPV render path selected."
          : "Embedded MPV render path is opt-in while the native WebView path stays primary."
        : null,
  };
}

export function playbackPathLabel(
  fallbackEngine: PlayerSettings["fallbackEngine"],
  playbackBackends: PlaybackBackendStatus[],
) {
  if (fallbackEngine === "off") {
    return "Native only";
  }
  if (fallbackEngine === "gstreamer") {
    const gstreamer = playbackBackends.find((backend) => backend.id === "gstreamer");
    return gstreamer?.available ? "GStreamer selected" : "GStreamer missing";
  }
  if (fallbackEngine === "embedded-mpv") {
    const libmpv = playbackBackends.find((backend) => backend.id === "libmpv");
    return libmpv?.available ? "Embedded MPV selected" : "Embedded MPV missing";
  }
  return "Auto: native/remux first";
}

export function playbackBackendHint(
  fallbackEngine: PlayerSettings["fallbackEngine"],
  playbackBackends: PlaybackBackendStatus[],
) {
  const nativeBackend = playbackBackends.find((backend) => backend.id === "native-webview");
  const libmpvBackend = playbackBackends.find((backend) => backend.id === "libmpv");
  const ffmpegBackend = playbackBackends.find((backend) => backend.id === "ffmpeg-helper");
  return [
    nativeBackend?.name ?? "Native WebView",
    fallbackEngine !== "off" ? playbackPathLabel(fallbackEngine, playbackBackends) : null,
    ffmpegBackend?.available ? "FFmpeg remux ready" : null,
    libmpvBackend?.available ? "Embedded MPV ready" : null,
  ]
    .filter(Boolean)
    .join(" - ");
}

export function playbackBackendDisplay(backend: PlaybackBackendStatus) {
  if (backend.id === "libmpv") {
    return {
      role: "experimental",
      status: backend.available ? "detected" : "missing",
      title: backend.available
        ? "MPV runtime detected. Automatic playback uses native/remux until embedded rendering is reliable."
        : backend.hint ?? undefined,
    };
  }

  if (backend.id === "ffmpeg-helper") {
    return {
      role: "helper",
      status: backend.available ? "remux ready" : "missing",
      title: backend.hint ?? undefined,
    };
  }

  return {
    role: backend.role,
    status: backend.available ? backend.version ?? "ready" : "missing",
    title: backend.hint ?? undefined,
  };
}
