export type TextMatch = {
  start: number;
  end: number;
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function collectTextMatches(
  text: string,
  query: string,
  caseSensitive: boolean,
  wholeWord: boolean,
) {
  const needle = query.trim();
  if (!needle) {
    return [];
  }

  const pattern = wholeWord ? `\\b${escapeRegExp(needle)}\\b` : escapeRegExp(needle);
  const flags = caseSensitive ? "g" : "gi";
  const regex = new RegExp(pattern, flags);
  const matches: TextMatch[] = [];

  for (const match of text.matchAll(regex)) {
    const value = match[0];
    if (!value) {
      continue;
    }
    const start = match.index ?? 0;
    matches.push({ start, end: start + value.length });
  }

  return matches;
}
