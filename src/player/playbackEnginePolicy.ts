import { extension as mediaExtension, type MediaKind } from "../lib/playerBrain";
import { lmpAvSupportsPath } from "./av/support";
import type { PlayerSettings } from "./settings";
import type { PlaybackBackendStatus } from "./types";

export type PlaybackEngineChoice = PlayerSettings["playbackEngine"];
export type PlaybackEngineKind = "lmp-av" | "native";

/** Containers the WebView stack cannot open directly and FFmpeg can remux without re-encoding. */
const remuxBeforeNativeExtensions = new Set(["ts", "mts", "m2ts", "mkv", "mka"]);
const remuxFallbackExtensions = new Set(["ts", "mts", "m2ts", "mp4", "m4v", "mov", "mkv", "mka"]);
/**
 * Containers where LMP AV is the better first choice because the WebView needs
 * a remux copy. The FFmpeg remux stays as the fallback when LMP AV cannot open
 * the file (e.g. MPEG-2 video or scrambled transport streams).
 */
const avFirstExtensions = new Set(["mkv", "mka", "webm", "weba", "ts", "mts", "m2ts"]);

export type PlaybackStartupPlan = {
  engine: PlaybackEngineKind;
  /** Remux through FFmpeg before handing the file to the WebView element. */
  prepareForNative: boolean;
  /** When LMP AV fails to open the file, continue with the native path. */
  nativeFallback: boolean;
  reason: string;
};

export function canTryRemuxFallback(path: string | null) {
  return Boolean(path && remuxFallbackExtensions.has(mediaExtension(path)));
}

export function canUseDirectAfterPrepFailure(path: string | null) {
  return Boolean(path && ["mkv", "mka"].includes(mediaExtension(path)));
}

export function canUseLmpAv(
  path: string | null,
  choice: PlaybackEngineChoice,
  avAvailable: boolean,
) {
  return avAvailable && choice !== "native" && lmpAvSupportsPath(path);
}

export function resolvePlaybackStartupPlan(
  path: string,
  kind: MediaKind,
  choice: PlaybackEngineChoice,
  avAvailable: boolean,
): PlaybackStartupPlan {
  const timed = kind === "video" || kind === "audio";
  const extension = mediaExtension(path);
  const avSupported = timed && canUseLmpAv(path, choice, avAvailable);
  const prepareForNative = timed && remuxBeforeNativeExtensions.has(extension);

  if (!timed) {
    return { engine: "native", prepareForNative: false, nativeFallback: false, reason: "static" };
  }
  if (choice === "lmp-av" && avSupported) {
    return {
      engine: "lmp-av",
      prepareForNative,
      nativeFallback: true,
      reason: "LMP AV selected in settings.",
    };
  }
  if (choice === "auto" && avSupported && avFirstExtensions.has(extension)) {
    return {
      engine: "lmp-av",
      prepareForNative,
      nativeFallback: true,
      reason: "LMP AV plays this container without a remux copy.",
    };
  }
  return {
    engine: "native",
    prepareForNative,
    nativeFallback: false,
    reason:
      choice === "native"
        ? "Native WebView selected in settings."
        : avSupported
          ? "Native WebView first; LMP AV takes over if the WebView cannot decode the file."
          : "Native WebView playback.",
  };
}

export function playbackPathLabel(choice: PlaybackEngineChoice, avAvailable: boolean) {
  if (choice === "native") {
    return "Native only";
  }
  if (!avAvailable) {
    return choice === "lmp-av" ? "LMP AV unavailable" : "Auto: native";
  }
  if (choice === "lmp-av") {
    return "LMP AV preferred";
  }
  return "Auto: LMP AV + native";
}

export function playbackBackendHint(
  choice: PlaybackEngineChoice,
  playbackBackends: PlaybackBackendStatus[],
  avAvailable: boolean,
) {
  const ffmpegBackend = playbackBackends.find((backend) => backend.id === "ffmpeg-helper");
  return [
    playbackPathLabel(choice, avAvailable),
    avAvailable ? "WebCodecs ready" : "WebCodecs missing",
    ffmpegBackend?.available ? "FFmpeg helper ready" : null,
  ]
    .filter(Boolean)
    .join(" - ");
}

export function describeActiveEngine(engine: PlaybackEngineKind | null, hardware: boolean) {
  if (engine === "lmp-av") {
    return hardware ? "LMP AV - hardware decode" : "LMP AV - software decode";
  }
  if (engine === "native") {
    return "Native WebView";
  }
  return "No media";
}

export function playbackBackendDisplay(backend: PlaybackBackendStatus) {
  if (backend.id === "ffmpeg-helper") {
    return {
      role: "helper",
      status: backend.available ? "remux - thumbnails - export" : "missing",
      title: backend.hint ?? undefined,
    };
  }

  return {
    role: backend.role,
    status: backend.available ? backend.version ?? "ready" : "missing",
    title: backend.hint ?? undefined,
  };
}
