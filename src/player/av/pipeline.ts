import { AudioOutput } from "./audioOutput";
import { avClose, avOpen, avRead, avSeek, avSelectTracks } from "./ipc";
import { CueList, cueFromSample } from "./subtitles";
import { probeAudioTrack, probeVideoTrack, audioDecoderConfig, describeCodecFamily } from "./support";
import type {
  AvCue,
  AvEngineStats,
  AvMediaInfo,
  AvPlayerState,
  AvSample,
  AvSelectedTracks,
  AvSnapshot,
  AvTrack,
} from "./types";
import { CanvasVideoRenderer, type VideoFitMode } from "./videoRenderer";

export type AvPlayerEventMap = {
  ready: { info: AvMediaInfo; tracks: AvSelectedTracks };
  firstframe: { positionUs: number };
  timeupdate: { positionUs: number };
  statechange: { paused: boolean };
  seeked: { positionUs: number };
  ended: Record<string, never>;
  error: { message: string; fatal: boolean };
  tracks: { tracks: AvSelectedTracks };
  videosize: { width: number; height: number };
  subtitle: { text: string | null };
};

type Listener<K extends keyof AvPlayerEventMap> = (payload: AvPlayerEventMap[K]) => void;

export type AvOpenOptions = {
  startSeconds?: number | null;
  autoplay: boolean;
  volume: number;
  speed: number;
  preferredAudioTrackId?: number | null;
  preferredSubtitleTrackId?: number | null;
};

const READ_BATCH_BYTES = 1536 * 1024;
const READ_BATCH_SAMPLES = 192;
const TARGET_BUFFER_US = 3_000_000;
const MAX_BUFFER_US = 9_000_000;
const MAX_QUEUED_BYTES = 28 * 1024 * 1024;
const MAX_DECODED_FRAMES = 8;
const MAX_VIDEO_DECODE_QUEUE = 6;
const MAX_AUDIO_DECODE_QUEUE = 12;
const AUDIO_PRIME_US = 120_000;
const PRIME_TIMEOUT_MS = 1600;
const LATE_FRAME_SLACK_US = 6_000;
const TIMEUPDATE_INTERVAL_MS = 180;

/**
 * The LMP AV playback core: pulls compressed samples from the Rust demuxer,
 * decodes them with WebCodecs, keeps audio and video in sync against the
 * audio clock (or a wall clock for silent files) and paints frames onto a
 * canvas. Seeking is exact: the demuxer jumps to the key frame before the
 * target and everything earlier is decoded and dropped.
 */
export class AvPlayer {
  private listeners = new Map<keyof AvPlayerEventMap, Set<Listener<keyof AvPlayerEventMap>>>();
  private readonly renderer = new CanvasVideoRenderer();
  private readonly audio = new AudioOutput();

  private sessionId: number | null = null;
  private path: string | null = null;
  private info: AvMediaInfo | null = null;
  private tracks: AvSelectedTracks = { video: null, audio: null, subtitle: null };
  private state: AvPlayerState = "idle";
  private generation = 0;

  private videoDecoder: VideoDecoder | null = null;
  private audioDecoder: AudioDecoder | null = null;
  private videoConfig: VideoDecoderConfig | null = null;
  private audioConfig: AudioDecoderConfig | null = null;
  private videoHardware = false;

  private videoQueue: AvSample[] = [];
  private audioQueue: AvSample[] = [];
  private queuedBytes = 0;
  private frames: VideoFrame[] = [];
  private cues = new CueList();
  private sidecarCues = new CueList();
  private subtitlesEnabled = true;
  private lastSubtitle: string | null = null;

  private feederBusy = false;
  private feederEof = false;
  /** Seeks whose `avSeek` has not finished yet; reads wait until it is zero. */
  private seekBarrier = 0;
  private readInFlight: Promise<unknown> | null = null;
  /**
   * Tail of the backend seek queue. Tauri runs commands concurrently, so two
   * quick seeks could reach the demuxer in the wrong order; each `avSeek`
   * therefore waits for the one before it. Never rejects.
   */
  private seekQueue: Promise<unknown> = Promise.resolve();
  private decodersFlushed = false;
  private flushing = false;
  private lastVideoQueuedUs = Number.NEGATIVE_INFINITY;
  private lastAudioQueuedUs = Number.NEGATIVE_INFINITY;
  private waitingForVideoKey = true;

  private paused = true;
  private seeking = false;
  private primed = false;
  private primeStartedAt = 0;
  private pendingTargetUs: number | null = null;
  private positionUs = 0;
  private lastPresentedUs = Number.NEGATIVE_INFINITY;
  private lastTimeUpdateAt = 0;
  private endedEmitted = false;

  private wallBaseUs = 0;
  private wallStartMs = 0;
  private audioMaster = false;
  private audioBlocked = false;

  private speed = 1;
  private volume = 1;
  private frameHandle: number | null = null;
  private droppedFrames = 0;
  private presentedFrames = 0;

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  on<K extends keyof AvPlayerEventMap>(event: K, listener: Listener<K>) {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<keyof AvPlayerEventMap>);
    return () => {
      set?.delete(listener as Listener<keyof AvPlayerEventMap>);
    };
  }

  private emit<K extends keyof AvPlayerEventMap>(event: K, payload: AvPlayerEventMap[K]) {
    const set = this.listeners.get(event);
    if (!set) {
      return;
    }
    for (const listener of Array.from(set)) {
      try {
        (listener as Listener<K>)(payload);
      } catch (error) {
        console.error("LMP AV listener failed", error);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------------

  attachCanvas(canvas: HTMLCanvasElement | null) {
    this.renderer.attach(canvas);
  }

  setFitMode(fit: VideoFitMode) {
    this.renderer.setFit(fit);
  }

  get currentPath() {
    return this.path;
  }

  get mediaInfo() {
    return this.info;
  }

  get selectedTracks() {
    return this.tracks;
  }

  get isActive() {
    return this.sessionId !== null && this.state !== "idle" && this.state !== "error";
  }

  /** Nominal frame duration in seconds for frame stepping. */
  frameDurationSeconds() {
    const video = this.tracks.video;
    if (video?.defaultDurationUs && video.defaultDurationUs > 0) {
      return video.defaultDurationUs / 1e6;
    }
    if (video?.frameRate && video.frameRate > 0) {
      return 1 / video.frameRate;
    }
    return 1 / 30;
  }

  stats(): AvEngineStats {
    return {
      videoDecoder: this.tracks.video?.codec ?? null,
      audioDecoder: this.tracks.audio?.codec ?? null,
      hardware: this.videoHardware,
      droppedFrames: this.droppedFrames,
      presentedFrames: this.presentedFrames,
      bufferedVideoMs: Math.max(0, (this.lastVideoQueuedUs - this.clockUs()) / 1000) || 0,
      bufferedAudioMs: this.audio.bufferedUs() / 1000,
      audioUnderruns: this.audio.underruns,
    };
  }

  snapshot(): AvSnapshot {
    return {
      state: this.state,
      paused: this.paused,
      seeking: this.seeking,
      positionUs: this.currentPositionUs(),
      durationUs: this.info?.durationUs ?? 0,
      speed: this.speed,
      volume: this.volume,
      primed: this.primed,
    };
  }

  async open(path: string, options: AvOpenOptions): Promise<AvMediaInfo> {
    await this.close();
    const generation = ++this.generation;
    this.state = "opening";
    this.path = path;
    this.paused = !options.autoplay;
    this.speed = options.speed;
    this.volume = Math.max(0, Math.min(1, options.volume / 100));

    const opened = await avOpen(path);
    if (generation !== this.generation) {
      await avClose(opened.sessionId);
      throw new Error("Playback was superseded.");
    }
    this.sessionId = opened.sessionId;
    this.info = opened.info;

    const video = pickTrack(opened.info.tracks, "video", null);
    const audio = pickTrack(opened.info.tracks, "audio", options.preferredAudioTrackId ?? null);
    const subtitle =
      options.preferredSubtitleTrackId != null
        ? opened.info.tracks.find((track) => track.id === options.preferredSubtitleTrackId) ?? null
        : opened.info.tracks.find(
            (track) => track.kind === "subtitle" && track.forced && track.subtitleFormat,
          ) ?? null;

    if (!video && !audio) {
      const reason = describeUnsupported(opened.info.tracks);
      await this.close();
      throw new Error(reason);
    }
    if (video && !audio) {
      // The file has sound, but only in codecs LMP AV cannot describe (DTS,
      // TrueHD, ...): keep the picture and tell the host why it is silent.
      const silent = opened.info.tracks.find((track) => track.kind === "audio");
      if (silent) {
        this.emit("error", {
          message: `${describeCodecFamily(silent.codecFamily)} audio is not supported by LMP AV; playing without sound.`,
          fatal: false,
        });
      }
    }

    let videoSupport = null;
    if (video) {
      videoSupport = await probeVideoTrack(video);
      if (generation !== this.generation) {
        throw new Error("Playback was superseded.");
      }
      if (!videoSupport.supported) {
        const reason = videoSupport.reason ?? "The video codec is not supported.";
        await this.close();
        throw new Error(reason);
      }
    }

    let audioSupport = null;
    let audioTrack: AvTrack | null = audio;
    if (audio) {
      audioSupport = await probeAudioTrack(audio);
      if (generation !== this.generation) {
        throw new Error("Playback was superseded.");
      }
      if (!audioSupport.supported) {
        if (!video) {
          const reason = audioSupport.reason ?? "The audio codec is not supported.";
          await this.close();
          throw new Error(reason);
        }
        // Keep the picture; tell the host the sound is missing.
        this.emit("error", {
          message: audioSupport.reason ?? "The audio track cannot be decoded; playing without sound.",
          fatal: false,
        });
        audioTrack = null;
        audioSupport = null;
      }
    }

    this.tracks = { video, audio: audioTrack, subtitle };
    this.videoConfig = videoSupport?.config ?? null;
    this.videoHardware = videoSupport?.hardware ?? false;
    this.audioConfig = audioSupport?.config ?? (audioTrack ? audioDecoderConfig(audioTrack) : null);

    await avSelectTracks(
      opened.sessionId,
      [video?.id, audioTrack?.id, subtitle?.id].filter((id): id is number => typeof id === "number"),
    );
    if (generation !== this.generation) {
      throw new Error("Playback was superseded.");
    }

    this.configureDecoders();
    if (audioTrack && this.audioConfig) {
      await this.audio.configure(this.audioConfig.sampleRate, this.audioConfig.numberOfChannels);
      if (generation !== this.generation) {
        throw new Error("Playback was superseded.");
      }
      this.audio.setBlockedHandler(() => this.handleAudioBlocked());
      this.audio.setRate(this.speed, true);
      this.audio.setVolume(this.volume);
      this.audioMaster = true;
    } else {
      this.audioMaster = false;
    }

    const startSeconds = options.startSeconds && options.startSeconds > 0 ? options.startSeconds : 0;
    const targetUs = Math.round(startSeconds * 1e6);
    this.positionUs = targetUs;
    this.wallBaseUs = targetUs;
    this.beginPrime(targetUs);
    if (targetUs > 0) {
      await avSeek(opened.sessionId, startSeconds);
      if (generation !== this.generation) {
        throw new Error("Playback was superseded.");
      }
    }

    this.state = "ready";
    this.emit("ready", { info: opened.info, tracks: this.tracks });
    this.emit("tracks", { tracks: this.tracks });
    if (video && video.width > 0 && video.height > 0) {
      this.emit("videosize", {
        width: video.displayWidth || video.width,
        height: video.displayHeight || video.height,
      });
    }
    this.startLoop();
    void this.pump();
    return opened.info;
  }

  async close() {
    this.generation += 1;
    this.stopLoop();
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.path = null;
    this.info = null;
    this.state = "idle";
    this.resetDecoders();
    this.audio.pause();
    this.audio.setBlockedHandler(null);
    this.audioMaster = false;
    this.audioBlocked = false;
    this.renderer.clear();
    this.cues.clear();
    this.sidecarCues.clear();
    this.tracks = { video: null, audio: null, subtitle: null };
    this.lastSubtitle = null;
    this.primed = false;
    this.seeking = false;
    this.paused = true;
    this.endedEmitted = false;
    this.droppedFrames = 0;
    this.presentedFrames = 0;
    if (sessionId !== null) {
      await avClose(sessionId);
    }
  }

  async play() {
    if (!this.isActive) {
      throw new Error("No media is open in LMP AV.");
    }
    if (this.state === "ended") {
      await this.seek(0);
    }
    if (!this.paused) {
      return;
    }
    this.paused = false;
    this.endedEmitted = false;
    this.wallStartMs = performance.now();
    if (this.primed && this.audioMaster) {
      this.audio.play();
    }
    this.emit("statechange", { paused: false });
    void this.pump();
  }

  pause() {
    if (this.paused) {
      return;
    }
    this.wallBaseUs = this.clockUs();
    this.paused = true;
    this.audio.pause();
    this.positionUs = this.wallBaseUs;
    this.emit("statechange", { paused: true });
  }

  async togglePause() {
    if (this.paused) {
      await this.play();
    } else {
      this.pause();
    }
  }

  async seek(seconds: number) {
    if (this.sessionId === null || !this.info) {
      return;
    }
    const durationUs = this.info.durationUs;
    // Stop a little before the end so the last group of pictures still decodes
    // and the final frame is shown instead of a blank seek.
    const endGuard = this.tracks.video ? Math.max(this.frameDurationSeconds() * 2, 0.1) : 0;
    const maxSeconds = durationUs > 0 ? Math.max(0, durationUs / 1e6 - endGuard) : seconds;
    const clamped = Math.max(0, Math.min(seconds, maxSeconds));
    const targetUs = Math.round(clamped * 1e6);
    const generation = ++this.generation;
    const sessionId = this.sessionId;

    this.seeking = true;
    this.state = this.state === "ended" ? "ready" : this.state;
    this.endedEmitted = false;
    this.positionUs = targetUs;
    this.wallBaseUs = targetUs;
    // Block new reads until the backend has moved: a read sent while
    // `avSeek` is in flight may run first and return samples from the old
    // position under the new generation.
    this.seekBarrier += 1;
    this.flushPipeline();
    this.beginPrime(targetUs);

    const previousSeek = this.seekQueue;
    const backendSeek = (async () => {
      // Seeks reach the backend strictly in order, so a slow earlier seek can
      // never land after this one and move the demuxer back.
      await previousSeek;
      // A read issued before this seek may still be queued in the backend. If
      // it ran after the seek it would swallow the key frame the seek landed
      // on, so let it finish first; its result is dropped by the generation
      // check in `pump`.
      const pendingRead = this.readInFlight;
      if (pendingRead) {
        await pendingRead.catch(() => undefined);
      }
      if (generation !== this.generation) {
        // A newer seek (or close) superseded this one; it issues its own.
        return false;
      }
      await avSeek(sessionId, clamped);
      return true;
    })();
    this.seekQueue = backendSeek.catch(() => undefined);

    try {
      if (!(await backendSeek)) {
        return;
      }
    } catch (error) {
      if (generation === this.generation) {
        this.emit("error", { message: errorText(error), fatal: false });
      }
      return;
    } finally {
      this.seekBarrier -= 1;
    }
    if (generation !== this.generation) {
      return;
    }
    void this.pump();
  }

  async stepFrame(direction: -1 | 1) {
    if (!this.isActive) {
      return;
    }
    if (!this.paused) {
      this.pause();
    }
    const frameSeconds = this.frameDurationSeconds();
    const current = this.currentPositionUs() / 1e6;
    const target = Math.max(0, current + direction * frameSeconds);
    await this.seek(target);
  }

  setVolume(volume: number) {
    this.volume = Math.max(0, Math.min(1, volume / 100));
    this.audio.setVolume(this.volume);
  }

  setSpeed(speed: number) {
    const next = Number.isFinite(speed) && speed > 0 ? speed : 1;
    if (!this.audioMaster || !this.primed) {
      this.wallBaseUs = this.clockUs();
      this.wallStartMs = performance.now();
    }
    this.speed = next;
    this.audio.setRate(next, true);
  }

  setSubtitlesEnabled(enabled: boolean) {
    this.subtitlesEnabled = enabled;
    this.updateSubtitle(true);
  }

  loadSidecarCues(cues: AvCue[] | null) {
    if (cues && cues.length > 0) {
      this.sidecarCues.replace(cues);
    } else {
      this.sidecarCues.clear();
    }
    this.updateSubtitle(true);
  }

  async selectAudioTrack(trackId: number | null) {
    if (!this.info || this.sessionId === null) {
      return;
    }
    const track = trackId === null ? null : this.info.tracks.find((item) => item.id === trackId && item.kind === "audio") ?? null;
    if (track === this.tracks.audio) {
      return;
    }
    if (track) {
      const support = await probeAudioTrack(track);
      if (!support.supported) {
        this.emit("error", { message: support.reason ?? "This audio track cannot be decoded.", fatal: false });
        return;
      }
      this.audioConfig = support.config;
    } else {
      this.audioConfig = null;
    }
    const wasPaused = this.paused;
    const position = this.currentPositionUs() / 1e6;
    this.tracks = { ...this.tracks, audio: track };
    await this.applyTrackSelection();
    if (track && this.audioConfig) {
      await this.audio.configure(this.audioConfig.sampleRate, this.audioConfig.numberOfChannels);
      this.audio.setRate(this.speed, true);
      this.audio.setVolume(this.volume);
      this.audioMaster = true;
    } else {
      this.audio.pause();
      this.audioMaster = false;
    }
    this.emit("tracks", { tracks: this.tracks });
    await this.seek(position);
    if (!wasPaused) {
      this.paused = false;
    }
  }

  async selectSubtitleTrack(trackId: number | null) {
    if (!this.info || this.sessionId === null) {
      return;
    }
    const track =
      trackId === null
        ? null
        : this.info.tracks.find((item) => item.id === trackId && item.kind === "subtitle") ?? null;
    if (track === this.tracks.subtitle) {
      return;
    }
    const position = this.currentPositionUs() / 1e6;
    this.tracks = { ...this.tracks, subtitle: track };
    this.cues.clear();
    await this.applyTrackSelection();
    this.emit("tracks", { tracks: this.tracks });
    this.updateSubtitle(true);
    await this.seek(position);
  }

  // ---------------------------------------------------------------------------
  // Decoders
  // ---------------------------------------------------------------------------

  private configureDecoders() {
    const generation = this.generation;
    if (this.tracks.video && this.videoConfig) {
      const decoder = new VideoDecoder({
        output: (frame) => this.onVideoFrame(frame, generation),
        error: (error) => this.onDecoderError("video", error, generation),
      });
      decoder.configure(this.videoConfig);
      decoder.ondequeue = () => this.drainDecoders();
      this.videoDecoder = decoder;
      this.waitingForVideoKey = true;
    }
    if (this.tracks.audio && this.audioConfig) {
      const decoder = new AudioDecoder({
        output: (data) => this.onAudioData(data, generation),
        error: (error) => this.onDecoderError("audio", error, generation),
      });
      decoder.configure(this.audioConfig);
      decoder.ondequeue = () => this.drainDecoders();
      this.audioDecoder = decoder;
    }
    this.decodersFlushed = false;
    this.flushing = false;
  }

  private resetDecoders() {
    for (const decoder of [this.videoDecoder, this.audioDecoder]) {
      if (!decoder) {
        continue;
      }
      try {
        if (decoder.state !== "closed") {
          decoder.close();
        }
      } catch {
        // Already closed.
      }
    }
    this.videoDecoder = null;
    this.audioDecoder = null;
    for (const frame of this.frames) {
      frame.close();
    }
    this.frames = [];
    this.videoQueue = [];
    this.audioQueue = [];
    this.queuedBytes = 0;
    this.feederEof = false;
    this.feederBusy = false;
    this.decodersFlushed = false;
    this.flushing = false;
    this.lastVideoQueuedUs = Number.NEGATIVE_INFINITY;
    this.lastAudioQueuedUs = Number.NEGATIVE_INFINITY;
    this.waitingForVideoKey = true;
  }

  /** Drops every queued and decoded sample and re-arms the decoders. */
  private flushPipeline() {
    this.resetDecoders();
    this.configureDecoders();
    this.audio.startSegment(this.positionUs);
    this.cues.clear();
    this.lastPresentedUs = Number.NEGATIVE_INFINITY;
  }

  private async applyTrackSelection() {
    if (this.sessionId === null) {
      return;
    }
    const ids = [this.tracks.video?.id, this.tracks.audio?.id, this.tracks.subtitle?.id].filter(
      (id): id is number => typeof id === "number",
    );
    await avSelectTracks(this.sessionId, ids);
  }

  private onDecoderError(kind: "video" | "audio", error: unknown, generation: number) {
    if (generation !== this.generation) {
      return;
    }
    const message = `${kind === "video" ? "Video" : "Audio"} decoder failed: ${errorText(error)}`;
    if (kind === "audio" && this.tracks.video) {
      // Keep the picture running on the wall clock.
      this.audioMaster = false;
      this.wallBaseUs = this.clockUs();
      this.wallStartMs = performance.now();
      this.audio.pause();
      this.emit("error", { message, fatal: false });
      return;
    }
    this.state = "error";
    this.emit("error", { message, fatal: true });
  }

  private onVideoFrame(frame: VideoFrame, generation: number) {
    if (generation !== this.generation) {
      frame.close();
      return;
    }
    const target = this.pendingTargetUs;
    if (target !== null && frame.timestamp + (frame.duration ?? 0) <= target) {
      // Decode-and-drop until the exact seek target. Keep the very last frame
      // of the stream so seeking to the end still shows a picture.
      const moreComing =
        this.videoQueue.length > 0 ||
        (this.videoDecoder?.decodeQueueSize ?? 0) > 0 ||
        !this.feederEof;
      if (moreComing) {
        frame.close();
        return;
      }
    }
    insertSorted(this.frames, frame);
    if (!this.primed) {
      this.tryPrime();
    }
  }

  private onAudioData(data: AudioData, generation: number) {
    if (generation !== this.generation) {
      data.close();
      return;
    }
    const target = this.pendingTargetUs;
    const endUs = data.timestamp + (data.numberOfFrames / data.sampleRate) * 1e6;
    if (target !== null && !this.audio.hasClock()) {
      if (endUs <= target) {
        data.close();
        return;
      }
      const trimUs = Math.max(0, target - data.timestamp);
      this.audio.push(data, trimUs);
    } else {
      this.audio.push(data);
    }
    data.close();
    if (!this.primed) {
      this.tryPrime();
    }
  }

  // ---------------------------------------------------------------------------
  // Feeding
  // ---------------------------------------------------------------------------

  private bufferedVideoUs() {
    return this.tracks.video ? this.lastVideoQueuedUs - this.clockUs() : Number.POSITIVE_INFINITY;
  }

  private bufferedAudioUs() {
    return this.tracks.audio ? this.lastAudioQueuedUs - this.clockUs() : Number.POSITIVE_INFINITY;
  }

  private needsMoreData() {
    if (this.feederEof || this.sessionId === null) {
      return false;
    }
    if (this.queuedBytes > MAX_QUEUED_BYTES) {
      return false;
    }
    const videoAhead = this.bufferedVideoUs();
    const audioAhead = this.bufferedAudioUs();
    const reference = this.primed ? this.clockUs() : this.positionUs;
    const minAhead = Math.min(
      this.tracks.video ? this.lastVideoQueuedUs - reference : Number.POSITIVE_INFINITY,
      this.tracks.audio ? this.lastAudioQueuedUs - reference : Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(minAhead)) {
      return true;
    }
    if (minAhead < TARGET_BUFFER_US) {
      return true;
    }
    return Math.max(videoAhead, audioAhead) < MAX_BUFFER_US && minAhead < TARGET_BUFFER_US;
  }

  private async pump() {
    if (this.feederBusy || this.seekBarrier > 0 || this.sessionId === null) {
      return;
    }
    this.feederBusy = true;
    const generation = this.generation;
    const sessionId = this.sessionId;
    try {
      while (generation === this.generation && this.needsMoreData()) {
        const read = avRead(sessionId, READ_BATCH_BYTES, READ_BATCH_SAMPLES);
        this.readInFlight = read;
        let batch: Awaited<typeof read>;
        try {
          batch = await read;
        } finally {
          if (this.readInFlight === read) {
            this.readInFlight = null;
          }
        }
        if (generation !== this.generation) {
          return;
        }
        for (const sample of batch.samples) {
          this.enqueue(sample);
        }
        if (batch.eof) {
          this.feederEof = true;
        }
        this.drainDecoders();
        if (batch.samples.length === 0 && !batch.eof) {
          break;
        }
      }
    } catch (error) {
      if (generation === this.generation) {
        this.emit("error", { message: `Reading media failed: ${errorText(error)}`, fatal: true });
        this.state = "error";
      }
    } finally {
      if (generation === this.generation) {
        this.feederBusy = false;
      }
    }
  }

  private enqueue(sample: AvSample) {
    const { video, audio, subtitle } = this.tracks;
    if (video && sample.trackId === video.id) {
      this.videoQueue.push(sample);
      this.queuedBytes += sample.data.byteLength;
      this.lastVideoQueuedUs = Math.max(this.lastVideoQueuedUs, sample.ptsUs);
      return;
    }
    if (audio && sample.trackId === audio.id) {
      this.audioQueue.push(sample);
      this.queuedBytes += sample.data.byteLength;
      this.lastAudioQueuedUs = Math.max(this.lastAudioQueuedUs, sample.ptsUs + Math.max(0, sample.durationUs));
      return;
    }
    if (subtitle && sample.trackId === subtitle.id) {
      const cue = cueFromSample(sample, subtitle.subtitleFormat);
      if (cue) {
        this.cues.add(cue);
      }
    }
  }

  private drainDecoders() {
    const videoDecoder = this.videoDecoder;
    if (videoDecoder && videoDecoder.state === "configured") {
      while (
        this.videoQueue.length > 0 &&
        videoDecoder.decodeQueueSize < MAX_VIDEO_DECODE_QUEUE &&
        this.frames.length < MAX_DECODED_FRAMES
      ) {
        const sample = this.videoQueue.shift()!;
        this.queuedBytes -= sample.data.byteLength;
        if (this.waitingForVideoKey && !sample.keyframe) {
          continue;
        }
        this.waitingForVideoKey = false;
        try {
          videoDecoder.decode(
            new EncodedVideoChunk({
              type: sample.keyframe ? "key" : "delta",
              timestamp: sample.ptsUs,
              duration: sample.durationUs > 0 ? sample.durationUs : undefined,
              data: sample.data,
            }),
          );
        } catch (error) {
          this.onDecoderError("video", error, this.generation);
          return;
        }
      }
    }

    const audioDecoder = this.audioDecoder;
    if (audioDecoder && audioDecoder.state === "configured") {
      while (
        this.audioQueue.length > 0 &&
        audioDecoder.decodeQueueSize < MAX_AUDIO_DECODE_QUEUE &&
        this.audio.bufferedUs() < 2_500_000
      ) {
        const sample = this.audioQueue.shift()!;
        this.queuedBytes -= sample.data.byteLength;
        try {
          audioDecoder.decode(
            new EncodedAudioChunk({
              type: "key",
              timestamp: sample.ptsUs,
              duration: sample.durationUs > 0 ? sample.durationUs : undefined,
              data: sample.data,
            }),
          );
        } catch (error) {
          this.onDecoderError("audio", error, this.generation);
          return;
        }
      }
    }

    if (
      this.feederEof &&
      this.videoQueue.length === 0 &&
      this.audioQueue.length === 0 &&
      !this.decodersFlushed &&
      !this.flushing
    ) {
      this.flushing = true;
      const generation = this.generation;
      const flushes: Promise<void>[] = [];
      if (videoDecoder && videoDecoder.state === "configured") {
        flushes.push(videoDecoder.flush());
      }
      if (audioDecoder && audioDecoder.state === "configured") {
        flushes.push(audioDecoder.flush());
      }
      void Promise.allSettled(flushes).then(() => {
        if (generation === this.generation) {
          this.decodersFlushed = true;
          this.flushing = false;
          if (!this.primed) {
            this.tryPrime(true);
          }
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Clock + presentation
  // ---------------------------------------------------------------------------

  private beginPrime(targetUs: number) {
    this.primed = false;
    this.pendingTargetUs = targetUs;
    this.primeStartedAt = performance.now();
    this.lastPresentedUs = Number.NEGATIVE_INFINITY;
  }

  private tryPrime(force = false) {
    if (this.primed || this.state === "idle" || this.state === "error") {
      return;
    }
    const hasVideo = Boolean(this.tracks.video);
    const hasAudio = this.audioMaster;
    const videoReady = !hasVideo || this.frames.length > 0 || (this.feederEof && this.decodersFlushed);
    const audioReady =
      !hasAudio ||
      this.audio.pushedUs() >= AUDIO_PRIME_US ||
      (this.feederEof && this.decodersFlushed) ||
      this.audio.bufferedUs() >= AUDIO_PRIME_US;
    const timedOut = performance.now() - this.primeStartedAt > PRIME_TIMEOUT_MS;
    if (!force && !(videoReady && audioReady) && !(timedOut && (videoReady || audioReady))) {
      return;
    }

    const target = this.pendingTargetUs ?? this.positionUs;
    this.primed = true;
    this.pendingTargetUs = null;
    const first = this.frames[0];
    const anchorUs = hasAudio && this.audio.hasClock() ? this.audio.currentTimeUs() : first ? Math.max(target, first.timestamp) : target;
    this.wallBaseUs = anchorUs;
    this.wallStartMs = performance.now();
    this.positionUs = anchorUs;
    if (first) {
      this.presentFrame(this.frames.shift()!);
    }
    if (!this.paused && hasAudio) {
      this.audio.play();
    }
    const wasSeeking = this.seeking;
    this.seeking = false;
    this.emit("firstframe", { positionUs: anchorUs });
    if (wasSeeking) {
      this.emit("seeked", { positionUs: anchorUs });
    }
    this.emitTimeUpdate(true);
    void this.pump();
  }

  private clockUs() {
    if (this.audioMaster && this.audio.hasClock() && this.primed) {
      return this.audio.currentTimeUs();
    }
    if (this.paused || !this.primed) {
      return this.wallBaseUs;
    }
    return this.wallBaseUs + (performance.now() - this.wallStartMs) * 1000 * this.speed;
  }

  private currentPositionUs() {
    if (this.seeking || !this.primed) {
      return this.positionUs;
    }
    const duration = this.info?.durationUs ?? 0;
    const clock = this.clockUs();
    return duration > 0 ? Math.min(clock, duration) : clock;
  }

  private presentFrame(frame: VideoFrame) {
    this.lastPresentedUs = frame.timestamp;
    this.presentedFrames += 1;
    this.renderer.present(frame);
  }

  private startLoop() {
    if (this.frameHandle !== null) {
      return;
    }
    const tick = () => {
      this.frameHandle = null;
      if (this.sessionId === null) {
        return;
      }
      this.step();
      this.frameHandle = requestAnimationFrame(tick);
    };
    this.frameHandle = requestAnimationFrame(tick);
  }

  private stopLoop() {
    if (this.frameHandle !== null) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
  }

  private step() {
    if (this.state === "error") {
      return;
    }
    if (!this.primed) {
      this.tryPrime();
      if (this.needsMoreData()) {
        void this.pump();
      } else {
        this.drainDecoders();
      }
      return;
    }

    const now = this.clockUs();
    if (!this.paused && this.frames.length > 0) {
      // Drop frames that are already late, keep the newest one that is due.
      while (this.frames.length > 1 && this.frames[1].timestamp <= now + LATE_FRAME_SLACK_US) {
        const late = this.frames.shift()!;
        late.close();
        this.droppedFrames += 1;
      }
      const next = this.frames[0];
      if (next.timestamp <= now + LATE_FRAME_SLACK_US) {
        this.frames.shift();
        this.presentFrame(next);
      }
    }

    if (this.frames.length < MAX_DECODED_FRAMES) {
      this.drainDecoders();
    }
    if (this.needsMoreData()) {
      void this.pump();
    }

    this.positionUs = this.currentPositionUs();
    this.emitTimeUpdate(false);
    this.updateSubtitle(false);
    this.checkEnded();
  }

  private emitTimeUpdate(force: boolean) {
    const nowMs = performance.now();
    if (!force && nowMs - this.lastTimeUpdateAt < TIMEUPDATE_INTERVAL_MS) {
      return;
    }
    this.lastTimeUpdateAt = nowMs;
    this.emit("timeupdate", { positionUs: this.positionUs });
  }

  private updateSubtitle(force: boolean) {
    const seconds = this.positionUs / 1e6;
    let text: string | null = null;
    if (this.subtitlesEnabled) {
      text = this.sidecarCues.size > 0 ? this.sidecarCues.activeAt(seconds) : this.cues.activeAt(seconds);
    }
    if (force || text !== this.lastSubtitle) {
      this.lastSubtitle = text;
      this.emit("subtitle", { text });
    }
  }

  private checkEnded() {
    if (this.endedEmitted || this.paused || !this.feederEof || !this.decodersFlushed) {
      return;
    }
    if (this.videoQueue.length > 0 || this.audioQueue.length > 0 || this.frames.length > 0) {
      return;
    }
    if (this.audioMaster && this.audio.bufferedUs() > 20_000) {
      return;
    }
    const duration = this.info?.durationUs ?? 0;
    if (duration > 0 && this.clockUs() < Math.min(duration, this.lastPresentedUs) - 50_000 && this.tracks.video) {
      return;
    }
    this.endedEmitted = true;
    this.state = "ended";
    this.paused = true;
    this.audio.pause();
    this.positionUs = duration > 0 ? duration : this.positionUs;
    this.wallBaseUs = this.positionUs;
    this.emit("timeupdate", { positionUs: this.positionUs });
    this.emit("statechange", { paused: true });
    this.emit("ended", {});
  }

  private handleAudioBlocked() {
    if (this.audioBlocked || !this.audioMaster) {
      return;
    }
    this.audioBlocked = true;
    this.audioMaster = false;
    this.wallBaseUs = this.positionUs;
    this.wallStartMs = performance.now();
    this.emit("error", {
      message: "Audio output could not start; playing video without sound.",
      fatal: false,
    });
  }
}

function pickTrack(tracks: AvTrack[], kind: "video" | "audio", preferredId: number | null) {
  const candidates = tracks.filter((track) => track.kind === kind && track.codec);
  if (candidates.length === 0) {
    return null;
  }
  if (preferredId !== null) {
    const preferred = candidates.find((track) => track.id === preferredId);
    if (preferred) {
      return preferred;
    }
  }
  return candidates.find((track) => track.default) ?? candidates[0];
}

function describeUnsupported(tracks: AvTrack[]) {
  const video = tracks.find((track) => track.kind === "video");
  const audio = tracks.find((track) => track.kind === "audio");
  const parts: string[] = [];
  if (video) {
    parts.push(`video ${video.codecFamily}`);
  }
  if (audio) {
    parts.push(`audio ${audio.codecFamily}`);
  }
  return parts.length > 0
    ? `LMP AV cannot decode this file yet (${parts.join(", ")}).`
    : "LMP AV found no playable tracks in this file.";
}

function insertSorted(frames: VideoFrame[], frame: VideoFrame) {
  let index = frames.length;
  while (index > 0 && frames[index - 1].timestamp > frame.timestamp) {
    index -= 1;
  }
  frames.splice(index, 0, frame);
}

function errorText(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
