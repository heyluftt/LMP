import type { PlayerSettings } from "../player/settings";
import { normalizeTextContent } from "./text";
import type { WordDocumentContent } from "./word";

export function countTextLines(text: string) {
  return text.length === 0 ? 0 : text.split("\n").length;
}

function cleanWordBlockText(text: string) {
  return normalizeTextContent(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function headingPrefix(kind: string) {
  const match = /^heading([1-6])$/i.exec(kind);
  const level = match ? Number(match[1]) : 1;
  return "#".repeat(Math.max(1, Math.min(6, level)));
}

export function wordDocumentToEditableText(
  document: WordDocumentContent,
  format: PlayerSettings["textWordExtractionFormat"],
) {
  const blocks = document.blocks
    .map((block) => {
      const lines = cleanWordBlockText(block.text);
      if (lines.length === 0) {
        return "";
      }
      if (format === "plain") {
        return lines.join("\n");
      }

      if (block.kind === "list") {
        return lines.map((line) => `- ${line}`).join("\n");
      }
      if (block.kind === "notice") {
        return lines.map((line) => `> ${line}`).join("\n");
      }
      if (block.kind === "heading" || block.kind.toLowerCase().startsWith("heading")) {
        return `${headingPrefix(block.kind)} ${lines.join(" ")}`;
      }
      return lines.join("\n");
    })
    .filter(Boolean);

  return normalizeTextContent(blocks.join("\n\n"));
}

export function suggestedExtractedTextPath(path: string) {
  const slash = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  const folder = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name || "document";
  return `${folder}${stem}.extracted.txt`;
}
