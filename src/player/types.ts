import type { MediaKind } from "../lib/playerBrain";

export type EngineName = "native-webview" | "gstreamer" | "ffmpeg-helper";

export type EngineStatus = {
  available: boolean;
  name: string;
  hint?: string;
};

export type PlaybackBackendStatus = {
  id: EngineName;
  name: string;
  role: "primary" | "fallback" | "helper";
  available: boolean;
  version?: string | null;
  path?: string | null;
  hint?: string | null;
};

export type GstreamerProbe = {
  summary: string[];
  details: string;
};

export type GstreamerPlaybackSession = {
  active: boolean;
  path?: string | null;
  pid?: number | null;
  started_at?: number | null;
};

export type MediaInspectionItem = {
  label: string;
  value: string;
  detail?: string | null;
};

export type MediaInspection = {
  source: string;
  summary: MediaInspectionItem[];
  details: string;
};

export type ThumbnailCacheStatus = {
  path: string;
  fileCount: number;
  byteLen: number;
  maxByteLen: number;
};

export type MediaThumbnail = {
  kind: MediaKind | "folder";
  path: string | null;
  source: "cache" | "generated" | "source" | "fallback" | string;
};

export type ClipPresetId = "balanced" | "highQuality" | "smallFile";

export type ClipExportProgress = {
  jobId: string;
  progress: number;
  status: "running" | "canceling" | "canceled" | "done" | "error";
  message?: string | null;
};

export type MediaFile = {
  path: string;
  display_name: string;
  extension: string;
  byte_len: number;
};

export type MediaFolderItem = {
  path: string;
  display_name: string;
  extension: string;
  byte_len: number;
  kind: MediaKind | "folder";
  modified_at?: number | null;
};

export type MediaFolder = {
  path: string;
  parent?: string | null;
  items: MediaFolderItem[];
};

export type SubtitleFile = {
  path: string;
  display_name: string;
  extension: string;
  content: string;
};

export type PlayerSnapshot = {
  path: string | null;
  title: string;
  kind: MediaKind;
  paused: boolean;
  duration: number;
  position: number;
  volume: number;
  speed: number;
};

export type PlayerCommand =
  | { type: "togglePause" }
  | { type: "stop" }
  | { type: "seekBy"; seconds: number }
  | { type: "seekTo"; seconds: number }
  | { type: "setVolume"; volume: number }
  | { type: "setSpeed"; speed: number }
  | { type: "frameStep"; direction: -1 | 1 };

export type Moment = {
  id: string;
  at: number;
  label: string;
  createdAt: number;
};
