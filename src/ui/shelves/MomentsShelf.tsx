import { X, Sparkles } from "lucide-react";
import { formatClock } from "../../lib/playerBrain";
import { ShelfCloseButton, ShelfHeader } from "./ShelfHeader";
import type { MediaShelvesProps } from "./types";

export function MomentsShelf({
  moments,
  onClose,
  onDeleteMoment,
  onJumpMoment,
  onJumpToMoment,
}: MediaShelvesProps) {
  return (
    <div className="shelf-section moments-section">
      <ShelfHeader
        icon={<Sparkles size={17} />}
        title="Moments"
        actions={
          <>
            <button type="button" onClick={() => onJumpMoment(-1)}>
              Prev
            </button>
            <button type="button" onClick={() => onJumpMoment(1)}>
              Next
            </button>
            <ShelfCloseButton label="Close moments" onClose={onClose} />
          </>
        }
      />

      <div className="moment-list">
        {moments.length === 0 ? (
          <p className="empty-state">No moments saved</p>
        ) : (
          moments.slice(0, 8).map((moment) => (
            <div className="moment-row" key={moment.id}>
              <button
                type="button"
                className="moment-jump"
                onClick={() => onJumpToMoment(moment.at)}
                title="Jump to moment"
              >
                <span>{formatClock(moment.at)}</span>
                <strong>{moment.label}</strong>
              </button>

              <button
                type="button"
                className="moment-delete"
                onClick={() => onDeleteMoment(moment.id)}
                title="Delete moment"
                aria-label="Delete moment"
              >
                <X size={14} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
