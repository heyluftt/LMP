import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { formatBytes } from "../lib/mediaFormat";
import { extension, fileName } from "../lib/playerBrain";
import type { PlayerSettings } from "../player/settings";
import type { MediaFile, MediaInspection, MediaInspectionItem } from "../player/types";
import type { WordDocumentContent } from "../viewers/word";
import type { TextEditorController } from "../viewers/text/textController";
import { formatDraftTime, textDraftSchemaVersion, type TextDraftSnapshot } from "../viewers/text/textDrafts";
import type { TextEditorDocState, TextEditorHandle, TextEditorLoad } from "../viewers/text/textEditorHandle";
import { normalizeTextEncodingId, textEncodingLabel } from "../viewers/text/textEncodings";
import { detectTextIndentation, textIndentationLabel, type TextIndentation } from "../viewers/text/textIndentation";
import {
  defaultExtensionForLanguage,
  detectTextLanguageKey,
  languageKeyFromPath,
  textLanguageLabelForKey,
  textLanguageOption,
  textLanguageOptions,
  type TextLanguageKey,
} from "../viewers/text/textLanguages";
import {
  createTextDocument,
  fileDraftId,
  isTextDocumentMetaDirty,
  largeTextFileBytes,
  largeTextLineChars,
  maxDraftTextChars,
  parseTextIoError,
  textDocumentTitle,
  textLineEndingLabel,
  untitledDraftId,
  wordDraftId,
  type TextDocument,
  type TextFileContent,
  type TextFileStat,
  type TextIoError,
  type TextLineEnding,
} from "../viewers/text/textModel";
import { readTextSession, rememberTextSession } from "../viewers/text/textSessionMemory";
import { directoryFromPath } from "../viewers/text/textTerminalRunner";
import { suggestedExtractedTextPath, wordDocumentToEditableText } from "../viewers/text/textWordExtract";
import type { ChoiceDialog, ConfirmDialog, ToastTone } from "./appTypes";
import { useTextDraftRecovery } from "./useTextDraftRecovery";

type RequestChoice = (dialog: Partial<ChoiceDialog> & Pick<ChoiceDialog, "choices">) => Promise<string | null>;
type RequestConfirm = (dialog: Partial<ConfirmDialog>) => Promise<boolean>;
type ShowToast = (message: string, tone?: ToastTone) => void;

type UseTextEditorOptions = {
  requestChoice: RequestChoice;
  requestConfirm: RequestConfirm;
  settings: PlayerSettings;
  showToast: ShowToast;
  /** Called after Save As moved the document to a new file. */
  onDocumentPathChange: (path: string, stat: TextFileStat) => void;
};

type SaveOverrides = {
  encoding?: string;
};

type SaveFailureResolution = "cancel" | "clear-read-only" | "create" | "overwrite" | "reload" | "save-as" | "utf-8";

const languageSampleChars = 8000;
const indentationSampleChars = 200_000;

function stemOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name || "Untitled";
}

function documentFromContent(
  id: string,
  path: string,
  content: TextFileContent,
  languageId: TextLanguageKey | null,
): TextDocument {
  const large = content.stat.byteLen > largeTextFileBytes || content.longestLine > largeTextLineChars;
  const encoding = normalizeTextEncodingId(content.encoding);
  return createTextDocument({
    id,
    sourceType: "file",
    path,
    encoding,
    savedEncoding: encoding,
    encodingSource: content.encodingSource,
    lineEnding: content.lineEnding,
    savedLineEnding: content.lineEnding,
    mixedLineEndings: content.mixedLineEndings,
    languageId,
    detectedLanguage: detectTextLanguageKey(path, content.content.slice(0, languageSampleChars)),
    indentation: large ? null : detectTextIndentation(content.content.slice(0, indentationSampleChars)),
    readOnly: content.stat.readOnly,
    locked: content.stat.readOnly || content.binary,
    binary: content.binary,
    decodeErrors: content.decodeErrors,
    large,
    byteLen: content.stat.byteLen,
    modifiedAt: content.stat.modifiedAt,
  });
}

export function useTextEditor({
  onDocumentPathChange,
  requestChoice,
  requestConfirm,
  settings,
  showToast,
}: UseTextEditorOptions) {
  const [doc, setDocState] = useState<TextDocument | null>(null);
  const [contentDirty, setContentDirty] = useState(false);
  const [loadToken, setLoadToken] = useState(0);
  const docRef = useRef<TextDocument | null>(null);
  const contentDirtyRef = useRef(false);
  const loadTokenRef = useRef(0);
  const pendingLoadRef = useRef<{ token: number; load: TextEditorLoad } | null>(null);
  const editorRef = useRef<TextEditorHandle | null>(null);
  const onDocumentPathChangeRef = useRef(onDocumentPathChange);
  onDocumentPathChangeRef.current = onDocumentPathChange;
  const rememberFilesRef = useRef(settings.rememberRecentMedia);
  rememberFilesRef.current = settings.rememberRecentMedia;

  const setDoc = useCallback(
    (update: TextDocument | null | ((current: TextDocument | null) => TextDocument | null)) => {
      const next = typeof update === "function" ? update(docRef.current) : update;
      docRef.current = next;
      setDocState(next);
    },
    [],
  );

  const patchDoc = useCallback(
    (id: string, patch: Partial<TextDocument>) => {
      setDoc((current) => (current && current.id === id ? { ...current, ...patch } : current));
    },
    [setDoc],
  );

  const isDirtyNow = useCallback(
    () => Boolean(docRef.current) && (contentDirtyRef.current || isTextDocumentMetaDirty(docRef.current)),
    [],
  );

  const titleFor = useCallback(
    (current: TextDocument) => textDocumentTitle(current, defaultExtensionForLanguage),
    [],
  );

  const buildSnapshot = useCallback((): TextDraftSnapshot | null => {
    const current = docRef.current;
    const editor = editorRef.current;
    if (!current || !editor || current.loading || current.error || current.large || !isDirtyNow()) {
      return null;
    }
    const draft = editor.getText();
    const baseContent = editor.getSavedText();
    if (draft.length > maxDraftTextChars || baseContent.length > maxDraftTextChars) {
      return null;
    }
    return {
      version: textDraftSchemaVersion,
      id: current.id,
      title: titleFor(current),
      baseContent,
      draft,
      originalPath: current.originalPath,
      savePath: current.path,
      sourceType: current.sourceType,
      suggestedSavePath: current.suggestedSavePath,
      encoding: current.encoding,
      lineEnding: current.lineEnding,
      languageId: current.languageId,
      baseModifiedAt: current.modifiedAt,
      updatedAt: Date.now(),
    };
  }, [isDirtyNow, titleFor]);

  const recovery = useTextDraftRecovery({ buildSnapshot });
  const { cancelScheduledWrite, clearDraft, notifyChange, readDraft, refreshDrafts, releaseDraft } = recovery;

  const beginLoad = useCallback((load: TextEditorLoad) => {
    loadTokenRef.current += 1;
    const token = loadTokenRef.current;
    pendingLoadRef.current = { token, load };
    const dirty = load.savedText !== undefined && load.savedText !== load.text;
    contentDirtyRef.current = dirty;
    setContentDirty(dirty);
    setLoadToken(token);
  }, []);

  const consumeLoad = useCallback((token: number) => {
    const pending = pendingLoadRef.current;
    if (!pending || pending.token !== token) {
      return null;
    }
    pendingLoadRef.current = null;
    return pending.load;
  }, []);

  const rememberSession = useCallback(() => {
    const current = docRef.current;
    const editor = editorRef.current;
    // Cursor memory stores file paths, so it follows the "remember recent files" setting.
    if (rememberFilesRef.current && current?.path && current.sourceType === "file" && editor && !current.loading) {
      rememberTextSession(current.path, { cursor: editor.cursorOffset(), languageId: current.languageId });
    }
  }, []);

  const handleDocState = useCallback(
    (state: TextEditorDocState) => {
      contentDirtyRef.current = state.dirty;
      setContentDirty((current) => (current === state.dirty ? current : state.dirty));
      const current = docRef.current;
      if (!current) {
        return;
      }
      if (isDirtyNow()) {
        notifyChange();
      } else {
        void releaseDraft(current.id);
      }
    },
    [isDirtyNow, notifyChange, releaseDraft],
  );

  // Encoding and line ending changes count as edits for drafts too.
  const metaKey = doc ? `${doc.id}|${doc.encoding}|${doc.lineEnding}|${doc.languageId}` : "";
  useEffect(() => {
    const current = docRef.current;
    if (!current || current.loading) {
      return;
    }
    if (isDirtyNow()) {
      notifyChange();
    }
  }, [isDirtyNow, metaKey, notifyChange]);

  const handleSample = useCallback(
    (sample: string) => {
      const current = docRef.current;
      if (!current || current.languageId !== null || current.sourceType === "file") {
        return;
      }
      const detected = detectTextLanguageKey(null, sample);
      if (detected !== current.detectedLanguage) {
        patchDoc(current.id, { detectedLanguage: detected });
      }
    },
    [patchDoc],
  );

  /** Asks whether to restore a stored draft for a document that is being opened. */
  const offerDraft = useCallback(
    async (id: string, title: string): Promise<TextDraftSnapshot | null> => {
      const drafts = await refreshDrafts();
      const summary = drafts.find((draft) => draft.id === id);
      if (!summary) {
        return null;
      }
      const choice = await requestChoice({
        title: "Restore unsaved changes?",
        message: `LMP kept unsaved changes to ${title} from ${formatDraftTime(summary.updatedAt)}.`,
        choices: [
          { id: "discard", label: "Discard", tone: "danger" },
          { id: "restore", label: "Restore", tone: "primary" },
        ],
        cancelLabel: "Not now",
      });
      if (choice === "discard") {
        await clearDraft(id);
        return null;
      }
      return choice === "restore" ? readDraft(id) : null;
    },
    [clearDraft, readDraft, refreshDrafts, requestChoice],
  );

  const resetSession = useCallback(() => {
    rememberSession();
    cancelScheduledWrite();
    pendingLoadRef.current = null;
    contentDirtyRef.current = false;
    setContentDirty(false);
    setDoc(null);
  }, [cancelScheduledWrite, rememberSession, setDoc]);

  const openFile = useCallback(
    async (media: MediaFile, isCurrent: () => boolean) => {
      rememberSession();
      const path = media.path;
      const id = fileDraftId(path);
      const memory = rememberFilesRef.current ? readTextSession(path) : null;
      setDoc(
        createTextDocument({
          id,
          sourceType: "file",
          path,
          byteLen: media.byte_len,
          languageId: memory?.languageId ?? null,
          detectedLanguage: languageKeyFromPath(path) ?? "plain",
          loading: true,
        }),
      );
      // Clear the previous text while the file loads or a draft prompt is open.
      beginLoad({ text: "" });

      let content: TextFileContent;
      try {
        content = await invoke<TextFileContent>("read_text_file", { path });
      } catch (error) {
        if (isCurrent()) {
          patchDoc(id, { loading: false, error: parseTextIoError(error).message || "Text file could not be loaded." });
        }
        return;
      }
      if (!isCurrent()) {
        return;
      }

      let next = documentFromContent(id, path, content, memory?.languageId ?? null);
      let load: TextEditorLoad = { text: content.content, cursor: memory?.cursor ?? 0 };
      const snapshot = await offerDraft(id, fileName(path));
      if (!isCurrent()) {
        return;
      }
      if (snapshot) {
        load = { text: snapshot.draft, savedText: content.content, cursor: memory?.cursor ?? 0 };
        next = {
          ...next,
          encoding: normalizeTextEncodingId(snapshot.encoding),
          lineEnding: snapshot.lineEnding,
          languageId: snapshot.languageId ?? next.languageId,
          locked: false,
          restoredDraftAt: snapshot.updatedAt,
        };
      }
      setDoc(next);
      beginLoad(load);
    },
    [beginLoad, offerDraft, patchDoc, rememberSession, setDoc],
  );

  const openWordExtract = useCallback(
    async (media: MediaFile, isCurrent: () => boolean) => {
      rememberSession();
      const id = wordDraftId(media.path);
      const suggestedSavePath = suggestedExtractedTextPath(media.path);
      const base = createTextDocument({
        id,
        sourceType: "word-extract",
        originalPath: media.path,
        suggestedSavePath,
        untitledName: stemOf(fileName(suggestedSavePath)),
        loading: true,
      });
      setDoc(base);
      beginLoad({ text: "" });

      let text: string;
      try {
        const document = await invoke<WordDocumentContent>("read_word_document", { path: media.path });
        text = wordDocumentToEditableText(document, settings.textWordExtractionFormat);
      } catch (error) {
        if (isCurrent()) {
          patchDoc(id, { loading: false, error: parseTextIoError(error).message || "Word document text could not be extracted." });
        }
        return;
      }
      if (!isCurrent()) {
        return;
      }
      const snapshot = await offerDraft(id, fileName(suggestedSavePath));
      if (!isCurrent()) {
        return;
      }
      setDoc({
        ...base,
        loading: false,
        indentation: detectTextIndentation(text.slice(0, indentationSampleChars)),
        restoredDraftAt: snapshot?.updatedAt ?? null,
      });
      beginLoad(snapshot ? { text: snapshot.draft, savedText: text } : { text });
    },
    [beginLoad, offerDraft, patchDoc, rememberSession, setDoc, settings.textWordExtractionFormat],
  );

  const newDocument = useCallback(
    (languageId: TextLanguageKey | null = null) => {
      rememberSession();
      const lineEnding: TextLineEnding = languageId === "batch" ? "crlf" : "lf";
      setDoc(
        createTextDocument({
          id: untitledDraftId(),
          sourceType: "untitled",
          languageId,
          detectedLanguage: languageId ?? "plain",
          lineEnding,
          savedLineEnding: lineEnding,
        }),
      );
      beginLoad({ text: "" });
    },
    [beginLoad, rememberSession, setDoc],
  );

  /** Opens a stored draft; the caller has already reset the rest of the app. */
  const applyDraft = useCallback(
    async (snapshot: TextDraftSnapshot) => {
      rememberSession();
      const path = snapshot.sourceType === "file" ? snapshot.savePath : null;
      let stat: TextFileStat | null = null;
      if (path) {
        stat = await invoke<TextFileStat | null>("stat_text_file", { path }).catch(() => null);
      }
      const encoding = normalizeTextEncodingId(snapshot.encoding);
      const changedOnDisk =
        Boolean(stat) && snapshot.baseModifiedAt !== null && stat?.modifiedAt !== snapshot.baseModifiedAt;
      setDoc(
        createTextDocument({
          id: snapshot.id,
          sourceType: snapshot.sourceType,
          path,
          originalPath: snapshot.originalPath,
          suggestedSavePath: snapshot.suggestedSavePath,
          untitledName: stemOf(snapshot.title),
          encoding,
          savedEncoding: encoding,
          encodingSource: path ? "detected" : "new",
          lineEnding: snapshot.lineEnding,
          savedLineEnding: snapshot.lineEnding,
          languageId: snapshot.languageId,
          detectedLanguage: detectTextLanguageKey(path, snapshot.draft.slice(0, languageSampleChars)),
          indentation: detectTextIndentation(snapshot.draft.slice(0, indentationSampleChars)),
          readOnly: stat?.readOnly ?? false,
          byteLen: stat?.byteLen ?? 0,
          modifiedAt: snapshot.baseModifiedAt ?? stat?.modifiedAt ?? null,
          externalChange: path ? (!stat ? "deleted" : changedOnDisk ? "changed" : null) : null,
          restoredDraftAt: snapshot.updatedAt,
        }),
      );
      beginLoad({ text: snapshot.draft, savedText: snapshot.baseContent });
    },
    [beginLoad, rememberSession, setDoc],
  );

  const resolveSaveFailure = useCallback(
    async (failure: TextIoError, name: string, canCreate: boolean): Promise<SaveFailureResolution> => {
      const ask = async (
        title: string,
        message: string,
        choices: Array<{ id: SaveFailureResolution; label: string; tone?: "danger" | "normal" | "primary" }>,
      ) => ((await requestChoice({ title, message, choices })) as SaveFailureResolution | null) ?? "cancel";

      switch (failure.code) {
        case "changed":
          return ask("File changed on disk", `Another program changed ${name} after LMP opened it.`, [
            { id: "reload", label: "Reload theirs" },
            { id: "overwrite", label: "Overwrite", tone: "danger" },
          ]);
        case "read-only":
          return ask("Read-only file", `${name} is marked read-only in Windows.`, [
            { id: "save-as", label: "Save As…" },
            { id: "clear-read-only", label: "Remove read-only and save", tone: "primary" },
          ]);
        case "access-denied":
          return ask("Can't save here", `${failure.message} Save a copy somewhere else?`, [
            { id: "save-as", label: "Save As…", tone: "primary" },
          ]);
        case "unrepresentable":
          return ask("Characters don't fit the encoding", failure.message, [
            { id: "utf-8", label: "Save as UTF-8", tone: "primary" },
          ]);
        case "missing":
          return canCreate
            ? ask("File missing", `${name} no longer exists. Save it again?`, [
                { id: "save-as", label: "Save As…" },
                { id: "create", label: "Save", tone: "primary" },
              ])
            : "cancel";
        default:
          showToast(failure.message, "error");
          return "cancel";
      }
    },
    [requestChoice, showToast],
  );

  const finishSave = useCallback(
    (
      previous: TextDocument,
      path: string,
      stat: TextFileStat,
      version: ReturnType<TextEditorHandle["snapshot"]>["version"],
      encoding: string,
    ) => {
      editorRef.current?.markSaved(version);
      const id = fileDraftId(path);
      if (previous.id !== id) {
        void clearDraft(previous.id);
      }
      void clearDraft(id);
      const pathLanguage = languageKeyFromPath(path);
      setDoc((current) =>
        current && current.id === previous.id
          ? {
              ...current,
              id,
              sourceType: "file",
              path,
              originalPath: null,
              suggestedSavePath: null,
              encoding,
              savedEncoding: encoding,
              // The file on disk now matches what LMP wrote, so a guessed encoding is settled.
              encodingSource: current.encodingSource === "fallback" ? "detected" : current.encodingSource,
              savedLineEnding: current.lineEnding,
              mixedLineEndings: false,
              decodeErrors: false,
              binary: false,
              readOnly: stat.readOnly,
              locked: false,
              byteLen: stat.byteLen,
              modifiedAt: stat.modifiedAt,
              externalChange: null,
              restoredDraftAt: null,
              languageId: current.languageId && current.languageId === pathLanguage ? null : current.languageId,
              detectedLanguage:
                previous.path === path
                  ? current.detectedLanguage
                  : detectTextLanguageKey(path, editorRef.current?.getSample(languageSampleChars) ?? ""),
            }
          : current,
      );
    },
    [clearDraft, setDoc],
  );

  const reloadFromDisk = useCallback(
    async (silent = false) => {
      const current = docRef.current;
      const editor = editorRef.current;
      if (!current?.path) {
        return;
      }
      const cursor = editor?.cursorOffset() ?? 0;
      try {
        const content = await invoke<TextFileContent>("read_text_file", {
          path: current.path,
          encoding: current.encodingSource === "forced" ? current.encoding : null,
        });
        if (docRef.current?.id !== current.id) {
          return;
        }
        const next = documentFromContent(current.id, current.path, content, current.languageId);
        setDoc({ ...next, encodingSource: current.encodingSource === "forced" ? "forced" : next.encodingSource, indentation: current.indentation ?? next.indentation });
        beginLoad({ text: content.content, cursor });
        await clearDraft(current.id);
        if (!silent) {
          showToast(`Reloaded ${fileName(current.path)} from disk.`, "info");
        }
      } catch (error) {
        const failure = parseTextIoError(error);
        if (failure.code === "missing") {
          patchDoc(current.id, { externalChange: "deleted" });
          return;
        }
        showToast(failure.message, "error");
      }
    },
    [beginLoad, clearDraft, patchDoc, setDoc, showToast],
  );

  const saveAs = useCallback(
    async (overrides: SaveOverrides = {}): Promise<boolean> => {
      const current = docRef.current;
      const editor = editorRef.current;
      if (!current || !editor || current.loading || current.error) {
        return false;
      }
      const languageKey = current.languageId ?? current.detectedLanguage;
      const suggestedName = current.path
        ? fileName(current.path)
        : current.suggestedSavePath
          ? fileName(current.suggestedSavePath)
          : `${current.untitledName}.${defaultExtensionForLanguage(languageKey)}`;
      const nameExtension = extension(suggestedName);
      const option =
        textLanguageOptions.find((candidate) => candidate.extensions.includes(nameExtension)) ??
        textLanguageOption(languageKey);
      const filterExtensions = nameExtension
        ? [nameExtension, ...option.extensions.filter((candidate) => candidate !== nameExtension)]
        : option.extensions;

      let target: string | null;
      try {
        target = await invoke<string | null>("choose_text_save_path", {
          directoryHint: directoryFromPath(current.path ?? current.suggestedSavePath ?? current.originalPath),
          fileName: suggestedName,
          filterName: textLanguageLabelForKey(option.key),
          filterExtensions,
        });
      } catch (error) {
        showToast(parseTextIoError(error).message, "error");
        return false;
      }
      if (!target) {
        return false;
      }

      let encoding = normalizeTextEncodingId(overrides.encoding ?? current.encoding);
      let overwriteReadOnly = false;
      const { text, version } = editor.snapshot();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const stat = await invoke<TextFileStat>("write_text_file", {
            path: target,
            content: text,
            lineEnding: current.lineEnding,
            encoding,
            expectedModifiedAt: null,
            overwriteReadOnly,
            create: true,
          });
          finishSave(current, target, stat, version, encoding);
          onDocumentPathChangeRef.current(target, stat);
          showToast(`Saved as ${fileName(target)}.`, "success");
          return true;
        } catch (error) {
          const resolution = await resolveSaveFailure(parseTextIoError(error), fileName(target), false);
          if (resolution === "clear-read-only") {
            overwriteReadOnly = true;
          } else if (resolution === "utf-8") {
            encoding = "utf-8";
          } else if (resolution === "save-as") {
            return saveAs({ encoding });
          } else {
            return false;
          }
        }
      }
      return false;
    },
    [finishSave, resolveSaveFailure, showToast],
  );

  const save = useCallback(
    async (overrides: SaveOverrides = {}): Promise<boolean> => {
      const current = docRef.current;
      const editor = editorRef.current;
      if (!current || !editor || current.loading || current.error) {
        return false;
      }
      if (current.sourceType !== "file" || !current.path) {
        return saveAs(overrides);
      }

      const path = current.path;
      let encoding = normalizeTextEncodingId(overrides.encoding ?? current.encoding);
      let expectedModifiedAt = current.modifiedAt;
      let overwriteReadOnly = false;
      let create = current.externalChange === "deleted";
      const { text, version } = editor.snapshot();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          const stat = await invoke<TextFileStat>("write_text_file", {
            path,
            content: text,
            lineEnding: current.lineEnding,
            encoding,
            expectedModifiedAt,
            overwriteReadOnly,
            create,
          });
          finishSave(current, path, stat, version, encoding);
          showToast(`Saved ${fileName(path)}.`, "success");
          return true;
        } catch (error) {
          const resolution = await resolveSaveFailure(parseTextIoError(error), fileName(path), true);
          switch (resolution) {
            case "overwrite":
              expectedModifiedAt = null;
              break;
            case "clear-read-only":
              overwriteReadOnly = true;
              break;
            case "utf-8":
              encoding = "utf-8";
              break;
            case "create":
              create = true;
              break;
            case "save-as":
              return saveAs({ encoding });
            case "reload":
              await reloadFromDisk();
              return false;
            default:
              return false;
          }
        }
      }
      return false;
    },
    [finishSave, reloadFromDisk, resolveSaveFailure, saveAs, showToast],
  );

  const confirmLeave = useCallback(async () => {
    const current = docRef.current;
    if (!current || !isDirtyNow()) {
      return true;
    }
    const choice = await requestChoice({
      title: "Save changes?",
      message: `Do you want to save the changes to ${titleFor(current)}?`,
      choices: [
        { id: "discard", label: "Don't Save", tone: "danger" },
        { id: "save", label: current.sourceType === "file" ? "Save" : "Save As…", tone: "primary" },
      ],
    });
    if (choice === "save") {
      return save();
    }
    if (choice === "discard") {
      await clearDraft(current.id);
      return true;
    }
    return false;
  }, [clearDraft, isDirtyNow, requestChoice, save, titleFor]);

  const revert = useCallback(async () => {
    const current = docRef.current;
    const editor = editorRef.current;
    if (!current || !editor) {
      return;
    }
    if (!isDirtyNow()) {
      showToast("No unsaved changes.", "info");
      return;
    }
    const allowed = await requestConfirm({
      title: "Revert to saved?",
      message: `Discard all unsaved changes to ${titleFor(current)}?`,
      confirmLabel: "Revert",
      tone: "danger",
    });
    if (!allowed) {
      return;
    }
    editor.revert();
    patchDoc(current.id, {
      encoding: current.savedEncoding,
      lineEnding: current.savedLineEnding,
      restoredDraftAt: null,
    });
    await clearDraft(current.id);
    showToast("Reverted to the saved version.", "info");
  }, [clearDraft, isDirtyNow, patchDoc, requestConfirm, showToast, titleFor]);

  const reopenWithEncoding = useCallback(
    async (encoding: string) => {
      const current = docRef.current;
      const editor = editorRef.current;
      if (!current?.path || current.sourceType !== "file") {
        return;
      }
      if (isDirtyNow()) {
        const allowed = await requestConfirm({
          title: "Reopen with encoding",
          message: "Reopening the file discards your unsaved changes.",
          confirmLabel: "Discard and reopen",
          tone: "danger",
        });
        if (!allowed) {
          return;
        }
      }
      const cursor = editor?.cursorOffset() ?? 0;
      try {
        const content = await invoke<TextFileContent>("read_text_file", { path: current.path, encoding });
        if (docRef.current?.id !== current.id) {
          return;
        }
        const next = documentFromContent(current.id, current.path, content, current.languageId);
        setDoc({ ...next, encodingSource: "forced", indentation: current.indentation ?? next.indentation });
        beginLoad({ text: content.content, cursor });
        await clearDraft(current.id);
        showToast(`Reopened as ${textEncodingLabel(encoding)}.`, "info");
      } catch (error) {
        showToast(parseTextIoError(error).message, "error");
      }
    },
    [beginLoad, clearDraft, isDirtyNow, requestConfirm, setDoc, showToast],
  );

  const saveWithEncoding = useCallback(
    async (encoding: string) => {
      const current = docRef.current;
      if (!current) {
        return;
      }
      await save({ encoding });
    },
    [save],
  );

  const setLineEnding = useCallback(
    (lineEnding: TextLineEnding) => {
      const current = docRef.current;
      if (current && !current.locked) {
        patchDoc(current.id, { lineEnding });
      }
    },
    [patchDoc],
  );

  const setLanguage = useCallback(
    (languageId: TextLanguageKey | null) => {
      const current = docRef.current;
      if (!current) {
        return;
      }
      const patch: Partial<TextDocument> = { languageId };
      if (languageId === "batch" && current.sourceType === "untitled" && !contentDirtyRef.current) {
        patch.lineEnding = "crlf";
        patch.savedLineEnding = "crlf";
      }
      patchDoc(current.id, patch);
    },
    [patchDoc],
  );

  const setIndentation = useCallback(
    (indentation: TextIndentation) => {
      const current = docRef.current;
      if (current) {
        patchDoc(current.id, { indentation });
      }
    },
    [patchDoc],
  );

  const unlock = useCallback(() => {
    const current = docRef.current;
    if (current) {
      patchDoc(current.id, { locked: false });
    }
  }, [patchDoc]);

  const keepLocalVersion = useCallback(async () => {
    const current = docRef.current;
    if (!current?.path) {
      return;
    }
    const stat = await invoke<TextFileStat | null>("stat_text_file", { path: current.path }).catch(() => undefined);
    if (stat === undefined) {
      return;
    }
    patchDoc(
      current.id,
      stat
        ? { externalChange: null, modifiedAt: stat.modifiedAt, readOnly: stat.readOnly }
        : { externalChange: "deleted" },
    );
  }, [patchDoc]);

  const discardRestoredDraft = useCallback(async () => {
    const current = docRef.current;
    const editor = editorRef.current;
    if (!current || !editor) {
      return;
    }
    const allowed = await requestConfirm({
      title: "Discard draft?",
      message:
        current.sourceType === "file"
          ? "The editor goes back to the version saved on disk."
          : "The restored text is removed.",
      confirmLabel: "Discard",
      tone: "danger",
    });
    if (!allowed) {
      return;
    }
    editor.revert();
    patchDoc(current.id, {
      encoding: current.savedEncoding,
      lineEnding: current.savedLineEnding,
      restoredDraftAt: null,
    });
    await clearDraft(current.id);
  }, [clearDraft, patchDoc, requestConfirm]);

  const dismissRestoredNotice = useCallback(() => {
    const current = docRef.current;
    if (current) {
      patchDoc(current.id, { restoredDraftAt: null });
    }
  }, [patchDoc]);

  // Notice changes made by other programs when the window regains focus.
  const checkDisk = useCallback(async () => {
    const current = docRef.current;
    if (!current?.path || current.sourceType !== "file" || current.loading || current.externalChange) {
      return;
    }
    const stat = await invoke<TextFileStat | null>("stat_text_file", { path: current.path }).catch(() => undefined);
    const latest = docRef.current;
    if (stat === undefined || !latest || latest.id !== current.id || latest.externalChange) {
      return;
    }
    if (!stat) {
      patchDoc(current.id, { externalChange: "deleted" });
      return;
    }
    if (stat.readOnly !== latest.readOnly) {
      patchDoc(current.id, { readOnly: stat.readOnly });
    }
    if (latest.modifiedAt === null || stat.modifiedAt === null || stat.modifiedAt === latest.modifiedAt) {
      return;
    }
    if (!isDirtyNow() && !latest.large) {
      await reloadFromDisk(true);
      showToast(`${fileName(current.path)} changed on disk and was reloaded.`, "info");
      return;
    }
    patchDoc(current.id, { externalChange: "changed" });
  }, [isDirtyNow, patchDoc, reloadFromDisk, showToast]);

  const hasFileDocument = Boolean(doc?.path);
  useEffect(() => {
    if (!hasFileDocument) {
      return;
    }
    const onFocus = () => void checkDisk();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [checkDisk, hasFileDocument]);

  // Remember the cursor when the window is closed or reloaded.
  useEffect(() => {
    window.addEventListener("beforeunload", rememberSession);
    return () => window.removeEventListener("beforeunload", rememberSession);
  }, [rememberSession]);

  const dirty = Boolean(doc) && (contentDirty || isTextDocumentMetaDirty(doc));
  const languageKey: TextLanguageKey = doc ? doc.languageId ?? doc.detectedLanguage : "plain";
  const docIndentation = doc?.indentation ?? null;
  const settingsTabSize = settings.textTabSize;
  const indentation = useMemo<TextIndentation>(
    () => docIndentation ?? { useTabs: false, size: Math.max(1, Math.min(8, Math.round(settingsTabSize))) },
    [docIndentation, settingsTabSize],
  );
  const title = doc ? titleFor(doc) : "";

  /** Info shelf entries for the open document, read from the editor on demand. */
  const describe = useCallback((): MediaInspection | null => {
    const current = docRef.current;
    if (!current) {
      return null;
    }
    const editor = editorRef.current;
    const text = editor && !current.large ? editor.getText() : null;
    const words = text === null ? null : text.match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu)?.length ?? 0;
    const items: MediaInspectionItem[] = [
      { label: "Name", value: titleFor(current) },
      { label: "Folder", value: directoryFromPath(current.path ?? current.originalPath) ?? "Not saved yet" },
      {
        label: "Size on disk",
        value: current.byteLen > 0 ? formatBytes(current.byteLen) : current.path ? "Empty" : "-",
      },
      {
        label: "Modified",
        value: current.modifiedAt ? new Date(current.modifiedAt).toLocaleString() : "-",
      },
      {
        label: "Encoding",
        value: textEncodingLabel(current.encoding),
        detail:
          current.encodingSource === "bom"
            ? "Byte order mark"
            : current.encodingSource === "fallback"
              ? "Guessed (not valid UTF-8)"
              : current.encodingSource === "forced"
                ? "Chosen manually"
                : null,
      },
      {
        label: "Line endings",
        value: textLineEndingLabel(current.lineEnding),
        detail: current.mixedLineEndings ? "Mixed in the file on disk" : null,
      },
      { label: "Language", value: textLanguageLabelForKey(current.languageId ?? current.detectedLanguage), detail: current.languageId ? "Chosen manually" : "Detected" },
      { label: "Indentation", value: textIndentationLabel(current.indentation ?? indentation) },
      { label: "Lines", value: (editor?.lineCount() ?? 0).toLocaleString() },
      { label: "Characters", value: text === null ? "-" : text.length.toLocaleString() },
      { label: "Words", value: words === null ? "-" : words.toLocaleString() },
      {
        label: "Access",
        value: current.readOnly ? "Read-only" : current.sourceType === "word-extract" ? "Extracted copy" : "Read and write",
      },
    ];
    return { source: "LMP text editor", summary: items, details: "" };
  }, [indentation, titleFor]);

  const controller: TextEditorController = useMemo(
    () => ({
      consumeLoad,
      dirty,
      discardRestoredDraft,
      dismissRestoredNotice,
      doc,
      editorRef,
      handleDocState,
      handleSample,
      indentation,
      keepLocalVersion,
      languageKey,
      loadToken,
      reloadFromDisk: () => reloadFromDisk(false),
      reopenWithEncoding,
      revert,
      save: () => save(),
      saveAs: () => saveAs(),
      saveWithEncoding,
      setIndentation,
      setLanguage,
      setLineEnding,
      title,
      unlock,
    }),
    [
      consumeLoad,
      dirty,
      discardRestoredDraft,
      dismissRestoredNotice,
      doc,
      handleDocState,
      handleSample,
      indentation,
      keepLocalVersion,
      languageKey,
      loadToken,
      reloadFromDisk,
      reopenWithEncoding,
      revert,
      save,
      saveAs,
      saveWithEncoding,
      setIndentation,
      setLanguage,
      setLineEnding,
      title,
      unlock,
    ],
  );

  return {
    applyDraft,
    clearDraft,
    confirmLeave,
    controller,
    describe,
    drafts: recovery.drafts,
    draftsLoaded: recovery.loaded,
    newDocument,
    openFile,
    openWordExtract,
    readDraft,
    refreshDrafts,
    resetSession,
  };
}
