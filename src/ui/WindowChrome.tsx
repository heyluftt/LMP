import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Disc3, Maximize2, Minimize2, Minus, Square, X } from "lucide-react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useRef } from "react";

type WindowChromeProps = {
  title: string;
  canMiniPlayer: boolean;
  miniPlayer: boolean;
  onRequestClose?: () => boolean | Promise<boolean>;
  onToggleMiniPlayer: () => void;
};

type CloseButtonEvent = ReactMouseEvent<HTMLButtonElement> | ReactPointerEvent<HTMLButtonElement>;

export function WindowChrome({
  title,
  canMiniPlayer,
  miniPlayer,
  onRequestClose,
  onToggleMiniPlayer,
}: WindowChromeProps) {
  const appWindow = getCurrentWindow();
  const closingRef = useRef(false);
  const destroyWindow = () => appWindow.destroy().catch(() => undefined);
  const closeWindow = async (event?: CloseButtonEvent) => {
    event?.stopPropagation();
    event?.currentTarget.blur();
    if (closingRef.current) {
      return;
    }

    if ((await onRequestClose?.()) === false) {
      return;
    }
    closingRef.current = true;

    void invoke("close_current_window").catch(() => {
      void destroyWindow();
    });

    window.setTimeout(() => {
      void destroyWindow().finally(() => {
        closingRef.current = false;
      });
    }, 420);
  };

  const startWindowDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) {
      return;
    }

    void appWindow.startDragging().catch(() => undefined);
  };
  const toggleWindowMaximize = (event: ReactMouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement | null)?.closest(".window-controls")) {
      return;
    }

    void appWindow.toggleMaximize();
  };

  return (
    <header className="window-titlebar" onPointerDown={startWindowDrag} onDoubleClick={toggleWindowMaximize}>
      <div className="window-title">
        <span className="window-title-mark" aria-hidden="true">
          <Disc3 size={13} />
        </span>
        <span>{title}</span>
      </div>
      <div
        className="window-controls"
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {canMiniPlayer ? (
          <button
            type="button"
            onClick={onToggleMiniPlayer}
            title={miniPlayer ? "Exit mini player" : "Mini player"}
            aria-label={miniPlayer ? "Exit mini player" : "Mini player"}
          >
            {miniPlayer ? <Maximize2 size={13} /> : <Minimize2 size={13} />}
          </button>
        ) : null}
        <button type="button" onClick={() => void appWindow.minimize()} title="Minimize" aria-label="Minimize">
          <Minus size={14} />
        </button>
        <button
          type="button"
          onClick={() => void appWindow.toggleMaximize()}
          title="Maximize"
          aria-label="Maximize"
        >
          <Square size={12} />
        </button>
        <button
          type="button"
          onPointerDown={(event) => void closeWindow(event)}
          onPointerUp={(event) => void closeWindow(event)}
          onClick={(event) => void closeWindow(event)}
          title="Close"
          aria-label="Close"
        >
          <X size={15} />
        </button>
      </div>
    </header>
  );
}
