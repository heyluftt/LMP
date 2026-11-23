/*
 * LMP audio output worklet.
 *
 * Runs inside the AudioWorkletGlobalScope. Owns a planar float ring buffer
 * that the main thread fills with decoded PCM. Playback rate is handled here:
 * rate 1 copies straight through, pitch-preserving rates between 0.5x and 2x
 * use a WSOLA time stretch, everything else falls back to linear resampling.
 *
 * The processor reports how many *input* frames it has consumed since the
 * last flush; the main thread turns that into the media clock. When the ring
 * runs dry the counter stops, so the clock stalls instead of drifting.
 *
 * This file is bundled as a standalone worklet module and must not import
 * anything from the app.
 */

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

declare function registerProcessor(
  name: string,
  processor: new (options?: unknown) => AudioWorkletProcessor,
): void;

declare const sampleRate: number;
declare const currentTime: number;

type WorkletMessage =
  | { type: "configure"; channels: number }
  | { type: "push"; planes: Float32Array[]; frames: number; segment: number }
  | { type: "flush"; segment: number }
  | { type: "play" }
  | { type: "pause" }
  | { type: "rate"; rate: number; preservePitch: boolean };

const RING_SECONDS = 10;
const STATUS_INTERVAL_BLOCKS = 12;

class LmpAudioOutputProcessor extends AudioWorkletProcessor {
  private channels = 2;
  private capacity = Math.max(1, Math.round(sampleRate * RING_SECONDS));
  private rings: Float32Array[] = [];

  /** Absolute input frame counters (never wrap; ring index = value % capacity). */
  private writePos = 0;
  private pos = 0;
  private released = 0;

  private segment = 0;
  private playing = false;
  private rate = 1;
  private preservePitch = true;
  private underruns = 0;
  private blockCounter = 0;
  private hasData = false;

  // --- WSOLA time stretch state --------------------------------------------
  private hop = Math.max(64, Math.round(sampleRate * 0.012));
  private frameLen = this.hop * 2;
  private radius = Math.max(16, Math.round(sampleRate * 0.004));
  private window = new Float32Array(this.hop);
  private tail: Float32Array[] = [];
  private naturalNext = -1;
  private stretchActive = false;
  private fifo: Float32Array[] = [];
  private fifoCapacity = this.frameLen * 8;
  private fifoRead = 0;
  private fifoWrite = 0;

  constructor() {
    super();
    for (let i = 0; i < this.hop; i += 1) {
      // Hann half-window for the cross-fade.
      this.window[i] = 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / this.hop);
    }
    this.allocate(this.channels);
    this.port.onmessage = (event: MessageEvent<WorkletMessage>) => this.handle(event.data);
  }

  private allocate(channels: number) {
    this.channels = Math.max(1, Math.min(8, channels | 0));
    this.rings = [];
    this.tail = [];
    this.fifo = [];
    for (let channel = 0; channel < this.channels; channel += 1) {
      this.rings.push(new Float32Array(this.capacity));
      this.tail.push(new Float32Array(this.hop));
      this.fifo.push(new Float32Array(this.fifoCapacity));
    }
    this.resetPositions();
  }

  private resetPositions() {
    this.writePos = 0;
    this.pos = 0;
    this.released = 0;
    this.hasData = false;
    this.naturalNext = -1;
    this.stretchActive = false;
    this.fifoRead = 0;
    this.fifoWrite = 0;
    for (const tail of this.tail) {
      tail.fill(0);
    }
  }

  private handle(message: WorkletMessage) {
    switch (message.type) {
      case "configure":
        this.allocate(message.channels);
        break;
      case "flush":
        this.segment = message.segment;
        this.resetPositions();
        this.underruns = 0;
        this.postStatus(true);
        break;
      case "push":
        if (message.segment === this.segment) {
          this.push(message.planes, message.frames);
        }
        break;
      case "play":
        this.playing = true;
        this.postStatus(true);
        break;
      case "pause":
        this.playing = false;
        this.postStatus(true);
        break;
      case "rate":
        this.setRate(message.rate, message.preservePitch);
        break;
    }
  }

  private setRate(rate: number, preservePitch: boolean) {
    const next = Number.isFinite(rate) && rate > 0 ? Math.max(0.1, Math.min(8, rate)) : 1;
    this.rate = next;
    this.preservePitch = preservePitch;
    const useStretch = this.preservePitch && Math.abs(next - 1) > 0.001 && next >= 0.5 && next <= 2.05;
    if (useStretch && !this.stretchActive) {
      // Start the stretcher at the current playhead with a silent tail; the
      // first grain skips the similarity search because there is no history.
      this.pos = Math.floor(this.pos);
      this.naturalNext = -1;
      for (const tail of this.tail) {
        tail.fill(0);
      }
      this.fifoRead = 0;
      this.fifoWrite = 0;
    } else if (!useStretch && this.stretchActive) {
      // Hand the integer playhead back to the direct path.
      this.pos = Math.floor(this.pos);
      this.fifoRead = 0;
      this.fifoWrite = 0;
    }
    this.stretchActive = useStretch;
  }

  private push(planes: Float32Array[], frames: number) {
    if (frames <= 0) {
      return;
    }
    const buffered = this.writePos - this.released;
    const space = this.capacity - buffered;
    const accepted = Math.min(frames, Math.max(0, space));
    if (accepted <= 0) {
      return;
    }
    for (let channel = 0; channel < this.channels; channel += 1) {
      const ring = this.rings[channel];
      const source = planes[Math.min(channel, planes.length - 1)];
      if (!source) {
        continue;
      }
      let start = this.writePos % this.capacity;
      let remaining = accepted;
      let offset = 0;
      while (remaining > 0) {
        const chunk = Math.min(remaining, this.capacity - start);
        ring.set(source.subarray(offset, offset + chunk), start);
        remaining -= chunk;
        offset += chunk;
        start = (start + chunk) % this.capacity;
      }
    }
    this.writePos += accepted;
    this.hasData = true;
  }

  private sampleAt(channel: number, index: number) {
    return this.rings[channel][((index % this.capacity) + this.capacity) % this.capacity];
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const output = outputs[0];
    if (!output || output.length === 0) {
      return true;
    }
    const frames = output[0].length;
    const outChannels = output.length;

    if (!this.playing || !this.hasData) {
      for (let channel = 0; channel < outChannels; channel += 1) {
        output[channel].fill(0);
      }
      this.maybePostStatus();
      return true;
    }

    let produced = 0;
    if (this.stretchActive) {
      produced = this.renderStretched(output, frames);
    } else if (Math.abs(this.rate - 1) < 0.001) {
      produced = this.renderDirect(output, frames);
    } else {
      produced = this.renderResampled(output, frames);
    }

    if (produced < frames) {
      this.underruns += 1;
      for (let channel = 0; channel < outChannels; channel += 1) {
        output[channel].fill(0, produced);
      }
    }

    this.maybePostStatus();
    return true;
  }

  private renderDirect(output: Float32Array[], frames: number) {
    const available = this.writePos - this.pos;
    const count = Math.max(0, Math.min(frames, Math.floor(available)));
    const start = Math.floor(this.pos);
    for (let channel = 0; channel < output.length; channel += 1) {
      const target = output[channel];
      const ring = this.rings[Math.min(channel, this.channels - 1)];
      let index = start % this.capacity;
      for (let i = 0; i < count; i += 1) {
        target[i] = ring[index];
        index += 1;
        if (index === this.capacity) {
          index = 0;
        }
      }
    }
    this.pos = start + count;
    this.released = Math.max(this.released, this.pos - 1);
    return count;
  }

  private renderResampled(output: Float32Array[], frames: number) {
    let produced = 0;
    for (let i = 0; i < frames; i += 1) {
      const base = Math.floor(this.pos);
      if (base + 1 >= this.writePos) {
        break;
      }
      const fraction = this.pos - base;
      for (let channel = 0; channel < output.length; channel += 1) {
        const ringChannel = Math.min(channel, this.channels - 1);
        const a = this.sampleAt(ringChannel, base);
        const b = this.sampleAt(ringChannel, base + 1);
        output[channel][i] = a + (b - a) * fraction;
      }
      this.pos += this.rate;
      produced += 1;
    }
    this.released = Math.max(this.released, Math.floor(this.pos) - 2);
    return produced;
  }

  private renderStretched(output: Float32Array[], frames: number) {
    let produced = 0;
    while (produced < frames) {
      if (this.fifoRead >= this.fifoWrite) {
        if (!this.synthesizeGrain()) {
          break;
        }
      }
      const available = this.fifoWrite - this.fifoRead;
      const count = Math.min(available, frames - produced);
      for (let channel = 0; channel < output.length; channel += 1) {
        const fifo = this.fifo[Math.min(channel, this.channels - 1)];
        const target = output[channel];
        let index = this.fifoRead % this.fifoCapacity;
        for (let i = 0; i < count; i += 1) {
          target[produced + i] = fifo[index];
          index += 1;
          if (index === this.fifoCapacity) {
            index = 0;
          }
        }
      }
      this.fifoRead += count;
      produced += count;
    }
    return produced;
  }

  /** Produces one hop of time-stretched output into the FIFO. */
  private synthesizeGrain() {
    const p = Math.round(this.pos);
    const first = this.naturalNext < 0;
    // Search window, clipped to the history that is still in the ring.
    let lo = first ? 0 : -this.radius;
    const hi = first ? 0 : this.radius;
    lo = Math.max(lo, this.released - p);
    if (lo > hi) {
      lo = 0;
    }
    if (p + hi + this.frameLen > this.writePos) {
      return false;
    }
    if (this.fifoWrite - this.fifoRead + this.hop > this.fifoCapacity) {
      return false;
    }

    let bestDelta = 0;
    if (!first && this.naturalNext >= this.released && lo < hi) {
      const reference = this.rings[0];
      const natural = this.naturalNext;
      let bestScore = -Infinity;
      for (let delta = lo; delta <= hi; delta += 1) {
        let score = 0;
        for (let i = 0; i < this.hop; i += 1) {
          const a = reference[((p + delta + i) % this.capacity + this.capacity) % this.capacity];
          const b = reference[((natural + i) % this.capacity + this.capacity) % this.capacity];
          score += a * b;
        }
        if (score > bestScore) {
          bestScore = score;
          bestDelta = delta;
        }
      }
    }

    const start = p + bestDelta;
    for (let channel = 0; channel < this.channels; channel += 1) {
      const ring = this.rings[channel];
      const tail = this.tail[channel];
      const fifo = this.fifo[channel];
      let fifoIndex = this.fifoWrite % this.fifoCapacity;
      for (let i = 0; i < this.hop; i += 1) {
        const grain = ring[((start + i) % this.capacity + this.capacity) % this.capacity];
        const w = this.window[i];
        fifo[fifoIndex] = tail[i] * (1 - w) + grain * w;
        fifoIndex += 1;
        if (fifoIndex === this.fifoCapacity) {
          fifoIndex = 0;
        }
      }
      for (let i = 0; i < this.hop; i += 1) {
        tail[i] = ring[((start + this.hop + i) % this.capacity + this.capacity) % this.capacity];
      }
    }
    this.fifoWrite += this.hop;
    this.naturalNext = start + this.hop;
    this.pos += this.hop * this.rate;
    const keepFrom = Math.min(this.naturalNext, Math.round(this.pos)) - this.radius - 2;
    this.released = Math.max(this.released, keepFrom);
    return true;
  }

  private maybePostStatus() {
    this.blockCounter += 1;
    if (this.blockCounter >= STATUS_INTERVAL_BLOCKS) {
      this.blockCounter = 0;
      this.postStatus(false);
    }
  }

  private postStatus(_immediate: boolean) {
    this.port.postMessage({
      type: "status",
      segment: this.segment,
      consumed: this.pos,
      buffered: Math.max(0, this.writePos - this.pos),
      underruns: this.underruns,
      playing: this.playing,
      time: currentTime,
    });
  }
}

registerProcessor("lmp-audio-output", LmpAudioOutputProcessor);
