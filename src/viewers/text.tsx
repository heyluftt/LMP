import { extension } from "../lib/playerBrain";

export type TextViewState = {
  content: string;
  draft: string;
  dirty: boolean;
  originalPath: string | null;
  savePath: string | null;
  sourceType: "file" | "word-extract";
  suggestedSavePath: string | null;
  lineCount: number;
  encoding: string;
  lineEnding: TextLineEnding;
  loading: boolean;
  error: string | null;
};

export type TextLineEnding = "lf" | "crlf" | "cr";

export const defaultTextView: TextViewState = {
  content: "",
  draft: "",
  dirty: false,
  originalPath: null,
  savePath: null,
  sourceType: "file",
  suggestedSavePath: null,
  lineCount: 0,
  encoding: "",
  lineEnding: "lf",
  loading: false,
  error: null,
};

export type TextFileContent = {
  content: string;
  line_count: number;
  encoding: string;
  line_ending: TextLineEnding;
};

export function textLineEndingLabel(lineEnding: TextLineEnding) {
  if (lineEnding === "crlf") {
    return "CRLF";
  }
  if (lineEnding === "cr") {
    return "CR";
  }
  return "LF";
}

export type TextEditorHandle = {
  focus: () => void;
  goToLine: (line: number) => void;
  redo: () => void;
  replaceRange: (from: number, to: number, insert: string) => void;
  replaceRanges: (ranges: Array<{ from: number; insert: string; to: number }>) => void;
  selection: () => { from: number; to: number };
  selectRange: (from: number, to: number) => void;
  scrollToIndex: (index: number) => void;
  undo: () => void;
};

export function textLanguageLabel(path: string | null) {
  if (!path) {
    return "Plain text";
  }

  const parts = path.split(/[\\/]/).filter(Boolean);
  const name = (parts[parts.length - 1] ?? "").toLowerCase();
  if (name === "dockerfile") {
    return "Dockerfile";
  }
  if (name === "makefile") {
    return "Makefile";
  }
  if (name.startsWith(".env")) {
    return "Env";
  }

  const ext = extension(path);
  const labels: Record<string, string> = {
    astro: "Astro",
    bat: "Batch",
    c: "C",
    cfg: "Config",
    cjs: "JavaScript",
    cmd: "Command",
    conf: "Config",
    cpp: "C++",
    cs: "C#",
    css: "CSS",
    csv: "CSV",
    go: "Go",
    h: "C/C++ Header",
    hpp: "C++ Header",
    htm: "HTML",
    html: "HTML",
    xhtml: "XHTML",
    ini: "INI",
    java: "Java",
    js: "JavaScript",
    json: "JSON",
    jsonc: "JSONC",
    jsx: "JavaScript React",
    log: "Log",
    less: "Less",
    markdown: "Markdown",
    md: "Markdown",
    mjs: "JavaScript",
    php: "PHP",
    ps1: "PowerShell",
    py: "Python",
    rb: "Ruby",
    rs: "Rust",
    sass: "Sass",
    scss: "SCSS",
    sh: "Shell",
    sql: "SQL",
    svelte: "Svelte",
    toml: "TOML",
    ts: "TypeScript",
    tsx: "TypeScript React",
    tsv: "TSV",
    txt: "Plain text",
    vue: "Vue",
    xml: "XML",
    yaml: "YAML",
    yml: "YAML",
  };

  return labels[ext] ?? "Plain text";
}

export function normalizeTextContent(content: string) {
  return content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
