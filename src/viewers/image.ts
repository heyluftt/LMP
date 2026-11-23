export type ImageFitMode = "contain" | "cover" | "actual";

export type ImageViewState = {
  fit: ImageFitMode;
  zoom: number;
  rotation: number;
  offsetX: number;
  offsetY: number;
};

export type ImageDragState = {
  pointerId: number;
  startX: number;
  startY: number;
  baseX: number;
  baseY: number;
};

export const defaultImageView: ImageViewState = {
  fit: "contain",
  zoom: 1,
  rotation: 0,
  offsetX: 0,
  offsetY: 0,
};

export function clampImageZoom(value: number) {
  return Math.max(0.25, Math.min(6, Math.round(value * 100) / 100));
}

export function nextImageFit(fit: ImageFitMode): ImageFitMode {
  if (fit === "contain") {
    return "cover";
  }
  if (fit === "cover") {
    return "actual";
  }
  return "contain";
}
