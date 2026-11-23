const videoExtensions = new Set([
  "mp4",
  "mkv",
  "mov",
  "avi",
  "webm",
  "m4v",
  "wmv",
  "m2ts",
  "mpeg",
  "mpg",
  "mpe",
  "ogv",
  "3gp",
  "3g2",
  "flv",
  "f4v",
  "asf",
  "vob",
  "divx",
  "mxf",
]);
const audioExtensions = new Set([
  "mp3",
  "flac",
  "wav",
  "m4a",
  "aac",
  "ogg",
  "opus",
  "wma",
  "aiff",
  "aif",
  "oga",
  "weba",
  "caf",
  "amr",
  "mka",
  "mp2",
  "mpa",
  "ac3",
  "eac3",
  "dts",
  "dtshd",
  "ape",
  "alac",
  "au",
  "snd",
]);

const imageExtensions = new Set([
  "jpg",
  "jpeg",
  "jfif",
  "png",
  "gif",
  "webp",
  "bmp",
  "avif",
  "svg",
  "ico",
  "tif",
  "tiff",
]);

const documentExtensions = new Set(["pdf", "doc", "docx", "docm", "dotx", "dotm"]);

const textExtensions = new Set([
  "txt",
  "md",
  "markdown",
  "log",
  "json",
  "jsonc",
  "csv",
  "tsv",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "conf",
  "cfg",
  "css",
  "scss",
  "sass",
  "less",
  "html",
  "htm",
  "xhtml",
  "js",
  "jsx",
  "tsx",
  "mjs",
  "cjs",
  "cts",
  "vue",
  "svelte",
  "astro",
  "rs",
  "py",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "cs",
  "go",
  "php",
  "rb",
  "sh",
  "ps1",
  "bat",
  "cmd",
  "sql",
  "lua",
  "dart",
  "kt",
  "kts",
  "swift",
  "pl",
  "r",
  "gradle",
  "text",
  "diff",
  "patch",
  "properties",
  "env",
  "rst",
  "tex",
  "bash",
  "zsh",
  "psm1",
  "psd1",
  "reg",
  "vbs",
  "nfo",
  "graphql",
  "gql",
  "proto",
  "tf",
]);

const textFileNames = new Set([
  ".bashrc",
  ".dockerignore",
  ".editorconfig",
  ".eslintrc",
  ".gitattributes",
  ".gitignore",
  ".gitmodules",
  ".htaccess",
  ".npmrc",
  ".prettierrc",
  ".profile",
  ".zshrc",
  "changelog",
  "dockerfile",
  "gemfile",
  "jenkinsfile",
  "license",
  "makefile",
  "procfile",
  "rakefile",
  "readme",
  "vagrantfile",
]);

export type MediaKind = "audio" | "video" | "image" | "document" | "text" | "unknown";

// `.ts` and `.mts` are MPEG-TS video or TypeScript. The backend reads the file
// content (`prepare_media`, `resolve_media_kinds`); unchecked files count as video.
const contentKindExtensions = new Set(["ts", "mts"]);
const contentKinds = new Map<string, MediaKind>();

function contentKindKey(path: string) {
  return path.trim().replace(/\\/g, "/").toLowerCase();
}

export function fileName(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function extension(path: string) {
  const name = fileName(path);
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1).toLowerCase() : "";
}

export function mediaKind(path: string): MediaKind {
  return knownMediaKind(path) ?? "video";
}

/** Like `mediaKind`, but null for a `.ts`/`.mts` file whose content was not checked yet. */
export function knownMediaKind(path: string): MediaKind | null {
  const ext = extension(path);
  const name = fileName(path).toLowerCase();
  if (contentKindExtensions.has(ext)) {
    return contentKinds.get(contentKindKey(path)) ?? null;
  }
  if (videoExtensions.has(ext)) {
    return "video";
  }
  if (audioExtensions.has(ext)) {
    return "audio";
  }
  if (imageExtensions.has(ext)) {
    return "image";
  }
  if (documentExtensions.has(ext)) {
    return "document";
  }
  if (textExtensions.has(ext) || textFileNames.has(name) || name.startsWith(".env")) {
    return "text";
  }
  return "unknown";
}

export function needsContentKind(path: string) {
  return contentKindExtensions.has(extension(path)) && !contentKinds.has(contentKindKey(path));
}

/** Stores the kind the backend read from a `.ts`/`.mts` file. */
export function rememberContentKind(path: string, kind: MediaKind) {
  if (contentKindExtensions.has(extension(path)) && (kind === "video" || kind === "text")) {
    contentKinds.set(contentKindKey(path), kind);
  }
}

export function isPlayablePath(path: string) {
  return mediaKind(path) !== "unknown";
}

export function buildRecentList(path: string, current: string[], limit = 12) {
  return [path, ...current.filter((item) => item !== path)].slice(0, limit);
}

export function clampVolume(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function normalizeSpeed(value: number) {
  return Math.max(0.25, Math.min(2, Math.round(value * 100) / 100));
}

export function seekStep(seconds: number, shiftKey = false, multiplier = 6) {
  if (shiftKey) {
    return seconds * multiplier;
  }
  return seconds;
}

export function formatClock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "00:00";
  }

  const rounded = Math.floor(seconds);
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = rounded % 60;

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }

  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}
