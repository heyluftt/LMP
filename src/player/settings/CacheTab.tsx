import { formatBytes } from "../../lib/mediaFormat";
import type { CacheStatus, SettingsCacheStatus } from "../types";

type CacheTabProps = {
  cacheStatus: SettingsCacheStatus | null;
  onClearMediaProbeCache: () => void;
  onClearPreparedVideoCache: () => void;
  onClearPreviewCache: () => void;
};

function cacheSizeLabel(status: CacheStatus | null | undefined) {
  if (!status) {
    return "Checking size...";
  }
  return `${formatBytes(status.byteLen)} - ${status.fileCount} ${status.fileCount === 1 ? "file" : "files"}`;
}

export function CacheTab({
  cacheStatus,
  onClearMediaProbeCache,
  onClearPreparedVideoCache,
  onClearPreviewCache,
}: CacheTabProps) {
  return (
    <div className="settings-cache-list">
      <div className="viewer-note settings-cache-note">
        <strong>Preview cache</strong>
        <span>Thumbnails and audio artwork - {cacheSizeLabel(cacheStatus?.preview)}</span>
        <button type="button" onClick={onClearPreviewCache}>Clear preview cache</button>
      </div>

      <div className="viewer-note settings-cache-note">
        <strong>Prepared video cache</strong>
        <span>Native playback remux files - {cacheSizeLabel(cacheStatus?.preparedVideo)}</span>
        <button type="button" onClick={onClearPreparedVideoCache}>Clear prepared video cache</button>
      </div>

      <div className="viewer-note settings-cache-note">
        <strong>Media probe cache</strong>
        <span>FFprobe inspection results - {cacheSizeLabel(cacheStatus?.mediaProbe)}</span>
        <button type="button" onClick={onClearMediaProbeCache}>Clear media probe cache</button>
      </div>
    </div>
  );
}
