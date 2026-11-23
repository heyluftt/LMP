import type { AvCue, AvSample } from "./types";

const textDecoder = new TextDecoder("utf-8");

function parseTimestamp(value: string): number | null {
  const match = value
    .trim()
    .match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!match) {
    return null;
  }
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = match[4] ? Number(match[4].padEnd(3, "0")) : 0;
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

export function stripSubtitleMarkup(text: string) {
  return text
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/<\/?(?:b|i|u|font|c|v|ruby|rt|lang)[^>]*>/gi, "")
    .replace(/\\N/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\h/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\r/g, "")
    .trim();
}

/** Parses SRT or WebVTT text into cues (seconds). */
export function parseSubtitleText(content: string): AvCue[] {
  const text = content.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const blocks = text.split(/\n{2,}/);
  const cues: AvCue[] = [];
  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    if (lines.length === 0) {
      continue;
    }
    if (/^WEBVTT/i.test(lines[0]) || /^(NOTE|STYLE|REGION)\b/.test(lines[0])) {
      continue;
    }
    let timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) {
      continue;
    }
    const timing = lines[timingIndex];
    const [startText, endPart] = timing.split("-->");
    const endText = endPart?.trim().split(/\s+/)[0] ?? "";
    const start = parseTimestamp(startText ?? "");
    const end = parseTimestamp(endText);
    if (start === null || end === null || end < start) {
      continue;
    }
    timingIndex += 1;
    const body = stripSubtitleMarkup(lines.slice(timingIndex).join("\n"));
    if (!body) {
      continue;
    }
    cues.push({ start, end, text: body });
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return cues;
}

function assPayloadText(payload: string) {
  // Matroska ASS block: ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
  const fields = payload.split(",");
  if (fields.length < 9) {
    return payload;
  }
  return fields.slice(8).join(",");
}

function tx3gText(data: Uint8Array) {
  if (data.length < 2) {
    return "";
  }
  const length = (data[0] << 8) | data[1];
  return textDecoder.decode(data.subarray(2, 2 + Math.min(length, data.length - 2)));
}

function wvttText(data: Uint8Array) {
  // ISO 14496-30: samples are vttc boxes containing payl boxes.
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const texts: string[] = [];
  const walk = (start: number, end: number) => {
    let offset = start;
    while (offset + 8 <= end) {
      const size = view.getUint32(offset);
      const type = textDecoder.decode(data.subarray(offset + 4, offset + 8));
      const boxEnd = size === 0 ? end : Math.min(end, offset + size);
      if (boxEnd <= offset + 8) {
        break;
      }
      if (type === "vttc") {
        walk(offset + 8, boxEnd);
      } else if (type === "payl") {
        texts.push(textDecoder.decode(data.subarray(offset + 8, boxEnd)));
      }
      offset = boxEnd;
    }
  };
  walk(0, data.byteLength);
  return texts.join("\n");
}

/** Converts a demuxed subtitle sample into a cue. */
export function cueFromSample(sample: AvSample, format: string | null): AvCue | null {
  if (sample.durationUs <= 0 && format !== "tx3g") {
    return null;
  }
  let text = "";
  switch (format) {
    case "srt":
    case "webvtt":
      text = textDecoder.decode(sample.data);
      break;
    case "ass":
      text = assPayloadText(textDecoder.decode(sample.data));
      break;
    case "tx3g":
    case "qt-text":
      text = tx3gText(sample.data);
      break;
    case "wvtt":
      text = wvttText(sample.data);
      break;
    default:
      return null;
  }
  const clean = stripSubtitleMarkup(text);
  if (!clean) {
    return null;
  }
  const start = sample.ptsUs / 1e6;
  const duration = sample.durationUs > 0 ? sample.durationUs / 1e6 : 3;
  return { start, end: start + duration, text: clean };
}

/** Sorted cue list with cheap active-cue lookup. */
export class CueList {
  private cues: AvCue[] = [];

  get size() {
    return this.cues.length;
  }

  replace(cues: AvCue[]) {
    this.cues = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  }

  add(cue: AvCue) {
    const index = this.cues.findIndex((item) => item.start === cue.start && item.text === cue.text);
    if (index >= 0) {
      return;
    }
    let insertAt = this.cues.length;
    while (insertAt > 0 && this.cues[insertAt - 1].start > cue.start) {
      insertAt -= 1;
    }
    this.cues.splice(insertAt, 0, cue);
  }

  clear() {
    this.cues = [];
  }

  activeAt(seconds: number): string | null {
    const active: string[] = [];
    for (const cue of this.cues) {
      if (cue.start > seconds + 0.05) {
        break;
      }
      if (cue.start <= seconds && seconds < cue.end) {
        active.push(cue.text);
      }
    }
    return active.length > 0 ? active.join("\n") : null;
  }
}
