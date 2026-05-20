import {
  ChevronsLeft,
  ChevronsRight,
  ListVideo,
  Printer,
  RefreshCcw,
  Scan,
  SkipBack,
  SkipForward,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import type { DocumentViewState } from "./PdfTypes";
import { documentZoomLabel } from "./PdfUtils";

type PdfToolbarProps = {
  documentReady: boolean;
  onFirstPage: () => void;
  onLastPage: () => void;
  onNextPage: () => void;
  onPageOverview?: () => void;
  onPreviousPage: () => void;
  onPrint: () => void;
  onReset?: () => void;
  onSetActualSize: () => void;
  onToggleFit: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  pageCount: number;
  pagesActive?: boolean;
  view: DocumentViewState;
  variant: "dock" | "tools";
};

export function PdfToolbar({
  documentReady,
  onFirstPage,
  onLastPage,
  onNextPage,
  onPageOverview,
  onPreviousPage,
  onPrint,
  onReset,
  onSetActualSize,
  onToggleFit,
  onZoomIn,
  onZoomOut,
  pageCount,
  pagesActive,
  view,
  variant,
}: PdfToolbarProps) {
  const pageNavigationDisabled = !documentReady || pageCount <= 0;
  const atFirstPage = pageNavigationDisabled || view.page <= 1;
  const atLastPage = pageNavigationDisabled || view.page >= pageCount;

  if (variant === "dock") {
    return (
      <>
        <button className="icon-button" onClick={onFirstPage} disabled={atFirstPage} title="First page">
          <ChevronsLeft size={19} />
        </button>
        <button className="icon-button" onClick={onPreviousPage} disabled={atFirstPage} title="Previous page">
          <SkipBack size={19} />
        </button>
        <button className="icon-button" onClick={onZoomOut} title="Zoom out">
          <ZoomOut size={19} />
        </button>
        <button className="text-button" onClick={onToggleFit} title="Fit mode">
          <Scan size={16} />
          <span>{documentZoomLabel(view)}</span>
        </button>
        <button className="text-button" onClick={onSetActualSize} title="Actual size">
          <span>100%</span>
        </button>
        <button className="icon-button" onClick={onZoomIn} title="Zoom in">
          <ZoomIn size={19} />
        </button>
        <button className="icon-button" onClick={onNextPage} disabled={atLastPage} title="Next page">
          <SkipForward size={19} />
        </button>
        <button className="icon-button" onClick={onLastPage} disabled={atLastPage} title="Last page">
          <ChevronsRight size={19} />
        </button>
        <button className="icon-button" onClick={onPrint} title="Print document">
          <Printer size={19} />
        </button>
      </>
    );
  }

  return (
    <>
      <button className="tool-action playback-tool" onClick={onFirstPage} disabled={atFirstPage} title="First page">
        <ChevronsLeft size={17} />
        <span>First</span>
      </button>
      <button className="tool-action playback-tool" onClick={onPreviousPage} disabled={atFirstPage} title="Previous page">
        <SkipBack size={17} />
        <span>Page -</span>
      </button>
      <button className="tool-action playback-tool" onClick={onToggleFit} title="Toggle document fit">
        <Scan size={17} />
        <span>{documentZoomLabel(view)}</span>
      </button>
      <button className="tool-action playback-tool" onClick={onSetActualSize} title="Actual size">
        <ZoomIn size={17} />
        <span>100%</span>
      </button>
      <button className="tool-action playback-tool" onClick={onNextPage} disabled={atLastPage} title="Next page">
        <SkipForward size={17} />
        <span>Page +</span>
      </button>
      <button className="tool-action playback-tool" onClick={onLastPage} disabled={atLastPage} title="Last page">
        <ChevronsRight size={17} />
        <span>Last</span>
      </button>
      {onPageOverview ? (
        <button
          className={`tool-action playback-tool ${pagesActive ? "active" : ""}`}
          onClick={onPageOverview}
          disabled={!documentReady || pageCount <= 0}
          title="Page overview"
        >
          <ListVideo size={17} />
          <span>Pages</span>
        </button>
      ) : null}
      <button className="tool-action playback-tool" onClick={onPrint} title="Print document">
        <Printer size={17} />
        <span>Print</span>
      </button>
      {onReset ? (
        <button className="tool-action playback-tool" onClick={onReset} title="Reset document view">
          <RefreshCcw size={17} />
          <span>Reset</span>
        </button>
      ) : null}
    </>
  );
}
