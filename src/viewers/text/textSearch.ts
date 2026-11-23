export type TextMatch = {
  start: number;
  end: number;
};

export type TextSearchOptions = {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
};

export type TextSearchResult = {
  error: string | null;
  matches: TextMatch[];
  truncated: boolean;
};

export const textSearchMatchLimit = 20_000;

export const emptyTextSearchResult: TextSearchResult = {
  error: null,
  matches: [],
  truncated: false,
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildTextSearchRegExp(options: TextSearchOptions): { error: string | null; regex: RegExp | null } {
  if (!options.query) {
    return { error: null, regex: null };
  }
  const source = options.regex ? options.query : escapeRegExp(options.query);
  const bounded = options.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])` : source;
  try {
    return {
      error: null,
      regex: new RegExp(bounded, `gmu${options.caseSensitive ? "" : "i"}`),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message.replace(/^Invalid regular expression: /, "") : "Invalid pattern",
      regex: null,
    };
  }
}

export function collectTextMatches(
  text: string,
  options: TextSearchOptions,
  limit = textSearchMatchLimit,
): TextSearchResult {
  const { error, regex } = buildTextSearchRegExp(options);
  if (!regex) {
    return { ...emptyTextSearchResult, error };
  }

  const matches: TextMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match[0].length === 0) {
      // Empty matches (e.g. "^" or "\b") would never advance; skip past them.
      regex.lastIndex += 1;
      continue;
    }
    matches.push({ start: match.index, end: match.index + match[0].length });
    if (matches.length >= limit) {
      return { error: null, matches, truncated: true };
    }
  }
  return { error: null, matches, truncated: false };
}

/** Expands `$&`, `$1`..`$99`, `$<name>` and `$$` like String.prototype.replace. */
export function expandTextReplacement(template: string, match: RegExpExecArray) {
  return template.replace(/\$(\$|&|<([^>]+)>|(\d{1,2}))/g, (token, kind: string, name?: string, digits?: string) => {
    if (kind === "$") {
      return "$";
    }
    if (kind === "&") {
      return match[0];
    }
    if (name !== undefined) {
      return match.groups?.[name] ?? "";
    }
    if (digits !== undefined) {
      const index = Number(digits);
      if (index > 0 && index < match.length) {
        return match[index] ?? "";
      }
    }
    return token;
  });
}

/**
 * Computes the replacement text for every match. In regex mode capture groups
 * are expanded against the full document so lookarounds keep their context.
 */
export function replacementsFor(
  text: string,
  options: TextSearchOptions,
  replacement: string,
  matches: TextMatch[],
) {
  if (!options.regex) {
    return matches.map((match) => ({ from: match.start, to: match.end, insert: replacement }));
  }
  const { regex } = buildTextSearchRegExp(options);
  if (!regex) {
    return [];
  }
  return matches.flatMap((target) => {
    regex.lastIndex = target.start;
    const match = regex.exec(text);
    if (!match || match.index !== target.start) {
      return [];
    }
    return [{ from: target.start, to: target.end, insert: expandTextReplacement(replacement, match) }];
  });
}
