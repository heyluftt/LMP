import type { TextLanguageKey } from "./textLanguages";
import { normalizeTextPath } from "./textModel";

const storageKey = "lmp:text-sessions";
const sessionLimit = 150;

export type TextSessionMemory = {
  cursor: number;
  languageId: TextLanguageKey | null;
  updatedAt: number;
};

type TextSessionStore = Record<string, TextSessionMemory>;

function readStore(): TextSessionStore {
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as TextSessionStore) : {};
  } catch {
    return {};
  }
}

/** Last cursor position and language choice per file, so reopening continues there. */
export function readTextSession(path: string): TextSessionMemory | null {
  const entry = readStore()[normalizeTextPath(path)];
  return entry && Number.isFinite(entry.cursor) ? entry : null;
}

export function rememberTextSession(path: string, session: Omit<TextSessionMemory, "updatedAt">) {
  try {
    const store = readStore();
    store[normalizeTextPath(path)] = { ...session, updatedAt: Date.now() };
    const entries = Object.entries(store)
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, sessionLimit);
    window.localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Session memory is a convenience; storage failures are ignored.
  }
}
