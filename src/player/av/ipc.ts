import { invoke } from "@tauri-apps/api/core";
import type { AvOpenResult, AvSample, AvSampleBatch } from "./types";

const BATCH_MAGIC = 0x53504d4c; // "LMPS"
const HEADER_SIZE = 16;
const RECORD_SIZE = 32;
const BATCH_FLAG_EOF = 1;
const SAMPLE_FLAG_KEYFRAME = 1;

export function avOpen(path: string) {
  return invoke<AvOpenResult>("av_open", { path });
}

export function avSelectTracks(sessionId: number, trackIds: number[]) {
  return invoke<void>("av_select_tracks", { sessionId, trackIds });
}

export function avSeek(sessionId: number, seconds: number) {
  return invoke<number>("av_seek", { sessionId, seconds });
}

export async function avRead(sessionId: number, maxBytes?: number, maxSamples?: number) {
  const buffer = await invoke<ArrayBuffer | Uint8Array | number[]>("av_read", {
    sessionId,
    maxBytes: maxBytes ?? null,
    maxSamples: maxSamples ?? null,
  });
  return parseSampleBatch(toArrayBuffer(buffer));
}

export function avClose(sessionId: number) {
  return invoke<void>("av_close", { sessionId }).catch(() => undefined);
}

function toArrayBuffer(value: ArrayBuffer | Uint8Array | number[]): ArrayBuffer {
  if (value instanceof ArrayBuffer) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  return Uint8Array.from(value).buffer;
}

/**
 * Decodes the binary batch produced by `src-tauri/src/av/batch.rs`.
 * Sample payloads are views into the batch buffer; no copies are made here.
 */
export function parseSampleBatch(buffer: ArrayBuffer): AvSampleBatch {
  if (buffer.byteLength < HEADER_SIZE) {
    throw new Error("Sample batch is truncated.");
  }
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== BATCH_MAGIC) {
    throw new Error("Sample batch has an unexpected header.");
  }
  const flags = view.getUint16(6, true);
  const count = view.getUint32(8, true);
  const payloadStart = HEADER_SIZE + count * RECORD_SIZE;
  if (payloadStart > buffer.byteLength) {
    throw new Error("Sample batch record table is truncated.");
  }

  const samples: AvSample[] = new Array(count);
  let payloadOffset = payloadStart;
  for (let index = 0; index < count; index += 1) {
    const record = HEADER_SIZE + index * RECORD_SIZE;
    const trackId = view.getUint32(record, true);
    const sampleFlags = view.getUint8(record + 4);
    const size = view.getUint32(record + 8, true);
    const ptsUs = Number(view.getBigInt64(record + 12, true));
    const durationUs = Number(view.getBigInt64(record + 20, true));
    if (payloadOffset + size > buffer.byteLength) {
      throw new Error("Sample batch payload is truncated.");
    }
    samples[index] = {
      trackId,
      keyframe: (sampleFlags & SAMPLE_FLAG_KEYFRAME) !== 0,
      ptsUs,
      durationUs,
      data: new Uint8Array(buffer, payloadOffset, size),
    };
    payloadOffset += size;
  }

  return { samples, eof: (flags & BATCH_FLAG_EOF) !== 0 };
}
