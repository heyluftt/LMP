import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeft, Disc3, Minimize2, Minus, Square, X } from "lucide-react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useRef } from "react";

import { MiniPlayerChrome } from "./MiniPlayerChrome";

type WindowChromeProps = {
  title: string;
  canMiniPlayer: boolean;
  canGoHome?: boolean;
  miniPlayer: boolean;
  onGoHome?: () => void;
  onPointerActivity?: () => void;
  onRequestClose?: () => boolean | Promise<boolean>;
  onToggleMiniPlayer: () => void;
};

type CloseButtonEvent = ReactMouseEvent<HTMLButtonElement> | ReactPointerEvent<HTMLButtonElement>;

export function WindowChrome({
  title,
  canMiniPlayer,
  canGoHome = false,
  miniPlayer,
  onGoHome,
  onPointerActivity,
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
    closingRef.current = true;

    if ((await onRequestClose?.()) === false) {
      closingRef.current = false;
      return;
    }

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

  if (miniPlayer) {
    return (
      <header
        className="window-titlebar mini-titlebar"
        onPointerDown={startWindowDrag}
        onPointerMove={onPointerActivity}
      >
        <MiniPlayerChrome onExitMiniPlayer={onToggleMiniPlayer} />
      </header>
    );
  }

  return (
    <header
      className="window-titlebar"
      onPointerDown={startWindowDrag}
      onPointerMove={onPointerActivity}
      onDoubleClick={toggleWindowMaximize}
    >
      <div className="window-title">
        {canGoHome ? (
          <button
            type="button"
            className="window-home-button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              event.currentTarget.blur();
              onGoHome?.();
            }}
            title="Back to home"
            aria-label="Back to home"
          >
            <ArrowLeft size={14} />
          </button>
        ) : null}
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
            title="Mini player"
            aria-label="Mini player"
          >
            <Minimize2 size={13} />
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
          onPointerDown={(event) => event.stopPropagation()}
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
