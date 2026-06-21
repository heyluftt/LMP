import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

import type { TextMatch } from "./textSearch";

export const updateSearchHighlights = StateEffect.define<{
  activeIndex: number;
  matches: TextMatch[];
}>();

function buildSearchDecorations(matches: TextMatch[], activeIndex: number): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  matches
    .map((match, index) => ({ ...match, index }))
    .filter((match) => match.end > match.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .forEach((match) => {
      builder.add(
        match.start,
        match.end,
        Decoration.mark({
          class: match.index === activeIndex ? "cm-lmp-search-active" : "cm-lmp-search-hit",
        }),
      );
    });
  return builder.finish();
}

export const searchHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (decorations, transaction) => {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(updateSearchHighlights)) {
        next = buildSearchDecorations(effect.value.matches, effect.value.activeIndex);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});
