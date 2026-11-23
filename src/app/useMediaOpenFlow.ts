import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  startupFileRetryCount,
  startupFileRetryDelayMs,
} from "./appConstants";
import type { MediaOpenRequest, ToastTone } from "./appTypes";
import { resolveContentKinds } from "./useContentKinds";
import { mediaKind, type MediaKind } from "../lib/playerBrain";
import {
  homeOpenTargetLabel,
  pathMatchesHomeTarget,
  type HomeOpenTarget,
} from "../ui/HomeScreen";
import {
  uniquePaths,
  uniquePlayablePaths,
  type PlayQueueOptions,
} from "../player/queue";

type PlayQueue = (paths: string[], startIndex?: number, options?: PlayQueueOptions) => Promise<void>;
type ShowToast = (message: string, tone?: ToastTone) => void;

type UseMediaOpenFlowOptions = {
  audioMultiWindow: boolean;
  currentKind: MediaKind;
  hasMedia: boolean;
  playQueue: PlayQueue;
  revealCurrentWindow: (focus?: boolean) => void;
  setStartupFilesSettled: (settled: boolean) => void;
  showToast: ShowToast;
  windowLabel: string;
};

export function useMediaOpenFlow({
  audioMultiWindow,
  currentKind,
  hasMedia,
  playQueue,
  revealCurrentWindow,
  setStartupFilesSettled,
  showToast,
  windowLabel,
}: UseMediaOpenFlowOptions) {
  const startupFileAttemptRef = useRef(0);
  const [dropActive, setDropActive] = useState(false);

  const shouldOpenPickedFilesInCurrentWindow = useCallback(
    (paths: string[]) => {
      const kinds = paths
        .map((path) => mediaKind(path))
        .filter((kind) => kind !== "unknown");
      if (!hasMedia || currentKind === "unknown" || kinds.length === 0) {
        return true;
      }

      const staticOnly = kinds.every(
        (kind) => kind === "text" || kind === "document" || kind === "image",
      );
      if (staticOnly) {
        return true;
      }

      const audioOnly = kinds.every((kind) => kind === "audio");
      return currentKind === "audio" && audioOnly && !audioMultiWindow;
    },
    [audioMultiWindow, currentKind, hasMedia],
  );

  const handleIncomingOpenRequest = useCallback(
    async (paths: string[]) => {
      const playablePaths = uniquePlayablePaths(paths);
      if (playablePaths.length === 0) {
        return;
      }

      await playQueue(playablePaths, 0, { transition: "open-with" });
    },
    [playQueue],
  );

  /** Opens picked or dropped files; several text files each get a window of their own. */
  const openPickedPaths = useCallback(
    async (playablePaths: string[]) => {
      await resolveContentKinds(playablePaths);
      const separateTextWindows =
        playablePaths.length > 1 && playablePaths.every((path) => mediaKind(path) === "text");
      if (separateTextWindows) {
        const [first, ...others] = playablePaths;
        if (shouldOpenPickedFilesInCurrentWindow([first])) {
          await playQueue([first]);
          await invoke("open_files_in_separate_windows", { files: others });
        } else {
          await invoke("open_files_in_separate_windows", { files: playablePaths });
        }
        return;
      }
      if (shouldOpenPickedFilesInCurrentWindow(playablePaths)) {
        await playQueue(playablePaths);
        return;
      }
      await invoke("open_files_in_window", { files: playablePaths });
    },
    [playQueue, shouldOpenPickedFilesInCurrentWindow],
  );

  const openHomeFiles = useCallback(
    async (target: HomeOpenTarget) => {
      try {
        const paths = await invoke<string[]>("open_filtered_files_dialog", { kind: target });
        await resolveContentKinds(paths);
        const playablePaths = uniquePaths(paths).filter((path) => pathMatchesHomeTarget(path, target));
        if (playablePaths.length === 0) {
          if (paths.length > 0) {
            showToast(`No ${homeOpenTargetLabel(target)} selected.`, "info");
          }
          return;
        }
        await openPickedPaths(playablePaths);
      } catch (error) {
        showToast(String(error), "error");
      }
    },
    [openPickedPaths, showToast],
  );

  const openFile = useCallback(async () => {
    try {
      const paths = await invoke<string[]>("open_files_dialog");
      const playablePaths = uniquePlayablePaths(paths);
      if (playablePaths.length === 0) {
        return;
      }
      await openPickedPaths(playablePaths);
    } catch (error) {
      showToast(String(error), "error");
    }
  }, [openPickedPaths, showToast]);

  // Files dropped onto the window open like files picked in the dialog.
  useEffect(() => {
    let disposed = false;
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (disposed) {
        return;
      }
      const payload = event.payload;
      if (payload.type === "enter") {
        setDropActive(uniquePlayablePaths(payload.paths).length > 0);
        return;
      }
      if (payload.type === "leave") {
        setDropActive(false);
        return;
      }
      if (payload.type !== "drop") {
        return;
      }
      setDropActive(false);
      const playablePaths = uniquePlayablePaths(payload.paths);
      if (playablePaths.length === 0) {
        if (payload.paths.length > 0) {
          showToast("LMP cannot open this file type.", "info");
        }
        return;
      }
      void openPickedPaths(playablePaths).catch((error) => showToast(String(error), "error"));
    });
    return () => {
      disposed = true;
      void unlisten.then((dispose) => dispose());
    };
  }, [openPickedPaths, showToast]);

  useEffect(() => {
    let disposed = false;
    let retryTimer: number | null = null;
    startupFileAttemptRef.current = 0;

    const finishStartup = () => {
      if (!disposed) {
        setStartupFilesSettled(true);
      }
    };

    const loadStartupFiles = () => {
      startupFileAttemptRef.current += 1;
      const attempt = startupFileAttemptRef.current;
      invoke<string[]>("take_startup_files")
        .then((paths) => {
          if (disposed) {
            return;
          }
          if (paths.length > 0) {
            void playQueue(paths, 0, { transition: "open-with" }).finally(() => {
              finishStartup();
            });
            return;
          }
          if (windowLabel !== "main" && attempt < startupFileRetryCount) {
            retryTimer = window.setTimeout(loadStartupFiles, startupFileRetryDelayMs);
            return;
          }
          finishStartup();
        })
        .catch(() => {
          if (!disposed && windowLabel !== "main" && attempt < startupFileRetryCount) {
            retryTimer = window.setTimeout(loadStartupFiles, startupFileRetryDelayMs);
            return;
          }
          if (!disposed) {
            setStartupFilesSettled(true);
            revealCurrentWindow();
          }
        });
    };

    loadStartupFiles();

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
        if (disposed) {
          return;
        }
        if (windowLabel === "main") {
          setStartupFilesSettled(true);
        }
        return;
      }

      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      setStartupFilesSettled(true);
      void handleIncomingOpenRequest(files);
    });

    return () => {
      disposed = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      void unlisten.then((dispose) => dispose());
    };
  }, [
    handleIncomingOpenRequest,
    playQueue,
    revealCurrentWindow,
    setStartupFilesSettled,
    windowLabel,
  ]);

  return {
    dropActive,
    openFile,
    openHomeFiles,
  };
}
