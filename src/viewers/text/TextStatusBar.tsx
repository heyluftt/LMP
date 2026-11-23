import { Lock, LockOpen } from "lucide-react";

import type { TextCursorInfo } from "./textEditorHandle";
import { textEncodingOptions, textEncodingShortLabel } from "./textEncodings";
import { textIndentationLabel, type TextIndentation } from "./textIndentation";
import {
  textLanguageLabelForKey,
  textLanguageOptions,
  type TextLanguageKey,
} from "./textLanguages";
import { TextMenu, textMenuAction, textMenuHeader, textMenuSeparator, type TextMenuItem } from "./TextMenu";
import { textLineEndingLabel, type TextDocument, type TextLineEnding } from "./textModel";
import type { TextStats } from "./textStats";

export type TextEncodingPicker = "reopen" | "save" | null;

type TextStatusBarProps = {
  cursor: TextCursorInfo;
  dirty: boolean;
  doc: TextDocument;
  encodingPicker: TextEncodingPicker;
  indentation: TextIndentation;
  languageKey: TextLanguageKey;
  lines: number;
  stats: TextStats | null;
  zoomPercent: number;
  onConvertIndentation: (toTabs: boolean) => void;
  onEncodingPickerChange: (picker: TextEncodingPicker) => void;
  onGoToLine: () => void;
  onLanguageChange: (key: TextLanguageKey | null) => void;
  onIndentationChange: (indentation: TextIndentation) => void;
  onLineEndingChange: (lineEnding: TextLineEnding) => void;
  onReopenWithEncoding: (encoding: string) => void;
  onResetZoom: () => void;
  onSaveWithEncoding: (encoding: string) => void;
  onToggleLock: () => void;
};

export function TextStatusBar({
  cursor,
  dirty,
  doc,
  encodingPicker,
  indentation,
  languageKey,
  lines,
  stats,
  zoomPercent,
  onConvertIndentation,
  onEncodingPickerChange,
  onGoToLine,
  onIndentationChange,
  onLanguageChange,
  onLineEndingChange,
  onReopenWithEncoding,
  onResetZoom,
  onSaveWithEncoding,
  onToggleLock,
}: TextStatusBarProps) {
  const canReopen = doc.sourceType === "file" && Boolean(doc.path);
  const encodingLabel = textEncodingShortLabel(doc.encoding);

  const selectionLabel =
    cursor.selections > 1
      ? `${cursor.selections} selections (${cursor.selectedChars.toLocaleString()} chars)`
      : cursor.selectedChars > 0
        ? `(${cursor.selectedChars.toLocaleString()} selected${cursor.selectedLines > 1 ? `, ${cursor.selectedLines} lines` : ""})`
        : "";

  const languageItems = (): TextMenuItem[] => [
    textMenuAction("auto", "Auto detect", () => onLanguageChange(null), {
      checked: doc.languageId === null,
      detail: doc.languageId === null ? textLanguageLabelForKey(languageKey) : textLanguageLabelForKey(doc.detectedLanguage),
    }),
    textMenuSeparator("auto-separator"),
    ...textLanguageOptions.map((option) =>
      textMenuAction(option.key, textLanguageLabelForKey(option.key), () => onLanguageChange(option.key), {
        checked: doc.languageId === option.key,
        detail: option.extensions.map((extension) => `.${extension}`).join(" "),
      }),
    ),
  ];

  const encodingModeItems = (): TextMenuItem[] => [
    textMenuHeader("current", `${textEncodingShortLabel(doc.encoding)}${doc.encodingSource === "fallback" ? " (guessed)" : ""}`),
    textMenuAction("reopen", "Reopen with Encoding…", () => onEncodingPickerChange("reopen"), {
      disabled: !canReopen,
      detail: "Reinterpret the file on disk",
    }),
    textMenuAction("save", "Save with Encoding…", () => onEncodingPickerChange("save"), {
      disabled: doc.locked,
      detail: "Convert and save",
    }),
  ];

  const encodingItems = (): TextMenuItem[] =>
    textEncodingOptions.map((option) =>
      textMenuAction(
        option.id,
        option.label,
        () => (encodingPicker === "reopen" ? onReopenWithEncoding(option.id) : onSaveWithEncoding(option.id)),
        { checked: option.id === doc.encoding, detail: option.group },
      ),
    );

  const lineEndingItems = (): TextMenuItem[] => [
    textMenuAction("lf", "LF", () => onLineEndingChange("lf"), {
      checked: doc.lineEnding === "lf",
      detail: "Unix, macOS, most code",
    }),
    textMenuAction("crlf", "CRLF", () => onLineEndingChange("crlf"), {
      checked: doc.lineEnding === "crlf",
      detail: "Windows, Notepad, batch files",
    }),
    textMenuAction("cr", "CR", () => onLineEndingChange("cr"), {
      checked: doc.lineEnding === "cr",
      detail: "Classic Mac OS",
    }),
  ];

  const indentationItems = (): TextMenuItem[] => [
    textMenuHeader("indent-using", "Indent using"),
    textMenuAction("spaces", "Spaces", () => onIndentationChange({ ...indentation, useTabs: false }), {
      checked: !indentation.useTabs,
    }),
    textMenuAction("tabs", "Tabs", () => onIndentationChange({ ...indentation, useTabs: true }), {
      checked: indentation.useTabs,
    }),
    textMenuHeader("size", "Width"),
    ...[2, 3, 4, 8].map((size) =>
      textMenuAction(`size-${size}`, `${size}`, () => onIndentationChange({ ...indentation, size }), {
        checked: indentation.size === size,
      }),
    ),
    textMenuSeparator("convert-separator"),
    textMenuAction("to-spaces", "Convert indentation to spaces", () => onConvertIndentation(false), {
      disabled: doc.locked,
    }),
    textMenuAction("to-tabs", "Convert indentation to tabs", () => onConvertIndentation(true), {
      disabled: doc.locked,
    }),
  ];

  return (
    <footer className="text-status-bar" data-wheel-volume="ignore">
      <div className="text-status-group">
        <button type="button" className="text-status-item" onClick={onGoToLine} title="Go to line (Ctrl+G)">
          Ln {cursor.line.toLocaleString()}, Col {cursor.column.toLocaleString()}
        </button>
        {selectionLabel ? <span className="text-status-note">{selectionLabel}</span> : null}
        <span className="text-status-note" title={stats ? `${stats.letterCount.toLocaleString()} letters` : undefined}>
          {lines.toLocaleString()} {lines === 1 ? "line" : "lines"}
          {stats ? ` · ${stats.wordCount.toLocaleString()} words · ${stats.characterCount.toLocaleString()} chars` : ""}
        </span>
        <span className={`text-status-state ${dirty ? "is-dirty" : ""}`}>
          {doc.loading ? "Loading…" : dirty ? "Unsaved" : doc.sourceType === "file" ? "Saved" : doc.sourceType === "word-extract" ? "Extracted copy" : "Not saved yet"}
        </span>
      </div>

      <div className="text-status-group is-end">
        {doc.readOnly || doc.binary || doc.locked ? (
          <button
            type="button"
            className={`text-status-item ${doc.locked ? "is-warning" : ""}`}
            onClick={onToggleLock}
            title={doc.locked ? "Allow editing" : "Lock editing"}
          >
            {doc.locked ? <Lock size={12} /> : <LockOpen size={12} />}
            {doc.locked ? "Read-only" : "Editing"}
          </button>
        ) : null}

        {zoomPercent !== 100 ? (
          <button type="button" className="text-status-item" onClick={onResetZoom} title="Reset zoom (Ctrl+0)">
            {zoomPercent}%
          </button>
        ) : null}

        <TextMenu
          label="Indentation"
          placement="up"
          align="end"
          buttonClassName="text-status-item"
          items={indentationItems}
          title="Indentation"
        >
          {textIndentationLabel(indentation)}
        </TextMenu>

        <div className="text-status-encoding">
          <TextMenu
            label="Encoding"
            placement="up"
            align="end"
            buttonClassName={`text-status-item ${doc.decodeErrors || doc.encodingSource === "fallback" ? "is-warning" : ""}`}
            items={encodingModeItems}
            title="Change encoding"
          >
            {encodingLabel}
          </TextMenu>
          {encodingPicker ? (
            <TextMenu
              label={encodingPicker === "reopen" ? "Reopen with encoding" : "Save with encoding"}
              placement="up"
              align="end"
              buttonClassName="text-status-picker-anchor"
              items={encodingItems}
              open
              onOpenChange={(open) => {
                if (!open) {
                  onEncodingPickerChange(null);
                }
              }}
              searchPlaceholder={encodingPicker === "reopen" ? "Reopen with encoding" : "Save with encoding"}
            >
              <span aria-hidden="true" />
            </TextMenu>
          ) : null}
        </div>

        <TextMenu
          label="Line endings"
          placement="up"
          align="end"
          buttonClassName={`text-status-item ${doc.mixedLineEndings ? "is-warning" : ""}`}
          items={lineEndingItems}
          title={doc.mixedLineEndings ? "Mixed line endings; saving unifies them" : "Line endings"}
          disabled={doc.locked}
        >
          {textLineEndingLabel(doc.lineEnding)}
          {doc.mixedLineEndings ? "*" : ""}
        </TextMenu>

        <TextMenu
          label="Language"
          placement="up"
          align="end"
          buttonClassName="text-status-item"
          items={languageItems}
          searchPlaceholder="Select language mode"
          title="Select language mode"
        >
          {textLanguageLabelForKey(languageKey)}
        </TextMenu>
      </div>
    </footer>
  );
}
