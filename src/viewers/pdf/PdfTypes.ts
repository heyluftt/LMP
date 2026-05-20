import type { PDFDocumentProxy } from "pdfjs-dist";

export type DocumentViewState = {
  page: number;
  zoom: number;
  fit: "page" | "width";
};

export type PdfLoadingTask = {
  promise: Promise<PDFDocumentProxy>;
  destroy: () => Promise<void>;
};

export type PdfScrollTarget = "top" | "bottom";

export type PdfZoomAnchor = {
  clientX: number;
  clientY: number;
  leftRatio: number;
  topRatio: number;
};

export const defaultDocumentView: DocumentViewState = {
  page: 1,
  zoom: 100,
  fit: "page",
};

export const pdfZoomLimits = {
  min: 40,
  max: 320,
};
