import type { MediaKind } from "../lib/playerBrain";

export type EngineName = "native-webview" | "libmpv" | "mpv" | "gstreamer" | "ffmpeg-helper";

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

export type MpvPlaybackSession = {
  active: boolean;
  path?: string | null;
  pid?: number | null;
  started_at?: number | null;
};

export type LibMpvCoreSession = {
  active: boolean;
  path?: string | null;
  startedAt?: number | null;
  ready: boolean;
  paused: boolean;
  position: number;
  duration: number;
  width: number;
  height: number;
  volume: number;
  speed: number;
  ended: boolean;
  error?: string | null;
};

export type LibMpvRenderStatus = {
  available: boolean;
  symbolsLoaded: boolean;
  softwareContext: boolean;
  openglSurfaceRequired: boolean;
  summary: string;
  error?: string | null;
};

export type LibMpvRenderFrameProbe = {
  width: number;
  height: number;
  stride: number;
  touchedBytes: number;
  elapsedMs: number;
  summary: string;
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

export type CacheStatus = {
  fileCount: number;
  byteLen: number;
};

export type SettingsCacheStatus = {
  preview: CacheStatus;
  preparedVideo: CacheStatus;
  mediaProbe: CacheStatus;
};

export type MediaThumbnail = {
  kind: MediaKind | "folder";
  path: string | null;
  source: "cache" | "created" | "source" | "fallback" | string;
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

export type PlaybackEngineId = "native-webview" | "libmpv" | "lmp-av";

export type NativeVideoSurfaceRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type NativeVideoSurfaceStatus = {
  available: boolean;
  active: boolean;
  label: string;
  hwnd: number | null;
  rect: NativeVideoSurfaceRect;
  visible: boolean;
  summary: string;
};

export type PlaybackEngineLoadOptions = {
  source: string;
  volume: number;
  speed: number;
};

export type PlaybackEngineSnapshot = {
  id: PlaybackEngineId;
  canRenderInline: boolean;
  duration: number;
  paused: boolean;
  position: number;
  readyState: number;
  seeking: boolean;
  speed: number;
  volume: number;
};

export interface PlaybackEngine {
  readonly id: PlaybackEngineId;
  readonly canRenderInline: boolean;
  load(options: PlaybackEngineLoadOptions): void;
  play(): Promise<void>;
  pause(): void;
  run(command: PlayerCommand): Promise<void>;
  seekTo(seconds: number, preferFastSeek?: boolean): void;
  snapshot(): PlaybackEngineSnapshot;
}

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
