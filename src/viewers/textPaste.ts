export type EditorPasteInput = {
  htmlText?: string;
  plainText?: string;
  mode: EditorPasteMode;
};

export type EditorPasteMode = "code" | "plain" | "writing";
export type EditorPasteSource = "html" | "plain";

export type EditorPasteLineStats = {
  blankLineCount: number;
  lineCount: number;
};

export type EditorPasteDebugInfo = {
  finalBlankLineCount: number;
  finalLineCount: number;
  hasHtml: boolean;
  hasPlain: boolean;
  mode: EditorPasteMode;
  rawBlankLineCount: number;
  rawHtmlLength: number;
  rawLineCount: number;
  rawPlainLength: number;
  source: EditorPasteSource;
  transform: "collapse-artificial-blanks" | "line-endings-only";
};

export type EditorPasteResult = {
  debug: EditorPasteDebugInfo;
  text: string;
};

const blockTags = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DD",
  "DIV",
  "DL",
  "DT",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

const htmlBreakMarker = "\u000b";

function normalizeLineEndings(text: string) {
  return text.replace(/\r+\n/g, "\n").replace(/\r/g, "\n");
}

function lineStats(text: string) {
  const lines = normalizeLineEndings(text).split("\n");
  const blankCount = lines.filter((line) => line.trim().length === 0).length;
  const nonBlankCount = lines.length - blankCount;
  return {
    blankCount,
    lines,
    nonBlankCount,
  };
}

function publicLineStats(text: string): EditorPasteLineStats {
  const stats = lineStats(text);
  return {
    blankLineCount: stats.blankCount,
    lineCount: stats.lines.length,
  };
}

function looksCodeLike(text: string) {
  const { lines, nonBlankCount } = lineStats(text);
  if (nonBlankCount < 3) {
    return false;
  }

  const indentedLines = lines.filter((line) => /^\s{2,}\S/.test(line)).length;
  const structuralCodeLines = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return false;
    }

    return (
      /^(?:import|from|def|class|if|elif|else|for|while|try|except|finally|with|return)\b.*[:()]/.test(
        trimmed,
      ) ||
      /^(?:function|const|let|var|return)\b/.test(trimmed) ||
      /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\s*=/.test(trimmed) ||
      /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(.*\)/.test(trimmed) ||
      /[{};]|=>/.test(trimmed)
    );
  }).length;

  return indentedLines >= 2 || structuralCodeLines >= 3;
}

function blankRunsBetweenText(lines: string[]) {
  let runCount = 0;
  let singleLineRunCount = 0;
  let multiLineRunCount = 0;
  let blankLineCount = 0;
  let sawTextBefore = false;

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim().length > 0) {
      sawTextBefore = true;
      continue;
    }

    const runStart = index;
    while (index + 1 < lines.length && lines[index + 1].trim().length === 0) {
      index += 1;
    }

    const runLength = index - runStart + 1;
    const hasTextAfter = lines.slice(index + 1).some((line) => line.trim().length > 0);
    if (!sawTextBefore || !hasTextAfter) {
      continue;
    }

    runCount += 1;
    blankLineCount += runLength;
    if (runLength === 1) {
      singleLineRunCount += 1;
    } else {
      multiLineRunCount += 1;
    }
  }

  return {
    blankLineCount,
    multiLineRunCount,
    runCount,
    singleLineRunCount,
  };
}

function hasArtificialBlankLines(text: string) {
  const { blankCount, lines, nonBlankCount } = lineStats(text);
  if (nonBlankCount < 3 || blankCount < 2 || looksCodeLike(text)) {
    return false;
  }

  const blankRuns = blankRunsBetweenText(lines);
  const repeatedSingleLineBlanks =
    blankRuns.singleLineRunCount >= Math.max(2, Math.floor(nonBlankCount * 0.45));
  const repeatedWideBlanks = blankRuns.multiLineRunCount >= 2;

  return repeatedSingleLineBlanks || repeatedWideBlanks;
}

function removeArtificialBlankLines(text: string) {
  const lines = normalizeLineEndings(text).split("\n");
  const cleaned: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length > 0) {
      cleaned.push(line);
      continue;
    }

    let runEnd = index;
    while (runEnd + 1 < lines.length && lines[runEnd + 1].trim().length === 0) {
      runEnd += 1;
    }

    const previousText = cleaned.some((entry) => entry.trim().length > 0);
    const nextText = lines.slice(runEnd + 1).some((entry) => entry.trim().length > 0);
    const runLength = runEnd - index + 1;

    if (previousText && nextText && runLength > 1) {
      cleaned.push("");
    } else if (!previousText || !nextText) {
      cleaned.push(...lines.slice(index, runEnd + 1));
    }

    index = runEnd;
  }

  return cleaned.join("\n");
}

function isBlockElement(element: Element) {
  return blockTags.has(element.tagName);
}

function hasBlockChild(element: Element): boolean {
  return Array.from(element.children).some((child) => isBlockElement(child) || hasBlockChild(child));
}

function nodeVisibleText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const element = node as Element;
  const tag = element.tagName;
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
    return "";
  }
  if (tag === "BR") {
    return htmlBreakMarker;
  }

  return Array.from(element.childNodes).map(nodeVisibleText).join("");
}

function trimOuterBlankLines(lines: string[]) {
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start].trim().length === 0) {
    start += 1;
  }
  while (end > start && lines[end - 1].trim().length === 0) {
    end -= 1;
  }

  return lines.slice(start, end);
}

function cleanHtmlBlockLines(text: string, preserveWhitespace: boolean) {
  const normalized = normalizeLineEndings(text);
  if (preserveWhitespace) {
    return trimOuterBlankLines(
      normalized
        .replace(/\u000b/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .split("\n")
        .map((line: string) => line.replace(/[ \t]+$/g, "")),
    );
  }

  return trimOuterBlankLines(
    normalized
      .replace(/\n/g, " ")
      .split(htmlBreakMarker)
      .map((line) => line.replace(/[ \t\f]+/g, " ").trim()),
  );
}

function joinHtmlTextLines(lines: string[]) {
  const trimmed = trimOuterBlankLines(lines);
  const joined: string[] = [];

  for (let index = 0; index < trimmed.length; index += 1) {
    const line = trimmed[index];
    if (line.trim().length > 0) {
      joined.push(line);
      continue;
    }

    const previousText = joined.some((entry) => entry.trim().length > 0);
    const nextText = trimmed.slice(index + 1).some((entry) => entry.trim().length > 0);
    if (previousText && nextText && joined[joined.length - 1]?.trim().length !== 0) {
      joined.push("");
    }
  }

  return joined.join("\n");
}

function htmlToVisibleText(htmlText: string) {
  if (!htmlText.trim() || typeof DOMParser === "undefined") {
    return "";
  }

  const doc = new DOMParser().parseFromString(htmlText, "text/html");
  doc.querySelectorAll("script, style, noscript").forEach((element) => element.remove());

  const lines: string[] = [];
  const blocks = Array.from(doc.body.querySelectorAll(Array.from(blockTags).join(","))).filter(
    (element) => !hasBlockChild(element),
  );

  blocks.forEach((element) => {
    if (element.tagName === "HR") {
      lines.push("", "***", "");
      return;
    }

    const blockLines = cleanHtmlBlockLines(nodeVisibleText(element), element.tagName === "PRE");
    if (blockLines.length === 0) {
      lines.push("");
      return;
    }

    lines.push(...blockLines);
  });

  if (blocks.length > 0) {
    return joinHtmlTextLines(lines);
  }

  return joinHtmlTextLines(cleanHtmlBlockLines(nodeVisibleText(doc.body), false));
}

function choosePasteSource({
  htmlText = "",
  plainText = "",
  mode,
}: EditorPasteInput): { source: EditorPasteSource; text: string } {
  const normalizedPlainText = normalizeLineEndings(plainText);
  if (mode === "code" || looksCodeLike(normalizedPlainText)) {
    return {
      source: "plain",
      text: normalizedPlainText,
    };
  }

  const htmlVisibleText = htmlText.trim().length > 0 ? normalizeLineEndings(htmlToVisibleText(htmlText)) : "";
  if (htmlVisibleText.trim().length > 0) {
    return {
      source: "html",
      text: htmlVisibleText,
    };
  }

  return {
    source: "plain",
    text: normalizedPlainText,
  };
}

function transformPasteText(text: string, mode: EditorPasteMode) {
  if (mode !== "code" && hasArtificialBlankLines(text)) {
    return {
      text: removeArtificialBlankLines(text),
      transform: "collapse-artificial-blanks" as const,
    };
  }

  return {
    text,
    transform: "line-endings-only" as const,
  };
}

export function normalizeEditorPasteText({
  htmlText = "",
  plainText = "",
  mode,
}: EditorPasteInput): EditorPasteResult {
  const chosen = choosePasteSource({ htmlText, mode, plainText });
  const rawStats = publicLineStats(chosen.text);
  const transformed = transformPasteText(chosen.text, mode);
  const finalStats = publicLineStats(transformed.text);

  return {
    debug: {
      finalBlankLineCount: finalStats.blankLineCount,
      finalLineCount: finalStats.lineCount,
      hasHtml: htmlText.trim().length > 0,
      hasPlain: plainText.length > 0,
      mode,
      rawBlankLineCount: rawStats.blankLineCount,
      rawHtmlLength: htmlText.length,
      rawLineCount: rawStats.lineCount,
      rawPlainLength: plainText.length,
      source: chosen.source,
      transform: transformed.transform,
    },
    text: transformed.text,
  };
}

export function runTextPasteSelfTest() {
  const cases = [
    ...(typeof DOMParser === "undefined"
      ? []
      : [
          {
            expected: "A\nB\nC",
            htmlText: "<p>A</p><p>B</p><p>C</p>",
            mode: "writing" as const,
            name: "html paragraph blocks",
            plainText: "A\n\nB\n\nC",
          },
          {
            expected: "Me: Hi\nHim: Hello\nMe: Good.",
            htmlText: "<p>Me: Hi</p><p>Him: Hello</p><p>Me: Good.</p>",
            mode: "writing" as const,
            name: "html dialog blocks",
            plainText: "Me: Hi\n\nHim: Hello\n\nMe: Good.",
          },
          {
            expected: "A\n\n***\n\nB",
            htmlText: "<p>A</p><p></p><p>***</p><p></p><p>B</p>",
            mode: "writing" as const,
            name: "html explicit separator spacing",
            plainText: "A\n\n***\n\nB",
          },
        ]),
    {
      expected: "A\nB\nC",
      input: "A\n\nB\n\nC",
      mode: "writing" as const,
      name: "writing artificial blanks",
    },
    {
      expected: "A if needed\nB if it works\nC if it stays prose",
      input: "A if needed\n\nB if it works\n\nC if it stays prose",
      mode: "writing" as const,
      name: "writing prose with code words",
    },
    {
      expected: "A\n\nB\n\nC",
      input: "A\n\n\nB\n\n\nC",
      mode: "writing" as const,
      name: "writing real paragraphs",
    },
    {
      expected: 'def test():\n    print("hi")\n\nif True:\n    test()',
      input: 'def test():\n    print("hi")\n\nif True:\n    test()',
      mode: "code" as const,
      name: "python code",
    },
  ];

  const results = cases.map((testCase) => {
    const result = normalizeEditorPasteText({
      mode: testCase.mode,
      htmlText: "htmlText" in testCase ? testCase.htmlText : "",
      plainText: "plainText" in testCase ? testCase.plainText : testCase.input,
    });
    return {
      finalBlankLineCount: result.debug.finalBlankLineCount,
      finalLineCount: result.debug.finalLineCount,
      name: testCase.name,
      passed: result.text === testCase.expected,
      source: result.debug.source,
      transform: result.debug.transform,
    };
  });

  return {
    passed: results.every((result) => result.passed),
    results,
  };
}
