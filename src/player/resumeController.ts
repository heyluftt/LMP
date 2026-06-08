import { formatClock } from "../lib/playerBrain";
import { getResume, saveResume } from "./memory";
import type { PlaybackEngine } from "./types";

type ResumeControllerOptions = {
  isEnabled: () => boolean;
  isAllowedPath: (path: string) => boolean;
  isCurrent: (path: string, loadId: number) => boolean;
  getSpeed: () => number;
  setPosition: (seconds: number) => void;
  notify: (message: string) => void;
};

type ResumeSession = {
  path: string;
  loadId: number;
  cancelledByUser: boolean;
};

const saveThrottleMs = 1500;
const initialSaveBlockMs = 2800;

export class ResumeController {
  private active: ResumeSession | null = null;
  private appliedPath: string | null = null;
  private pending = false;
  private saveBlockedUntil = 0;
  private lastSaveAt = 0;
  private timer: number | null = null;

  constructor(private options: ResumeControllerOptions) {}

  beginLoad(path: string, loadId: number) {
    this.clearTimer();
    if (!this.options.isAllowedPath(path)) {
      this.active = null;
      this.appliedPath = null;
      this.pending = false;
      this.saveBlockedUntil = 0;
      return;
    }

    this.active = { path, loadId, cancelledByUser: false };
    this.appliedPath = null;
    this.pending = false;
    this.saveBlockedUntil = Date.now() + initialSaveBlockMs;
  }

  cancelUserAction() {
    if (this.active) {
      this.active.cancelledByUser = true;
    }
    this.pending = false;
    this.clearTimer();
  }

  dispose() {
    this.clearTimer();
    this.pending = false;
    this.active = null;
  }

  maybeResume(engine: PlaybackEngine, path: string, loadId: number): boolean {
    if (
      !this.options.isEnabled() ||
      !this.options.isAllowedPath(path) ||
      !this.isActive(path, loadId) ||
      this.active?.cancelledByUser
    ) {
      return false;
    }

    if (this.pending) {
      return true;
    }

    if (this.appliedPath === path) {
      return false;
    }

    const resume = getResume(path);
    if (!resume || resume.position <= 5) {
      return false;
    }

    const initialSnapshot = engine.snapshot();
    const durationAllowsResume =
      !Number.isFinite(initialSnapshot.duration) ||
      initialSnapshot.duration <= 0 ||
      initialSnapshot.duration - resume.position > 8;
    if (!durationAllowsResume) {
      return false;
    }

    if (initialSnapshot.readyState < 1) {
      return false;
    }

    this.pending = true;
    let attempts = 0;
    const maxAttempts = 5;

    const finish = (applied: boolean, actualPosition = engine.snapshot().position) => {
      if (!this.isActive(path, loadId)) {
        return;
      }

      this.pending = false;
      this.appliedPath = path;
      this.clearTimer();

      if (applied) {
        this.options.setPosition(actualPosition);
        this.options.notify(`Resumed at ${formatClock(actualPosition)}`);
      }
    };

    const retry = () => {
      if (this.active?.cancelledByUser || attempts >= maxAttempts) {
        finish(false);
        return;
      }

      attempts += 1;
      this.timer = window.setTimeout(tryApply, Math.min(850, 180 + attempts * 120));
    };

    const resolveTarget = () => {
      const snapshot = engine.snapshot();
      if (snapshot.readyState < 1) {
        return null;
      }

      const knownDuration =
        Number.isFinite(snapshot.duration) && snapshot.duration > 0 ? snapshot.duration : resume.duration;
      const upperBound = knownDuration > 0 ? Math.max(0, knownDuration - 8) : resume.position;
      const target = Math.min(resume.position, upperBound);
      return target > 5 ? target : null;
    };

    const isStableAtTarget = (target: number) => {
      const snapshot = engine.snapshot();
      const actual = snapshot.position;
      const speedAllowance = Math.max(7, this.options.getSpeed() * 4);
      return !snapshot.seeking && actual >= target - 1.25 && actual <= target + speedAllowance;
    };

    const verifyStable = (target: number) => {
      this.timer = window.setTimeout(() => {
        if (!this.isActive(path, loadId) || this.active?.cancelledByUser || !this.options.isEnabled()) {
          this.pending = false;
          this.clearTimer();
          return;
        }

        if (!isStableAtTarget(target)) {
          retry();
          return;
        }

        this.timer = window.setTimeout(() => {
          if (!this.isActive(path, loadId) || this.active?.cancelledByUser || !this.options.isEnabled()) {
            this.pending = false;
            this.clearTimer();
            return;
          }

          if (isStableAtTarget(target)) {
            finish(true);
            return;
          }

          retry();
        }, 900);
      }, 950);
    };

    const tryApply = () => {
      if (!this.isActive(path, loadId) || this.active?.cancelledByUser || !this.options.isEnabled()) {
        this.pending = false;
        this.clearTimer();
        return;
      }

      const target = resolveTarget();
      if (target === null) {
        retry();
        return;
      }

      try {
        engine.seekTo(target, true);
      } catch {
        retry();
        return;
      }

      verifyStable(target);
    };

    tryApply();
    return true;
  }

  saveProgress(engine: PlaybackEngine, path: string | null, loadId: number, force = false) {
    if (!path || !this.options.isAllowedPath(path) || this.pending || !this.isActive(path, loadId)) {
      return;
    }

    const now = Date.now();
    if (!force && (now < this.saveBlockedUntil || now - this.lastSaveAt < saveThrottleMs)) {
      return;
    }

    const snapshot = engine.snapshot();
    const position = snapshot.position;
    if (position < 5) {
      return;
    }

    this.lastSaveAt = now;
    saveResume(path, position, snapshot.duration);
  }

  private isActive(path: string, loadId: number) {
    return this.active?.path === path && this.active.loadId === loadId && this.options.isCurrent(path, loadId);
  }

  private clearTimer() {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
