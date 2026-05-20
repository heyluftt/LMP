import { ListVideo } from "lucide-react";
import { fileName } from "../../lib/playerBrain";
import { mediaKindBadge } from "../../lib/mediaFormat";
import { MediaThumbnail } from "../MediaThumbnail";
import { ShelfCloseButton, ShelfHeader } from "./ShelfHeader";
import type { MediaShelvesProps } from "./types";

export function QueueShelf({
  currentPath,
  onAddFilesToQueue,
  onClearQueue,
  onClose,
  onPlayQueueIndex,
  queue,
  queueCount,
  queueIndex,
}: MediaShelvesProps) {
  return (
    <div className="shelf-section queue-section">
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
          queue.map((path, index) => (
            <button
              key={`${path}-${index}`}
              type="button"
              className={path === currentPath ? "active" : ""}
              onClick={() => onPlayQueueIndex(index)}
              title={path}
            >
              <span className="queue-index">{String(index + 1).padStart(2, "0")}</span>
              <MediaThumbnail path={path} size={15} />
              <strong>{fileName(path)}</strong>
              <small>{mediaKindBadge(path)}</small>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
