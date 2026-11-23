import { clampVolume, normalizeSpeed } from "../../lib/playerBrain";
import type {
  PlaybackEngine,
  PlaybackEngineLoadOptions,
  PlaybackEngineSnapshot,
  PlayerCommand,
} from "../types";
import type { AvPlayer } from "./pipeline";

/**
 * Adapts the LMP AV player to the shared `PlaybackEngine` contract used by
 * the transport controls, keyboard handling and resume logic.
 */
export class LmpAvPlaybackEngine implements PlaybackEngine {
  readonly id = "lmp-av" as const;
  readonly canRenderInline = true;

  constructor(private readonly player: AvPlayer) {}

  load(_options: PlaybackEngineLoadOptions) {
    // Sessions are opened by the playback start pipeline.
  }

  async play() {
    await this.player.play();
  }

  pause() {
    this.player.pause();
  }

  async run(command: PlayerCommand) {
    switch (command.type) {
      case "togglePause":
        await this.player.togglePause();
        break;
      case "stop":
        this.player.pause();
        await this.player.seek(0);
        break;
      case "seekBy": {
        const snapshot = this.player.snapshot();
        await this.player.seek(snapshot.positionUs / 1e6 + command.seconds);
        break;
      }
      case "seekTo":
        await this.player.seek(command.seconds);
        break;
      case "setVolume":
        this.player.setVolume(clampVolume(command.volume));
        break;
      case "setSpeed":
        this.player.setSpeed(normalizeSpeed(command.speed));
        break;
      case "frameStep":
        await this.player.stepFrame(command.direction);
        break;
    }
  }

  seekTo(seconds: number) {
    void this.player.seek(seconds);
  }

  snapshot(): PlaybackEngineSnapshot {
    const snapshot = this.player.snapshot();
    return {
      id: this.id,
      canRenderInline: this.canRenderInline,
      duration: snapshot.durationUs / 1e6,
      paused: snapshot.paused,
      position: snapshot.positionUs / 1e6,
      readyState: snapshot.primed ? 4 : snapshot.state === "ready" ? 1 : 0,
      seeking: snapshot.seeking,
      speed: normalizeSpeed(snapshot.speed || 1),
      volume: clampVolume(snapshot.volume * 100),
    };
  }
}
