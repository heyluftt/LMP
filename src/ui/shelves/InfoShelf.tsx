import { Info } from "lucide-react";
import { ShelfCloseButton, ShelfHeader } from "./ShelfHeader";
import { inspectionKindClass, type MediaShelvesProps } from "./types";

export function InfoShelf({
  currentPath,
  mediaInspection,
  mediaInspectionLoading,
  onClose,
  onRefreshInspection,
  overviewInspectionItems,
  streamInspectionItems,
}: MediaShelvesProps) {
  return (
    <div className="shelf-section info-section">
      <ShelfHeader
        icon={<Info size={17} />}
        title="Info"
        meta={mediaInspectionLoading ? "Inspecting..." : mediaInspection?.source ?? "LMP"}
        actions={
          <>
            <button type="button" onClick={onRefreshInspection} disabled={!currentPath || mediaInspectionLoading}>
              Refresh
            </button>
            <ShelfCloseButton label="Close info" onClose={onClose} />
          </>
        }
      />

      <div className="media-info-list">
        {mediaInspectionLoading ? (
          <p className="empty-state">Inspecting media...</p>
        ) : mediaInspection?.summary.length ? (
          <>
            {overviewInspectionItems.length > 0 ? (
              <div className="media-info-group">
                <span className="media-info-group-title">Overview</span>
                <div className="media-info-grid overview">
                  {overviewInspectionItems.map((item, index) => (
                    <div className={`media-info-card ${inspectionKindClass(item)}`} key={`${item.label}-${index}`}>
                      <span>{item.label}</span>
                      <strong>{item.value}</strong>
                      {item.detail ? <small>{item.detail}</small> : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {streamInspectionItems.length > 0 ? (
              <div className="media-info-group">
                <span className="media-info-group-title">Streams</span>
                <div className="media-info-grid streams">
                  {streamInspectionItems.map((item, index) => (
                    <div className={`media-info-card ${inspectionKindClass(item)}`} key={`${item.label}-${index}`}>
                      <span>{item.label}</span>
                      <strong>{item.value}</strong>
                      {item.detail ? <small>{item.detail}</small> : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <p className="empty-state">No media details yet</p>
        )}
      </div>
    </div>
  );
}
