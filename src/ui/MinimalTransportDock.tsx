import {
  BookmarkPlus,
  Captions,
  FastForward,
  Gauge,
  Info,
  ListVideo,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Pause,
  Play,
  Repeat2,
  Rewind,
  Settings2,
  SkipBack,
  SkipForward,
  Sparkles,
  Volume2,
} from "lucide-react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import { useEffect, useRef, useState } from "react";

import { formatClock } from "../lib/playerBrain";
import type { MediaCapabilities, ShelfCapability } from "../player/capabilities";
import type { PlayerSettings } from "../player/settings";

type MinimalMediaMode = "video" | "audio";
type MinimalShelfMode = ShelfCapability | null;

type MinimalTransportDockProps = {
  capabilities: MediaCapabilities;
  cycleSpeed: () => void;
  duration: number;
  gstreamerActiveForCurrent: boolean;
  hasNextQueueItem: boolean;
  hasPreviousQueueItem: boolean;
  isFullscreen: boolean;
  loopArmed: boolean;
  loopLabel: string;
  loopReady: boolean;
  mediaMode: MinimalMediaMode;
  nudgeVolumeFromWheel: (deltaY: number) => boolean;
  onAddCurrentMoment: () => void;
  onClearLoop: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onOpenSubtitle: () => void;
  onPlayNextQueueItem: () => void;
  onPlayPreviousQueueItem: () => void;
  onSeekBy: (seconds: number) => void;
  onSeekTo: (seconds: number) => void;
  onSetLoopPoint: () => void;
  onSetPlayerVolume: (volume: number) => void;
  onTimelineKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
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
  shelfMode: MinimalShelfMode;
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
};

export function MinimalTransportDock({
  capabilities,
  cycleSpeed,
  duration,
  gstreamerActiveForCurrent,
  hasNextQueueItem,
  hasPreviousQueueItem,
  isFullscreen,
  loopArmed,
  loopLabel,
  loopReady,
  mediaMode,
  nudgeVolumeFromWheel,
  onAddCurrentMoment,
  onClearLoop,
  onMouseEnter,
  onMouseLeave,
  onOpenSubtitle,
  onPlayNextQueueItem,
  onPlayPreviousQueueItem,
  onSeekBy,
  onSeekTo,
  onSetLoopPoint,
  onSetPlayerVolume,
  onTimelineKeyDown,
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
}: MinimalTransportDockProps) {
  const scrubActiveRef = useRef(false);
  const [draftPosition, setDraftPosition] = useState<number | null>(null);
  const boundedDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const boundedPosition =
    boundedDuration > 0 ? Math.max(0, Math.min(position, boundedDuration)) : Math.max(0, position);
  const visiblePosition = draftPosition ?? boundedPosition;
  const timelineProgress =
    boundedDuration > 0 ? Math.min(100, Math.max(0, (visiblePosition / boundedDuration) * 100)) : 0;
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
  const showQueueControls = capabilities.queue && queueCount > 1;

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

  const releaseTimelinePointer = (event: ReactPointerEvent<HTMLInputElement>) => {
    commitTimelineSeek();
    event.currentTarget.blur();
  };

  const onSubtitleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.shiftKey || !subtitleAvailable) {
      onOpenSubtitle();
      return;
    }
    onToggleSubtitles();
  };

  return (
    <div
      className={`minimal-transport-dock ${mediaMode}-dock`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <span className="minimal-time">{formatClock(position)}</span>

      <div
        className={`minimal-timeline timeline-wrap ${
          trimRange?.active && boundedDuration > 0 ? "has-trim-range" : ""
        }`}
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
          onPointerUp={releaseTimelinePointer}
          onPointerCancel={releaseTimelinePointer}
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

      <div className="minimal-control-cluster">
        {showQueueControls ? (
          <button
            className="minimal-control-button"
            onClick={onPlayPreviousQueueItem}
            title={hasPreviousQueueItem ? "Previous queue item" : "Restart current media"}
          >
            <SkipBack size={17} />
          </button>
        ) : null}
        <button
          className="minimal-control-button"
          onClick={() => onSeekBy(-settings.seekSeconds)}
          disabled={gstreamerActiveForCurrent}
          title={`Back ${settings.seekSeconds} seconds`}
        >
          <Rewind size={18} />
        </button>
        <button
          className="minimal-play-button"
          onClick={onTogglePause}
          title={gstreamerActiveForCurrent ? "Stop GStreamer fallback" : paused ? "Play" : "Pause"}
        >
          {paused ? <Play size={21} fill="currentColor" /> : <Pause size={21} fill="currentColor" />}
        </button>
        <button
          className="minimal-control-button"
          onClick={() => onSeekBy(settings.seekSeconds)}
          disabled={gstreamerActiveForCurrent}
          title={`Forward ${settings.seekSeconds} seconds`}
        >
          <FastForward size={18} />
        </button>
        {showQueueControls ? (
          <button
            className="minimal-control-button"
            onClick={onPlayNextQueueItem}
            disabled={!hasNextQueueItem}
            title={hasNextQueueItem ? "Next queue item" : "End of queue"}
          >
            <SkipForward size={17} />
          </button>
        ) : null}
        {mediaMode === "video" ? (
          <button
            className="minimal-control-button"
            onClick={onToggleFullscreen}
            title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {isFullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </button>
        ) : null}
      </div>

      <span className="minimal-time minimal-time-end">{duration ? formatClock(duration) : "--:--"}</span>

      <button
        className={`minimal-control-button minimal-tools-button ${toolsOpen ? "active" : ""}`}
        onClick={onToggleTools}
        title="Tools"
      >
        <MoreHorizontal size={18} />
      </button>

      {toolsOpen ? (
        <div className="minimal-tool-popover" data-wheel-volume="ignore" aria-label={`${mediaMode} tools`}>
          <label className="minimal-tool-volume" title="Volume">
            <Volume2 size={16} />
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
          <button className="minimal-tool-action" onClick={cycleSpeed} disabled={gstreamerActiveForCurrent}>
            <Gauge size={16} />
            <span>{speed.toFixed(speed === 1 ? 0 : 2)}x</span>
          </button>
          {capabilities.captions ? (
            <button
              className={`minimal-tool-action ${subtitleAvailable && subtitlesEnabled ? "active" : ""}`}
              onClick={onSubtitleClick}
              title={subtitleAvailable ? "Shift-click to load another subtitle file" : "Load subtitles"}
            >
              <Captions size={16} />
              <span>Captions</span>
            </button>
          ) : null}
          {capabilities.loopPoints ? (
            <button
              className={`minimal-tool-action ${loopReady || loopArmed ? "active" : ""}`}
              onClick={onSetLoopPoint}
              onDoubleClick={onClearLoop}
              title={loopReady || loopArmed ? `${loopLabel}. Double-click to clear` : "Set loop point"}
            >
              <Repeat2 size={16} />
              <span>Loop</span>
            </button>
          ) : null}
          {capabilities.queue ? (
            <button
              className={`minimal-tool-action ${shelfMode === "queue" ? "active" : ""}`}
              onClick={() => onToggleShelfMode("queue")}
              title={`Queue${queueCount > 0 ? ` (${queueIndex + 1}/${queueCount})` : ""}`}
            >
              <ListVideo size={16} />
              <span>Queue</span>
            </button>
          ) : null}
          {capabilities.moments ? (
            <>
              <button className="minimal-tool-action" onClick={onAddCurrentMoment}>
                <BookmarkPlus size={16} />
                <span>Mark</span>
              </button>
              <button
                className={`minimal-tool-action ${shelfMode === "moments" ? "active" : ""}`}
                onClick={() => onToggleShelfMode("moments")}
              >
                <Sparkles size={16} />
                <span>Moments</span>
              </button>
            </>
          ) : null}
          <button
            className={`minimal-tool-action ${shelfMode === "info" ? "active" : ""}`}
            onClick={() => onToggleShelfMode("info")}
          >
            <Info size={16} />
            <span>Info</span>
          </button>
          <button
            className={`minimal-tool-action ${shelfMode === "settings" ? "active" : ""}`}
            onClick={() => onToggleShelfMode("settings")}
          >
            <Settings2 size={16} />
            <span>Settings</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
