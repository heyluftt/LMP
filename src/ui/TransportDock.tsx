import {
  BookmarkPlus,
  Captions,
  FastForward,
  Gauge,
  History,
  Info,
  ListVideo,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Pause,
  Play,
  Printer,
  RefreshCcw,
  Repeat2,
  Rewind,
  RotateCw,
  Scan,
  Settings2,
  SkipBack,
  SkipForward,
  Sparkles,
  Scissors,
  Volume2,
  ZoomIn,
  ZoomOut,
  FolderOpen,
} from "lucide-react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import { useEffect, useRef, useState } from "react";

import { formatClock } from "../lib/playerBrain";
import type { MediaCapabilities, ShelfCapability } from "../player/capabilities";
import type { PlayerSettings } from "../player/settings";
import { PdfToolbar, type DocumentViewState } from "../viewers/pdf";
import type { ImageViewState } from "../viewers/image";

type TransportMediaMode = "empty" | "video" | "audio" | "image" | "document" | "text";
type TransportShelfMode = ShelfCapability | null;

type TransportDockProps = {
  capabilities: MediaCapabilities;
  currentTitle: string;
  cycleImageFit: () => void;
  cycleSpeed: () => void;
  documentPageCount: number;
  documentReady: boolean;
  documentView: DocumentViewState;
  duration: number;
  gstreamerActiveForCurrent: boolean;
  hasNextQueueItem: boolean;
  hasPreviousQueueItem: boolean;
  imageFitLabel: string;
  imageView: ImageViewState;
  isFullscreen: boolean;
  isStaticViewer: boolean;
  loopArmed: boolean;
  loopLabel: string;
  loopReady: boolean;
  mediaMode: TransportMediaMode;
  metaLabel: string;
  nudgeVolumeFromWheel: (deltaY: number) => boolean;
  onAddCurrentMoment: () => void;
  onClearLoop: () => void;
  onLoadLibraryFolder: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onOpenSubtitle: () => void;
  onPlayNextQueueItem: () => void;
  onPlayPreviousQueueItem: () => void;
  onPrintCurrentDocument: () => void;
  onResetDocumentView: () => void;
  onResetImageView: () => void;
  onSeekBy: (seconds: number) => void;
  onSeekTo: (seconds: number) => void;
  onSelectDocumentPage: (page: number) => void;
  onSetDocumentZoom: (direction: -1 | 1) => void;
  onSetDocumentZoomExact: (zoom: number) => void;
  onSetPlayerVolume: (volume: number) => void;
  onSetLoopPoint: () => void;
  onStepDocumentPage: (direction: -1 | 1) => void;
  onTimelineKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onToggleDocumentFit: () => void;
  onToggleFullscreen: () => void;
  onTogglePause: () => void;
  onToggleShelfMode: (mode: ShelfCapability) => void;
  onToggleSubtitles: () => void;
  onToggleTools: () => void;
  paused: boolean;
  position: number;
  queueCount: number;
  queueIndex: number;
  settings: PlayerSettings;
  shelfMode: TransportShelfMode;
  speed: number;
  subtitleAvailable: boolean;
  subtitlesEnabled: boolean;
  toolsOpen: boolean;
  trimRange?: {
    active: boolean;
    end: number;
    start: number;
  };
  volume: number;
  zoomImage: (direction: -1 | 1) => void;
  rotateImage: () => void;
};

export function TransportDock({
  capabilities,
  currentTitle,
  cycleImageFit,
  cycleSpeed,
  documentPageCount,
  documentReady,
  documentView,
  duration,
  gstreamerActiveForCurrent,
  hasNextQueueItem,
  hasPreviousQueueItem,
  imageFitLabel,
  imageView,
  isFullscreen,
  isStaticViewer,
  loopArmed,
  loopLabel,
  loopReady,
  mediaMode,
  metaLabel,
  nudgeVolumeFromWheel,
  onAddCurrentMoment,
  onClearLoop,
  onLoadLibraryFolder,
  onMouseEnter,
  onMouseLeave,
  onOpenSubtitle,
  onPlayNextQueueItem,
  onPlayPreviousQueueItem,
  onPrintCurrentDocument,
  onResetDocumentView,
  onResetImageView,
  onSeekBy,
  onSeekTo,
  onSelectDocumentPage,
  onSetDocumentZoom,
  onSetDocumentZoomExact,
  onSetPlayerVolume,
  onSetLoopPoint,
  onStepDocumentPage,
  onTimelineKeyDown,
  onToggleDocumentFit,
  onToggleFullscreen,
  onTogglePause,
  onToggleShelfMode,
  onToggleSubtitles,
  onToggleTools,
  paused,
  position,
  queueCount,
  queueIndex,
  settings,
  shelfMode,
  speed,
  subtitleAvailable,
  subtitlesEnabled,
  toolsOpen,
  trimRange,
  volume,
  zoomImage,
  rotateImage,
}: TransportDockProps) {
  const onSubtitleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.shiftKey || !subtitleAvailable) {
      onOpenSubtitle();
      return;
    }
    onToggleSubtitles();
  };
  const isAudioMode = mediaMode === "audio";
  const showQueueControls = capabilities.queue && queueCount > 1;
  const scrubActiveRef = useRef(false);
  const [draftPosition, setDraftPosition] = useState<number | null>(null);
  const boundedDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const boundedPosition =
    boundedDuration > 0 ? Math.max(0, Math.min(position, boundedDuration)) : Math.max(0, position);
  const visiblePosition = draftPosition ?? boundedPosition;
  const timelineProgress = boundedDuration > 0 ? Math.min(100, Math.max(0, (visiblePosition / boundedDuration) * 100)) : 0;
  const normalizedTrimStart =
    trimRange?.active && boundedDuration > 0
      ? Math.min(100, Math.max(0, (trimRange.start / boundedDuration) * 100))
      : 0;
  const normalizedTrimEnd =
    trimRange?.active && boundedDuration > 0
      ? Math.min(100, Math.max(normalizedTrimStart, (trimRange.end / boundedDuration) * 100))
      : 0;
  const timelineWrapStyle = {
    "--progress-pct": `${timelineProgress}%`,
    "--trim-start-pct": `${normalizedTrimStart}%`,
    "--trim-end-pct": `${normalizedTrimEnd}%`,
    "--trim-width-pct": `${Math.max(0, normalizedTrimEnd - normalizedTrimStart)}%`,
  } as CSSProperties;

  useEffect(() => {
    if (!scrubActiveRef.current) {
      setDraftPosition(null);
    }
  }, [position, duration]);

  const commitTimelineSeek = () => {
    if (!scrubActiveRef.current) {
      return;
    }
    scrubActiveRef.current = false;
    const next = draftPosition ?? boundedPosition;
    setDraftPosition(null);
    onSeekTo(next);
  };

  return (
    <div
      className={`transport-dock ${mediaMode}-dock ${isStaticViewer ? "viewer-dock" : ""}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {!isStaticViewer ? (
        <div className="scrub-row">
          <span>{formatClock(position)}</span>
          <div
            className={`timeline-wrap ${trimRange?.active && boundedDuration > 0 ? "has-trim-range" : ""}`}
            style={timelineWrapStyle}
          >
            <span className="timeline-track-frame" aria-hidden="true">
              <span className="timeline-progress-fill" />
              <span className="trim-range-indicator" />
              <span className="trim-marker trim-marker-start" />
              <span className="trim-marker trim-marker-end" />
            </span>
            <input
              className="timeline-input"
              type="range"
              min="0"
              max={duration || 0}
              step="0.1"
              value={visiblePosition}
              data-wheel-volume="ignore"
              onPointerDown={(event) => {
                scrubActiveRef.current = true;
                setDraftPosition(Number(event.currentTarget.value));
              }}
              onPointerUp={commitTimelineSeek}
              onPointerCancel={commitTimelineSeek}
              onBlur={commitTimelineSeek}
              onChange={(event) => {
                const next = Number(event.currentTarget.value);
                if (scrubActiveRef.current) {
                  setDraftPosition(next);
                  return;
                }
                onSeekTo(next);
              }}
              onKeyDown={onTimelineKeyDown}
              aria-label="Seek"
            />
          </div>
          <span>{duration ? formatClock(duration) : "--:--"}</span>
        </div>
      ) : null}

      <div className="control-row">
        <div className="control-meta">
          <strong>{currentTitle}</strong>
          <span>{metaLabel}</span>
        </div>

        <div className="control-cluster">
          {isStaticViewer ? (
            <>
              {showQueueControls ? (
                <button
                  className="icon-button"
                  onClick={() => onPlayPreviousQueueItem()}
                  disabled={!hasPreviousQueueItem}
                  title={hasPreviousQueueItem ? "Previous item" : "Start of queue"}
                >
                  <SkipBack size={20} />
                </button>
              ) : null}
              {capabilities.imageTools ? (
                <>
                  <button className="icon-button" onClick={() => zoomImage(-1)} title="Zoom out">
                    <ZoomOut size={19} />
                  </button>
                  <button className="text-button" onClick={cycleImageFit} title="Cycle fit mode">
                    <Scan size={16} />
                    <span>{imageFitLabel}</span>
                  </button>
                  <button className="icon-button" onClick={() => zoomImage(1)} title="Zoom in">
                    <ZoomIn size={19} />
                  </button>
                  <button className="icon-button" onClick={rotateImage} title="Rotate image">
                    <RotateCw size={19} />
                  </button>
                </>
              ) : null}
              {capabilities.documentPages || capabilities.documentPrint ? (
                <>
                  {capabilities.documentPages ? (
                    <PdfToolbar
                      documentReady={documentReady}
                      onFirstPage={() => onSelectDocumentPage(1)}
                      onLastPage={() => onSelectDocumentPage(Math.max(1, documentPageCount))}
                      onNextPage={() => onStepDocumentPage(1)}
                      onPreviousPage={() => onStepDocumentPage(-1)}
                      onPrint={onPrintCurrentDocument}
                      onSetActualSize={() => onSetDocumentZoomExact(100)}
                      onToggleFit={onToggleDocumentFit}
                      onZoomIn={() => onSetDocumentZoom(1)}
                      onZoomOut={() => onSetDocumentZoom(-1)}
                      pageCount={documentPageCount}
                      view={documentView}
                      variant="dock"
                    />
                  ) : null}
                  {!capabilities.documentPages && capabilities.documentPrint ? (
                    <button className="icon-button" onClick={onPrintCurrentDocument} title="Print document">
                      <Printer size={19} />
                    </button>
                  ) : null}
                </>
              ) : null}
              <button
                className="icon-button"
                onClick={onToggleFullscreen}
                title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              >
                {isFullscreen ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
              </button>
              {showQueueControls ? (
                <button
                  className="icon-button"
                  onClick={() => onPlayNextQueueItem()}
                  disabled={!hasNextQueueItem}
                  title={hasNextQueueItem ? "Next item" : "End of queue"}
                >
                  <SkipForward size={20} />
                </button>
              ) : null}
            </>
          ) : (
            <>
              {showQueueControls ? (
                <button
                  className="icon-button"
                  onClick={() => onPlayPreviousQueueItem()}
                  title={hasPreviousQueueItem ? "Previous queue item" : "Restart current media"}
                >
                  <SkipBack size={20} />
                </button>
              ) : null}
              <button
                className="icon-button"
                onClick={() => onSeekBy(-settings.seekSeconds)}
                disabled={gstreamerActiveForCurrent}
                title={`Back ${settings.seekSeconds} seconds`}
              >
                <Rewind size={21} />
              </button>
              <button
                className="play-button"
                onClick={onTogglePause}
                title={gstreamerActiveForCurrent ? "Stop GStreamer fallback" : paused ? "Play" : "Pause"}
              >
                {paused ? <Play size={24} fill="currentColor" /> : <Pause size={24} fill="currentColor" />}
              </button>
              <button
                className="icon-button"
                onClick={() => onSeekBy(settings.seekSeconds)}
                disabled={gstreamerActiveForCurrent}
                title={`Forward ${settings.seekSeconds} seconds`}
              >
                <FastForward size={21} />
              </button>
              {showQueueControls ? (
                <button
                  className="icon-button"
                  onClick={() => onPlayNextQueueItem()}
                  disabled={!hasNextQueueItem}
                  title={hasNextQueueItem ? "Next queue item" : "End of queue"}
                >
                  <SkipForward size={20} />
                </button>
              ) : null}
              {!isAudioMode ? (
                <button
                  className="icon-button"
                  onClick={onToggleFullscreen}
                  title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                >
                  {isFullscreen ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
                </button>
              ) : null}
            </>
          )}
        </div>

        <div className="control-cluster secondary">
          {capabilities.timedPlayback ? (
            <>
              <label className="volume-inline compact-hide" title="Volume">
                <Volume2 size={17} />
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={volume}
                  disabled={gstreamerActiveForCurrent}
                  onChange={(event) => onSetPlayerVolume(Number(event.target.value))}
                  onWheel={(event: ReactWheelEvent<HTMLInputElement>) => {
                    event.stopPropagation();
                    if (nudgeVolumeFromWheel(event.deltaY)) {
                      event.preventDefault();
                    }
                  }}
                />
              </label>
              <button
                className="text-button speed-button compact-hide"
                onClick={cycleSpeed}
                disabled={gstreamerActiveForCurrent}
                title="Playback speed"
              >
                <Gauge size={15} />
                <span>{speed.toFixed(speed === 1 ? 0 : 2)}x</span>
              </button>
            </>
          ) : null}
          <button
            className={`icon-button tools-toggle ${toolsOpen ? "active" : ""}`}
            onClick={onToggleTools}
            title="Tools"
          >
            <MoreHorizontal size={19} />
          </button>
        </div>
      </div>

      {toolsOpen ? (
        <div
          className={`tool-popover ${mediaMode}-tools`}
          data-wheel-volume="ignore"
          aria-label={`${mediaMode} tools`}
        >
          {capabilities.captions || capabilities.tracks || capabilities.loopPoints ? (
            <>
              {capabilities.captions ? (
                <button
                  className={`tool-action playback-tool ${subtitleAvailable && subtitlesEnabled ? "active" : ""}`}
                  onClick={onSubtitleClick}
                  title={subtitleAvailable ? "Shift-click to load another subtitle file" : "Load subtitles"}
                >
                  <Captions size={17} />
                  <span>Captions</span>
                </button>
              ) : null}
              {capabilities.tracks ? (
                <button
                  className={`tool-action playback-tool ${shelfMode === "tracks" ? "active" : ""}`}
                  onClick={() => onToggleShelfMode("tracks")}
                >
                  <ListVideo size={17} />
                  <span>Tracks</span>
                </button>
              ) : null}
              {capabilities.loopPoints ? (
                <button
                  className={`tool-action playback-tool ${loopReady || loopArmed ? "active" : ""}`}
                  onClick={onSetLoopPoint}
                  onDoubleClick={onClearLoop}
                  title={loopReady || loopArmed ? `${loopLabel}. Double-click to clear` : "Set loop point"}
                >
                  <Repeat2 size={17} />
                  <span>Loop</span>
                </button>
              ) : null}
            </>
          ) : null}
          {capabilities.moments ? (
            <button className="tool-action playback-tool" onClick={onAddCurrentMoment}>
              <BookmarkPlus size={17} />
              <span>Mark</span>
            </button>
          ) : null}
          {capabilities.shelves.includes("trim") ? (
            <button
              className={`tool-action playback-tool ${shelfMode === "trim" ? "active" : ""}`}
              onClick={() => onToggleShelfMode("trim")}
            >
              <Scissors size={17} />
              <span>Trim</span>
            </button>
          ) : null}
          {capabilities.imageTools ? (
            <>
              <button className="tool-action playback-tool" onClick={() => zoomImage(-1)} title="Zoom out">
                <ZoomOut size={17} />
                <span>{Math.round(imageView.zoom * 100)}%</span>
              </button>
              <button className="tool-action playback-tool" onClick={cycleImageFit} title="Cycle fit mode">
                <Scan size={17} />
                <span>{imageFitLabel}</span>
              </button>
              <button className="tool-action playback-tool" onClick={() => zoomImage(1)} title="Zoom in">
                <ZoomIn size={17} />
                <span>Zoom</span>
              </button>
              <button className="tool-action playback-tool" onClick={rotateImage} title="Rotate image">
                <RotateCw size={17} />
                <span>Rotate</span>
              </button>
              <button className="tool-action playback-tool" onClick={onResetImageView} title="Reset image view">
                <RefreshCcw size={17} />
                <span>Reset</span>
              </button>
            </>
          ) : null}
          {capabilities.documentPages || capabilities.documentPrint ? (
            <>
              {capabilities.documentPages ? (
                <PdfToolbar
                  documentReady={documentReady}
                  onFirstPage={() => onSelectDocumentPage(1)}
                  onLastPage={() => onSelectDocumentPage(Math.max(1, documentPageCount))}
                  onNextPage={() => onStepDocumentPage(1)}
                  onPageOverview={() => onToggleShelfMode("pages")}
                  onPreviousPage={() => onStepDocumentPage(-1)}
                  onPrint={onPrintCurrentDocument}
                  onReset={onResetDocumentView}
                  onSetActualSize={() => onSetDocumentZoomExact(100)}
                  onToggleFit={onToggleDocumentFit}
                  onZoomIn={() => onSetDocumentZoom(1)}
                  onZoomOut={() => onSetDocumentZoom(-1)}
                  pageCount={documentPageCount}
                  pagesActive={shelfMode === "pages"}
                  view={documentView}
                  variant="tools"
                />
              ) : null}
              {!capabilities.documentPages && capabilities.documentPrint ? (
                <button className="tool-action playback-tool" onClick={onPrintCurrentDocument} title="Print document">
                  <Printer size={17} />
                  <span>Print</span>
                </button>
              ) : null}
            </>
          ) : null}
          {capabilities.queue ? (
            <button
              className={`tool-action panel-tool ${shelfMode === "queue" ? "active" : ""}`}
              onClick={() => onToggleShelfMode("queue")}
              title={`Queue${queueCount > 0 ? ` (${queueIndex + 1}/${queueCount})` : ""}`}
            >
              <ListVideo size={17} />
              <span>Queue</span>
            </button>
          ) : null}
          {capabilities.moments ? (
            <button
              className={`tool-action panel-tool ${shelfMode === "moments" ? "active" : ""}`}
              onClick={() => onToggleShelfMode("moments")}
            >
              <Sparkles size={17} />
              <span>Moments</span>
            </button>
          ) : null}
          <button
            className={`tool-action panel-tool ${shelfMode === "recent" ? "active" : ""}`}
            onClick={() => onToggleShelfMode("recent")}
          >
            <History size={17} />
            <span>Recent</span>
          </button>
          <button
            className={`tool-action panel-tool ${shelfMode === "library" ? "active" : ""}`}
            onClick={onLoadLibraryFolder}
          >
            <FolderOpen size={17} />
            <span>Library</span>
          </button>
          <button
            className={`tool-action system-tool ${shelfMode === "info" ? "active" : ""}`}
            onClick={() => onToggleShelfMode("info")}
          >
            <Info size={17} />
            <span>Info</span>
          </button>
          <button
            className={`tool-action system-tool ${shelfMode === "settings" ? "active" : ""}`}
            onClick={() => onToggleShelfMode("settings")}
          >
            <Settings2 size={17} />
            <span>Settings</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
