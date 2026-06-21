import { clampVolume, normalizeSpeed } from "../lib/playerBrain";
import type {
  PlaybackEngine,
  PlaybackEngineLoadOptions,
  PlaybackEngineSnapshot,
  PlayerCommand,
} from "./types";

const frameSeconds = 1 / 30;

export class NativeMediaEngine implements PlaybackEngine {
  readonly id = "native-webview" as const;
  readonly canRenderInline = true;

  private media: HTMLMediaElement;

  constructor(media: HTMLMediaElement) {
    this.media = media;
  }

  load({ source, volume, speed }: PlaybackEngineLoadOptions) {
    this.media.volume = clampVolume(volume) / 100;
    this.setSpeed(speed);
    if (this.media.src !== source) {
      this.media.src = source;
      this.media.load();
    } else if (this.media.readyState === 0) {
      this.media.load();
    }
  }

  async play() {
    await this.media.play();
  }

  pause() {
    this.media.pause();
  }

  async run(command: PlayerCommand) {
    switch (command.type) {
      case "togglePause":
        if (this.media.paused) {
          await this.media.play();
        } else {
          this.media.pause();
        }
        break;
      case "stop":
        this.media.pause();
        this.seekTo(0);
        break;
      case "seekBy":
        this.seekTo(this.media.currentTime + command.seconds, true);
        break;
      case "seekTo":
        this.seekTo(command.seconds, true);
        break;
      case "setVolume":
        this.media.volume = clampVolume(command.volume) / 100;
        break;
      case "setSpeed":
        this.setSpeed(command.speed);
        break;
      case "frameStep":
        this.media.pause();
        this.seekTo(this.media.currentTime + (command.seconds ?? frameSeconds) * command.direction);
        break;
    }
  }

  snapshot(): PlaybackEngineSnapshot {
    return {
      id: this.id,
      canRenderInline: this.canRenderInline,
      duration: Number.isFinite(this.media.duration) ? this.media.duration : 0,
      paused: this.media.paused,
      position: this.media.currentTime || 0,
      readyState: this.media.readyState,
      seeking: this.media.seeking,
      speed: normalizeSpeed(this.media.playbackRate || 1),
      volume: clampVolume(this.media.volume * 100),
    };
  }

  seekTo(seconds: number, preferFastSeek = false) {
    const duration = Number.isFinite(this.media.duration) ? this.media.duration : 0;
    const next = duration > 0 ? Math.max(0, Math.min(duration, seconds)) : Math.max(0, seconds);

    if (preferFastSeek && "fastSeek" in this.media && Math.abs(next - this.media.currentTime) > 1.25) {
      this.media.fastSeek(next);
      return;
    }

    this.media.currentTime = next;
  }

  private setSpeed(value: number) {
    const next = normalizeSpeed(value);
    this.media.defaultPlaybackRate = next;
    this.media.playbackRate = next;
    this.setPreservesPitch(true);
  }

  private setPreservesPitch(enabled: boolean) {
    const media = this.media as HTMLMediaElement & {
      preservesPitch?: boolean;
      mozPreservesPitch?: boolean;
      webkitPreservesPitch?: boolean;
    };
    media.preservesPitch = enabled;
    media.mozPreservesPitch = enabled;
    media.webkitPreservesPitch = enabled;
  }
}

export function createNativePlaybackEngine(
  media: HTMLMediaElement | null | undefined,
): PlaybackEngine | null {
  return media ? new NativeMediaEngine(media) : null;
}
