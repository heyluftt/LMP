import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { visiblePreparationDelayMs } from "./appConstants";
import type {
  LoopRange,
  MediaDetails,
  OpeningMediaState,
  RemuxFallbackState,
  StartupResumeState,
  ToastTone,
  TrimExportState,
  TrimRange,
} from "./appTypes";
import { compactError } from "../lib/errorText";
import {
  extension as mediaExtension,
  knownMediaKind,
  mediaKind,
  rememberContentKind,
  type MediaKind,
} from "../lib/playerBrain";
import { getResume, readMoments, readRecent, rememberMedia } from "../player/memory";
import {
  canUseDirectAfterPrepFailure,
  resolvePlaybackStartupPlan,
} from "../player/playbackEnginePolicy";
import {
  transitionAllowsWindowFocus,
  transitionAllowsWindowReveal,
  type PlaybackTransitionKind,
  type PlayPathOptions,
} from "../player/queue";
import type { PendingSeekState } from "../player/playbackSmoothing";
import type { ResumeController } from "../player/resumeController";
import type { PlayerSettings } from "../player/settings";
import type { MediaFile, MediaInspection, Moment, SubtitleFile } from "../player/types";
import type { MediaShelfMode } from "../ui/MediaShelves";
import { defaultDocumentView, type DocumentViewState } from "../viewers/pdf";
import {
  isWordDocumentExtension,
  type WordDocumentContent,
} from "../viewers/word";

type SetState<T> = Dispatch<SetStateAction<T>>;

type ShowToast = (message: string, tone?: ToastTone) => void;
type OpenTextMedia = (media: MediaFile, isCurrent: () => boolean) => Promise<void>;

type PlaybackStartPipelineOptions = {
  abortNativeMediaLoad: () => void;
  activePlaybackPathRef: MutableRefObject<string | null>;
  applyWindowProfile: (kind: MediaKind) => void | Promise<void>;
  avBypassPathRef: MutableRefObject<string | null>;
  cancelVideoWindowAspectRetry: () => void;
  clearSubtitleTrack: () => void;
  commitPlaybackPosition: (seconds: number, force?: boolean) => void;
  confirmTextNavigation: (nextPath: string) => Promise<boolean>;
  documentDragRef: MutableRefObject<unknown | null>;
  documentZoomAnchorRef: MutableRefObject<unknown | null>;
  inspectMedia: (path: string, loadId: number) => void | Promise<void>;
  lmpAvAvailable: boolean;
  loadIdRef: MutableRefObject<number>;
  loadSubtitleFile: (file: SubtitleFile, automatic?: boolean) => void;
  openTextFile: OpenTextMedia;
  openWordExtract: OpenTextMedia;
  mediaReadyRevealSuppressRef: MutableRefObject<{
    loadId: number;
    reason: string;
    until: number;
  } | null>;
  pendingSeekRef: MutableRefObject<PendingSeekState | null>;
  recentOpenRequestRef: MutableRefObject<{ path: string; at: number } | null>;
  remuxFallbackRef: MutableRefObject<RemuxFallbackState | null>;
  resetImageView: () => void;
  resetTextSession: () => void;
  resumeController: ResumeController;
  revealCurrentWindow: (focus?: boolean) => void;
  revealCurrentWindowAfterRender: (focus?: boolean) => void;
  scheduleDeferredMediaDetails: (path: string, kind: MediaKind, loadId: number) => void;
  scheduleWindowRevealFallback: (
    path: string,
    loadId: number,
    delayMs: number,
    focusWindow: boolean,
  ) => void;
  setAudioArtworkUrl: SetState<string | null>;
  setCurrentMedia: SetState<MediaFile | null>;
  setCurrentPath: SetState<string | null>;
  setDocumentError: SetState<string | null>;
  setDocumentLoading: SetState<boolean>;
  setDocumentPageCount: SetState<number>;
  setDocumentView: SetState<DocumentViewState>;
  setDuration: SetState<number>;
  setIsDocumentDragging: SetState<boolean>;
  setLoopRange: SetState<LoopRange>;
  setMediaDetails: SetState<MediaDetails>;
  setMediaInspection: SetState<MediaInspection | null>;
  setMediaInspectionLoading: SetState<boolean>;
  setMoments: SetState<Moment[]>;
  setOpeningMedia: SetState<OpeningMediaState | null>;
  setPaused: SetState<boolean>;
  setPdfDocument: (document: null) => void;
  setRecent: SetState<string[]>;
  setShelfMode: SetState<MediaShelfMode>;
  setSourceUrl: SetState<string | null>;
  setToolsOpen: SetState<boolean>;
  setTrimError: SetState<string | null>;
  setTrimExport: SetState<TrimExportState | null>;
  setTrimRange: SetState<TrimRange>;
  setWordDocument: (document: WordDocumentContent | null) => void;
  settings: PlayerSettings;
  showToast: ShowToast;
  startLmpAv: (
    path: string,
    loadId: number,
    startSeconds: number | null,
    focusWindow: boolean,
    revealWindow: boolean,
  ) => Promise<unknown>;
  startupResumeRef: MutableRefObject<StartupResumeState | null>;
  stopLmpAv: () => Promise<void>;
  trimPreviewEndRef: MutableRefObject<number | null>;
  videoWindowAspectTokenRef: MutableRefObject<string | null>;
  windowRevealAllowedRef: MutableRefObject<boolean>;
  windowRevealFocusRef: MutableRefObject<boolean>;
  windowRevealTimerRef: MutableRefObject<number | null>;
};

export function usePlaybackStartPipeline({
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
  lmpAvAvailable,
  loadIdRef,
  loadSubtitleFile,
  mediaReadyRevealSuppressRef,
  openTextFile,
  openWordExtract,
  pendingSeekRef,
  recentOpenRequestRef,
  remuxFallbackRef,
  resetImageView,
  resetTextSession,
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
  startLmpAv,
  startupResumeRef,
  stopLmpAv,
  trimPreviewEndRef,
  videoWindowAspectTokenRef,
  windowRevealAllowedRef,
  windowRevealFocusRef,
  windowRevealTimerRef,
}: PlaybackStartPipelineOptions) {
  return useCallback(
    async (path: string, options: PlayPathOptions = {}) => {
      const transition: PlaybackTransitionKind =
        options.transition ?? (options.focusWindow === false ? "internal-queue" : "user-open");
      const shouldRevealWindow =
        options.revealWindow ??
        (options.focusWindow !== undefined
          ? options.focusWindow
          : transitionAllowsWindowReveal(transition));
      const shouldFocusWindow =
        options.focusWindow ?? (shouldRevealWindow && transitionAllowsWindowFocus(transition));
      windowRevealAllowedRef.current = shouldRevealWindow;
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
        if (shouldRevealWindow) {
          revealCurrentWindow(shouldFocusWindow);
        }
        return;
      }
      recentOpenRequestRef.current = { path, at: now };
      if (avBypassPathRef.current && avBypassPathRef.current !== path) {
        avBypassPathRef.current = null;
      }

      const loadId = loadIdRef.current + 1;
      loadIdRef.current = loadId;
      // An unchecked `.ts` may be TypeScript; its opening state waits for prepare_media.
      const optimisticKind = knownMediaKind(path) ?? "unknown";
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
      void stopLmpAv();
      abortNativeMediaLoad();
      setSourceUrl(null);
      setCurrentMedia(null);
      if (optimisticKind === "audio" || optimisticKind === "video") {
        activePlaybackPathRef.current = path;
        setCurrentPath(path);
        setOpeningMedia({ kind: optimisticKind, path, phase: "opening", loadId });
        if (shouldRevealWindow) {
          revealCurrentWindowAfterRender(shouldFocusWindow);
        }
      } else {
        setOpeningMedia(null);
      }
      setMediaInspection(null);
      setMediaInspectionLoading(false);
      setAudioArtworkUrl(null);
      setPdfDocument(null);
      setWordDocument(null);
      setDocumentPageCount(0);
      setDocumentLoading(false);
      setDocumentError(null);
      documentDragRef.current = null;
      documentZoomAnchorRef.current = null;
      setIsDocumentDragging(false);
      resetTextSession();
      setPaused(true);
      setMediaDetails({ width: null, height: null, duration: null });
      try {
        const media = await invoke<MediaFile>("prepare_media", { path });
        if (loadId !== loadIdRef.current) {
          return;
        }

        rememberContentKind(media.path, media.kind);
        const kind = mediaKind(media.path);
        const opensAsExtractedWord = isWordDocumentExtension(mediaExtension(media.path));
        const viewKind: MediaKind = opensAsExtractedWord ? "text" : kind;
        if (kind === "unknown") {
          setOpeningMedia(null);
          if (shouldRevealWindow) {
            revealCurrentWindow(shouldFocusWindow);
          }
          showToast("This file type is not supported by LMP yet.", "error");
          return;
        }
        if (kind !== optimisticKind) {
          // Only `.ts`/`.mts` files get here: the content decided their kind.
          const playable = kind === "audio" || kind === "video";
          setOpeningMedia(playable ? { kind, path: media.path, phase: "opening", loadId } : null);
          if (playable && shouldRevealWindow) {
            revealCurrentWindowAfterRender(shouldFocusWindow);
          }
        }

        const staticKind = kind === "image" || kind === "document" || kind === "text";
        let playablePath = media.path;
        const avAllowed = lmpAvAvailable && avBypassPathRef.current !== media.path;
        const playbackPlan = resolvePlaybackStartupPlan(
          media.path,
          kind,
          settings.playbackEngine,
          avAllowed,
        );
        const needsNativePrep = playbackPlan.prepareForNative;
        const startupResume =
          !staticKind && options.resumeAt !== undefined && options.resumeAt > 0.5
            ? { position: options.resumeAt, duration: 0 }
            : !staticKind && kind === "video" && settings.resumePlayback
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
        if (startupResume && startupResume.position > 0.5) {
          startupResumeRef.current = {
            path: media.path,
            target: startupResume.position,
            loadId,
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
        // Keep the settings panel open when the file is re-opened because the
        // engine choice changed; otherwise close shelves for the new file.
        setShelfMode((current) =>
          current === "settings" && transition === "internal-queue" ? current : null,
        );
        remuxFallbackRef.current = null;
        resumeController.beginLoad(media.path, loadId);
        clearSubtitleTrack();
        setMoments(staticKind ? [] : readMoments(media.path));
        setRecent(settings.rememberRecentMedia ? rememberMedia(media.path) : readRecent());

        if (staticKind) {
          if (loadId !== loadIdRef.current || activePlaybackPathRef.current !== media.path) {
            return;
          }
          const isCurrentLoad = () =>
            loadId === loadIdRef.current && activePlaybackPathRef.current === media.path;
          if (opensAsExtractedWord) {
            setSourceUrl(convertFileSrc(media.path));
            if (shouldRevealWindow) {
              revealCurrentWindow(shouldFocusWindow);
            }
            await openWordExtract(media, isCurrentLoad);
            return;
          }
          if (kind === "document") {
            setSourceUrl(convertFileSrc(media.path));
            if (shouldRevealWindow) {
              revealCurrentWindow(shouldFocusWindow);
            }
            return;
          }
          if (kind === "text") {
            setSourceUrl(convertFileSrc(media.path));
            if (shouldRevealWindow) {
              revealCurrentWindow(shouldFocusWindow);
            }
            await openTextFile(media, isCurrentLoad);
            return;
          }
          setSourceUrl(convertFileSrc(media.path));
          if (shouldRevealWindow) {
            revealCurrentWindow(shouldFocusWindow);
          }
          return;
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

        if (playbackPlan.engine === "lmp-av") {
          try {
            setOpeningMedia((current) =>
              current?.loadId === loadId
                ? { ...current, phase: startupResume ? "resuming" : "opening" }
                : current,
            );
            await startLmpAv(
              media.path,
              loadId,
              startupResume && startupResume.position > 0.5 ? startupResume.position : null,
              shouldFocusWindow,
              shouldRevealWindow,
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
            if (!playbackPlan.nativeFallback) {
              setOpeningMedia(null);
              if (shouldRevealWindow) {
                revealCurrentWindow(shouldFocusWindow);
              }
              showToast(`LMP AV could not play this file: ${compactError(error)}`, "error");
              return;
            }
            showToast(
              `LMP AV could not open this file (${compactError(error)}). Using native playback instead.`,
              "info",
            );
          }
        }

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
              if (shouldRevealWindow) {
                revealCurrentWindow(shouldFocusWindow);
              }
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
        if (shouldRevealWindow) {
          scheduleWindowRevealFallback(media.path, loadId, kind === "audio" ? 900 : 1400, shouldFocusWindow);
        }
      } catch (error) {
        if (loadId !== loadIdRef.current) {
          return;
        }
        setOpeningMedia(null);
        if (shouldRevealWindow) {
          revealCurrentWindow(shouldFocusWindow);
        }
        showToast(compactError(error), "error");
      }
    },
    [
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
      lmpAvAvailable,
      loadIdRef,
      loadSubtitleFile,
      mediaReadyRevealSuppressRef,
      openTextFile,
      openWordExtract,
      pendingSeekRef,
      recentOpenRequestRef,
      remuxFallbackRef,
      resetImageView,
      resetTextSession,
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
      settings.playbackEngine,
      settings.rememberRecentMedia,
      settings.resumePlayback,
      showToast,
      startLmpAv,
      startupResumeRef,
      stopLmpAv,
      trimPreviewEndRef,
      videoWindowAspectTokenRef,
      windowRevealAllowedRef,
      windowRevealFocusRef,
      windowRevealTimerRef,
    ],
  );
}
