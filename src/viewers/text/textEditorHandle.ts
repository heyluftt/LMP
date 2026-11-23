import type { TextEditCommand } from "./textEditCommands";

/** Text handed to the editor when a document is opened, restored or reloaded. */
export type TextEditorLoad = {
  text: string;
  /** Saved baseline when it differs from `text`, e.g. for a restored draft. */
  savedText?: string;
  cursor?: number | null;
};

export type TextEditorDocState = {
  dirty: boolean;
  length: number;
  lines: number;
};

export type TextCursorInfo = {
  line: number;
  column: number;
  selections: number;
  selectedChars: number;
  selectedLines: number;
};

/** Opaque document version captured before a save. */
export type TextEditorVersion = { readonly brand: "text-editor-version" };

export type TextEditorHandle = {
  focus: () => void;
  getText: () => string;
  getSavedText: () => string;
  getSample: (maxChars: number) => string;
  snapshot: () => { text: string; version: TextEditorVersion };
  markSaved: (version: TextEditorVersion) => void;
  revert: () => void;
  isDirty: () => boolean;
  lineCount: () => number;
  cursorOffset: () => number;
  goToLine: (line: number, column?: number) => void;
  selection: () => { from: number; to: number };
  selectedText: () => string;
  selectRange: (from: number, to: number) => void;
  replaceRange: (from: number, to: number, insert: string) => void;
  replaceRanges: (ranges: Array<{ from: number; insert: string; to: number }>) => void;
  insertText: (text: string) => void;
  runCommand: (command: TextEditCommand) => boolean;
};

export type { TextEditCommand };
