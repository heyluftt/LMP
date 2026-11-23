export type TextStats = {
  characterCount: number;
  letterCount: number;
  wordCount: number;
};

const letterPattern = /\p{L}/gu;
const wordPattern = /[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu;

export function countTextStats(text: string): TextStats {
  return {
    characterCount: Array.from(text).length,
    letterCount: text.match(letterPattern)?.length ?? 0,
    wordCount: text.match(wordPattern)?.length ?? 0,
  };
}

export function formatTextStats(stats: TextStats) {
  return `${stats.wordCount.toLocaleString()} words - ${stats.characterCount.toLocaleString()} chars`;
}
