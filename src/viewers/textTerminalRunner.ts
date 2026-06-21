import { extension } from "../lib/playerBrain";

export function directoryFromPath(path?: string | null): string | null {
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

export function runCommandForTextFile(path: string | null, content: string): string | null {
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

export function runLabelForCommand(command: string | null): string {
  if (!command) return "Run";

  if (command.startsWith("python ")) return "Run Python";
  if (command.startsWith("node ")) return "Run Node";
  if (command.startsWith("powershell ")) return "Run PS1";
  if (command.startsWith("cmd /c ")) return "Run CMD";
  if (command.startsWith("bash ")) return "Run Bash";

  return "Run";
}
