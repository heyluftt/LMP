import type { MediaFile, MediaFolderItem } from "../player/types";
import { extension, formatClock, mediaKind } from "./playerBrain";

type MediaDetails = {
  width: number | null;
  height: number | null;
  duration: number | null;
};

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

export function formatMediaMeta(
  kind: string,
  media: MediaFile | null,
  details: MediaDetails,
  fallback: string,
) {
  const parts = [fallback || kind];
  if (details.width && details.height) {
    parts.push(`${details.width}x${details.height}`);
  }
  if (details.duration && details.duration > 0) {
    parts.push(formatClock(details.duration));
  }
  if (media?.byte_len) {
    const size = formatBytes(media.byte_len);
    if (size) {
      parts.push(size);
    }
  }
  return parts.join(" - ");
}

export function formatModifiedDate(seconds?: number | null) {
  if (!seconds) {
    return "";
  }
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

export function libraryKindLabel(item: MediaFolderItem) {
  if (item.kind === "folder") {
    return "folder";
  }
  return item.kind || mediaKind(item.path);
}

export function mediaKindBadge(path: string) {
  const kind = mediaKind(path);
  const mediaExtension = extension(path);
  return mediaExtension ? `${kind} .${mediaExtension}` : kind;
}
