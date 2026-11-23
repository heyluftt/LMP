import type { SubtitleFile } from "./types";

export function normalizeSubtitleToVtt(file: SubtitleFile) {
  const text = file.content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (file.extension.toLowerCase() === "vtt") {
    const trimmed = text.trimStart();
    return trimmed.startsWith("WEBVTT") ? trimmed : `WEBVTT\n\n${trimmed}`;
  }

  return srtToVtt(text);
}

function srtToVtt(text: string) {
  const cues = text
    .trim()
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);

      if (/^\d+$/.test(lines[0]?.trim() ?? "")) {
        lines.shift();
      }

      if (!lines[0]?.includes("-->")) {
        return "";
      }

      lines[0] = lines[0].replace(/,/g, ".");
      return lines.join("\n");
    })
    .filter(Boolean)
    .join("\n\n");

  return `WEBVTT\n\n${cues}\n`;
}
