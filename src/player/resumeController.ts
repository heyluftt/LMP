import { formatClock } from "../lib/playerBrain";
import { getResume, saveResume } from "./memory";

type ResumeControllerOptions = {
  isEnabled: () => boolean;
  isAllowedPath: (path: string) => boolean;
  isCurrent: (path: string, token: number) => boolean;
  getSpeed: () => number;
  setPosition: (seconds: number) => void;
  notify: (message: string) => void;
};

type ResumeSession = {
  path: string;
  token: number;
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

  beginLoad(path: string, token: number) {
    this.clearTimer();
    if (!this.options.isAllowedPath(path)) {
      this.active = null;
      this.appliedPath = null;
      this.pending = false;
      this.saveBlockedUntil = 0;
      return;
    }

    this.active = { path, token, cancelledByUser: false };
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

  maybeResume(media: HTMLMediaElement, path: string, token: number) {
    if (
      !this.options.isEnabled() ||
      !this.options.isAllowedPath(path) ||
      this.pending ||
      this.appliedPath === path ||
      !this.isActive(path, token) ||
      this.active?.cancelledByUser
    ) {
      return;
    }

    const resume = getResume(path);
    if (!resume || resume.position <= 5) {
      return;
    }

    const durationAllowsResume =
      !Number.isFinite(media.duration) || media.duration <= 0 || media.duration - resume.position > 8;
    if (!durationAllowsResume) {
      return;
    }

    this.pending = true;
    let attempts = 0;
    const maxAttempts = 5;

    const finish = (applied: boolean, actualPosition = media.currentTime || 0) => {
      if (!this.isActive(path, token)) {
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
      if (media.readyState < 2) {
        return null;
      }

      const knownDuration =
        Number.isFinite(media.duration) && media.duration > 0 ? media.duration : resume.duration;
      const upperBound = knownDuration > 0 ? Math.max(0, knownDuration - 8) : resume.position;
      const target = Math.min(resume.position, upperBound);
      return target > 5 ? target : null;
    };

    const isStableAtTarget = (target: number) => {
      const actual = media.currentTime || 0;
      const speedAllowance = Math.max(7, this.options.getSpeed() * 4);
      return !media.seeking && actual >= target - 1.25 && actual <= target + speedAllowance;
    };

    const verifyStable = (target: number) => {
      this.timer = window.setTimeout(() => {
        if (!this.isActive(path, token) || this.active?.cancelledByUser || !this.options.isEnabled()) {
          this.pending = false;
          this.clearTimer();
          return;
        }

        if (!isStableAtTarget(target)) {
          retry();
          return;
        }

        this.timer = window.setTimeout(() => {
          if (!this.isActive(path, token) || this.active?.cancelledByUser || !this.options.isEnabled()) {
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
      if (!this.isActive(path, token) || this.active?.cancelledByUser || !this.options.isEnabled()) {
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
        media.currentTime = target;
      } catch {
        retry();
        return;
      }

      verifyStable(target);
    };

    tryApply();
  }

  saveProgress(media: HTMLMediaElement, path: string | null, token: number, force = false) {
    if (!path || !this.options.isAllowedPath(path) || this.pending || !this.isActive(path, token)) {
      return;
    }

    const now = Date.now();
    if (!force && (now < this.saveBlockedUntil || now - this.lastSaveAt < saveThrottleMs)) {
      return;
    }

    const position = media.currentTime || 0;
    if (position < 5) {
      return;
    }

    this.lastSaveAt = now;
    saveResume(path, position, media.duration || 0);
  }

  private isActive(path: string, token: number) {
    return this.active?.path === path && this.active.token === token && this.options.isCurrent(path, token);
  }

  private clearTimer() {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
