import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

import type { TextMatch } from "./textSearch";

export const updateSearchHighlights = StateEffect.define<{
  activeIndex: number;
  matches: TextMatch[];
}>();

const hitMark = Decoration.mark({ class: "cm-lmp-search-hit" });
const activeMark = Decoration.mark({ class: "cm-lmp-search-active" });

function buildSearchDecorations(matches: TextMatch[], activeIndex: number, docLength: number): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  // Matches arrive sorted by position from collectTextMatches.
  matches.forEach((match, index) => {
    if (match.end > match.start && match.end <= docLength) {
      builder.add(match.start, match.end, index === activeIndex ? activeMark : hitMark);
    }
  });
  return builder.finish();
}

export const searchHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (decorations, transaction) => {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(updateSearchHighlights)) {
        next = buildSearchDecorations(
          effect.value.matches,
          effect.value.activeIndex,
          transaction.state.doc.length,
        );
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});
