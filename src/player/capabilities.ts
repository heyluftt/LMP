import type { MediaKind } from "../lib/playerBrain";

export type MediaMode = "empty" | Exclude<MediaKind, "unknown">;

export type ShelfCapability =
  | "info"
  | "library"
  | "moments"
  | "pages"
  | "queue"
  | "recent"
  | "settings"
  | "trim"
  | "tracks";

export type MediaCapabilities = {
  mode: MediaMode;
  transportDock: boolean;
  staticViewer: boolean;
  timedPlayback: boolean;
  volume: boolean;
  speed: boolean;
  queue: boolean;
  moments: boolean;
  captions: boolean;
  tracks: boolean;
  loopPoints: boolean;
  imageTools: boolean;
  documentPages: boolean;
  documentPrint: boolean;
  textTools: boolean;
  miniPlayer: boolean;
  shelves: readonly ShelfCapability[];
};

const sharedShelves = ["recent", "library", "info", "settings"] as const;

const capabilityByMode: Record<MediaMode, MediaCapabilities> = {
  empty: {
    mode: "empty",
    transportDock: false,
    staticViewer: false,
    timedPlayback: false,
    volume: false,
    speed: false,
    queue: false,
    moments: false,
    captions: false,
    tracks: false,
    loopPoints: false,
    imageTools: false,
    documentPages: false,
    documentPrint: false,
    textTools: false,
    miniPlayer: false,
    shelves: ["settings"],
  },
  video: {
    mode: "video",
    transportDock: true,
    staticViewer: false,
    timedPlayback: true,
    volume: true,
    speed: true,
    queue: true,
    moments: true,
    captions: true,
    tracks: true,
    loopPoints: true,
    imageTools: false,
    documentPages: false,
    documentPrint: false,
    textTools: false,
    miniPlayer: true,
    shelves: ["trim", "queue", "moments", "tracks", ...sharedShelves],
  },
  audio: {
    mode: "audio",
    transportDock: true,
    staticViewer: false,
    timedPlayback: true,
    volume: true,
    speed: true,
    queue: true,
    moments: false,
    captions: false,
    tracks: false,
    loopPoints: false,
    imageTools: false,
    documentPages: false,
    documentPrint: false,
    textTools: false,
    miniPlayer: true,
    shelves: ["queue", ...sharedShelves],
  },
  image: {
    mode: "image",
    transportDock: true,
    staticViewer: true,
    timedPlayback: false,
    volume: false,
    speed: false,
    queue: true,
    moments: false,
    captions: false,
    tracks: false,
    loopPoints: false,
    imageTools: true,
    documentPages: false,
    documentPrint: false,
    textTools: false,
    miniPlayer: false,
    shelves: ["queue", ...sharedShelves],
  },
  document: {
    mode: "document",
    transportDock: true,
    staticViewer: true,
    timedPlayback: false,
    volume: false,
    speed: false,
    queue: true,
    moments: false,
    captions: false,
    tracks: false,
    loopPoints: false,
    imageTools: false,
    documentPages: true,
    documentPrint: true,
    textTools: false,
    miniPlayer: false,
    shelves: ["pages", "queue", ...sharedShelves],
  },
  text: {
    mode: "text",
    transportDock: false,
    staticViewer: true,
    timedPlayback: false,
    volume: false,
    speed: false,
    queue: false,
    moments: false,
    captions: false,
    tracks: false,
    loopPoints: false,
    imageTools: false,
    documentPages: false,
    documentPrint: false,
    textTools: true,
    miniPlayer: false,
    shelves: sharedShelves,
  },
};

export function mediaModeFor(kind: MediaKind): MediaMode {
  return kind === "unknown" ? "empty" : kind;
}

export function capabilitiesFor(mode: MediaMode): MediaCapabilities {
  return capabilityByMode[mode];
}

export function canOpenShelf(capabilities: MediaCapabilities, shelf: ShelfCapability | null) {
  return Boolean(shelf && capabilities.shelves.includes(shelf));
}
