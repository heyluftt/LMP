import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import type { RefObject } from "react";
import { useEffect, useRef } from "react";

import type { DocumentViewState } from "./PdfTypes";
import {
  clearPdfCanvas,
  clampPdfPage,
  getPdfOutputScale,
  isPdfRenderingCancelled,
  pdfErrorMessage,
  preparePdfCanvas,
  resolvePdfCssScale,
} from "./PdfUtils";

type PdfPageCanvasProps = {
  layoutTick: number;
  onPageClamped: (page: number) => void;
  onRenderError: (message: string) => void;
  onRenderStart: () => void;
  onRenderSuccess: () => void;
  pdf: PDFDocumentProxy;
  title: string;
  view: DocumentViewState;
  viewportRef: RefObject<HTMLDivElement | null>;
};

export function PdfPageCanvas({
  layoutTick,
  onPageClamped,
  onRenderError,
  onRenderStart,
  onRenderSuccess,
  pdf,
  title,
  view,
  viewportRef,
}: PdfPageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const renderSequenceRef = useRef(0);

  useEffect(
    () => () => {
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const viewportElement = viewportRef.current;
    if (!canvas || !viewportElement) {
      return;
    }

    const sequence = renderSequenceRef.current + 1;
    renderSequenceRef.current = sequence;
    let cancelled = false;
    let page: PDFPageProxy | null = null;

    renderTaskRef.current?.cancel();
    renderTaskRef.current = null;
    onRenderStart();

    const renderPage = async () => {
      let task: RenderTask | null = null;

      try {
        const pageNumber = clampPdfPage(view.page, pdf.numPages);
        if (pageNumber !== view.page) {
          onPageClamped(pageNumber);
          return;
        }

        page = await pdf.getPage(pageNumber);
        if (cancelled || renderSequenceRef.current !== sequence) {
          return;
        }

        const baseViewport = page.getViewport({ scale: 1 });
        const cssScale = resolvePdfCssScale(baseViewport, view, viewportElement);
        const cssViewport = page.getViewport({ scale: cssScale });
        const scratchCanvas = document.createElement("canvas");
        const outputScale = getPdfOutputScale();
        const metrics = preparePdfCanvas(scratchCanvas, cssViewport, outputScale);

        task = page.render({
          background: "#ffffff",
          canvas: scratchCanvas,
          canvasContext: metrics.context,
          transform: metrics.transform,
          viewport: cssViewport,
        });
        renderTaskRef.current = task;
        await task.promise;

        if (cancelled || renderSequenceRef.current !== sequence) {
          return;
        }

        const visibleContext = canvas.getContext("2d", { alpha: false });
        if (!visibleContext) {
          throw new Error("Canvas rendering is not available.");
        }

        canvas.width = metrics.pixelWidth;
        canvas.height = metrics.pixelHeight;
        canvas.style.width = `${metrics.cssWidth}px`;
        canvas.style.height = `${metrics.cssHeight}px`;
        visibleContext.setTransform(1, 0, 0, 1, 0, 0);
        visibleContext.globalAlpha = 1;
        visibleContext.globalCompositeOperation = "source-over";
        visibleContext.clearRect(0, 0, canvas.width, canvas.height);
        visibleContext.drawImage(scratchCanvas, 0, 0);
        onRenderSuccess();
      } catch (error) {
        if (!cancelled && !isPdfRenderingCancelled(error)) {
          clearPdfCanvas(canvas);
          onRenderError(pdfErrorMessage(error));
        }
      } finally {
        if (renderTaskRef.current === task) {
          renderTaskRef.current = null;
        }
        try {
          page?.cleanup();
        } catch {
          // PDF.js can reject cleanup while another render of the same cached page is active.
        }
      }
    };

    void renderPage();

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [
    layoutTick,
    onPageClamped,
    onRenderError,
    onRenderStart,
    onRenderSuccess,
    pdf,
    view,
    viewportRef,
  ]);

  return <canvas className="document-surface pdf-page-canvas" ref={canvasRef} aria-label={title} />;
}
