import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import type { ToastTone } from "../../app/appTypes";
import { fileName } from "../../lib/playerBrain";
import type { PlayerSettings } from "../../player/settings";
import type { MediaShelfMode } from "../../ui/MediaShelves";
import type { TextEditorController } from "./textController";
import type { TextCursorInfo, TextEditCommand, TextEditorDocState } from "./textEditorHandle";
import type { TextEditorSurfaceConfig } from "./TextEditorSurface";
import { TextFindBar } from "./TextFindBar";
import { TextGoToLine } from "./TextGoToLine";
import { textLanguageLabelForKey, type TextLanguageKey } from "./textLanguages";
import { textMenuAction, textMenuHeader, textMenuSeparator, type TextMenuItem } from "./TextMenu";
import { TextMenuBar } from "./TextMenuBar";
import { TextNotices, textNoticesFor } from "./TextNotices";
import { normalizeEditorPasteText } from "./textPaste";
import {
  collectTextMatches,
  emptyTextSearchResult,
  replacementsFor,
  type TextSearchOptions,
  type TextSearchResult,
} from "./textSearch";
import { textShortcutFor, textShortcutLabels } from "./textShortcuts";
import { countTextStats, type TextStats } from "./textStats";
import { TextStatusBar, type TextEncodingPicker } from "./TextStatusBar";
import { directoryFromPath, runCommandForTextFile, runLabelForCommand } from "./textTerminalRunner";

const TextEditorSurface = lazy(() =>
  import("./TextEditorSurface").then((module) => ({ default: module.TextEditorSurface })),
);
const TextTerminalPanel = lazy(() =>
  import("../../ui/TextTerminalPanel").then((module) => ({ default: module.TextTerminalPanel })),
);

export type TextWorkspaceHandle = {
  copy: () => void;
  cut: () => void;
  openFind: (replace?: boolean) => void;
  openGoToLine: () => void;
  paste: () => void;
  runCommand: (command: TextEditCommand) => void;
};

type TextShelf = "info" | "recent" | "settings";

type TextWorkspaceProps = {
  activeShelf: MediaShelfMode;
  controller: TextEditorController;
  isFullscreen: boolean;
  recentTextFiles: string[];
  settings: PlayerSettings;
  workspaceRef: RefObject<TextWorkspaceHandle | null>;
  onGoHome: () => void;
  onNew: (languageKey?: TextLanguageKey) => void;
  onOpen: () => void;
  onOpenLibrary: () => void;
  onOpenRecent: (path: string) => void;
  onPatchSettings: (patch: Partial<PlayerSettings>) => void;
  onShowInExplorer: (path: string) => void;
  onToggleFullscreen: () => void;
  onToggleShelf: (shelf: TextShelf) => void;
  showToast: (message: string, tone?: ToastTone) => void;
};

const defaultFontSize = 13;
const statsCharLimit = 2_000_000;
const largeSearchChars = 4_000_000;
const initialCursor: TextCursorInfo = { line: 1, column: 1, selections: 1, selectedChars: 0, selectedLines: 0 };

function clampFontSize(size: number) {
  return Math.max(10, Math.min(24, Math.round(size)));
}

export function TextWorkspace({
  activeShelf,
  controller,
  isFullscreen,
  recentTextFiles,
  settings,
  workspaceRef,
  onGoHome,
  onNew,
  onOpen,
  onOpenLibrary,
  onOpenRecent,
  onPatchSettings,
  onShowInExplorer,
  onToggleFullscreen,
  onToggleShelf,
  showToast,
}: TextWorkspaceProps) {
  const { doc, editorRef } = controller;
  const [cursor, setCursor] = useState<TextCursorInfo>(initialCursor);
  const [docState, setDocState] = useState<TextEditorDocState>({ dirty: false, length: 0, lines: 1 });
  const [docVersion, setDocVersion] = useState(0);
  const [stats, setStats] = useState<TextStats | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [searchOptions, setSearchOptions] = useState<TextSearchOptions>({
    query: "",
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });
  const [replacement, setReplacement] = useState("");
  const [searchResult, setSearchResult] = useState<TextSearchResult>(emptyTextSearchResult);
  const [activeMatch, setActiveMatch] = useState(-1);
  const [goToOpen, setGoToOpen] = useState(false);
  const [encodingPicker, setEncodingPicker] = useState<TextEncodingPicker>(null);
  const [dismissedNotices, setDismissedNotices] = useState<Set<string>>(() => new Set());
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalRunRequest, setTerminalRunRequest] = useState(0);
  // The terminal stays mounted once used so hiding it keeps the shell session.
  const [terminalMounted, setTerminalMounted] = useState(false);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const searchFromCursorRef = useRef(true);
  const advanceAfterReplaceRef = useRef<number | null>(null);

  // A new load is a new document; the surface reports its cursor itself.
  const loadToken = controller.loadToken;
  useEffect(() => {
    setDismissedNotices(new Set());
    setActiveMatch(-1);
    setEncodingPicker(null);
  }, [loadToken]);

  const handleDocState = useCallback(
    (state: TextEditorDocState) => {
      setDocState(state);
      setDocVersion((version) => version + 1);
      controller.handleDocState(state);
    },
    [controller],
  );

  // Word and character counts are recomputed once typing pauses.
  useEffect(() => {
    if (docState.length > statsCharLimit) {
      setStats(null);
      return;
    }
    const timer = window.setTimeout(() => {
      const text = editorRef.current?.getText();
      setStats(text === undefined ? null : countTextStats(text));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [docState.length, docVersion, editorRef]);

  // Search results follow the query and the document while the find bar is open.
  useEffect(() => {
    if (!findOpen || !searchOptions.query) {
      setSearchResult(emptyTextSearchResult);
      setActiveMatch(-1);
      return;
    }
    const delay = docState.length > largeSearchChars ? 320 : 90;
    const timer = window.setTimeout(() => {
      const editor = editorRef.current;
      if (!editor) {
        return;
      }
      const result = collectTextMatches(editor.getText(), searchOptions);
      setSearchResult(result);

      const advanceFrom = advanceAfterReplaceRef.current;
      if (advanceFrom !== null) {
        advanceAfterReplaceRef.current = null;
        const next = result.matches.findIndex((match) => match.start >= advanceFrom);
        const index = next >= 0 ? next : result.matches.length > 0 ? 0 : -1;
        setActiveMatch(index);
        if (index >= 0) {
          editor.selectRange(result.matches[index].start, result.matches[index].end);
        }
        return;
      }

      if (searchFromCursorRef.current) {
        // Typing a query jumps to the first hit after the cursor, like other editors.
        searchFromCursorRef.current = false;
        const from = editor.selection().from;
        const next = result.matches.findIndex((match) => match.start >= from);
        const index = next >= 0 ? next : result.matches.length > 0 ? 0 : -1;
        setActiveMatch(index);
        if (index >= 0) {
          editor.selectRange(result.matches[index].start, result.matches[index].end);
        }
        return;
      }
      setActiveMatch((current) => (current >= result.matches.length ? result.matches.length - 1 : current));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [docState.length, docVersion, editorRef, findOpen, searchOptions]);

  const updateSearchOptions = useCallback((patch: Partial<TextSearchOptions>) => {
    searchFromCursorRef.current = true;
    setSearchOptions((current) => ({ ...current, ...patch }));
  }, []);

  const openFind = useCallback(
    (replace = false) => {
      const editor = editorRef.current;
      const selected = editor?.selectedText() ?? "";
      if (selected && !selected.includes("\n") && selected.length <= 200) {
        updateSearchOptions({ query: selected });
      }
      setFindOpen(true);
      setGoToOpen(false);
      if (replace && !doc?.locked) {
        setReplaceOpen(true);
      }
      window.setTimeout(() => {
        const target = replace && !doc?.locked ? replaceInputRef.current : findInputRef.current;
        target?.focus();
        target?.select();
      }, 0);
    },
    [doc?.locked, editorRef, updateSearchOptions],
  );

  const closeFind = useCallback(() => {
    setFindOpen(false);
    editorRef.current?.focus();
  }, [editorRef]);

  const findMatch = useCallback(
    (direction: -1 | 1) => {
      const editor = editorRef.current;
      const matches = searchResult.matches;
      if (!editor) {
        return;
      }
      if (!findOpen || !searchOptions.query) {
        openFind();
        return;
      }
      if (matches.length === 0) {
        return;
      }
      let index: number;
      if (activeMatch >= 0 && activeMatch < matches.length) {
        index = (activeMatch + direction + matches.length) % matches.length;
      } else if (direction > 0) {
        const from = editor.selection().to;
        index = matches.findIndex((match) => match.start >= from);
        index = index < 0 ? 0 : index;
      } else {
        const from = editor.selection().from;
        index = -1;
        for (let candidate = matches.length - 1; candidate >= 0; candidate -= 1) {
          if (matches[candidate].end <= from) {
            index = candidate;
            break;
          }
        }
        index = index < 0 ? matches.length - 1 : index;
      }
      setActiveMatch(index);
      editor.selectRange(matches[index].start, matches[index].end);
    },
    [activeMatch, editorRef, findOpen, openFind, searchOptions.query, searchResult.matches],
  );

  const replaceCurrent = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || doc?.locked) {
      return;
    }
    const matches = searchResult.matches;
    const index = activeMatch >= 0 && activeMatch < matches.length ? activeMatch : -1;
    if (index < 0) {
      findMatch(1);
      return;
    }
    const [change] = replacementsFor(editor.getText(), searchOptions, replacement, [matches[index]]);
    if (!change) {
      return;
    }
    advanceAfterReplaceRef.current = change.from + change.insert.length;
    editor.replaceRange(change.from, change.to, change.insert);
  }, [activeMatch, doc?.locked, editorRef, findMatch, replacement, searchOptions, searchResult.matches]);

  const replaceAll = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || doc?.locked) {
      return;
    }
    const text = editor.getText();
    const { matches } = collectTextMatches(text, searchOptions, Number.POSITIVE_INFINITY);
    const changes = replacementsFor(text, searchOptions, replacement, matches);
    if (changes.length === 0) {
      showToast("No matches to replace.", "info");
      return;
    }
    editor.replaceRanges(changes);
    setActiveMatch(-1);
    showToast(`Replaced ${changes.length.toLocaleString()} match${changes.length === 1 ? "" : "es"}.`, "success");
  }, [doc?.locked, editorRef, replacement, searchOptions, showToast]);

  const openGoToLine = useCallback(() => {
    setGoToOpen(true);
  }, []);

  const runCommand = useCallback(
    (command: TextEditCommand) => {
      const editor = editorRef.current;
      if (!editor) {
        return;
      }
      if (doc?.locked && !["selectAll", "selectNextOccurrence", "selectAllOccurrences", "foldAll", "unfoldAll", "addCursorAbove", "addCursorBelow"].includes(command)) {
        showToast("Unlock the document to edit it.", "info");
        return;
      }
      editor.runCommand(command);
    },
    [doc?.locked, editorRef, showToast],
  );

  const copySelection = useCallback(
    async (cut: boolean) => {
      const editor = editorRef.current;
      const text = editor?.selectedText() ?? "";
      if (!editor || !text) {
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        if (cut && !doc?.locked) {
          editor.insertText("");
        }
      } catch {
        showToast(cut ? "Press Ctrl+X to cut." : "Press Ctrl+C to copy.", "info");
      }
    },
    [doc?.locked, editorRef, showToast],
  );

  const pasteClipboard = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor || doc?.locked) {
      return;
    }
    try {
      const plainText = await navigator.clipboard.readText();
      if (plainText) {
        editor.insertText(normalizeEditorPasteText({ plainText, mode: "plain" }).text);
      }
    } catch {
      showToast("Press Ctrl+V to paste.", "info");
    }
  }, [doc?.locked, editorRef, showToast]);

  useImperativeHandle(
    workspaceRef,
    () => ({
      copy: () => void copySelection(false),
      cut: () => void copySelection(true),
      openFind,
      openGoToLine,
      paste: () => void pasteClipboard(),
      runCommand,
    }),
    [copySelection, openFind, openGoToLine, pasteClipboard, runCommand],
  );

  const fontSize = clampFontSize(settings.textFontSize);
  // The zoom badge only appears once the user zoomed; the font size itself is a setting.
  const [zoomTouched, setZoomTouched] = useState(false);
  const zoom = useCallback(
    (direction: -1 | 0 | 1) => {
      setZoomTouched(direction !== 0);
      onPatchSettings({ textFontSize: direction === 0 ? defaultFontSize : clampFontSize(fontSize + direction) });
    },
    [fontSize, onPatchSettings],
  );

  // Text shortcuts work wherever focus is inside the workspace window.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = textShortcutFor(event);
      if (!shortcut) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const inEditor = Boolean(target?.closest(".cm-editor"));
      const inField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
      if (target?.closest(".text-terminal-panel, .confirm-backdrop")) {
        return;
      }
      if ((shortcut === "undo" || shortcut === "redo") && (inEditor || inField)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      switch (shortcut) {
        case "new":
          onNew();
          break;
        case "open":
          onOpen();
          break;
        case "save":
          void controller.save();
          break;
        case "saveAs":
          void controller.saveAs();
          break;
        case "find":
          openFind(false);
          break;
        case "replace":
          openFind(true);
          break;
        case "findNext":
          findMatch(1);
          break;
        case "findPrevious":
          findMatch(-1);
          break;
        case "goToLine":
          openGoToLine();
          break;
        case "close":
          onGoHome();
          break;
        case "undo":
          editorRef.current?.runCommand("undo");
          break;
        case "redo":
          editorRef.current?.runCommand("redo");
          break;
        case "toggleWrap":
          onPatchSettings({ textWordWrap: !settings.textWordWrap });
          break;
        case "zoomIn":
          zoom(1);
          break;
        case "zoomOut":
          zoom(-1);
          break;
        case "zoomReset":
          zoom(0);
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    controller,
    editorRef,
    findMatch,
    onGoHome,
    onNew,
    onOpen,
    onPatchSettings,
    openFind,
    openGoToLine,
    settings.textWordWrap,
    zoom,
  ]);

  const consumeLoad = controller.consumeLoad;
  const handleSample = controller.handleSample;
  const languageKey = controller.languageKey;
  const indentation = controller.indentation;

  const filePath = doc?.path ?? null;
  const terminalFilePath = filePath ?? doc?.originalPath ?? null;
  const terminalCommand = settings.enableIntegratedTerminal
    ? runCommandForTextFile(filePath, editorRef.current?.getSample(4000) ?? "")
    : null;
  const terminalRunTitle = controller.dirty
    ? "Save the file to run the latest changes"
    : terminalCommand ?? "No runnable file detected";

  useEffect(() => {
    if (!settings.enableIntegratedTerminal) {
      setTerminalOpen(false);
      setTerminalMounted(false);
    } else if (terminalOpen) {
      setTerminalMounted(true);
    }
  }, [settings.enableIntegratedTerminal, terminalOpen]);

  const surfaceConfig: TextEditorSurfaceConfig = {
    autoCloseBrackets: settings.textAutoCloseBrackets,
    editable: Boolean(doc && !doc.locked && !doc.loading && !doc.error),
    fontFamily: settings.textFontFamily,
    fontSize,
    highlight: settings.textSyntaxHighlighting && !doc?.large,
    indentWithTabs: indentation.useTabs,
    languageKey,
    large: Boolean(doc?.large),
    lineNumbers: settings.textLineNumbers,
    showWhitespace: settings.textShowWhitespace,
    tabSize: indentation.size,
    wordWrap: settings.textWordWrap,
    writingMode: settings.textWritingMode,
  };

  const notices = useMemo(
    () =>
      doc
        ? textNoticesFor(doc, {
            dirty: controller.dirty,
            onDiscardRestoredDraft: () => void controller.discardRestoredDraft(),
            onDismissRestored: controller.dismissRestoredNotice,
            onKeepLocal: () => void controller.keepLocalVersion(),
            onPickEncoding: () => setEncodingPicker("reopen"),
            onReload: () => void controller.reloadFromDisk(),
            onSave: () => void controller.save(),
            onSaveAs: () => void controller.saveAs(),
            onUnlock: controller.unlock,
          })
        : [],
    [controller, doc],
  );

  const recentItems = recentTextFiles
    .filter((path) => path !== filePath)
    .slice(0, 6)
    .map((path) => textMenuAction(`recent-${path}`, fileName(path), () => onOpenRecent(path), { detail: directoryFromPath(path) ?? undefined }));

  const fileMenu = (): TextMenuItem[] => [
    textMenuAction("new", "New Text File", () => onNew(), { shortcut: textShortcutLabels.new }),
    textMenuAction("new-markdown", "New Markdown File", () => onNew("markdown")),
    textMenuAction("new-json", "New JSON File", () => onNew("json")),
    textMenuSeparator("open-separator"),
    textMenuAction("open", "Open…", onOpen, { shortcut: textShortcutLabels.open }),
    ...(recentItems.length > 0 ? [textMenuHeader("recent", "Recent"), ...recentItems] : []),
    textMenuSeparator("save-separator"),
    textMenuAction("save", "Save", () => void controller.save(), {
      shortcut: textShortcutLabels.save,
      disabled: !doc || doc.loading,
    }),
    textMenuAction("save-as", "Save As…", () => void controller.saveAs(), {
      shortcut: textShortcutLabels.saveAs,
      disabled: !doc || doc.loading,
    }),
    textMenuAction("save-encoding", "Save with Encoding…", () => setEncodingPicker("save"), {
      disabled: !doc || doc.loading || doc.locked,
    }),
    textMenuAction("reopen-encoding", "Reopen with Encoding…", () => setEncodingPicker("reopen"), {
      disabled: !doc || doc.sourceType !== "file" || !doc.path,
    }),
    textMenuAction("revert", "Revert to Saved", () => void controller.revert(), { disabled: !controller.dirty }),
    textMenuSeparator("file-separator"),
    textMenuAction("explorer", "Show in Explorer", () => filePath && onShowInExplorer(filePath), {
      disabled: !filePath,
    }),
    textMenuAction(
      "copy-path",
      "Copy Path",
      () => {
        if (filePath) {
          void navigator.clipboard.writeText(filePath).then(
            () => showToast("Path copied.", "success"),
            () => showToast("Could not copy the path.", "error"),
          );
        }
      },
      { disabled: !filePath },
    ),
    textMenuSeparator("close-separator"),
    textMenuAction("close", "Close", onGoHome, { shortcut: textShortcutLabels.close }),
  ];

  const locked = Boolean(doc?.locked);
  const editMenu = (): TextMenuItem[] => [
    textMenuAction("undo", "Undo", () => runCommand("undo"), { shortcut: textShortcutLabels.undo, disabled: locked }),
    textMenuAction("redo", "Redo", () => runCommand("redo"), { shortcut: textShortcutLabels.redo, disabled: locked }),
    textMenuSeparator("clipboard-separator"),
    textMenuAction("cut", "Cut", () => void copySelection(true), { shortcut: "Ctrl+X", disabled: locked || cursor.selectedChars === 0 }),
    textMenuAction("copy", "Copy", () => void copySelection(false), { shortcut: "Ctrl+C", disabled: cursor.selectedChars === 0 }),
    textMenuAction("paste", "Paste", () => void pasteClipboard(), { shortcut: "Ctrl+V", disabled: locked }),
    textMenuAction("select-all", "Select All", () => runCommand("selectAll"), { shortcut: "Ctrl+A" }),
    textMenuSeparator("find-separator"),
    textMenuAction("find", "Find", () => openFind(false), { shortcut: textShortcutLabels.find }),
    textMenuAction("replace", "Replace", () => openFind(true), { shortcut: textShortcutLabels.replace, disabled: locked }),
    textMenuAction("go-to-line", "Go to Line…", openGoToLine, { shortcut: textShortcutLabels.goToLine }),
    textMenuSeparator("line-separator"),
    textMenuAction("comment", "Toggle Comment", () => runCommand("toggleComment"), { shortcut: "Ctrl+/", disabled: locked }),
    textMenuAction("duplicate", "Duplicate Line", () => runCommand("duplicateLine"), { shortcut: "Shift+Alt+↓", disabled: locked }),
    textMenuAction("delete-line", "Delete Line", () => runCommand("deleteLine"), { shortcut: "Ctrl+Shift+K", disabled: locked }),
    textMenuAction("move-up", "Move Line Up", () => runCommand("moveLineUp"), { shortcut: "Alt+↑", disabled: locked }),
    textMenuAction("move-down", "Move Line Down", () => runCommand("moveLineDown"), { shortcut: "Alt+↓", disabled: locked }),
    textMenuAction("next-occurrence", "Add Next Occurrence", () => runCommand("selectNextOccurrence"), { shortcut: "Ctrl+D" }),
    textMenuAction("all-occurrences", "Select All Occurrences", () => runCommand("selectAllOccurrences"), { shortcut: "Ctrl+Shift+L" }),
    textMenuAction("cursor-above", "Add Cursor Above", () => runCommand("addCursorAbove"), { shortcut: "Ctrl+Alt+↑" }),
    textMenuAction("cursor-below", "Add Cursor Below", () => runCommand("addCursorBelow"), { shortcut: "Ctrl+Alt+↓" }),
    textMenuHeader("transform", "Transform"),
    textMenuAction("upper", "UPPERCASE", () => runCommand("upperCase"), { disabled: locked }),
    textMenuAction("lower", "lowercase", () => runCommand("lowerCase"), { disabled: locked }),
    textMenuAction("title", "Title Case", () => runCommand("titleCase"), { disabled: locked }),
    textMenuAction("sort-asc", "Sort Lines Ascending", () => runCommand("sortLinesAscending"), { disabled: locked }),
    textMenuAction("sort-desc", "Sort Lines Descending", () => runCommand("sortLinesDescending"), { disabled: locked }),
    textMenuAction("dedupe", "Remove Duplicate Lines", () => runCommand("removeDuplicateLines"), { disabled: locked }),
    textMenuAction("join", "Join Lines", () => runCommand("joinLines"), { disabled: locked }),
    textMenuAction("trim", "Trim Trailing Whitespace", () => runCommand("trimTrailingWhitespace"), { disabled: locked }),
  ];

  const viewMenu = (): TextMenuItem[] => [
    textMenuAction("wrap", "Word Wrap", () => onPatchSettings({ textWordWrap: !settings.textWordWrap }), {
      checked: settings.textWordWrap,
      shortcut: textShortcutLabels.toggleWrap,
    }),
    textMenuAction("line-numbers", "Line Numbers", () => onPatchSettings({ textLineNumbers: !settings.textLineNumbers }), {
      checked: settings.textLineNumbers,
    }),
    textMenuAction("whitespace", "Show Whitespace", () => onPatchSettings({ textShowWhitespace: !settings.textShowWhitespace }), {
      checked: settings.textShowWhitespace,
    }),
    textMenuAction(
      "highlighting",
      "Syntax Highlighting",
      () => onPatchSettings({ textSyntaxHighlighting: !settings.textSyntaxHighlighting }),
      { checked: settings.textSyntaxHighlighting, detail: doc?.large ? "Off for large files" : undefined },
    ),
    textMenuAction(
      "brackets",
      "Auto-close Brackets",
      () => onPatchSettings({ textAutoCloseBrackets: !settings.textAutoCloseBrackets }),
      { checked: settings.textAutoCloseBrackets },
    ),
    textMenuAction("writing", "Writing Mode", () => onPatchSettings({ textWritingMode: !settings.textWritingMode }), {
      checked: settings.textWritingMode,
    }),
    textMenuSeparator("zoom-separator"),
    textMenuAction("zoom-in", "Zoom In", () => zoom(1), { shortcut: textShortcutLabels.zoomIn, disabled: fontSize >= 24 }),
    textMenuAction("zoom-out", "Zoom Out", () => zoom(-1), { shortcut: textShortcutLabels.zoomOut, disabled: fontSize <= 10 }),
    textMenuAction("zoom-reset", "Reset Zoom", () => zoom(0), { shortcut: textShortcutLabels.zoomReset, disabled: fontSize === defaultFontSize }),
    textMenuSeparator("fold-separator"),
    textMenuAction("fold", "Fold All", () => runCommand("foldAll"), { disabled: Boolean(doc?.large) }),
    textMenuAction("unfold", "Unfold All", () => runCommand("unfoldAll"), { disabled: Boolean(doc?.large) }),
    textMenuSeparator("window-separator"),
    textMenuAction("fullscreen", isFullscreen ? "Exit Fullscreen" : "Fullscreen", onToggleFullscreen),
    ...(settings.enableIntegratedTerminal
      ? [textMenuAction("terminal", "Terminal", () => setTerminalOpen((open) => !open), { checked: terminalOpen })]
      : []),
    textMenuSeparator("shelf-separator"),
    textMenuAction("shelf-recent", "Recent Files", () => onToggleShelf("recent"), {
      checked: activeShelf === "recent",
      disabled: !settings.rememberRecentMedia,
    }),
    textMenuAction("shelf-library", "Folder Library", onOpenLibrary, { checked: activeShelf === "library" }),
    textMenuAction("shelf-info", "Document Info", () => onToggleShelf("info"), { checked: activeShelf === "info" }),
    textMenuAction("shelf-settings", "Text Settings", () => onToggleShelf("settings"), { checked: activeShelf === "settings" }),
  ];

  if (!doc) {
    return null;
  }

  const saveTitle = doc.sourceType === "file" ? "Save (Ctrl+S)" : "Save As (Ctrl+S)";
  const directory = directoryFromPath(filePath ?? doc.originalPath);
  const zoomPercent = zoomTouched ? Math.round((fontSize / defaultFontSize) * 100) : 100;

  return (
    <div className={`text-viewport ${settings.textWritingMode ? "is-writing-mode" : ""}`}>
      <TextMenuBar
        dirty={controller.dirty}
        directory={directory}
        editMenu={editMenu}
        fileMenu={fileMenu}
        saveTitle={saveTitle}
        terminalAvailable={settings.enableIntegratedTerminal}
        terminalOpen={terminalOpen}
        terminalRunLabel={terminalCommand ? runLabelForCommand(terminalCommand) : null}
        terminalRunTitle={terminalRunTitle}
        title={controller.title}
        viewMenu={viewMenu}
        onFind={() => openFind(false)}
        onRun={() => {
          setTerminalOpen(true);
          setTerminalRunRequest((value) => value + 1);
        }}
        onSave={() => void controller.save()}
        onToggleTerminal={() => setTerminalOpen((open) => !open)}
      />

      <TextNotices
        dismissed={dismissedNotices}
        notices={notices}
        onDismiss={(id) => setDismissedNotices((current) => new Set(current).add(id))}
      />

      <div className="text-editor-frame">
        <Suspense fallback={<div className="text-status">Loading editor…</div>}>
          <TextEditorSurface
            activeSearchIndex={activeMatch}
            autoDetectSample={doc.sourceType !== "file" && doc.languageId === null}
            config={surfaceConfig}
            consumeLoad={consumeLoad}
            editorRef={editorRef}
            loadToken={controller.loadToken}
            onCursor={setCursor}
            onDocState={handleDocState}
            onSample={handleSample}
            searchMatches={findOpen ? searchResult.matches : emptyTextSearchResult.matches}
          />
        </Suspense>

        {findOpen ? (
          <TextFindBar
            activeIndex={activeMatch}
            error={searchResult.error}
            findInputRef={findInputRef}
            matchCount={searchResult.matches.length}
            options={searchOptions}
            readOnly={doc.locked}
            replaceInputRef={replaceInputRef}
            replaceOpen={replaceOpen}
            replacement={replacement}
            truncated={searchResult.truncated}
            onClose={closeFind}
            onFind={findMatch}
            onOptionsChange={updateSearchOptions}
            onReplace={replaceCurrent}
            onReplaceAll={replaceAll}
            onReplaceOpenChange={(open) => {
              setReplaceOpen(open);
              if (open) {
                window.setTimeout(() => replaceInputRef.current?.focus(), 0);
              }
            }}
            onReplacementChange={setReplacement}
          />
        ) : null}

        {goToOpen ? (
          <TextGoToLine
            currentLine={cursor.line}
            lineCount={docState.lines}
            onClose={() => setGoToOpen(false)}
            onGo={(line, column) => {
              setGoToOpen(false);
              editorRef.current?.goToLine(line, column);
            }}
          />
        ) : null}

        {doc.loading ? <div className="text-status">Loading {controller.title}…</div> : null}
        {doc.error ? <div className="text-status error">{doc.error}</div> : null}
      </div>

      {settings.enableIntegratedTerminal && (terminalOpen || terminalMounted) ? (
        <Suspense fallback={null}>
          <TextTerminalPanel
            open={terminalOpen}
            cwd={directoryFromPath(terminalFilePath)}
            runCommand={terminalCommand}
            runLabel={terminalCommand ? runLabelForCommand(terminalCommand) : null}
            runRequestId={terminalRunRequest}
            runTitle={terminalRunTitle}
            onClose={() => setTerminalOpen(false)}
          />
        </Suspense>
      ) : null}

      <TextStatusBar
        cursor={cursor}
        dirty={controller.dirty}
        doc={doc}
        encodingPicker={encodingPicker}
        indentation={indentation}
        languageKey={languageKey}
        lines={docState.lines}
        stats={stats}
        zoomPercent={zoomPercent}
        onConvertIndentation={(toTabs) => runCommand(toTabs ? "indentToTabs" : "indentToSpaces")}
        onEncodingPickerChange={setEncodingPicker}
        onGoToLine={openGoToLine}
        onIndentationChange={controller.setIndentation}
        onLanguageChange={(key) => {
          controller.setLanguage(key);
          showToast(`Language: ${key ? textLanguageLabelForKey(key) : "Auto detect"}`, "info");
        }}
        onLineEndingChange={controller.setLineEnding}
        onReopenWithEncoding={(encoding) => void controller.reopenWithEncoding(encoding)}
        onResetZoom={() => zoom(0)}
        onSaveWithEncoding={(encoding) => void controller.saveWithEncoding(encoding)}
        onToggleLock={() => (doc.locked ? controller.unlock() : undefined)}
      />
    </div>
  );
}
