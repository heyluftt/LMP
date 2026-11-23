import type { MediaKind } from "../lib/playerBrain";
import type { ClipExportProgress } from "../player/types";

export type ToastTone = "info" | "error" | "success";

export type Toast = {
  tone: ToastTone;
  message: string;
};

export type ContextMenuState = {
  x: number;
  y: number;
};

export type ConfirmDialog = {
  cancelLabel: string;
  confirmLabel: string;
  message: string;
  title: string;
  tone?: "danger" | "normal";
};

export type ChoiceDialogOption = {
  id: string;
  label: string;
  tone?: "danger" | "normal" | "primary";
};

/** Dialog with several answers, e.g. Save / Don't Save / Cancel. Cancel resolves to null. */
export type ChoiceDialog = {
  cancelLabel: string;
  choices: ChoiceDialogOption[];
  message: string;
  title: string;
};

export type PromptDialog = {
  cancelLabel: string;
  confirmLabel: string;
  message: string;
  title: string;
};

export type LoopRange = {
  start: number | null;
  end: number | null;
};

export type TrimRange = {
  start: number;
  end: number;
};

export type TrimExportState = ClipExportProgress & {
  outputPath?: string | null;
};

export type RemuxFallbackState = {
  path: string;
  status: "running" | "done";
};

export type MediaOpenRequest = {
  targetLabel: string;
  files: string[];
};

export type SubtitleTrack = {
  path: string;
  label: string;
  src: string;
  automatic: boolean;
};

export type StartupResumeState = {
  path: string;
  loadId: number;
  target: number;
};

export type MediaDetails = {
  width: number | null;
  height: number | null;
  duration: number | null;
};

export type OpeningMediaState = {
  kind: MediaKind;
  path: string;
  phase: "opening" | "preparing" | "resuming";
  loadId: number;
};

export type QueueSource = "single" | "manual" | "auto-folder";
