import { Disc3, Music2 } from "lucide-react";

import { formatClock } from "../lib/playerBrain";
import type { MediaInspection, MediaInspectionItem } from "../player/types";

export type AudioMetadata = {
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  genre: string | null;
  date: string | null;
  track: string | null;
  codec: string | null;
  quality: string | null;
  container: string | null;
};

function stripExtension(name: string) {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(0, index) : name;
}

function itemValue(items: MediaInspectionItem[], label: string) {
  const match = items.find((item) => item.label.toLowerCase() === label.toLowerCase());
  return match?.value?.trim() || null;
}

function firstAudioStream(items: MediaInspectionItem[]) {
  return items.find((item) => item.label.toLowerCase().startsWith("audio"));
}

function compactCodec(value: string | null) {
  if (!value) {
    return null;
  }
  return value.split(" - ")[0]?.trim() || value;
}

function compactTag(value: string | null) {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function audioInitials(metadata: AudioMetadata) {
  const source = metadata.artist || metadata.albumArtist || metadata.title || "LMP";
  const words = source
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

export function audioMetadataFromInspection(
  inspection: MediaInspection | null,
  fallbackTitle: string,
): AudioMetadata {
  const items = inspection?.summary ?? [];
  const stream = firstAudioStream(items);
  const container = items.find((item) => item.label.toLowerCase() === "container");

  return {
    title: compactTag(itemValue(items, "Title")) ?? stripExtension(fallbackTitle),
    artist: compactTag(itemValue(items, "Artist")),
    album: compactTag(itemValue(items, "Album")),
    albumArtist: compactTag(itemValue(items, "Album artist")),
    genre: compactTag(itemValue(items, "Genre")),
    date: compactTag(itemValue(items, "Date")),
    track: compactTag(itemValue(items, "Track")),
    codec: compactCodec(stream?.value ?? null),
    quality: stream?.detail ?? null,
    container: container?.value ?? null,
  };
}

export function AudioNowPlaying({
  artworkUrl,
  metadata,
  metaLabel,
  paused,
  position,
  duration,
}: {
  artworkUrl: string | null;
  metadata: AudioMetadata;
  metaLabel: string;
  paused: boolean;
  position: number;
  duration: number;
}) {
  const primaryArtist = metadata.artist ?? metadata.albumArtist;
  const byline = [primaryArtist, metadata.album].filter(Boolean).join(" - ");
  const fallbackLine = [metadata.container, metadata.codec].filter(Boolean).join(" - ");
  const supportingLine = byline || fallbackLine || metaLabel;
  const initials = audioInitials(metadata);
  const detailChips = [
    metadata.track ? `Track ${metadata.track}` : null,
    metadata.codec,
    metadata.quality,
    metadata.genre,
    metadata.date,
    duration > 0 ? formatClock(duration) : null,
  ].filter((detail): detail is string => Boolean(detail));

  return (
    <div className={`now-playing audio-panel audio-v2 ${artworkUrl ? "has-artwork" : ""}`}>
      <div className="audio-artwork" aria-hidden="true">
        {artworkUrl ? (
          <img src={artworkUrl} alt="" draggable={false} />
        ) : (
          <div className="audio-artwork-fallback">
            <Music2 size={42} strokeWidth={1.7} />
            <strong>{initials}</strong>
            <Disc3 size={16} strokeWidth={2} />
          </div>
        )}
      </div>

      <div className="audio-copy">
        <p>
          <span className={`audio-state-dot ${paused ? "paused" : "playing"}`} aria-hidden="true" />
          {paused ? "paused" : "playing"}
        </p>
        <h1>{metadata.title}</h1>
        {supportingLine ? <strong>{supportingLine}</strong> : null}
      </div>

      <div className="audio-progress-text" aria-label="Audio progress">
        <span>{formatClock(position)}</span>
        <span>{duration > 0 ? formatClock(duration) : "--:--"}</span>
      </div>

      {detailChips.length > 0 ? (
        <div className="audio-detail-chips" aria-label="Audio details">
          {detailChips.slice(0, 4).map((detail) => (
            <span key={detail}>{detail}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
