import type {
  PointerEvent as ReactPointerEvent,
  RefObject,
  WheelEvent as ReactWheelEvent,
} from "react";

import type { PDFDocumentProxy } from "pdfjs-dist";

import { PdfPageCanvas } from "./PdfPageCanvas";
import type { DocumentViewState } from "./PdfTypes";

type PdfViewerProps = {
  error: string | null;
  isDragging: boolean;
  layoutTick: number;
  loading: boolean;
  onPageClamped: (page: number) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onRenderError: (message: string) => void;
  onRenderStart: () => void;
  onRenderSuccess: () => void;
  onWheel: (event: ReactWheelEvent<HTMLDivElement>) => void;
  pdf: PDFDocumentProxy | null;
  title: string;
  view: DocumentViewState;
  viewportRef: RefObject<HTMLDivElement | null>;
};

export function PdfViewer({
  error,
  isDragging,
  layoutTick,
  loading,
  onPageClamped,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onRenderError,
  onRenderStart,
  onRenderSuccess,
  onWheel,
  pdf,
  title,
  view,
  viewportRef,
}: PdfViewerProps) {
  return (
    <div
      className={`document-viewport pdf-document-viewport ${isDragging ? "is-dragging" : ""}`}
      ref={viewportRef}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {pdf ? (
        <PdfPageCanvas
          layoutTick={layoutTick}
          onPageClamped={onPageClamped}
          onRenderError={onRenderError}
          onRenderStart={onRenderStart}
          onRenderSuccess={onRenderSuccess}
          pdf={pdf}
          title={title}
          view={view}
          viewportRef={viewportRef}
        />
      ) : null}
      {loading ? (
        <div className="document-status">{pdf ? "Rendering page..." : "Loading document..."}</div>
      ) : null}
      {error ? <div className="document-status error">{error}</div> : null}
    </div>
  );
}
