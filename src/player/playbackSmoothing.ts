import type { PlayerCommand } from "./types";

export type PendingSeekState = {
  target: number;
  until: number;
};

const defaultOptimisticHoldMs = 1200;
const settleToleranceSeconds = 0.35;

export function clampMediaTime(seconds: number, duration: number) {
  if (!Number.isFinite(seconds)) {
    return 0;
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    return Math.max(0, seconds);
  }
  return Math.max(0, Math.min(duration, seconds));
}

export function commandSeekTarget(
  command: PlayerCommand,
  currentTime: number,
  duration: number,
) {
  if (command.type === "seekBy") {
    return clampMediaTime(currentTime + command.seconds, duration);
  }
  if (command.type === "seekTo") {
    return clampMediaTime(command.seconds, duration);
  }
  if (command.type === "frameStep") {
    return clampMediaTime(currentTime + command.direction / 30, duration);
  }
  if (command.type === "stop") {
    return 0;
  }
  return null;
}

export function createPendingSeek(
  target: number,
  duration: number,
  holdMs = defaultOptimisticHoldMs,
): PendingSeekState {
  return {
    target: clampMediaTime(target, duration),
    until: performance.now() + holdMs,
  };
}

export function shouldKeepOptimisticSeek(
  pending: PendingSeekState | null,
  actualPosition: number,
  mediaSeeking: boolean,
) {
  if (!pending) {
    return false;
  }
  if (performance.now() > pending.until) {
    return false;
  }
  return mediaSeeking || Math.abs(actualPosition - pending.target) > settleToleranceSeconds;
}
