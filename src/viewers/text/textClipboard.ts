import {
  normalizeEditorPasteText,
  type EditorPasteMode,
  type EditorPasteResult,
} from "./textPaste";

export function editorPasteTextFromClipboard(
  clipboardData: DataTransfer | null,
  mode: EditorPasteMode,
): EditorPasteResult | null {
  if (!clipboardData) {
    return null;
  }

  const plainText = clipboardData.getData("text/plain");
  const htmlText = clipboardData.getData("text/html");
  if (!plainText && !htmlText) {
    return null;
  }

  return normalizeEditorPasteText({
    htmlText,
    mode,
    plainText,
  });
}
