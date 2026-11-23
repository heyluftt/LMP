import { ArrowDown, ArrowUp, ListVideo, X } from "lucide-react";
import { fileName } from "../../lib/playerBrain";
import { mediaKindBadge } from "../../lib/mediaFormat";
import { MediaThumbnail } from "../MediaThumbnail";
import { ShelfCloseButton, ShelfHeader } from "./ShelfHeader";
import type { MediaShelvesProps } from "./types";

export type QueueShelfProps = Pick<
  MediaShelvesProps,
  | "currentPath"
  | "onAddFilesToQueue"
  | "onClearQueue"
  | "onClose"
  | "onMoveQueueItem"
  | "onPlayQueueIndex"
  | "onRemoveQueueItem"
  | "queue"
  | "queueCount"
  | "queueIndex"
>;

export function QueueShelf({
  currentPath,
  onAddFilesToQueue,
  onClearQueue,
  onClose,
  onMoveQueueItem,
  onPlayQueueIndex,
  onRemoveQueueItem,
  queue,
  queueCount,
  queueIndex,
}: QueueShelfProps) {
  return (
    <div className="shelf-section queue-section" data-wheel-volume="ignore">
      <ShelfHeader
        icon={<ListVideo size={17} />}
        title="Queue"
        meta={queueIndex >= 0 ? `${queueIndex + 1}/${queueCount}` : `${queueCount} items`}
        actions={
          <>
            <button type="button" onClick={onAddFilesToQueue}>
              Add
            </button>
            <button type="button" onClick={onClearQueue}>
              Clear
            </button>
            <ShelfCloseButton label="Close queue" onClose={onClose} />
          </>
        }
      />

      <div className="queue-list">
        {queue.length === 0 ? (
          <p className="empty-state">No queued media</p>
        ) : (
          queue.map((path, index) => {
            const active = path === currentPath;
            return (
              <div
                key={`${path}-${index}`}
                className={`queue-item ${active ? "active" : ""}`}
                title={path}
              >
                <button type="button" className="queue-play-button" onClick={() => onPlayQueueIndex(index)}>
                  <span className="queue-index">{String(index + 1).padStart(2, "0")}</span>
                  <MediaThumbnail path={path} size={15} />
                  <span className="queue-item-text">
                    <strong>{fileName(path)}</strong>
                    <small>{mediaKindBadge(path)}</small>
                  </span>
                </button>
                <span className="queue-item-actions" aria-label="Queue item actions">
                  <button
                    type="button"
                    onClick={() => onMoveQueueItem(index, -1)}
                    disabled={index === 0}
                    title="Move up"
                    aria-label="Move queue item up"
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onMoveQueueItem(index, 1)}
                    disabled={index === queue.length - 1}
                    title="Move down"
                    aria-label="Move queue item down"
                  >
                    <ArrowDown size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemoveQueueItem(index)}
                    disabled={active}
                    title={active ? "Current item stays in queue" : "Remove"}
                    aria-label="Remove queue item"
                  >
                    <X size={13} />
                  </button>
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
