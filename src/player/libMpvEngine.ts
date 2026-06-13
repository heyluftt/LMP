import { clampVolume, normalizeSpeed } from "../lib/playerBrain";
import {
  seekLibMpvCore,
  setLibMpvCorePaused,
  setLibMpvCoreSpeed,
  setLibMpvCoreVolume,
} from "./fallbackEngine";
import type {
  LibMpvCoreSession,
  PlaybackEngine,
  PlaybackEngineLoadOptions,
  PlaybackEngineSnapshot,
  PlayerCommand,
} from "./types";

const frameSeconds = 1 / 30;

export class LibMpvPlaybackEngine implements PlaybackEngine {
  readonly id = "libmpv" as const;
  readonly canRenderInline = true;

  private session: LibMpvCoreSession;
  private onSession: (session: LibMpvCoreSession) => void;

  constructor(
    session: LibMpvCoreSession,
    onSession: (session: LibMpvCoreSession) => void,
  ) {
    this.session = session;
    this.onSession = onSession;
  }

  load(_options: PlaybackEngineLoadOptions) {
    // libmpv sessions are started by the Tauri render path.
  }

  async play() {
    await this.setPaused(false);
  }

  pause() {
    void this.setPaused(true);
  }

  async run(command: PlayerCommand) {
    switch (command.type) {
      case "togglePause":
        await this.setPaused(!this.session.paused);
        break;
      case "stop":
        await this.setPaused(true);
        await this.seekToAsync(0);
        break;
      case "seekBy":
        await this.seekToAsync(this.session.position + command.seconds);
        break;
      case "seekTo":
        await this.seekToAsync(command.seconds);
        break;
      case "setVolume":
        await this.setVolume(command.volume);
        break;
      case "setSpeed":
        await this.setSpeed(command.speed);
        break;
      case "frameStep":
        await this.setPaused(true);
        await this.seekToAsync(this.session.position + frameSeconds * command.direction);
        break;
    }
  }

  seekTo(seconds: number) {
    void this.seekToAsync(seconds);
  }

  snapshot(): PlaybackEngineSnapshot {
    return {
      id: this.id,
      canRenderInline: this.canRenderInline,
      duration: Number.isFinite(this.session.duration) ? this.session.duration : 0,
      paused: this.session.paused,
      position: Number.isFinite(this.session.position) ? this.session.position : 0,
      readyState: this.session.ready ? 4 : this.session.active ? 1 : 0,
      seeking: false,
      speed: normalizeSpeed(this.session.speed || 1),
      volume: clampVolume(this.session.volume),
    };
  }

  private async setPaused(paused: boolean) {
    const session = await setLibMpvCorePaused(paused);
    this.replaceSession(session);
  }

  private async seekToAsync(seconds: number) {
    const duration = Number.isFinite(this.session.duration) ? this.session.duration : 0;
    const next = duration > 0 ? Math.max(0, Math.min(duration, seconds)) : Math.max(0, seconds);
    const session = await seekLibMpvCore(next);
    this.replaceSession(session);
  }

  private async setVolume(volume: number) {
    const session = await setLibMpvCoreVolume(clampVolume(volume));
    this.replaceSession(session);
  }

  private async setSpeed(speed: number) {
    const session = await setLibMpvCoreSpeed(normalizeSpeed(speed));
    this.replaceSession(session);
  }

  private replaceSession(session: LibMpvCoreSession) {
    this.session = session;
    this.onSession(session);
  }
}

export function createLibMpvPlaybackEngine(
  session: LibMpvCoreSession,
  onSession: (session: LibMpvCoreSession) => void,
): PlaybackEngine | null {
  return session.active ? new LibMpvPlaybackEngine(session, onSession) : null;
}
