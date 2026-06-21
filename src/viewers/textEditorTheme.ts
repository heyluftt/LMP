import { HighlightStyle } from "@codemirror/language";
import { EditorView } from "codemirror";
import { tags } from "@lezer/highlight";

export type TextFontFamily = "mono" | "system" | "serif" | "sans";

const editorFontFamilies: Record<TextFontFamily, string> = {
  mono: '"Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace',
  system: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  sans: '"Segoe UI", Inter, ui-sans-serif, system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", ui-serif, serif',
};

export function lmpEditorTheme(
  fontSize: number,
  fontFamily: TextFontFamily,
  writingMode = false,
) {
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        color: "rgba(255, 248, 238, 0.92)",
        background: "transparent",
        fontSize: `${fontSize}px`,
      },
      ".cm-scroller": {
        height: "100%",
        overflow: "auto",
        fontFamily: editorFontFamilies[fontFamily],
        lineHeight: writingMode ? "1.48" : "1.5",
        scrollbarColor: "rgba(164, 234, 208, 0.32) rgba(255, 255, 255, 0.05)",
      },
      ".cm-content": {
        width: writingMode ? "min(74ch, 100%)" : "auto",
        minHeight: "100%",
        margin: writingMode ? "0 auto" : "0",
        padding: writingMode ? "30px 22px 46px" : "15px 0",
        caretColor: "#a4ead0",
        fontWeight: writingMode ? "430" : "inherit",
      },
      ".cm-line": {
        padding: writingMode ? "0" : "0 18px 0 14px",
      },
      ".cm-gutters": {
        minHeight: "100%",
        color: "rgba(247, 242, 235, 0.34)",
        background: "rgba(255, 255, 255, 0.028)",
        borderRight: "1px solid rgba(255, 255, 255, 0.07)",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        minWidth: "34px",
        padding: "0 10px 0 8px",
      },
      ".cm-activeLine": {
        background: writingMode ? "transparent" : "rgba(164, 234, 208, 0.055)",
      },
      ".cm-activeLineGutter": {
        color: "rgba(255, 248, 238, 0.74)",
        background: "rgba(164, 234, 208, 0.08)",
      },
      "&.cm-focused": {
        outline: "none",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        background: "rgba(141, 193, 255, 0.32) !important",
      },
      ".cm-cursor": {
        borderLeftColor: "#a4ead0",
      },
      ".cm-matchingBracket, .cm-nonmatchingBracket": {
        outline: "1px solid rgba(164, 234, 208, 0.34)",
        background: "rgba(164, 234, 208, 0.08)",
      },
      ".cm-searchMatch": {
        background: "rgba(224, 198, 112, 0.2)",
        outline: "1px solid rgba(224, 198, 112, 0.28)",
      },
      ".cm-searchMatch-selected": {
        background: "rgba(164, 234, 208, 0.24)",
        outlineColor: "rgba(164, 234, 208, 0.45)",
      },
    },
    { dark: true },
  );
}

export const lmpHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "#e0c670", fontWeight: "700" },
  { tag: [tags.atom, tags.bool, tags.null], color: "#d9a9ff" },
  { tag: [tags.number, tags.integer, tags.float], color: "#f0a97f" },
  { tag: [tags.string, tags.regexp, tags.special(tags.string)], color: "#a4ead0" },
  { tag: tags.comment, color: "rgba(247, 242, 235, 0.42)", fontStyle: "italic" },
  { tag: [tags.variableName, tags.self], color: "#fff8ee" },
  { tag: [tags.definition(tags.variableName), tags.function(tags.variableName)], color: "#8dc1ff" },
  { tag: [tags.className, tags.typeName, tags.namespace], color: "#f1dc8b" },
  { tag: [tags.propertyName, tags.attributeName], color: "#b7e7d3" },
  { tag: [tags.tagName, tags.heading], color: "#f0a97f", fontWeight: "700" },
  { tag: [tags.operator, tags.punctuation], color: "rgba(255, 248, 238, 0.64)" },
  { tag: tags.link, color: "#8dc1ff", textDecoration: "underline" },
  { tag: tags.invalid, color: "#ffb2a6" },
]);
