import type { RefObject } from "react";

import type { TextEditorDocState, TextEditorHandle, TextEditorLoad } from "./textEditorHandle";
import type { TextIndentation } from "./textIndentation";
import type { TextLanguageKey } from "./textLanguages";
import type { TextDocument, TextLineEnding } from "./textModel";

/** What the text workspace needs from the app-level text editor controller. */
export type TextEditorController = {
  doc: TextDocument | null;
  /** Unsaved text, encoding or line ending changes. */
  dirty: boolean;
  title: string;
  languageKey: TextLanguageKey;
  indentation: TextIndentation;
  editorRef: RefObject<TextEditorHandle | null>;
  loadToken: number;
  consumeLoad: (token: number) => TextEditorLoad | null;
  handleDocState: (state: TextEditorDocState) => void;
  handleSample: (sample: string) => void;
  save: () => Promise<boolean>;
  saveAs: () => Promise<boolean>;
  revert: () => Promise<void>;
  reopenWithEncoding: (encoding: string) => Promise<void>;
  saveWithEncoding: (encoding: string) => Promise<void>;
  setLineEnding: (lineEnding: TextLineEnding) => void;
  setLanguage: (key: TextLanguageKey | null) => void;
  setIndentation: (indentation: TextIndentation) => void;
  unlock: () => void;
  reloadFromDisk: () => Promise<void>;
  keepLocalVersion: () => Promise<void>;
  discardRestoredDraft: () => Promise<void>;
  dismissRestoredNotice: () => void;
};
