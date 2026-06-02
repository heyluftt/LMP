export type VideoFitMode = "auto" | "contain" | "cover" | "stretch" | "original";

export const videoFitModes: Array<{ id: VideoFitMode; label: string }> = [
  { id: "auto", label: "Auto" },
  { id: "contain", label: "Contain" },
  { id: "cover", label: "Cover" },
  { id: "stretch", label: "Stretch" },
  { id: "original", label: "100%" },
];

export function sanitizeVideoFitMode(value: unknown): VideoFitMode {
  return videoFitModes.some((mode) => mode.id === value) ? (value as VideoFitMode) : "auto";
}

export function videoFitLabel(mode: VideoFitMode) {
  return videoFitModes.find((item) => item.id === mode)?.label ?? "Auto";
}

export function nextVideoFitMode(mode: VideoFitMode): VideoFitMode {
  const index = videoFitModes.findIndex((item) => item.id === mode);
  return videoFitModes[(index + 1) % videoFitModes.length]?.id ?? "auto";
}

export function videoFitObjectFit(mode: VideoFitMode) {
  if (mode === "stretch") {
    return "fill";
  }
  if (mode === "original") {
    return "none";
  }
  return mode === "cover" ? "cover" : "contain";
}
