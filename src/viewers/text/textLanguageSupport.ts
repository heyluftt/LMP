import { StreamLanguage, type StringStream } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

import type { TextLanguageKey } from "./textLanguages";

const configLanguage = StreamLanguage.define<null>({
  name: "lmp-config",
  languageData: { commentTokens: { line: "#" } },
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

function shellToken(stream: StringStream) {
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
}

function shellLikeLanguage(name: string, lineComment: string) {
  return StreamLanguage.define<null>({
    name,
    languageData: { commentTokens: { line: lineComment } },
    startState: () => null,
    token: shellToken,
  });
}

const shellLanguage = shellLikeLanguage("lmp-shell", "#");
const powerShellLanguage = shellLikeLanguage("lmp-powershell", "#");
const batchLanguage = shellLikeLanguage("lmp-batch", "REM");

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

const diffLanguage = StreamLanguage.define<null>({
  name: "lmp-diff",
  startState: () => null,
  token(stream) {
    if (!stream.sol()) {
      stream.skipToEnd();
      return null;
    }
    if (stream.match(/^(?:\+\+\+|---|diff |index ).*/)) {
      return "heading";
    }
    if (stream.match(/^@@.*/)) {
      return "keyword";
    }
    if (stream.match(/^\+.*/)) {
      return "string";
    }
    if (stream.match(/^-.*/)) {
      return "invalid";
    }
    stream.skipToEnd();
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
    case "batch":
      return batchLanguage;
    case "config":
      return configLanguage;
    case "diff":
      return diffLanguage;
    case "powershell":
      return powerShellLanguage;
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
