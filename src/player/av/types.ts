export type AvTrackKind = "video" | "audio" | "subtitle";

export type AvTrack = {
  id: number;
  kind: AvTrackKind;
  codecFamily: string;
  codec: string | null;
  description: number[] | null;
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  frameRate: number | null;
  sampleRate: number;
  channels: number;
  bitDepth: number | null;
  language: string | null;
  name: string | null;
  default: boolean;
  forced: boolean;
  defaultDurationUs: number;
  codecDelayUs: number;
  sampleCount: number;
  subtitleFormat: string | null;
};

export type AvChapter = {
  startUs: number;
  endUs: number | null;
  title: string;
};

export type AvMediaInfo = {
  container: string;
  durationUs: number;
  tracks: AvTrack[];
  chapters: AvChapter[];
  title: string | null;
  seekable: boolean;
};

export type AvOpenResult = {
  sessionId: number;
  info: AvMediaInfo;
};

export type AvSample = {
  trackId: number;
  keyframe: boolean;
  ptsUs: number;
  durationUs: number;
  data: Uint8Array;
};

export type AvSampleBatch = {
  samples: AvSample[];
  eof: boolean;
};

export type AvSelectedTracks = {
  video: AvTrack | null;
  audio: AvTrack | null;
  subtitle: AvTrack | null;
};

export type AvPlayerState = "idle" | "opening" | "ready" | "ended" | "error";

export type AvSnapshot = {
  state: AvPlayerState;
  paused: boolean;
  seeking: boolean;
  positionUs: number;
  durationUs: number;
  speed: number;
  volume: number;
  primed: boolean;
};

export type AvCue = {
  start: number;
  end: number;
  text: string;
};

export type AvEngineStats = {
  videoDecoder: string | null;
  audioDecoder: string | null;
  hardware: boolean;
  droppedFrames: number;
  presentedFrames: number;
  bufferedVideoMs: number;
  bufferedAudioMs: number;
  audioUnderruns: number;
};
