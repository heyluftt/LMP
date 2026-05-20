import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";

import {
  isPdfRenderingCancelled,
  preparePdfCanvas,
} from "./PdfUtils";

type PdfPageThumbnailProps = {
  active: boolean;
  onSelect: () => void;
  pageNumber: number;
  pdf: PDFDocumentProxy;
};

export function PdfPageThumbnail({
  active,
  onSelect,
  pageNumber,
  pdf,
}: PdfPageThumbnailProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const button = buttonRef.current;
    if (!button) {
      return;
    }

    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
        }
      },
      { rootMargin: "180px" },
    );
    observer.observe(button);
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!visible) {
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    let cancelled = false;

    renderTaskRef.current?.cancel();
    renderTaskRef.current = null;
    setFailed(false);

    const renderThumb = async () => {
      let task: RenderTask | null = null;
      const page = await pdf.getPage(pageNumber);

      try {
        if (cancelled) {
          return;
        }

        const baseViewport = page.getViewport({ scale: 1 });
        const scale = 92 / Math.max(1, baseViewport.width);
        const cssViewport = page.getViewport({ scale });
        const scratchCanvas = document.createElement("canvas");
        const metrics = preparePdfCanvas(scratchCanvas, cssViewport, 1.5);

        task = page.render({
          background: "#ffffff",
          canvas: scratchCanvas,
          canvasContext: metrics.context,
          transform: metrics.transform,
          viewport: cssViewport,
        });
        renderTaskRef.current = task;
        await task.promise;

        if (cancelled) {
          return;
        }

        const context = canvas.getContext("2d", { alpha: false });
        if (!context) {
          throw new Error("Canvas rendering is not available.");
        }

        canvas.width = metrics.pixelWidth;
        canvas.height = metrics.pixelHeight;
        canvas.style.width = `${metrics.cssWidth}px`;
        canvas.style.height = `${metrics.cssHeight}px`;
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.globalAlpha = 1;
        context.globalCompositeOperation = "source-over";
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(scratchCanvas, 0, 0);
      } catch (error) {
        if (!cancelled && !isPdfRenderingCancelled(error)) {
          setFailed(true);
        }
      } finally {
        if (renderTaskRef.current === task) {
          renderTaskRef.current = null;
        }
        try {
          page.cleanup();
        } catch {
          // The main page canvas may be rendering the same cached page.
        }
      }
    };

    void renderThumb();

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [pageNumber, pdf, visible]);

  return (
    <button
      ref={buttonRef}
      className={`pdf-page-thumb ${active ? "active" : ""} ${failed ? "failed" : ""}`}
      onClick={onSelect}
      title={`Page ${pageNumber}`}
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      <span>{pageNumber}</span>
    </button>
  );
}
