import type { MediaInspectionItem } from "./types";

export function isStreamInspectionItem(item: MediaInspectionItem) {
  return /^(video|audio|subtitle|data|attachment|stream)\b/i.test(item.label);
}

export function inspectionKindClass(item: MediaInspectionItem) {
  const label = item.label.toLowerCase();
  if (label.startsWith("video")) {
    return "video";
  }
  if (label.startsWith("audio")) {
    return "audio";
  }
  if (label.startsWith("subtitle")) {
    return "subtitle";
  }
  if (label.startsWith("data") || label.startsWith("attachment")) {
    return "data";
  }
  return "meta";
}

export function frameStepSecondsFromInspection(items: MediaInspectionItem[]) {
  for (const item of items) {
    const detail = item.detail ?? "";
    const match = detail.match(/\b(\d+(?:\.\d+)?)\s*fps\b/i);
    if (!match) {
      continue;
    }
    const fps = Number(match[1]);
    if (Number.isFinite(fps) && fps >= 1 && fps <= 240) {
      return 1 / fps;
    }
  }
  return 1 / 30;
}
