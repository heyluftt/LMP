import { Check } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

export type TextMenuItem =
  | {
      kind: "action";
      id: string;
      label: string;
      checked?: boolean;
      detail?: string;
      disabled?: boolean;
      shortcut?: string;
      onSelect: () => void;
    }
  | { kind: "header"; id: string; label: string }
  | { kind: "separator"; id: string };

type TextMenuProps = {
  align?: "start" | "end";
  buttonClassName?: string;
  children: ReactNode;
  disabled?: boolean;
  items: TextMenuItem[] | (() => TextMenuItem[]);
  label: string;
  /** Controlled open state; the menu manages it itself when omitted. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  placement?: "down" | "up";
  searchPlaceholder?: string;
  title?: string;
};

export function textMenuAction(
  id: string,
  label: string,
  onSelect: () => void,
  options: { checked?: boolean; detail?: string; disabled?: boolean; shortcut?: string } = {},
): TextMenuItem {
  return { kind: "action", id, label, onSelect, ...options };
}

export function textMenuSeparator(id: string): TextMenuItem {
  return { kind: "separator", id };
}

export function textMenuHeader(id: string, label: string): TextMenuItem {
  return { kind: "header", id, label };
}

/** Drops separators that would start, end or double up after filtering. */
function tidySeparators(items: TextMenuItem[]) {
  const result: TextMenuItem[] = [];
  for (const item of items) {
    if (item.kind === "separator" && (result.length === 0 || result[result.length - 1].kind === "separator")) {
      continue;
    }
    result.push(item);
  }
  while (result.length > 0 && result[result.length - 1].kind === "separator") {
    result.pop();
  }
  return result;
}

export function TextMenu({
  align = "start",
  buttonClassName = "",
  children,
  disabled = false,
  items,
  label,
  open: controlledOpen,
  onOpenChange,
  placement = "down",
  searchPlaceholder,
  title,
}: TextMenuProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const [filter, setFilter] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const menuId = useId();

  const resolvedItems = useMemo(() => {
    if (!open) {
      return [];
    }
    const all = typeof items === "function" ? items() : items;
    const query = filter.trim().toLowerCase();
    if (!query) {
      return tidySeparators(all);
    }
    return all.filter(
      (item) =>
        item.kind === "action" &&
        (item.label.toLowerCase().includes(query) || item.detail?.toLowerCase().includes(query)),
    );
  }, [filter, items, open]);

  const close = useCallback(() => {
    setOpen(false);
    setFilter("");
  }, [setOpen]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        close();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [close, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    window.setTimeout(() => {
      if (searchPlaceholder) {
        filterRef.current?.focus();
        return;
      }
      const checked = listRef.current?.querySelector<HTMLButtonElement>("button[aria-checked='true']");
      (checked ?? listRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();
    }, 0);
  }, [open, searchPlaceholder]);

  const moveFocus = (direction: 1 | -1) => {
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (buttons.length === 0) {
      return;
    }
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = index < 0 ? (direction > 0 ? 0 : buttons.length - 1) : (index + direction + buttons.length) % buttons.length;
    buttons[next].focus();
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      rootRef.current?.querySelector<HTMLButtonElement>(".text-menu-trigger")?.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter" && event.target === filterRef.current) {
      const first = resolvedItems.find((item) => item.kind === "action" && !item.disabled);
      if (first?.kind === "action") {
        event.preventDefault();
        close();
        first.onSelect();
      }
    }
  };

  return (
    <div className={`text-menu ${open ? "is-open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className={`text-menu-trigger ${buttonClassName}`}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        disabled={disabled}
        title={title ?? label}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {children}
      </button>

      {open ? (
        <div
          className={`text-menu-popover placement-${placement} align-${align}`}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          data-wheel-volume="ignore"
        >
          {searchPlaceholder ? (
            <input
              ref={filterRef}
              className="text-menu-filter"
              type="search"
              value={filter}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              onChange={(event) => setFilter(event.currentTarget.value)}
            />
          ) : null}
          <div className="text-menu-list" ref={listRef}>
            {resolvedItems.length === 0 ? <p className="text-menu-empty">No matches</p> : null}
            {resolvedItems.map((item) => {
              if (item.kind === "separator") {
                return <div key={item.id} className="text-menu-separator" role="separator" />;
              }
              if (item.kind === "header") {
                return (
                  <div key={item.id} className="text-menu-header">
                    {item.label}
                  </div>
                );
              }
              return (
                <button
                  key={item.id}
                  type="button"
                  role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                  aria-checked={item.checked === undefined ? undefined : item.checked}
                  className="text-menu-item"
                  disabled={item.disabled}
                  onClick={() => {
                    close();
                    item.onSelect();
                  }}
                >
                  <span className="text-menu-check" aria-hidden="true">
                    {item.checked ? <Check size={13} /> : null}
                  </span>
                  <span className="text-menu-label">
                    {item.label}
                    {item.detail ? <small>{item.detail}</small> : null}
                  </span>
                  {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
