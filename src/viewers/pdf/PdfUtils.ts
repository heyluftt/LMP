import type { PageViewport } from "pdfjs-dist";

import { pdfZoomLimits, type DocumentViewState } from "./PdfTypes";

export function clampPdfPage(page: number, pageCount: number) {
  return Math.max(1, Math.min(Math.max(1, pageCount), page));
}

export function clampPdfZoom(zoom: number) {
  return Math.max(pdfZoomLimits.min, Math.min(pdfZoomLimits.max, zoom));
}

export function documentZoomLabel(view: DocumentViewState) {
  return view.fit === "width" ? "Width" : `${view.zoom}%`;
}

export function isPdfRenderingCancelled(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "RenderingCancelledException" ||
      error.message.toLowerCase().includes("rendering cancelled"))
  );
}

export function pdfErrorMessage(error: unknown, fallback = "Could not render PDF page.") {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

export function getPdfOutputScale() {
  return Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
}

export function resolvePdfCssScale(
  baseViewport: PageViewport,
  view: DocumentViewState,
  viewportElement: HTMLElement,
) {
  const bounds = viewportElement.getBoundingClientRect();
  const availableWidth = Math.max(260, bounds.width - 36);
  const widthFitScale = availableWidth / Math.max(1, baseViewport.width);
  const manualScale = clampPdfZoom(view.zoom) / 100;
  return Math.max(0.25, Math.min(4, view.fit === "width" ? widthFitScale : manualScale));
}

export function preparePdfCanvas(
  canvas: HTMLCanvasElement,
  cssViewport: PageViewport,
  outputScale: number,
) {
  const pixelWidth = Math.max(1, Math.ceil(cssViewport.width * outputScale));
  const pixelHeight = Math.max(1, Math.ceil(cssViewport.height * outputScale));
  const cssWidth = Math.max(1, Math.ceil(cssViewport.width));
  const cssHeight = Math.max(1, Math.ceil(cssViewport.height));
  const context = canvas.getContext("2d", { alpha: false });

  if (!context) {
    throw new Error("Canvas rendering is not available.");
  }

  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, pixelWidth, pixelHeight);

  return {
    context,
    cssHeight,
    cssWidth,
    pixelHeight,
    pixelWidth,
    transform:
      outputScale === 1
        ? undefined
        : ([outputScale, 0, 0, outputScale, 0, 0] as [number, number, number, number, number, number]),
  };
}

export function clearPdfCanvas(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (context) {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
  }
  canvas.removeAttribute("width");
  canvas.removeAttribute("height");
  canvas.style.removeProperty("width");
  canvas.style.removeProperty("height");
}
