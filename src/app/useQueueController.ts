import { invoke } from "@tauri-apps/api/core";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mediaKind } from "../lib/playerBrain";
import { resolveContentKinds } from "./useContentKinds";
import {
  appendUniquePaths,
  clearQueueKeepingCurrent,
  createQueueRequest,
  moveQueueItem,
  queueIndexOfPath,
  queuePathEquals,
  queuePosition,
  removeQueueItem,
  uniquePaths,
  uniquePlayablePaths,
  type PlaybackTransitionKind,
  type PlayPathOptions,
  type PlayQueueOptions,
} from "../player/queue";
import type { MediaShelfMode } from "../ui/MediaShelves";
import type { QueueSource, ToastTone } from "./appTypes";

type ConfirmTextNavigation = (path: string) => Promise<boolean>;
type PlayPath = (path: string, options?: PlayPathOptions) => Promise<void>;
type ShowToast = (message: string, tone?: ToastTone) => void;

type UseQueueControllerOptions = {
  activePlaybackPathRef: MutableRefObject<string | null>;
  autoQueueFolder: boolean;
  confirmTextNavigation: ConfirmTextNavigation;
  currentPath: string | null;
  playPath: PlayPath;
  setShelfMode: Dispatch<SetStateAction<MediaShelfMode>>;
  shelfMode: MediaShelfMode;
  showToast: ShowToast;
  supportsQueue: boolean;
};

export function useQueueController({
  activePlaybackPathRef,
  autoQueueFolder,
  confirmTextNavigation,
  currentPath,
  playPath,
  setShelfMode,
  shelfMode,
  showToast,
  supportsQueue,
}: UseQueueControllerOptions) {
  const [queue, setQueue] = useState<string[]>([]);
  const queueSourceRef = useRef<QueueSource>("single");
  const queueState = useMemo(() => queuePosition(queue, currentPath), [currentPath, queue]);

  const applyFolderQueueForPath = useCallback(
    async (path: string) => {
      if (mediaKind(path) === "text") {
        return false;
      }

      const siblings = await invoke<string[]>("list_sibling_media", { mediaPath: path });
      const siblingQueue = uniquePlayablePaths(siblings);
      const siblingIndex = queueIndexOfPath(siblingQueue, path);
      const activePath = activePlaybackPathRef.current;
      if (
        siblingQueue.length <= 1 ||
        siblingIndex < 0 ||
        (activePath && !queuePathEquals(activePath, path))
      ) {
        return false;
      }

      queueSourceRef.current = "auto-folder";
      setQueue(siblingQueue);
      return true;
    },
    [activePlaybackPathRef],
  );

  const playQueue = useCallback(
    async (paths: string[], startIndex = 0, options: PlayQueueOptions = {}) => {
      // Text files never get a queue, so `.ts` files must be checked first.
      await resolveContentKinds(paths);
      const request = createQueueRequest(paths, startIndex);
      if (!request) {
        return;
      }

      if (!(await confirmTextNavigation(request.focusedPath))) {
        return;
      }

      queueSourceRef.current = request.queue.length > 1 ? "manual" : "single";
      setQueue(request.queue);
      const playbackTask = playPath(request.focusedPath, {
        skipTextGuard: true,
        transition: options.transition ?? "user-open",
      });

      if (autoQueueFolder && request.queue.length === 1) {
        void applyFolderQueueForPath(request.focusedPath).catch(() => undefined);
      }

      await playbackTask;
    },
    [applyFolderQueueForPath, autoQueueFolder, confirmTextNavigation, playPath],
  );

  const appendToQueue = useCallback(
    async (paths: string[], playFirstNew = false) => {
      const additions = uniquePaths(paths);
      if (additions.length === 0) {
        return;
      }

      queueSourceRef.current = "manual";
      setQueue((current) => appendUniquePaths(current, additions));

      if (!currentPath || playFirstNew) {
        await playPath(additions[0], { transition: "user-open" });
      } else {
        showToast(`${additions.length} item${additions.length === 1 ? "" : "s"} added to queue.`, "success");
      }
    },
    [currentPath, playPath, showToast],
  );

  const resetQueue = useCallback(() => {
    queueSourceRef.current = "single";
    setQueue([]);
  }, []);

  const clearCurrentQueue = useCallback(() => {
    queueSourceRef.current = "single";
    setQueue(clearQueueKeepingCurrent(currentPath));
    showToast("Queue cleared.", "info");
  }, [currentPath, showToast]);

  const moveQueuedItem = useCallback((index: number, direction: -1 | 1) => {
    queueSourceRef.current = "manual";
    setQueue((current) => moveQueueItem(current, index, direction));
  }, []);

  const removeQueuedItem = useCallback(
    (index: number) => {
      queueSourceRef.current = "manual";
      setQueue((current) => removeQueueItem(current, index, currentPath));
    },
    [currentPath],
  );

  const playQueueIndex = useCallback(
    async (
      index: number,
      options: { focusWindow?: boolean; transition?: PlaybackTransitionKind } = {},
    ) => {
      if (index < 0 || index >= queue.length) {
        return;
      }

      await playPath(queue[index], {
        focusWindow: options.focusWindow,
        transition: options.transition ?? "internal-queue",
      });
    },
    [playPath, queue],
  );

  const playNextQueueItem = useCallback(
    async (options: { focusWindow?: boolean; transition?: PlaybackTransitionKind } = {}) => {
      if (queueState.hasNext) {
        await playQueueIndex(queueState.index + 1, {
          ...options,
          transition: options.transition ?? "internal-queue",
        });
        return;
      }

      showToast("End of queue.", "info");
    },
    [playQueueIndex, queueState.hasNext, queueState.index, showToast],
  );

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

  useEffect(() => {
    if (autoQueueFolder) {
      if (
        currentPath &&
        queueSourceRef.current !== "manual" &&
        queueSourceRef.current !== "auto-folder"
      ) {
        void applyFolderQueueForPath(currentPath).catch(() => undefined);
      }
      return;
    }

    if (queueSourceRef.current !== "auto-folder") {
      return;
    }

    queueSourceRef.current = "single";
    setQueue(clearQueueKeepingCurrent(currentPath));
    if (shelfMode === "queue") {
      setShelfMode(null);
    }
  }, [applyFolderQueueForPath, autoQueueFolder, currentPath, setShelfMode, shelfMode]);

  return {
    addFilesToQueue,
    appendToQueue,
    clearCurrentQueue,
    hasNextQueueItem: queueState.hasNext,
    hasPreviousQueueItem: queueState.hasPrevious,
    moveQueuedItem,
    playNextQueueItem,
    playQueue,
    playQueueIndex,
    queue,
    queueCount: queueState.count,
    queueIndex: queueState.index,
    removeQueuedItem,
    resetQueue,
  };
}
