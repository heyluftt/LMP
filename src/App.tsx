import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
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
  rememberContentKind,
  seekStep,
  type MediaKind,
} from "./lib/playerBrain";
import {
  deferredMediaDetailsDelayMs,
  homeSourceUrl,
  newTextSourceUrl,
  playbackDebugLoggingEnabled,
  playbackPositionJumpThresholdSeconds,
  playbackPositionRenderIntervalMs,
  playbackProgressAttemptIntervalMs,
  startupDiagnosticsDelayMs,
} from "./app/appConstants";
import type {
  ContextMenuState,
  LoopRange,
  MediaDetails,
  OpeningMediaState,
  RemuxFallbackState,
  StartupResumeState,
  SubtitleTrack,
  TrimExportState,
  TrimRange,
} from "./app/appTypes";
import { AppFeedback } from "./app/AppFeedback";
import { useAppFeedback } from "./app/useAppFeedback";
import { useContentKinds } from "./app/useContentKinds";
import { useLmpAvEngine } from "./app/useLmpAvEngine";
import { useMediaOpenFlow } from "./app/useMediaOpenFlow";
import { usePlaybackStartPipeline } from "./app/usePlaybackStartPipeline";
import { useQueueController } from "./app/useQueueController";
import { useTextEditor } from "./app/useTextEditor";
import { compactError, errorMessage, formatDebugDetails } from "./lib/errorText";
import {
  formatMediaMeta,
  libraryKindLabel,
} from "./lib/mediaFormat";
import {
  applyHomeWindowProfile,
  applyMiniVideoWindowAspect,
  applyMiniWindowProfile,
  applyPlayerVideoWindowAspect,
  applyTextDraftWindowProfile,
  applyVideoWindowAspect,
  applyWindowProfile,
} from "./lib/windowProfile";
import { keyboardCommand } from "./player/keyboard";
import {
  frameStepSecondsFromInspection,
  inspectionKindClass,
  isStreamInspectionItem,
} from "./player/mediaInspection";
import {
  addMoment,
  clearRecent,
  findAdjacentMoment,
  readRecent,
  rememberMedia,
  removeMoment,
} from "./player/memory";
import {
  canOpenShelf,
  capabilitiesFor,
  mediaModeFor,
  type ShelfCapability,
} from "./player/capabilities";
import {
  describeTrack,
  parseSubtitleText,
  trackLabel,
  type AvCue,
  type AvMediaInfo,
} from "./player/av";
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
  canUseLmpAv,
  describeActiveEngine,
  playbackBackendHint,
  playbackPathLabel,
} from "./player/playbackEnginePolicy";
import { describePlaybackProblem, isUnsupportedSourceError } from "./player/playbackErrors";
import { ResumeController } from "./player/resumeController";
import { defaultSettings, readSettings, updateSettings } from "./player/settings";
import type { PlayerSettings } from "./player/settings";
import { normalizeSubtitleToVtt } from "./player/subtitles";
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
import { printCurrentWebView, printPdfDocument } from "./viewers/pdf/PdfPrint";
import {
  isWordDocumentExtension,
  WordDocumentSurface,
  type WordDocumentContent,
} from "./viewers/word";
import { textLanguageLabelForKey, type TextLanguageKey } from "./viewers/text/textLanguages";
import type { TextFileStat } from "./viewers/text/textModel";
import { textShortcutFor } from "./viewers/text/textShortcuts";
import { TextWorkspace, type TextWorkspaceHandle } from "./viewers/text/TextWorkspace";
import {
  MediaShelves,
  type LibraryFilter,
  type LibrarySort,
  type MediaShelfMode,
} from "./ui/MediaShelves";
import { QueueShelf } from "./ui/shelves/QueueShelf";
import { compareLibraryItems } from "./ui/shelves/libraryUtils";
import { ContextMenu, type ContextMenuSection } from "./ui/ContextMenu";
import { HomeScreen } from "./ui/HomeScreen";
import { SubtitleOverlay } from "./ui/SubtitleOverlay";
import { TransportDock } from "./ui/TransportDock";
import { WindowChrome } from "./ui/WindowChrome";
import type {
  ClipExportProgress,
  ClipPresetId,
  MediaInspection,
  MediaFile,
  MediaFolder,
  MediaFolderItem,
  Moment,
  PlaybackEngine,
  PlaybackBackendStatus,
  PlaybackTrackChoice,
  PlayerCommand,
  SettingsCacheStatus,
  SubtitleFile,
} from "./player/types";

function App() {
  const windowLabel = getCurrentWindow().label;
  const mediaRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<HTMLElement | null>(null);

  const [playbackBackends, setPlaybackBackends] = useState<PlaybackBackendStatus[]>([]);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [currentMedia, setCurrentMedia] = useState<MediaFile | null>(null);
  const [openingMedia, setOpeningMedia] = useState<OpeningMediaState | null>(null);
  const [startupFilesSettled, setStartupFilesSettled] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => readRecent());
  const [paused, setPaused] = useState(true);
  const [settings, setSettings] = useState<PlayerSettings>(() => readSettings());
  const [volume, setVolume] = useState(settings.defaultVolume);
  const [speed, setSpeed] = useState(1);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [mediaInspection, setMediaInspection] = useState<MediaInspection | null>(null);
  const [mediaInspectionLoading, setMediaInspectionLoading] = useState(false);
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
  const [sidecarCues, setSidecarCues] = useState<AvCue[] | null>(null);
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);
  const [imageView, setImageView] = useState<ImageViewState>(defaultImageView);
  const [documentView, setDocumentView] = useState<DocumentViewState>(defaultDocumentView);
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
  const [shelfMode, setShelfMode] = useState<MediaShelfMode>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("controls");
  const [updateInstallLocked, setUpdateInstallLocked] = useState(false);
  const [cacheStatus, setCacheStatus] = useState<SettingsCacheStatus | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const {
    choiceDialog,
    confirmDialog,
    promptDialog,
    promptInput,
    requestChoice,
    requestConfirm,
    setPromptInput,
    settleChoiceDialog,
    settleConfirmDialog,
    settlePromptDialog,
    showToast,
    toast,
  } = useAppFeedback();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [miniPlayer, setMiniPlayer] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [controlsPinned, setControlsPinned] = useState(false);
  const [controlActivity, setControlActivity] = useState(0);
  const [videoCursorHidden, setVideoCursorHidden] = useState(false);
  const volumeRef = useRef(volume);
  const playbackEngineChoiceRef = useRef(settings.playbackEngine);
  const avBypassPathRef = useRef<string | null>(null);
  const avFallbackAttemptedPathRef = useRef<string | null>(null);
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
  const textWorkspaceRef = useRef<TextWorkspaceHandle | null>(null);
  const textCloseAllowedRef = useRef(false);
  const textRecoveryAttemptedRef = useRef(false);
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
  const windowRevealTimerRef = useRef<number | null>(null);
  const windowRevealAllowedRef = useRef(true);
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
  const playerVideoAspectTimerRef = useRef<number | null>(null);
  const playerVideoAspectCorrectionRef = useRef(false);
  const miniVideoAspectTimerRef = useRef<number | null>(null);
  const miniVideoAspectCorrectionRef = useRef(false);
  const miniPlayerActiveRef = useRef(false);
  const homeProfileAppliedRef = useRef(false);
  const settingsRef = useRef(settings);
  const speedRef = useRef(speed);
  settingsRef.current = settings;
  speedRef.current = speed;

  const tracePlaybackFocus = useCallback((phase: string, details: Record<string, unknown> = {}) => {
    if (!playbackDebugLoggingEnabled) {
      return;
    }
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
    if (!playbackDebugLoggingEnabled) {
      return;
    }
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

  const cancelMiniVideoAspectTimer = useCallback(() => {
    if (miniVideoAspectTimerRef.current !== null) {
      window.clearTimeout(miniVideoAspectTimerRef.current);
      miniVideoAspectTimerRef.current = null;
    }
  }, []);

  const cancelPlayerVideoAspectTimer = useCallback(() => {
    if (playerVideoAspectTimerRef.current !== null) {
      window.clearTimeout(playerVideoAspectTimerRef.current);
      playerVideoAspectTimerRef.current = null;
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

  const handleTextPathChange = useCallback((path: string, stat: TextFileStat) => {
    rememberContentKind(path, "text");
    activePlaybackPathRef.current = path;
    setCurrentPath(path);
    setCurrentMedia({
      path,
      display_name: fileName(path),
      extension: mediaExtension(path),
      byte_len: stat.byteLen,
      kind: "text",
    });
    setSourceUrl(convertFileSrc(path));
    setRecent(settingsRef.current.rememberRecentMedia ? rememberMedia(path) : readRecent());
  }, []);
  const textEditor = useTextEditor({
    onDocumentPathChange: handleTextPathChange,
    requestChoice,
    requestConfirm,
    settings,
    showToast,
  });
  const textController = textEditor.controller;
  const hasTextDocument = textController.doc !== null;
  const textTitle = textController.title;
  const currentTitle = useMemo(
    () => (hasTextDocument ? textTitle : currentPath ? fileName(currentPath) : "LMP"),
    [currentPath, hasTextDocument, textTitle],
  );
  const sourceKind = useMemo(
    () => (currentPath ? mediaKind(currentPath) : "unknown"),
    [currentPath],
  );
  // An open text document (file, untitled draft or Word extract) always shows the editor.
  const currentKind: MediaKind = hasTextDocument ? "text" : sourceKind;
  const videoFitMode: "contain" | "cover" = isFullscreen || isWindowMaximized ? "contain" : "cover";
  // The LMP AV handlers are declared further down; they only run after mount.
  const av = useLmpAvEngine(
    {
      onEnded: (path) => handleAvEnded(path),
      onError: (message, fatal, path) => handleAvError(message, fatal, path),
      onFirstFrame: (positionSeconds, path) => handleAvFirstFrame(positionSeconds, path),
      onReady: (info, path) => handleAvReady(info, path),
      onSeeked: (positionSeconds, path) => handleAvSeeked(positionSeconds, path),
      onStateChange: (nextPaused, path) => handleAvStateChange(nextPaused, path),
      onTimeUpdate: (positionSeconds, path) => handleAvTimeUpdate(positionSeconds, path),
      onVideoSize: (width, height, path) => handleAvVideoSize(width, height, path),
    },
    videoFitMode,
  );
  const avActiveForCurrent = av.isActiveFor(currentPath);
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
  miniPlayerActiveRef.current = miniPlayerActive;

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

  useEffect(() => {
    if (!isVideo || miniPlayerActive || !mediaDetails.width || !mediaDetails.height) {
      cancelPlayerVideoAspectTimer();
      return;
    }

    const loadId = loadIdRef.current;
    const path = activePlaybackPathRef.current;
    const videoWidth = mediaDetails.width;
    const videoHeight = mediaDetails.height;
    const isCurrent = () =>
      loadId === loadIdRef.current &&
      activePlaybackPathRef.current === path &&
      !miniPlayerActiveRef.current;
    const applyAspect = () => {
      playerVideoAspectTimerRef.current = null;
      if (playerVideoAspectCorrectionRef.current) {
        return;
      }
      playerVideoAspectCorrectionRef.current = true;
      void applyPlayerVideoWindowAspect(videoWidth, videoHeight, isCurrent).finally(() => {
        playerVideoAspectCorrectionRef.current = false;
      });
    };
    const scheduleAspect = (delayMs = 420) => {
      if (playerVideoAspectCorrectionRef.current) {
        return;
      }
      cancelPlayerVideoAspectTimer();
      playerVideoAspectTimerRef.current = window.setTimeout(applyAspect, delayMs);
    };
    const handleWindowResize = () => scheduleAspect();

    window.addEventListener("resize", handleWindowResize);

    return () => {
      window.removeEventListener("resize", handleWindowResize);
      cancelPlayerVideoAspectTimer();
    };
  }, [
    cancelPlayerVideoAspectTimer,
    isVideo,
    mediaDetails.height,
    mediaDetails.width,
    miniPlayerActive,
  ]);

  useEffect(() => {
    if (!miniPlayerActive || !isVideo || !mediaDetails.width || !mediaDetails.height) {
      cancelMiniVideoAspectTimer();
      return;
    }

    const loadId = loadIdRef.current;
    const path = activePlaybackPathRef.current;
    const videoWidth = mediaDetails.width;
    const videoHeight = mediaDetails.height;
    const isCurrent = () =>
      loadId === loadIdRef.current &&
      activePlaybackPathRef.current === path &&
      miniPlayerActiveRef.current;
    const applyAspect = () => {
      miniVideoAspectTimerRef.current = null;
      if (miniVideoAspectCorrectionRef.current) {
        return;
      }
      miniVideoAspectCorrectionRef.current = true;
      void applyMiniVideoWindowAspect(videoWidth, videoHeight, isCurrent).finally(() => {
        miniVideoAspectCorrectionRef.current = false;
      });
    };
    const scheduleAspect = (delayMs = 360) => {
      if (miniVideoAspectCorrectionRef.current) {
        return;
      }
      cancelMiniVideoAspectTimer();
      miniVideoAspectTimerRef.current = window.setTimeout(applyAspect, delayMs);
    };
    const handleWindowResize = () => scheduleAspect();

    scheduleAspect(120);
    window.addEventListener("resize", handleWindowResize);

    return () => {
      window.removeEventListener("resize", handleWindowResize);
      cancelMiniVideoAspectTimer();
    };
  }, [
    cancelMiniVideoAspectTimer,
    isVideo,
    mediaDetails.height,
    mediaDetails.width,
    miniPlayerActive,
  ]);

  useEffect(() => cancelVideoWindowAspectRetry, [cancelVideoWindowAspectRetry]);

  const supportsQueue = mediaCapabilities.queue;
  const supportsMoments = mediaCapabilities.moments;
  const supportsLoopPoints = mediaCapabilities.loopPoints;
  const hasMedia = Boolean(sourceUrl || openingMedia || avActiveForCurrent);
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

  const playbackEngineLabel = playbackPathLabel(settings.playbackEngine, av.available);
  const backendHint = playbackBackendHint(settings.playbackEngine, playbackBackends, av.available);
  const activeEngineLabel = describeActiveEngine(
    hasMedia && isTimedMedia ? (avActiveForCurrent ? "lmp-av" : sourceUrl ? "native" : null) : null,
    av.hardwareDecode,
  );
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
      ? !Number.isFinite(trimRange.start) || !Number.isFinite(trimRange.end)
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
      ? textLanguageLabelForKey(textController.languageKey).toLowerCase()
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
    avActiveForCurrent ? "lmp-av-mode" : "",
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
      objectFit: isVideo ? videoFitMode : "cover",
    }),
    [isVideo, videoFitMode],
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
  const avFrameDurationSeconds = av.frameDurationSeconds;
  const frameStepSeconds = useMemo(
    () =>
      avActiveForCurrent
        ? avFrameDurationSeconds()
        : frameStepSecondsFromInspection(videoInspectionItems),
    [avActiveForCurrent, avFrameDurationSeconds, videoInspectionItems],
  );
  const audioInspectionItems = useMemo(
    () => streamInspectionItems.filter((item) => inspectionKindClass(item) === "audio"),
    [streamInspectionItems],
  );
  const subtitleInspectionItems = useMemo(
    () => streamInspectionItems.filter((item) => inspectionKindClass(item) === "subtitle"),
    [streamInspectionItems],
  );
  const avInfo = av.info;
  const audioTrackChoices = useMemo<PlaybackTrackChoice[]>(() => {
    if (avActiveForCurrent && avInfo) {
      return avInfo.tracks
        .filter((track) => track.kind === "audio")
        .map((track, index) => ({
          id: track.id,
          label: trackLabel(track, index),
          detail: describeTrack(track),
          supported: Boolean(track.codec),
        }));
    }
    return audioInspectionItems.map((item, index) => ({
      id: index,
      label: item.value || item.label,
      detail: item.detail ?? "",
      supported: true,
    }));
  }, [audioInspectionItems, avActiveForCurrent, avInfo]);
  const subtitleTrackChoices = useMemo<PlaybackTrackChoice[]>(() => {
    if (avActiveForCurrent && avInfo) {
      return avInfo.tracks
        .filter((track) => track.kind === "subtitle")
        .map((track, index) => ({
          id: track.id,
          label: trackLabel(track, index),
          detail: describeTrack(track),
          supported: Boolean(track.subtitleFormat),
        }));
    }
    return subtitleInspectionItems.map((item, index) => ({
      id: index,
      label: item.value || item.label,
      detail: item.detail ?? "",
      supported: false,
    }));
  }, [avActiveForCurrent, avInfo, subtitleInspectionItems]);
  const activeAudioTrackId = avActiveForCurrent
    ? av.tracks.audio?.id ?? null
    : audioInspectionItems.length > 0
      ? 0
      : null;
  const activeSubtitleTrackId = avActiveForCurrent ? av.tracks.subtitle?.id ?? null : null;
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
  const [textInspectionTick, setTextInspectionTick] = useState(0);
  const textDescribe = textEditor.describe;
  const textInspection = useMemo(
    () => (isText && shelfMode === "info" ? textDescribe() : null),
    // The tick and the document object refresh the snapshot of the editor contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isText, shelfMode, textDescribe, textController.doc, textController.dirty, textInspectionTick],
  );
  // Recent `.ts` files are video or TypeScript; the version changes once their content was checked.
  const recentContentKinds = useContentKinds(recent);
  const recentTextFiles = useMemo(
    () => recent.filter((path) => mediaKind(path) === "text"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recent, recentContentKinds],
  );

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

  const revealPlaybackWindow = useCallback(
    (focus = windowRevealFocusRef.current) => {
      if (!windowRevealAllowedRef.current) {
        tracePlaybackFocus("reveal-skip-transition", { focus });
        return;
      }
      revealCurrentWindow(focus);
    },
    [revealCurrentWindow, tracePlaybackFocus],
  );

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
          revealAllowed: windowRevealAllowedRef.current,
        });
        setOpeningMedia((current) => (current?.loadId === loadId ? null : current));
        if (!windowRevealAllowedRef.current) {
          tracePlaybackFocus("media-ready-reveal-skip", {
            loadId,
            reason: "transition",
          });
          return;
        }
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
      setSidecarCues(parseSubtitleText(file.content));
      setSubtitlesEnabled(true);
      showToast(`${automatic ? "Subtitle found" : "Subtitle loaded"}: ${file.display_name}`, "success");
    },
    [revokeSubtitleUrl, showToast],
  );

  const clearSubtitleTrack = useCallback(
    (notify = false) => {
      revokeSubtitleUrl();
      setSubtitleTrack(null);
      setSidecarCues(null);
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

  const confirmTextLeave = textEditor.confirmLeave;
  const confirmTextNavigation = useCallback(
    async (_nextPath: string) => confirmTextLeave(),
    [confirmTextLeave],
  );

  const confirmWindowClose = useCallback(
    () =>
      confirmTextLeave().then((allowed) => {
        textCloseAllowedRef.current = allowed;
        return allowed;
      }),
    [confirmTextLeave],
  );
  windowCloseStateRef.current = { isText, textDirty: textController.dirty };
  confirmWindowCloseRef.current = confirmWindowClose;

  const startAvEngine = av.start;
  const stopAvEngine = av.stop;
  const startLmpAvPlayback = useCallback(
    async (
      path: string,
      loadId: number,
      startSeconds: number | null,
      focusWindow: boolean,
      revealWindow: boolean,
    ) => {
      tracePlaybackFocus("lmp-av-start-request", {
        focusWindow,
        loadId,
        revealWindow,
        startSeconds: startSeconds ?? "-",
        title: fileName(path),
      });
      abortNativeMediaLoad();
      setSourceUrl(null);
      windowRevealAllowedRef.current = revealWindow;
      windowRevealFocusRef.current = focusWindow;
      const info = await startAvEngine(path, {
        startSeconds,
        autoplay: true,
        volume: volumeRef.current,
        speed: speedRef.current,
      });
      if (loadId !== loadIdRef.current || activePlaybackPathRef.current !== path) {
        tracePlaybackFocus("lmp-av-start-skip", {
          reason: "stale-after-start",
          loadId,
          title: fileName(path),
        });
        void stopAvEngine();
        return info;
      }
      if (revealWindow) {
        scheduleWindowRevealFallback(path, loadId, 1600, focusWindow);
      }
      tracePlaybackFocus("lmp-av-start-ok", {
        duration: info.durationUs / 1e6,
        loadId,
        title: fileName(path),
      });
      return info;
    },
    [abortNativeMediaLoad, scheduleWindowRevealFallback, startAvEngine, stopAvEngine, tracePlaybackFocus],
  );

  const playPath = usePlaybackStartPipeline({
    abortNativeMediaLoad,
    activePlaybackPathRef,
    applyWindowProfile,
    avBypassPathRef,
    cancelVideoWindowAspectRetry,
    clearSubtitleTrack,
    commitPlaybackPosition,
    confirmTextNavigation,
    documentDragRef,
    documentZoomAnchorRef,
    inspectMedia,
    lmpAvAvailable: av.available,
    loadIdRef,
    loadSubtitleFile,
    mediaReadyRevealSuppressRef,
    openTextFile: textEditor.openFile,
    openWordExtract: textEditor.openWordExtract,
    pendingSeekRef,
    recentOpenRequestRef,
    remuxFallbackRef,
    resetImageView,
    resetTextSession: textEditor.resetSession,
    resumeController,
    revealCurrentWindow,
    revealCurrentWindowAfterRender,
    scheduleDeferredMediaDetails,
    scheduleWindowRevealFallback,
    setAudioArtworkUrl,
    setCurrentMedia,
    setCurrentPath,
    setDocumentError,
    setDocumentLoading,
    setDocumentPageCount,
    setDocumentView,
    setDuration,
    setIsDocumentDragging,
    setLoopRange,
    setMediaDetails,
    setMediaInspection,
    setMediaInspectionLoading,
    setMoments,
    setOpeningMedia,
    setPaused,
    setPdfDocument,
    setRecent,
    setShelfMode,
    setSourceUrl,
    setToolsOpen,
    setTrimError,
    setTrimExport,
    setTrimRange,
    setWordDocument,
    settings,
    showToast,
    startLmpAv: startLmpAvPlayback,
    startupResumeRef,
    stopLmpAv: stopAvEngine,
    trimPreviewEndRef,
    videoWindowAspectTokenRef,
    windowRevealAllowedRef,
    windowRevealFocusRef,
    windowRevealTimerRef,
  });
  const {
    addFilesToQueue,
    clearCurrentQueue,
    hasNextQueueItem,
    hasPreviousQueueItem,
    moveQueuedItem,
    playNextQueueItem,
    playQueue,
    playQueueIndex,
    queue,
    queueCount,
    queueIndex,
    removeQueuedItem,
    resetQueue,
  } = useQueueController({
    activePlaybackPathRef,
    autoQueueFolder: settings.autoQueueFolder,
    confirmTextNavigation,
    currentPath,
    playPath,
    setShelfMode,
    shelfMode,
    showToast,
    supportsQueue,
  });
  const { dropActive, openFile, openHomeFiles } = useMediaOpenFlow({
    audioMultiWindow: settings.audioMultiWindow,
    currentKind,
    hasMedia,
    playQueue,
    revealCurrentWindow,
    setStartupFilesSettled,
    showToast,
    windowLabel,
  });

  /** Clears every viewer so a text draft that is not loaded by the pipeline can take the stage. */
  const prepareStageForTextDraft = useCallback((draftPath: string | null) => {
    loadIdRef.current += 1;
    cancelVideoWindowAspectRetry();
    videoWindowAspectTokenRef.current = null;
    pendingSeekRef.current = null;
    startupResumeRef.current = null;
    if (windowRevealTimerRef.current !== null) {
      window.clearTimeout(windowRevealTimerRef.current);
      windowRevealTimerRef.current = null;
    }
    activePlaybackPathRef.current = draftPath;
    recentOpenRequestRef.current = null;
    void stopAvEngine();
    abortNativeMediaLoad();
    setOpeningMedia(null);
    setCurrentPath(draftPath);
    setCurrentMedia(null);
    resetQueue();
    setSourceUrl(draftPath ? convertFileSrc(draftPath) : newTextSourceUrl);
    setMediaInspection(null);
    setMediaInspectionLoading(false);
    setAudioArtworkUrl(null);
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
    windowRevealAllowedRef.current = true;
    windowRevealFocusRef.current = true;
    void applyTextDraftWindowProfile();
    revealCurrentWindow();
  }, [
    abortNativeMediaLoad,
    cancelVideoWindowAspectRetry,
    clearSubtitleTrack,
    commitPlaybackPosition,
    resetImageView,
    resetQueue,
    revealCurrentWindow,
    stopAvEngine,
  ]);

  const newTextDocument = textEditor.newDocument;
  const createNewTextDraft = useCallback(
    async (languageId: TextLanguageKey | null = null) => {
      if (!(await confirmTextNavigation(newTextSourceUrl))) {
        return false;
      }
      prepareStageForTextDraft(null);
      newTextDocument(languageId);
      return true;
    },
    [confirmTextNavigation, newTextDocument, prepareStageForTextDraft],
  );

  const { applyDraft: applyTextDraft, readDraft: readTextDraft, refreshDrafts: refreshTextDrafts } = textEditor;
  const restoreTextDraft = useCallback(
    async (id: string, skipConfirm = false) => {
      if (!skipConfirm && !(await confirmTextNavigation(newTextSourceUrl))) {
        return false;
      }
      const snapshot = await readTextDraft(id);
      if (!snapshot) {
        showToast("This draft is no longer available.", "info");
        void refreshTextDrafts();
        return false;
      }
      prepareStageForTextDraft(
        snapshot.sourceType === "file" ? snapshot.savePath : snapshot.sourceType === "word-extract" ? snapshot.originalPath : null,
      );
      await applyTextDraft(snapshot);
      return true;
    },
    [applyTextDraft, confirmTextNavigation, prepareStageForTextDraft, readTextDraft, refreshTextDrafts, showToast],
  );

  const discardTextDraft = useCallback(
    async (id: string) => {
      const allowed = await requestConfirm({
        title: "Discard draft?",
        message: "The unsaved text in this draft is deleted.",
        confirmLabel: "Discard",
        tone: "danger",
      });
      if (allowed) {
        await textEditor.clearDraft(id);
      }
    },
    [requestConfirm, textEditor],
  );

  // After a crash LMP reopens the newest draft when it starts without files.
  const textDrafts = textEditor.drafts;
  const textDraftsLoaded = textEditor.draftsLoaded;
  useEffect(() => {
    if (textRecoveryAttemptedRef.current || !textDraftsLoaded || !startupFilesSettled) {
      return;
    }
    textRecoveryAttemptedRef.current = true;
    const latest = textDrafts[0];
    if (hasMedia || !latest) {
      return;
    }
    void restoreTextDraft(latest.id, true).then((opened) => {
      if (opened) {
        showToast(`Recovered unsaved draft: ${latest.title}.`, "success");
      }
    });
  }, [hasMedia, restoreTextDraft, showToast, startupFilesSettled, textDrafts, textDraftsLoaded]);

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
    void stopAvEngine();
    abortNativeMediaLoad();
    setOpeningMedia(null);
    setCurrentPath(null);
    setCurrentMedia(null);
    resetQueue();
    setSourceUrl(null);
    setMediaInspection(null);
    setMediaInspectionLoading(false);
    setAudioArtworkUrl(null);
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
    textEditor.resetSession();
    void textEditor.refreshDrafts();
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
    windowRevealAllowedRef.current = true;
    windowRevealFocusRef.current = true;
    void applyHomeWindowProfile();
    revealCurrentWindow();
  }, [
    abortNativeMediaLoad,
    cancelVideoWindowAspectRetry,
    clearSubtitleTrack,
    commitPlaybackPosition,
    confirmTextNavigation,
    resetImageView,
    resetQueue,
    revealCurrentWindow,
    shelfMode,
    showToast,
    stopAvEngine,
    textEditor,
    updateInstallLocked,
  ]);

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

  const avSelectAudioTrack = av.selectAudioTrack;
  const avSelectSubtitleTrack = av.selectSubtitleTrack;
  const avEmbeddedSubtitleActive = avActiveForCurrent && av.tracks.subtitle !== null;

  const selectAudioTrack = useCallback(
    (trackId: number) => {
      if (!avActiveForCurrent) {
        showToast(
          "Audio track switching needs the LMP AV engine. Choose LMP AV under Settings - Engine.",
          "info",
        );
        return;
      }
      const choice = audioTrackChoices.find((track) => track.id === trackId);
      void avSelectAudioTrack(trackId)
        .then(() => showToast(`Audio: ${choice?.label ?? `track ${trackId}`}`, "success"))
        .catch((error) => showToast(compactError(error), "error"));
    },
    [audioTrackChoices, avActiveForCurrent, avSelectAudioTrack, showToast],
  );

  const selectSubtitleTrack = useCallback(
    (trackId: number | null) => {
      if (!avActiveForCurrent) {
        showToast(
          "Embedded subtitles need the LMP AV engine. Choose LMP AV under Settings - Engine.",
          "info",
        );
        return;
      }
      const choice = trackId === null ? null : subtitleTrackChoices.find((track) => track.id === trackId);
      void avSelectSubtitleTrack(trackId)
        .then(() => {
          if (trackId !== null) {
            setSubtitlesEnabled(true);
            showToast(`Subtitles: ${choice?.label ?? "embedded track"}`, "success");
          }
        })
        .catch((error) => showToast(compactError(error), "error"));
    },
    [avActiveForCurrent, avSelectSubtitleTrack, showToast, subtitleTrackChoices],
  );

  const toggleSubtitles = useCallback(() => {
    if (!subtitleTrack && !avEmbeddedSubtitleActive) {
      const embedded = subtitleTrackChoices.find((track) => track.supported);
      if (avActiveForCurrent && embedded) {
        selectSubtitleTrack(embedded.id);
        return;
      }
      void openSubtitle();
      return;
    }

    setSubtitlesEnabled((enabled) => !enabled);
  }, [
    avActiveForCurrent,
    avEmbeddedSubtitleActive,
    openSubtitle,
    selectSubtitleTrack,
    subtitleTrack,
    subtitleTrackChoices,
  ]);

  const avEngine = av.engine;
  const activePlaybackEngine = useCallback((): PlaybackEngine | null => {
    if (avActiveForCurrent && avEngine) {
      return avEngine;
    }
    return createNativePlaybackEngine(mediaRef.current);
  }, [avActiveForCurrent, avEngine]);

  const tryRemuxFallback = useCallback(
    async (error?: unknown, media?: HTMLMediaElement) => {
      const path = currentPath;
      if (!path || !isUnsupportedSourceError(error, media) || !canTryRemuxFallback(path)) {
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
        if (windowRevealAllowedRef.current) {
          scheduleWindowRevealFallback(path, loadIdRef.current, 1400, windowRevealFocusRef.current);
        }
        showToast("Media remuxed without re-encoding.", "success");
      } catch (fallbackError) {
        remuxFallbackRef.current = { path, status: "done" };
        revealPlaybackWindow();
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
      revealPlaybackWindow,
      scheduleWindowRevealFallback,
      showToast,
    ],
  );

  const tryLmpAvFallback = useCallback(
    async (error?: unknown, media?: HTMLMediaElement) => {
      const path = currentPath;
      if (
        !path ||
        !isUnsupportedSourceError(error, media) ||
        !canUseLmpAv(path, settings.playbackEngine, av.available) ||
        avBypassPathRef.current === path ||
        avFallbackAttemptedPathRef.current === path
      ) {
        return false;
      }

      avFallbackAttemptedPathRef.current = path;
      const loadId = loadIdRef.current;
      setPaused(true);
      showToast("The WebView cannot decode this file. Switching to LMP AV...", "info");
      try {
        const startupResume = startupResumeRef.current;
        const startSeconds =
          startupResume?.path === path && startupResume.loadId === loadId
            ? startupResume.target
            : renderedPlaybackPositionRef.current > 1
              ? renderedPlaybackPositionRef.current
              : null;
        setOpeningMedia({ kind: mediaKind(path), path, phase: "opening", loadId });
        await startLmpAvPlayback(
          path,
          loadId,
          startSeconds,
          windowRevealFocusRef.current,
          windowRevealAllowedRef.current,
        );
        return true;
      } catch (avError) {
        if (loadId !== loadIdRef.current || activePlaybackPathRef.current !== path) {
          return true;
        }
        setOpeningMedia(null);
        showToast(`LMP AV could not open this file either: ${compactError(avError)}`, "info");
        return false;
      }
    },
    [av.available, currentPath, settings.playbackEngine, showToast, startLmpAvPlayback],
  );

  const handlePlaybackProblem = useCallback(
    async (error?: unknown, media?: HTMLMediaElement) => {
      if (await tryLmpAvFallback(error, media)) {
        return true;
      }

      if (await tryRemuxFallback(error, media)) {
        return true;
      }

      revealPlaybackWindow();
      showToast(describePlaybackProblem(error, media, currentPath), "error");
      return true;
    },
    [currentPath, revealPlaybackWindow, showToast, tryLmpAvFallback, tryRemuxFallback],
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
      handlePlaybackProblem,
      commitPlaybackPosition,
      isTimedMedia,
      activePlaybackEngine,
      resumeController,
      showToast,
    ],
  );

  const playPreviousQueueItem = useCallback(async () => {
    if (hasPreviousQueueItem) {
      await playQueueIndex(queueIndex - 1, { transition: "internal-queue" });
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

  useEffect(() => {
    const previousEngine = playbackEngineChoiceRef.current;
    if (previousEngine === settings.playbackEngine) {
      return;
    }

    playbackEngineChoiceRef.current = settings.playbackEngine;
    avBypassPathRef.current = null;
    avFallbackAttemptedPathRef.current = null;
    if (!currentPath || !isTimedMedia) {
      return;
    }

    recentOpenRequestRef.current = null;
    void playPath(currentPath, {
      focusWindow: false,
      resumeAt: renderedPlaybackPositionRef.current,
      revealWindow: false,
      skipTextGuard: true,
      transition: "internal-queue",
    }).catch(() => undefined);
  }, [currentPath, isTimedMedia, playPath, settings.playbackEngine]);

  const avSetSidecarCues = av.setSidecarCues;
  const avSetSubtitlesEnabled = av.setSubtitlesEnabled;

  useEffect(() => {
    avSetSidecarCues(sidecarCues);
  }, [avActiveForCurrent, avSetSidecarCues, sidecarCues]);

  useEffect(() => {
    avSetSubtitlesEnabled(subtitlesEnabled);
  }, [avActiveForCurrent, avSetSubtitlesEnabled, subtitlesEnabled]);

  const patchSettings = useCallback((patch: Partial<PlayerSettings>) => {
    setSettings((current) => updateSettings(current, patch));
    if (patch.rememberRecentMedia === false) {
      setRecent([]);
      setShelfMode((mode) => (mode === "recent" ? null : mode));
    }
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
    const timer = window.setTimeout(() => {
      void invoke<PlaybackBackendStatus[]>("get_playback_backends")
        .then((backends) => {
          if (!disposed) {
            setPlaybackBackends(backends);
          }
        })
        .catch(() => undefined);
    }, startupDiagnosticsDelayMs);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, []);

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
    let disposed = false;
    let unlistenResize: (() => void) | undefined;
    let unlistenFocus: (() => void) | undefined;
    const appWindow = getCurrentWindow();

    const syncMaximized = () => {
      void appWindow
        .isMaximized()
        .then((maximized) => {
          if (!disposed) {
            setIsWindowMaximized(maximized);
          }
        })
        .catch(() => undefined);
    };

    syncMaximized();

    void appWindow
      .onResized(() => syncMaximized())
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlistenResize = unlisten;
      })
      .catch(() => undefined);

    void appWindow
      .onFocusChanged(() => syncMaximized())
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlistenFocus = unlisten;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlistenResize?.();
      unlistenFocus?.();
    };
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
      revealPlaybackWindow();
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

      revealPlaybackWindow();
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
  }, [handlePlaybackProblem, isStaticViewer, resumeController, revealPlaybackWindow, sourceUrl, showToast]);

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

  const handlePlaybackTick = useCallback(
    (player: PlaybackEngine) => {
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

  const onTimeUpdate = useCallback(
    (media: HTMLMediaElement) => {
      const player = createNativePlaybackEngine(media);
      if (player) {
        handlePlaybackTick(player);
      }
    },
    [handlePlaybackTick],
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
      if (player) {
        void player.run({ type: "setSpeed", speed }).catch(() => undefined);
      }
    },
    [isVideo, scheduleVideoWindowAspectResize, speed],
  );

  const onEnded = useCallback(() => {
    trimPreviewEndRef.current = null;
    const player = activePlaybackEngine();
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
      windowRevealAllowedRef.current = false;
      windowRevealFocusRef.current = false;
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
      windowRevealAllowedRef.current = false;
      windowRevealFocusRef.current = false;
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

    if (snapshot && snapshot.duration > 0) {
      commitPlaybackPosition(snapshot.duration, true);
      savePlaybackProgress(true);
    }
    setPaused(true);
    if (settings.autoplayNext && hasNextQueueItem) {
      tracePlaybackFocus("native-autoplay-next", { focusWindow: false });
      void playNextQueueItem({ focusWindow: false, transition: "internal-autoplay" });
    }
  }, [
    activePlaybackEngine,
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

  const handleAvReady = useCallback((info: AvMediaInfo, path: string) => {
    if (activePlaybackPathRef.current !== path) {
      return;
    }
    pendingSeekRef.current = null;
    const durationSeconds = info.durationUs / 1e6;
    const video = info.tracks.find((track) => track.kind === "video");
    setDuration(durationSeconds);
    setMediaDetails({
      width: video ? video.displayWidth || video.width || null : null,
      height: video ? video.displayHeight || video.height || null : null,
      duration: durationSeconds > 0 ? durationSeconds : null,
    });
  }, []);

  const handleAvVideoSize = useCallback((width: number, height: number, path: string) => {
    if (activePlaybackPathRef.current !== path || !width || !height) {
      return;
    }
    setMediaDetails((current) => {
      const nextWidth = Math.round(width);
      const nextHeight = Math.round(height);
      if (current.width === nextWidth && current.height === nextHeight) {
        return current;
      }
      return { ...current, width: nextWidth, height: nextHeight };
    });
  }, []);

  const handleAvFirstFrame = useCallback(
    (_positionSeconds: number, path: string) => {
      if (activePlaybackPathRef.current !== path) {
        return;
      }
      const loadId = loadIdRef.current;
      setOpeningMedia((current) => (current?.path === path ? null : current));
      if (startupResumeRef.current?.path === path) {
        startupResumeRef.current = null;
      }
      tracePlaybackFocus("lmp-av-first-frame", { loadId, title: fileName(path) });
      revealPlaybackWindow();
    },
    [revealPlaybackWindow, tracePlaybackFocus],
  );

  const handleAvStateChange = useCallback(
    (nextPaused: boolean, path: string) => {
      if (activePlaybackPathRef.current !== path) {
        return;
      }
      setPaused(nextPaused);
      if (nextPaused) {
        savePlaybackProgress(true);
      }
    },
    [savePlaybackProgress],
  );

  const handleAvSeeked = useCallback(
    (positionSeconds: number, path: string) => {
      if (activePlaybackPathRef.current !== path) {
        return;
      }
      pendingSeekRef.current = null;
      commitPlaybackPosition(positionSeconds, true);
      savePlaybackProgress(true);
    },
    [commitPlaybackPosition, savePlaybackProgress],
  );

  const handleAvTimeUpdate = useCallback(
    (positionSeconds: number, path: string) => {
      if (activePlaybackPathRef.current !== path || !avEngine) {
        return;
      }
      if (positionSeconds > 0.25) {
        setOpeningMedia((current) => (current?.path === path ? null : current));
      }
      handlePlaybackTick(avEngine);
    },
    [avEngine, handlePlaybackTick],
  );

  const handleAvEnded = useCallback(
    (path: string) => {
      if (activePlaybackPathRef.current !== path) {
        return;
      }
      tracePlaybackFocus("lmp-av-ended", { title: fileName(path) });
      onEnded();
    },
    [onEnded, tracePlaybackFocus],
  );

  const handleAvError = useCallback(
    (message: string, fatal: boolean, path: string) => {
      if (activePlaybackPathRef.current !== path) {
        return;
      }
      if (!fatal) {
        showToast(message, "info");
        return;
      }
      tracePlaybackFocus("lmp-av-fatal", { error: message, title: fileName(path) });
      avBypassPathRef.current = path;
      showToast(`LMP AV stopped: ${message} Switching to native playback.`, "info");
      const loadId = loadIdRef.current;
      void stopAvEngine().then(() => {
        if (loadIdRef.current !== loadId || activePlaybackPathRef.current !== path) {
          return;
        }
        recentOpenRequestRef.current = null;
        void playPath(path, {
          focusWindow: false,
          resumeAt: renderedPlaybackPositionRef.current,
          revealWindow: false,
          skipTextGuard: true,
          transition: "internal-queue",
        }).catch((error) => showToast(compactError(error), "error"));
      });
    },
    [playPath, showToast, stopAvEngine, tracePlaybackFocus],
  );

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

      // The text workspace handles its own shortcuts (save, find, zoom, ...).
      if (isText && (textEntry || textShortcutFor(event))) {
        return;
      }

      if (textEntry) {
        return;
      }

      if (input && input.type !== "range") {
        return;
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

      if (!event.ctrlKey && !event.altKey && !event.metaKey && !toolsOpen && !shelfMode) {
        const lowerKey = event.key.toLowerCase();
        if (lowerKey === "q" && canOpenShelf(mediaCapabilities, "queue")) {
          event.preventDefault();
          revealControls();
          toggleShelfMode("queue");
          return;
        }
        if (lowerKey === "i" && canOpenShelf(mediaCapabilities, "info")) {
          event.preventDefault();
          revealControls();
          toggleShelfMode("info");
          return;
        }
      }

      const command = keyboardCommand(event, settings);
      if (!command) {
        return;
      }
      const routedCommand =
        typeof command === "object" && command.type === "frameStep"
          ? { ...command, seconds: frameStepSeconds }
          : command;

      event.preventDefault();
      revealControls();
      if (routedCommand === "open") {
        void openFile();
      } else if (routedCommand === "fullscreen") {
        void send("fullscreen");
      } else if (routedCommand === "mark") {
        if (supportsMoments) {
          addCurrentMoment();
        }
      } else if (routedCommand === "loop") {
        if (supportsLoopPoints) {
          setLoopPoint();
        }
      } else if (routedCommand === "clearLoop") {
        if (supportsLoopPoints) {
          clearLoop();
        }
      } else if (routedCommand === "captions") {
        if (isVideo) {
          toggleSubtitles();
        }
      } else if (isStaticViewer && supportsQueue && routedCommand.type === "seekBy") {
        if (routedCommand.seconds < 0) {
          void playPreviousQueueItem();
        } else {
          void playNextQueueItem();
        }
      } else if (isStaticViewer && routedCommand.type === "togglePause") {
        return;
      } else {
        void runCommand(routedCommand);
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
    frameStepSeconds,
    openFile,
    isDocument,
    isPdfDocument,
    isImage,
    isVideo,
    isText,
    isStaticViewer,
    mediaCapabilities,
    playNextQueueItem,
    playPreviousQueueItem,
    printCurrentDocument,
    revealControls,
    resetDocumentView,
    resetImageView,
    rotateImage,
    runCommand,
    send,
    selectDocumentPage,
    setDocumentZoom,
    setLoopPoint,
    settings,
    stepDocumentPage,
    supportsLoopPoints,
    supportsMoments,
    supportsQueue,
    toggleImageActualSize,
    toggleSubtitles,
    toggleShelfMode,
    toolsOpen,
    shelfMode,
    zoomImage,
  ]);

  const seekTo = (value: number) => {
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
    const textDoc = textController.doc;
    const textLocked = Boolean(textDoc?.locked);
    contextMenuSections.push({
      id: "text-edit",
      actions: [
        {
          id: "text-cut",
          disabled: textLocked,
          icon: "text",
          label: "Cut",
          hint: "Ctrl+X",
          onSelect: () => textWorkspaceRef.current?.cut(),
        },
        {
          id: "text-copy",
          icon: "file",
          label: "Copy",
          hint: "Ctrl+C",
          onSelect: () => textWorkspaceRef.current?.copy(),
        },
        {
          id: "text-paste",
          disabled: textLocked,
          icon: "check",
          label: "Paste",
          hint: "Ctrl+V",
          onSelect: () => textWorkspaceRef.current?.paste(),
        },
        {
          id: "text-comment",
          disabled: textLocked,
          icon: "line",
          label: "Toggle comment",
          hint: "Ctrl+/",
          onSelect: () => textWorkspaceRef.current?.runCommand("toggleComment"),
        },
      ],
    });
    contextMenuSections.push({
      id: "text",
      actions: [
        {
          id: "find-text",
          icon: "search",
          label: "Find",
          hint: "Ctrl+F",
          onSelect: () => textWorkspaceRef.current?.openFind(),
        },
        {
          id: "go-to-line",
          icon: "line",
          label: "Go to line",
          hint: "Ctrl+G",
          onSelect: () => textWorkspaceRef.current?.openGoToLine(),
        },
        {
          id: "save-text",
          disabled: !textDoc || textDoc.loading,
          icon: "save",
          label: textDoc?.sourceType === "file" ? "Save" : "Save As",
          hint: "Ctrl+S",
          onSelect: () => void textController.save(),
        },
        {
          id: "save-text-as",
          disabled: !textDoc || textDoc.loading,
          icon: "saveAs",
          label: "Save As",
          onSelect: () => void textController.saveAs(),
        },
        {
          id: "revert-text",
          disabled: !textController.dirty,
          icon: "undo",
          label: "Revert",
          onSelect: () => void textController.revert(),
        },
        {
          id: "toggle-wrap",
          icon: "file",
          label: "Word wrap",
          hint: settings.textWordWrap ? "On" : "Off",
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
          disabled: !settings.rememberRecentMedia || !canOpenShelf(mediaCapabilities, "recent"),
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

  const videoQueueOverlayOpen =
    isVideo && !miniPlayerActive && shelfMode === "queue" && canOpenShelf(mediaCapabilities, "queue");
  const mediaShelvesMode = videoQueueOverlayOpen ? null : shelfMode;

  return (
    <main
      className={`app-shell ${hasMedia ? "with-media" : "without-media"}`}
      onContextMenu={openContextMenu}
    >
      <WindowChrome
        title={hasMedia ? (isText && textController.dirty ? `\u25cf ${currentTitle}` : currentTitle) : "LMP"}
        canMiniPlayer={supportsMiniPlayer}
        canGoHome={hasMedia}
        miniPlayer={miniPlayerActive}
        onGoHome={() => void openHome()}
        onPointerActivity={registerPlayerPointerActivity}
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
              drafts={textDrafts}
              onDiscardDraft={(id) => void discardTextDraft(id)}
              onRestoreDraft={(id) => void restoreTextDraft(id)}
              onNewText={() => void createNewTextDraft()}
              onOpen={(target) => void openHomeFiles(target)}
              onOpenGeneric={() => void openFile()}
              onOpenSettings={openHomeSettings}
              onPlayRecent={(path) => void playQueue([path])}
              recent={recent}
              showRecentFiles={settings.rememberRecentMedia}
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
            <TextWorkspace
              activeShelf={shelfMode}
              controller={textController}
              isFullscreen={isFullscreen}
              recentTextFiles={recentTextFiles}
              settings={settings}
              workspaceRef={textWorkspaceRef}
              onGoHome={() => void openHome()}
              onNew={(languageId) => void createNewTextDraft(languageId ?? null)}
              onOpen={() => void openFile()}
              onOpenLibrary={() => void loadLibraryFolder()}
              onOpenRecent={(path) => void playQueue([path])}
              onPatchSettings={patchSettings}
              onShowInExplorer={(path) =>
                void invoke("show_path_in_explorer", { path }).catch((error) => showToast(compactError(error), "error"))
              }
              onToggleFullscreen={() => void send("fullscreen")}
              onToggleShelf={(shelf) => toggleShelfMode(shelf)}
              showToast={showToast}
            />
          ) : null}

          {!isStaticViewer ? (
            <canvas
              ref={av.attachCanvas}
              className={`media-surface av-surface ${isAudio ? "audio-only" : ""} ${
                avActiveForCurrent ? "" : "is-standby"
              }`}
              aria-hidden={!avActiveForCurrent}
            />
          ) : null}

          {!isStaticViewer ? (
            <video
              ref={mediaRef}
              className={`media-surface ${isAudio ? "audio-only" : ""} ${
                avActiveForCurrent ? "is-standby" : ""
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
                  revealPlaybackWindow();
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

          {isVideo && avActiveForCurrent && subtitlesEnabled ? (
            <SubtitleOverlay text={av.subtitleText} />
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
            subtitleAvailable={Boolean(subtitleTrack) || avEmbeddedSubtitleActive}
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
        {videoQueueOverlayOpen ? (
          <section className="video-queue-overlay media-shelf queue-shelf" aria-label="Media queue">
            <QueueShelf
              currentPath={currentPath}
              onAddFilesToQueue={() => void addFilesToQueue()}
              onClearQueue={clearCurrentQueue}
              onClose={closeShelf}
              onMoveQueueItem={moveQueuedItem}
              onPlayQueueIndex={(index) => void playQueueIndex(index)}
              onRemoveQueueItem={removeQueuedItem}
              queue={queue}
              queueCount={queueCount}
              queueIndex={queueIndex}
            />
          </section>
        ) : null}
        {shelfMode === "settings" ? (
          <SettingsPanel
            activeEngineLabel={activeEngineLabel}
            activeTab={activeSettingsTab}
            cacheStatus={cacheStatus}
            currentPath={currentPath}
            isAudio={isAudio}
            isDocument={isDocument}
            isImage={isImage}
            isStaticViewer={isStaticViewer}
            isText={isText}
            lmpAvAvailable={av.available}
            onClearMediaProbeCache={() => void clearMediaProbeCache()}
            onClearPreparedVideoCache={() => void clearPreparedVideoCache()}
            onClearPreviewCache={() => void clearPreviewCache()}
            onClose={closeShelf}
            onPatchSettings={patchSettings}
            onPinControls={setControlsPinned}
            onReset={resetSettings}
            onSetPlayerSpeed={setPlayerSpeed}
            onTabChange={setSettingsTab}
            onUpdateInstallLockChange={setUpdateInstallLocked}
            playbackBackends={playbackBackends}
            playbackPathLabel={playbackEngineLabel}
            settings={settings}
            speed={speed}
            tabs={activeSettingsTabs}
            updateInstallLocked={updateInstallLocked}
          />
        ) : null}
      </section>

      <MediaShelves
        activeAudioTrackId={activeAudioTrackId}
        activeSubtitleTrackId={activeSubtitleTrackId}
        audioTracks={audioTrackChoices}
        backendHint={backendHint}
        capabilities={mediaCapabilities}
        currentPath={currentPath}
        dataInspectionItems={dataInspectionItems}
        documentPageCount={documentPageCount}
        documentView={documentView}
        engineLabel={activeEngineLabel}
        hasMedia={hasMedia}
        libraryFilter={libraryFilter}
        libraryFolder={libraryFolder}
        libraryFolderLabel={libraryFolderLabel}
        libraryLoading={libraryLoading}
        librarySearch={librarySearch}
        librarySort={librarySort}
        mediaInspection={isText ? textInspection : mediaInspection}
        mediaInspectionLoading={isText ? false : mediaInspectionLoading}
        moments={moments}
        onAddFilesToQueue={() => void addFilesToQueue()}
        onCancelTrimExport={cancelTrimExport}
        onChooseLibraryFolder={() => void chooseLibraryFolder()}
        onClearQueue={clearCurrentQueue}
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
        onMoveQueueItem={moveQueuedItem}
        onPlayQueueIndex={(index) => void playQueueIndex(index)}
        onPlayRecent={(path) => void playQueue([path])}
        onPreviewTrimRange={previewTrimRange}
        onRefreshInspection={() =>
          isText
            ? setTextInspectionTick((tick) => tick + 1)
            : currentPath && void inspectMedia(currentPath, loadIdRef.current)
        }
        onRemoveQueueItem={removeQueuedItem}
        onSelectAudioTrack={selectAudioTrack}
        onSelectDocumentPage={selectDocumentPage}
        onSelectSubtitleTrack={selectSubtitleTrack}
        onSetTrimEndFromCurrent={setTrimEndFromCurrent}
        onSetTrimPreset={setTrimPreset}
        onSetTrimStartFromCurrent={setTrimStartFromCurrent}
        onShowTrimResult={showTrimResult}
        onToggleSubtitles={toggleSubtitles}
        overviewInspectionItems={isText ? textInspection?.summary ?? [] : overviewInspectionItems}
        pdfDocument={pdfDocument}
        queue={queue}
        queueCount={queueCount}
        queueIndex={queueIndex}
        recent={recent}
        shelfMode={mediaShelvesMode}
        streamInspectionItems={isText ? [] : streamInspectionItems}
        subtitleTrackLabel={subtitleTrack?.label ?? null}
        subtitleTracks={subtitleTrackChoices}
        subtitlesEnabled={subtitlesEnabled}
        tracksSwitchable={avActiveForCurrent}
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

      {dropActive ? (
        <div className="drop-overlay" aria-hidden="true">
          <span>Drop to open in LMP</span>
        </div>
      ) : null}

      {contextMenu ? (
        <ContextMenu
          onClose={closeContextMenu}
          sections={contextMenuSections}
          x={contextMenu.x}
          y={contextMenu.y}
        />
      ) : null}

      <AppFeedback
        choiceDialog={choiceDialog}
        settleChoiceDialog={settleChoiceDialog}
        confirmDialog={confirmDialog}
        promptDialog={promptDialog}
        promptInput={promptInput}
        setPromptInput={setPromptInput}
        settleConfirmDialog={settleConfirmDialog}
        settlePromptDialog={settlePromptDialog}
        toast={toast}
      />
    </main>
  );
}

export default App;
