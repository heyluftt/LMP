import {
  addCursorAbove,
  addCursorBelow,
  copyLineDown,
  deleteLine,
  indentLess,
  indentMore,
  moveLineDown,
  moveLineUp,
  redo,
  selectAll,
  toggleComment,
  undo,
} from "@codemirror/commands";
import { foldAll, unfoldAll } from "@codemirror/language";
import { selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import { EditorSelection, type ChangeSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export type TextEditCommand =
  | "addCursorAbove"
  | "addCursorBelow"
  | "deleteLine"
  | "duplicateLine"
  | "foldAll"
  | "indentLess"
  | "indentMore"
  | "indentToSpaces"
  | "indentToTabs"
  | "joinLines"
  | "lowerCase"
  | "moveLineDown"
  | "moveLineUp"
  | "redo"
  | "removeDuplicateLines"
  | "selectAll"
  | "selectAllOccurrences"
  | "selectNextOccurrence"
  | "sortLinesAscending"
  | "sortLinesDescending"
  | "titleCase"
  | "toggleComment"
  | "trimTrailingWhitespace"
  | "undo"
  | "unfoldAll"
  | "upperCase";

const lineCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Line numbers covered by the selection, or the whole document for a bare cursor. */
function selectedLineSpan(view: EditorView) {
  const { state } = view;
  const ranges = state.selection.ranges;
  if (ranges.length === 1 && ranges[0].empty) {
    return { first: 1, last: state.doc.lines };
  }
  const first = Math.min(...ranges.map((range) => state.doc.lineAt(range.from).number));
  const last = Math.max(
    ...ranges.map((range) => {
      const line = state.doc.lineAt(range.to);
      // A selection ending at column 0 does not include that line.
      return range.to === line.from && range.to > range.from ? line.number - 1 : line.number;
    }),
  );
  return { first, last: Math.max(first, last) };
}

function replaceLines(view: EditorView, transform: (lines: string[]) => string[]) {
  const { state } = view;
  const { first, last } = selectedLineSpan(view);
  const from = state.doc.line(first).from;
  const to = state.doc.line(last).to;
  const lines = state.sliceDoc(from, to).split("\n");
  const next = transform(lines).join("\n");
  if (next === state.sliceDoc(from, to)) {
    return true;
  }
  view.dispatch({
    changes: { from, to, insert: next },
    selection: EditorSelection.range(from, from + next.length),
    userEvent: "input.transform",
  });
  return true;
}

function transformSelections(view: EditorView, transform: (text: string) => string) {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  const ranges = state.selection.ranges.map((range) => {
    const target = range.empty ? state.wordAt(range.head) ?? range : range;
    const text = state.sliceDoc(target.from, target.to);
    const next = transform(text);
    if (next !== text) {
      changes.push({ from: target.from, to: target.to, insert: next });
    }
    return EditorSelection.range(target.from, target.from + next.length);
  });
  if (changes.length === 0) {
    return true;
  }
  view.dispatch({
    changes,
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    userEvent: "input.transform",
  });
  return true;
}

function titleCase(text: string) {
  return text.toLocaleLowerCase().replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (_, prefix: string, letter: string) =>
    `${prefix}${letter.toLocaleUpperCase()}`,
  );
}

function trimTrailingWhitespace(view: EditorView) {
  const { doc } = view.state;
  const changes: ChangeSpec[] = [];
  for (let number = 1; number <= doc.lines; number += 1) {
    const line = doc.line(number);
    const trailing = /[ \t]+$/.exec(line.text);
    if (trailing) {
      changes.push({ from: line.from + trailing.index, to: line.to });
    }
  }
  if (changes.length > 0) {
    view.dispatch({ changes, userEvent: "input.transform" });
  }
  return true;
}

function convertIndentation(view: EditorView, toTabs: boolean) {
  const { state } = view;
  const size = state.tabSize;
  const changes: ChangeSpec[] = [];
  for (let number = 1; number <= state.doc.lines; number += 1) {
    const line = state.doc.line(number);
    const leading = /^[ \t]+/.exec(line.text)?.[0];
    if (!leading) {
      continue;
    }
    let columns = 0;
    for (const character of leading) {
      columns = character === "\t" ? columns + size - (columns % size) : columns + 1;
    }
    const next = toTabs
      ? "\t".repeat(Math.floor(columns / size)) + " ".repeat(columns % size)
      : " ".repeat(columns);
    if (next !== leading) {
      changes.push({ from: line.from, to: line.from + leading.length, insert: next });
    }
  }
  if (changes.length > 0) {
    view.dispatch({ changes, userEvent: "input.transform" });
  }
  return true;
}

export function runTextEditCommand(view: EditorView, command: TextEditCommand): boolean {
  switch (command) {
    case "undo":
      return undo(view);
    case "redo":
      return redo(view);
    case "selectAll":
      return selectAll(view);
    case "toggleComment":
      return toggleComment(view);
    case "duplicateLine":
      return copyLineDown(view);
    case "deleteLine":
      return deleteLine(view);
    case "moveLineUp":
      return moveLineUp(view);
    case "moveLineDown":
      return moveLineDown(view);
    case "indentMore":
      return indentMore(view);
    case "indentLess":
      return indentLess(view);
    case "addCursorAbove":
      return addCursorAbove(view);
    case "addCursorBelow":
      return addCursorBelow(view);
    case "selectNextOccurrence":
      return selectNextOccurrence(view);
    case "selectAllOccurrences":
      return selectSelectionMatches(view);
    case "foldAll":
      return foldAll(view);
    case "unfoldAll":
      return unfoldAll(view);
    case "upperCase":
      return transformSelections(view, (text) => text.toLocaleUpperCase());
    case "lowerCase":
      return transformSelections(view, (text) => text.toLocaleLowerCase());
    case "titleCase":
      return transformSelections(view, titleCase);
    case "sortLinesAscending":
      return replaceLines(view, (lines) => [...lines].sort(lineCollator.compare));
    case "sortLinesDescending":
      return replaceLines(view, (lines) => [...lines].sort((a, b) => lineCollator.compare(b, a)));
    case "removeDuplicateLines":
      return replaceLines(view, (lines) => Array.from(new Set(lines)));
    case "joinLines":
      return replaceLines(view, (lines) =>
        lines.length < 2 ? lines : [lines.map((line, index) => (index === 0 ? line.trimEnd() : line.trim())).join(" ")],
      );
    case "trimTrailingWhitespace":
      return trimTrailingWhitespace(view);
    case "indentToSpaces":
      return convertIndentation(view, false);
    case "indentToTabs":
      return convertIndentation(view, true);
  }
  return false;
}
