import { extension, fileName } from "../../lib/playerBrain";

export type TextLanguageKey =
  | "batch"
  | "config"
  | "cpp"
  | "css"
  | "delimited"
  | "diff"
  | "html"
  | "java"
  | "javascript"
  | "javascript-react"
  | "json"
  | "log"
  | "markdown"
  | "php"
  | "plain"
  | "plain-hints"
  | "powershell"
  | "python"
  | "rust"
  | "shell"
  | "sql"
  | "typescript"
  | "typescript-react"
  | "xml"
  | "yaml";

export function languageKeyFromPath(path: string | null): TextLanguageKey | null {
  if (!path) {
    return null;
  }
  const name = fileName(path).toLowerCase();
  if (name === "dockerfile" || name === "makefile" || name === "jenkinsfile" || name === "procfile") {
    return "shell";
  }
  if (
    name.startsWith(".env") ||
    name === ".editorconfig" ||
    name === ".gitattributes" ||
    name === ".gitignore" ||
    name === ".dockerignore" ||
    name === ".gitmodules" ||
    name.endsWith("rc")
  ) {
    return "config";
  }

  switch (extension(path)) {
    case "c":
    case "cpp":
    case "h":
    case "hpp":
      return "cpp";
    case "css":
    case "scss":
    case "sass":
    case "less":
      return "css";
    case "htm":
    case "html":
    case "xhtml":
      return "html";
    case "java":
      return "java";
    case "cjs":
    case "js":
    case "mjs":
      return "javascript";
    case "jsx":
      return "javascript-react";
    case "cts":
    case "mts":
    case "ts":
      return "typescript";
    case "tsx":
      return "typescript-react";
    case "json":
    case "jsonc":
      return "json";
    case "ini":
    case "conf":
    case "cfg":
    case "toml":
    case "properties":
    case "env":
    case "reg":
      return "config";
    case "bat":
    case "cmd":
      return "batch";
    case "ps1":
    case "psm1":
    case "psd1":
      return "powershell";
    case "sh":
    case "bash":
    case "zsh":
      return "shell";
    case "diff":
    case "patch":
      return "diff";
    case "csv":
    case "tsv":
      return "delimited";
    case "txt":
    case "text":
    case "nfo":
    case "rst":
    case "tex":
      return "plain-hints";
    case "log":
      return "log";
    case "markdown":
    case "md":
      return "markdown";
    case "php":
      return "php";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "sql":
      return "sql";
    case "xml":
      return "xml";
    case "yaml":
    case "yml":
      return "yaml";
    default:
      return null;
  }
}

function looksLikeJson(text: string) {
  const trimmed = text.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) {
    return false;
  }

  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function countMatches(text: string, patterns: RegExp[]) {
  return patterns.reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0);
}

function inferLanguageKeyFromContent(content: string): TextLanguageKey | null {
  const sample = content.slice(0, 8000);
  const trimmed = sample.trim();
  if (!trimmed) {
    return null;
  }

  if (looksLikeJson(trimmed)) {
    return "json";
  }

  if (/^\s*<!doctype\s+html/i.test(sample) || /<html[\s>]/i.test(sample)) {
    return "html";
  }

  if (/^\s*<\?xml\b/i.test(sample) || /<\/?[A-Za-z][\w:-]*(?:\s[^>]*)?>/.test(sample)) {
    return "xml";
  }

  const pythonScore = countMatches(sample, [
    /^\s*(?:from\s+\S+\s+)?import\s+\S+/m,
    /^\s*def\s+[A-Za-z_]\w*\s*\(/m,
    /^\s*class\s+[A-Za-z_]\w*/m,
    /^\s*(?:if|elif|else|for|while|try|except|finally|with)\b.*:\s*$/m,
    /^\s{2,}(?:print|return|raise|yield|pass|break|continue)\b/m,
    /\bprint\s*\(/,
  ]);
  if (pythonScore >= 2) {
    return "python";
  }

  const tsScore = countMatches(sample, [
    /^\s*(?:import|export)\s+/m,
    /\b(?:interface|type)\s+[A-Za-z_]\w*\s*[={]/,
    /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*[:=]/,
    /=>/,
    /\bfunction\s+[A-Za-z_$][\w$]*\s*\(/,
  ]);
  if (tsScore >= 2) {
    return /\b(?:interface|type)\s+[A-Za-z_]\w*\s*[={]/.test(sample)
      ? "typescript"
      : "javascript";
  }

  const cssScore = countMatches(sample, [
    /[.#]?[A-Za-z][\w-]*\s*\{[^}]*\}/,
    /\b(?:color|display|position|margin|padding|font-size|background)\s*:/,
  ]);
  if (cssScore >= 2) {
    return "css";
  }

  if (/^#!.*(?:bash|sh|pwsh|powershell)/m.test(sample)) {
    return "shell";
  }

  const shellScore = countMatches(sample, [
    /^\s*(?:echo|export|set|if|for|while)\b/m,
    /\$\{?[A-Za-z_]\w*\}?/,
    /^\s*(?:npm|cargo|git|cd|mkdir|copy|del|rm)\b/m,
  ]);
  if (shellScore >= 2) {
    return "shell";
  }

  return null;
}

export function detectTextLanguageKey(path: string | null, content: string): TextLanguageKey {
  const pathKey = languageKeyFromPath(path);
  if (pathKey && pathKey !== "plain" && pathKey !== "plain-hints") {
    return pathKey;
  }

  return inferLanguageKeyFromContent(content) ?? pathKey ?? "plain";
}

export function textLanguageLabelForKey(key: TextLanguageKey) {
  const labels: Record<TextLanguageKey, string> = {
    batch: "Batch",
    config: "Config",
    cpp: "C/C++",
    css: "CSS",
    delimited: "CSV / TSV",
    diff: "Diff",
    html: "HTML",
    java: "Java",
    javascript: "JavaScript",
    "javascript-react": "JavaScript React",
    json: "JSON",
    log: "Log",
    markdown: "Markdown",
    php: "PHP",
    plain: "Plain text",
    "plain-hints": "Plain text",
    powershell: "PowerShell",
    python: "Python",
    rust: "Rust",
    shell: "Shell",
    sql: "SQL",
    typescript: "TypeScript",
    "typescript-react": "TypeScript React",
    xml: "XML",
    yaml: "YAML",
  };
  return labels[key];
}

export type TextLanguageOption = {
  key: TextLanguageKey;
  /** Extensions offered by Save As; the first one is the default. */
  extensions: string[];
};

/** Languages offered in the picker, in display order. */
export const textLanguageOptions: TextLanguageOption[] = [
  { key: "plain", extensions: ["txt"] },
  { key: "markdown", extensions: ["md", "markdown"] },
  { key: "json", extensions: ["json", "jsonc"] },
  { key: "javascript", extensions: ["js", "mjs", "cjs"] },
  { key: "javascript-react", extensions: ["jsx"] },
  // LMP tells TypeScript ".ts" from MPEG-TS video by the file content.
  { key: "typescript", extensions: ["ts", "mts", "cts"] },
  { key: "typescript-react", extensions: ["tsx"] },
  { key: "html", extensions: ["html", "htm"] },
  { key: "css", extensions: ["css", "scss", "less"] },
  { key: "xml", extensions: ["xml"] },
  { key: "yaml", extensions: ["yaml", "yml"] },
  { key: "python", extensions: ["py"] },
  { key: "rust", extensions: ["rs"] },
  { key: "cpp", extensions: ["cpp", "c", "h", "hpp"] },
  { key: "java", extensions: ["java"] },
  { key: "php", extensions: ["php"] },
  { key: "sql", extensions: ["sql"] },
  { key: "shell", extensions: ["sh", "bash", "zsh"] },
  { key: "powershell", extensions: ["ps1", "psm1"] },
  { key: "batch", extensions: ["bat", "cmd"] },
  { key: "config", extensions: ["ini", "toml", "conf", "cfg", "properties"] },
  { key: "log", extensions: ["log"] },
  { key: "delimited", extensions: ["csv", "tsv"] },
  { key: "diff", extensions: ["diff", "patch"] },
];

export function textLanguageOption(key: TextLanguageKey) {
  const normalized = key === "plain-hints" ? "plain" : key;
  return textLanguageOptions.find((option) => option.key === normalized) ?? textLanguageOptions[0];
}

export function defaultExtensionForLanguage(key: TextLanguageKey) {
  return textLanguageOption(key).extensions[0] ?? "txt";
}

/** Prose languages paste as plain text and skip code helpers such as bracket closing. */
export function isProseLanguage(key: TextLanguageKey) {
  return key === "plain" || key === "plain-hints" || key === "markdown";
}
