import { ListVideo } from "lucide-react";
import type { MediaInspectionItem, PlaybackTrackChoice } from "../../player/types";
import { ShelfCloseButton, ShelfHeader } from "./ShelfHeader";
import type { MediaShelvesProps } from "./types";

function StreamCard({
  className,
  item,
}: {
  className: string;
  item: MediaInspectionItem;
}) {
  return (
    <div className={className}>
      <span>{item.label}</span>
      <strong>{item.value}</strong>
      {item.detail ? <small>{item.detail}</small> : null}
    </div>
  );
}

function TrackChoiceCard({
  active,
  className,
  kindLabel,
  onSelect,
  switchable,
  track,
}: {
  active: boolean;
  className: string;
  kindLabel: string;
  onSelect: () => void;
  switchable: boolean;
  track: PlaybackTrackChoice;
}) {
  const status = active
    ? "selected"
    : !track.supported
      ? "not decodable"
      : switchable
        ? "click to switch"
        : "detected";
  return (
    <button
      type="button"
      className={`track-card ${className} ${active ? "active" : ""}`}
      onClick={onSelect}
      disabled={!switchable || !track.supported}
      title={
        switchable
          ? track.supported
            ? `Switch to ${track.label}`
            : "This track cannot be decoded on this system"
          : "Track switching needs the LMP AV engine (Settings - Engine)"
      }
    >
      <span>{kindLabel}</span>
      <strong>{track.label}</strong>
      <small>{track.detail ? `${track.detail} - ${status}` : status}</small>
    </button>
  );
}

export function TracksShelf({
  activeAudioTrackId,
  activeSubtitleTrackId,
  audioTracks,
  currentPath,
  dataInspectionItems,
  engineLabel,
  mediaInspectionLoading,
  onClearSubtitleTrack,
  onClose,
  onOpenSubtitle,
  onRefreshInspection,
  onSelectAudioTrack,
  onSelectSubtitleTrack,
  onToggleSubtitles,
  streamInspectionItems,
  subtitleTracks,
  subtitleTrackLabel,
  subtitlesEnabled,
  tracksSwitchable,
  videoInspectionItems,
}: MediaShelvesProps) {
  return (
    <div className="shelf-section tracks-section">
      <ShelfHeader
        icon={<ListVideo size={17} />}
        title="Tracks"
        meta={mediaInspectionLoading ? "Detecting..." : `${engineLabel} - ${streamInspectionItems.length} streams`}
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
            {audioTracks.length ? (
              audioTracks.map((track, index) => (
                <TrackChoiceCard
                  active={activeAudioTrackId === track.id}
                  className="audio"
                  key={`audio-${track.id}`}
                  kindLabel={`Audio ${index + 1}`}
                  onSelect={() => onSelectAudioTrack(track.id)}
                  switchable={tracksSwitchable}
                  track={track}
                />
              ))
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

            {subtitleTracks.map((track, index) => (
              <TrackChoiceCard
                active={activeSubtitleTrackId === track.id}
                className="subtitle"
                key={`subtitle-${track.id}`}
                kindLabel={`Embedded ${index + 1}`}
                onSelect={() =>
                  onSelectSubtitleTrack(activeSubtitleTrackId === track.id ? null : track.id)
                }
                switchable={tracksSwitchable}
                track={track}
              />
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
