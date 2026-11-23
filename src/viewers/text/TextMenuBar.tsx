import { Play, Save, Search, Terminal } from "lucide-react";

import { TextMenu, type TextMenuItem } from "./TextMenu";

type TextMenuBarProps = {
  dirty: boolean;
  directory: string | null;
  editMenu: () => TextMenuItem[];
  fileMenu: () => TextMenuItem[];
  saveTitle: string;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalRunLabel: string | null;
  terminalRunTitle: string;
  title: string;
  viewMenu: () => TextMenuItem[];
  onFind: () => void;
  onRun: () => void;
  onSave: () => void;
  onToggleTerminal: () => void;
};

export function TextMenuBar({
  dirty,
  directory,
  editMenu,
  fileMenu,
  saveTitle,
  terminalAvailable,
  terminalOpen,
  terminalRunLabel,
  terminalRunTitle,
  title,
  viewMenu,
  onFind,
  onRun,
  onSave,
  onToggleTerminal,
}: TextMenuBarProps) {
  return (
    <div className="text-menu-bar" data-wheel-volume="ignore">
      <nav className="text-menu-group" aria-label="Text editor menu">
        <TextMenu label="File" items={fileMenu} buttonClassName="text-menu-bar-button">
          File
        </TextMenu>
        <TextMenu label="Edit" items={editMenu} buttonClassName="text-menu-bar-button">
          Edit
        </TextMenu>
        <TextMenu label="View" items={viewMenu} buttonClassName="text-menu-bar-button">
          View
        </TextMenu>
      </nav>

      <div className="text-menu-title" title={directory ? `${directory}\\${title}` : title}>
        <strong>
          {title}
          {dirty ? <span className="text-dirty-dot" aria-label="Unsaved changes" /> : null}
        </strong>
        {directory ? <small>{directory}</small> : null}
      </div>

      <div className="text-menu-group is-end">
        {terminalAvailable ? (
          <>
            <button
              type="button"
              className={`text-menu-bar-icon ${terminalOpen ? "active" : ""}`}
              onClick={onToggleTerminal}
              title="Terminal"
              aria-pressed={terminalOpen}
            >
              <Terminal size={15} />
            </button>
            {terminalRunLabel ? (
              <button type="button" className="text-menu-bar-icon has-label" onClick={onRun} title={terminalRunTitle}>
                <Play size={14} />
                <span>{terminalRunLabel}</span>
              </button>
            ) : null}
          </>
        ) : null}
        <button type="button" className="text-menu-bar-icon" onClick={onFind} title="Find (Ctrl+F)" aria-label="Find">
          <Search size={15} />
        </button>
        <button
          type="button"
          className={`text-menu-bar-icon ${dirty ? "is-dirty" : ""}`}
          onClick={onSave}
          title={saveTitle}
          aria-label="Save"
        >
          <Save size={15} />
        </button>
      </div>
    </div>
  );
}
