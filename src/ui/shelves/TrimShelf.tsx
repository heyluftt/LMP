import {
  CornerDownLeft,
  FolderSearch,
  Play,
  Scissors,
  Square,
  StepBack,
  StepForward,
  X,
} from "lucide-react";

import { formatClock } from "../../lib/playerBrain";
import type { ClipPresetId } from "../../player/types";
import { ShelfCloseButton, ShelfHeader } from "./ShelfHeader";
import type { MediaShelvesProps } from "./types";

const presetLabels: Record<ClipPresetId, string> = {
  balanced: "Balanced",
  highQuality: "High Quality",
  smallFile: "Small File",
};

function trimFileName(path: string | null) {
  if (!path) {
    return "";
  }
  return path.split(/[\\/]/).pop() ?? path;
}

export function TrimShelf({
  onCancelTrimExport,
  onClose,
  onExportTrimClip,
  onJumpToTrimEnd,
  onJumpToTrimStart,
  onOpenTrimResult,
  onPreviewTrimRange,
  onSetTrimEndFromCurrent,
  onSetTrimPreset,
  onSetTrimStartFromCurrent,
  onShowTrimResult,
  trimCanExport,
  trimDuration,
  trimEnd,
  trimError,
  trimExport,
  trimOutputPath,
  trimPreset,
  trimStart,
}: MediaShelvesProps) {
  const isExporting = trimExport?.status === "running" || trimExport?.status === "canceling";
  const exported = Boolean(trimOutputPath && trimExport?.status === "done");
  const progress = Math.round(Math.max(0, Math.min(1, trimExport?.progress ?? 0)) * 100);

  return (
    <div className="shelf-section trim-section">
      <ShelfHeader
        icon={<Scissors size={18} />}
        title="Create Clip"
        meta="Accurate MP4 export"
        actions={<ShelfCloseButton label="Close trim panel" onClose={onClose} />}
      />

      <div className="trim-panel">
        <section className="trim-card trim-range-card" aria-label="Trim range">
          <div className="trim-card-header">
            <strong>Range</strong>
            <span>{formatClock(trimDuration)}</span>
          </div>

          <div className="trim-times">
            <div>
              <span>Start</span>
              <strong>{formatClock(trimStart)}</strong>
            </div>
            <div>
              <span>End</span>
              <strong>{formatClock(trimEnd)}</strong>
            </div>
            <div>
              <span>Duration</span>
              <strong>{formatClock(trimDuration)}</strong>
            </div>
          </div>

          <div className="trim-actions trim-range-actions">
            <button type="button" onClick={onSetTrimStartFromCurrent}>
              <StepBack size={15} />
              <span>Set Start</span>
            </button>
            <button type="button" onClick={onSetTrimEndFromCurrent}>
              <StepForward size={15} />
              <span>Set End</span>
            </button>
            <button type="button" onClick={onJumpToTrimStart}>
              <CornerDownLeft size={15} />
              <span>Jump Start</span>
            </button>
            <button type="button" onClick={onJumpToTrimEnd}>
              <CornerDownLeft size={15} />
              <span>Jump End</span>
            </button>
            <button type="button" onClick={onPreviewTrimRange} disabled={!trimCanExport || isExporting}>
              <Play size={15} />
              <span>Preview</span>
            </button>
          </div>
        </section>

        <section className="trim-card trim-export-card" aria-label="Trim export">
          <div className="trim-card-header">
            <strong>Export</strong>
            <span>MP4</span>
          </div>

          <div className="trim-presets" aria-label="Clip quality preset">
            {(Object.keys(presetLabels) as ClipPresetId[]).map((preset) => (
              <button
                key={preset}
                type="button"
                className={trimPreset === preset ? "active" : ""}
                onClick={() => onSetTrimPreset(preset)}
                disabled={isExporting}
              >
                {presetLabels[preset]}
              </button>
            ))}
          </div>

          <p>Accurate export re-encodes for precise cuts and compatibility.</p>
          {trimError ? <span className="trim-error">{trimError}</span> : null}

          {isExporting ? (
            <button type="button" className="danger trim-main-action" onClick={onCancelTrimExport}>
              <Square size={16} />
              <span>Cancel export</span>
            </button>
          ) : (
            <button type="button" className="primary trim-main-action" onClick={onExportTrimClip} disabled={!trimCanExport}>
              <Scissors size={16} />
              <span>Export Clip</span>
            </button>
          )}
        </section>

        <section className="trim-card trim-result-card" aria-label="Trim result">
          <div className="trim-card-header">
            <strong>Result</strong>
            <span>{exported ? "Ready" : trimExport?.status ?? "Waiting"}</span>
          </div>

          {trimExport ? (
            <div className="trim-progress" aria-label="Clip export progress">
              <div>
                <span>{trimExport.message ?? "Exporting clip..."}</span>
                <strong>{progress}%</strong>
              </div>
              <div className="trim-progress-track">
                <span style={{ width: `${progress}%` }} />
              </div>
            </div>
          ) : (
            <p>Export status and output actions will appear here.</p>
          )}

          {exported ? (
            <span className="trim-output" title={trimOutputPath ?? undefined}>
              Created {trimFileName(trimOutputPath)}
            </span>
          ) : null}

          <div className="trim-result-actions">
            <button type="button" onClick={onOpenTrimResult} disabled={!exported}>
              <Play size={15} />
              <span>Open Clip</span>
            </button>
            <button type="button" onClick={onShowTrimResult} disabled={!exported}>
              <FolderSearch size={15} />
              <span>Show File</span>
            </button>
            <button type="button" onClick={onClose}>
              <X size={15} />
              <span>Cancel</span>
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
