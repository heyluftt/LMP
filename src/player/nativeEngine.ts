import { clampVolume, normalizeSpeed } from "../lib/playerBrain";
import type { PlayerCommand } from "./types";

const frameSeconds = 1 / 30;

export class NativeMediaEngine {
  private media: HTMLMediaElement;

  constructor(media: HTMLMediaElement) {
    this.media = media;
  }

  load(src: string, volume: number, speed: number) {
    this.media.volume = clampVolume(volume) / 100;
    this.setSpeed(speed);
    if (this.media.src !== src) {
      this.media.src = src;
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
        this.seekTo(this.media.currentTime + frameSeconds * command.direction);
        break;
    }
  }

  private setSpeed(value: number) {
    const next = normalizeSpeed(value);
    this.media.defaultPlaybackRate = next;
    this.media.playbackRate = next;
  }

  private seekTo(seconds: number, preferFastSeek = false) {
    const duration = Number.isFinite(this.media.duration) ? this.media.duration : 0;
    const next = duration > 0 ? Math.max(0, Math.min(duration, seconds)) : Math.max(0, seconds);

    if (preferFastSeek && "fastSeek" in this.media && Math.abs(next - this.media.currentTime) > 1.25) {
      this.media.fastSeek(next);
      return;
    }

    this.media.currentTime = next;
  }
}
