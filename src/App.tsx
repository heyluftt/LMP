import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  Disc3,
  FileText,
  FileVideo,
  FolderOpen,
  ImageIcon,
} from "lucide-react";
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  clampVolume,
  extension as mediaExtension,
  fileName,
  formatClock,
  mediaKind,
  normalizeSpeed,
  seekStep,
  type MediaKind,
} from "./lib/playerBrain";
import {
  formatBytes,
  formatMediaMeta,
  libraryKindLabel,
} from "./lib/mediaFormat";
import { applyMiniWindowProfile, applyWindowProfile } from "./lib/windowProfile";
import { keyboardCommand } from "./player/keyboard";
import {
  addMoment,
  clearRecent,
  findAdjacentMoment,
  getResume,
  readMoments,
  readRecent,
  rememberMedia,
  removeMoment,
} from "./player/memory";
import {
  compactProbeSummary,
  emptyGstreamerSession,
  isGstreamerActiveFor,
  probeGstreamer,
  readGstreamerPlaybackSession,
  startGstreamerPlayback,
  stopGstreamerPlayback,
} from "./player/fallbackEngine";
import {
  canOpenShelf,
  capabilitiesFor,
  mediaModeFor,
  type ShelfCapability,
} from "./player/capabilities";
import { NativeMediaEngine } from "./player/nativeEngine";
import {
  clampMediaTime,
  commandSeekTarget,
  createPendingSeek,
  shouldKeepOptimisticSeek,
  type PendingSeekState,
} from "./player/playbackSmoothing";
import { ResumeController } from "./player/resumeController";
import { defaultSettings, readSettings, updateSettings } from "./player/settings";
import type { PlayerSettings } from "./player/settings";
import { SettingsPanel, settingsTabsFor, type SettingsTab } from "./player/settingsPanel";
import {
  clampImageZoom,
  defaultImageView,
  nextImageFit,
  type ImageDragState,
  type ImageViewState,
} from "./viewers/image";
import { AudioNowPlaying, audioMetadataFromInspection } from "./viewers/audio";
import {
  createPdfLoadingTask,
  defaultDocumentView,
  PdfViewer,
  type DocumentViewState,
  type PdfLoadingTask,
} from "./viewers/pdf";
import {
  isWordDocumentExtension,
  WordDocumentSurface,
  type WordDocumentContent,
} from "./viewers/word";
import {
  defaultTextView,
  normalizeTextContent,
  type TextEditorHandle,
  type TextFileContent,
  type TextViewState,
} from "./viewers/text";
import { TextTools } from "./viewers/textTools";
import {
  MediaShelves,
  type LibraryFilter,
  type LibrarySort,
  type MediaShelfMode,
} from "./ui/MediaShelves";
import { ContextMenu, type ContextMenuSection } from "./ui/ContextMenu";
import { TransportDock } from "./ui/TransportDock";
import { WindowChrome } from "./ui/WindowChrome";
import type {
  EngineStatus,
  ClipExportProgress,
  ClipPresetId,
  GstreamerPlaybackSession,
  MediaInspection,
  MediaInspectionItem,
  MediaFile,
  MediaFolder,
  MediaFolderItem,
  Moment,
  PlaybackBackendStatus,
  PlayerCommand,
  SubtitleFile,
  ThumbnailCacheStatus,
} from "./player/types";

type ToastTone = "info" | "error" | "success";

const TextEditorSurface = lazy(() =>
  import("./viewers/textEditorSurface").then((module) => ({
    default: module.TextEditorSurface,
  })),
);

type Toast = {
  tone: ToastTone;
  message: string;
};

type ContextMenuState = {
  x: number;
  y: number;
};

type ConfirmDialog = {
  cancelLabel: string;
  confirmLabel: string;
  message: string;
  title: string;
  tone?: "danger" | "normal";
};

type PromptDialog = {
  cancelLabel: string;
  confirmLabel: string;
  message: string;
  title: string;
};

type LoopRange = {
  start: number | null;
  end: number | null;
};

type TrimRange = {
  start: number;
  end: number;
};

type TrimExportState = ClipExportProgress & {
  outputPath?: string | null;
};

type RemuxFallbackState = {
  path: string;
  status: "running" | "done";
};

type MediaOpenRequest = {
  targetLabel: string;
  files: string[];
};

type SubtitleTrack = {
  path: string;
  label: string;
  src: string;
  automatic: boolean;
};

type StartupResumeState = {
  path: string;
  token: number;
  target: number;
};

type MediaDetails = {
  width: number | null;
  height: number | null;
  duration: number | null;
};

type TextMatch = {
  start: number;
  end: number;
};

type NativeAudioTrack = {
  enabled: boolean;
};

type NativeAudioTrackList = {
  length: number;
  [index: number]: NativeAudioTrack | undefined;
};

const playbackPositionRenderIntervalMs = 220;
const playbackPositionJumpThresholdSeconds = 0.45;
const playbackProgressAttemptIntervalMs = 750;
const startupDiagnosticsDelayMs = 450;

function compareLibraryItems(a: MediaFolderItem, b: MediaFolderItem, sort: LibrarySort) {
  if (a.kind === "folder" && b.kind !== "folder") {
    return -1;
  }
  if (a.kind !== "folder" && b.kind === "folder") {
    return 1;
  }

  if (sort === "date") {
    return (b.modified_at ?? 0) - (a.modified_at ?? 0);
  }
  if (sort === "size") {
    return (b.byte_len ?? 0) - (a.byte_len ?? 0);
  }
  if (sort === "type") {
    const kindCompare = libraryKindLabel(a).localeCompare(libraryKindLabel(b), undefined, {
      sensitivity: "base",
    });
    if (kindCompare !== 0) {
      return kindCompare;
    }
  }

  return a.display_name.localeCompare(b.display_name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectTextMatches(
  text: string,
  query: string,
  caseSensitive: boolean,
  wholeWord: boolean,
) {
  const needle = query.trim();
  if (!needle) {
    return [];
  }

  const pattern = wholeWord ? `\\b${escapeRegExp(needle)}\\b` : escapeRegExp(needle);
  const flags = caseSensitive ? "g" : "gi";
  const regex = new RegExp(pattern, flags);
  const matches: TextMatch[] = [];

  for (const match of text.matchAll(regex)) {
    const value = match[0];
    if (!value) {
      continue;
    }
    const start = match.index ?? 0;
    matches.push({ start, end: start + value.length });
  }

  return matches;
}

function countTextLines(text: string) {
  return text.length === 0 ? 0 : text.split("\n").length;
}

function cleanWordBlockText(text: string) {
  return normalizeTextContent(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function headingPrefix(kind: string) {
  const match = /^heading([1-6])$/i.exec(kind);
  const level = match ? Number(match[1]) : 1;
  return "#".repeat(Math.max(1, Math.min(6, level)));
}

function wordDocumentToEditableText(
  document: WordDocumentContent,
  format: PlayerSettings["textWordExtractionFormat"],
) {
  const blocks = document.blocks
    .map((block) => {
      const lines = cleanWordBlockText(block.text);
      if (lines.length === 0) {
        return "";
      }
      if (format === "plain") {
        return lines.join("\n");
      }

      if (block.kind === "list") {
        return lines.map((line) => `- ${line}`).join("\n");
      }
      if (block.kind === "notice") {
        return lines.map((line) => `> ${line}`).join("\n");
      }
      if (block.kind === "heading" || block.kind.toLowerCase().startsWith("heading")) {
        return `${headingPrefix(block.kind)} ${lines.join(" ")}`;
      }
      return lines.join("\n");
    })
    .filter(Boolean);

  return normalizeTextContent(blocks.join("\n\n"));
}

function suggestedExtractedTextPath(path: string) {
  const slash = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  const folder = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name || "document";
  return `${folder}${stem}.extracted.txt`;
}

function describeMediaError(media: HTMLMediaElement) {
  switch (media.error?.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return "Playback was aborted.";
    case MediaError.MEDIA_ERR_NETWORK:
      return "The media file could not be read.";
    case MediaError.MEDIA_ERR_DECODE:
      return "The native media engine could not decode this file.";
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "This format is not supported by the native engine yet.";
    default:
      return "Playback failed.";
  }
}

function errorMessage(error: unknown) {
  if (!error) {
    return "";
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error).replace(/^Error:\s*/i, "");
}

function compactError(error: unknown) {
  const message = errorMessage(error).replace(/\s+/g, " ").trim();
  if (message.length <= 220) {
    return message;
  }

  return `${message.slice(0, 217)}...`;
}

function nextAnimationFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function pdfPrintScale(pageWidth: number, pageCount: number) {
  const targetWidth = pageCount > 80 ? 820 : pageCount > 32 ? 980 : 1220;
  const maxScale = pageCount > 80 ? 1.12 : pageCount > 32 ? 1.28 : 1.55;
  return Math.min(maxScale, Math.max(1, targetWidth / Math.max(1, pageWidth)));
}

async function printPdfDocument(pdf: PDFDocumentProxy, title: string) {
  const root = document.createElement("div");
  root.className = "pdf-print-root";
  root.setAttribute("aria-hidden", "true");

  const previousTitle = document.title;
  document.title = title || previousTitle;
  document.body.classList.add("printing-pdf-document");
  document.body.append(root);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    document.title = previousTitle;
    document.body.classList.remove("printing-pdf-document");
    root.remove();
  };

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = pdfPrintScale(baseViewport.width, pdf.numPages);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Could not prepare PDF canvas for printing.");
      }

      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.aspectRatio = `${canvas.width} / ${canvas.height}`;

      const pageElement = document.createElement("section");
      pageElement.className = "pdf-print-page";
      if (baseViewport.width > baseViewport.height) {
        pageElement.classList.add("landscape");
      }
      pageElement.append(canvas);
      root.append(pageElement);

      await page.render({ canvas, canvasContext: context, viewport }).promise;
    }

    await nextAnimationFrame();
    window.addEventListener("afterprint", cleanup, { once: true });
    window.print();
    window.setTimeout(cleanup, 10 * 60 * 1000);
  } catch (error) {
    cleanup();
    throw error;
  }
}

function printCurrentWebView(title?: string) {
  const previousTitle = document.title;
  if (title) {
    document.title = title;
  }

  try {
    window.print();
  } finally {
    window.setTimeout(() => {
      document.title = previousTitle;
    }, 1000);
  }
}

function isStreamInspectionItem(item: MediaInspectionItem) {
  return /^(video|audio|subtitle|data|attachment|stream)\b/i.test(item.label);
}

function inspectionKindClass(item: MediaInspectionItem) {
  const label = item.label.toLowerCase();
  if (label.startsWith("video")) {
    return "video";
  }
  if (label.startsWith("audio")) {
    return "audio";
  }
  if (label.startsWith("subtitle")) {
    return "subtitle";
  }
  if (label.startsWith("data") || label.startsWith("attachment")) {
    return "data";
  }
  return "meta";
}

function getNativeAudioTracks(media: HTMLMediaElement | null) {
  return (media as unknown as { audioTracks?: NativeAudioTrackList } | null)?.audioTracks ?? null;
}

function isUnsupportedSourceError(error: unknown, media?: HTMLMediaElement) {
  const message = errorMessage(error).toLowerCase();
  return (
    media?.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ||
    message.includes("notsupportederror") ||
    message.includes("supported sources")
  );
}

function canTryRemuxFallback(path: string | null) {
  if (!path) {
    return false;
  }

  return ["ts", "mts", "m2ts"].includes(mediaExtension(path));
}

function describePlaybackProblem(error: unknown, media?: HTMLMediaElement, path?: string | null) {
  if (isUnsupportedSourceError(error, media)) {
    if (canTryRemuxFallback(path ?? null)) {
      return "This TS file is recognized, but the native WebView engine cannot play its container/codec directly yet.";
    }

    return "This file is recognized by LMP, but the native WebView engine cannot play its container/codec yet.";
  }

  return compactError(error) || (media ? describeMediaError(media) : "Playback failed.");
}

function normalizeSubtitleToVtt(file: SubtitleFile) {
  const text = file.content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (file.extension.toLowerCase() === "vtt") {
    const trimmed = text.trimStart();
    return trimmed.startsWith("WEBVTT") ? trimmed : `WEBVTT\n\n${trimmed}`;
  }

  return srtToVtt(text);
}

function srtToVtt(text: string) {
  const cues = text
    .trim()
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);

      if (/^\d+$/.test(lines[0]?.trim() ?? "")) {
        lines.shift();
      }

      if (!lines[0]?.includes("-->")) {
        return "";
      }

      lines[0] = lines[0].replace(/,/g, ".");
      return lines.join("\n");
    })
    .filter(Boolean)
    .join("\n\n");

  return `WEBVTT\n\n${cues}\n`;
}

function uniquePaths(paths: string[]) {
  return paths.filter((path, index) => path && paths.indexOf(path) === index);
}

function App() {
  const windowLabel = getCurrentWindow().label;
  const mediaRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<HTMLElement | null>(null);

  const [engineStatus, setEngineStatus] = useState<EngineStatus>({
    available: true,
    name: "Native media engine",
  });
  const [playbackBackends, setPlaybackBackends] = useState<PlaybackBackendStatus[]>([]);
  const [gstreamerSession, setGstreamerSession] =
    useState<GstreamerPlaybackSession>(emptyGstreamerSession);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [currentMedia, setCurrentMedia] = useState<MediaFile | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [recent, setRecent] = useState<string[]>(() => readRecent());
  const [paused, setPaused] = useState(true);
  const [settings, setSettings] = useState<PlayerSettings>(() => readSettings());
  const [volume, setVolume] = useState(settings.defaultVolume);
  const [speed, setSpeed] = useState(1);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [mediaInspection, setMediaInspection] = useState<MediaInspection | null>(null);
  const [mediaInspectionLoading, setMediaInspectionLoading] = useState(false);
  const [nativeAudioTrackCount, setNativeAudioTrackCount] = useState(0);
  const [nativeAudioTrackIndex, setNativeAudioTrackIndex] = useState(0);
  const [mediaDetails, setMediaDetails] = useState<MediaDetails>({
    width: null,
    height: null,
    duration: null,
  });
  const [audioArtworkUrl, setAudioArtworkUrl] = useState<string | null>(null);
  const [loopRange, setLoopRange] = useState<LoopRange>({ start: null, end: null });
  const [trimRange, setTrimRange] = useState<TrimRange>({ start: 0, end: 0 });
  const [trimPreset, setTrimPreset] = useState<ClipPresetId>("balanced");
  const [trimExport, setTrimExport] = useState<TrimExportState | null>(null);
  const [trimError, setTrimError] = useState<string | null>(null);
  const [moments, setMoments] = useState<Moment[]>([]);
  const [subtitleTrack, setSubtitleTrack] = useState<SubtitleTrack | null>(null);
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);
  const [imageView, setImageView] = useState<ImageViewState>(defaultImageView);
  const [documentView, setDocumentView] = useState<DocumentViewState>(defaultDocumentView);
  const [textView, setTextView] = useState<TextViewState>(defaultTextView);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [wordDocument, setWordDocument] = useState<WordDocumentContent | null>(null);
  const [documentPageCount, setDocumentPageCount] = useState(0);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [documentLayoutTick, setDocumentLayoutTick] = useState(0);
  const [isDocumentDragging, setIsDocumentDragging] = useState(false);
  const [isImageDragging, setIsImageDragging] = useState(false);
  const [libraryFolder, setLibraryFolder] = useState<MediaFolder | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [librarySearch, setLibrarySearch] = useState("");
  const [librarySort, setLibrarySort] = useState<LibrarySort>("name");
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>("all");
  const textWordWrap = settings.textWordWrap;
  const [textFindQuery, setTextFindQuery] = useState("");
  const [textReplaceQuery, setTextReplaceQuery] = useState("");
  const [textReplaceOpen, setTextReplaceOpen] = useState(false);
  const [textCaseSensitive, setTextCaseSensitive] = useState(false);
  const [textWholeWord, setTextWholeWord] = useState(false);
  const [textActiveMatchIndex, setTextActiveMatchIndex] = useState(-1);
  const [shelfMode, setShelfMode] = useState<MediaShelfMode>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("controls");
  const [toolsOpen, setToolsOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialog | null>(null);
  const [promptDialog, setPromptDialog] = useState<PromptDialog | null>(null);
  const [promptInput, setPromptInput] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [miniPlayer, setMiniPlayer] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [controlsPinned, setControlsPinned] = useState(false);
  const [controlActivity, setControlActivity] = useState(0);
  const volumeRef = useRef(volume);
  const lastControlRevealRef = useRef(0);
  const loadTokenRef = useRef(0);
  const activePlaybackPathRef = useRef<string | null>(null);
  const imageDragRef = useRef<ImageDragState | null>(null);
  const documentViewportRef = useRef<HTMLDivElement | null>(null);
  const documentLayoutFrameRef = useRef<number | null>(null);
  const documentPageScrollTargetRef = useRef<"top" | "bottom" | null>(null);
  const documentDragRef = useRef<ImageDragState | null>(null);
  const documentZoomAnchorRef = useRef<{
    clientX: number;
    clientY: number;
    leftRatio: number;
    topRatio: number;
  } | null>(null);
  const textEditorRef = useRef<TextEditorHandle | null>(null);
  const textFindInputRef = useRef<HTMLInputElement | null>(null);
  const textReplaceInputRef = useRef<HTMLInputElement | null>(null);
  const textCloseAllowedRef = useRef(false);
  const windowCloseStateRef = useRef({ isText: false, textDirty: false });
  const confirmWindowCloseRef = useRef<() => boolean | Promise<boolean>>(() => true);
  const windowBackendCloseRequestedRef = useRef(false);
  const windowClosePromptPendingRef = useRef(false);
  const pendingSeekRef = useRef<PendingSeekState | null>(null);
  const startupResumeRef = useRef<StartupResumeState | null>(null);
  const renderedPlaybackPositionRef = useRef(0);
  const lastPlaybackPositionRenderAtRef = useRef(0);
  const lastPlaybackProgressAttemptAtRef = useRef(0);
  const trimPreviewEndRef = useRef<number | null>(null);
  const remuxFallbackRef = useRef<RemuxFallbackState | null>(null);
  const subtitleUrlRef = useRef<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const windowRevealTimerRef = useRef<number | null>(null);
  const confirmDialogResolverRef = useRef<((value: boolean) => void) | null>(null);
  const promptDialogResolverRef = useRef<((value: string | null) => void) | null>(null);
  const settingsRef = useRef(settings);
  const speedRef = useRef(speed);
  settingsRef.current = settings;
  speedRef.current = speed;

  useEffect(() => {
    renderedPlaybackPositionRef.current = position;
  }, [position]);

  useEffect(() => {
    lastPlaybackPositionRenderAtRef.current = 0;
    lastPlaybackProgressAttemptAtRef.current = 0;
  }, [currentPath]);

  const commitPlaybackPosition = useCallback((seconds: number, force = false) => {
    const nextPosition = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    const now = window.performance.now();
    const renderIsDue =
      now - lastPlaybackPositionRenderAtRef.current >= playbackPositionRenderIntervalMs;
    const positionJumped =
      Math.abs(nextPosition - renderedPlaybackPositionRef.current) >=
      playbackPositionJumpThresholdSeconds;

    if (!force && !renderIsDue && !positionJumped) {
      return;
    }

    lastPlaybackPositionRenderAtRef.current = now;
    renderedPlaybackPositionRef.current = nextPosition;
    setPosition(nextPosition);
  }, []);

  const currentTitle = useMemo(
    () => (currentPath ? fileName(currentPath) : "LMP"),
    [currentPath],
  );
  const sourceKind = useMemo(
    () => (currentPath ? mediaKind(currentPath) : "unknown"),
    [currentPath],
  );
  const currentKind: MediaKind = textView.sourceType === "word-extract" ? "text" : sourceKind;
  const queueIndex = currentPath ? queue.indexOf(currentPath) : -1;
  const queueCount = queue.length;
  const hasPreviousQueueItem = queueIndex > 0;
  const hasNextQueueItem = queueIndex >= 0 && queueIndex < queue.length - 1;
  const gstreamerActiveForCurrent = isGstreamerActiveFor(gstreamerSession, currentPath);
  const currentExtension = useMemo(() => (currentPath ? mediaExtension(currentPath) : ""), [currentPath]);
  const isVideo = currentKind === "video";
  const isAudio = currentKind === "audio";
  const isImage = currentKind === "image";
  const isDocument = currentKind === "document";
  const isPdfDocument = isDocument && currentExtension === "pdf";
  const isWordDocument = isDocument && isWordDocumentExtension(currentExtension);
  const isText = currentKind === "text";
  const mediaMode = mediaModeFor(currentKind);
  const baseMediaCapabilities = useMemo(() => capabilitiesFor(mediaMode), [mediaMode]);
  const mediaCapabilities = useMemo(() => {
    if (isDocument && !isPdfDocument) {
      return {
        ...baseMediaCapabilities,
        documentPages: false,
        shelves: baseMediaCapabilities.shelves.filter((shelf) => shelf !== "pages"),
      };
    }
    return baseMediaCapabilities;
  }, [baseMediaCapabilities, isDocument, isPdfDocument]);
  const isStaticViewer = mediaCapabilities.staticViewer;
  const isTimedMedia = mediaCapabilities.timedPlayback;
  const supportsMiniPlayer = mediaCapabilities.miniPlayer;
  const miniPlayerActive = miniPlayer && supportsMiniPlayer;
  const supportsQueue = mediaCapabilities.queue;
  const supportsMoments = mediaCapabilities.moments;
  const supportsLoopPoints = mediaCapabilities.loopPoints;
  const hasMedia = Boolean(sourceUrl);
  const nativeBackend = playbackBackends.find((backend) => backend.id === "native-webview");
  const gstreamerBackend = playbackBackends.find((backend) => backend.id === "gstreamer");
  const ffmpegBackend = playbackBackends.find((backend) => backend.id === "ffmpeg-helper");
  const fallbackStatusLabel =
    settings.fallbackEngine === "off"
      ? "Fallback disabled"
      : gstreamerBackend?.available
        ? "GStreamer detected"
        : "GStreamer missing";
  const backendHint = [
    nativeBackend?.name ?? "Native WebView",
    settings.fallbackEngine !== "off" ? fallbackStatusLabel : null,
    ffmpegBackend?.available ? "FFmpeg helper ready" : null,
  ]
    .filter(Boolean)
    .join(" - ");
  const activeSettingsTabs = settingsTabsFor(currentKind);
  const activeSettingsTab = activeSettingsTabs.some((tab) => tab.id === settingsTab)
    ? settingsTab
    : activeSettingsTabs[0]?.id ?? "shortcuts";
  const loopReady = loopRange.start !== null && loopRange.end !== null;
  const loopArmed = loopRange.start !== null && loopRange.end === null;
  const loopLabel = loopReady
    ? `Loop ${formatClock(loopRange.start ?? 0)} - ${formatClock(loopRange.end ?? 0)}`
    : loopArmed
      ? `Loop A ${formatClock(loopRange.start ?? 0)}`
      : "Loop";
  const trimmedDuration = Math.max(0, trimRange.end - trimRange.start);
  const trimRangeError =
    isVideo && hasMedia
      ? gstreamerActiveForCurrent
        ? "Trim export is not available while GStreamer fallback is playing."
        : !Number.isFinite(trimRange.start) || !Number.isFinite(trimRange.end)
          ? "Trim range needs valid start and end times."
          : trimRange.end <= trimRange.start
            ? "End time must be after start time."
            : trimmedDuration < 0.2
              ? "Clip range is too short. Use at least 0.2 seconds."
              : null
      : null;
  const trimCanExport = isVideo && !trimRangeError;
  const displayedTrimError = trimError ?? trimRangeError;
  const trimOutputPath = trimExport?.outputPath ?? null;
  const baseMetaLabel = isDocument
    ? isWordDocument
      ? wordDocument
        ? `word document - ${wordDocument.wordCount.toLocaleString()} words`
        : "word document"
      : documentPageCount > 0
      ? `document - page ${Math.min(documentView.page, documentPageCount)}/${documentPageCount}`
      : "document"
    : isText
      ? `${textView.lineCount.toLocaleString()} lines`
    : isImage
      ? currentExtension === "gif"
        ? "animated image"
        : "image"
      : loopReady || loopArmed
      ? loopLabel
      : subtitleTrack && subtitlesEnabled
        ? `${currentKind} - captions`
        : currentKind;
  const metaLabel = formatMediaMeta(currentKind, currentMedia, mediaDetails, baseMetaLabel);
  const audioMetadata = useMemo(
    () => audioMetadataFromInspection(mediaInspection, currentTitle),
    [currentTitle, mediaInspection],
  );
  const controlsHidden =
    hasMedia &&
    settings.autoHideControls &&
    !controlsVisible &&
    (isStaticViewer || !paused) &&
    !controlsPinned &&
    !toolsOpen;
  const playerViewClass = [
    "player-view",
    mediaMode !== "empty" ? `${mediaMode}-mode` : "",
    loopReady ? "loop-active" : "",
    loopArmed ? "loop-armed" : "",
    isFullscreen ? "fullscreen-mode" : "",
    miniPlayerActive ? "mini-player" : "",
    settings.minimalControls ? "minimal-controls" : "",
    controlsHidden ? "controls-hidden" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const imageFitLabel = imageView.fit === "actual" ? "1:1" : imageView.fit === "cover" ? "Fill" : "Fit";
  const imageSurfaceStyle = useMemo<CSSProperties>(
    () => ({
      objectFit: imageView.fit === "actual" ? "none" : imageView.fit,
      transform: `translate(${imageView.offsetX}px, ${imageView.offsetY}px) rotate(${imageView.rotation}deg) scale(${imageView.zoom})`,
    }),
    [imageView],
  );
  const overviewInspectionItems = useMemo(
    () => mediaInspection?.summary.filter((item) => !isStreamInspectionItem(item)) ?? [],
    [mediaInspection],
  );
  const streamInspectionItems = useMemo(
    () => mediaInspection?.summary.filter(isStreamInspectionItem) ?? [],
    [mediaInspection],
  );
  const videoInspectionItems = useMemo(
    () => streamInspectionItems.filter((item) => inspectionKindClass(item) === "video"),
    [streamInspectionItems],
  );
  const audioInspectionItems = useMemo(
    () => streamInspectionItems.filter((item) => inspectionKindClass(item) === "audio"),
    [streamInspectionItems],
  );
  const subtitleInspectionItems = useMemo(
    () => streamInspectionItems.filter((item) => inspectionKindClass(item) === "subtitle"),
    [streamInspectionItems],
  );
  const dataInspectionItems = useMemo(
    () => streamInspectionItems.filter((item) => inspectionKindClass(item) === "data"),
    [streamInspectionItems],
  );
  const visibleLibraryItems = useMemo(() => {
    const query = librarySearch.trim().toLowerCase();
    return (libraryFolder?.items ?? [])
      .filter((item) => {
        if (libraryFilter === "all") {
          if (item.kind === "folder") {
            return false;
          }
        } else if (libraryFilter === "folder") {
          if (item.kind !== "folder") {
            return false;
          }
        } else {
          if (item.kind === "folder" || libraryKindLabel(item) !== libraryFilter) {
            return false;
          }
        }
        if (!query) {
          return true;
        }
        return item.display_name.toLowerCase().includes(query) || item.extension.toLowerCase().includes(query);
      })
      .sort((a, b) => compareLibraryItems(a, b, librarySort));
  }, [libraryFilter, libraryFolder?.items, librarySearch, librarySort]);
  const libraryFolderLabel = useMemo(() => {
    if (!libraryFolder?.path) {
      return "Current folder";
    }
    return fileName(libraryFolder.path) || libraryFolder.path;
  }, [libraryFolder?.path]);
  const textFindMatches = useMemo(
    () => collectTextMatches(textView.draft, textFindQuery, textCaseSensitive, textWholeWord),
    [textCaseSensitive, textFindQuery, textView.draft, textWholeWord],
  );
  const textNeedsInitialSave = textView.sourceType === "word-extract" && !textView.savePath;
  const canSaveText = textView.dirty || textNeedsInitialSave;
  const textFindMatchCount = textFindMatches.length;
  const boundedTextActiveMatchIndex =
    textFindMatchCount > 0 && textActiveMatchIndex >= 0
      ? Math.min(textActiveMatchIndex, textFindMatchCount - 1)
      : -1;
  const textFindPositionLabel =
    textFindMatchCount > 0 && boundedTextActiveMatchIndex >= 0
      ? `${boundedTextActiveMatchIndex + 1}/${textFindMatchCount}`
      : textFindMatchCount > 0
        ? `0/${textFindMatchCount}`
        : "-";

  const showToast = useCallback((message: string, tone: ToastTone = "info") => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }

    setToast({ message, tone });
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 4400);
  }, []);

  const settleConfirmDialog = useCallback((value: boolean) => {
    const resolver = confirmDialogResolverRef.current;
    confirmDialogResolverRef.current = null;
    setConfirmDialog(null);
    resolver?.(value);
  }, []);

  const requestConfirm = useCallback((dialog: Partial<ConfirmDialog>) => {
    confirmDialogResolverRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      confirmDialogResolverRef.current = resolve;
      setConfirmDialog({
        cancelLabel: "Cancel",
        confirmLabel: "Discard",
        message: dialog.message ?? "Continue?",
        title: dialog.title ?? "Confirm",
        tone: dialog.tone ?? "normal",
      });
    });
  }, []);

  const settlePromptDialog = useCallback((value: string | null) => {
    const resolver = promptDialogResolverRef.current;
    promptDialogResolverRef.current = null;
    setPromptDialog(null);
    resolver?.(value);
  }, []);

  const requestPrompt = useCallback((dialog: Partial<PromptDialog> & { initialValue?: string }) => {
    promptDialogResolverRef.current?.(null);
    return new Promise<string | null>((resolve) => {
      promptDialogResolverRef.current = resolve;
      setPromptInput(dialog.initialValue ?? "");
      setPromptDialog({
        cancelLabel: dialog.cancelLabel ?? "Cancel",
        confirmLabel: dialog.confirmLabel ?? "Go",
        message: dialog.message ?? "",
        title: dialog.title ?? "Input",
      });
    });
  }, []);

  useEffect(() => {
    if (!textFindQuery.trim() || textFindMatchCount === 0) {
      setTextActiveMatchIndex(-1);
      return;
    }

    setTextActiveMatchIndex((current) => (current >= textFindMatchCount ? textFindMatchCount - 1 : current));
  }, [textFindMatchCount, textFindQuery]);

  const resumeController = useMemo(
    () =>
      new ResumeController({
        isEnabled: () => settingsRef.current.resumePlayback,
        isAllowedPath: (path) => mediaKind(path) === "video",
        isCurrent: (path, token) => loadTokenRef.current === token && activePlaybackPathRef.current === path,
        getSpeed: () => speedRef.current,
        setPosition: (seconds) => commitPlaybackPosition(seconds, true),
        notify: (message) => showToast(message, "info"),
      }),
    [commitPlaybackPosition, showToast],
  );

  useEffect(() => () => resumeController.dispose(), [resumeController]);

  const revealCurrentWindow = useCallback(() => {
    if (windowRevealTimerRef.current !== null) {
      window.clearTimeout(windowRevealTimerRef.current);
      windowRevealTimerRef.current = null;
    }
    void invoke("reveal_current_window").catch(() => undefined);
  }, []);

  const scheduleWindowRevealFallback = useCallback(
    (path: string, token: number, delayMs = 1400) => {
      if (windowRevealTimerRef.current !== null) {
        window.clearTimeout(windowRevealTimerRef.current);
      }

      windowRevealTimerRef.current = window.setTimeout(() => {
        windowRevealTimerRef.current = null;
        const startupResume = startupResumeRef.current;
        if (
          loadTokenRef.current === token &&
          activePlaybackPathRef.current === path &&
          !(startupResume && startupResume.token === token && startupResume.path === path)
        ) {
          void invoke("reveal_current_window").catch(() => undefined);
        }
      }, delayMs);
    },
    [],
  );

  const revealCurrentWindowWhenMediaReady = useCallback(
    (media: HTMLMediaElement) => {
      const token = Number(media.dataset.loadToken ?? 0);
      const startupResume = startupResumeRef.current;
      if (
        token > 0 &&
        token === loadTokenRef.current &&
        currentPath &&
        activePlaybackPathRef.current === currentPath &&
        media.readyState >= 2 &&
        !(startupResume && startupResume.token === token && startupResume.path === currentPath)
      ) {
        revealCurrentWindow();
      }
    },
    [currentPath, revealCurrentWindow],
  );

  useEffect(
    () => () => {
      if (windowRevealTimerRef.current !== null) {
        window.clearTimeout(windowRevealTimerRef.current);
        windowRevealTimerRef.current = null;
      }
    },
    [],
  );

  const scrollDocumentViewportTo = useCallback((scrollTarget: "top" | "bottom") => {
    const viewport = documentViewportRef.current;
    if (!viewport) {
      return;
    }

    requestAnimationFrame(() => {
      viewport.scrollTop = scrollTarget === "bottom" ? viewport.scrollHeight : 0;
    });
  }, []);

  useEffect(() => {
    if (!isPdfDocument || !sourceUrl) {
      setPdfDocument(null);
      setDocumentPageCount(0);
      if (!isWordDocument) {
        setDocumentLoading(false);
        setDocumentError(null);
      }
      return;
    }

    let cancelled = false;
    let loadedDocument: PDFDocumentProxy | null = null;
    let loadingTask: PdfLoadingTask | null = null;

    setPdfDocument(null);
    setDocumentPageCount(0);
    setDocumentLoading(true);
    setDocumentError(null);

    const loadDocument = async () => {
      try {
        loadingTask = await createPdfLoadingTask(sourceUrl);
        const nextDocument = await loadingTask.promise;
        loadedDocument = nextDocument;

        if (cancelled) {
          await nextDocument.destroy();
          return;
        }

        setPdfDocument(nextDocument);
        setDocumentPageCount(nextDocument.numPages);
        setDocumentView((current) => ({
          ...current,
          page: Math.max(1, Math.min(nextDocument.numPages, current.page)),
        }));
        setDocumentLoading(false);
      } catch (error) {
        if (!cancelled) {
          setDocumentLoading(false);
          setDocumentError(compactError(error));
        }
      }
    };

    void loadDocument();

    return () => {
      cancelled = true;
      void loadingTask?.destroy();
      if (loadedDocument) {
        void loadedDocument.destroy();
      }
    };
  }, [isPdfDocument, isWordDocument, sourceUrl]);

  useEffect(() => {
    if (!isDocument) {
      return;
    }

    const refreshLayout = () => {
      if (documentLayoutFrameRef.current !== null) {
        return;
      }

      documentLayoutFrameRef.current = window.requestAnimationFrame(() => {
        documentLayoutFrameRef.current = null;
        setDocumentLayoutTick((current) => current + 1);
      });
    };
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refreshLayout);
    const viewport = documentViewportRef.current;

    window.addEventListener("resize", refreshLayout);
    if (viewport && observer) {
      observer.observe(viewport);
    }

    return () => {
      window.removeEventListener("resize", refreshLayout);
      observer?.disconnect();
      if (documentLayoutFrameRef.current !== null) {
        window.cancelAnimationFrame(documentLayoutFrameRef.current);
        documentLayoutFrameRef.current = null;
      }
    };
  }, [isDocument, sourceUrl]);

  const startPdfPageRender = useCallback(() => {
    setDocumentLoading(true);
    setDocumentError(null);
  }, []);

  const finishPdfPageRender = useCallback(() => {
    const viewportElement = documentViewportRef.current;

    const scrollTarget = documentPageScrollTargetRef.current;
    if (scrollTarget) {
      documentPageScrollTargetRef.current = null;
      scrollDocumentViewportTo(scrollTarget);
    }

    const zoomAnchor = documentZoomAnchorRef.current;
    if (zoomAnchor && viewportElement && viewportElement.scrollWidth > 0 && viewportElement.scrollHeight > 0) {
      documentZoomAnchorRef.current = null;
      const bounds = viewportElement.getBoundingClientRect();
      viewportElement.scrollLeft =
        viewportElement.scrollWidth * zoomAnchor.leftRatio - (zoomAnchor.clientX - bounds.left);
      viewportElement.scrollTop =
        viewportElement.scrollHeight * zoomAnchor.topRatio - (zoomAnchor.clientY - bounds.top);
    }

    setDocumentLoading(false);
    setDocumentError(null);
  }, [scrollDocumentViewportTo]);

  const failPdfPageRender = useCallback((message: string) => {
    setDocumentLoading(false);
    setDocumentError(message);
  }, []);

  const clampPdfDocumentPage = useCallback((page: number) => {
    setDocumentView((current) => ({ ...current, page }));
  }, []);

  const stopTrackedGstreamer = useCallback(
    async (silent = false) => {
      try {
        const session = await stopGstreamerPlayback();
        setGstreamerSession(session);
        if (!silent) {
          showToast("GStreamer fallback stopped.", "info");
        }
      } catch (error) {
        if (!silent) {
          showToast(compactError(error), "error");
        }
      }
    },
    [showToast],
  );

  const startTrackedGstreamer = useCallback(
    async (path: string, summary?: string) => {
      const session = await startGstreamerPlayback(path);
      setGstreamerSession(session);
      setPaused(true);
      showToast(
        summary
          ? `Native playback failed. Started GStreamer fallback: ${summary}.`
          : "Started GStreamer fallback playback.",
        summary ? "error" : "success",
      );
      return session;
    },
    [showToast],
  );

  const inspectMedia = useCallback(async (path: string, loadToken: number) => {
    setMediaInspection(null);
    setMediaInspectionLoading(true);

    try {
      const inspection = await invoke<MediaInspection>("inspect_media", { path });
      if (loadToken === loadTokenRef.current && activePlaybackPathRef.current === path) {
        setMediaInspection(inspection);
      }
    } catch (error) {
      if (loadToken === loadTokenRef.current && activePlaybackPathRef.current === path) {
        setMediaInspection({
          source: "LMP",
          summary: [
            {
              label: "Inspector",
              value: "unavailable",
              detail: compactError(error),
            },
          ],
          details: compactError(error),
        });
      }
    } finally {
      if (loadToken === loadTokenRef.current && activePlaybackPathRef.current === path) {
        setMediaInspectionLoading(false);
      }
    }
  }, []);

  const loadAudioArtwork = useCallback(async (path: string, loadToken: number) => {
    setAudioArtworkUrl(null);

    try {
      const artworkPath = await invoke<string | null>("extract_audio_artwork", { path });
      if (loadToken === loadTokenRef.current && activePlaybackPathRef.current === path) {
        setAudioArtworkUrl(artworkPath ? convertFileSrc(artworkPath) : null);
      }
    } catch {
      if (loadToken === loadTokenRef.current && activePlaybackPathRef.current === path) {
        setAudioArtworkUrl(null);
      }
    }
  }, []);

  const revokeSubtitleUrl = useCallback(() => {
    if (subtitleUrlRef.current) {
      URL.revokeObjectURL(subtitleUrlRef.current);
      subtitleUrlRef.current = null;
    }
  }, []);

  const loadSubtitleFile = useCallback(
    (file: SubtitleFile, automatic = false) => {
      const vtt = normalizeSubtitleToVtt(file);
      if (!vtt.trim()) {
        showToast("Subtitle file is empty or unsupported.", "error");
        return;
      }

      revokeSubtitleUrl();
      const blob = new Blob([vtt], { type: "text/vtt;charset=utf-8" });
      const src = URL.createObjectURL(blob);
      subtitleUrlRef.current = src;
      setSubtitleTrack({
        path: file.path,
        label: file.display_name,
        src,
        automatic,
      });
      setSubtitlesEnabled(true);
      showToast(`${automatic ? "Subtitle found" : "Subtitle loaded"}: ${file.display_name}`, "success");
    },
    [revokeSubtitleUrl, showToast],
  );

  const clearSubtitleTrack = useCallback(
    (notify = false) => {
      revokeSubtitleUrl();
      setSubtitleTrack(null);
      setSubtitlesEnabled(true);
      if (notify) {
        showToast("Subtitles cleared.", "info");
      }
    },
    [revokeSubtitleUrl, showToast],
  );

  const resetImageView = useCallback(() => {
    imageDragRef.current = null;
    setIsImageDragging(false);
    setImageView(defaultImageView);
  }, []);

  const zoomImage = useCallback((direction: -1 | 1) => {
    setImageView((current) => {
      const nextZoom = clampImageZoom(current.zoom + direction * 0.25);
      const shouldResetPan = nextZoom <= 1 && current.fit !== "actual";
      return {
        ...current,
        zoom: nextZoom,
        offsetX: shouldResetPan ? 0 : current.offsetX,
        offsetY: shouldResetPan ? 0 : current.offsetY,
      };
    });
  }, []);

  const zoomImageAtPoint = useCallback((direction: -1 | 1, clientX: number, clientY: number) => {
    const bounds = playerRef.current?.getBoundingClientRect();
    setImageView((current) => {
      const nextZoom = clampImageZoom(current.zoom + direction * 0.25);
      const shouldResetPan = nextZoom <= 1 && current.fit !== "actual";
      if (!bounds || shouldResetPan) {
        return {
          ...current,
          zoom: nextZoom,
          offsetX: shouldResetPan ? 0 : current.offsetX,
          offsetY: shouldResetPan ? 0 : current.offsetY,
        };
      }

      const pointerX = clientX - bounds.left - bounds.width / 2;
      const pointerY = clientY - bounds.top - bounds.height / 2;
      const scaleRatio = nextZoom / Math.max(current.zoom, 0.01);
      return {
        ...current,
        zoom: nextZoom,
        offsetX: pointerX - (pointerX - current.offsetX) * scaleRatio,
        offsetY: pointerY - (pointerY - current.offsetY) * scaleRatio,
      };
    });
  }, []);

  const rotateImage = useCallback(() => {
    setImageView((current) => ({
      ...current,
      rotation: (current.rotation + 90) % 360,
    }));
  }, []);

  const toggleImageActualSize = useCallback(() => {
    imageDragRef.current = null;
    setIsImageDragging(false);
    setImageView((current) => ({
      ...defaultImageView,
      fit: current.fit === "actual" ? "contain" : "actual",
    }));
  }, []);

  const cycleImageFit = useCallback(() => {
    setImageView((current) => ({
      ...defaultImageView,
      fit: nextImageFit(current.fit),
    }));
  }, []);

  const stepDocumentPage = useCallback((direction: -1 | 1) => {
    documentPageScrollTargetRef.current = direction > 0 ? "top" : "bottom";
    setDocumentView((current) => ({
      ...current,
      page: Math.max(
        1,
        documentPageCount > 0
          ? Math.min(documentPageCount, current.page + direction)
          : current.page + direction,
      ),
    }));
  }, [documentPageCount]);

  const setDocumentZoom = useCallback((direction: -1 | 1) => {
    setDocumentView((current) => ({
      ...current,
      fit: "page",
      zoom: Math.max(40, Math.min(320, current.zoom + direction * 15)),
    }));
  }, []);

  const rememberDocumentZoomAnchor = useCallback((clientX: number, clientY: number) => {
    const viewport = documentViewportRef.current;
    if (!viewport) {
      return;
    }

    const bounds = viewport.getBoundingClientRect();
    documentZoomAnchorRef.current = {
      clientX,
      clientY,
      leftRatio: (viewport.scrollLeft + clientX - bounds.left) / Math.max(1, viewport.scrollWidth),
      topRatio: (viewport.scrollTop + clientY - bounds.top) / Math.max(1, viewport.scrollHeight),
    };
  }, []);

  const setDocumentZoomExact = useCallback((zoom: number) => {
    setDocumentView((current) => ({
      ...current,
      fit: "page",
      zoom: Math.max(40, Math.min(320, zoom)),
    }));
  }, []);

  const toggleDocumentFit = useCallback(() => {
    setDocumentView((current) => ({
      ...current,
      fit: current.fit === "width" ? "page" : "width",
      zoom: current.fit === "width" ? 100 : current.zoom,
    }));
  }, []);

  const resetDocumentView = useCallback(() => {
    setDocumentView(defaultDocumentView);
  }, []);

  const selectDocumentPage = useCallback(
    (page: number, scrollTarget: "top" | "bottom" = "top") => {
      const nextPage = Math.max(1, documentPageCount > 0 ? Math.min(documentPageCount, page) : page);
      documentPageScrollTargetRef.current = scrollTarget;
      if (documentView.page === nextPage) {
        scrollDocumentViewportTo(scrollTarget);
      }
      setDocumentView((current) => ({
        ...current,
        page: nextPage,
      }));
    },
    [documentPageCount, documentView.page, scrollDocumentViewportTo],
  );

  const handleDocumentWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      setControlsVisible(true);
      setControlActivity((current) => current + 1);

      event.preventDefault();
      event.stopPropagation();

      if (!pdfDocument || documentLoading || documentError || Math.abs(event.deltaY) < 1) {
        return;
      }

      rememberDocumentZoomAnchor(event.clientX, event.clientY);
      setDocumentZoom(event.deltaY < 0 ? 1 : -1);
    },
    [documentError, documentLoading, pdfDocument, rememberDocumentZoomAnchor, setDocumentZoom],
  );

  const startDocumentDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    const viewport = event.currentTarget;
    const canPan =
      viewport.scrollWidth > viewport.clientWidth + 2 ||
      viewport.scrollHeight > viewport.clientHeight + 2;
    if (!canPan) {
      return;
    }

    event.preventDefault();
    viewport.setPointerCapture(event.pointerId);
    documentDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseX: viewport.scrollLeft,
      baseY: viewport.scrollTop,
    };
    setIsDocumentDragging(true);
  }, []);

  const moveDocumentDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = documentDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const viewport = event.currentTarget;
    viewport.scrollLeft = drag.baseX - (event.clientX - drag.startX);
    viewport.scrollTop = drag.baseY - (event.clientY - drag.startY);
  }, []);

  const endDocumentDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = documentDragRef.current;
    if (drag?.pointerId !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    documentDragRef.current = null;
    setIsDocumentDragging(false);
  }, []);

  const abortNativeMediaLoad = useCallback(() => {
    const media = mediaRef.current;
    if (!media) {
      return;
    }

    try {
      media.pause();
      media.removeAttribute("src");
      delete media.dataset.loadToken;
      media.load();
    } catch {
      // WebView media cancellation is best-effort during rapid source changes.
    }
  }, []);

  const confirmTextNavigation = useCallback(
    async (nextPath: string) => {
      if (!isText || !textView.dirty || nextPath === currentPath) {
        return true;
      }
      return requestConfirm({
        title: "Unsaved text changes",
        message: "Discard unsaved changes and open another file?",
        confirmLabel: "Discard",
        tone: "danger",
      });
    },
    [currentPath, isText, requestConfirm, textView.dirty],
  );

  const confirmWindowClose = useCallback(() => {
    if (!isText || !textView.dirty) {
      return true;
    }
    return requestConfirm({
      title: "Unsaved text changes",
      message: "Discard unsaved changes and close LMP?",
      confirmLabel: "Discard",
      tone: "danger",
    }).then((allowed) => {
      textCloseAllowedRef.current = allowed;
      return allowed;
    });
  }, [isText, requestConfirm, textView.dirty]);
  windowCloseStateRef.current = { isText, textDirty: textView.dirty };
  confirmWindowCloseRef.current = confirmWindowClose;

  const playPath = useCallback(
    async (path: string, options: { skipTextGuard?: boolean } = {}) => {
      if (!options.skipTextGuard && !(await confirmTextNavigation(path))) {
        return;
      }

      const loadToken = loadTokenRef.current + 1;
      loadTokenRef.current = loadToken;
      pendingSeekRef.current = null;
      startupResumeRef.current = null;
      if (windowRevealTimerRef.current !== null) {
        window.clearTimeout(windowRevealTimerRef.current);
        windowRevealTimerRef.current = null;
      }
      activePlaybackPathRef.current = null;
      void stopTrackedGstreamer(true);
      abortNativeMediaLoad();
      setSourceUrl(null);
      setCurrentMedia(null);
      setMediaInspection(null);
      setMediaInspectionLoading(false);
      setAudioArtworkUrl(null);
      setNativeAudioTrackCount(0);
      setNativeAudioTrackIndex(0);
      setPdfDocument(null);
      setWordDocument(null);
      setDocumentPageCount(0);
      setDocumentLoading(false);
      setDocumentError(null);
      documentDragRef.current = null;
      documentZoomAnchorRef.current = null;
      setIsDocumentDragging(false);
      setTextView(defaultTextView);
      setTextFindQuery("");
      setTextReplaceQuery("");
      setTextReplaceOpen(false);
      setTextActiveMatchIndex(-1);
      setPaused(true);
      setMediaDetails({ width: null, height: null, duration: null });
      try {
        const media = await invoke<MediaFile>("prepare_media", { path });
        if (loadToken !== loadTokenRef.current) {
          return;
        }

        const kind = mediaKind(media.path);
        const opensAsExtractedWord = isWordDocumentExtension(mediaExtension(media.path));
        const viewKind: MediaKind = opensAsExtractedWord ? "text" : kind;
        if (kind === "unknown") {
          revealCurrentWindow();
          showToast("This file type is not supported by LMP yet.", "error");
          return;
        }

        const staticKind = kind === "image" || kind === "document" || kind === "text";
        let playablePath = media.path;
        const needsNativePrep =
          settings.fallbackEngine !== "off" && !staticKind && canTryRemuxFallback(media.path);
        const startupResume =
          !staticKind && kind === "video" && settings.resumePlayback
            ? getResume(media.path)
            : null;

        activePlaybackPathRef.current = media.path;
        void applyWindowProfile(viewKind);
        setCurrentMedia(media);
        if (viewKind === "text") {
          setMediaInspection(null);
        } else {
          void inspectMedia(media.path, loadToken);
        }
        if (kind === "audio") {
          void loadAudioArtwork(media.path, loadToken);
        }
        setCurrentPath(media.path);
        setDuration(0);
        if (startupResume && startupResume.position > 5) {
          startupResumeRef.current = {
            path: media.path,
            target: startupResume.position,
            token: loadToken,
          };
          commitPlaybackPosition(startupResume.position, true);
        } else {
          startupResumeRef.current = null;
          commitPlaybackPosition(0, true);
        }
        setPaused(staticKind);
        resetImageView();
        setDocumentView(defaultDocumentView);
        setLoopRange({ start: null, end: null });
        setTrimRange({ start: 0, end: 0 });
        setTrimExport(null);
        setTrimError(null);
        trimPreviewEndRef.current = null;
        setToolsOpen(false);
        setShelfMode(null);
        remuxFallbackRef.current = null;
        resumeController.beginLoad(media.path, loadToken);
        clearSubtitleTrack();
        setMoments(staticKind ? [] : readMoments(media.path));
        setRecent(settings.rememberRecentMedia ? rememberMedia(media.path) : readRecent());

        if (staticKind) {
          if (loadToken !== loadTokenRef.current || activePlaybackPathRef.current !== media.path) {
            return;
          }
          if (opensAsExtractedWord) {
            setSourceUrl(convertFileSrc(media.path));
            setTextView({
              ...defaultTextView,
              loading: true,
              error: null,
              originalPath: media.path,
              savePath: null,
              sourceType: "word-extract",
              suggestedSavePath: suggestedExtractedTextPath(media.path),
            });
            try {
              const document = await invoke<WordDocumentContent>("read_word_document", {
                path: media.path,
              });
              if (loadToken !== loadTokenRef.current || activePlaybackPathRef.current !== media.path) {
                return;
              }
              const content = wordDocumentToEditableText(
                document,
                settings.textWordExtractionFormat,
              );
              setTextView({
                content,
                draft: content,
                dirty: false,
                lineCount: countTextLines(content),
                encoding: "extracted",
                lineEnding: "lf",
                loading: false,
                error: null,
                originalPath: media.path,
                savePath: null,
                sourceType: "word-extract",
                suggestedSavePath: suggestedExtractedTextPath(media.path),
              });
            } catch (error) {
              if (loadToken !== loadTokenRef.current || activePlaybackPathRef.current !== media.path) {
                return;
              }
              setTextView({
                ...defaultTextView,
                loading: false,
                error: compactError(error) || "Word document text could not be extracted.",
                originalPath: media.path,
                savePath: null,
                sourceType: "word-extract",
                suggestedSavePath: suggestedExtractedTextPath(media.path),
              });
            }
            revealCurrentWindow();
            return;
          }
          if (kind === "document") {
            setSourceUrl(convertFileSrc(media.path));
            revealCurrentWindow();
            return;
          }
          if (kind === "text") {
            setTextView((current) => ({ ...current, loading: true, error: null }));
            try {
              const text = await invoke<TextFileContent>("read_text_file", { path: media.path });
              if (loadToken !== loadTokenRef.current || activePlaybackPathRef.current !== media.path) {
                return;
              }
              const content = normalizeTextContent(text.content);
              setTextView({
                content,
                draft: content,
                dirty: false,
                lineCount: countTextLines(content),
                encoding: text.encoding,
                lineEnding: text.line_ending,
                loading: false,
                error: null,
                originalPath: null,
                savePath: media.path,
                sourceType: "file",
                suggestedSavePath: null,
              });
            } catch (error) {
              if (loadToken !== loadTokenRef.current || activePlaybackPathRef.current !== media.path) {
                return;
              }
              setTextView({
                ...defaultTextView,
                loading: false,
                error: compactError(error) || "Text file could not be loaded.",
              });
            }
          }
          setSourceUrl(convertFileSrc(media.path));
          revealCurrentWindow();
          return;
        }

        const sidecar = await invoke<SubtitleFile | null>("find_sidecar_subtitle", { mediaPath: media.path }).catch(
          () => null,
        );
        if (loadToken !== loadTokenRef.current || activePlaybackPathRef.current !== media.path) {
          return;
        }
        if (sidecar) {
          loadSubtitleFile(sidecar, true);
        }

        if (needsNativePrep) {
          setSourceUrl(null);
          const prepToast = window.setTimeout(
            () => {
              if (loadToken === loadTokenRef.current && activePlaybackPathRef.current === media.path) {
                showToast("Preparing TS for native playback...", "info");
              }
            },
            650,
          );

          try {
            const remuxed = await invoke<MediaFile>("transmux_for_native", { path: media.path });
            if (loadToken !== loadTokenRef.current || activePlaybackPathRef.current !== media.path) {
              return;
            }
            playablePath = remuxed.path;
          } catch (fallbackError) {
            window.clearTimeout(prepToast);
            if (loadToken !== loadTokenRef.current || activePlaybackPathRef.current !== media.path) {
              return;
            }
            revealCurrentWindow();
            showToast(
              `TS is recognized, but native playback cannot open it yet. FFmpeg remux failed: ${compactError(
                fallbackError,
              )}`,
              "error",
            );
            return;
          } finally {
            window.clearTimeout(prepToast);
          }
        }

        if (loadToken !== loadTokenRef.current || activePlaybackPathRef.current !== media.path) {
          return;
        }
        setSourceUrl(convertFileSrc(playablePath));
        scheduleWindowRevealFallback(media.path, loadToken, kind === "audio" ? 900 : 1400);
      } catch (error) {
        if (loadToken !== loadTokenRef.current) {
          return;
        }
        revealCurrentWindow();
        showToast(compactError(error), "error");
      }
    },
    [
      abortNativeMediaLoad,
      clearSubtitleTrack,
      commitPlaybackPosition,
      confirmTextNavigation,
      inspectMedia,
      loadAudioArtwork,
      loadSubtitleFile,
      revealCurrentWindow,
      scheduleWindowRevealFallback,
      resumeController,
      resetImageView,
      settings.fallbackEngine,
      settings.rememberRecentMedia,
      settings.resumePlayback,
      settings.textWordExtractionFormat,
      showToast,
      stopTrackedGstreamer,
    ],
  );

  const playQueue = useCallback(
    async (paths: string[], startIndex = 0) => {
      let nextQueue = uniquePaths(paths);
      if (nextQueue.length === 0) {
        return;
      }

      let boundedIndex = Math.max(0, Math.min(nextQueue.length - 1, startIndex));
      const focusedPath = nextQueue[boundedIndex] ?? nextQueue[0]!;
      if (!(await confirmTextNavigation(focusedPath))) {
        return;
      }
      if (mediaKind(focusedPath) === "text") {
        nextQueue = [focusedPath];
        boundedIndex = 0;
      } else if (settings.autoQueueFolder && nextQueue.length === 1) {
        const siblings = await invoke<string[]>("list_sibling_media", { mediaPath: focusedPath }).catch(() => []);
        const siblingQueue = uniquePaths(siblings);
        const siblingIndex = siblingQueue.indexOf(focusedPath);
        if (siblingQueue.length > 1 && siblingIndex >= 0) {
          nextQueue = siblingQueue;
          boundedIndex = siblingIndex;
        }
      }

      setQueue(nextQueue);
      await playPath(nextQueue[boundedIndex], { skipTextGuard: true });
    },
    [confirmTextNavigation, playPath, settings.autoQueueFolder],
  );

  const appendToQueue = useCallback(
    async (paths: string[], playFirstNew = false) => {
      const additions = uniquePaths(paths);
      if (additions.length === 0) {
        return;
      }

      setQueue((current) => {
        return uniquePaths([...current, ...additions]);
      });

      if (!currentPath || playFirstNew) {
        await playPath(additions[0]);
      } else {
        showToast(`${additions.length} item${additions.length === 1 ? "" : "s"} added to queue.`, "success");
      }
    },
    [currentPath, playPath, showToast],
  );

  const handleIncomingOpenRequest = useCallback(
    async (paths: string[]) => {
      const playablePaths = uniquePaths(paths).filter((path) => mediaKind(path) !== "unknown");
      if (playablePaths.length === 0) {
        return;
      }

      await playQueue(playablePaths);
    },
    [playQueue],
  );

  const shouldOpenPickedFilesInCurrentWindow = useCallback(
    (paths: string[]) => {
      const kinds = paths
        .map((path) => mediaKind(path))
        .filter((kind) => kind !== "unknown");
      if (!hasMedia || currentKind === "unknown" || kinds.length === 0) {
        return true;
      }

      const audioOnly = kinds.every((kind) => kind === "audio");
      return currentKind === "audio" && audioOnly && !settings.audioMultiWindow;
    },
    [currentKind, hasMedia, settings.audioMultiWindow],
  );

  const openFile = useCallback(async () => {
    try {
      const paths = await invoke<string[]>("open_files_dialog");
      const playablePaths = uniquePaths(paths).filter((path) => mediaKind(path) !== "unknown");
      if (playablePaths.length === 0) {
        return;
      }
      if (shouldOpenPickedFilesInCurrentWindow(playablePaths)) {
        await playQueue(playablePaths);
        return;
      }
      await invoke("open_files_in_window", { files: playablePaths });
    } catch (error) {
      showToast(String(error), "error");
    }
  }, [playQueue, shouldOpenPickedFilesInCurrentWindow, showToast]);

  const loadLibraryFolder = useCallback(
    async (folderPath?: string | null) => {
      setLibraryLoading(true);
      try {
        const folder = await invoke<MediaFolder>("browse_media_folder", {
          folderPath: folderPath ?? null,
          mediaPath: folderPath ? null : currentPath,
        });
        setLibraryFolder(folder);
        setShelfMode("library");
        setToolsOpen(false);
        setControlsPinned(false);
        setControlsVisible(true);
        setControlActivity((value) => value + 1);
      } catch (error) {
        showToast(compactError(error), "error");
      } finally {
        setLibraryLoading(false);
      }
    },
    [currentPath, showToast],
  );

  const chooseLibraryFolder = useCallback(async () => {
    try {
      const folder = await invoke<string | null>("open_media_folder_dialog");
      if (folder) {
        await loadLibraryFolder(folder);
      }
    } catch (error) {
      showToast(compactError(error), "error");
    }
  }, [loadLibraryFolder, showToast]);

  const toggleShelfMode = useCallback(
    (mode: ShelfCapability) => {
      if (!hasMedia || !canOpenShelf(mediaCapabilities, mode)) {
        setToolsOpen(false);
        setShelfMode(null);
        return;
      }

      setToolsOpen(false);
      setControlsPinned(false);
      setControlsVisible(true);
      setControlActivity((value) => value + 1);
      setShelfMode((current) => (current === mode ? null : mode));
    },
    [hasMedia, mediaCapabilities],
  );

  const closeShelf = useCallback(() => {
    setShelfMode(null);
    setToolsOpen(false);
    setControlsPinned(false);
    setControlsVisible(true);
    setControlActivity((value) => value + 1);
  }, []);

  const addFilesToQueue = useCallback(async () => {
    if (!supportsQueue) {
      showToast("Queue is not used for this file type.", "info");
      return;
    }

    try {
      const paths = await invoke<string[]>("open_files_dialog");
      if (paths.length > 0) {
        await appendToQueue(paths);
      }
    } catch (error) {
      showToast(String(error), "error");
    }
  }, [appendToQueue, showToast, supportsQueue]);

  const playQueueIndex = useCallback(
    async (index: number) => {
      if (index < 0 || index >= queue.length) {
        return;
      }

      await playPath(queue[index]);
    },
    [playPath, queue],
  );

  const openLibraryItem = useCallback(
    async (item: MediaFolderItem) => {
      if (item.kind === "folder") {
        await loadLibraryFolder(item.path);
        return;
      }

      if (item.kind === "text") {
        await playQueue([item.path]);
        return;
      }

      const paths = libraryFolder?.items
        .filter((candidate) => candidate.kind !== "folder")
        .map((candidate) => candidate.path) ?? [item.path];
      const startIndex = Math.max(0, paths.indexOf(item.path));
      await playQueue(paths, startIndex);
    },
    [libraryFolder?.items, loadLibraryFolder, playQueue],
  );

  const playNextQueueItem = useCallback(async () => {
    if (hasNextQueueItem) {
      await playQueueIndex(queueIndex + 1);
      return;
    }

    showToast("End of queue.", "info");
  }, [hasNextQueueItem, playQueueIndex, queueIndex, showToast]);

  const openSubtitle = useCallback(async () => {
    if (!currentPath) {
      showToast("Open a media file first.", "info");
      return;
    }
    if (!isVideo) {
      showToast("Captions are for video files.", "info");
      return;
    }

    try {
      const subtitle = await invoke<SubtitleFile | null>("open_subtitle_dialog", { mediaPath: currentPath });
      if (subtitle) {
        loadSubtitleFile(subtitle);
      }
    } catch (error) {
      showToast(compactError(error), "error");
    }
  }, [currentPath, isVideo, loadSubtitleFile, showToast]);

  const toggleSubtitles = useCallback(() => {
    if (!subtitleTrack) {
      void openSubtitle();
      return;
    }

    setSubtitlesEnabled((enabled) => !enabled);
  }, [openSubtitle, subtitleTrack]);

  const selectNativeAudioTrack = useCallback(
    (index: number) => {
      const tracks = getNativeAudioTracks(mediaRef.current);
      if (!tracks || tracks.length <= 1) {
        showToast("Native audio track switching is not exposed for this file yet.", "info");
        return;
      }

      for (let trackIndex = 0; trackIndex < tracks.length; trackIndex += 1) {
        const track = tracks[trackIndex];
        if (track) {
          track.enabled = trackIndex === index;
        }
      }

      setNativeAudioTrackIndex(index);
      showToast(`Audio track ${index + 1} selected.`, "success");
    },
    [showToast],
  );

  const nativeEngine = useCallback(() => {
    const media = mediaRef.current;
    return media ? new NativeMediaEngine(media) : null;
  }, []);

  const tryRemuxFallback = useCallback(
    async (error?: unknown, media?: HTMLMediaElement) => {
      const path = currentPath;
      if (
        settings.fallbackEngine === "off" ||
        !path ||
        !isUnsupportedSourceError(error, media) ||
        !canTryRemuxFallback(path)
      ) {
        return false;
      }

      const fallback = remuxFallbackRef.current;
      if (fallback?.path === path) {
        return fallback.status === "running";
      }

      remuxFallbackRef.current = { path, status: "running" };
      setPaused(true);
      showToast("Preparing TS for native playback...", "info");

      try {
        const remuxed = await invoke<MediaFile>("transmux_for_native", { path });
        remuxFallbackRef.current = { path, status: "done" };
        resumeController.beginLoad(path, loadTokenRef.current);
        setDuration(0);
        const startupResume = startupResumeRef.current;
        if (startupResume?.path === path && startupResume.token === loadTokenRef.current) {
          commitPlaybackPosition(startupResume.target, true);
        } else {
          commitPlaybackPosition(0, true);
        }
        setSourceUrl(convertFileSrc(remuxed.path));
        scheduleWindowRevealFallback(path, loadTokenRef.current, 1400);
        showToast("TS remuxed without re-encoding.", "success");
      } catch (fallbackError) {
        remuxFallbackRef.current = { path, status: "done" };
        revealCurrentWindow();
        showToast(
          `TS is recognized, but native playback cannot open it yet. FFmpeg remux failed: ${compactError(
            fallbackError,
          )}`,
          "error",
        );
      }

      return true;
    },
    [
      commitPlaybackPosition,
      currentPath,
      resumeController,
      revealCurrentWindow,
      scheduleWindowRevealFallback,
      settings.fallbackEngine,
      showToast,
    ],
  );

  const tryGstreamerProbe = useCallback(async () => {
    if (
      settings.fallbackEngine === "off" ||
      !currentPath ||
      isStaticViewer ||
      !gstreamerBackend?.available
    ) {
      return false;
    }

    try {
      const probe = await probeGstreamer(currentPath);
      await startTrackedGstreamer(currentPath, compactProbeSummary(probe));
      return true;
    } catch (error) {
      if (settings.fallbackEngine === "gstreamer") {
        showToast(`Native playback failed. GStreamer probe failed: ${compactError(error)}`, "error");
        return true;
      }
    }

    return false;
  }, [
    currentPath,
    gstreamerBackend?.available,
    isStaticViewer,
    settings.fallbackEngine,
    showToast,
    startTrackedGstreamer,
  ]);

  const openCurrentWithGstreamer = useCallback(async () => {
    if (!currentPath) {
      showToast("Open a media file first.", "info");
      return;
    }
    if (isStaticViewer) {
      showToast("GStreamer fallback is for audio and video files.", "info");
      return;
    }

    try {
      await startTrackedGstreamer(currentPath);
    } catch (error) {
      showToast(compactError(error), "error");
    }
  }, [currentPath, isStaticViewer, showToast, startTrackedGstreamer]);

  const handlePlaybackProblem = useCallback(
    async (error?: unknown, media?: HTMLMediaElement) => {
      if (await tryRemuxFallback(error, media)) {
        return true;
      }

      if (await tryGstreamerProbe()) {
        revealCurrentWindow();
        return true;
      }

      revealCurrentWindow();
      showToast(describePlaybackProblem(error, media, currentPath), "error");
      return true;
    },
    [currentPath, revealCurrentWindow, showToast, tryGstreamerProbe, tryRemuxFallback],
  );

  const isActiveMediaElement = useCallback(
    (media: HTMLMediaElement) => {
      const token = Number(media.dataset.loadToken ?? 0);
      return !isStaticViewer && token > 0 && token === loadTokenRef.current;
    },
    [isStaticViewer],
  );

  const runCommand = useCallback(
    async (command: PlayerCommand) => {
      if (!isTimedMedia) {
        return;
      }

      if (gstreamerActiveForCurrent) {
        if (command.type === "togglePause" || command.type === "stop") {
          await stopTrackedGstreamer();
        } else {
          showToast("GStreamer fallback is running in its own playback window for now.", "info");
        }
        return;
      }

      const player = nativeEngine();
      if (!player) {
        showToast("Open a media file first.", "info");
        return;
      }

      resumeController.cancelUserAction();
      try {
        const media = mediaRef.current;
        if (media) {
          const duration = Number.isFinite(media.duration) ? media.duration : 0;
          const seekTarget = commandSeekTarget(command, media.currentTime || 0, duration);
          if (seekTarget !== null) {
            pendingSeekRef.current = createPendingSeek(seekTarget, duration);
            commitPlaybackPosition(seekTarget, true);
          }
        }
        await player.run(command);
      } catch (error) {
        await handlePlaybackProblem(error);
      }
    },
    [
      gstreamerActiveForCurrent,
      handlePlaybackProblem,
      commitPlaybackPosition,
      isTimedMedia,
      nativeEngine,
      resumeController,
      showToast,
      stopTrackedGstreamer,
    ],
  );

  const playPreviousQueueItem = useCallback(async () => {
    if (hasPreviousQueueItem) {
      await playQueueIndex(queueIndex - 1);
      return;
    }

    if (isStaticViewer) {
      showToast("Start of queue.", "info");
      return;
    }

    await runCommand({ type: "seekTo", seconds: 0 });
  }, [hasPreviousQueueItem, isStaticViewer, playQueueIndex, queueIndex, runCommand, showToast]);

  const togglePause = useCallback(async () => {
    if (!isTimedMedia) {
      return;
    }

    if (!mediaRef.current) {
      await openFile();
      return;
    }

    await runCommand({ type: "togglePause" });
  }, [isTimedMedia, openFile, runCommand]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }

      setShelfMode(null);
      setControlsVisible(true);
      await playerRef.current?.requestFullscreen();
    } catch {
      showToast("Fullscreen is not available here.", "error");
    }
  }, [showToast]);

  const send = useCallback(
    async (command: string, value?: number) => {
      if (command === "fullscreen") {
        await toggleFullscreen();
        return;
      }

      switch (command) {
        case "toggle_pause":
          await runCommand({ type: "togglePause" });
          break;
        case "stop":
          await runCommand({ type: "stop" });
          break;
        case "seek":
          await runCommand({ type: "seekBy", seconds: value ?? 0 });
          break;
        case "volume":
          await runCommand({ type: "setVolume", volume: value ?? volume });
          break;
        case "speed":
          await runCommand({ type: "setSpeed", speed: value ?? speed });
          break;
        default:
          showToast(`Unsupported player command: ${command}`, "error");
      }
    },
    [runCommand, showToast, speed, toggleFullscreen, volume],
  );

  const patchSettings = useCallback((patch: Partial<PlayerSettings>) => {
    setSettings((current) => updateSettings(current, patch));
  }, []);

  const toggleMiniPlayer = useCallback(() => {
    if (!supportsMiniPlayer) {
      return;
    }

    setMiniPlayer((current) => {
      const next = !current;
      setToolsOpen(false);
      setShelfMode(null);
      setControlsPinned(false);
      setControlsVisible(!next);
      void (next ? applyMiniWindowProfile(currentKind) : applyWindowProfile(currentKind));
      return next;
    });
  }, [currentKind, supportsMiniPlayer]);

  const resetSettings = useCallback(() => {
    updateSettings(settings, defaultSettings);
    setSettings(defaultSettings);
    volumeRef.current = defaultSettings.defaultVolume;
    setVolume(defaultSettings.defaultVolume);
    void runCommand({ type: "setVolume", volume: defaultSettings.defaultVolume });
  }, [runCommand, settings]);

  const clearThumbnailCache = useCallback(async () => {
    try {
      const status = await invoke<ThumbnailCacheStatus>("clear_thumbnail_cache");
      const size = formatBytes(status.byteLen);
      showToast(
        `Thumbnail cache cleared${size ? ` (${size})` : ""}.`,
        "success",
      );
    } catch (error) {
      showToast(compactError(error), "error");
    }
  }, [showToast]);

  const setPlayerVolume = useCallback(
    (value: number) => {
      const next = clampVolume(value);
      volumeRef.current = next;
      setVolume(next);
      void runCommand({ type: "setVolume", volume: next });
    },
    [runCommand],
  );

  const setPlayerSpeed = useCallback(
    (value: number) => {
      const next = normalizeSpeed(value);
      setSpeed(next);
      void runCommand({ type: "setSpeed", speed: next });
    },
    [runCommand],
  );

  const cycleSpeed = useCallback(() => {
    const choices = settings.speedPresets;
    const index = choices.findIndex((choice) => choice > speed + 0.01);
    setPlayerSpeed(choices[index >= 0 ? index : 0] ?? 1);
  }, [setPlayerSpeed, settings.speedPresets, speed]);

  const nudgeVolumeFromWheel = useCallback(
    (deltaY: number) => {
      if (!hasMedia || !isTimedMedia || Math.abs(deltaY) < 1) {
        return false;
      }

      const direction = deltaY < 0 ? 1 : -1;
      setPlayerVolume(volumeRef.current + direction * settings.wheelVolumeStep);
      return true;
    },
    [hasMedia, isTimedMedia, setPlayerVolume, settings.wheelVolumeStep],
  );

  const revealControls = useCallback(() => {
    const now = Date.now();
    if (controlsVisible && now - lastControlRevealRef.current < 180) {
      return;
    }

    lastControlRevealRef.current = now;
    setControlsVisible(true);
    setControlActivity((value) => value + 1);
  }, [controlsVisible]);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const openContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      revealControls();
      setContextMenu({
        x: Math.max(8, event.clientX),
        y: Math.max(8, event.clientY),
      });
    },
    [revealControls],
  );

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeContextMenu();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [closeContextMenu, contextMenu]);

  useEffect(() => {
    const preventNativeContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };

    window.addEventListener("contextmenu", preventNativeContextMenu, true);
    return () => window.removeEventListener("contextmenu", preventNativeContextMenu, true);
  }, []);

  const startImageDrag = useCallback(
    (event: ReactPointerEvent<HTMLImageElement>) => {
      if (!isImage || (imageView.zoom <= 1 && imageView.fit !== "actual")) {
        return;
      }

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      imageDragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        baseX: imageView.offsetX,
        baseY: imageView.offsetY,
      };
      setIsImageDragging(true);
    },
    [imageView.fit, imageView.offsetX, imageView.offsetY, imageView.zoom, isImage],
  );

  const moveImageDrag = useCallback((event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = imageDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    setImageView((current) => ({
      ...current,
      offsetX: drag.baseX + event.clientX - drag.startX,
      offsetY: drag.baseY + event.clientY - drag.startY,
    }));
  }, []);

  const endImageDrag = useCallback((event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = imageDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      imageDragRef.current = null;
      setIsImageDragging(false);
    }
  }, []);

  const addCurrentMoment = useCallback(() => {
    if (!currentPath) {
      showToast("Open a media file first.", "info");
      return;
    }
    if (!supportsMoments) {
      showToast("Moments are for video files.", "info");
      return;
    }
    const next = addMoment(currentPath, position);
    setMoments(next);
    showToast(`Moment saved at ${formatClock(position)}`, "success");
  }, [currentPath, position, showToast, supportsMoments]);

  const jumpMoment = useCallback(
    (direction: -1 | 1) => {
      const target = findAdjacentMoment(moments, position, direction);
      if (!target) {
        showToast("No moment in that direction.", "info");
        return;
      }
      void runCommand({ type: "seekTo", seconds: target.at });
    },
    [moments, position, runCommand, showToast],
  );

  const printCurrentDocument = useCallback(async () => {
    if (!currentPath || !isDocument) {
      showToast("Open a document first.", "info");
      return;
    }

    try {
      if (pdfDocument) {
        showToast(
          `Preparing ${pdfDocument.numPages} PDF page${pdfDocument.numPages === 1 ? "" : "s"}...`,
          "info",
        );
        await printPdfDocument(pdfDocument, currentTitle);
        showToast("Print preview opened.", "success");
        return;
      }

      printCurrentWebView(currentTitle);
      showToast("Print preview opened.", "info");
    } catch (error) {
      try {
        await invoke("print_file", { path: currentPath });
        showToast("System print handler started.", "success");
      } catch (fallbackError) {
        showToast(compactError(fallbackError || error), "error");
      }
    }
  }, [currentPath, currentTitle, isDocument, pdfDocument, showToast]);

  const updateTextDraft = useCallback((draft: string) => {
    setTextView((current) => ({
      ...current,
      draft,
      dirty: draft !== current.content,
      lineCount: countTextLines(draft),
    }));
  }, []);

  const saveCurrentText = useCallback(async () => {
    if (!currentPath || !isText) {
      showToast("Open a text file first.", "info");
      return;
    }
    if (!textView.dirty && !textNeedsInitialSave) {
      showToast("No text changes to save.", "info");
      return;
    }

    const savedDraft = textView.draft;
    try {
      const writablePath =
        textView.sourceType === "file" && mediaKind(textView.savePath ?? currentPath) === "text"
          ? textView.savePath ?? currentPath
          : null;
      if (!writablePath) {
        const savedMedia = await invoke<MediaFile | null>("save_text_file_dialog", {
          path: textView.suggestedSavePath ?? suggestedExtractedTextPath(currentPath),
          content: savedDraft,
          lineEnding: textView.lineEnding,
          encoding: textView.encoding,
        });
        if (!savedMedia) {
          return;
        }

        const savedContent = normalizeTextContent(savedDraft);
        activePlaybackPathRef.current = savedMedia.path;
        setCurrentPath(savedMedia.path);
        setCurrentMedia(savedMedia);
        setSourceUrl(convertFileSrc(savedMedia.path));
        setTextView((current) => ({
          ...current,
          content: savedContent,
          draft: savedContent,
          dirty: false,
          lineCount: countTextLines(savedContent),
          encoding: current.encoding === "utf-8/lossy" || current.encoding === "extracted" ? "utf-8" : current.encoding || "utf-8",
          originalPath: null,
          savePath: savedMedia.path,
          sourceType: "file",
          suggestedSavePath: null,
        }));
        setRecent(settings.rememberRecentMedia ? rememberMedia(savedMedia.path) : readRecent());
        showToast(`Saved as ${savedMedia.display_name}.`, "success");
        return;
      }

      await invoke("write_text_file", {
        path: writablePath,
        content: savedDraft,
        lineEnding: textView.lineEnding,
        encoding: textView.encoding,
      });
      setTextView((current) => ({
        ...current,
        content: savedDraft,
        dirty: current.draft !== savedDraft,
        lineCount: countTextLines(current.draft),
        encoding: current.encoding === "utf-8/lossy" ? "utf-8" : current.encoding,
        savePath: writablePath,
      }));
      showToast("Text saved.", "success");
    } catch (error) {
      showToast(compactError(error), "error");
    }
  }, [
    currentPath,
    isText,
    settings.rememberRecentMedia,
    showToast,
    textNeedsInitialSave,
    textView.dirty,
    textView.draft,
    textView.encoding,
    textView.lineEnding,
    textView.savePath,
    textView.sourceType,
    textView.suggestedSavePath,
  ]);

  const saveCurrentTextAs = useCallback(async () => {
    if (!isText) {
      showToast("Open a text file first.", "info");
      return;
    }

    const savedDraft = textView.draft;
    try {
      const savedMedia = await invoke<MediaFile | null>("save_text_file_dialog", {
        path: textView.suggestedSavePath ?? currentPath,
        content: savedDraft,
        lineEnding: textView.lineEnding,
        encoding: textView.encoding,
      });
      if (!savedMedia) {
        return;
      }

      const savedContent = normalizeTextContent(savedDraft);
      activePlaybackPathRef.current = savedMedia.path;
      setCurrentPath(savedMedia.path);
      setCurrentMedia(savedMedia);
      setSourceUrl(convertFileSrc(savedMedia.path));
      setTextView((current) => ({
        ...current,
        content: savedContent,
        draft: savedContent,
        dirty: false,
        lineCount: countTextLines(savedContent),
        encoding:
          current.encoding === "utf-8/lossy" || current.encoding === "extracted"
            ? "utf-8"
            : current.encoding || "utf-8",
        originalPath: null,
        savePath: savedMedia.path,
        sourceType: "file",
        suggestedSavePath: null,
      }));
      setRecent(settings.rememberRecentMedia ? rememberMedia(savedMedia.path) : readRecent());
      showToast(`Saved as ${savedMedia.display_name}.`, "success");
    } catch (error) {
      showToast(compactError(error), "error");
    }
  }, [
    currentPath,
    isText,
    settings.rememberRecentMedia,
    showToast,
    textView.draft,
    textView.encoding,
    textView.lineEnding,
    textView.suggestedSavePath,
  ]);

  const revertCurrentText = useCallback(async () => {
    if (!isText) {
      return;
    }
    if (!textView.dirty) {
      showToast("No text changes to revert.", "info");
      return;
    }
    if (
      !(await requestConfirm({
        title: "Revert text",
        message: "Discard unsaved changes and restore the last saved version?",
        confirmLabel: "Revert",
        tone: "danger",
      }))
    ) {
      return;
    }

    setTextView((current) => ({
      ...current,
      draft: current.content,
      dirty: false,
      lineCount: countTextLines(current.content),
    }));
    showToast("Text reverted.", "info");
  }, [isText, requestConfirm, showToast, textView.dirty]);

  const focusTextFind = useCallback((replaceMode = false) => {
    setToolsOpen(true);
    setShelfMode(null);
    if (replaceMode) {
      setTextReplaceOpen(true);
    }
    window.setTimeout(() => {
      const target = replaceMode && textFindQuery.trim() ? textReplaceInputRef.current : textFindInputRef.current;
      target?.focus();
      target?.select();
    }, 0);
  }, [textFindQuery]);

  const goToTextLine = useCallback(async () => {
    if (!isText) {
      return;
    }

    const maxLine = Math.max(1, textView.lineCount);
    const answer = await requestPrompt({
      title: "Go to line",
      message: `Line 1-${maxLine.toLocaleString()}`,
      initialValue: "1",
      confirmLabel: "Go",
    });
    if (!answer) {
      return;
    }

    const line = Number.parseInt(answer, 10);
    if (!Number.isFinite(line) || line < 1 || line > maxLine) {
      showToast(`Line must be between 1 and ${maxLine.toLocaleString()}.`, "info");
      return;
    }

    textEditorRef.current?.goToLine(line);
  }, [isText, requestPrompt, showToast, textView.lineCount]);

  const undoTextEdit = useCallback(() => {
    if (!isText) {
      return;
    }
    textEditorRef.current?.undo();
  }, [isText]);

  const redoTextEdit = useCallback(() => {
    if (!isText) {
      return;
    }
    textEditorRef.current?.redo();
  }, [isText]);

  const selectTextMatch = useCallback(
    (matchIndex: number) => {
      const match = textFindMatches[matchIndex];
      const editor = textEditorRef.current;
      if (!match || !editor) {
        return;
      }

      const select = () => {
        editor.selectRange(match.start, match.end);
      };

      setTextActiveMatchIndex(matchIndex);
      select();
      window.requestAnimationFrame(select);
    },
    [textFindMatches],
  );

  const findTextMatch = useCallback(
    (direction: -1 | 1) => {
      if (!isText) {
        return;
      }

      const query = textFindQuery.trim();
      if (!query) {
        focusTextFind();
        return;
      }

      if (textFindMatches.length === 0) {
        showToast("No text match found.", "info");
        return;
      }

      const editor = textEditorRef.current;
      const activeIndex =
        boundedTextActiveMatchIndex >= 0 && boundedTextActiveMatchIndex < textFindMatches.length
          ? boundedTextActiveMatchIndex
          : -1;
      let nextIndex = -1;

      if (activeIndex >= 0) {
        nextIndex = (activeIndex + direction + textFindMatches.length) % textFindMatches.length;
      } else if (direction > 0) {
        const cursor = editor?.selection().to ?? 0;
        nextIndex = textFindMatches.findIndex((match) => match.start >= cursor);
        if (nextIndex < 0) {
          nextIndex = 0;
        }
      } else {
        const cursor = editor?.selection().from ?? textView.draft.length;
        for (let index = textFindMatches.length - 1; index >= 0; index -= 1) {
          if (textFindMatches[index].end <= cursor) {
            nextIndex = index;
            break;
          }
        }
        if (nextIndex < 0) {
          nextIndex = textFindMatches.length - 1;
        }
      }

      selectTextMatch(nextIndex);
    },
    [
      boundedTextActiveMatchIndex,
      focusTextFind,
      isText,
      selectTextMatch,
      showToast,
      textFindMatches,
      textFindQuery,
      textView.draft.length,
    ],
  );

  const replaceCurrentTextMatch = useCallback(() => {
    if (!isText || !textFindQuery.trim()) {
      focusTextFind(true);
      return;
    }
    if (textFindMatches.length === 0) {
      showToast("No text match found.", "info");
      return;
    }

    const editor = textEditorRef.current;
    let matchIndex =
      boundedTextActiveMatchIndex >= 0 && boundedTextActiveMatchIndex < textFindMatches.length
        ? boundedTextActiveMatchIndex
        : -1;

    if (matchIndex < 0) {
      const cursor = editor?.selection().to ?? 0;
      matchIndex = textFindMatches.findIndex((match) => match.start >= cursor);
      if (matchIndex < 0) {
        matchIndex = 0;
      }
    }

    const match = textFindMatches[matchIndex];
    if (!match) {
      return;
    }

    const replacementEnd = match.start + textReplaceQuery.length;
    if (editor) {
      editor.replaceRange(match.start, match.end, textReplaceQuery);
    } else {
      const nextDraft =
        textView.draft.slice(0, match.start) + textReplaceQuery + textView.draft.slice(match.end);
      setTextView((current) => ({
        ...current,
        draft: nextDraft,
        dirty: nextDraft !== current.content,
        lineCount: countTextLines(nextDraft),
      }));
    }
    setTextActiveMatchIndex(-1);
    window.setTimeout(() => {
      const currentEditor = textEditorRef.current;
      if (!currentEditor) {
        return;
      }
      currentEditor.selectRange(match.start, replacementEnd);
    }, 0);
  }, [
    boundedTextActiveMatchIndex,
    focusTextFind,
    isText,
    showToast,
    textFindMatches,
    textFindQuery,
    textReplaceQuery,
    textView.draft,
  ]);

  const replaceAllTextMatches = useCallback(() => {
    if (!isText || !textFindQuery.trim()) {
      focusTextFind(true);
      return;
    }
    if (textFindMatches.length === 0) {
      showToast("No text match found.", "info");
      return;
    }

    const editor = textEditorRef.current;
    if (editor) {
      editor.replaceRanges(
        textFindMatches.map((match) => ({
          from: match.start,
          insert: textReplaceQuery,
          to: match.end,
        })),
      );
    } else {
      let nextDraft = "";
      let lastIndex = 0;
      for (const match of textFindMatches) {
        nextDraft += textView.draft.slice(lastIndex, match.start);
        nextDraft += textReplaceQuery;
        lastIndex = match.end;
      }
      nextDraft += textView.draft.slice(lastIndex);

      setTextView((current) => ({
        ...current,
        draft: nextDraft,
        dirty: nextDraft !== current.content,
        lineCount: countTextLines(nextDraft),
      }));
    }
    setTextActiveMatchIndex(-1);
    showToast(
      `${textFindMatches.length} replacement${textFindMatches.length === 1 ? "" : "s"} made.`,
      "success",
    );
  }, [
    focusTextFind,
    isText,
    showToast,
    textFindMatches,
    textFindQuery,
    textReplaceQuery,
    textView.draft,
  ]);

  const clearLoop = useCallback(() => {
    setLoopRange({ start: null, end: null });
    showToast("Loop cleared.", "info");
  }, [showToast]);

  const setLoopPoint = useCallback(() => {
    if (!hasMedia) {
      showToast("Open a media file first.", "info");
      return;
    }
    if (!supportsLoopPoints) {
      showToast("Loop points are for video files.", "info");
      return;
    }

    const at = position;
    setLoopRange((current) => {
      if (current.start === null || current.end !== null) {
        showToast(`Loop A set at ${formatClock(at)}`, "success");
        return { start: at, end: null };
      }

      const start = Math.min(current.start, at);
      const end = Math.max(current.start, at);
      if (end - start < 0.35) {
        showToast("Loop needs a little more space.", "info");
        return current;
      }

      showToast(`Loop set: ${formatClock(start)} - ${formatClock(end)}`, "success");
      return { start, end };
    });
  }, [hasMedia, position, showToast, supportsLoopPoints]);

  const setTrimStartFromCurrent = useCallback(() => {
    if (!isVideo || duration <= 0) {
      showToast("Open a video first.", "info");
      return;
    }
    const nextStart = clampMediaTime(position, duration);
    setTrimError(null);
    setTrimRange((current) => ({
      start: nextStart,
      end: current.end > nextStart + 0.2 ? current.end : Math.min(duration, nextStart + 5),
    }));
  }, [duration, isVideo, position, showToast]);

  const setTrimEndFromCurrent = useCallback(() => {
    if (!isVideo || duration <= 0) {
      showToast("Open a video first.", "info");
      return;
    }
    const nextEnd = clampMediaTime(position, duration);
    setTrimError(null);
    setTrimRange((current) => ({
      start: current.start,
      end: nextEnd,
    }));
  }, [duration, isVideo, position, showToast]);

  const jumpToTrimStart = useCallback(() => {
    void runCommand({ type: "seekTo", seconds: trimRange.start });
  }, [runCommand, trimRange.start]);

  const jumpToTrimEnd = useCallback(() => {
    void runCommand({ type: "seekTo", seconds: trimRange.end });
  }, [runCommand, trimRange.end]);

  const previewTrimRange = useCallback(() => {
    if (!trimCanExport) {
      setTrimError(trimRangeError ?? "Set a valid trim range first.");
      return;
    }
    const media = mediaRef.current;
    if (!media) {
      showToast("Open a video first.", "info");
      return;
    }
    trimPreviewEndRef.current = trimRange.end;
    pendingSeekRef.current = createPendingSeek(trimRange.start, duration || 0, 450);
    media.currentTime = trimRange.start;
    commitPlaybackPosition(trimRange.start, true);
    setPaused(false);
    void media.play().catch((error) => {
      trimPreviewEndRef.current = null;
      setPaused(true);
      showToast(compactError(error), "error");
    });
  }, [
    commitPlaybackPosition,
    duration,
    showToast,
    trimCanExport,
    trimRange.end,
    trimRange.start,
    trimRangeError,
  ]);

  const exportTrimClip = useCallback(async () => {
    if (!currentPath || !isVideo) {
      showToast("Open a video first.", "info");
      return;
    }
    if (!trimCanExport) {
      setTrimError(trimRangeError ?? "Set a valid trim range first.");
      return;
    }
    if (trimExport?.status === "running" || trimExport?.status === "canceling") {
      showToast("A clip export is already running.", "info");
      return;
    }

    try {
      setTrimError(null);
      const outputPath = await invoke<string | null>("choose_clip_output_path", {
        inputPath: currentPath,
        startSeconds: trimRange.start,
        endSeconds: trimRange.end,
      });
      if (!outputPath) {
        return;
      }

      const jobId = `clip-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setTrimExport({
        jobId,
        message: "Starting clip export...",
        outputPath,
        progress: 0,
        status: "running",
      });

      const exported = await invoke<MediaFile>("export_video_clip", {
        jobId,
        inputPath: currentPath,
        outputPath,
        startSeconds: trimRange.start,
        endSeconds: trimRange.end,
        preset: trimPreset,
      });
      setTrimExport({
        jobId,
        message: "Clip export complete.",
        outputPath: exported.path,
        progress: 1,
        status: "done",
      });
      showToast(`Clip exported: ${exported.display_name}`, "success");
    } catch (error) {
      const message = compactError(error);
      setTrimError(message);
      setTrimExport((current) => {
        if (!current || current.status === "canceled") {
          return current;
        }
        return {
          ...current,
          message,
          status: message.toLowerCase().includes("cancel") ? "canceled" : "error",
        };
      });
      if (!message.toLowerCase().includes("cancel")) {
        showToast(message, "error");
      }
    }
  }, [
    currentPath,
    isVideo,
    showToast,
    trimCanExport,
    trimExport?.status,
    trimPreset,
    trimRange.end,
    trimRange.start,
    trimRangeError,
  ]);

  const cancelTrimExport = useCallback(() => {
    if (!trimExport?.jobId || (trimExport.status !== "running" && trimExport.status !== "canceling")) {
      return;
    }
    setTrimExport((current) =>
      current ? { ...current, message: "Canceling export...", status: "canceling" } : current,
    );
    void invoke("cancel_clip_export", { jobId: trimExport.jobId }).catch((error) => {
      showToast(compactError(error), "error");
    });
  }, [showToast, trimExport?.jobId, trimExport?.status]);

  const openTrimResult = useCallback(() => {
    if (!trimOutputPath) {
      return;
    }
    void playPath(trimOutputPath);
  }, [playPath, trimOutputPath]);

  const showTrimResult = useCallback(() => {
    if (!trimOutputPath) {
      return;
    }
    void invoke("show_path_in_explorer", { path: trimOutputPath }).catch((error) => {
      showToast(compactError(error), "error");
    });
  }, [showToast, trimOutputPath]);

  useEffect(() => {
    invoke<string[]>("take_startup_files")
      .then((paths) => {
        if (paths.length > 0) {
          void playQueue(paths);
        }
      })
      .catch(() => undefined);

    const unlisten = listen<MediaOpenRequest>("media-open-request", (event) => {
      const { targetLabel, files } = event.payload;
      const accepted = targetLabel === windowLabel;
      void invoke("log_media_open_event", {
        accepted,
        currentLabel: windowLabel,
        files,
        targetLabel,
      }).catch(() => undefined);

      if (!accepted || files.length === 0) {
        return;
      }

      void handleIncomingOpenRequest(files);
    });

    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, [handleIncomingOpenRequest, playQueue, windowLabel]);

  useEffect(() => {
    let disposed = false;
    const timer = window.setTimeout(() => {
      void invoke<EngineStatus>("get_engine_status")
        .then((status) => {
          if (!disposed) {
            setEngineStatus(status);
          }
        })
        .catch((error) => {
          if (!disposed) {
            showToast(String(error), "error");
          }
        });

      void invoke<PlaybackBackendStatus[]>("get_playback_backends")
        .then((backends) => {
          if (!disposed) {
            setPlaybackBackends(backends);
          }
        })
        .catch(() => undefined);

      void readGstreamerPlaybackSession()
        .then((session) => {
          if (!disposed) {
            setGstreamerSession(session);
          }
        })
        .catch(() => undefined);
    }, startupDiagnosticsDelayMs);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [showToast]);

  useEffect(() => {
    const unlisten = listen<ClipExportProgress>("clip-export-progress", (event) => {
      const progress = event.payload;
      setTrimExport((current) => {
        if (!current || current.jobId !== progress.jobId) {
          return current;
        }
        return {
          ...current,
          ...progress,
          outputPath: current.outputPath ?? null,
        };
      });
    });

    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    void invoke("set_window_media_kind", { kind: currentKind, path: currentPath }).catch(() => undefined);
  }, [currentKind, currentPath]);

  useEffect(() => {
    if (!isVideo || duration <= 0) {
      trimPreviewEndRef.current = null;
      return;
    }

    setTrimRange((current) => {
      const start = clampMediaTime(current.start, duration);
      const end = current.end > 0 ? clampMediaTime(current.end, duration) : duration;
      if (start === current.start && end === current.end) {
        return current;
      }
      return { start, end: Math.max(end, Math.min(duration, start + 0.2)) };
    });
  }, [duration, isVideo]);

  useEffect(() => {
    void invoke("set_audio_multi_window", { enabled: settings.audioMultiWindow }).catch(() => undefined);
  }, [settings.audioMultiWindow]);

  useEffect(() => {
    if (!activeSettingsTabs.some((tab) => tab.id === settingsTab)) {
      setSettingsTab(activeSettingsTabs[0]?.id ?? "shortcuts");
    }
  }, [activeSettingsTabs, settingsTab]);

  useEffect(() => {
    if (shelfMode && !canOpenShelf(mediaCapabilities, shelfMode)) {
      setShelfMode(null);
      setToolsOpen(false);
    }
  }, [mediaCapabilities, shelfMode]);

  useEffect(() => {
    if (!miniPlayer) {
      return;
    }

    if (!supportsMiniPlayer) {
      setMiniPlayer(false);
      return;
    }

    void applyMiniWindowProfile(currentKind);
  }, [currentKind, miniPlayer, supportsMiniPlayer]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === playerRef.current);
      setControlsVisible(true);
      setControlActivity((value) => value + 1);
    };

    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media) {
      return;
    }

    Array.from(media.textTracks).forEach((track) => {
      track.mode = subtitleTrack && subtitlesEnabled ? "showing" : "disabled";
    });
  }, [sourceUrl, subtitleTrack, subtitlesEnabled]);

  useEffect(() => () => revokeSubtitleUrl(), [revokeSubtitleUrl]);

  useEffect(() => {
    if (
      !hasMedia ||
      !settings.autoHideControls ||
      (paused && !isStaticViewer) ||
      controlsPinned ||
      toolsOpen
    ) {
      setControlsVisible(true);
      return;
    }

    if (!controlsVisible) {
      return;
    }

    const timeout = window.setTimeout(
      () => setControlsVisible(false),
      settings.controlsHideDelaySeconds * 1000,
    );
    return () => window.clearTimeout(timeout);
  }, [
    controlActivity,
    controlsPinned,
    controlsVisible,
    hasMedia,
    isStaticViewer,
    paused,
    settings.autoHideControls,
    settings.controlsHideDelaySeconds,
    toolsOpen,
  ]);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media || !sourceUrl || isStaticViewer) {
      return;
    }

    const loadToken = loadTokenRef.current;
    const loadPath = activePlaybackPathRef.current;
    let disposed = false;
    let retryTimer: number | null = null;
    let resumePlayTimer: number | null = null;
    let playbackStarted = false;
    let startupPlayRequested = false;
    let startupResumeSettled = false;
    let startupResumeWaitUntil = 0;
    media.dataset.loadToken = String(loadToken);
    const player = new NativeMediaEngine(media);

    const isStillActive = () =>
      !disposed && loadToken === loadTokenRef.current && activePlaybackPathRef.current === loadPath;

    const clearStartupResume = () => {
      const startupResume = startupResumeRef.current;
      if (startupResume?.token === loadToken && startupResume.path === loadPath) {
        startupResumeRef.current = null;
      }
    };

    const attemptPlay = async (retry = true) => {
      if (!isStillActive() || playbackStarted) {
        return;
      }

      playbackStarted = true;
      try {
        await player.play();
      } catch (error) {
        playbackStarted = false;
        if (!isStillActive()) {
          return;
        }

        const message = errorMessage(error).toLowerCase();
        if (retry && (message.includes("abort") || message.includes("interrupted"))) {
          retryTimer = window.setTimeout(() => void attemptPlay(false), 180);
          return;
        }

        setPaused(true);
        const handled = await handlePlaybackProblem(error, media);
        if (!handled) {
          showToast("Press play to start playback.", "info");
        }
      }
    };

    const playAfterStartupResume = () => {
      if (startupResumeSettled) {
        return;
      }
      const startupResume = startupResumeRef.current;
      if (startupResume?.token === loadToken && startupResume.path === loadPath) {
        const actualPosition = media.currentTime || 0;
        const targetReached = Math.abs(actualPosition - startupResume.target) <= 1.25;
        if (!targetReached && performance.now() < startupResumeWaitUntil) {
          resumePlayTimer = window.setTimeout(playAfterStartupResume, 120);
          return;
        }
      }
      startupResumeSettled = true;
      clearStartupResume();
      revealCurrentWindow();
      void attemptPlay();
    };

    const playWhenReady = () => {
      if (!isStillActive() || startupPlayRequested) {
        return;
      }
      startupPlayRequested = true;

      const startupResume = startupResumeRef.current;
      if (startupResume?.token === loadToken && startupResume.path === loadPath) {
        media.addEventListener("seeked", playAfterStartupResume, { once: true });
        const resumeStarted = resumeController.maybeResume(media, startupResume.path, loadToken);
        if (resumeStarted) {
          startupResumeWaitUntil = performance.now() + 2600;
          pendingSeekRef.current = createPendingSeek(startupResume.target, media.duration || 0, 1800);
          resumePlayTimer = window.setTimeout(playAfterStartupResume, 900);
          return;
        }
        media.removeEventListener("seeked", playAfterStartupResume);
        clearStartupResume();
      }

      revealCurrentWindow();
      void attemptPlay();
    };

    media.addEventListener("canplay", playWhenReady, { once: true });
    player.load(sourceUrl, volumeRef.current, speedRef.current);
    retryTimer = window.setTimeout(() => {
      if (media.readyState >= 3) {
        playWhenReady();
      }
    }, 900);

    return () => {
      disposed = true;
      media.removeEventListener("canplay", playWhenReady);
      media.removeEventListener("seeked", playAfterStartupResume);
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      if (resumePlayTimer !== null) {
        window.clearTimeout(resumePlayTimer);
      }
      if (loadToken !== loadTokenRef.current || activePlaybackPathRef.current !== loadPath) {
        try {
          media.pause();
        } catch {
          // Best-effort cleanup while switching files.
        }
      }
    };
  }, [handlePlaybackProblem, isStaticViewer, resumeController, revealCurrentWindow, sourceUrl, showToast]);

  useEffect(() => {
    const media = mediaRef.current;
    volumeRef.current = volume;
    if (media) {
      media.volume = volume / 100;
    }
  }, [volume]);

  useEffect(() => {
    const media = mediaRef.current as
      | (HTMLVideoElement & {
          preservesPitch?: boolean;
          mozPreservesPitch?: boolean;
          webkitPreservesPitch?: boolean;
        })
      | null;

    if (media) {
      media.defaultPlaybackRate = speed;
      media.playbackRate = speed;
      media.preservesPitch = true;
      media.mozPreservesPitch = true;
      media.webkitPreservesPitch = true;
    }
  }, [speed]);

  const savePlaybackProgress = useCallback(
    (media: HTMLMediaElement, force = false) => {
      resumeController.saveProgress(media, currentPath, loadTokenRef.current, force);
    },
    [currentPath, resumeController],
  );

  const maybeSavePlaybackProgress = useCallback(
    (media: HTMLMediaElement) => {
      const now = window.performance.now();
      if (now - lastPlaybackProgressAttemptAtRef.current < playbackProgressAttemptIntervalMs) {
        return;
      }

      lastPlaybackProgressAttemptAtRef.current = now;
      savePlaybackProgress(media);
    },
    [savePlaybackProgress],
  );

  useEffect(() => {
    const saveOnExit = () => {
      const media = mediaRef.current;
      if (media) {
        savePlaybackProgress(media, true);
      }
    };

    window.addEventListener("pagehide", saveOnExit);
    window.addEventListener("beforeunload", saveOnExit);
    return () => {
      window.removeEventListener("pagehide", saveOnExit);
      window.removeEventListener("beforeunload", saveOnExit);
    };
  }, [savePlaybackProgress]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    const requestBackendClose = () => {
      if (windowBackendCloseRequestedRef.current) {
        return;
      }

      windowBackendCloseRequestedRef.current = true;
      void invoke("close_current_window").catch(() => {
        void appWindow.destroy().catch(() => undefined);
      });
    };

    const unlisten = appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      if (windowBackendCloseRequestedRef.current || windowClosePromptPendingRef.current) {
        return;
      }

      const closeState = windowCloseStateRef.current;
      if (textCloseAllowedRef.current || !closeState.isText || !closeState.textDirty) {
        requestBackendClose();
        return;
      }

      windowClosePromptPendingRef.current = true;
      let shouldClose = false;
      try {
        shouldClose = await confirmWindowCloseRef.current();
      } catch {
        shouldClose = false;
      } finally {
        windowClosePromptPendingRef.current = false;
      }

      if (shouldClose) {
        textCloseAllowedRef.current = true;
        requestBackendClose();
      }
    });

    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  const onTimeUpdate = useCallback(
    (media: HTMLMediaElement) => {
      const nextPosition = media.currentTime || 0;
      const previewEnd = trimPreviewEndRef.current;
      if (previewEnd !== null && nextPosition >= previewEnd - 0.03) {
        trimPreviewEndRef.current = null;
        media.pause();
        pendingSeekRef.current = createPendingSeek(previewEnd, media.duration || 0, 250);
        media.currentTime = previewEnd;
        commitPlaybackPosition(previewEnd, true);
        setPaused(true);
        return;
      }

      if (
        loopRange.start !== null &&
        loopRange.end !== null &&
        nextPosition >= loopRange.end - 0.03
      ) {
        pendingSeekRef.current = createPendingSeek(loopRange.start, media.duration || 0, 450);
        media.currentTime = loopRange.start;
        commitPlaybackPosition(loopRange.start, true);
        return;
      }

      if (shouldKeepOptimisticSeek(pendingSeekRef.current, nextPosition, media.seeking)) {
        return;
      }
      pendingSeekRef.current = null;
      commitPlaybackPosition(nextPosition);
      maybeSavePlaybackProgress(media);
    },
    [commitPlaybackPosition, loopRange.end, loopRange.start, maybeSavePlaybackProgress],
  );

  const onLoadedMetadata = useCallback(
    (media: HTMLMediaElement) => {
      pendingSeekRef.current = null;
      const nextDuration = media.duration || 0;
      const video = media as HTMLVideoElement;
      setDuration(nextDuration);
      setMediaDetails({
        width: video.videoWidth || null,
        height: video.videoHeight || null,
        duration: nextDuration > 0 ? nextDuration : null,
      });
      const audioTracks = getNativeAudioTracks(media);
      let enabledAudioTrack = 0;
      if (audioTracks) {
        for (let index = 0; index < audioTracks.length; index += 1) {
          if (audioTracks[index]?.enabled) {
            enabledAudioTrack = index;
            break;
          }
        }
      }
      setNativeAudioTrackCount(audioTracks?.length ?? 0);
      setNativeAudioTrackIndex(enabledAudioTrack);
      media.defaultPlaybackRate = speed;
      media.playbackRate = speed;
    },
    [speed],
  );

  const onEnded = useCallback(() => {
    const media = mediaRef.current;
    trimPreviewEndRef.current = null;

    if (media && loopRange.start !== null && loopRange.end !== null) {
      pendingSeekRef.current = createPendingSeek(loopRange.start, media.duration || 0, 450);
      media.currentTime = loopRange.start;
      commitPlaybackPosition(loopRange.start, true);
      setPaused(false);
      void media.play().catch(() => setPaused(true));
      return;
    }

    if (media && settings.repeatCurrent) {
      pendingSeekRef.current = createPendingSeek(0, media.duration || 0, 450);
      media.currentTime = 0;
      commitPlaybackPosition(0, true);
      setPaused(false);
      void media.play().catch(() => setPaused(true));
      return;
    }

    if (media && Number.isFinite(media.duration) && media.duration > 0) {
      commitPlaybackPosition(media.duration, true);
      savePlaybackProgress(media, true);
    }
    setPaused(true);
    if (settings.autoplayNext && hasNextQueueItem) {
      void playNextQueueItem();
    }
  }, [
    commitPlaybackPosition,
    hasNextQueueItem,
    loopRange.end,
    loopRange.start,
    playNextQueueItem,
    savePlaybackProgress,
    settings.autoplayNext,
    settings.repeatCurrent,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const input = target instanceof HTMLInputElement ? target : null;
      const textEntry =
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        Boolean(target?.isContentEditable);

      if (event.key === "Escape" && (toolsOpen || shelfMode)) {
        event.preventDefault();
        closeShelf();
        return;
      }

      if (textEntry) {
        if (isText && event.ctrlKey && event.key.toLowerCase() === "f") {
          event.preventDefault();
          focusTextFind();
          return;
        }
        if (isText && event.ctrlKey && event.key.toLowerCase() === "h") {
          event.preventDefault();
          focusTextFind(true);
          return;
        }
        if (isText && event.ctrlKey && event.key.toLowerCase() === "g") {
          event.preventDefault();
          goToTextLine();
          return;
        }
        if (isText && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "s") {
          event.preventDefault();
          revealControls();
          void saveCurrentTextAs();
          return;
        }
        if (isText && event.ctrlKey && event.key.toLowerCase() === "s") {
          event.preventDefault();
          revealControls();
          void saveCurrentText();
          return;
        }
        if (isText && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "z") {
          event.preventDefault();
          redoTextEdit();
          return;
        }
        if (isText && event.ctrlKey && event.key.toLowerCase() === "y") {
          event.preventDefault();
          redoTextEdit();
          return;
        }
        if (isText && event.ctrlKey && event.key.toLowerCase() === "z") {
          event.preventDefault();
          undoTextEdit();
          return;
        }
        if (isText && event.ctrlKey && event.key.toLowerCase() === "o") {
          event.preventDefault();
          revealControls();
          void openFile();
        }
        return;
      }

      if (input && input.type !== "range") {
        return;
      }

      if (isText) {
        if (event.ctrlKey && event.key.toLowerCase() === "f") {
          event.preventDefault();
          focusTextFind();
          return;
        }
        if (event.ctrlKey && event.key.toLowerCase() === "h") {
          event.preventDefault();
          focusTextFind(true);
          return;
        }
        if (event.ctrlKey && event.key.toLowerCase() === "g") {
          event.preventDefault();
          goToTextLine();
          return;
        }
        if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "s") {
          event.preventDefault();
          revealControls();
          void saveCurrentTextAs();
          return;
        }
        if (event.ctrlKey && event.key.toLowerCase() === "s") {
          event.preventDefault();
          revealControls();
          void saveCurrentText();
          return;
        }
        if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "z") {
          event.preventDefault();
          redoTextEdit();
          return;
        }
        if (event.ctrlKey && event.key.toLowerCase() === "y") {
          event.preventDefault();
          redoTextEdit();
          return;
        }
        if (event.ctrlKey && event.key.toLowerCase() === "z") {
          event.preventDefault();
          undoTextEdit();
          return;
        }
        if (event.ctrlKey && event.key.toLowerCase() === "o") {
          event.preventDefault();
          revealControls();
          void openFile();
          return;
        }
      }

      if (isImage) {
        if (event.key === "+" || event.key === "=") {
          event.preventDefault();
          revealControls();
          zoomImage(1);
          return;
        }
        if (event.key === "-" || event.key === "_") {
          event.preventDefault();
          revealControls();
          zoomImage(-1);
          return;
        }
        if (event.key === "0") {
          event.preventDefault();
          revealControls();
          resetImageView();
          return;
        }
        if (event.key.toLowerCase() === "r") {
          event.preventDefault();
          revealControls();
          rotateImage();
          return;
        }
      }

      if (isDocument) {
        if (event.ctrlKey && event.key.toLowerCase() === "p") {
          event.preventDefault();
          revealControls();
          void printCurrentDocument();
          return;
        }
        if (!isPdfDocument) {
          return;
        }
        if (event.key === "+" || event.key === "=") {
          event.preventDefault();
          revealControls();
          setDocumentZoom(1);
          return;
        }
        if (event.key === "-" || event.key === "_") {
          event.preventDefault();
          revealControls();
          setDocumentZoom(-1);
          return;
        }
        if (event.key === "0") {
          event.preventDefault();
          revealControls();
          resetDocumentView();
          return;
        }
        if (event.code === "ArrowLeft" || event.code === "PageUp") {
          event.preventDefault();
          revealControls();
          stepDocumentPage(-1);
          return;
        }
        if (event.code === "ArrowRight" || event.code === "PageDown") {
          event.preventDefault();
          revealControls();
          stepDocumentPage(1);
          return;
        }
        if (event.code === "Home") {
          event.preventDefault();
          revealControls();
          selectDocumentPage(1);
          return;
        }
        if (event.code === "End") {
          event.preventDefault();
          revealControls();
          selectDocumentPage(documentPageCount || documentView.page);
          return;
        }
      }

      const command = keyboardCommand(event, settings);
      if (!command) {
        return;
      }

      event.preventDefault();
      revealControls();
      if (command === "open") {
        void openFile();
      } else if (command === "fullscreen") {
        void send("fullscreen");
      } else if (command === "mark") {
        if (supportsMoments) {
          addCurrentMoment();
        }
      } else if (command === "loop") {
        if (supportsLoopPoints) {
          setLoopPoint();
        }
      } else if (command === "clearLoop") {
        if (supportsLoopPoints) {
          clearLoop();
        }
      } else if (command === "captions") {
        if (isVideo) {
          toggleSubtitles();
        }
      } else if (isStaticViewer && supportsQueue && command.type === "seekBy") {
        if (command.seconds < 0) {
          void playPreviousQueueItem();
        } else {
          void playNextQueueItem();
        }
      } else if (isStaticViewer && command.type === "togglePause") {
        return;
      } else {
        void runCommand(command);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    addCurrentMoment,
    closeShelf,
    clearLoop,
    documentPageCount,
    documentView.page,
    focusTextFind,
    goToTextLine,
    openFile,
    isDocument,
    isPdfDocument,
    isImage,
    isVideo,
    isText,
    isStaticViewer,
    playNextQueueItem,
    playPreviousQueueItem,
    printCurrentDocument,
    redoTextEdit,
    revealControls,
    resetDocumentView,
    resetImageView,
    rotateImage,
    runCommand,
    saveCurrentText,
    saveCurrentTextAs,
    send,
    selectDocumentPage,
    setDocumentZoom,
    setLoopPoint,
    settings,
    stepDocumentPage,
    supportsLoopPoints,
    supportsMoments,
    supportsQueue,
    undoTextEdit,
    toggleImageActualSize,
    toggleSubtitles,
    toolsOpen,
    shelfMode,
    zoomImage,
  ]);

  const seekTo = (value: number) => {
    if (gstreamerActiveForCurrent) {
      showToast("Seeking is not wired to the external GStreamer fallback yet.", "info");
      return;
    }

    const media = mediaRef.current;
    if (!media) {
      return;
    }
    const duration = Number.isFinite(media.duration) ? media.duration : 0;
    void runCommand({ type: "seekTo", seconds: clampMediaTime(value, duration) });
  };

  const contextMenuSections: ContextMenuSection[] = [];
  contextMenuSections.push({
    id: "file",
    actions: [
      {
        id: "open-file",
        icon: "folder",
        label: hasMedia ? "Open file" : "Open media",
        onSelect: () => void openFile(),
      },
    ],
  });

  if (isTimedMedia) {
    contextMenuSections.push({
      id: "playback",
      actions: [
        {
          id: "toggle-playback",
          icon: paused ? "play" : "pause",
          label: paused ? "Play" : "Pause",
          onSelect: () => void togglePause(),
        },
        {
          id: "previous-item",
          disabled: !hasPreviousQueueItem && position < 1,
          icon: "previous",
          label: hasPreviousQueueItem ? "Previous item" : "Restart",
          onSelect: () => void playPreviousQueueItem(),
        },
        {
          id: "next-item",
          disabled: !hasNextQueueItem,
          icon: "next",
          label: "Next item",
          onSelect: () => void playNextQueueItem(),
        },
        {
          id: "cycle-speed",
          icon: "speed",
          label: "Speed",
          hint: speed === 1 ? "1x" : `${speed.toFixed(2)}x`,
          onSelect: cycleSpeed,
        },
        {
          id: "repeat-current",
          icon: "repeat",
          label: "Repeat current",
          hint: settings.repeatCurrent ? "On" : "Off",
          onSelect: () => {
            if (settings.repeatCurrent) {
              patchSettings({ repeatCurrent: false });
            } else {
              patchSettings({ autoplayNext: false, repeatCurrent: true });
            }
          },
        },
      ],
    });
  }

  if (isVideo) {
    contextMenuSections.push({
      id: "video",
      actions: [
        {
          id: "captions",
          icon: "captions",
          label: subtitleTrack ? (subtitlesEnabled ? "Hide captions" : "Show captions") : "Load captions",
          onSelect: subtitleTrack ? toggleSubtitles : () => void openSubtitle(),
        },
        {
          id: "loop-point",
          disabled: !supportsLoopPoints,
          icon: "loop",
          label: loopReady ? "Clear A-B loop" : loopArmed ? "Set loop end" : "Set loop point",
          onSelect: loopReady ? clearLoop : setLoopPoint,
        },
        {
          id: "mark-moment",
          disabled: !supportsMoments,
          icon: "mark",
          label: "Mark moment",
          onSelect: addCurrentMoment,
        },
        {
          id: "tracks",
          icon: "line",
          label: "Tracks",
          onSelect: () => toggleShelfMode("tracks"),
        },
      ],
    });
  }

  if (isImage) {
    contextMenuSections.push({
      id: "image",
      actions: [
        {
          id: "image-fit",
          icon: "fit",
          label: "Fit mode",
          hint: imageFitLabel,
          onSelect: cycleImageFit,
        },
        {
          id: "image-actual",
          icon: "zoomIn",
          label: imageView.fit === "actual" ? "Fit to window" : "Actual size",
          hint: imageView.fit === "actual" ? "Fit" : "1:1",
          onSelect: toggleImageActualSize,
        },
        {
          id: "image-zoom-out",
          icon: "zoomOut",
          label: "Zoom out",
          onSelect: () => zoomImage(-1),
        },
        {
          id: "image-zoom-in",
          icon: "zoomIn",
          label: "Zoom in",
          onSelect: () => zoomImage(1),
        },
        {
          id: "image-rotate",
          icon: "rotate",
          label: "Rotate",
          onSelect: rotateImage,
        },
        {
          id: "image-reset",
          icon: "repeat",
          label: "Reset image view",
          onSelect: resetImageView,
        },
      ],
    });
  }

  if (isDocument) {
    const documentActions: ContextMenuSection["actions"] = [];
    if (isPdfDocument) {
      documentActions.push(
        {
          id: "previous-page",
          disabled: documentView.page <= 1,
          icon: "previous",
          label: "Previous page",
          onSelect: () => stepDocumentPage(-1),
        },
        {
          id: "next-page",
          disabled: documentPageCount > 0 && documentView.page >= documentPageCount,
          icon: "next",
          label: "Next page",
          onSelect: () => stepDocumentPage(1),
        },
        {
          id: "document-fit",
          icon: "fit",
          label: "Fit mode",
          onSelect: toggleDocumentFit,
        },
        {
          id: "document-zoom-out",
          icon: "zoomOut",
          label: "Zoom out",
          onSelect: () => setDocumentZoom(-1),
        },
        {
          id: "document-zoom-in",
          icon: "zoomIn",
          label: "Zoom in",
          onSelect: () => setDocumentZoom(1),
        },
      );
    }
    documentActions.push({
      id: "print-document",
      icon: "print",
      label: "Print",
      onSelect: () => void printCurrentDocument(),
    });
    contextMenuSections.push({
      id: "document",
      actions: documentActions,
    });
  }

  if (isText) {
    contextMenuSections.push({
      id: "text",
      actions: [
        {
          id: "find-text",
          icon: "search",
          label: "Find",
          onSelect: () => focusTextFind(),
        },
        {
          id: "go-to-line",
          icon: "line",
          label: "Go to line",
          onSelect: () => void goToTextLine(),
        },
        {
          id: "save-text",
          disabled: !canSaveText,
          icon: "save",
          label: "Save",
          onSelect: () => void saveCurrentText(),
        },
        {
          id: "save-text-as",
          icon: "saveAs",
          label: "Save As",
          onSelect: () => void saveCurrentTextAs(),
        },
        {
          id: "revert-text",
          disabled: !textView.dirty,
          icon: "repeat",
          label: "Revert",
          onSelect: () => void revertCurrentText(),
        },
        {
          id: "toggle-wrap",
          icon: "file",
          label: "Word wrap",
          hint: textWordWrap ? "On" : "Off",
          onSelect: () => patchSettings({ textWordWrap: !settings.textWordWrap }),
        },
      ],
    });
  }

  if (hasMedia) {
    contextMenuSections.push({
      id: "view",
      actions: [
        {
          id: "fullscreen",
          icon: "fullscreen",
          label: isFullscreen ? "Exit fullscreen" : "Fullscreen",
          onSelect: () => void send("fullscreen"),
        },
        {
          id: "mini-player",
          disabled: !supportsMiniPlayer,
          icon: "fit",
          label: "Mini player",
          hint: miniPlayerActive ? "On" : "Off",
          onSelect: toggleMiniPlayer,
        },
        {
          id: "queue",
          disabled: !canOpenShelf(mediaCapabilities, "queue"),
          icon: "line",
          label: "Queue",
          hint: queueCount > 0 ? `${queueCount}` : undefined,
          onSelect: () => toggleShelfMode("queue"),
        },
        {
          id: "recent",
          disabled: !canOpenShelf(mediaCapabilities, "recent"),
          icon: "recent",
          label: "Recent",
          onSelect: () => toggleShelfMode("recent"),
        },
        {
          id: "library",
          disabled: !canOpenShelf(mediaCapabilities, "library"),
          icon: "library",
          label: "Library",
          onSelect: () => void loadLibraryFolder(),
        },
        {
          id: "info",
          disabled: !canOpenShelf(mediaCapabilities, "info"),
          icon: "info",
          label: "Info",
          onSelect: () => toggleShelfMode("info"),
        },
        {
          id: "settings",
          disabled: !canOpenShelf(mediaCapabilities, "settings"),
          icon: "settings",
          label: "Settings",
          onSelect: () => toggleShelfMode("settings"),
        },
      ],
    });
  }

  return (
    <main
      className={`app-shell ${hasMedia ? "with-media" : "without-media"}`}
      onContextMenu={openContextMenu}
    >
      <WindowChrome
        title={currentPath ? currentTitle : "LMP"}
        canMiniPlayer={supportsMiniPlayer}
        miniPlayer={miniPlayerActive}
        onRequestClose={confirmWindowClose}
        onToggleMiniPlayer={toggleMiniPlayer}
      />

      {!hasMedia ? (
      <header className="top-bar">
        <div className="brand-lockup" title={engineStatus.hint}>
          <div className="brand-mark" aria-hidden="true">
            <Disc3 size={19} />
          </div>
          <div>
            <strong>LMP</strong>
            <span>{engineStatus.available ? engineStatus.name : "engine unavailable"}</span>
          </div>
        </div>

        <button className="soft-button primary-open" onClick={openFile} title="Open media">
          <FolderOpen size={18} />
          <span>Open</span>
        </button>
      </header>
      ) : null}

      <section
        ref={playerRef}
        className={playerViewClass}
        aria-label="Player"
        onMouseMove={revealControls}
        onPointerDown={revealControls}
        onFocusCapture={revealControls}
        onWheel={(event) => {
          revealControls();
          if ((event.target as HTMLElement).closest("[data-wheel-volume='ignore']")) {
            return;
          }
          if (isImage) {
            zoomImageAtPoint(event.deltaY < 0 ? 1 : -1, event.clientX, event.clientY);
            event.preventDefault();
            return;
          }
          if (nudgeVolumeFromWheel(event.deltaY)) {
            event.preventDefault();
          }
        }}
      >
        <div
          className={`stage ${hasMedia ? "has-media" : ""} ${isImage ? "has-image" : ""} ${
            isDocument ? "has-document" : ""
          } ${isText ? "has-text" : ""}`}
        >
          {isImage && sourceUrl ? (
            <img
              className={`image-surface ${
                imageView.zoom > 1 || imageView.fit === "actual" ? "is-pannable" : ""
              } ${isImageDragging ? "is-dragging" : ""}`}
              src={sourceUrl}
              alt={currentTitle}
              style={imageSurfaceStyle}
              draggable={false}
              onPointerDown={startImageDrag}
              onPointerMove={moveImageDrag}
              onPointerUp={endImageDrag}
              onPointerCancel={endImageDrag}
              onDoubleClick={toggleImageActualSize}
              onLoad={(event) => {
                setDuration(0);
                setPosition(0);
                setPaused(true);
                setMediaDetails({
                  width: event.currentTarget.naturalWidth || null,
                  height: event.currentTarget.naturalHeight || null,
                  duration: null,
                });
              }}
              onError={() => showToast("Image could not be loaded.", "error")}
            />
          ) : null}

          {isDocument && sourceUrl ? (
            isPdfDocument ? (
              <PdfViewer
                error={documentError}
                isDragging={isDocumentDragging}
                layoutTick={documentLayoutTick}
                loading={documentLoading}
                onPageClamped={clampPdfDocumentPage}
                onPointerCancel={endDocumentDrag}
                onPointerDown={startDocumentDrag}
                onPointerMove={moveDocumentDrag}
                onPointerUp={endDocumentDrag}
                onRenderError={failPdfPageRender}
                onRenderStart={startPdfPageRender}
                onRenderSuccess={finishPdfPageRender}
                onWheel={handleDocumentWheel}
                pdf={pdfDocument}
                title={currentTitle}
                view={documentView}
                viewportRef={documentViewportRef}
              />
            ) : (
              <div className="document-viewport word-document-viewport" ref={documentViewportRef}>
                {isWordDocument && wordDocument ? (
                  <WordDocumentSurface document={wordDocument} title={currentTitle} />
                ) : null}
                {documentLoading ? <div className="document-status">Loading document...</div> : null}
                {documentError ? <div className="document-status error">{documentError}</div> : null}
              </div>
            )
          ) : null}

          {isText && sourceUrl ? (
            <>
              <Suspense
                fallback={
                  <div className="text-viewport">
                    <div className="text-status">Loading editor...</div>
                  </div>
                }
              >
                <TextEditorSurface
                  activeSearchIndex={boundedTextActiveMatchIndex}
                  autoCloseBrackets={settings.textAutoCloseBrackets}
                  enableIntegratedTerminal={settings.enableIntegratedTerminal}
                  fontFamily={settings.textFontFamily}
                  fontSize={settings.textFontSize}
                  lineNumbersVisible={settings.textLineNumbers}
                  path={currentPath}
                  searchMatches={textFindMatches}
                  syntaxHighlightingEnabled={settings.textSyntaxHighlighting}
                  tabSize={settings.textTabSize}
                  title={currentTitle}
                  view={textView}
                  onChange={updateTextDraft}
                  editorRef={textEditorRef}
                  wordWrap={textWordWrap}
                />
              </Suspense>
              <TextTools
                activeShelf={shelfMode === "info" || shelfMode === "library" || shelfMode === "recent" || shelfMode === "settings" ? shelfMode : null}
                caseSensitive={textCaseSensitive}
                dirty={canSaveText}
                findInputRef={textFindInputRef}
                findMatchCount={textFindMatchCount}
                findPositionLabel={textFindPositionLabel}
                findQuery={textFindQuery}
                isFullscreen={isFullscreen}
                onFind={findTextMatch}
                onFindQueryChange={(value) => {
                  setTextFindQuery(value);
                  setTextActiveMatchIndex(-1);
                }}
                onGoToLine={goToTextLine}
                onOpenInfo={() => toggleShelfMode("info")}
                onOpenLibrary={() => void loadLibraryFolder()}
                onOpenRecent={() => toggleShelfMode("recent")}
                onOpenSettings={() => toggleShelfMode("settings")}
                onReplaceAll={replaceAllTextMatches}
                onReplaceCurrent={replaceCurrentTextMatch}
                onReplaceOpenChange={(open) => {
                  setTextReplaceOpen(open);
                  window.setTimeout(() => {
                    if (open) {
                      textReplaceInputRef.current?.focus();
                      textReplaceInputRef.current?.select();
                    }
                  }, 0);
                }}
                onReplaceQueryChange={setTextReplaceQuery}
                onRevert={revertCurrentText}
                onRedo={redoTextEdit}
                onSave={() => void saveCurrentText()}
                onSaveAs={() => void saveCurrentTextAs()}
                onToggleFullscreen={() => send("fullscreen")}
                onToggleTools={() => {
                  setToolsOpen((open) => !open);
                  setShelfMode(null);
                }}
                onToggleWordWrap={() => patchSettings({ textWordWrap: !settings.textWordWrap })}
                onUndo={undoTextEdit}
                onUpdateCaseSensitive={(value) => {
                  setTextCaseSensitive(value);
                  setTextActiveMatchIndex(-1);
                }}
                onUpdateWholeWord={(value) => {
                  setTextWholeWord(value);
                  setTextActiveMatchIndex(-1);
                }}
                replaceInputRef={textReplaceInputRef}
                replaceOpen={textReplaceOpen}
                replaceQuery={textReplaceQuery}
                toolsOpen={toolsOpen}
                wholeWord={textWholeWord}
                wordWrap={textWordWrap}
              />
            </>
          ) : null}

          {!isStaticViewer ? (
            <video
              ref={mediaRef}
              className={`media-surface ${isAudio ? "audio-only" : ""}`}
              playsInline
              onDurationChange={(event) => {
                if (isActiveMediaElement(event.currentTarget)) {
                  setDuration(event.currentTarget.duration || 0);
                }
              }}
              onLoadedMetadata={(event) => {
                if (isActiveMediaElement(event.currentTarget)) {
                  onLoadedMetadata(event.currentTarget);
                }
              }}
              onLoadedData={(event) => {
                if (isActiveMediaElement(event.currentTarget)) {
                  revealCurrentWindowWhenMediaReady(event.currentTarget);
                }
              }}
              onCanPlay={(event) => {
                if (isActiveMediaElement(event.currentTarget)) {
                  revealCurrentWindowWhenMediaReady(event.currentTarget);
                }
              }}
              onTimeUpdate={(event) => {
                if (isActiveMediaElement(event.currentTarget)) {
                  onTimeUpdate(event.currentTarget);
                }
              }}
              onSeeked={(event) => {
                if (isActiveMediaElement(event.currentTarget)) {
                  pendingSeekRef.current = null;
                  commitPlaybackPosition(event.currentTarget.currentTime || 0, true);
                  savePlaybackProgress(event.currentTarget, true);
                }
              }}
              onPlay={(event) => {
                if (isActiveMediaElement(event.currentTarget)) {
                  setPaused(false);
                }
              }}
              onPause={(event) => {
                if (isActiveMediaElement(event.currentTarget)) {
                  if (settings.repeatCurrent && event.currentTarget.ended) {
                    return;
                  }
                  savePlaybackProgress(event.currentTarget, true);
                  setPaused(true);
                }
              }}
              onRateChange={(event) => {
                if (isActiveMediaElement(event.currentTarget)) {
                  setSpeed(normalizeSpeed(event.currentTarget.playbackRate));
                }
              }}
              onEnded={(event) => {
                if (isActiveMediaElement(event.currentTarget)) {
                  onEnded();
                }
              }}
              onError={(event) => {
                if (isActiveMediaElement(event.currentTarget)) {
                  revealCurrentWindow();
                  void handlePlaybackProblem(undefined, event.currentTarget);
                }
              }}
            >
              {subtitleTrack ? (
                <track
                  key={subtitleTrack.src}
                  kind="subtitles"
                  label={subtitleTrack.label}
                  src={subtitleTrack.src}
                  srcLang="und"
                  default={subtitlesEnabled}
                />
              ) : null}
            </video>
          ) : null}

          {isAudio ? (
            <AudioNowPlaying
              artworkUrl={audioArtworkUrl}
              duration={duration || mediaDetails.duration || 0}
              metaLabel={metaLabel}
              metadata={audioMetadata}
              paused={paused}
              position={position}
            />
          ) : !hasMedia ? (
            <div className="now-playing">
              <div className="media-orb">
                {currentKind === "image" ? (
                  <ImageIcon size={38} strokeWidth={1.6} />
                ) : currentKind === "document" ? (
                  <FileText size={38} strokeWidth={1.6} />
                ) : (
                  <FileVideo size={38} strokeWidth={1.6} />
                )}
              </div>
              <p>{currentPath ? currentKind : "Ready"}</p>
              <h1>{currentTitle}</h1>
              {currentPath ? (
                <span>{currentPath}</span>
              ) : (
                <button onClick={openFile}>Open media</button>
              )}
            </div>
          ) : null}

          {gstreamerActiveForCurrent ? (
            <div className="fallback-overlay" data-wheel-volume="ignore">
              <div>
                <span>Fallback engine</span>
                <strong>Playing through GStreamer</strong>
                <p>
                  Native WebView could not handle this container/codec, so LMP handed it to the
                  GStreamer runtime. Embedded fallback controls are the next engine step.
                </p>
              </div>
              <div className="fallback-actions">
                <button type="button" onClick={() => void stopTrackedGstreamer()}>
                  Stop fallback
                </button>
                <button type="button" onClick={() => currentPath && void playPath(currentPath)}>
                  Retry native
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {hasMedia && !miniPlayerActive && !isText ? (
          <TransportDock
            capabilities={mediaCapabilities}
            currentTitle={currentTitle}
            cycleImageFit={cycleImageFit}
            cycleSpeed={cycleSpeed}
            documentPageCount={documentPageCount}
            documentReady={Boolean(pdfDocument || wordDocument)}
            documentView={documentView}
            duration={duration}
            gstreamerActiveForCurrent={gstreamerActiveForCurrent}
            hasNextQueueItem={hasNextQueueItem}
            hasPreviousQueueItem={hasPreviousQueueItem}
            imageFitLabel={imageFitLabel}
            imageView={imageView}
            isFullscreen={isFullscreen}
            isStaticViewer={isStaticViewer}
            loopArmed={loopArmed}
            loopLabel={loopLabel}
            loopReady={loopReady}
            mediaMode={mediaMode}
            metaLabel={metaLabel}
            nudgeVolumeFromWheel={nudgeVolumeFromWheel}
            onAddCurrentMoment={addCurrentMoment}
            onClearLoop={clearLoop}
            onLoadLibraryFolder={() => void loadLibraryFolder()}
            onMouseEnter={() => {
              setControlsPinned(true);
              revealControls();
            }}
            onMouseLeave={() => {
              setControlsPinned(false);
              revealControls();
            }}
            onOpenSubtitle={() => void openSubtitle()}
            onPlayNextQueueItem={() => void playNextQueueItem()}
            onPlayPreviousQueueItem={() => void playPreviousQueueItem()}
            onPrintCurrentDocument={() => void printCurrentDocument()}
            onResetDocumentView={resetDocumentView}
            onResetImageView={resetImageView}
            onSeekBy={(seconds) => send("seek", seconds)}
            onSeekTo={seekTo}
            onSelectDocumentPage={selectDocumentPage}
            onSetDocumentZoom={setDocumentZoom}
            onSetDocumentZoomExact={setDocumentZoomExact}
            onSetPlayerVolume={setPlayerVolume}
            onSetLoopPoint={setLoopPoint}
            onStepDocumentPage={stepDocumentPage}
            onTimelineKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                void runCommand({
                  type: "seekBy",
                  seconds: seekStep(-settings.seekSeconds, event.shiftKey, settings.shiftSeekMultiplier),
                });
                return;
              }

              if (event.key === "ArrowRight") {
                event.preventDefault();
                void runCommand({
                  type: "seekBy",
                  seconds: seekStep(settings.seekSeconds, event.shiftKey, settings.shiftSeekMultiplier),
                });
                return;
              }

              if (event.key === " " || event.code === "Space") {
                event.preventDefault();
                void runCommand({ type: "togglePause" });
                return;
              }

              if (event.key.toLowerCase() === "k") {
                event.preventDefault();
                void runCommand({ type: "togglePause" });
              }
            }}
            onToggleDocumentFit={toggleDocumentFit}
            onToggleFullscreen={() => send("fullscreen")}
            onTogglePause={togglePause}
            onToggleShelfMode={toggleShelfMode}
            onToggleSubtitles={toggleSubtitles}
            onToggleTools={() => {
              setToolsOpen((open) => !open);
              setShelfMode(null);
            }}
            paused={paused}
            position={position}
            queueCount={queueCount}
            queueIndex={queueIndex}
            rotateImage={rotateImage}
            settings={settings}
            shelfMode={shelfMode}
            speed={speed}
            subtitleAvailable={Boolean(subtitleTrack)}
            subtitlesEnabled={subtitlesEnabled}
            toolsOpen={toolsOpen}
            trimRange={{
              active: shelfMode === "trim",
              end: trimRange.end,
              start: trimRange.start,
            }}
            volume={volume}
            zoomImage={zoomImage}
          />
        ) : null}
        {hasMedia && shelfMode === "settings" ? (
          <SettingsPanel
            activeTab={activeSettingsTab}
            currentPath={currentPath}
            fallbackStatusLabel={fallbackStatusLabel}
            gstreamerAvailable={Boolean(gstreamerBackend?.available)}
            isAudio={isAudio}
            isDocument={isDocument}
            isImage={isImage}
            isStaticViewer={isStaticViewer}
            isText={isText}
            onClearThumbnailCache={() => void clearThumbnailCache()}
            onClose={closeShelf}
            onOpenCurrentWithGstreamer={() => void openCurrentWithGstreamer()}
            onPatchSettings={patchSettings}
            onPinControls={setControlsPinned}
            onReset={resetSettings}
            onSetPlayerSpeed={setPlayerSpeed}
            onTabChange={setSettingsTab}
            playbackBackends={playbackBackends}
            settings={settings}
            speed={speed}
            tabs={activeSettingsTabs}
          />
        ) : null}
      </section>

      <MediaShelves
        audioInspectionItems={audioInspectionItems}
        backendHint={backendHint}
        capabilities={mediaCapabilities}
        currentPath={currentPath}
        dataInspectionItems={dataInspectionItems}
        documentPageCount={documentPageCount}
        documentView={documentView}
        engineHint={engineStatus.hint}
        hasMedia={hasMedia}
        libraryFilter={libraryFilter}
        libraryFolder={libraryFolder}
        libraryFolderLabel={libraryFolderLabel}
        libraryLoading={libraryLoading}
        librarySearch={librarySearch}
        librarySort={librarySort}
        mediaInspection={mediaInspection}
        mediaInspectionLoading={mediaInspectionLoading}
        moments={moments}
        nativeAudioTrackCount={nativeAudioTrackCount}
        nativeAudioTrackIndex={nativeAudioTrackIndex}
        onAddFilesToQueue={() => void addFilesToQueue()}
        onCancelTrimExport={cancelTrimExport}
        onChooseLibraryFolder={() => void chooseLibraryFolder()}
        onClearQueue={() => {
          setQueue(currentPath ? [currentPath] : []);
          showToast("Queue cleared.", "info");
        }}
        onClearRecent={() => {
          setRecent(clearRecent());
          showToast("Recent media cleared.", "info");
        }}
        onClearSubtitleTrack={() => clearSubtitleTrack(true)}
        onClose={closeShelf}
        onDeleteMoment={(id) => {
          if (currentPath) {
            setMoments(removeMoment(currentPath, id));
          }
        }}
        onExportTrimClip={() => void exportTrimClip()}
        onJumpMoment={jumpMoment}
        onJumpToTrimEnd={jumpToTrimEnd}
        onJumpToTrimStart={jumpToTrimStart}
        onJumpToMoment={(seconds) => void runCommand({ type: "seekTo", seconds })}
        onLibraryFilterChange={setLibraryFilter}
        onLibrarySearchChange={setLibrarySearch}
        onLibrarySortChange={setLibrarySort}
        onLoadLibraryFolder={(path) => void loadLibraryFolder(path)}
        onOpenLibraryItem={(item) => void openLibraryItem(item)}
        onOpenTrimResult={openTrimResult}
        onOpenSubtitle={() => void openSubtitle()}
        onPlayQueueIndex={(index) => void playQueueIndex(index)}
        onPlayRecent={(path) => void playQueue([path])}
        onPreviewTrimRange={previewTrimRange}
        onRefreshInspection={() => currentPath && void inspectMedia(currentPath, loadTokenRef.current)}
        onSelectDocumentPage={selectDocumentPage}
        onSelectNativeAudioTrack={selectNativeAudioTrack}
        onSetTrimEndFromCurrent={setTrimEndFromCurrent}
        onSetTrimPreset={setTrimPreset}
        onSetTrimStartFromCurrent={setTrimStartFromCurrent}
        onShowTrimResult={showTrimResult}
        onToggleSubtitles={toggleSubtitles}
        overviewInspectionItems={overviewInspectionItems}
        pdfDocument={pdfDocument}
        queue={queue}
        queueCount={queueCount}
        queueIndex={queueIndex}
        recent={recent}
        shelfMode={shelfMode}
        streamInspectionItems={streamInspectionItems}
        subtitleInspectionItems={subtitleInspectionItems}
        subtitleTrackLabel={subtitleTrack?.label ?? null}
        subtitlesEnabled={subtitlesEnabled}
        trimCanExport={trimCanExport}
        trimDuration={trimmedDuration}
        trimEnd={trimRange.end}
        trimError={displayedTrimError}
        trimExport={trimExport}
        trimOutputPath={trimOutputPath}
        trimPreset={trimPreset}
        trimStart={trimRange.start}
        videoInspectionItems={videoInspectionItems}
        visibleLibraryItems={visibleLibraryItems}
      />

      {contextMenu ? (
        <ContextMenu
          onClose={closeContextMenu}
          sections={contextMenuSections}
          x={contextMenu.x}
          y={contextMenu.y}
        />
      ) : null}

      {confirmDialog ? (
        <div className="confirm-backdrop" data-wheel-volume="ignore" role="presentation">
          <div
            className={`confirm-dialog ${confirmDialog.tone === "danger" ? "danger" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
          >
            <strong id="confirm-title">{confirmDialog.title}</strong>
            <p>{confirmDialog.message}</p>
            <div className="confirm-actions">
              <button type="button" onClick={() => settleConfirmDialog(false)}>
                {confirmDialog.cancelLabel}
              </button>
              <button type="button" className="primary" onClick={() => settleConfirmDialog(true)}>
                {confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {promptDialog ? (
        <div className="confirm-backdrop" data-wheel-volume="ignore" role="presentation">
          <form
            className="confirm-dialog prompt-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="prompt-title"
            onSubmit={(event) => {
              event.preventDefault();
              settlePromptDialog(promptInput);
            }}
          >
            <strong id="prompt-title">{promptDialog.title}</strong>
            <p>{promptDialog.message}</p>
            <input
              autoFocus
              type="text"
              value={promptInput}
              onChange={(event) => setPromptInput(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  settlePromptDialog(null);
                }
              }}
            />
            <div className="confirm-actions">
              <button type="button" onClick={() => settlePromptDialog(null)}>
                {promptDialog.cancelLabel}
              </button>
              <button type="submit" className="primary">
                {promptDialog.confirmLabel}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {toast ? <div className={`toast ${toast.tone}`}>{toast.message}</div> : null}
    </main>
  );
}

export default App;
