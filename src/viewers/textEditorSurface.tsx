import { minimalSetup, EditorView } from "codemirror";
import {
  HighlightStyle,
  StreamLanguage,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  Compartment,
  EditorSelection,
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { indentWithTab, redo, undo } from "@codemirror/commands";
import { tags } from "@lezer/highlight";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";

import { extension } from "../lib/playerBrain";
import { TextTerminalPanel } from "../ui/TextTerminalPanel";
import {
  type TextEditorHandle,
  type TextViewState,
  textLanguageLabel,
  textLineEndingLabel,
} from "./text";

type TextFontFamily = "mono" | "system" | "serif" | "sans";

const editorFontFamilies: Record<TextFontFamily, string> = {
  mono: '"Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace',
  system: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  sans: '"Segoe UI", Inter, ui-sans-serif, system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", ui-serif, serif',
};

function lmpEditorTheme(fontSize: number, fontFamily: TextFontFamily) {
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        color: "rgba(255, 248, 238, 0.92)",
        background: "transparent",
        fontSize: `${fontSize}px`,
      },
      ".cm-scroller": {
        height: "100%",
        overflow: "auto",
        fontFamily: editorFontFamilies[fontFamily],
        lineHeight: "1.58",
        scrollbarColor: "rgba(164, 234, 208, 0.32) rgba(255, 255, 255, 0.05)",
      },
      ".cm-content": {
        minHeight: "100%",
        padding: "15px 0",
        caretColor: "#a4ead0",
      },
      ".cm-line": {
        padding: "0 18px 0 14px",
      },
      ".cm-gutters": {
        minHeight: "100%",
        color: "rgba(247, 242, 235, 0.34)",
        background: "rgba(255, 255, 255, 0.028)",
        borderRight: "1px solid rgba(255, 255, 255, 0.07)",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        minWidth: "34px",
        padding: "0 10px 0 8px",
      },
      ".cm-activeLine": {
        background: "rgba(164, 234, 208, 0.055)",
      },
      ".cm-activeLineGutter": {
        color: "rgba(255, 248, 238, 0.74)",
        background: "rgba(164, 234, 208, 0.08)",
      },
      "&.cm-focused": {
        outline: "none",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        background: "rgba(141, 193, 255, 0.32) !important",
      },
      ".cm-cursor": {
        borderLeftColor: "#a4ead0",
      },
      ".cm-matchingBracket, .cm-nonmatchingBracket": {
        outline: "1px solid rgba(164, 234, 208, 0.34)",
        background: "rgba(164, 234, 208, 0.08)",
      },
      ".cm-searchMatch": {
        background: "rgba(224, 198, 112, 0.2)",
        outline: "1px solid rgba(224, 198, 112, 0.28)",
      },
      ".cm-searchMatch-selected": {
        background: "rgba(164, 234, 208, 0.24)",
        outlineColor: "rgba(164, 234, 208, 0.45)",
      },
    },
    { dark: true },
  );
}

const lmpHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "#e0c670", fontWeight: "700" },
  { tag: [tags.atom, tags.bool, tags.null], color: "#d9a9ff" },
  { tag: [tags.number, tags.integer, tags.float], color: "#f0a97f" },
  { tag: [tags.string, tags.regexp, tags.special(tags.string)], color: "#a4ead0" },
  { tag: tags.comment, color: "rgba(247, 242, 235, 0.42)", fontStyle: "italic" },
  { tag: [tags.variableName, tags.self], color: "#fff8ee" },
  { tag: [tags.definition(tags.variableName), tags.function(tags.variableName)], color: "#8dc1ff" },
  { tag: [tags.className, tags.typeName, tags.namespace], color: "#f1dc8b" },
  { tag: [tags.propertyName, tags.attributeName], color: "#b7e7d3" },
  { tag: [tags.tagName, tags.heading], color: "#f0a97f", fontWeight: "700" },
  { tag: [tags.operator, tags.punctuation], color: "rgba(255, 248, 238, 0.64)" },
  { tag: tags.link, color: "#8dc1ff", textDecoration: "underline" },
  { tag: tags.invalid, color: "#ffb2a6" },
]);

type SearchMatch = {
  start: number;
  end: number;
};

const updateSearchHighlights = StateEffect.define<{
  activeIndex: number;
  matches: SearchMatch[];
}>();

function buildSearchDecorations(matches: SearchMatch[], activeIndex: number): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  matches
    .map((match, index) => ({ ...match, index }))
    .filter((match) => match.end > match.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .forEach((match) => {
      builder.add(
        match.start,
        match.end,
        Decoration.mark({
          class: match.index === activeIndex ? "cm-lmp-search-active" : "cm-lmp-search-hit",
        }),
      );
    });
  return builder.finish();
}

const searchHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (decorations, transaction) => {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(updateSearchHighlights)) {
        next = buildSearchDecorations(effect.value.matches, effect.value.activeIndex);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const configLanguage = StreamLanguage.define<null>({
  name: "lmp-config",
  startState: () => null,
  token(stream) {
    if (stream.sol()) {
      stream.eatSpace();
      if (stream.match(/[;#].*/)) {
        return "comment";
      }
      if (stream.match(/\[[^\]]+\]/)) {
        return "keyword";
      }
    }
    if (stream.match(/"(?:[^"\\]|\\.)*"/) || stream.match(/'(?:[^'\\]|\\.)*'/)) {
      return "string";
    }
    if (stream.match(/[A-Za-z0-9_.-]+(?=\s*[=:])/)) {
      return "propertyName";
    }
    if (stream.match(/-?\d+(?:\.\d+)?/)) {
      return "number";
    }
    stream.next();
    return null;
  },
});

const shellLanguage = StreamLanguage.define<null>({
  name: "lmp-shell",
  startState: () => null,
  token(stream) {
    if (stream.eatSpace()) {
      return null;
    }
    if (stream.match(/#.*/) || stream.match(/rem\b.*/i) || stream.match(/::.*$/)) {
      return "comment";
    }
    if (stream.match(/"(?:[^"\\]|\\.)*"/) || stream.match(/'(?:[^'\\]|\\.)*'/)) {
      return "string";
    }
    if (stream.match(/\$[A-Za-z_][\w-]*/) || stream.match(/%[A-Za-z_][\w-]*%/)) {
      return "variableName";
    }
    if (
      stream.match(
        /\b(?:if|else|for|do|done|then|fi|case|esac|function|return|echo|set|export|param|foreach|while|switch|try|catch|finally)\b/i,
      )
    ) {
      return "keyword";
    }
    if (stream.match(/-?\d+(?:\.\d+)?/)) {
      return "number";
    }
    stream.next();
    return null;
  },
});

const logLanguage = StreamLanguage.define<null>({
  name: "lmp-log",
  startState: () => null,
  token(stream) {
    if (stream.sol() && stream.match(/\[[^\]]+\]/)) {
      return "keyword";
    }
    if (stream.match(/\b(?:error|fatal|fail|failed|exception)\b/i)) {
      return "invalid";
    }
    if (stream.match(/\b(?:warn|warning)\b/i)) {
      return "atom";
    }
    if (stream.match(/\b(?:info|debug|trace|success|ok)\b/i)) {
      return "keyword";
    }
    if (stream.match(/\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?\b/)) {
      return "number";
    }
    stream.next();
    return null;
  },
});

const delimitedTextLanguage = StreamLanguage.define<null>({
  name: "lmp-delimited",
  startState: () => null,
  token(stream) {
    if (stream.match(/"(?:[^"\\]|\\.)*"/)) {
      return "string";
    }
    if (stream.match(/-?\d+(?:[.,]\d+)?/)) {
      return "number";
    }
    if (stream.match(/[,;\t]/)) {
      return "punctuation";
    }
    stream.next();
    return null;
  },
});

const plainTextHintLanguage = StreamLanguage.define<null>({
  name: "lmp-plain-text-hints",
  startState: () => null,
  token(stream) {
    if (stream.eatSpace()) {
      return null;
    }
    if (stream.match(/\/\/.*/) || stream.match(/#.*/)) {
      return "comment";
    }
    if (
      stream.match(/"(?:[^"\\]|\\.)*"/) ||
      stream.match(/'(?:[^'\\]|\\.)*'/) ||
      stream.match(/`(?:[^`\\]|\\.)*`/)
    ) {
      return "string";
    }
    if (stream.match(/\b(?:TODO|FIXME|NOTE|WARN|WARNING|ERROR)\b/)) {
      return "atom";
    }
    if (
      stream.match(
        /\b(?:async|await|break|case|catch|class|const|continue|def|elif|else|except|false|finally|for|from|function|if|import|in|let|null|print|return|true|try|var|while|yield)\b/,
      )
    ) {
      return "keyword";
    }
    if (stream.match(/-?\d+(?:[.,]\d+)?/)) {
      return "number";
    }
    stream.next();
    return null;
  },
});

async function loadTextLanguageExtension(path: string | null): Promise<Extension> {
  if (!path) {
    return [];
  }

  const parts = path.split(/[\\/]/).filter(Boolean);
  const name = (parts[parts.length - 1] ?? "").toLowerCase();
  if (name === "dockerfile" || name === "makefile" || name.startsWith(".env")) {
    return shellLanguage;
  }
  if (name === ".editorconfig" || name.endsWith("rc")) {
    return configLanguage;
  }

  switch (extension(path)) {
    case "c":
    case "cpp":
    case "h":
    case "hpp": {
      const { cpp } = await import("@codemirror/lang-cpp");
      return cpp();
    }
    case "css": {
      const { css } = await import("@codemirror/lang-css");
      return css();
    }
    case "scss":
    case "sass":
    case "less": {
      const { css } = await import("@codemirror/lang-css");
      return css();
    }
    case "htm":
    case "html":
    case "xhtml": {
      const { html } = await import("@codemirror/lang-html");
      return html();
    }
    case "java": {
      const { java } = await import("@codemirror/lang-java");
      return java();
    }
    case "cjs":
    case "js":
    case "mjs": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript();
    }
    case "jsx": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript({ jsx: true });
    }
    case "ts": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript({ typescript: true });
    }
    case "tsx": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript({ jsx: true, typescript: true });
    }
    case "json":
    case "jsonc": {
      const { json } = await import("@codemirror/lang-json");
      return json();
    }
    case "ini":
    case "conf":
    case "cfg":
    case "toml":
      return configLanguage;
    case "bat":
    case "cmd":
    case "ps1":
    case "sh":
      return shellLanguage;
    case "csv":
    case "tsv":
      return delimitedTextLanguage;
    case "txt":
    case "text":
      return plainTextHintLanguage;
    case "log":
      return logLanguage;
    case "markdown":
    case "md": {
      const { markdown } = await import("@codemirror/lang-markdown");
      return markdown();
    }
    case "php": {
      const { php } = await import("@codemirror/lang-php");
      return php();
    }
    case "py": {
      const { python } = await import("@codemirror/lang-python");
      return python();
    }
    case "rs": {
      const { rust } = await import("@codemirror/lang-rust");
      return rust();
    }
    case "sql": {
      const { sql } = await import("@codemirror/lang-sql");
      return sql();
    }
    case "xml": {
      const { xml } = await import("@codemirror/lang-xml");
      return xml();
    }
    case "yaml":
    case "yml": {
      const { yaml } = await import("@codemirror/lang-yaml");
      return yaml();
    }
    default:
      return [];
  }
}

type TextEditorSurfaceProps = {
  activeSearchIndex: number;
  autoCloseBrackets: boolean;
  enableIntegratedTerminal: boolean;
  fontFamily: TextFontFamily;
  fontSize: number;
  lineNumbersVisible: boolean;
  path: string | null;
  searchMatches: SearchMatch[];
  syntaxHighlightingEnabled: boolean;
  tabSize: number;
  title: string;
  view: TextViewState;
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

function cursorPositionFor(editor: EditorView) {
  const head = editor.state.selection.main.head;
  const line = editor.state.doc.lineAt(head);
  return {
    line: line.number,
    column: head - line.from + 1,
  };
}

function directoryFromPath(path?: string | null): string | null {
  if (!path) return null;

  const lastSlash = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));

  if (lastSlash <= 0) return null;

  return path.slice(0, lastSlash);
}

function quotePowerShellPath(path: string): string {
  return `'${path.replace(/'/g, "''")}'`;
}

function looksLikePythonSource(content: string): boolean {
  const trimmed = content.trimStart();

  return (
    trimmed.startsWith("print(") ||
    /^\s*(import|from|def|class|if __name__|for|while)\b/m.test(content)
  );
}

function looksLikeJavaScriptSource(content: string): boolean {
  const trimmed = content.trimStart();

  return (
    trimmed.startsWith("console.log(") ||
    /\bconsole\.(log|error|warn|info)\s*\(/.test(content) ||
    /^\s*(import|export|const|let|var|function|class)\b/m.test(content) ||
    /\b(require|process\.cwd|process\.env|setTimeout|setInterval)\s*\(/.test(content) ||
    /=>/.test(content)
  );
}

function runCommandForTextFile(path: string | null, content: string): string | null {
  if (!path) return null;

  const fileExtension = extension(path);
  const quotedPath = quotePowerShellPath(path);

  switch (fileExtension) {
    case "py":
      return `python ${quotedPath}`;
    case "js":
    case "mjs":
    case "cjs":
      return `node ${quotedPath}`;
    case "ps1":
      return `powershell -NoProfile -ExecutionPolicy Bypass -File ${quotedPath}`;
    case "bat":
    case "cmd":
      return `cmd /c ${quotedPath}`;
    case "sh":
      return `bash ${quotedPath}`;
    case "txt":
      if (looksLikePythonSource(content)) {
        return `python ${quotedPath}`;
      }

      if (looksLikeJavaScriptSource(content)) {
        return `node ${quotedPath}`;
      }

      return null;
    default:
      return null;
  }
}

function runLabelForCommand(command: string | null): string {
  if (!command) return "Run";

  if (command.startsWith("python ")) return "Run Python";
  if (command.startsWith("node ")) return "Run Node";
  if (command.startsWith("powershell ")) return "Run PS1";
  if (command.startsWith("cmd /c ")) return "Run CMD";
  if (command.startsWith("bash ")) return "Run Bash";

  return "Run";
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
  onChange,
  editorRef,
  wordWrap,
}: TextEditorSurfaceProps) {
  const [textTerminalOpen, setTextTerminalOpen] = useState(false);
  const [terminalRunRequestId, setTerminalRunRequestId] = useState(0);

  const terminalFilePath = path ?? view.savePath ?? view.originalPath;
  const terminalCwd = directoryFromPath(terminalFilePath);
  const terminalRunCommand = runCommandForTextFile(terminalFilePath, view.draft);
  const terminalRunLabel = runLabelForCommand(terminalRunCommand);
  const terminalRunTitle = view.dirty
    ? "Save file to run latest changes"
    : terminalRunCommand ?? "No runnable file detected";

  const language = textLanguageLabel(path);
  const originalPathParts = view.originalPath?.split(/[\\/]/).filter(Boolean) ?? [];
  const originalName = view.originalPath
    ? originalPathParts[originalPathParts.length - 1] ?? view.originalPath
    : title;
  const visibleSummary = `${view.lineCount.toLocaleString()} lines`;
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
        themeCompartment.of(lmpEditorTheme(fontSize, fontFamily)),
        highlightCompartment.of([]),
        languageCompartment.of([]),
        lineNumberCompartment.of(lineNumberExtensions(lineNumbersVisible)),
        tabCompartment.of(tabExtensions(tabSize)),
        wrapCompartment.of(wordWrap ? EditorView.lineWrapping : []),
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
    void loadTextLanguageExtension(path).then((languageExtension) => {
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
  }, [highlightCompartment, languageCompartment, path, syntaxHighlightingEnabled]);

  useEffect(() => {
    const editor = viewRef.current;
    if (!editor) {
      return;
    }

    editor.dispatch({
      effects: themeCompartment.reconfigure(lmpEditorTheme(fontSize, fontFamily)),
    });
  }, [fontFamily, fontSize, themeCompartment]);

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
      effects: wrapCompartment.reconfigure(wordWrap ? EditorView.lineWrapping : []),
    });
  }, [wordWrap, wrapCompartment]);

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
    <div className={`text-viewport ${view.sourceType === "word-extract" ? "has-extracted-copy" : ""}`}>
      <div className="text-editor-header">
        <div
          className="text-editor-summary"
          title={`${title}${technicalSummary ? ` - ${technicalSummary}` : ""}`}
        >
          <span>{visibleSummary}</span>
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
        className={`text-editor ${wordWrap ? "" : "no-wrap"}`}
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
