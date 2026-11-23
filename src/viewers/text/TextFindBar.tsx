import { ArrowDown, ArrowUp, ChevronRight, Replace, ReplaceAll, Search, X } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";

import type { TextSearchOptions } from "./textSearch";

type TextFindBarProps = {
  activeIndex: number;
  error: string | null;
  findInputRef: RefObject<HTMLInputElement | null>;
  matchCount: number;
  options: TextSearchOptions;
  readOnly: boolean;
  replaceInputRef: RefObject<HTMLInputElement | null>;
  replaceOpen: boolean;
  replacement: string;
  truncated: boolean;
  onClose: () => void;
  onFind: (direction: -1 | 1) => void;
  onOptionsChange: (patch: Partial<TextSearchOptions>) => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  onReplaceOpenChange: (open: boolean) => void;
  onReplacementChange: (value: string) => void;
};

function countLabel(matchCount: number, activeIndex: number, truncated: boolean, hasQuery: boolean) {
  if (!hasQuery) {
    return "";
  }
  if (matchCount === 0) {
    return "No results";
  }
  const total = `${matchCount.toLocaleString()}${truncated ? "+" : ""}`;
  return activeIndex >= 0 ? `${(activeIndex + 1).toLocaleString()} of ${total}` : `${total} found`;
}

export function TextFindBar({
  activeIndex,
  error,
  findInputRef,
  matchCount,
  options,
  readOnly,
  replaceInputRef,
  replaceOpen,
  replacement,
  truncated,
  onClose,
  onFind,
  onOptionsChange,
  onReplace,
  onReplaceAll,
  onReplaceOpenChange,
  onReplacementChange,
}: TextFindBarProps) {
  const hasQuery = options.query.length > 0;
  const toggles: Array<{ key: "caseSensitive" | "wholeWord" | "regex"; label: string; title: string }> = [
    { key: "caseSensitive", label: "Aa", title: "Match case (Alt+C)" },
    { key: "wholeWord", label: "ab", title: "Match whole word (Alt+W)" },
    { key: "regex", label: ".*", title: "Use regular expression (Alt+R)" },
  ];

  const handleOptionShortcut = (event: ReactKeyboardEvent) => {
    if (!event.altKey || event.ctrlKey) {
      return false;
    }
    const key = event.key.toLowerCase();
    const option = key === "c" ? "caseSensitive" : key === "w" ? "wholeWord" : key === "r" ? "regex" : null;
    if (!option) {
      return false;
    }
    event.preventDefault();
    onOptionsChange({ [option]: !options[option] });
    return true;
  };

  return (
    <div className="text-find-bar" role="search" data-wheel-volume="ignore">
      <button
        type="button"
        className={`text-find-expand ${replaceOpen ? "is-open" : ""}`}
        onClick={() => onReplaceOpenChange(!replaceOpen)}
        title={replaceOpen ? "Hide replace" : "Show replace (Ctrl+H)"}
        aria-label={replaceOpen ? "Hide replace" : "Show replace"}
        aria-expanded={replaceOpen}
        disabled={readOnly}
      >
        <ChevronRight size={15} />
      </button>

      <div className="text-find-rows">
        <div className="text-find-row">
          <label className={`text-find-field ${error ? "has-error" : ""}`}>
            <Search size={14} aria-hidden="true" />
            <input
              ref={findInputRef}
              type="text"
              value={options.query}
              spellCheck={false}
              placeholder="Find"
              aria-label="Find"
              aria-invalid={Boolean(error)}
              onChange={(event) => onOptionsChange({ query: event.currentTarget.value })}
              onKeyDown={(event) => {
                if (handleOptionShortcut(event)) {
                  return;
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  onFind(event.shiftKey ? -1 : 1);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  onClose();
                }
              }}
            />
            <span className="text-find-toggles">
              {toggles.map((toggle) => (
                <button
                  key={toggle.key}
                  type="button"
                  className={options[toggle.key] ? "active" : ""}
                  aria-pressed={options[toggle.key]}
                  title={toggle.title}
                  onClick={() => onOptionsChange({ [toggle.key]: !options[toggle.key] })}
                >
                  {toggle.label}
                </button>
              ))}
            </span>
          </label>

          <span className={`text-find-count ${error ? "is-error" : ""}`} aria-live="polite" title={error ?? undefined}>
            {error ? "Invalid pattern" : countLabel(matchCount, activeIndex, truncated, hasQuery)}
          </span>

          <button type="button" onClick={() => onFind(-1)} disabled={matchCount === 0} title="Previous match (Shift+F3)" aria-label="Previous match">
            <ArrowUp size={15} />
          </button>
          <button type="button" onClick={() => onFind(1)} disabled={matchCount === 0} title="Next match (F3)" aria-label="Next match">
            <ArrowDown size={15} />
          </button>
          <button type="button" onClick={onClose} title="Close (Esc)" aria-label="Close find">
            <X size={15} />
          </button>
        </div>

        {replaceOpen && !readOnly ? (
          <div className="text-find-row">
            <label className="text-find-field">
              <Replace size={14} aria-hidden="true" />
              <input
                ref={replaceInputRef}
                type="text"
                value={replacement}
                spellCheck={false}
                placeholder={options.regex ? "Replace ($1, $<name>, $&)" : "Replace"}
                aria-label="Replace"
                onChange={(event) => onReplacementChange(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (handleOptionShortcut(event)) {
                    return;
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (event.ctrlKey && event.altKey) {
                      onReplaceAll();
                    } else {
                      onReplace();
                    }
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    onClose();
                  }
                }}
              />
            </label>
            <button type="button" className="text-find-wide" onClick={onReplace} disabled={matchCount === 0} title="Replace (Enter)">
              <Replace size={14} />
              <span>Replace</span>
            </button>
            <button type="button" className="text-find-wide" onClick={onReplaceAll} disabled={matchCount === 0} title="Replace all (Ctrl+Alt+Enter)">
              <ReplaceAll size={14} />
              <span>All</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
