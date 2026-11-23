import type { TextLanguageKey } from "./textLanguages";
import type { TextLineEnding, TextSourceType } from "./textModel";

export const textDraftSchemaVersion = 2;

/** Mirrors `TextDraftSnapshot` in src-tauri/src/text_recovery.rs. */
export type TextDraftSnapshot = {
  version: typeof textDraftSchemaVersion;
  id: string;
  title: string;
  baseContent: string;
  draft: string;
  originalPath: string | null;
  savePath: string | null;
  sourceType: TextSourceType;
  suggestedSavePath: string | null;
  encoding: string;
  lineEnding: TextLineEnding;
  languageId: TextLanguageKey | null;
  baseModifiedAt: number | null;
  updatedAt: number;
};

export type TextDraftSummary = {
  id: string;
  title: string;
  path: string | null;
  sourceType: TextSourceType;
  updatedAt: number;
  charCount: number;
  preview: string;
};

export function formatDraftTime(timestamp: number) {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return `today, ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  }
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
