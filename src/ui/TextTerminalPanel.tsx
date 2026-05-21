import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

type TextTerminalPanelProps = {
  open: boolean;
  cwd?: string | null;
  runCommand?: string | null;
  runLabel?: string | null;
  runRequestId?: number;
  runTitle?: string;
  onClose: () => void;
};

type TerminalOutputEvent = {
  id: string;
  data: string;
};

type TerminalExitEvent = {
  id: string;
};

const TERMINAL_ID_PREFIX = "lmp-text-editor-terminal";

function normalizeTerminalCwd(cwd?: string | null): string | null {
  if (!cwd) return null;
  const trimmed = cwd.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function TextTerminalPanel({
  open,
  cwd,
  runCommand,
  runLabel,
  runRequestId = 0,
  runTitle,
  onClose,
}: TextTerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastHandledRunRequestRef = useRef(0);

  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<"idle" | "starting" | "running" | "closed" | "error">(
    "idle",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const effectiveCwd = useMemo(() => normalizeTerminalCwd(cwd), [cwd]);
  const sessionId = useMemo(() => {
    const label = getCurrentWindow().label.replace(/[^a-zA-Z0-9_-]/g, "_");
    return `${TERMINAL_ID_PREFIX}-${label}`;
  }, []);

  const sendCommandToTerminal = (command: string | null | undefined) => {
    const nextCommand = command?.trim();
    if (!nextCommand) return;

    terminalRef.current?.focus();

    void invoke("terminal_write", {
      id: sessionId,
      data: `${nextCommand}\r`,
    }).catch((error) => {
      terminalRef.current?.writeln(`\r\n[run failed] ${String(error)}`);
    });
  };

  useEffect(() => {
    if (!open) return;
    if (!containerRef.current) return;
    if (terminalRef.current) return;

    let disposed = false;
    let outputUnlisten: UnlistenFn | null = null;
    let exitUnlisten: UnlistenFn | null = null;

    const disposeTerminalListeners = () => {
      outputUnlisten?.();
      exitUnlisten?.();
      outputUnlisten = null;
      exitUnlisten = null;
    };

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
      fontFamily: "JetBrains Mono, Cascadia Mono, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      theme: {
        background: "#070b0a",
        foreground: "#e8efe9",
        cursor: "#b7f2d0",
        black: "#101413",
        red: "#ff8f8f",
        green: "#a8f0c6",
        yellow: "#eadb8f",
        blue: "#9fc4ff",
        magenta: "#d8b4fe",
        cyan: "#9be7ff",
        white: "#e8efe9",
        brightBlack: "#65706b",
        brightRed: "#ffb4b4",
        brightGreen: "#c5ffd9",
        brightYellow: "#fff0a8",
        brightBlue: "#bfdbff",
        brightMagenta: "#ead5ff",
        brightCyan: "#c4f3ff",
        brightWhite: "#ffffff",
        selectionBackground: "#25483c",
      },
    });

    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const fitAndResize = () => {
      if (disposed) return;

      try {
        fitAddon.fit();
        const dimensions = fitAddon.proposeDimensions();

        if (dimensions) {
          void invoke("terminal_resize", {
            id: sessionId,
            cols: dimensions.cols,
            rows: dimensions.rows,
          });
        }
      } catch {
        // Resize can fail during mount/unmount.
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(fitAndResize);
    });

    resizeObserver.observe(containerRef.current);

    terminal.onData((data) => {
      void invoke("terminal_write", {
        id: sessionId,
        data,
      }).catch((error) => {
        terminal.writeln(`\r\n[terminal write failed] ${String(error)}`);
      });
    });

    setStatus("starting");
    setErrorMessage(null);

    const startTerminal = async () => {
      try {
        const output = await listen<TerminalOutputEvent>("terminal-output", (event) => {
          if (event.payload.id !== sessionId) return;
          terminal.write(event.payload.data);
        });

        if (disposed) {
          output();
          return;
        }

        outputUnlisten = output;

        const exit = await listen<TerminalExitEvent>("terminal-exit", (event) => {
          if (event.payload.id !== sessionId) return;

          if (!disposed) {
            setRunning(false);
            setStatus("closed");
            terminal.writeln("\r\n[terminal closed]");
          }
        });

        if (disposed) {
          exit();
          return;
        }

        exitUnlisten = exit;

        await invoke("terminal_open", {
          id: sessionId,
          cwd: effectiveCwd,
          shell: null,
          cols: 100,
          rows: 24,
        });

        if (disposed) {
          void invoke("terminal_kill", {
            id: sessionId,
          });
          return;
        }

        setRunning(true);
        setStatus("running");

        window.requestAnimationFrame(() => {
          fitAndResize();
          terminal.focus();
        });
      } catch (error) {
        disposeTerminalListeners();
        if (disposed) return;

        const message = String(error);
        setRunning(false);
        setStatus("error");
        setErrorMessage(message);
        terminal.writeln(`[terminal failed to start] ${message}`);
      }
    };

    void startTerminal();

    return () => {
      disposed = true;
      resizeObserver.disconnect();

      disposeTerminalListeners();

      void invoke("terminal_kill", {
        id: sessionId,
      });

      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;

      setRunning(false);
      setStatus("idle");
    };
  }, [open, effectiveCwd, sessionId]);

  useEffect(() => {
    if (!open || !running || !runCommand || runRequestId <= 0) return;
    if (lastHandledRunRequestRef.current === runRequestId) return;

    lastHandledRunRequestRef.current = runRequestId;
    sendCommandToTerminal(runCommand);
  }, [open, running, runCommand, runRequestId]);

  if (!open) return null;

  const canRun = running && Boolean(runCommand?.trim());

  return (
    <section className="text-terminal-panel" aria-label="Text editor terminal">
      <header className="text-terminal-header">
        <div className="text-terminal-title">
          <strong>Terminal</strong>
          <span>{effectiveCwd ?? "Project shell"}</span>
        </div>

        <div className="text-terminal-actions">
          <span className={`text-terminal-pill text-terminal-pill-${status}`}>
            {status === "starting"
              ? "Starting"
              : status === "running"
                ? "Running"
                : status === "closed"
                  ? "Closed"
                  : status === "error"
                    ? "Error"
                    : running
                      ? "Running"
                      : "Idle"}
          </span>

          <button
            type="button"
            className="text-terminal-button text-terminal-run-button"
            disabled={!canRun}
            title={runTitle ?? runCommand ?? "No runnable file detected"}
            onClick={() => sendCommandToTerminal(runCommand)}
          >
            {runLabel ?? "Run"}
          </button>

          <button
            type="button"
            className="text-terminal-button"
            onClick={() => {
              try {
                fitAddonRef.current?.fit();
                terminalRef.current?.focus();
              } catch {
                // Ignore transient fit errors.
              }
            }}
          >
            Fit
          </button>

          <button
            type="button"
            className="text-terminal-button"
            onClick={() => {
              terminalRef.current?.focus();

              if (running) {
                void invoke("terminal_write", {
                  id: sessionId,
                  data: "Clear-Host\r",
                }).catch(() => {
                  terminalRef.current?.write("\x1b[2J\x1b[3J\x1b[H");
                });
                return;
              }

              terminalRef.current?.write("\x1b[2J\x1b[3J\x1b[H");
            }}
          >
            Clear
          </button>

          <button
            type="button"
            className="text-terminal-button text-terminal-close"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </header>

      {errorMessage ? <div className="text-terminal-error">{errorMessage}</div> : null}

      <div ref={containerRef} className="text-terminal-body" />
    </section>
  );
}
