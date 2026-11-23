import { fileName } from "../../lib/playerBrain";
import type { TextIndentation } from "./textIndentation";
import type { TextLanguageKey } from "./textLanguages";

export type TextLineEnding = "lf" | "crlf" | "cr";
export type TextSourceType = "file" | "untitled" | "word-extract";
export type TextEncodingSource = "bom" | "detected" | "fallback" | "forced" | "new";

export type TextFileStat = {
  path: string;
  byteLen: number;
  modifiedAt: number | null;
  readOnly: boolean;
};

/** Response of the `read_text_file` command. */
export type TextFileContent = {
  content: string;
  encoding: string;
  encodingSource: Exclude<TextEncodingSource, "new">;
  lineEnding: TextLineEnding;
  mixedLineEndings: boolean;
  decodeErrors: boolean;
  binary: boolean;
  longestLine: number;
  stat: TextFileStat;
};

/**
 * Everything the app knows about the open document except its text. The text
 * itself lives in the CodeMirror state so large files are never copied per key.
 */
export type TextDocument = {
  id: string;
  sourceType: TextSourceType;
  /** File the document saves to; null for untitled drafts and Word extracts. */
  path: string | null;
  /** Word document an extracted copy came from. */
  originalPath: string | null;
  suggestedSavePath: string | null;
  untitledName: string;
  encoding: string;
  savedEncoding: string;
  encodingSource: TextEncodingSource;
  lineEnding: TextLineEnding;
  savedLineEnding: TextLineEnding;
  mixedLineEndings: boolean;
  /** Language chosen by the user; null means automatic detection. */
  languageId: TextLanguageKey | null;
  detectedLanguage: TextLanguageKey;
  /** Indentation detected in or chosen for this document; null uses the settings. */
  indentation: TextIndentation | null;
  readOnly: boolean;
  locked: boolean;
  binary: boolean;
  decodeErrors: boolean;
  large: boolean;
  byteLen: number;
  modifiedAt: number | null;
  externalChange: "changed" | "deleted" | null;
  restoredDraftAt: number | null;
  loading: boolean;
  error: string | null;
};

export function createTextDocument(
  fields: Pick<TextDocument, "id" | "sourceType"> & Partial<TextDocument>,
): TextDocument {
  const encoding = fields.encoding ?? "utf-8";
  const lineEnding = fields.lineEnding ?? "lf";
  return {
    path: null,
    originalPath: null,
    suggestedSavePath: null,
    untitledName: "Untitled",
    encoding,
    savedEncoding: encoding,
    encodingSource: "new",
    lineEnding,
    savedLineEnding: lineEnding,
    mixedLineEndings: false,
    languageId: null,
    detectedLanguage: "plain",
    indentation: null,
    readOnly: false,
    locked: false,
    binary: false,
    decodeErrors: false,
    large: false,
    byteLen: 0,
    modifiedAt: null,
    externalChange: null,
    restoredDraftAt: null,
    loading: false,
    error: null,
    ...fields,
  };
}

export const largeTextFileBytes = 8 * 1024 * 1024;
export const largeTextLineChars = 40_000;
export const maxDraftTextChars = 16 * 1024 * 1024;

export type TextIoErrorCode =
  | "access-denied"
  | "changed"
  | "missing"
  | "read-only"
  | "too-large"
  | "unknown-encoding"
  | "unrepresentable"
  | "unsupported-extension";

export type TextIoError = {
  code: TextIoErrorCode | null;
  message: string;
};

export function parseTextIoError(error: unknown): TextIoError {
  const raw =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : String(error ?? "Unknown error");
  const match = /^\[text:([a-z-]+)\]\s*([\s\S]*)$/.exec(raw.trim());
  if (!match) {
    return { code: null, message: raw };
  }
  return { code: match[1] as TextIoErrorCode, message: match[2] || raw };
}

function hashString(value: string) {
  // FNV-1a, 32 bit twice with different seeds: short, stable and dependency-free.
  let first = 0x811c9dc5;
  let second = 0x01000193 ^ value.length;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x5bd1e995) >>> 0;
  }
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

export function normalizeTextPath(path: string) {
  return path.trim().replace(/\//g, "\\").toLowerCase();
}

export function fileDraftId(path: string) {
  return `file-${hashString(normalizeTextPath(path))}`;
}

export function wordDraftId(path: string) {
  return `word-${hashString(normalizeTextPath(path))}`;
}

export function untitledDraftId() {
  const random = Math.random().toString(36).slice(2, 10);
  return `new-${Date.now().toString(36)}-${random}`;
}

export function textDocumentTitle(document: TextDocument, extensionFor: (key: TextLanguageKey) => string) {
  if (document.path) {
    return fileName(document.path);
  }
  if (document.sourceType === "word-extract" && document.suggestedSavePath) {
    return fileName(document.suggestedSavePath);
  }
  const language = document.languageId ?? "plain";
  return `${document.untitledName}.${extensionFor(language)}`;
}

export function textDocumentFilePath(document: TextDocument | null) {
  return document?.path ?? null;
}

export function textLineEndingLabel(lineEnding: TextLineEnding) {
  if (lineEnding === "crlf") {
    return "CRLF";
  }
  if (lineEnding === "cr") {
    return "CR";
  }
  return "LF";
}

export function isTextDocumentMetaDirty(document: TextDocument | null) {
  return Boolean(
    document &&
      (document.encoding !== document.savedEncoding || document.lineEnding !== document.savedLineEnding),
  );
}

export function countTextLines(text: string) {
  return text.length === 0 ? 0 : text.split("\n").length;
}

export function normalizeTextContent(content: string) {
  return content.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
