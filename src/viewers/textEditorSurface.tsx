import { minimalSetup, EditorView } from "codemirror";
import {
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
} from "@codemirror/state";
import {
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { indentWithTab, redo, undo } from "@codemirror/commands";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";

import { TextTerminalPanel } from "../ui/TextTerminalPanel";
import {
  type TextEditorHandle,
  type TextViewState,
  textLineEndingLabel,
} from "./text";
import { editorPasteTextFromClipboard } from "./textClipboard";
import { type EditorPasteMode } from "./textPaste";
import {
  detectTextLanguageKey,
  loadTextLanguageExtensionForKey,
  type TextLanguageKey,
  textLanguageLabelForKey,
} from "./textEditorLanguages";
import { searchHighlightField, updateSearchHighlights } from "./textEditorSearch";
import { lmpEditorTheme, lmpHighlightStyle, type TextFontFamily } from "./textEditorTheme";
import { countTextStats, formatTextStats } from "./textStats";
import { directoryFromPath, runCommandForTextFile, runLabelForCommand } from "./textTerminalRunner";
import type { TextMatch } from "./textSearch";

type TextEditorSurfaceProps = {
  activeSearchIndex: number;
  autoCloseBrackets: boolean;
  enableIntegratedTerminal: boolean;
  fontFamily: TextFontFamily;
  fontSize: number;
  lineNumbersVisible: boolean;
  path: string | null;
  searchMatches: TextMatch[];
  syntaxHighlightingEnabled: boolean;
  tabSize: number;
  title: string;
  view: TextViewState;
  writingMode: boolean;
  onChange: (draft: string) => void;
  editorRef: RefObject<TextEditorHandle | null>;
  wordWrap: boolean;
};

function clampEditorNumber(value: number, fallback: number, min: number, max: number) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
}

function tabExtensions(tabSize: number): Extension {
  const size = clampEditorNumber(tabSize, 2, 1, 8);
  return [EditorState.tabSize.of(size), indentUnit.of(" ".repeat(size))];
}

function lineNumberExtensions(visible: boolean): Extension {
  return visible ? [lineNumbers(), highlightActiveLineGutter()] : [];
}

function textPasteModeFor(writingMode: boolean, languageKey: TextLanguageKey): EditorPasteMode {
  if (writingMode) {
    return "writing";
  }

  return languageKey === "plain" || languageKey === "plain-hints" || languageKey === "markdown"
    ? "plain"
    : "code";
}

function cursorPositionFor(editor: EditorView) {
  const head = editor.state.selection.main.head;
  const line = editor.state.doc.lineAt(head);
  return {
    line: line.number,
    column: head - line.from + 1,
  };
}

export function TextEditorSurface({
  activeSearchIndex,
  autoCloseBrackets,
  enableIntegratedTerminal,
  fontFamily,
  fontSize,
  lineNumbersVisible,
  path,
  searchMatches,
  syntaxHighlightingEnabled,
  tabSize,
  title,
  view,
  writingMode,
  onChange,
  editorRef,
  wordWrap,
}: TextEditorSurfaceProps) {
  const [textTerminalOpen, setTextTerminalOpen] = useState(false);
  const [terminalRunRequestId, setTerminalRunRequestId] = useState(0);
  const pasteModeRef = useRef<EditorPasteMode>("plain");

  const terminalFilePath = path ?? view.savePath ?? view.originalPath;
  const terminalCwd = directoryFromPath(terminalFilePath);
  const terminalRunCommand = runCommandForTextFile(terminalFilePath, view.draft);
  const terminalRunLabel = runLabelForCommand(terminalRunCommand);
  const terminalRunTitle = view.dirty
    ? "Save file to run latest changes"
    : terminalRunCommand ?? "No runnable file detected";

  const languagePath = path ?? view.savePath ?? view.originalPath;
  const languageKey = useMemo(
    () => detectTextLanguageKey(languagePath, view.draft),
    [languagePath, view.draft],
  );
  const language = textLanguageLabelForKey(languageKey);
  const pasteMode = useMemo(
    () => textPasteModeFor(writingMode, languageKey),
    [languageKey, writingMode],
  );
  const effectiveWordWrap = writingMode || wordWrap;
  const originalPathParts = view.originalPath?.split(/[\\/]/).filter(Boolean) ?? [];
  const originalName = view.originalPath
    ? originalPathParts[originalPathParts.length - 1] ?? view.originalPath
    : title;
  const visibleSummary = `${view.lineCount.toLocaleString()} lines`;
  const textStats = useMemo(() => countTextStats(view.draft), [view.draft]);
  const textStatsLabel = formatTextStats(textStats);
  const technicalSummary = [language, textLineEndingLabel(view.lineEnding), view.encoding]
    .filter(Boolean)
    .join(" - ");
  const [cursorPosition, setCursorPosition] = useState({ column: 1, line: 1 });
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const focusedPathRef = useRef<string | null>(null);
  const wrapCompartment = useMemo(() => new Compartment(), []);
  const bracketsCompartment = useMemo(() => new Compartment(), []);
  const languageCompartment = useMemo(() => new Compartment(), []);
  const highlightCompartment = useMemo(() => new Compartment(), []);
  const editableCompartment = useMemo(() => new Compartment(), []);
  const lineNumberCompartment = useMemo(() => new Compartment(), []);
  const tabCompartment = useMemo(() => new Compartment(), []);
  const themeCompartment = useMemo(() => new Compartment(), []);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    pasteModeRef.current = pasteMode;
  }, [pasteMode]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const editor = new EditorView({
      parent: host,
      doc: view.draft,
      extensions: [
        minimalSetup,
        keymap.of([indentWithTab]),
        bracketsCompartment.of([]),
        highlightActiveLine(),
        searchHighlightField,
        themeCompartment.of(lmpEditorTheme(fontSize, fontFamily, writingMode)),
        highlightCompartment.of([]),
        languageCompartment.of([]),
        lineNumberCompartment.of(lineNumberExtensions(lineNumbersVisible)),
        tabCompartment.of(tabExtensions(tabSize)),
        wrapCompartment.of(effectiveWordWrap ? EditorView.lineWrapping : []),
        editableCompartment.of(EditorView.editable.of(!view.loading && !view.error)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
          if (update.docChanged || update.selectionSet) {
            setCursorPosition(cursorPositionFor(update.view));
          }
        }),
      ],
    });
    setCursorPosition(cursorPositionFor(editor));

    const handlePasteCapture = (event: ClipboardEvent) => {
      const mode = pasteModeRef.current;
      const result = editorPasteTextFromClipboard(event.clipboardData, mode);

      if (result === null) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      editor.dispatch(editor.state.replaceSelection(result.text));
    };
    host.addEventListener("paste", handlePasteCapture, true);

    const handle: TextEditorHandle = {
      focus: () => editor.focus(),
      goToLine: (line) => {
        const nextLine = clampEditorNumber(line, 1, 1, editor.state.doc.lines);
        const targetLine = editor.state.doc.line(nextLine);
        editor.dispatch({
          selection: EditorSelection.cursor(targetLine.from),
          effects: EditorView.scrollIntoView(targetLine.from, { y: "center" }),
        });
        editor.focus();
      },
      redo: () => {
        redo(editor);
        editor.focus();
      },
      replaceRange: (from, to, insert) => {
        const docLength = editor.state.doc.length;
        const nextFrom = Math.max(0, Math.min(from, docLength));
        const nextTo = Math.max(nextFrom, Math.min(to, docLength));
        const cursor = nextFrom + insert.length;
        editor.dispatch({
          changes: { from: nextFrom, to: nextTo, insert },
          selection: EditorSelection.cursor(cursor),
          effects: EditorView.scrollIntoView(cursor, { y: "center" }),
        });
        editor.focus();
      },
      replaceRanges: (ranges) => {
        const docLength = editor.state.doc.length;
        const changes = ranges
          .map((range) => ({
            from: Math.max(0, Math.min(range.from, docLength)),
            insert: range.insert,
            to: Math.max(0, Math.min(range.to, docLength)),
          }))
          .filter((range) => range.to >= range.from)
          .sort((a, b) => a.from - b.from || a.to - b.to);

        if (changes.length === 0) {
          return;
        }

        const lastChange = changes[changes.length - 1];
        const cursor = Math.min(lastChange.from + lastChange.insert.length, docLength);
        editor.dispatch({
          changes,
          selection: EditorSelection.cursor(cursor),
          effects: EditorView.scrollIntoView(cursor, { y: "center" }),
        });
        editor.focus();
      },
      selection: () => ({
        from: editor.state.selection.main.from,
        to: editor.state.selection.main.to,
      }),
      selectRange: (from, to) => {
        const docLength = editor.state.doc.length;
        const nextFrom = Math.max(0, Math.min(from, docLength));
        const nextTo = Math.max(0, Math.min(to, docLength));
        editor.dispatch({
          selection: EditorSelection.range(nextFrom, nextTo),
          effects: EditorView.scrollIntoView(nextFrom, { y: "center" }),
        });
        editor.focus();
      },
      scrollToIndex: (index) => {
        const docLength = editor.state.doc.length;
        const nextIndex = Math.max(0, Math.min(index, docLength));
        editor.dispatch({
          effects: EditorView.scrollIntoView(nextIndex, { y: "center" }),
        });
      },
      undo: () => {
        undo(editor);
        editor.focus();
      },
    };

    viewRef.current = editor;
    editorRef.current = handle;

    return () => {
      host.removeEventListener("paste", handlePasteCapture, true);
      if (editorRef.current === handle) {
        editorRef.current = null;
      }
      viewRef.current = null;
      editor.destroy();
    };
  }, [
    editableCompartment,
    bracketsCompartment,
    editorRef,
    highlightCompartment,
    languageCompartment,
    lineNumberCompartment,
    tabCompartment,
    themeCompartment,
    wrapCompartment,
  ]);

  useEffect(() => {
    const editor = viewRef.current;
    if (!editor) {
      return;
    }

    editor.dispatch({
      effects: bracketsCompartment.reconfigure(
        autoCloseBrackets ? [closeBrackets(), keymap.of(closeBracketsKeymap)] : [],
      ),
    });
  }, [autoCloseBrackets, bracketsCompartment]);

  useEffect(() => {
    const editor = viewRef.current;
    if (!editor) {
      return;
    }

    if (!syntaxHighlightingEnabled) {
      editor.dispatch({
        effects: [
          highlightCompartment.reconfigure([]),
          languageCompartment.reconfigure([]),
        ],
      });
      return;
    }

    editor.dispatch({
      effects: highlightCompartment.reconfigure(syntaxHighlighting(lmpHighlightStyle)),
    });

    let cancelled = false;
    void loadTextLanguageExtensionForKey(languageKey).then((languageExtension) => {
      if (cancelled || viewRef.current !== editor) {
        return;
      }
      editor.dispatch({
        effects: languageCompartment.reconfigure(languageExtension),
      });
    });

    return () => {
      cancelled = true;
    };
  }, [highlightCompartment, languageCompartment, languageKey, syntaxHighlightingEnabled]);

  useEffect(() => {
    const editor = viewRef.current;
    if (!editor) {
      return;
    }

    editor.dispatch({
      effects: themeCompartment.reconfigure(lmpEditorTheme(fontSize, fontFamily, writingMode)),
    });
  }, [fontFamily, fontSize, themeCompartment, writingMode]);

  useEffect(() => {
    const editor = viewRef.current;
    if (!editor) {
      return;
    }

    editor.dispatch({
      effects: lineNumberCompartment.reconfigure(lineNumberExtensions(lineNumbersVisible)),
    });
  }, [lineNumberCompartment, lineNumbersVisible]);

  useEffect(() => {
    const editor = viewRef.current;
    if (!editor) {
      return;
    }

    editor.dispatch({
      effects: tabCompartment.reconfigure(tabExtensions(tabSize)),
    });
  }, [tabCompartment, tabSize]);

  useEffect(() => {
    const editor = viewRef.current;
    if (!editor) {
      return;
    }

    editor.dispatch({
      effects: wrapCompartment.reconfigure(effectiveWordWrap ? EditorView.lineWrapping : []),
    });
  }, [effectiveWordWrap, wrapCompartment]);

  useEffect(() => {
    const editor = viewRef.current;
    if (!editor) {
      return;
    }

    editor.dispatch({
      effects: updateSearchHighlights.of({
        activeIndex: activeSearchIndex,
        matches: searchMatches,
      }),
    });
  }, [activeSearchIndex, searchMatches]);

  useEffect(() => {
    const editor = viewRef.current;
    if (!editor) {
      return;
    }

    editor.dispatch({
      effects: editableCompartment.reconfigure(EditorView.editable.of(!view.loading && !view.error)),
    });
  }, [editableCompartment, view.error, view.loading]);

  useEffect(() => {
    const editor = viewRef.current;
    if (!editor) {
      return;
    }

    const current = editor.state.doc.toString();
    if (current === view.draft) {
      return;
    }

    const from = Math.min(editor.state.selection.main.from, view.draft.length);
    const to = Math.min(editor.state.selection.main.to, view.draft.length);
    editor.dispatch({
      changes: { from: 0, to: current.length, insert: view.draft },
      selection: EditorSelection.range(from, to),
    });
  }, [view.draft]);

  useEffect(() => {
    const editor = viewRef.current;
    if (!editor || !path || view.loading || view.error || focusedPathRef.current === path) {
      return;
    }

    focusedPathRef.current = path;
    window.setTimeout(() => {
      if (viewRef.current === editor) {
        editor.focus();
      }
    }, 0);
  }, [path, view.error, view.loading]);

  useEffect(() => {
    if (!enableIntegratedTerminal && textTerminalOpen) {
      setTextTerminalOpen(false);
    }
  }, [enableIntegratedTerminal, textTerminalOpen]);

  return (
    <div
      className={[
        "text-viewport",
        view.sourceType === "word-extract" ? "has-extracted-copy" : "",
        writingMode ? "is-writing-mode" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="text-editor-header">
        <div
          className="text-editor-summary"
          title={`${title}${technicalSummary ? ` - ${technicalSummary}` : ""} - ${textStats.letterCount.toLocaleString()} letters`}
        >
          <span>{visibleSummary}</span>
          <small>{textStatsLabel}</small>
        </div>

        <div className="text-editor-meta">
          {enableIntegratedTerminal ? (
            <>
              <button
                type="button"
                className={`text-terminal-toggle ${textTerminalOpen ? "is-active" : ""}`}
                onClick={() => setTextTerminalOpen((open) => !open)}
              >
                <span className="text-terminal-toggle-dot" />
                Terminal
              </button>

              {terminalRunCommand ? (
                <button
                  type="button"
                  className="text-terminal-run-toggle"
                  title={terminalRunTitle}
                  onClick={() => {
                    setTextTerminalOpen(true);
                    setTerminalRunRequestId((value) => value + 1);
                  }}
                >
                  {terminalRunLabel}
                </button>
              ) : null}

            </>
          ) : null}

          <small>
            Ln {cursorPosition.line.toLocaleString()}, Col{" "}
            {cursorPosition.column.toLocaleString()}
          </small>

          {view.dirty ? (
            <small>Unsaved</small>
          ) : (
            <small>{view.sourceType === "word-extract" ? "Extracted" : "Saved"}</small>
          )}
        </div>
      </div>

      {view.sourceType === "word-extract" ? (
        <div className="text-extracted-copy-note" role="note">
          <strong>Editable extracted copy</strong>
          <span>
            Original: {originalName}. Saving creates a new text file; the original Word document remains unchanged.
          </span>
        </div>
      ) : null}

      <div
        ref={hostRef}
        className={`text-editor ${effectiveWordWrap ? "" : "no-wrap"}`}
        aria-label="Text editor"
      />

      {enableIntegratedTerminal ? (
        <TextTerminalPanel
          open={textTerminalOpen}
          cwd={terminalCwd}
          runCommand={terminalRunCommand}
          runLabel={terminalRunLabel}
          runRequestId={terminalRunRequestId}
          runTitle={terminalRunTitle}
          onClose={() => setTextTerminalOpen(false)}
        />
      ) : null}

      {view.loading ? <div className="text-status">Loading text...</div> : null}
      {view.error ? <div className="text-status error">{view.error}</div> : null}
    </div>
  );
}
