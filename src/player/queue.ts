import { mediaKind } from "../lib/playerBrain";

export type PlaybackTransitionKind =
  | "user-open"
  | "open-with"
  | "internal-repeat"
  | "internal-loop"
  | "internal-autoplay"
  | "internal-queue"
  | "resume";

export type PlayPathOptions = {
  focusWindow?: boolean;
  revealWindow?: boolean;
  skipTextGuard?: boolean;
  transition?: PlaybackTransitionKind;
};

export type PlayQueueOptions = {
  transition?: PlaybackTransitionKind;
};

export type QueueRequest = {
  focusedPath: string;
  queue: string[];
  startIndex: number;
};

export type QueuePosition = {
  count: number;
  hasNext: boolean;
  hasPrevious: boolean;
  index: number;
};

function normalizeQueuePath(path: string) {
  return path.trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

export function queuePathEquals(left: string | null | undefined, right: string | null | undefined) {
  if (!left || !right) {
    return false;
  }
  return normalizeQueuePath(left) === normalizeQueuePath(right);
}

export function queueIndexOfPath(queue: string[], path: string | null | undefined) {
  if (!path) {
    return -1;
  }
  const normalizedPath = normalizeQueuePath(path);
  return queue.findIndex((item) => normalizeQueuePath(item) === normalizedPath);
}

export function uniquePaths(paths: string[]) {
  const seen = new Set<string>();
  return paths.filter((path) => {
    if (!path) {
      return false;
    }
    const normalized = normalizeQueuePath(path);
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

export function uniquePlayablePaths(paths: string[]) {
  return uniquePaths(paths).filter((path) => mediaKind(path) !== "unknown");
}

export function appendUniquePaths(queue: string[], additions: string[]) {
  return uniquePaths([...queue, ...additions]);
}

export function createQueueRequest(paths: string[], startIndex = 0): QueueRequest | null {
  let queue = uniquePaths(paths);
  if (queue.length === 0) {
    return null;
  }

  let boundedIndex = Math.max(0, Math.min(queue.length - 1, startIndex));
  const focusedPath = queue[boundedIndex] ?? queue[0];
  if (!focusedPath) {
    return null;
  }

  if (mediaKind(focusedPath) === "text") {
    queue = [focusedPath];
    boundedIndex = 0;
  }

  return {
    focusedPath,
    queue,
    startIndex: boundedIndex,
  };
}

export function queuePosition(queue: string[], currentPath: string | null): QueuePosition {
  const index = queueIndexOfPath(queue, currentPath);
  const count = queue.length;
  return {
    count,
    hasNext: index >= 0 && index < count - 1,
    hasPrevious: index > 0,
    index,
  };
}

export function clearQueueKeepingCurrent(currentPath: string | null) {
  return currentPath ? [currentPath] : [];
}

export function removeQueueItem(queue: string[], index: number, currentPath: string | null) {
  if (index < 0 || index >= queue.length || queuePathEquals(queue[index], currentPath)) {
    return queue;
  }
  return queue.filter((_, itemIndex) => itemIndex !== index);
}

export function moveQueueItem(queue: string[], index: number, direction: -1 | 1) {
  const nextIndex = index + direction;
  if (index < 0 || index >= queue.length || nextIndex < 0 || nextIndex >= queue.length) {
    return queue;
  }

  const next = [...queue];
  const [item] = next.splice(index, 1);
  if (!item) {
    return queue;
  }
  next.splice(nextIndex, 0, item);
  return next;
}

export function transitionAllowsWindowReveal(transition: PlaybackTransitionKind) {
  return transition === "user-open" || transition === "open-with";
}

export function transitionAllowsWindowFocus(transition: PlaybackTransitionKind) {
  return transition === "user-open" || transition === "open-with";
}
