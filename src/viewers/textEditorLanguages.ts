import { StreamLanguage } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

import { extension } from "../lib/playerBrain";

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

export type TextLanguageKey =
  | "config"
  | "cpp"
  | "css"
  | "delimited"
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
  | "python"
  | "rust"
  | "shell"
  | "sql"
  | "typescript"
  | "typescript-react"
  | "xml"
  | "yaml";

function languageKeyFromPath(path: string | null): TextLanguageKey | null {
  if (!path) {
    return null;
  }
  const parts = path.split(/[\\/]/).filter(Boolean);
  const name = (parts[parts.length - 1] ?? "").toLowerCase();
  if (name === "dockerfile" || name === "makefile" || name.startsWith(".env")) {
    return "shell";
  }
  if (name === ".editorconfig" || name.endsWith("rc")) {
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
      return "config";
    case "bat":
    case "cmd":
    case "ps1":
    case "sh":
      return "shell";
    case "csv":
    case "tsv":
      return "delimited";
    case "txt":
    case "text":
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
    config: "Config",
    cpp: "C/C++",
    css: "CSS",
    delimited: "Delimited text",
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

export async function loadTextLanguageExtensionForKey(key: TextLanguageKey): Promise<Extension> {
  switch (key) {
    case "cpp": {
      const { cpp } = await import("@codemirror/lang-cpp");
      return cpp();
    }
    case "css": {
      const { css } = await import("@codemirror/lang-css");
      return css();
    }
    case "html": {
      const { html } = await import("@codemirror/lang-html");
      return html();
    }
    case "java": {
      const { java } = await import("@codemirror/lang-java");
      return java();
    }
    case "javascript": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript();
    }
    case "javascript-react": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript({ jsx: true });
    }
    case "typescript": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript({ typescript: true });
    }
    case "typescript-react": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript({ jsx: true, typescript: true });
    }
    case "json": {
      const { json } = await import("@codemirror/lang-json");
      return json();
    }
    case "markdown": {
      const { markdown } = await import("@codemirror/lang-markdown");
      return markdown();
    }
    case "php": {
      const { php } = await import("@codemirror/lang-php");
      return php();
    }
    case "python": {
      const { python } = await import("@codemirror/lang-python");
      return python();
    }
    case "rust": {
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
    case "yaml": {
      const { yaml } = await import("@codemirror/lang-yaml");
      return yaml();
    }
    case "config":
      return configLanguage;
    case "delimited":
      return delimitedTextLanguage;
    case "log":
      return logLanguage;
    case "plain-hints":
      return plainTextHintLanguage;
    case "shell":
      return shellLanguage;
    case "plain":
    default:
      return [];
  }
}

export function loadTextLanguageExtension(path: string | null, content = ""): Promise<Extension> {
  return loadTextLanguageExtensionForKey(detectTextLanguageKey(path, content));
}
