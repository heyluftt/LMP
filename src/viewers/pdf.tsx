import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";

export type DocumentViewState = {
  page: number;
  zoom: number;
  fit: "page" | "width";
};

export type PdfLoadingTask = {
  promise: Promise<PDFDocumentProxy>;
  destroy: () => Promise<void>;
};

export const defaultDocumentView: DocumentViewState = {
  page: 1,
  zoom: 100,
  fit: "page",
};

export function documentZoomLabel(view: DocumentViewState) {
  return view.fit === "width" ? "Width" : `${view.zoom}%`;
}

export async function createPdfLoadingTask(sourceUrl: string): Promise<PdfLoadingTask> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Could not read PDF (${response.status})`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  return pdfjs.getDocument({ data: bytes }) as PdfLoadingTask;
}

export function PdfPageThumbnail({
  active,
  onSelect,
  pageNumber,
  pdf,
}: {
  active: boolean;
  onSelect: () => void;
  pageNumber: number;
  pdf: PDFDocumentProxy;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(false);

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
      { rootMargin: "160px" },
    );
    observer.observe(button);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) {
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    let cancelled = false;
    let task: RenderTask | null = null;

    const renderThumb = async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) {
          return;
        }

        const baseViewport = page.getViewport({ scale: 1 });
        const scale = 92 / baseViewport.width;
        const viewport = page.getViewport({ scale });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const renderViewport = page.getViewport({ scale: scale * ratio });
        const context = canvas.getContext("2d");
        if (!context) {
          return;
        }

        canvas.width = Math.ceil(renderViewport.width);
        canvas.height = Math.ceil(renderViewport.height);
        canvas.style.width = `${Math.ceil(viewport.width)}px`;
        canvas.style.height = `${Math.ceil(viewport.height)}px`;
        context.clearRect(0, 0, canvas.width, canvas.height);
        task = page.render({ canvas, canvasContext: context, viewport: renderViewport });
        await task.promise;
      } catch (error) {
        if (!(error instanceof Error && error.name === "RenderingCancelledException")) {
          canvas.removeAttribute("width");
          canvas.removeAttribute("height");
        }
      }
    };

    void renderThumb();

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pageNumber, pdf, visible]);

  return (
    <button
      ref={buttonRef}
      className={`pdf-page-thumb ${active ? "active" : ""}`}
      onClick={onSelect}
      title={`Page ${pageNumber}`}
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      <span>{pageNumber}</span>
    </button>
  );
}
