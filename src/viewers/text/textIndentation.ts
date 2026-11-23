export type TextIndentation = {
  useTabs: boolean;
  size: number;
};

const sampleLineLimit = 4000;

/**
 * Guesses how a file is indented from the leading whitespace of its lines.
 * Returns null when the sample has too few indented lines to tell.
 */
export function detectTextIndentation(text: string): TextIndentation | null {
  let tabLines = 0;
  let spaceLines = 0;
  const spaceSteps = new Map<number, number>();
  let previousSpaces = 0;
  let start = 0;

  for (let lineIndex = 0; lineIndex < sampleLineLimit && start <= text.length; lineIndex += 1) {
    const end = text.indexOf("\n", start);
    const line = text.slice(start, end < 0 ? text.length : end);
    start = end < 0 ? text.length + 1 : end + 1;

    if (!line.trim()) {
      continue;
    }
    if (line.startsWith("\t")) {
      tabLines += 1;
      previousSpaces = 0;
      continue;
    }
    const spaces = /^ */.exec(line)?.[0].length ?? 0;
    if (spaces > 0) {
      spaceLines += 1;
    }
    const step = Math.abs(spaces - previousSpaces);
    if (step >= 2 && step <= 8) {
      spaceSteps.set(step, (spaceSteps.get(step) ?? 0) + 1);
    }
    previousSpaces = spaces;
  }

  if (tabLines + spaceLines < 3) {
    return null;
  }
  if (tabLines > spaceLines) {
    return { useTabs: true, size: 4 };
  }

  let bestStep = 0;
  let bestCount = 0;
  for (const [step, count] of spaceSteps) {
    if (count > bestCount || (count === bestCount && step < bestStep)) {
      bestStep = step;
      bestCount = count;
    }
  }
  return bestStep ? { useTabs: false, size: bestStep } : null;
}

export function textIndentationLabel(indentation: TextIndentation) {
  return indentation.useTabs ? `Tabs: ${indentation.size}` : `Spaces: ${indentation.size}`;
}
