import { ListVideo } from "lucide-react";
import type { MediaInspectionItem } from "../../player/types";
import { ShelfCloseButton, ShelfHeader } from "./ShelfHeader";
import type { MediaShelvesProps } from "./types";

function StreamCard({
  className,
  item,
  onClick,
  title,
}: {
  className: string;
  item: MediaInspectionItem;
  onClick?: () => void;
  title?: string;
}) {
  const content = (
    <>
      <span>{item.label}</span>
      <strong>{item.value}</strong>
      {item.detail ? <small>{item.detail}</small> : null}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={className} onClick={onClick} title={title}>
        {content}
      </button>
    );
  }

  return <div className={className}>{content}</div>;
}

export function TracksShelf({
  audioInspectionItems,
  currentPath,
  dataInspectionItems,
  mediaInspectionLoading,
  nativeAudioTrackCount,
  nativeAudioTrackIndex,
  onClearSubtitleTrack,
  onClose,
  onOpenSubtitle,
  onRefreshInspection,
  onSelectNativeAudioTrack,
  onToggleSubtitles,
  streamInspectionItems,
  subtitleInspectionItems,
  subtitleTrackLabel,
  subtitlesEnabled,
  videoInspectionItems,
}: MediaShelvesProps) {
  return (
    <div className="shelf-section tracks-section">
      <ShelfHeader
        icon={<ListVideo size={17} />}
        title="Tracks"
        meta={mediaInspectionLoading ? "Detecting..." : `${streamInspectionItems.length} streams`}
        actions={
          <>
            <button type="button" onClick={onRefreshInspection} disabled={!currentPath || mediaInspectionLoading}>
              Refresh
            </button>
            <ShelfCloseButton label="Close tracks" onClose={onClose} />
          </>
        }
      />

      <div className="tracks-panel">
        <div className="track-group">
          <span className="track-group-title">Video</span>
          <div className="track-list">
            {videoInspectionItems.length ? (
              videoInspectionItems.map((item, index) => (
                <StreamCard className="track-card video active" item={item} key={`${item.label}-${index}`} />
              ))
            ) : (
              <p className="empty-state">No video stream detected</p>
            )}
          </div>
        </div>

        <div className="track-group">
          <span className="track-group-title">Audio</span>
          <div className="track-list">
            {audioInspectionItems.length ? (
              audioInspectionItems.map((item, index) => {
                const isActive = nativeAudioTrackCount > 1 ? nativeAudioTrackIndex === index : index === 0;
                return (
                  <button
                    type="button"
                    className={`track-card audio ${isActive ? "active" : ""}`}
                    key={`${item.label}-${index}`}
                    onClick={() => onSelectNativeAudioTrack(index)}
                    title={
                      nativeAudioTrackCount > 1
                        ? "Switch audio track"
                        : "Native audio switching is not exposed for this file yet"
                    }
                  >
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                    <small>
                      {nativeAudioTrackCount > 1
                        ? isActive
                          ? "selected"
                          : "click to switch"
                        : item.detail ?? "detected"}
                    </small>
                  </button>
                );
              })
            ) : (
              <p className="empty-state">No audio stream detected</p>
            )}
          </div>
        </div>

        <div className="track-group">
          <span className="track-group-title">Subtitles</span>
          <div className="track-list">
            {subtitleTrackLabel ? (
              <div className={`track-card subtitle ${subtitlesEnabled ? "active" : ""}`}>
                <span>Sidecar</span>
                <strong>{subtitleTrackLabel}</strong>
                <small>{subtitlesEnabled ? "visible" : "hidden"}</small>
                <div className="track-actions">
                  <button type="button" onClick={onToggleSubtitles}>
                    {subtitlesEnabled ? "Hide" : "Show"}
                  </button>
                  <button type="button" onClick={onClearSubtitleTrack}>
                    Clear
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="track-card subtitle add-track" onClick={onOpenSubtitle}>
                <span>Sidecar</span>
                <strong>Load subtitle</strong>
                <small>SRT or VTT</small>
              </button>
            )}

            {subtitleInspectionItems.map((item, index) => (
              <StreamCard className="track-card subtitle" item={item} key={`${item.label}-${index}`} />
            ))}
          </div>
        </div>

        <div className="track-group">
          <span className="track-group-title">Data</span>
          <div className="track-list">
            {dataInspectionItems.length ? (
              dataInspectionItems.map((item, index) => (
                <StreamCard className="track-card data" item={item} key={`${item.label}-${index}`} />
              ))
            ) : (
              <p className="empty-state">No data streams</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
