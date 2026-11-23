import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, type Extension, type Text } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  highlightTrailingWhitespace,
  highlightWhitespace,
  keymap,
  lineNumbers,
  rectangularSelection,
  type ViewUpdate,
} from "@codemirror/view";
import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

import { runTextEditCommand } from "./textEditCommands";
import type {
  TextCursorInfo,
  TextEditorDocState,
  TextEditorHandle,
  TextEditorLoad,
  TextEditorVersion,
} from "./textEditorHandle";
import { lmpEditorTheme, lmpHighlightStyle, type TextFontFamily } from "./textEditorTheme";
import { editorPasteTextFromClipboard } from "./textClipboard";
import { loadTextLanguageExtensionForKey } from "./textLanguageSupport";
import { isProseLanguage, type TextLanguageKey } from "./textLanguages";
import { type EditorPasteMode } from "./textPaste";
import type { TextMatch } from "./textSearch";
import { searchHighlightField, updateSearchHighlights } from "./textSearchHighlight";

export type TextEditorSurfaceConfig = {
  autoCloseBrackets: boolean;
  editable: boolean;
  fontFamily: TextFontFamily;
  fontSize: number;
  highlight: boolean;
  indentWithTabs: boolean;
  languageKey: TextLanguageKey;
  /** Large-file mode drops helpers that scan the whole document. */
  large: boolean;
  lineNumbers: boolean;
  showWhitespace: boolean;
  tabSize: number;
  wordWrap: boolean;
  writingMode: boolean;
};

type TextEditorSurfaceProps = {
  activeSearchIndex: number;
  autoDetectSample: boolean;
  config: TextEditorSurfaceConfig;
  consumeLoad: (token: number) => TextEditorLoad | null;
  editorRef: RefObject<TextEditorHandle | null>;
  loadToken: number;
  onCursor: (cursor: TextCursorInfo) => void;
  onDocState: (state: TextEditorDocState) => void;
  onSample: (sample: string) => void;
  searchMatches: TextMatch[];
};

type ParkedEditor = { doc: Text; saved: Text | null; selection: EditorSelection; token: number };

/**
 * Keeps the document for a moment when the surface remounts (StrictMode, layout
 * changes) so a document that was already handed over is not lost.
 */
const parkedEditors = new WeakMap<object, ParkedEditor>();

const sampleChars = 8000;
const sampleDelayMs = 600;
const cleanCheckDelayMs = 140;

function clampNumber(value: number, fallback: number, min: number, max: number) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
}

function tabExtensions(tabSize: number, useTabs: boolean): Extension {
  const size = clampNumber(tabSize, 2, 1, 8);
  return [EditorState.tabSize.of(size), indentUnit.of(useTabs ? "\t" : " ".repeat(size))];
}

function gutterExtensions(visible: boolean, large: boolean): Extension {
  if (!visible) {
    return [];
  }
  return large
    ? [lineNumbers(), highlightActiveLineGutter()]
    : [lineNumbers(), highlightActiveLineGutter(), foldGutter({ openText: "▾", closedText: "▸" })];
}

function codeHelperExtensions(large: boolean, prose: boolean): Extension {
  if (large) {
    return [];
  }
  return prose
    ? [highlightSelectionMatches({ minSelectionLength: 2 })]
    : [bracketMatching(), indentOnInput(), highlightSelectionMatches({ minSelectionLength: 2 })];
}

function pasteModeFor(writingMode: boolean, languageKey: TextLanguageKey): EditorPasteMode {
  if (writingMode) {
    return "writing";
  }
  return isProseLanguage(languageKey) ? "plain" : "code";
}

function cursorInfoFor(state: EditorState): TextCursorInfo {
  const main = state.selection.main;
  const line = state.doc.lineAt(main.head);
  let selectedChars = 0;
  let selectedLines = 0;
  for (const range of state.selection.ranges) {
    if (!range.empty) {
      selectedChars += range.to - range.from;
      selectedLines += state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number + 1;
    }
  }
  return {
    line: line.number,
    column: main.head - line.from + 1,
    selections: state.selection.ranges.length,
    selectedChars,
    selectedLines,
  };
}

export function TextEditorSurface({
  activeSearchIndex,
  autoDetectSample,
  config,
  consumeLoad,
  editorRef,
  loadToken,
  onCursor,
  onDocState,
  onSample,
  searchMatches,
}: TextEditorSurfaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const savedDocRef = useRef<Text | null>(null);
  const dirtyRef = useRef(false);
  const cleanCheckTimerRef = useRef<number | null>(null);
  const sampleTimerRef = useRef<number | null>(null);
  const appliedTokenRef = useRef(0);
  const loadDocumentRef = useRef<((load: TextEditorLoad) => void) | null>(null);
  const refreshLanguageRef = useRef<(() => void) | null>(null);
  const configRef = useRef(config);
  const callbacksRef = useRef({ autoDetectSample, consumeLoad, onCursor, onDocState, onSample });
  configRef.current = config;
  callbacksRef.current = { autoDetectSample, consumeLoad, onCursor, onDocState, onSample };

  const compartments = useRef({
    brackets: new Compartment(),
    editable: new Compartment(),
    gutters: new Compartment(),
    helpers: new Compartment(),
    highlight: new Compartment(),
    language: new Compartment(),
    tabs: new Compartment(),
    theme: new Compartment(),
    whitespace: new Compartment(),
    wrap: new Compartment(),
  }).current;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const reportDocState = (state: EditorState) => {
      callbacksRef.current.onDocState({
        dirty: dirtyRef.current,
        length: state.doc.length,
        lines: state.doc.lines,
      });
    };

    const setDirty = (state: EditorState, dirty: boolean) => {
      dirtyRef.current = dirty;
      reportDocState(state);
    };

    const recheckClean = (editor: EditorView) => {
      const saved = savedDocRef.current;
      const doc = editor.state.doc;
      setDirty(editor.state, !saved || doc.length !== saved.length || !doc.eq(saved));
    };

    const scheduleSample = (editor: EditorView) => {
      if (!callbacksRef.current.autoDetectSample) {
        return;
      }
      if (sampleTimerRef.current !== null) {
        window.clearTimeout(sampleTimerRef.current);
      }
      sampleTimerRef.current = window.setTimeout(() => {
        sampleTimerRef.current = null;
        if (viewRef.current === editor) {
          callbacksRef.current.onSample(editor.state.sliceDoc(0, sampleChars));
        }
      }, sampleDelayMs);
    };

    const handleUpdate = (update: ViewUpdate) => {
      if (update.docChanged) {
        const saved = savedDocRef.current;
        if (cleanCheckTimerRef.current !== null) {
          window.clearTimeout(cleanCheckTimerRef.current);
          cleanCheckTimerRef.current = null;
        }
        if (!saved || update.state.doc.length !== saved.length) {
          if (!dirtyRef.current) {
            setDirty(update.state, true);
          } else {
            reportDocState(update.state);
          }
        } else {
          // Same length as the saved text: compare after typing settles.
          const editor = update.view;
          cleanCheckTimerRef.current = window.setTimeout(() => {
            cleanCheckTimerRef.current = null;
            if (viewRef.current === editor) {
              recheckClean(editor);
            }
          }, cleanCheckDelayMs);
          reportDocState(update.state);
        }
        scheduleSample(update.view);
      }
      if (update.docChanged || update.selectionSet) {
        callbacksRef.current.onCursor(cursorInfoFor(update.state));
      }
    };

    const buildExtensions = (): Extension[] => {
      const current = configRef.current;
      const prose = isProseLanguage(current.languageKey);
      const effectiveWrap = current.writingMode || current.wordWrap;
      return [
        history(),
        drawSelection(),
        dropCursor(),
        highlightSpecialChars(),
        EditorState.allowMultipleSelections.of(true),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        searchHighlightField,
        keymap.of([
          { key: "Mod-d", run: selectNextOccurrence, preventDefault: true },
          { key: "Mod-Shift-l", run: selectSelectionMatches, preventDefault: true },
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        compartments.brackets.of(
          current.autoCloseBrackets && !prose ? [closeBrackets(), keymap.of(closeBracketsKeymap)] : [],
        ),
        compartments.editable.of(EditorState.readOnly.of(!current.editable)),
        compartments.gutters.of(gutterExtensions(current.lineNumbers, current.large)),
        compartments.helpers.of(codeHelperExtensions(current.large, prose)),
        compartments.highlight.of(current.highlight ? syntaxHighlighting(lmpHighlightStyle) : []),
        compartments.language.of([]),
        compartments.tabs.of(tabExtensions(current.tabSize, current.indentWithTabs)),
        compartments.theme.of(lmpEditorTheme(current.fontSize, current.fontFamily, current.writingMode)),
        compartments.whitespace.of(current.showWhitespace ? [highlightWhitespace(), highlightTrailingWhitespace()] : []),
        compartments.wrap.of(effectiveWrap ? EditorView.lineWrapping : []),
        EditorView.updateListener.of(handleUpdate),
        EditorView.contentAttributes.of({ "aria-label": "Text editor", spellcheck: "false" }),
      ];
    };

    const parked = parkedEditors.get(editorRef);
    parkedEditors.delete(editorRef);
    const editor = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: parked?.doc ?? "",
        selection: parked?.selection,
        extensions: buildExtensions(),
      }),
    });
    savedDocRef.current = parked ? parked.saved : editor.state.doc;
    appliedTokenRef.current = parked?.token ?? 0;
    viewRef.current = editor;

    const loadDocument = (load: TextEditorLoad) => {
      const state = EditorState.create({ doc: load.text, extensions: buildExtensions() });
      editor.setState(state);
      savedDocRef.current =
        load.savedText === undefined ? state.doc : EditorState.create({ doc: load.savedText }).doc;
      const cursor = Math.max(0, Math.min(load.cursor ?? 0, state.doc.length));
      if (cursor > 0) {
        editor.dispatch({
          selection: EditorSelection.cursor(cursor),
          effects: EditorView.scrollIntoView(cursor, { y: "center" }),
        });
      }
      recheckClean(editor);
      callbacksRef.current.onCursor(cursorInfoFor(editor.state));
      // The language compartment starts empty; the effect below fills it in.
      setLanguageExtension(editor);
      if (callbacksRef.current.autoDetectSample) {
        callbacksRef.current.onSample(editor.state.sliceDoc(0, sampleChars));
      }
      window.setTimeout(() => {
        if (viewRef.current === editor) {
          editor.focus();
        }
      }, 0);
    };

    const handlePasteCapture = (event: ClipboardEvent) => {
      const current = configRef.current;
      if (!current.editable) {
        return;
      }
      const result = editorPasteTextFromClipboard(
        event.clipboardData,
        pasteModeFor(current.writingMode, current.languageKey),
      );
      if (result === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      editor.dispatch(editor.state.replaceSelection(result.text), { userEvent: "input.paste" });
    };
    host.addEventListener("paste", handlePasteCapture, true);

    const clampRange = (from: number, to: number) => {
      const length = editor.state.doc.length;
      const nextFrom = Math.max(0, Math.min(from, length));
      return { from: nextFrom, to: Math.max(nextFrom, Math.min(to, length)) };
    };

    const handle: TextEditorHandle = {
      focus: () => editor.focus(),
      getText: () => editor.state.doc.toString(),
      getSavedText: () => (savedDocRef.current ?? editor.state.doc).toString(),
      getSample: (maxChars) => editor.state.sliceDoc(0, maxChars),
      snapshot: () => ({
        text: editor.state.doc.toString(),
        version: editor.state.doc as unknown as TextEditorVersion,
      }),
      markSaved: (version) => {
        savedDocRef.current = version as unknown as Text;
        recheckClean(editor);
      },
      revert: () => {
        const saved = savedDocRef.current;
        if (!saved) {
          return;
        }
        const head = Math.min(editor.state.selection.main.head, saved.length);
        editor.dispatch({
          changes: { from: 0, to: editor.state.doc.length, insert: saved },
          selection: EditorSelection.cursor(head),
          userEvent: "input.revert",
        });
        recheckClean(editor);
      },
      isDirty: () => dirtyRef.current,
      lineCount: () => editor.state.doc.lines,
      cursorOffset: () => editor.state.selection.main.head,
      goToLine: (line, column = 1) => {
        const target = editor.state.doc.line(clampNumber(line, 1, 1, editor.state.doc.lines));
        const position = Math.min(target.to, target.from + Math.max(0, column - 1));
        editor.dispatch({
          selection: EditorSelection.cursor(position),
          effects: EditorView.scrollIntoView(position, { y: "center" }),
        });
        editor.focus();
      },
      selection: () => ({
        from: editor.state.selection.main.from,
        to: editor.state.selection.main.to,
      }),
      selectedText: () =>
        editor.state.selection.ranges
          .filter((range) => !range.empty)
          .map((range) => editor.state.sliceDoc(range.from, range.to))
          .join(editor.state.lineBreak),
      selectRange: (from, to) => {
        const range = clampRange(Math.min(from, to), Math.max(from, to));
        editor.dispatch({
          selection: EditorSelection.range(range.from, range.to),
          effects: EditorView.scrollIntoView(range.from, { y: "center" }),
        });
      },
      replaceRange: (from, to, insert) => {
        const range = clampRange(from, to);
        const end = range.from + insert.length;
        editor.dispatch({
          changes: { from: range.from, to: range.to, insert },
          selection: EditorSelection.range(range.from, end),
          effects: EditorView.scrollIntoView(range.from, { y: "center" }),
          userEvent: "input.replace",
        });
      },
      replaceRanges: (ranges) => {
        const changes = ranges
          .map((range) => ({ ...clampRange(range.from, range.to), insert: range.insert }))
          .sort((a, b) => a.from - b.from || a.to - b.to);
        if (changes.length === 0) {
          return;
        }
        editor.dispatch({ changes, userEvent: "input.replace.all" });
        editor.focus();
      },
      insertText: (text) => {
        if (!configRef.current.editable) {
          return;
        }
        editor.dispatch(editor.state.replaceSelection(text), { userEvent: "input.paste" });
        editor.focus();
      },
      runCommand: (command) => {
        const handled = runTextEditCommand(editor, command);
        editor.focus();
        return handled;
      },
    };

    let languageRequest = 0;
    function setLanguageExtension(target: EditorView) {
      const current = configRef.current;
      languageRequest += 1;
      const request = languageRequest;
      if (!current.highlight) {
        target.dispatch({ effects: compartments.language.reconfigure([]) });
        return;
      }
      void loadTextLanguageExtensionForKey(current.languageKey).then((extension) => {
        if (request === languageRequest && viewRef.current === target) {
          target.dispatch({ effects: compartments.language.reconfigure(extension) });
        }
      });
    }

    editorRef.current = handle;
    loadDocumentRef.current = loadDocument;
    refreshLanguageRef.current = () => setLanguageExtension(editor);
    if (parked) {
      recheckClean(editor);
      setLanguageExtension(editor);
    }

    return () => {
      const parkedEntry: ParkedEditor = {
        doc: editor.state.doc,
        saved: savedDocRef.current,
        selection: editor.state.selection,
        token: appliedTokenRef.current,
      };
      parkedEditors.set(editorRef, parkedEntry);
      // Only an immediate remount needs the parked document; release it afterwards.
      window.setTimeout(() => {
        if (parkedEditors.get(editorRef) === parkedEntry) {
          parkedEditors.delete(editorRef);
        }
      }, 1500);
      loadDocumentRef.current = null;
      refreshLanguageRef.current = null;
      host.removeEventListener("paste", handlePasteCapture, true);
      if (cleanCheckTimerRef.current !== null) {
        window.clearTimeout(cleanCheckTimerRef.current);
      }
      if (sampleTimerRef.current !== null) {
        window.clearTimeout(sampleTimerRef.current);
      }
      if (editorRef.current === handle) {
        editorRef.current = null;
      }
      viewRef.current = null;
      editor.destroy();
    };
  }, [compartments, editorRef]);

  useEffect(() => {
    const loadDocument = loadDocumentRef.current;
    if (!loadDocument || appliedTokenRef.current === loadToken) {
      return;
    }
    const load = callbacksRef.current.consumeLoad(loadToken);
    if (load) {
      appliedTokenRef.current = loadToken;
      loadDocument(load);
    }
  }, [loadToken]);

  const { highlight, languageKey } = config;
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.highlight.reconfigure(highlight ? syntaxHighlighting(lmpHighlightStyle) : []),
    });
    refreshLanguageRef.current?.();
  }, [compartments, highlight, languageKey]);

  const { autoCloseBrackets, editable, large, writingMode } = config;
  const prose = isProseLanguage(languageKey);
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        compartments.brackets.reconfigure(
          autoCloseBrackets && !prose ? [closeBrackets(), keymap.of(closeBracketsKeymap)] : [],
        ),
        compartments.helpers.reconfigure(codeHelperExtensions(large, prose)),
      ],
    });
  }, [autoCloseBrackets, compartments, large, prose]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.editable.reconfigure(EditorState.readOnly.of(!editable)),
    });
  }, [compartments, editable]);

  const { fontFamily, fontSize } = config;
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.theme.reconfigure(lmpEditorTheme(fontSize, fontFamily, writingMode)),
    });
  }, [compartments, fontFamily, fontSize, writingMode]);

  const { lineNumbers: lineNumbersVisible } = config;
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.gutters.reconfigure(gutterExtensions(lineNumbersVisible, large)),
    });
  }, [compartments, large, lineNumbersVisible]);

  const { indentWithTabs, tabSize } = config;
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.tabs.reconfigure(tabExtensions(tabSize, indentWithTabs)),
    });
  }, [compartments, indentWithTabs, tabSize]);

  const { showWhitespace } = config;
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.whitespace.reconfigure(
        showWhitespace ? [highlightWhitespace(), highlightTrailingWhitespace()] : [],
      ),
    });
  }, [compartments, showWhitespace]);

  const effectiveWrap = config.writingMode || config.wordWrap;
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.wrap.reconfigure(effectiveWrap ? EditorView.lineWrapping : []),
    });
  }, [compartments, effectiveWrap]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: updateSearchHighlights.of({ activeIndex: activeSearchIndex, matches: searchMatches }),
    });
  }, [activeSearchIndex, searchMatches]);

  return <div ref={hostRef} className={`text-editor ${effectiveWrap ? "" : "no-wrap"}`} />;
}
