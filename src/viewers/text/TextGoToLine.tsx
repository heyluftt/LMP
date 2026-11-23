import { CornerDownLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type TextGoToLineProps = {
  currentLine: number;
  lineCount: number;
  onClose: () => void;
  onGo: (line: number, column: number) => void;
};

/** Accepts "42", "42:7" or "42,7". */
function parseTarget(value: string, lineCount: number) {
  const match = /^\s*(\d+)\s*(?:[:,]\s*(\d+))?\s*$/.exec(value);
  if (!match) {
    return null;
  }
  const line = Number(match[1]);
  const column = match[2] ? Number(match[2]) : 1;
  if (line < 1 || line > lineCount || column < 1) {
    return null;
  }
  return { line, column };
}

export function TextGoToLine({ currentLine, lineCount, onClose, onGo }: TextGoToLineProps) {
  const [value, setValue] = useState(String(currentLine));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const target = parseTarget(value, lineCount);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <form
      className="text-goto"
      data-wheel-volume="ignore"
      onSubmit={(event) => {
        event.preventDefault();
        if (target) {
          onGo(target.line, target.column);
        }
      }}
    >
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        value={value}
        aria-label="Go to line"
        aria-invalid={!target}
        onChange={(event) => setValue(event.currentTarget.value)}
        onBlur={onClose}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      />
      <span className={target ? "" : "is-error"}>
        {target ? `Line ${target.line.toLocaleString()} of ${lineCount.toLocaleString()}` : `1 – ${lineCount.toLocaleString()}, optional :column`}
      </span>
      <button type="submit" disabled={!target} aria-label="Go" onMouseDown={(event) => event.preventDefault()}>
        <CornerDownLeft size={14} />
      </button>
    </form>
  );
}
