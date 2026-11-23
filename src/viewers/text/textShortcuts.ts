export type TextShortcut =
  | "close"
  | "find"
  | "findNext"
  | "findPrevious"
  | "goToLine"
  | "new"
  | "open"
  | "redo"
  | "replace"
  | "save"
  | "saveAs"
  | "toggleWrap"
  | "undo"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset";

/**
 * Maps a key event to a text workspace shortcut. App-level key handling skips
 * these so the editor owns them while a text document is open.
 */
export function textShortcutFor(event: KeyboardEvent): TextShortcut | null {
  const key = event.key.toLowerCase();
  const ctrl = event.ctrlKey || event.metaKey;

  if (event.key === "F3") {
    return event.shiftKey ? "findPrevious" : "findNext";
  }
  if (event.altKey && !ctrl && key === "z") {
    return "toggleWrap";
  }
  if (!ctrl || event.altKey) {
    return null;
  }
  if (event.shiftKey) {
    if (key === "s") {
      return "saveAs";
    }
    if (key === "z") {
      return "redo";
    }
    return null;
  }
  switch (key) {
    case "n":
      return "new";
    case "o":
      return "open";
    case "s":
      return "save";
    case "f":
      return "find";
    case "h":
      return "replace";
    case "g":
      return "goToLine";
    case "w":
      return "close";
    case "z":
      return "undo";
    case "y":
      return "redo";
    case "=":
    case "+":
      return "zoomIn";
    case "-":
      return "zoomOut";
    case "0":
      return "zoomReset";
    default:
      return null;
  }
}

export const textShortcutLabels: Partial<Record<TextShortcut, string>> = {
  close: "Ctrl+W",
  find: "Ctrl+F",
  findNext: "F3",
  goToLine: "Ctrl+G",
  new: "Ctrl+N",
  open: "Ctrl+O",
  redo: "Ctrl+Y",
  replace: "Ctrl+H",
  save: "Ctrl+S",
  saveAs: "Ctrl+Shift+S",
  toggleWrap: "Alt+Z",
  undo: "Ctrl+Z",
  zoomIn: "Ctrl++",
  zoomOut: "Ctrl+-",
  zoomReset: "Ctrl+0",
};
