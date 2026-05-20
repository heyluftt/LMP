import { FileVideo } from "lucide-react";
import { fileName } from "../../lib/playerBrain";
import { mediaKindBadge } from "../../lib/mediaFormat";
import { MediaThumbnail } from "../MediaThumbnail";
import { ShelfCloseButton, ShelfHeader } from "./ShelfHeader";
import type { MediaShelvesProps } from "./types";

export function RecentShelf({
  backendHint,
  currentPath,
  engineHint,
  onClearRecent,
  onClose,
  onPlayRecent,
  recent,
}: MediaShelvesProps) {
  return (
    <div className="shelf-section recent-section">
      <ShelfHeader
        icon={<FileVideo size={17} />}
        title="Recent"
        meta={backendHint || "Native playback"}
        metaTitle={engineHint}
        actions={
          <>
            <button type="button" onClick={onClearRecent} disabled={recent.length === 0}>
              Clear
            </button>
            <ShelfCloseButton label="Close recent" onClose={onClose} />
          </>
        }
      />

      <div className="recent-list">
        {recent.length === 0 ? (
          <p className="empty-state">No recent media</p>
        ) : (
          recent.map((path) => (
            <button
              key={path}
              type="button"
              className={path === currentPath ? "active" : ""}
              onClick={() => onPlayRecent(path)}
              title={path}
            >
              <MediaThumbnail path={path} size={15} />
              <strong>{fileName(path)}</strong>
              <span>{mediaKindBadge(path)}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
