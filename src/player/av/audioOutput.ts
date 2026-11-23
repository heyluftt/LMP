import workletUrl from "./audioOutputWorklet.ts?worker&url";

type WorkletStatus = {
  segment: number;
  consumed: number;
  buffered: number;
  underruns: number;
  playing: boolean;
  time: number;
};

const emptyStatus: WorkletStatus = {
  segment: 0,
  consumed: 0,
  buffered: 0,
  underruns: 0,
  playing: false,
  time: 0,
};

/**
 * Main-thread side of the LMP audio output. Owns the AudioContext, the
 * worklet node and the gain stage, converts decoded `AudioData` into planar
 * float planes and derives the media clock from the worklet's consumption
 * reports.
 */
export class AudioOutput {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private moduleReady: Promise<void> | null = null;

  private sampleRate = 48000;
  private channels = 2;
  private segment = 0;
  private segmentBaseUs = 0;
  private hasSegmentBase = false;
  private status: WorkletStatus = emptyStatus;
  private statusReceivedAt = 0;
  private pushedFrames = 0;

  private playing = false;
  private rate = 1;
  private preservePitch = true;
  private volume = 1;
  private blockedResumeTimer: number | null = null;
  private onBlocked: (() => void) | null = null;

  get configured() {
    return this.node !== null;
  }

  get outputSampleRate() {
    return this.sampleRate;
  }

  async configure(sampleRate: number, channels: number) {
    const nextRate = sampleRate > 0 ? Math.min(192000, Math.max(8000, Math.round(sampleRate))) : 48000;
    const nextChannels = Math.max(1, Math.min(8, channels || 2));
    if (
      this.context &&
      this.node &&
      this.context.sampleRate === nextRate &&
      this.channels === nextChannels &&
      this.context.state !== "closed"
    ) {
      this.startSegment(0);
      return;
    }

    await this.close();
    let context: AudioContext;
    try {
      context = new AudioContext({ sampleRate: nextRate, latencyHint: "playback" });
    } catch {
      context = new AudioContext({ latencyHint: "playback" });
    }
    this.context = context;
    this.sampleRate = context.sampleRate;
    this.channels = nextChannels;
    this.moduleReady = context.audioWorklet.addModule(workletUrl);
    await this.moduleReady;
    if (this.context !== context) {
      return;
    }
    const node = new AudioWorkletNode(context, "lmp-audio-output", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [nextChannels],
    });
    node.port.onmessage = (event: MessageEvent<WorkletStatus & { type: string }>) => {
      const message = event.data;
      if (message?.type !== "status" || message.segment !== this.segment) {
        return;
      }
      this.status = message;
      this.statusReceivedAt = performance.now();
    };
    const gain = context.createGain();
    gain.gain.value = this.volume;
    node.connect(gain);
    gain.connect(context.destination);
    this.node = node;
    this.gain = gain;
    node.port.postMessage({ type: "configure", channels: nextChannels });
    node.port.postMessage({ type: "rate", rate: this.rate, preservePitch: this.preservePitch });
    this.startSegment(0);
    if (this.playing) {
      this.play();
    }
  }

  setBlockedHandler(handler: (() => void) | null) {
    this.onBlocked = handler;
  }

  startSegment(baseUs: number) {
    this.segment += 1;
    this.segmentBaseUs = baseUs;
    this.hasSegmentBase = false;
    this.status = { ...emptyStatus, segment: this.segment, playing: this.playing };
    this.statusReceivedAt = performance.now();
    this.pushedFrames = 0;
    this.node?.port.postMessage({ type: "flush", segment: this.segment });
  }

  /**
   * Queues decoded audio. `trimUs` skips the start of the buffer (used right
   * after a seek so audio begins exactly at the target).
   */
  push(data: AudioData, trimUs = 0) {
    const node = this.node;
    if (!node) {
      return;
    }
    const sourceRate = data.sampleRate || this.sampleRate;
    const skipFrames = trimUs > 0 ? Math.min(data.numberOfFrames, Math.round((trimUs / 1e6) * sourceRate)) : 0;
    const frames = data.numberOfFrames - skipFrames;
    if (frames <= 0) {
      return;
    }
    const planes = this.extractPlanes(data, skipFrames, frames);
    if (!planes) {
      return;
    }
    if (!this.hasSegmentBase) {
      this.segmentBaseUs = data.timestamp + (skipFrames / sourceRate) * 1e6;
      this.hasSegmentBase = true;
    }
    this.pushedFrames += frames;
    node.port.postMessage(
      { type: "push", planes, frames, segment: this.segment },
      planes.map((plane) => plane.buffer),
    );
  }

  private extractPlanes(data: AudioData, frameOffset: number, frames: number): Float32Array[] | null {
    const sourceChannels = data.numberOfChannels;
    const planes: Float32Array[] = [];
    try {
      const source: Float32Array[] = [];
      for (let channel = 0; channel < sourceChannels; channel += 1) {
        const plane = new Float32Array(frames);
        data.copyTo(plane, { planeIndex: channel, frameOffset, format: "f32-planar" });
        source.push(plane);
      }
      for (let channel = 0; channel < this.channels; channel += 1) {
        if (channel < source.length) {
          planes.push(source[channel]);
        } else if (source.length === 1) {
          planes.push(new Float32Array(source[0]));
        } else {
          planes.push(new Float32Array(frames));
        }
      }
      return planes;
    } catch {
      return this.extractPlanesFallback(data, frameOffset, frames);
    }
  }

  private extractPlanesFallback(data: AudioData, frameOffset: number, frames: number): Float32Array[] | null {
    // Older runtimes cannot convert in copyTo. Copy the native format and convert here.
    const format = data.format;
    if (!format) {
      return null;
    }
    const sourceChannels = data.numberOfChannels;
    const planar = format.endsWith("-planar");
    const bytesPer = format.startsWith("u8") ? 1 : format.startsWith("s16") ? 2 : 4;
    const totalFrames = data.numberOfFrames;
    const planes: Float32Array[] = [];
    for (let channel = 0; channel < this.channels; channel += 1) {
      planes.push(new Float32Array(frames));
    }
    const convert = (view: DataView, byteIndex: number) => {
      if (format.startsWith("u8")) {
        return (view.getUint8(byteIndex) - 128) / 128;
      }
      if (format.startsWith("s16")) {
        return view.getInt16(byteIndex, true) / 32768;
      }
      if (format.startsWith("s32")) {
        return view.getInt32(byteIndex, true) / 2147483648;
      }
      return view.getFloat32(byteIndex, true);
    };
    if (planar) {
      for (let channel = 0; channel < sourceChannels; channel += 1) {
        const buffer = new ArrayBuffer(totalFrames * bytesPer);
        data.copyTo(buffer, { planeIndex: channel });
        const view = new DataView(buffer);
        const target = planes[Math.min(channel, this.channels - 1)];
        if (channel >= this.channels) {
          break;
        }
        for (let i = 0; i < frames; i += 1) {
          target[i] = convert(view, (frameOffset + i) * bytesPer);
        }
      }
    } else {
      const buffer = new ArrayBuffer(totalFrames * sourceChannels * bytesPer);
      data.copyTo(buffer, { planeIndex: 0 });
      const view = new DataView(buffer);
      for (let i = 0; i < frames; i += 1) {
        for (let channel = 0; channel < this.channels; channel += 1) {
          const sourceChannel = Math.min(channel, sourceChannels - 1);
          planes[channel][i] = convert(view, ((frameOffset + i) * sourceChannels + sourceChannel) * bytesPer);
        }
      }
    }
    if (sourceChannels === 1) {
      for (let channel = 1; channel < this.channels; channel += 1) {
        planes[channel].set(planes[0]);
      }
    }
    return planes;
  }

  play() {
    this.playing = true;
    this.node?.port.postMessage({ type: "play" });
    const context = this.context;
    if (context && context.state !== "running") {
      void context.resume().catch(() => undefined);
      if (this.blockedResumeTimer !== null) {
        window.clearTimeout(this.blockedResumeTimer);
      }
      this.blockedResumeTimer = window.setTimeout(() => {
        this.blockedResumeTimer = null;
        if (this.playing && this.context === context && context.state !== "running") {
          this.onBlocked?.();
        }
      }, 900);
    }
  }

  pause() {
    this.playing = false;
    this.node?.port.postMessage({ type: "pause" });
  }

  get isPlaying() {
    return this.playing;
  }

  get contextRunning() {
    return this.context?.state === "running";
  }

  setRate(rate: number, preservePitch = true) {
    this.rate = rate;
    this.preservePitch = preservePitch;
    this.node?.port.postMessage({ type: "rate", rate, preservePitch });
  }

  setVolume(volume: number) {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.gain) {
      this.gain.gain.value = this.volume;
    }
  }

  /**
   * Frames handed to the worklet that have not been played yet (microseconds).
   * Uses the main-thread push counter so pushes that the worklet has not
   * acknowledged yet still count; otherwise the decoder gate overshoots.
   */
  bufferedUs() {
    const buffered = Math.max(0, this.pushedFrames - this.extrapolatedConsumed());
    return (buffered / this.sampleRate) * 1e6;
  }

  /** Total frames handed to the worklet in this segment, as microseconds. */
  pushedUs() {
    return (this.pushedFrames / this.sampleRate) * 1e6;
  }

  get underruns() {
    return this.status.underruns;
  }

  hasClock() {
    return this.hasSegmentBase && this.node !== null;
  }

  /** Media time of the audio currently leaving the speakers (microseconds). */
  currentTimeUs() {
    if (!this.hasSegmentBase) {
      return this.segmentBaseUs;
    }
    return this.segmentBaseUs + (this.extrapolatedConsumed() / this.sampleRate) * 1e6;
  }

  private extrapolatedConsumed() {
    const status = this.status;
    if (!this.playing || !status.playing || !this.context || this.context.state !== "running") {
      return status.consumed;
    }
    const elapsed = Math.max(0, this.context.currentTime - status.time);
    const wallElapsed = Math.max(0, (performance.now() - this.statusReceivedAt) / 1000);
    const dt = Math.min(elapsed, wallElapsed + 0.05, 0.4);
    const advance = dt * this.sampleRate * this.rate;
    return status.consumed + Math.min(advance, status.buffered);
  }

  async close() {
    if (this.blockedResumeTimer !== null) {
      window.clearTimeout(this.blockedResumeTimer);
      this.blockedResumeTimer = null;
    }
    const context = this.context;
    this.node?.port.postMessage({ type: "pause" });
    this.node?.disconnect();
    this.gain?.disconnect();
    this.node = null;
    this.gain = null;
    this.context = null;
    this.moduleReady = null;
    this.hasSegmentBase = false;
    if (context && context.state !== "closed") {
      await context.close().catch(() => undefined);
    }
  }
}
