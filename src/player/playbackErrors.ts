import { compactError, errorMessage } from "../lib/errorText";
import { canTryRemuxFallback } from "./playbackEnginePolicy";

export function describeMediaError(media: HTMLMediaElement) {
  switch (media.error?.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return "Playback was aborted.";
    case MediaError.MEDIA_ERR_NETWORK:
      return "The media file could not be read.";
    case MediaError.MEDIA_ERR_DECODE:
      return "The native media engine could not decode this file.";
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "This format is not supported by the native engine yet.";
    default:
      return "Playback failed.";
  }
}

export function isUnsupportedSourceError(error: unknown, media?: HTMLMediaElement) {
  const message = errorMessage(error).toLowerCase();
  return (
    media?.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ||
    message.includes("notsupportederror") ||
    message.includes("supported sources")
  );
}

export function describePlaybackProblem(
  error: unknown,
  media?: HTMLMediaElement,
  path?: string | null,
) {
  if (isUnsupportedSourceError(error, media)) {
    if (canTryRemuxFallback(path ?? null)) {
      return "This media file is recognized, but the native WebView engine cannot play its container/codec directly yet.";
    }

    return "This file is recognized by LMP, but the native WebView engine cannot play its container/codec yet.";
  }

  return compactError(error) || (media ? describeMediaError(media) : "Playback failed.");
}
