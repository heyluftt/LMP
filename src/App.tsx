import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  Clock3,
  Code2,
  Disc3,
  FileAudio,
  FilePlus2,
  FileText,
  FileVideo,
  FolderOpen,
  ImageIcon,
  Settings2,
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
  mediaKindBadge,
} from "./lib/mediaFormat";
import {
  applyHomeWindowProfile,
  applyMiniWindowProfile,
  applyTextDraftWindowProfile,
  applyVideoWindowAspect,
  applyWindowProfile,
} from "./lib/windowProfile";
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
  emptyLibMpvCoreSession,
  emptyMpvSession,
  isGstreamerActiveFor,
  isLibMpvActiveFor,
  isMpvActiveFor,
  probeGstreamer,
  readLibMpvCoreSession,
  readMpvPlaybackSession,
  readGstreamerPlaybackSession,
  seekLibMpvCore,
  setLibMpvCorePaused,
  showNativeVideoSurface,
  startLibMpvRenderSession,
  startGstreamerPlayback,
  stopLibMpvSurfaceSession,
  stopLibMpvRenderSession,
  stopMpvPlayback,
  stopGstreamerPlayback,
} from "./player/fallbackEngine";
import {
  canOpenShelf,
  capabilitiesFor,
  mediaModeFor,
  type ShelfCapability,
} from "./player/capabilities";
import { createLibMpvPlaybackEngine } from "./player/libMpvEngine";
import { createNativePlaybackEngine } from "./player/nativeEngine";
import {
  clampMediaTime,
  commandSeekTarget,
  createPendingSeek,
  shouldKeepOptimisticSeek,
  type PendingSeekState,
} from "./player/playbackSmoothing";
import {
  canTryRemuxFallback,
  canUseDirectAfterPrepFailure,
  playbackBackendHint,
  playbackPathLabel,
  resolvePlaybackStartupPlan,
} from "./player/playbackEnginePolicy";
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
  LibMpvCoreSession,
  MediaInspection,
  MediaInspectionItem,
  MediaFile,
  MediaFolder,
  MediaFolderItem,
  Moment,
  MpvPlaybackSession,
  NativeVideoSurfaceRect,
  PlaybackEngine,
  PlaybackBackendStatus,
  PlayerCommand,
  SettingsCacheStatus,
  SubtitleFile,
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
  loadId: number;
  target: number;
};

type MediaDetails = {
  width: number | null;
  height: number | null;
  duration: number | null;
};

type OpeningMediaState = {
  kind: MediaKind;
  path: string;
  phase: "opening" | "preparing" | "resuming";
  loadId: number;
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
const visiblePreparationDelayMs = 1200;
const deferredMediaDetailsDelayMs = 180;
const homeSourceUrl = "lmp://home";
const newTextSourceUrl = "lmp://new-text";

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

function compactDebugValue(value: unknown) {
  return String(value ?? "-")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, "_")
    .slice(0, 180);
}

function formatDebugDetails(details: Record<string, unknown>) {
  return Object.entries(details)
    .map(([key, value]) => `${key}=${compactDebugValue(value)}`)
    .join(" ");
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

function describePlaybackProblem(error: unknown, media?: HTMLMediaElement, path?: string | null) {
  if (isUnsupportedSourceError(error, media)) {
    if (canTryRemuxFallback(path ?? null)) {
      return "This media file is recognized, but the native WebView engine cannot play its container/codec directly yet.";
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

type HomeOpenTarget = "text" | "video" | "audio" | "image" | "pdf" | "word";

function homeOpenTargetLabel(target: HomeOpenTarget) {
  switch (target) {
    case "text":
      return "text or code file";
    case "video":
      return "video file";
    case "audio":
      return "audio file";
    case "image":
      return "image or GIF";
    case "pdf":
      return "PDF";
    case "word":
      return "Word document";
  }
  return "file";
}

function pathMatchesHomeTarget(path: string, target: HomeOpenTarget) {
  const kind = mediaKind(path);
  const ext = mediaExtension(path);
  switch (target) {
    case "text":
      return kind === "text";
    case "video":
      return kind === "video";
    case "audio":
      return kind === "audio";
    case "image":
      return kind === "image";
    case "pdf":
      return kind === "document" && ext === "pdf";
    case "word":
      return kind === "document" && isWordDocumentExtension(ext);
  }
  return false;
}

type HomeScreenProps = {
  onNewText: () => void;
  onOpen: (target: HomeOpenTarget) => void;
  onOpenGeneric: () => void;
  onOpenSettings: () => void;
  onPlayRecent: (path: string) => void;
  recent: string[];
};

function HomeScreen({
  onNewText,
  onOpen,
  onOpenGeneric,
  onOpenSettings,
  onPlayRecent,
  recent,
}: HomeScreenProps) {
  const quickActions = [
    {
      description: "Start a blank editor draft.",
      icon: <FilePlus2 size={22} />,
      label: "New Text",
      onClick: onNewText,
    },
    {
      description: "Open notes, configs, scripts, or source files.",
      icon: <Code2 size={22} />,
      label: "Open Text / Code",
      onClick: () => onOpen("text"),
    },
    {
      description: "Use LMP playback and queue behavior.",
      icon: <FileVideo size={22} />,
      label: "Open Video",
      onClick: () => onOpen("video"),
    },
    {
      description: "Open music, recordings, or audio clips.",
      icon: <FileAudio size={22} />,
      label: "Open Audio",
      onClick: () => onOpen("audio"),
    },
    {
      description: "View images and animated GIF files.",
      icon: <ImageIcon size={22} />,
      label: "Open Image / GIF",
      onClick: () => onOpen("image"),
    },
    {
      description: "Open documents in the built-in viewer.",
      icon: <FileText size={22} />,
      label: "Open PDF",
      onClick: () => onOpen("pdf"),
    },
  ];

  return (
    <div className="home-screen" data-wheel-volume="ignore">
      <section className="home-hero" aria-label="LMP home">
        <div className="home-brand">
          <div className="home-brand-mark" aria-hidden="true">
            <Disc3 size={26} />
          </div>
          <div>
            <h1>LMP</h1>
            <span>Local media suite</span>
          </div>
        </div>
        <div className="home-hero-copy">
          <strong>Start with a file or a blank draft.</strong>
          <p>Play media, view documents, or write text without switching apps first.</p>
        </div>
        <div className="home-primary-actions">
          <button type="button" className="home-primary-button" onClick={onNewText}>
            <FilePlus2 size={19} />
            <span>New Text</span>
          </button>
          <button type="button" className="home-secondary-button" onClick={onOpenGeneric}>
            <FolderOpen size={19} />
            <span>Open File</span>
          </button>
        </div>
      </section>

      <section className="home-action-panel" aria-label="Quick open">
        <div className="home-section-heading">
          <span>Start</span>
          <strong>Choose what you want to open</strong>
        </div>
        <div className="home-action-grid">
          {quickActions.map((action) => (
            <button key={action.label} type="button" className="home-action" onClick={action.onClick}>
              {action.icon}
              <span>
                <strong>{action.label}</strong>
                <small>{action.description}</small>
              </span>
            </button>
          ))}
          <button type="button" className="home-action" onClick={() => onOpen("word")}>
            <FileText size={22} />
            <span>
              <strong>Open Word / DOCX</strong>
              <small>Extract an editable text copy.</small>
            </span>
          </button>
          <button type="button" className="home-action" onClick={onOpenSettings}>
            <Settings2 size={22} />
            <span>
              <strong>Settings</strong>
              <small>Adjust updates, cache, playback, and text behavior.</small>
            </span>
          </button>
        </div>
      </section>

      <section className="home-recent-panel" aria-label="Recent files">
        <div className="home-section-heading">
          <span>Recent Files</span>
          <strong>{recent.length > 0 ? "Continue where you left off" : "No recent files yet"}</strong>
        </div>
        <div className="home-recent-list">
          {recent.length > 0 ? (
            recent.slice(0, 4).map((path) => (
              <button key={path} type="button" onClick={() => onPlayRecent(path)} title={path}>
                <Clock3 size={16} />
                <span>
                  <strong>{fileName(path)}</strong>
                  <small>{mediaKindBadge(path)}</small>
                </span>
              </button>
            ))
          ) : (
            <p>Files you open will appear here when recent files are enabled.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function App() {
  const windowLabel = getCurrentWindow().label;
  const mediaRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<HTMLElement | null>(null);
  const nativeVideoSurfaceRef = useRef<HTMLDivElement | null>(null);

  const [engineStatus, setEngineStatus] = useState<EngineStatus>({
    available: true,
    name: "Native media engine",
  });
  const [playbackBackends, setPlaybackBackends] = useState<PlaybackBackendStatus[]>([]);
  const [gstreamerSession, setGstreamerSession] =
    useState<GstreamerPlaybackSession>(emptyGstreamerSession);
  const [mpvSession, setMpvSession] = useState<MpvPlaybackSession>(emptyMpvSession);
  const [libMpvSession, setLibMpvSession] =
    useState<LibMpvCoreSession>(emptyLibMpvCoreSession);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [currentMedia, setCurrentMedia] = useState<MediaFile | null>(null);
  const [openingMedia, setOpeningMedia] = useState<OpeningMediaState | null>(null);
  const [startupFilesSettled, setStartupFilesSettled] = useState(false);
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
  const [updateInstallLocked, setUpdateInstallLocked] = useState(false);
  const [cacheStatus, setCacheStatus] = useState<SettingsCacheStatus | null>(null);
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
  const [videoCursorHidden, setVideoCursorHidden] = useState(false);
  const volumeRef = useRef(volume);
  const lastControlRevealRef = useRef(0);
  const loadIdRef = useRef(0);
  const activePlaybackPathRef = useRef<string | null>(null);
  const recentOpenRequestRef = useRef<{ path: string; at: number } | null>(null);
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
  const windowRevealFocusRef = useRef(true);
  const mediaReadyRevealSuppressRef = useRef<{
    loadId: number;
    reason: string;
    until: number;
  } | null>(null);
  const deferredWindowRevealTimerRef = useRef<number | null>(null);
  const deferredWindowRevealFrameRef = useRef<number | null>(null);
  const videoCursorHideTimerRef = useRef<number | null>(null);
  const videoWindowAspectTokenRef = useRef<string | null>(null);
  const videoWindowAspectRetryRef = useRef<number | null>(null);
  const homeProfileAppliedRef = useRef(false);
  const confirmDialogResolverRef = useRef<((value: boolean) => void) | null>(null);
  const promptDialogResolverRef = useRef<((value: string | null) => void) | null>(null);
  const settingsRef = useRef(settings);
  const speedRef = useRef(speed);
  settingsRef.current = settings;
  speedRef.current = speed;

  const tracePlaybackFocus = useCallback((phase: string, details: Record<string, unknown> = {}) => {
    const activePath = activePlaybackPathRef.current;
    void invoke("log_frontend_playback_event", {
      phase,
      detail: formatDebugDetails({
        documentFocused: document.hasFocus(),
        documentHidden: document.hidden,
        focusWindow: windowRevealFocusRef.current,
        loadId: loadIdRef.current,
        activeTitle: activePath ? fileName(activePath) : "-",
        ...details,
      }),
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const onFocus = () => tracePlaybackFocus("browser-window-focus");
    const onBlur = () => tracePlaybackFocus("browser-window-blur");
    const onVisibilityChange = () =>
      tracePlaybackFocus("document-visibility", { hidden: document.hidden });

    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [tracePlaybackFocus]);

  const cancelVideoWindowAspectRetry = useCallback(() => {
    if (videoWindowAspectRetryRef.current !== null) {
      window.clearTimeout(videoWindowAspectRetryRef.current);
      videoWindowAspectRetryRef.current = null;
    }
  }, []);

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

  const isNewTextDraft = sourceUrl === newTextSourceUrl && !currentPath && textView.sourceType === "file";
  const currentTitle = useMemo(
    () => (currentPath ? fileName(currentPath) : isNewTextDraft ? "Untitled.txt" : "LMP"),
    [currentPath, isNewTextDraft],
  );
  const sourceKind = useMemo(
    () => (isNewTextDraft ? "text" : currentPath ? mediaKind(currentPath) : "unknown"),
    [currentPath, isNewTextDraft],
  );
  const currentKind: MediaKind = textView.sourceType === "word-extract" ? "text" : sourceKind;
  const queueIndex = currentPath ? queue.indexOf(currentPath) : -1;
  const queueCount = queue.length;
  const hasPreviousQueueItem = queueIndex > 0;
  const hasNextQueueItem = queueIndex >= 0 && queueIndex < queue.length - 1;
  const gstreamerActiveForCurrent = isGstreamerActiveFor(gstreamerSession, currentPath);
  const mpvActiveForCurrent = isMpvActiveFor(mpvSession, currentPath);
  const libMpvActiveForCurrent = isLibMpvActiveFor(libMpvSession, currentPath);
  const externalPlaybackActiveForCurrent = gstreamerActiveForCurrent || mpvActiveForCurrent;
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

  const scheduleVideoWindowAspectResize = useCallback(
    (videoWidth: number, videoHeight: number) => {
      const loadId = loadIdRef.current;
      const path = activePlaybackPathRef.current;
      if (miniPlayerActive) {
        tracePlaybackFocus("video-aspect-skip", {
          reason: "mini-player",
          videoHeight,
          videoWidth,
        });
        return;
      }
      if (!path) {
        tracePlaybackFocus("video-aspect-skip", {
          reason: "no-path",
          videoHeight,
          videoWidth,
        });
        return;
      }
      if (!videoWidth || !videoHeight) {
        tracePlaybackFocus("video-aspect-skip", {
          reason: "empty-dimensions",
          videoHeight,
          videoWidth,
        });
        return;
      }

      const resizeId = `${loadId}:${path}`;
      if (videoWindowAspectTokenRef.current === resizeId) {
        tracePlaybackFocus("video-aspect-skip", {
          reason: "already-applied",
          title: fileName(path),
          videoHeight,
          videoWidth,
        });
        return;
      }
      videoWindowAspectTokenRef.current = resizeId;
      cancelVideoWindowAspectRetry();
      tracePlaybackFocus("video-aspect-scheduled", {
        center: settings.centerVideoWindowAfterResize,
        skipWhenUnfocused: !windowRevealFocusRef.current,
        title: fileName(path),
        videoHeight,
        videoWidth,
      });

      const applyAspect = () => {
        const isCurrent = () =>
          loadId === loadIdRef.current &&
          activePlaybackPathRef.current === path;
        if (isCurrent()) {
          tracePlaybackFocus("video-aspect-apply", {
            skipWhenUnfocused: !windowRevealFocusRef.current,
            title: fileName(path),
            videoHeight,
            videoWidth,
          });
          void applyVideoWindowAspect(
            videoWidth,
            videoHeight,
            settings.centerVideoWindowAfterResize,
            isCurrent,
            !windowRevealFocusRef.current,
          );
        }
      };

      applyAspect();
      videoWindowAspectRetryRef.current = window.setTimeout(() => {
        videoWindowAspectRetryRef.current = null;
        applyAspect();
      }, 220);
    },
    [
      cancelVideoWindowAspectRetry,
      miniPlayerActive,
      settings.centerVideoWindowAfterResize,
      tracePlaybackFocus,
    ],
  );

  useEffect(() => {
    if (
      isVideo &&
      !miniPlayerActive &&
      mediaDetails.width &&
      mediaDetails.height
    ) {
      scheduleVideoWindowAspectResize(mediaDetails.width, mediaDetails.height);
    }
  }, [
    isVideo,
    mediaDetails.height,
    mediaDetails.width,
    miniPlayerActive,
    scheduleVideoWindowAspectResize,
  ]);

  useEffect(() => cancelVideoWindowAspectRetry, [cancelVideoWindowAspectRetry]);

  const supportsQueue = mediaCapabilities.queue;
  const supportsMoments = mediaCapabilities.moments;
  const supportsLoopPoints = mediaCapabilities.loopPoints;
  const hasMedia = Boolean(
    sourceUrl ||
      openingMedia ||
      externalPlaybackActiveForCurrent ||
      libMpvActiveForCurrent,
  );
  const showHome = !hasMedia && startupFilesSettled;

  useEffect(() => {
    const appWindow = getCurrentWindow();
    void appWindow.setAlwaysOnTop(miniPlayerActive).catch(() => undefined);

    return () => {
      if (miniPlayerActive) {
        void appWindow.setAlwaysOnTop(false).catch(() => undefined);
      }
    };
  }, [miniPlayerActive]);

  useEffect(() => {
    if (!showHome) {
      if (hasMedia) {
        homeProfileAppliedRef.current = false;
      }
      return;
    }
    if (homeProfileAppliedRef.current) {
      return;
    }
    homeProfileAppliedRef.current = true;
    void applyHomeWindowProfile();
  }, [hasMedia, showHome]);

  const gstreamerBackend = playbackBackends.find((backend) => backend.id === "gstreamer");
  const fallbackStatusLabel = playbackPathLabel(settings.fallbackEngine, playbackBackends);
  const backendHint = playbackBackendHint(settings.fallbackEngine, playbackBackends);
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
    (isVideo || isStaticViewer || !paused) &&
    !controlsPinned &&
    !toolsOpen;
  const playerViewClass = [
    "player-view",
    mediaMode !== "empty" ? `${mediaMode}-mode` : "",
    showHome ? "home-mode" : "",
    !hasMedia && !startupFilesSettled ? "startup-mode" : "",
    loopReady ? "loop-active" : "",
    loopArmed ? "loop-armed" : "",
    isFullscreen ? "fullscreen-mode" : "",
    miniPlayerActive ? "mini-player" : "",
    settings.minimalControls ? "minimal-controls" : "",
    openingMedia ? "opening-media" : "",
    libMpvActiveForCurrent ? "libmpv-render-mode" : "",
    controlsHidden ? "controls-hidden" : "",
    videoCursorHidden ? "cursor-hidden" : "",
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
  const videoSurfaceStyle = useMemo<CSSProperties>(
    () => ({
      objectFit: "cover",
    }),
    [],
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
  const textNeedsInitialSave =
    !textView.savePath && (textView.sourceType === "word-extract" || isNewTextDraft);
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
        isCurrent: (path, loadId) => loadIdRef.current === loadId && activePlaybackPathRef.current === path,
        getSpeed: () => speedRef.current,
        setPosition: (seconds) => commitPlaybackPosition(seconds, true),
        notify: (message) => showToast(message, "info"),
      }),
    [commitPlaybackPosition, showToast],
  );

  useEffect(() => () => resumeController.dispose(), [resumeController]);

  const cancelDeferredWindowReveal = useCallback(() => {
    if (deferredWindowRevealTimerRef.current !== null) {
      window.clearTimeout(deferredWindowRevealTimerRef.current);
      deferredWindowRevealTimerRef.current = null;
    }
    if (deferredWindowRevealFrameRef.current !== null) {
      window.cancelAnimationFrame(deferredWindowRevealFrameRef.current);
      deferredWindowRevealFrameRef.current = null;
    }
  }, []);

  const revealCurrentWindow = useCallback((focus = true) => {
    cancelDeferredWindowReveal();
    if (windowRevealTimerRef.current !== null) {
      window.clearTimeout(windowRevealTimerRef.current);
      windowRevealTimerRef.current = null;
    }
    tracePlaybackFocus("reveal-now", { focus });
    void invoke(focus ? "reveal_current_window" : "reveal_current_window_without_focus").catch(() => undefined);
  }, [cancelDeferredWindowReveal, tracePlaybackFocus]);

  const revealCurrentWindowAfterRender = useCallback((focus = true) => {
    cancelDeferredWindowReveal();
    if (windowRevealTimerRef.current !== null) {
      window.clearTimeout(windowRevealTimerRef.current);
      windowRevealTimerRef.current = null;
    }
    tracePlaybackFocus("reveal-after-render-scheduled", { focus });
    deferredWindowRevealTimerRef.current = window.setTimeout(() => {
      deferredWindowRevealTimerRef.current = null;
      deferredWindowRevealFrameRef.current = window.requestAnimationFrame(() => {
        deferredWindowRevealFrameRef.current = null;
        tracePlaybackFocus("reveal-after-render-fire", { focus });
        void invoke(focus ? "reveal_current_window" : "reveal_current_window_without_focus").catch(
          () => undefined,
        );
      });
    }, 0);
  }, [cancelDeferredWindowReveal, tracePlaybackFocus]);

  const scheduleWindowRevealFallback = useCallback(
    (path: string, loadId: number, delayMs = 1400, focus = true) => {
      if (windowRevealTimerRef.current !== null) {
        window.clearTimeout(windowRevealTimerRef.current);
      }

      tracePlaybackFocus("reveal-fallback-scheduled", {
        delayMs,
        focus,
        loadId,
        title: fileName(path),
      });
      windowRevealTimerRef.current = window.setTimeout(() => {
        windowRevealTimerRef.current = null;
        const startupResume = startupResumeRef.current;
        if (
          loadIdRef.current === loadId &&
          activePlaybackPathRef.current === path &&
          !(startupResume && startupResume.loadId === loadId && startupResume.path === path)
        ) {
          tracePlaybackFocus("reveal-fallback-fire", {
            focus,
            loadId,
            title: fileName(path),
          });
          void invoke(focus ? "reveal_current_window" : "reveal_current_window_without_focus").catch(
            () => undefined,
          );
        } else {
          tracePlaybackFocus("reveal-fallback-skip", {
            activeMatches: activePlaybackPathRef.current === path,
            focus,
            loadId,
            loadMatches: loadIdRef.current === loadId,
            startupResume: Boolean(startupResume),
            title: fileName(path),
          });
        }
      }, delayMs);
    },
    [tracePlaybackFocus],
  );

  const revealCurrentWindowWhenMediaReady = useCallback(
    (media: HTMLMediaElement) => {
      const loadId = Number(media.dataset.loadId ?? 0);
      const startupResume = startupResumeRef.current;
      if (
        loadId > 0 &&
        loadId === loadIdRef.current &&
        currentPath &&
        activePlaybackPathRef.current === currentPath &&
        media.readyState >= 2 &&
        !(startupResume && startupResume.loadId === loadId && startupResume.path === currentPath)
      ) {
        const suppress = mediaReadyRevealSuppressRef.current;
        if (suppress && suppress.loadId === loadId) {
          if (window.performance.now() < suppress.until) {
            tracePlaybackFocus("media-ready-reveal-skip", {
              loadId,
              readyState: media.readyState,
              reason: suppress.reason,
            });
            return;
          }
          mediaReadyRevealSuppressRef.current = null;
        }
        tracePlaybackFocus("media-ready-reveal", {
          focus: windowRevealFocusRef.current,
          loadId,
          readyState: media.readyState,
        });
        setOpeningMedia((current) => (current?.loadId === loadId ? null : current));
        revealCurrentWindow(windowRevealFocusRef.current);
      }
    },
    [currentPath, revealCurrentWindow, tracePlaybackFocus],
  );

  useEffect(
    () => () => {
      if (windowRevealTimerRef.current !== null) {
        window.clearTimeout(windowRevealTimerRef.current);
        windowRevealTimerRef.current = null;
      }
      cancelDeferredWindowReveal();
    },
    [cancelDeferredWindowReveal],
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

  const measureNativeVideoSurfaceRect = useCallback((): NativeVideoSurfaceRect | null => {
    const element = nativeVideoSurfaceRef.current ?? playerRef.current;
    const bounds = element?.getBoundingClientRect();
    if (!bounds || bounds.width < 16 || bounds.height < 16) {
      return null;
    }

    return {
      left: Math.round(bounds.left),
      top: Math.round(bounds.top),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    };
  }, []);

  const syncNativeVideoSurfaceRect = useCallback(async () => {
    if (!libMpvActiveForCurrent) {
      return;
    }

    const rect = measureNativeVideoSurfaceRect();
    if (!rect) {
      return;
    }

    await showNativeVideoSurface(rect);
  }, [libMpvActiveForCurrent, measureNativeVideoSurfaceRect]);

  const stopTrackedLibMpvRender = useCallback(
    async (silent = false) => {
      try {
        await stopLibMpvRenderSession().catch(() => emptyLibMpvCoreSession);
        const session = await stopLibMpvSurfaceSession();
        setLibMpvSession(session);
        if (!silent) {
          showToast("Embedded playback stopped.", "info");
        }
      } catch (error) {
        setLibMpvSession(emptyLibMpvCoreSession);
        if (!silent) {
          showToast(compactError(error), "error");
        }
      }
    },
    [showToast],
  );

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
      await stopMpvPlayback().catch(() => emptyMpvSession);
      await stopLibMpvRenderSession().catch(() => emptyLibMpvCoreSession);
      await stopLibMpvSurfaceSession().catch(() => emptyLibMpvCoreSession);
      const session = await startGstreamerPlayback(path);
      setGstreamerSession(session);
      setMpvSession(emptyMpvSession);
      setLibMpvSession(emptyLibMpvCoreSession);
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

  const stopTrackedMpv = useCallback(
    async (silent = false) => {
      try {
        const session = await stopMpvPlayback();
        setMpvSession(session);
        if (!silent) {
          showToast("MPV playback stopped.", "info");
        }
      } catch (error) {
        if (!silent) {
          showToast(compactError(error), "error");
        }
      }
    },
    [showToast],
  );

  const startTrackedLibMpvRender = useCallback(
    async (path: string, loadId: number, startSeconds?: number | null, focusWindow = true) => {
      tracePlaybackFocus("libmpv-render-start-request", {
        focusWindow,
        loadId,
        startSeconds: startSeconds ?? "-",
        title: fileName(path),
      });
      await nextAnimationFrame();
      if (loadId !== loadIdRef.current || activePlaybackPathRef.current !== path) {
        tracePlaybackFocus("libmpv-render-start-skip", {
          reason: "stale-before-measure",
          focusWindow,
          loadId,
          title: fileName(path),
        });
        return emptyLibMpvCoreSession;
      }

      const rect = measureNativeVideoSurfaceRect();
      if (!rect) {
        tracePlaybackFocus("libmpv-render-start-fail", {
          reason: "no-surface-rect",
          focusWindow,
          loadId,
          title: fileName(path),
        });
        throw new Error("Video surface is not ready yet.");
      }
      tracePlaybackFocus("libmpv-render-surface-measured", {
        focusWindow,
        loadId,
        rect: `${rect.width}x${rect.height}+${rect.left}+${rect.top}`,
        title: fileName(path),
      });

      let session: LibMpvCoreSession;
      try {
        session = await startLibMpvRenderSession(
          path,
          rect,
          startSeconds ?? null,
          volumeRef.current,
          speedRef.current,
        );
      } catch (error) {
        await stopLibMpvSurfaceSession().catch(() => emptyLibMpvCoreSession);
        tracePlaybackFocus("libmpv-render-start-fail", {
          error: compactError(error),
          focusWindow,
          loadId,
          title: fileName(path),
        });
        throw new Error(`Render API failed: ${compactError(error)}`);
      }
      if (loadId !== loadIdRef.current || activePlaybackPathRef.current !== path) {
        tracePlaybackFocus("libmpv-render-start-skip", {
          reason: "stale-after-start",
          focusWindow,
          loadId,
          title: fileName(path),
        });
        void stopLibMpvRenderSession().catch(() => undefined);
        void stopLibMpvSurfaceSession().catch(() => undefined);
        return emptyLibMpvCoreSession;
      }

      setLibMpvSession(session);
      setGstreamerSession(emptyGstreamerSession);
      setMpvSession(emptyMpvSession);
      setSourceUrl(null);
      setDuration(session.duration || 0);
      setPaused(session.paused);
      commitPlaybackPosition(session.position || startSeconds || 0, true);
      if (session.width > 0 && session.height > 0) {
        setMediaDetails({
          width: Math.round(session.width),
          height: Math.round(session.height),
          duration: session.duration > 0 ? session.duration : null,
        });
        if (focusWindow) {
          scheduleVideoWindowAspectResize(session.width, session.height);
        }
      } else if (session.duration > 0) {
        setMediaDetails((current) => ({
          ...current,
          duration: session.duration,
        }));
      }
      setOpeningMedia(null);
      revealCurrentWindow(focusWindow);
      tracePlaybackFocus("libmpv-render-start-ok", {
        duration: session.duration,
        focusWindow,
        loadId,
        position: session.position,
        title: fileName(path),
      });
      return session;
    },
    [
      commitPlaybackPosition,
      measureNativeVideoSurfaceRect,
      revealCurrentWindow,
      scheduleVideoWindowAspectResize,
      tracePlaybackFocus,
    ],
  );

  const inspectMedia = useCallback(async (path: string, loadId: number) => {
    setMediaInspection(null);
    setMediaInspectionLoading(true);

    try {
      const inspection = await invoke<MediaInspection>("inspect_media", { path });
      if (loadId === loadIdRef.current && activePlaybackPathRef.current === path) {
        setMediaInspection(inspection);
      }
    } catch (error) {
      if (loadId === loadIdRef.current && activePlaybackPathRef.current === path) {
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
      if (loadId === loadIdRef.current && activePlaybackPathRef.current === path) {
        setMediaInspectionLoading(false);
      }
    }
  }, []);

  const loadAudioArtwork = useCallback(async (path: string, loadId: number) => {
    setAudioArtworkUrl(null);

    try {
      const artworkPath = await invoke<string | null>("extract_audio_artwork", { path });
      if (loadId === loadIdRef.current && activePlaybackPathRef.current === path) {
        setAudioArtworkUrl(artworkPath ? convertFileSrc(artworkPath) : null);
      }
    } catch {
      if (loadId === loadIdRef.current && activePlaybackPathRef.current === path) {
        setAudioArtworkUrl(null);
      }
    }
  }, []);

  const scheduleDeferredMediaDetails = useCallback(
    (path: string, kind: MediaKind, loadId: number) => {
      window.setTimeout(() => {
        if (loadId !== loadIdRef.current || activePlaybackPathRef.current !== path) {
          return;
        }
        void inspectMedia(path, loadId);
        if (kind === "audio") {
          void loadAudioArtwork(path, loadId);
        }
      }, deferredMediaDetailsDelayMs);
    },
    [inspectMedia, loadAudioArtwork],
  );

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
      createNativePlaybackEngine(media)?.pause();
      media.removeAttribute("src");
      delete media.dataset.loadId;
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
    async (path: string, options: { focusWindow?: boolean; skipTextGuard?: boolean } = {}) => {
      const shouldFocusWindow = options.focusWindow ?? true;
      windowRevealFocusRef.current = shouldFocusWindow;
      if (!options.skipTextGuard && !(await confirmTextNavigation(path))) {
        return;
      }

      const now = window.performance.now();
      const recentOpenRequest = recentOpenRequestRef.current;
      if (
        recentOpenRequest?.path === path &&
        now - recentOpenRequest.at < 1600
      ) {
        revealCurrentWindow(shouldFocusWindow);
        return;
      }
      recentOpenRequestRef.current = { path, at: now };

      const loadId = loadIdRef.current + 1;
      loadIdRef.current = loadId;
      const optimisticKind = mediaKind(path);
      cancelVideoWindowAspectRetry();
      videoWindowAspectTokenRef.current = null;
      mediaReadyRevealSuppressRef.current = null;
      pendingSeekRef.current = null;
      startupResumeRef.current = null;
      if (windowRevealTimerRef.current !== null) {
        window.clearTimeout(windowRevealTimerRef.current);
        windowRevealTimerRef.current = null;
      }
      activePlaybackPathRef.current = null;
      void stopTrackedGstreamer(true);
      void stopTrackedMpv(true);
      void stopTrackedLibMpvRender(true);
      abortNativeMediaLoad();
      setSourceUrl(null);
      setCurrentMedia(null);
      if (optimisticKind === "audio" || optimisticKind === "video") {
        activePlaybackPathRef.current = path;
        setCurrentPath(path);
        setOpeningMedia({ kind: optimisticKind, path, phase: "opening", loadId: loadId });
        revealCurrentWindowAfterRender(shouldFocusWindow);
      } else {
        setOpeningMedia(null);
      }
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
        if (loadId !== loadIdRef.current) {
          return;
        }

        const kind = mediaKind(media.path);
        const opensAsExtractedWord = isWordDocumentExtension(mediaExtension(media.path));
        const viewKind: MediaKind = opensAsExtractedWord ? "text" : kind;
        if (kind === "unknown") {
          setOpeningMedia(null);
          revealCurrentWindow(shouldFocusWindow);
          showToast("This file type is not supported by LMP yet.", "error");
          return;
        }

        const staticKind = kind === "image" || kind === "document" || kind === "text";
        let playablePath = media.path;
        const playbackPlan = resolvePlaybackStartupPlan(
          media.path,
          kind,
          settings.fallbackEngine,
        );
        const needsNativePrep = playbackPlan.prepareForNative;
        const startupResume =
          !staticKind && kind === "video" && settings.resumePlayback
            ? getResume(media.path)
            : null;

        activePlaybackPathRef.current = media.path;
        if (viewKind !== "video") {
          void applyWindowProfile(viewKind);
        }
        setCurrentMedia(media);
        if (viewKind === "text") {
          setMediaInspection(null);
        } else if (staticKind) {
          void inspectMedia(media.path, loadId);
        }
        setCurrentPath(media.path);
        setDuration(0);
        if (startupResume && startupResume.position > 5) {
          startupResumeRef.current = {
            path: media.path,
            target: startupResume.position,
            loadId: loadId,
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
        resumeController.beginLoad(media.path, loadId);
        clearSubtitleTrack();
        setMoments(staticKind ? [] : readMoments(media.path));
        setRecent(settings.rememberRecentMedia ? rememberMedia(media.path) : readRecent());

        if (staticKind) {
          if (loadId !== loadIdRef.current || activePlaybackPathRef.current !== media.path) {
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
              if (loadId !== loadIdRef.current || activePlaybackPathRef.current !== media.path) {
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
              if (loadId !== loadIdRef.current || activePlaybackPathRef.current !== media.path) {
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
            revealCurrentWindow(shouldFocusWindow);
            return;
          }
          if (kind === "document") {
            setSourceUrl(convertFileSrc(media.path));
            revealCurrentWindow(shouldFocusWindow);
            return;
          }
          if (kind === "text") {
            setTextView((current) => ({ ...current, loading: true, error: null }));
            try {
              const text = await invoke<TextFileContent>("read_text_file", { path: media.path });
              if (loadId !== loadIdRef.current || activePlaybackPathRef.current !== media.path) {
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
              if (loadId !== loadIdRef.current || activePlaybackPathRef.current !== media.path) {
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
          revealCurrentWindow(shouldFocusWindow);
          return;
        }

        if (playbackPlan.mode === "gstreamer") {
          try {
            await startTrackedGstreamer(media.path);
            if (loadId !== loadIdRef.current || activePlaybackPathRef.current !== media.path) {
              return;
            }
            startupResumeRef.current = null;
            setSourceUrl(null);
            setOpeningMedia(null);
            scheduleDeferredMediaDetails(media.path, kind, loadId);
            revealCurrentWindow(shouldFocusWindow);
            return;
          } catch (error) {
            if (loadId !== loadIdRef.current || activePlaybackPathRef.current !== media.path) {
              return;
            }
            showToast(`GStreamer could not start. Using native playback instead: ${compactError(error)}`, "info");
          }
        }

        if (playbackPlan.useEmbeddedRenderer) {
          try {
            setOpeningMedia((current) =>
              current?.loadId === loadId
                ? { ...current, phase: startupResume ? "resuming" : "opening" }
                : current,
            );
            await startTrackedLibMpvRender(
              media.path,
              loadId,
              startupResume && startupResume.position > 5 ? startupResume.position : null,
              shouldFocusWindow,
            );
            if (loadId !== loadIdRef.current || activePlaybackPathRef.current !== media.path) {
              return;
            }
            startupResumeRef.current = null;
            scheduleDeferredMediaDetails(media.path, kind, loadId);
            return;
          } catch (error) {
            if (loadId !== loadIdRef.current || activePlaybackPathRef.current !== media.path) {
              return;
            }
            setLibMpvSession(emptyLibMpvCoreSession);
            showToast(`Embedded renderer could not start. Using native playback instead: ${compactError(error)}`, "info");
          }
        }

        void invoke<SubtitleFile | null>("find_sidecar_subtitle", { mediaPath: media.path })
          .then((sidecar) => {
            if (
              sidecar &&
              loadId === loadIdRef.current &&
              activePlaybackPathRef.current === media.path
            ) {
              loadSubtitleFile(sidecar, true);
            }
          })
          .catch(() => undefined);

        if (needsNativePrep) {
          setSourceUrl(null);
          const prepNotice = window.setTimeout(
            () => {
              if (loadId === loadIdRef.current && activePlaybackPathRef.current === media.path) {
                setOpeningMedia((current) =>
                  current?.loadId === loadId ? { ...current, phase: "preparing" } : current,
                );
              }
            },
            visiblePreparationDelayMs,
          );

          try {
            const remuxed = await invoke<MediaFile>("transmux_for_native", { path: media.path });
            if (loadId !== loadIdRef.current || activePlaybackPathRef.current !== media.path) {
              return;
            }
            playablePath = remuxed.path;
          } catch (fallbackError) {
            window.clearTimeout(prepNotice);
            if (loadId !== loadIdRef.current || activePlaybackPathRef.current !== media.path) {
              return;
            }
            if (canUseDirectAfterPrepFailure(media.path)) {
              playablePath = media.path;
            } else {
              setOpeningMedia(null);
              revealCurrentWindow(shouldFocusWindow);
              showToast(
                `This media file is recognized, but native playback cannot open it yet. FFmpeg remux failed: ${compactError(
                  fallbackError,
                )}`,
                "error",
              );
              return;
            }
          } finally {
            window.clearTimeout(prepNotice);
          }

          if (loadId !== loadIdRef.current || activePlaybackPathRef.current !== media.path) {
            return;
          }
        }

        if (loadId !== loadIdRef.current || activePlaybackPathRef.current !== media.path) {
          return;
        }
        setSourceUrl(convertFileSrc(playablePath));
        scheduleDeferredMediaDetails(media.path, kind, loadId);
        scheduleWindowRevealFallback(media.path, loadId, kind === "audio" ? 900 : 1400, shouldFocusWindow);
      } catch (error) {
        if (loadId !== loadIdRef.current) {
          return;
        }
        setOpeningMedia(null);
        revealCurrentWindow(shouldFocusWindow);
        showToast(compactError(error), "error");
      }
    },
    [
      abortNativeMediaLoad,
      cancelVideoWindowAspectRetry,
      clearSubtitleTrack,
      commitPlaybackPosition,
      confirmTextNavigation,
      inspectMedia,
      loadSubtitleFile,
      revealCurrentWindow,
      revealCurrentWindowAfterRender,
      scheduleDeferredMediaDetails,
      scheduleWindowRevealFallback,
      resumeController,
      resetImageView,
      settings.fallbackEngine,
      settings.rememberRecentMedia,
      settings.resumePlayback,
      settings.textWordExtractionFormat,
      showToast,
      startTrackedLibMpvRender,
      startTrackedGstreamer,
      stopTrackedLibMpvRender,
      stopTrackedMpv,
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
      }

      setQueue(nextQueue);
      const playbackTask = playPath(nextQueue[boundedIndex], { skipTextGuard: true });

      if (settings.autoQueueFolder && nextQueue.length === 1 && mediaKind(focusedPath) !== "text") {
        void invoke<string[]>("list_sibling_media", { mediaPath: focusedPath })
          .then((siblings) => {
            const siblingQueue = uniquePaths(siblings);
            const siblingIndex = siblingQueue.indexOf(focusedPath);
            if (
              siblingQueue.length > 1 &&
              siblingIndex >= 0 &&
              activePlaybackPathRef.current === focusedPath
            ) {
              setQueue(siblingQueue);
            }
          })
          .catch(() => undefined);
      }

      await playbackTask;
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

  const createNewTextDraft = useCallback(async () => {
    if (!(await confirmTextNavigation(newTextSourceUrl))) {
      return;
    }

    loadIdRef.current += 1;
    cancelVideoWindowAspectRetry();
    videoWindowAspectTokenRef.current = null;
    pendingSeekRef.current = null;
    startupResumeRef.current = null;
    if (windowRevealTimerRef.current !== null) {
      window.clearTimeout(windowRevealTimerRef.current);
      windowRevealTimerRef.current = null;
    }
    activePlaybackPathRef.current = null;
    recentOpenRequestRef.current = null;
    void stopTrackedGstreamer(true);
    void stopTrackedMpv(true);
    void stopTrackedLibMpvRender(true);
    abortNativeMediaLoad();
    setOpeningMedia(null);
    setCurrentPath(null);
    setCurrentMedia(null);
    setQueue([]);
    setSourceUrl(newTextSourceUrl);
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
    setDocumentView(defaultDocumentView);
    documentDragRef.current = null;
    documentZoomAnchorRef.current = null;
    setIsDocumentDragging(false);
    resetImageView();
    setTextView({
      ...defaultTextView,
      encoding: "utf-8",
      lineEnding: "lf",
    });
    setTextFindQuery("");
    setTextReplaceQuery("");
    setTextReplaceOpen(false);
    setTextActiveMatchIndex(-1);
    setDuration(0);
    commitPlaybackPosition(0, true);
    setPaused(true);
    setMediaDetails({ width: null, height: null, duration: null });
    setLoopRange({ start: null, end: null });
    setTrimRange({ start: 0, end: 0 });
    setTrimExport(null);
    setTrimError(null);
    trimPreviewEndRef.current = null;
    remuxFallbackRef.current = null;
    clearSubtitleTrack();
    setMoments([]);
    setToolsOpen(false);
    setShelfMode(null);
    void applyTextDraftWindowProfile();
    revealCurrentWindow();
    window.setTimeout(() => textEditorRef.current?.focus(), 120);
  }, [
    abortNativeMediaLoad,
    cancelVideoWindowAspectRetry,
    clearSubtitleTrack,
    commitPlaybackPosition,
    confirmTextNavigation,
    resetImageView,
    revealCurrentWindow,
    stopTrackedGstreamer,
    stopTrackedLibMpvRender,
    stopTrackedMpv,
  ]);

  const openHome = useCallback(async () => {
    if (updateInstallLocked && shelfMode === "settings") {
      showToast("Update installation is in progress.", "info");
      return;
    }
    if (!(await confirmTextNavigation(homeSourceUrl))) {
      return;
    }

    loadIdRef.current += 1;
    cancelVideoWindowAspectRetry();
    videoWindowAspectTokenRef.current = null;
    pendingSeekRef.current = null;
    startupResumeRef.current = null;
    if (windowRevealTimerRef.current !== null) {
      window.clearTimeout(windowRevealTimerRef.current);
      windowRevealTimerRef.current = null;
    }
    activePlaybackPathRef.current = null;
    recentOpenRequestRef.current = null;
    void stopTrackedGstreamer(true);
    void stopTrackedMpv(true);
    void stopTrackedLibMpvRender(true);
    abortNativeMediaLoad();
    setOpeningMedia(null);
    setCurrentPath(null);
    setCurrentMedia(null);
    setQueue([]);
    setSourceUrl(null);
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
    setDocumentView(defaultDocumentView);
    documentDragRef.current = null;
    documentZoomAnchorRef.current = null;
    setIsDocumentDragging(false);
    resetImageView();
    setTextView(defaultTextView);
    setTextFindQuery("");
    setTextReplaceQuery("");
    setTextReplaceOpen(false);
    setTextActiveMatchIndex(-1);
    setDuration(0);
    commitPlaybackPosition(0, true);
    setPaused(true);
    setMediaDetails({ width: null, height: null, duration: null });
    setLoopRange({ start: null, end: null });
    setTrimRange({ start: 0, end: 0 });
    setTrimExport(null);
    setTrimError(null);
    trimPreviewEndRef.current = null;
    remuxFallbackRef.current = null;
    clearSubtitleTrack();
    setMoments([]);
    setToolsOpen(false);
    setControlsPinned(false);
    setControlsVisible(true);
    setControlActivity((value) => value + 1);
    setShelfMode(null);
    void applyHomeWindowProfile();
    revealCurrentWindow();
  }, [
    abortNativeMediaLoad,
    cancelVideoWindowAspectRetry,
    clearSubtitleTrack,
    commitPlaybackPosition,
    confirmTextNavigation,
    resetImageView,
    revealCurrentWindow,
    shelfMode,
    showToast,
    stopTrackedGstreamer,
    stopTrackedLibMpvRender,
    stopTrackedMpv,
    updateInstallLocked,
  ]);

  const openHomeFiles = useCallback(
    async (target: HomeOpenTarget) => {
      try {
        const paths = await invoke<string[]>("open_filtered_files_dialog", { kind: target });
        const playablePaths = uniquePaths(paths).filter((path) => pathMatchesHomeTarget(path, target));
        if (playablePaths.length === 0) {
          if (paths.length > 0) {
            showToast(`No ${homeOpenTargetLabel(target)} selected.`, "info");
          }
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
    },
    [playQueue, shouldOpenPickedFilesInCurrentWindow, showToast],
  );

  const openHomeSettings = useCallback(() => {
    if (updateInstallLocked && shelfMode === "settings") {
      showToast("Update installation is in progress.", "info");
      return;
    }
    setToolsOpen(false);
    setControlsPinned(false);
    setControlsVisible(true);
    setControlActivity((value) => value + 1);
    setShelfMode("settings");
  }, [shelfMode, showToast, updateInstallLocked]);

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
        if (updateInstallLocked && shelfMode === "settings") {
          showToast("Update installation is in progress.", "info");
          return;
        }
        setToolsOpen(false);
        setShelfMode(null);
        return;
      }

      if (updateInstallLocked && shelfMode === "settings") {
        showToast("Update installation is in progress.", "info");
        return;
      }

      setToolsOpen(false);
      setControlsPinned(false);
      setControlsVisible(true);
      setControlActivity((value) => value + 1);
      setShelfMode((current) => (current === mode ? null : mode));
    },
    [hasMedia, mediaCapabilities, shelfMode, showToast, updateInstallLocked],
  );

  const closeShelf = useCallback(() => {
    if (updateInstallLocked && shelfMode === "settings") {
      showToast("Update installation is in progress.", "info");
      return;
    }
    setShelfMode(null);
    setToolsOpen(false);
    setControlsPinned(false);
    setControlsVisible(true);
    setControlActivity((value) => value + 1);
  }, [shelfMode, showToast, updateInstallLocked]);

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
    async (index: number, options: { focusWindow?: boolean } = {}) => {
      if (index < 0 || index >= queue.length) {
        return;
      }

      await playPath(queue[index], { focusWindow: options.focusWindow });
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

  const playNextQueueItem = useCallback(async (options: { focusWindow?: boolean } = {}) => {
    if (hasNextQueueItem) {
      await playQueueIndex(queueIndex + 1, options);
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

  const activePlaybackEngine = useCallback((): PlaybackEngine | null => {
    if (libMpvActiveForCurrent) {
      return createLibMpvPlaybackEngine(libMpvSession, setLibMpvSession);
    }
    return createNativePlaybackEngine(mediaRef.current);
  }, [libMpvActiveForCurrent, libMpvSession]);

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
      showToast("Preparing media for native playback...", "info");

      try {
        const remuxed = await invoke<MediaFile>("transmux_for_native", { path });
        remuxFallbackRef.current = { path, status: "done" };
        resumeController.beginLoad(path, loadIdRef.current);
        setDuration(0);
        const startupResume = startupResumeRef.current;
        if (startupResume?.path === path && startupResume.loadId === loadIdRef.current) {
          commitPlaybackPosition(startupResume.target, true);
        } else {
          commitPlaybackPosition(0, true);
        }
        setSourceUrl(convertFileSrc(remuxed.path));
        scheduleWindowRevealFallback(path, loadIdRef.current, 1400, windowRevealFocusRef.current);
        showToast("Media remuxed without re-encoding.", "success");
      } catch (fallbackError) {
        remuxFallbackRef.current = { path, status: "done" };
        revealCurrentWindow(windowRevealFocusRef.current);
        showToast(
          `This media file is recognized, but native playback cannot open it yet. FFmpeg remux failed: ${compactError(
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
      const loadId = Number(media.dataset.loadId ?? 0);
      return !isStaticViewer && loadId > 0 && loadId === loadIdRef.current;
    },
    [isStaticViewer],
  );

  const runCommand = useCallback(
    async (command: PlayerCommand) => {
      if (!isTimedMedia) {
        return;
      }

      if (externalPlaybackActiveForCurrent) {
        if (command.type === "togglePause" || command.type === "stop") {
          if (mpvActiveForCurrent) {
            await stopTrackedMpv();
          } else {
            await stopTrackedGstreamer();
          }
        } else {
          showToast("External fallback playback is running in its own window for now.", "info");
        }
        return;
      }

      const player = activePlaybackEngine();
      if (!player) {
        showToast("Open a media file first.", "info");
        return;
      }

      resumeController.cancelUserAction();
      try {
        const snapshot = player.snapshot();
        const seekTarget = commandSeekTarget(command, snapshot.position, snapshot.duration);
        if (seekTarget !== null) {
          pendingSeekRef.current = createPendingSeek(seekTarget, snapshot.duration);
          commitPlaybackPosition(seekTarget, true);
        }
        await player.run(command);
      } catch (error) {
        await handlePlaybackProblem(error);
      }
    },
    [
      externalPlaybackActiveForCurrent,
      handlePlaybackProblem,
      commitPlaybackPosition,
      isTimedMedia,
      mpvActiveForCurrent,
      activePlaybackEngine,
      resumeController,
      showToast,
      stopTrackedMpv,
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

    const player = activePlaybackEngine();
    if (!player) {
      await openFile();
      return;
    }

    await runCommand({ type: "togglePause" });
  }, [activePlaybackEngine, isTimedMedia, openFile, runCommand]);

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
      if (next) {
        cancelVideoWindowAspectRetry();
        videoWindowAspectTokenRef.current = null;
        void applyMiniWindowProfile(currentKind);
      } else if (currentKind !== "video") {
        void applyWindowProfile(currentKind);
      }
      return next;
    });
  }, [
    cancelVideoWindowAspectRetry,
    currentKind,
    supportsMiniPlayer,
  ]);

  const resetSettings = useCallback(() => {
    updateSettings(settings, defaultSettings);
    setSettings(defaultSettings);
    volumeRef.current = defaultSettings.defaultVolume;
    setVolume(defaultSettings.defaultVolume);
    void runCommand({ type: "setVolume", volume: defaultSettings.defaultVolume });
  }, [runCommand, settings]);

  const refreshCacheStatus = useCallback(async () => {
    const status = await invoke<SettingsCacheStatus>("get_settings_cache_status");
    setCacheStatus(status);
    return status;
  }, []);

  useEffect(() => {
    if (shelfMode !== "settings") {
      return;
    }
    void refreshCacheStatus().catch(() => setCacheStatus(null));
  }, [refreshCacheStatus, shelfMode]);

  const clearSettingsCache = useCallback(async (command: string, label: string) => {
    try {
      const status = await invoke<SettingsCacheStatus>(command);
      setCacheStatus(status);
      showToast(`${label} cleared.`, "success");
    } catch (error) {
      showToast(compactError(error), "error");
    }
  }, [showToast]);

  const clearPreviewCache = useCallback(
    () => clearSettingsCache("clear_preview_cache", "Preview cache"),
    [clearSettingsCache],
  );

  const clearPreparedVideoCache = useCallback(
    () => clearSettingsCache("clear_prepared_video_cache", "Prepared video cache"),
    [clearSettingsCache],
  );

  const clearMediaProbeCache = useCallback(
    () => clearSettingsCache("clear_media_probe_cache", "Media probe cache"),
    [clearSettingsCache],
  );

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

  const cancelVideoCursorHide = useCallback(() => {
    if (videoCursorHideTimerRef.current !== null) {
      window.clearTimeout(videoCursorHideTimerRef.current);
      videoCursorHideTimerRef.current = null;
    }
  }, []);

  const videoCursorAutoHideBlocked =
    !isVideo || miniPlayerActive || controlsPinned || toolsOpen || Boolean(shelfMode) || contextMenu !== null;

  const revealVideoCursor = useCallback(() => {
    cancelVideoCursorHide();
    setVideoCursorHidden(false);

    if (videoCursorAutoHideBlocked) {
      return;
    }

    videoCursorHideTimerRef.current = window.setTimeout(() => {
      videoCursorHideTimerRef.current = null;
      setVideoCursorHidden(true);
    }, 1400);
  }, [cancelVideoCursorHide, videoCursorAutoHideBlocked]);

  const registerPlayerPointerActivity = useCallback(() => {
    revealControls();
    revealVideoCursor();
  }, [revealControls, revealVideoCursor]);

  useEffect(() => () => cancelVideoCursorHide(), [cancelVideoCursorHide]);

  useEffect(() => {
    if (!videoCursorAutoHideBlocked) {
      return;
    }

    cancelVideoCursorHide();
    setVideoCursorHidden(false);
  }, [cancelVideoCursorHide, videoCursorAutoHideBlocked]);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const openContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      revealControls();
      revealVideoCursor();
      setContextMenu({
        x: Math.max(8, event.clientX),
        y: Math.max(8, event.clientY),
      });
    },
    [revealControls, revealVideoCursor],
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
    if (!isText) {
      showToast("Open a text file first.", "info");
      return;
    }
    if (!textView.dirty && !textNeedsInitialSave) {
      showToast("No text changes to save.", "info");
      return;
    }

    const savedDraft = textView.draft;
    try {
      const candidateSavePath = textView.savePath ?? currentPath;
      const writablePath =
        textView.sourceType === "file" && candidateSavePath && mediaKind(candidateSavePath) === "text"
          ? candidateSavePath
          : null;
      if (!writablePath) {
        const savedMedia = await invoke<MediaFile | null>("save_text_file_dialog", {
          path: textView.suggestedSavePath ?? currentPath ?? null,
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
    const player = activePlaybackEngine();
    if (!player) {
      showToast("Open a video first.", "info");
      return;
    }
    const snapshot = player.snapshot();
    trimPreviewEndRef.current = trimRange.end;
    pendingSeekRef.current = createPendingSeek(trimRange.start, snapshot.duration || duration || 0, 450);
    player.seekTo(trimRange.start, true);
    commitPlaybackPosition(trimRange.start, true);
    setPaused(false);
    void player.play().catch((error) => {
      trimPreviewEndRef.current = null;
      setPaused(true);
      showToast(compactError(error), "error");
    });
  }, [
    commitPlaybackPosition,
    activePlaybackEngine,
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
    let disposed = false;

    invoke<string[]>("take_startup_files")
      .then((paths) => {
        if (disposed) {
          return;
        }
        if (paths.length > 0) {
          void playQueue(paths).finally(() => {
            if (!disposed) {
              setStartupFilesSettled(true);
            }
          });
          return;
        }
        setStartupFilesSettled(true);
      })
      .catch(() => {
        if (!disposed) {
          setStartupFilesSettled(true);
          revealCurrentWindow();
        }
      });

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
      disposed = true;
      void unlisten.then((dispose) => dispose());
    };
  }, [handleIncomingOpenRequest, playQueue, revealCurrentWindow, windowLabel]);

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
      void readMpvPlaybackSession()
        .then((session) => {
          if (!disposed) {
            setMpvSession(session);
          }
        })
        .catch(() => undefined);
      void readLibMpvCoreSession()
        .then((session) => {
          if (!disposed) {
            setLibMpvSession(session);
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
    if (!libMpvActiveForCurrent) {
      return;
    }

    let disposed = false;
    let frame: number | null = null;
    const update = () => {
      if (disposed) {
        return;
      }
      frame = null;
      void syncNativeVideoSurfaceRect().catch(() => undefined);
    };
    const requestUpdate = () => {
      if (frame !== null) {
        return;
      }
      frame = window.requestAnimationFrame(update);
    };

    requestUpdate();
    window.addEventListener("resize", requestUpdate);
    const observer = new ResizeObserver(requestUpdate);
    if (nativeVideoSurfaceRef.current) {
      observer.observe(nativeVideoSurfaceRef.current);
    }

    return () => {
      disposed = true;
      window.removeEventListener("resize", requestUpdate);
      observer.disconnect();
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [libMpvActiveForCurrent, syncNativeVideoSurfaceRect]);

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
    return () => {
      void stopLibMpvRenderSession().catch(() => undefined);
      void stopLibMpvSurfaceSession().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (
      !hasMedia ||
      !settings.autoHideControls ||
      (paused && !isStaticViewer && !isVideo) ||
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
    isVideo,
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

    const loadId = loadIdRef.current;
    const loadPath = activePlaybackPathRef.current;
    let disposed = false;
    let retryTimer: number | null = null;
    let resumePlayTimer: number | null = null;
    let playbackStarted = false;
    let startupPlayRequested = false;
    let startupResumeSettled = false;
    let startupResumeSeeked = false;
    let startupResumeWaitUntil = 0;
    media.dataset.loadId = String(loadId);
    const player = createNativePlaybackEngine(media);
    if (!player) {
      return;
    }

    const isStillActive = () =>
      !disposed && loadId === loadIdRef.current && activePlaybackPathRef.current === loadPath;

    const clearStartupResume = () => {
      const startupResume = startupResumeRef.current;
      if (startupResume?.loadId === loadId && startupResume.path === loadPath) {
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

    const finishStartupResume = () => {
      if (startupResumeSettled) {
        return;
      }
      startupResumeSettled = true;
      clearStartupResume();
      setOpeningMedia((current) => (current?.loadId === loadId ? null : current));
      revealCurrentWindow();
      void attemptPlay();
    };

    const waitForStartupResume = () => {
      if (startupResumeSettled || !isStillActive()) {
        return;
      }
      const startupResume = startupResumeRef.current;
      if (startupResume?.loadId === loadId && startupResume.path === loadPath) {
        const snapshot = player.snapshot();
        const targetReached = Math.abs(snapshot.position - startupResume.target) <= 0.65;
        const seekAccepted = startupResumeSeeked || targetReached;
        if (
          (!seekAccepted || (!startupResumeSeeked && snapshot.seeking) || snapshot.readyState < 2) &&
          performance.now() < startupResumeWaitUntil
        ) {
          if (resumePlayTimer !== null) {
            window.clearTimeout(resumePlayTimer);
          }
          resumePlayTimer = window.setTimeout(() => {
            resumePlayTimer = null;
            waitForStartupResume();
          }, 90);
          return;
        }
      }
      finishStartupResume();
    };

    const onStartupResumeSeeked = () => {
      startupResumeSeeked = true;
      waitForStartupResume();
    };

    const playWhenReady = () => {
      if (!isStillActive() || startupPlayRequested) {
        return;
      }
      startupPlayRequested = true;

      const startupResume = startupResumeRef.current;
      if (startupResume?.loadId === loadId && startupResume.path === loadPath) {
        setOpeningMedia((current) =>
          current?.loadId === loadId ? { ...current, phase: "resuming" } : current,
        );
        try {
          player.pause();
          startupResumeSeeked = false;
          startupResumeWaitUntil = performance.now() + 2200;
          pendingSeekRef.current = createPendingSeek(startupResume.target, player.snapshot().duration, 1900);
          media.addEventListener("seeked", onStartupResumeSeeked, { once: true });
          media.addEventListener("loadeddata", waitForStartupResume);
          media.addEventListener("canplay", waitForStartupResume);
          player.seekTo(startupResume.target, false);
          if (resumePlayTimer !== null) {
            window.clearTimeout(resumePlayTimer);
          }
          resumePlayTimer = window.setTimeout(() => {
            resumePlayTimer = null;
            waitForStartupResume();
          }, 120);
          return;
        } catch {
          media.removeEventListener("seeked", onStartupResumeSeeked);
          media.removeEventListener("loadeddata", waitForStartupResume);
          media.removeEventListener("canplay", waitForStartupResume);
        }
        clearStartupResume();
        setOpeningMedia((current) => (current?.loadId === loadId ? null : current));
      }

      revealCurrentWindow();
      void attemptPlay();
    };

    media.addEventListener("loadedmetadata", playWhenReady, { once: true });
    media.addEventListener("canplay", playWhenReady, { once: true });
    player.load({
      source: sourceUrl,
      volume: volumeRef.current,
      speed: speedRef.current,
    });
    retryTimer = window.setTimeout(() => {
      if (media.readyState >= 3) {
        playWhenReady();
      }
    }, 900);

    return () => {
      disposed = true;
      media.removeEventListener("loadedmetadata", playWhenReady);
      media.removeEventListener("canplay", playWhenReady);
      media.removeEventListener("seeked", onStartupResumeSeeked);
      media.removeEventListener("loadeddata", waitForStartupResume);
      media.removeEventListener("canplay", waitForStartupResume);
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      if (resumePlayTimer !== null) {
        window.clearTimeout(resumePlayTimer);
      }
      if (loadId !== loadIdRef.current || activePlaybackPathRef.current !== loadPath) {
        try {
          player.pause();
        } catch {
          // Best-effort cleanup while switching files.
        }
      }
    };
  }, [handlePlaybackProblem, isStaticViewer, resumeController, revealCurrentWindow, sourceUrl, showToast]);

  useEffect(() => {
    volumeRef.current = volume;
    const player = activePlaybackEngine();
    if (player) {
      void player.run({ type: "setVolume", volume }).catch(() => undefined);
    }
  }, [activePlaybackEngine, volume]);

  useEffect(() => {
    const player = activePlaybackEngine();
    if (player) {
      void player.run({ type: "setSpeed", speed }).catch(() => undefined);
    }
  }, [activePlaybackEngine, speed]);

  const savePlaybackProgress = useCallback(
    (force = false) => {
      const player = activePlaybackEngine();
      if (player) {
        resumeController.saveProgress(player, currentPath, loadIdRef.current, force);
      }
    },
    [activePlaybackEngine, currentPath, resumeController],
  );

  const maybeSavePlaybackProgress = useCallback(
    () => {
      const now = window.performance.now();
      if (now - lastPlaybackProgressAttemptAtRef.current < playbackProgressAttemptIntervalMs) {
        return;
      }

      lastPlaybackProgressAttemptAtRef.current = now;
      savePlaybackProgress();
    },
    [savePlaybackProgress],
  );

  useEffect(() => {
    const saveOnExit = () => {
      savePlaybackProgress(true);
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
      const player = createNativePlaybackEngine(media);
      if (!player) {
        return;
      }
      const snapshot = player.snapshot();
      const nextPosition = snapshot.position;
      const previewEnd = trimPreviewEndRef.current;
      if (previewEnd !== null && nextPosition >= previewEnd - 0.03) {
        trimPreviewEndRef.current = null;
        player.pause();
        pendingSeekRef.current = createPendingSeek(previewEnd, snapshot.duration, 250);
        player.seekTo(previewEnd, true);
        commitPlaybackPosition(previewEnd, true);
        setPaused(true);
        return;
      }

      if (
        loopRange.start !== null &&
        loopRange.end !== null &&
        nextPosition >= loopRange.end - 0.03
      ) {
        pendingSeekRef.current = createPendingSeek(loopRange.start, snapshot.duration, 450);
        player.seekTo(loopRange.start, true);
        commitPlaybackPosition(loopRange.start, true);
        return;
      }

      if (shouldKeepOptimisticSeek(pendingSeekRef.current, nextPosition, snapshot.seeking)) {
        return;
      }
      pendingSeekRef.current = null;
      commitPlaybackPosition(nextPosition);
      maybeSavePlaybackProgress();
    },
    [commitPlaybackPosition, loopRange.end, loopRange.start, maybeSavePlaybackProgress],
  );

  const onLoadedMetadata = useCallback(
    (media: HTMLMediaElement) => {
      pendingSeekRef.current = null;
      const player = createNativePlaybackEngine(media);
      const snapshot = player?.snapshot() ?? null;
      const nextDuration = snapshot?.duration ?? 0;
      const video = media as HTMLVideoElement;
      setDuration(nextDuration);
      setMediaDetails({
        width: video.videoWidth || null,
        height: video.videoHeight || null,
        duration: nextDuration > 0 ? nextDuration : null,
      });
      const loadId = Number(media.dataset.loadId ?? 0);
      const startupResume = startupResumeRef.current;
      if (
        loadId > 0 &&
        !(startupResume && startupResume.loadId === loadId && startupResume.path === activePlaybackPathRef.current)
      ) {
        setOpeningMedia((current) => (current?.loadId === loadId ? null : current));
      }
      if (isVideo && video.videoWidth && video.videoHeight) {
        scheduleVideoWindowAspectResize(video.videoWidth, video.videoHeight);
      }
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
      if (player) {
        void player.run({ type: "setSpeed", speed }).catch(() => undefined);
      }
    },
    [isVideo, scheduleVideoWindowAspectResize, speed],
  );

  const onEnded = useCallback(() => {
    const media = mediaRef.current;
    trimPreviewEndRef.current = null;
    const player = createNativePlaybackEngine(media);
    const snapshot = player?.snapshot() ?? null;
    tracePlaybackFocus("native-ended", {
      autoplayNext: settings.autoplayNext,
      duration: snapshot?.duration ?? "-",
      hasNextQueueItem,
      player: snapshot?.id ?? "-",
      position: snapshot?.position ?? "-",
      repeatCurrent: settings.repeatCurrent,
    });

    if (player && snapshot && loopRange.start !== null && loopRange.end !== null) {
      tracePlaybackFocus("native-loop-repeat", {
        duration: snapshot.duration,
        target: loopRange.start,
      });
      mediaReadyRevealSuppressRef.current = {
        loadId: loadIdRef.current,
        reason: "loop-range",
        until: window.performance.now() + 1800,
      };
      tracePlaybackFocus("media-ready-reveal-suppress", {
        loadId: loadIdRef.current,
        reason: "loop-range",
      });
      pendingSeekRef.current = createPendingSeek(loopRange.start, snapshot.duration, 450);
      player.seekTo(loopRange.start, true);
      commitPlaybackPosition(loopRange.start, true);
      setPaused(false);
      void player
        .play()
        .then(() => tracePlaybackFocus("native-loop-play-ok", { target: loopRange.start }))
        .catch((error) => {
          tracePlaybackFocus("native-loop-play-fail", { error: compactError(error) });
          setPaused(true);
        });
      return;
    }

    if (player && snapshot && settings.repeatCurrent) {
      tracePlaybackFocus("native-repeat-current", {
        duration: snapshot.duration,
        target: 0,
      });
      mediaReadyRevealSuppressRef.current = {
        loadId: loadIdRef.current,
        reason: "repeat-current",
        until: window.performance.now() + 1800,
      };
      tracePlaybackFocus("media-ready-reveal-suppress", {
        loadId: loadIdRef.current,
        reason: "repeat-current",
      });
      pendingSeekRef.current = createPendingSeek(0, snapshot.duration, 450);
      player.seekTo(0, true);
      commitPlaybackPosition(0, true);
      setPaused(false);
      void player
        .play()
        .then(() => tracePlaybackFocus("native-repeat-play-ok", { target: 0 }))
        .catch((error) => {
          tracePlaybackFocus("native-repeat-play-fail", { error: compactError(error) });
          setPaused(true);
        });
      return;
    }

    if (media && snapshot && snapshot.duration > 0) {
      commitPlaybackPosition(snapshot.duration, true);
      savePlaybackProgress(true);
    }
    setPaused(true);
    if (settings.autoplayNext && hasNextQueueItem) {
      tracePlaybackFocus("native-autoplay-next", { focusWindow: false });
      void playNextQueueItem({ focusWindow: false });
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
    tracePlaybackFocus,
  ]);

  useEffect(() => {
    if (!libMpvActiveForCurrent) {
      return;
    }

    let disposed = false;
    let timer: number | null = null;

    const tick = () => {
      void readLibMpvCoreSession()
        .then((session) => {
          if (disposed) {
            return;
          }
          setLibMpvSession(session);
          if (session.path !== currentPath) {
            return;
          }
          if (session.ended) {
            tracePlaybackFocus("libmpv-ended", {
              duration: session.duration,
              position: session.position,
              repeatCurrent: settings.repeatCurrent,
              title: currentPath ? fileName(currentPath) : "-",
            });
            if (settings.repeatCurrent && currentPath) {
              const repeatPath = currentPath;
              const repeatLoadId = loadIdRef.current;
              const isRepeatStillCurrent = () =>
                !disposed &&
                loadIdRef.current === repeatLoadId &&
                activePlaybackPathRef.current === repeatPath;

              pendingSeekRef.current = createPendingSeek(0, session.duration, 450);
              commitPlaybackPosition(0, true);
              tracePlaybackFocus("libmpv-repeat-seek-start", {
                loadId: repeatLoadId,
                title: fileName(repeatPath),
              });
              void seekLibMpvCore(0)
                .then((nextSession) => {
                  if (!isRepeatStillCurrent()) {
                    tracePlaybackFocus("libmpv-repeat-seek-skip", {
                      reason: "stale-after-seek",
                      loadId: repeatLoadId,
                      title: fileName(repeatPath),
                    });
                    return nextSession;
                  }
                  tracePlaybackFocus("libmpv-repeat-seek-ok", {
                    loadId: repeatLoadId,
                    position: nextSession.position,
                    title: fileName(repeatPath),
                  });
                  setLibMpvSession(nextSession);
                  return setLibMpvCorePaused(false);
                })
                .then((nextSession) => {
                  if (!isRepeatStillCurrent()) {
                    tracePlaybackFocus("libmpv-repeat-unpause-skip", {
                      reason: "stale-after-unpause",
                      loadId: repeatLoadId,
                      title: fileName(repeatPath),
                    });
                    return;
                  }
                  tracePlaybackFocus("libmpv-repeat-unpause-ok", {
                    loadId: repeatLoadId,
                    paused: nextSession.paused,
                    position: nextSession.position,
                    title: fileName(repeatPath),
                  });
                  setLibMpvSession(nextSession);
                  setPaused(nextSession.paused);
                })
                .catch((error) => {
                  if (!isRepeatStillCurrent()) {
                    return;
                  }
                  tracePlaybackFocus("libmpv-repeat-seek-fallback", {
                    error: compactError(error),
                    loadId: repeatLoadId,
                    title: fileName(repeatPath),
                  });
                  void startTrackedLibMpvRender(repeatPath, repeatLoadId, 0, false).catch((error) => {
                    if (!disposed) {
                      tracePlaybackFocus("libmpv-repeat-fallback-fail", {
                        error: compactError(error),
                        loadId: repeatLoadId,
                        title: fileName(repeatPath),
                      });
                      showToast(compactError(error), "error");
                    }
                  });
                });
              return;
            }
            onEnded();
            return;
          }
          if (!session.active) {
            return;
          }

          setPaused(session.paused);
          setDuration(session.duration || 0);
          if (session.width > 0 && session.height > 0) {
            setMediaDetails((current) => {
              const nextWidth = Math.round(session.width);
              const nextHeight = Math.round(session.height);
              const nextDuration = session.duration > 0 ? session.duration : null;
              if (
                current.width === nextWidth &&
                current.height === nextHeight &&
                current.duration === nextDuration
              ) {
                return current;
              }
              return {
                width: nextWidth,
                height: nextHeight,
                duration: nextDuration,
              };
            });
            scheduleVideoWindowAspectResize(session.width, session.height);
          } else if (session.duration > 0) {
            setMediaDetails((current) =>
              current.duration === session.duration
                ? current
                : { ...current, duration: session.duration },
            );
          }

          if (session.position > 0.1 || session.ready) {
            setOpeningMedia((current) =>
              current?.path === session.path ? null : current,
            );
          }
          if (
            loopRange.start !== null &&
            loopRange.end !== null &&
            session.position >= loopRange.end - 0.03
          ) {
            tracePlaybackFocus("libmpv-loop-repeat", {
              duration: session.duration,
              target: loopRange.start,
            });
            pendingSeekRef.current = createPendingSeek(loopRange.start, session.duration, 450);
            commitPlaybackPosition(loopRange.start, true);
            void seekLibMpvCore(loopRange.start)
              .then((nextSession) => {
                if (!disposed) {
                  tracePlaybackFocus("libmpv-loop-seek-ok", {
                    position: nextSession.position,
                    target: loopRange.start,
                  });
                  setLibMpvSession(nextSession);
                }
              })
              .catch((error) => {
                if (!disposed) {
                  tracePlaybackFocus("libmpv-loop-seek-fail", { error: compactError(error) });
                  showToast(compactError(error), "error");
                }
              });
            return;
          }
          commitPlaybackPosition(session.position);
          maybeSavePlaybackProgress();
        })
        .catch((error) => {
          if (!disposed) {
            showToast(compactError(error), "error");
          }
        })
        .finally(() => {
          if (!disposed) {
            timer = window.setTimeout(tick, 180);
          }
        });
    };

    tick();

    return () => {
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [
    commitPlaybackPosition,
    currentPath,
    libMpvActiveForCurrent,
    loopRange.end,
    loopRange.start,
    maybeSavePlaybackProgress,
    onEnded,
    scheduleVideoWindowAspectResize,
    seekLibMpvCore,
    setLibMpvCorePaused,
    settings.repeatCurrent,
    showToast,
    startTrackedLibMpvRender,
    tracePlaybackFocus,
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
    if (externalPlaybackActiveForCurrent) {
      showToast("Seeking is not wired to external fallback playback yet.", "info");
      return;
    }

    const player = activePlaybackEngine();
    if (!player) {
      return;
    }
    const duration = player.snapshot().duration;
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
        title={hasMedia ? currentTitle : "LMP"}
        canMiniPlayer={supportsMiniPlayer}
        canGoHome={hasMedia}
        miniPlayer={miniPlayerActive}
        onGoHome={() => void openHome()}
        onRequestClose={confirmWindowClose}
        onToggleMiniPlayer={toggleMiniPlayer}
      />

      <section
        ref={playerRef}
        className={playerViewClass}
        aria-label="Player"
        onMouseMove={registerPlayerPointerActivity}
        onPointerDown={registerPlayerPointerActivity}
        onFocusCapture={revealControls}
        onWheel={(event) => {
          revealControls();
          revealVideoCursor();
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
          className={`stage ${hasMedia ? "has-media" : showHome ? "has-home" : "is-starting"} ${isImage ? "has-image" : ""} ${
            isDocument ? "has-document" : ""
          } ${isText ? "has-text" : ""}`}
        >
          {showHome ? (
            <HomeScreen
              onNewText={() => void createNewTextDraft()}
              onOpen={(target) => void openHomeFiles(target)}
              onOpenGeneric={() => void openFile()}
              onOpenSettings={openHomeSettings}
              onPlayRecent={(path) => void playQueue([path])}
              recent={recent}
            />
          ) : null}

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

          {isVideo ? (
            <div
              ref={nativeVideoSurfaceRef}
              className={`native-video-surface-anchor ${
                libMpvActiveForCurrent ? "is-active" : ""
              }`}
              aria-hidden="true"
            />
          ) : null}

          {!isStaticViewer ? (
            <video
              ref={mediaRef}
              className={`media-surface ${isAudio ? "audio-only" : ""} ${
                libMpvActiveForCurrent ? "is-standby" : ""
              }`}
              style={videoSurfaceStyle}
              preload="auto"
              playsInline
              onDurationChange={(event) => {
                if (isActiveMediaElement(event.currentTarget)) {
                  setDuration(createNativePlaybackEngine(event.currentTarget)?.snapshot().duration ?? 0);
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
                  const snapshot = createNativePlaybackEngine(event.currentTarget)?.snapshot();
                  if (!snapshot) {
                    return;
                  }
                  if (snapshot.position > 0.25) {
                    const loadId = Number(event.currentTarget.dataset.loadId ?? 0);
                    const startupResume = startupResumeRef.current;
                    if (
                      !(
                        startupResume &&
                        startupResume.loadId === loadId &&
                        startupResume.path === activePlaybackPathRef.current
                      )
                    ) {
                      setOpeningMedia((current) => (current?.loadId === loadId ? null : current));
                    }
                  }
                  onTimeUpdate(event.currentTarget);
                }
              }}
              onSeeked={(event) => {
                if (isActiveMediaElement(event.currentTarget)) {
                  const snapshot = createNativePlaybackEngine(event.currentTarget)?.snapshot();
                  if (!snapshot) {
                    return;
                  }
                  pendingSeekRef.current = null;
                  commitPlaybackPosition(snapshot.position, true);
                  savePlaybackProgress(true);
                }
              }}
              onPlay={(event) => {
                if (isActiveMediaElement(event.currentTarget)) {
                  const loadId = Number(event.currentTarget.dataset.loadId ?? 0);
                  setOpeningMedia((current) => (current?.loadId === loadId ? null : current));
                  setPaused(false);
                }
              }}
              onPause={(event) => {
                if (isActiveMediaElement(event.currentTarget)) {
                  if (settings.repeatCurrent && event.currentTarget.ended) {
                    return;
                  }
                  savePlaybackProgress(true);
                  setPaused(true);
                }
              }}
              onRateChange={(event) => {
                if (isActiveMediaElement(event.currentTarget)) {
                  const snapshot = createNativePlaybackEngine(event.currentTarget)?.snapshot();
                  if (snapshot) {
                    setSpeed(snapshot.speed);
                  }
                }
              }}
              onEnded={(event) => {
                if (isActiveMediaElement(event.currentTarget)) {
                  onEnded();
                }
              }}
              onError={(event) => {
                if (isActiveMediaElement(event.currentTarget)) {
                  setOpeningMedia(null);
                  revealCurrentWindow(windowRevealFocusRef.current);
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

          {isVideo && !openingMedia ? (
            <div className="video-overlay-header" data-wheel-volume="ignore">
              <div className="video-overlay-title">
                <strong>{currentTitle}</strong>
              </div>
            </div>
          ) : null}

          {isAudio && !openingMedia ? (
            <AudioNowPlaying
              artworkUrl={audioArtworkUrl}
              duration={duration || mediaDetails.duration || 0}
              metaLabel={metaLabel}
              metadata={audioMetadata}
              paused={paused}
              position={position}
            />
          ) : null}

          {openingMedia ? (
            <div className="media-opening-state" data-phase={openingMedia.phase} aria-live="polite">
              <strong>
                {openingMedia.phase === "preparing"
                  ? "Preparing media..."
                  : openingMedia.phase === "resuming"
                    ? "Resuming..."
                    : "Opening media..."}
              </strong>
              <span>{fileName(openingMedia.path)}</span>
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

          {mpvActiveForCurrent ? (
            <div className="fallback-overlay" data-wheel-volume="ignore">
              <div>
                <span>Fallback engine</span>
                <strong>Playing through MPV</strong>
                <p>
                  MPV is handling this file in its own playback window. Native LMP playback stays
                  available for the regular embedded path.
                </p>
              </div>
              <div className="fallback-actions">
                <button type="button" onClick={() => void stopTrackedMpv()}>
                  Stop fallback
                </button>
                <button type="button" onClick={() => currentPath && void playPath(currentPath)}>
                  Retry native
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {hasMedia && !openingMedia && !miniPlayerActive && !isText ? (
          <TransportDock
            capabilities={mediaCapabilities}
            currentTitle={currentTitle}
            cycleImageFit={cycleImageFit}
            cycleSpeed={cycleSpeed}
            documentPageCount={documentPageCount}
            documentReady={Boolean(pdfDocument || wordDocument)}
            documentView={documentView}
            duration={duration}
            gstreamerActiveForCurrent={externalPlaybackActiveForCurrent}
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
        {shelfMode === "settings" ? (
          <SettingsPanel
            activeTab={activeSettingsTab}
            cacheStatus={cacheStatus}
            currentPath={currentPath}
            fallbackStatusLabel={fallbackStatusLabel}
            gstreamerAvailable={Boolean(gstreamerBackend?.available)}
            isAudio={isAudio}
            isDocument={isDocument}
            isImage={isImage}
            isStaticViewer={isStaticViewer}
            isText={isText}
            onClearMediaProbeCache={() => void clearMediaProbeCache()}
            onClearPreparedVideoCache={() => void clearPreparedVideoCache()}
            onClearPreviewCache={() => void clearPreviewCache()}
            onClose={closeShelf}
            onOpenCurrentWithGstreamer={() => void openCurrentWithGstreamer()}
            onPatchSettings={patchSettings}
            onPinControls={setControlsPinned}
            onReset={resetSettings}
            onSetPlayerSpeed={setPlayerSpeed}
            onTabChange={setSettingsTab}
            onUpdateInstallLockChange={setUpdateInstallLocked}
            playbackBackends={playbackBackends}
            settings={settings}
            speed={speed}
            tabs={activeSettingsTabs}
            updateInstallLocked={updateInstallLocked}
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
        onRefreshInspection={() => currentPath && void inspectMedia(currentPath, loadIdRef.current)}
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
