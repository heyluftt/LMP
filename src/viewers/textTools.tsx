import {
  FileText,
  FolderOpen,
  History,
  Info,
  ListOrdered,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PenLine,
  Redo2,
  RefreshCcw,
  Save,
  SaveAll,
  Search,
  Settings2,
  Undo2,
} from "lucide-react";
import type { RefObject } from "react";

type TextToolShelf = "info" | "library" | "recent" | "settings" | null;

type TextToolsProps = {
  activeShelf: TextToolShelf;
  caseSensitive: boolean;
  dirty: boolean;
  findInputRef: RefObject<HTMLInputElement | null>;
  findMatchCount: number;
  findPositionLabel: string;
  findQuery: string;
  isFullscreen: boolean;
  onFind: (direction: -1 | 1) => void;
  onApplyWritingPreset: () => void;
  onFindQueryChange: (value: string) => void;
  onGoToLine: () => void;
  onOpenInfo: () => void;
  onOpenLibrary: () => void;
  onOpenRecent: () => void;
  onOpenSettings: () => void;
  onReplaceAll: () => void;
  onReplaceCurrent: () => void;
  onReplaceOpenChange: (open: boolean) => void;
  onReplaceQueryChange: (value: string) => void;
  onRevert: () => void;
  onRedo: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onToggleFullscreen: () => void;
  onToggleTools: () => void;
  onToggleWordWrap: () => void;
  onUndo: () => void;
  onUpdateCaseSensitive: (value: boolean) => void;
  onUpdateWholeWord: (value: boolean) => void;
  replaceInputRef: RefObject<HTMLInputElement | null>;
  replaceOpen: boolean;
  replaceQuery: string;
  toolsOpen: boolean;
  wholeWord: boolean;
  writingPresetActive: boolean;
  wordWrap: boolean;
};

export function TextTools({
  activeShelf,
  caseSensitive,
  dirty,
  findInputRef,
  findMatchCount,
  findPositionLabel,
  findQuery,
  isFullscreen,
  onFind,
  onApplyWritingPreset,
  onFindQueryChange,
  onGoToLine,
  onOpenInfo,
  onOpenLibrary,
  onOpenRecent,
  onOpenSettings,
  onReplaceAll,
  onReplaceCurrent,
  onReplaceOpenChange,
  onReplaceQueryChange,
  onRevert,
  onRedo,
  onSave,
  onSaveAs,
  onToggleFullscreen,
  onToggleTools,
  onToggleWordWrap,
  onUndo,
  onUpdateCaseSensitive,
  onUpdateWholeWord,
  replaceInputRef,
  replaceOpen,
  replaceQuery,
  toolsOpen,
  wholeWord,
  writingPresetActive,
  wordWrap,
}: TextToolsProps) {
  return (
    <div className="text-floating-actions" data-wheel-volume="ignore">
      {toolsOpen ? (
        <div className="tool-popover text-tools text-floating-popover" aria-label="Text tools">
          <div className="text-find-row">
            <Search size={15} />
            <input
              ref={findInputRef}
              type="search"
              value={findQuery}
              onChange={(event) => onFindQueryChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onFind(event.shiftKey ? -1 : 1);
                }
              }}
              placeholder="Find in text"
              aria-label="Find in text"
            />
            <span aria-live="polite">{findPositionLabel}</span>
            <button type="button" onClick={() => onFind(-1)} disabled={!findQuery.trim()}>
              Prev
            </button>
            <button type="button" onClick={() => onFind(1)} disabled={!findQuery.trim()}>
              Next
            </button>
          </div>

          {replaceOpen ? (
            <div className="text-replace-row">
              <input
                ref={replaceInputRef}
                type="text"
                value={replaceQuery}
                onChange={(event) => onReplaceQueryChange(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    onReplaceCurrent();
                  }
                }}
                placeholder="Replace with"
                aria-label="Replace with"
              />
              <button type="button" onClick={onReplaceCurrent} disabled={findMatchCount === 0}>
                Replace
              </button>
              <button type="button" onClick={onReplaceAll} disabled={findMatchCount === 0}>
                All
              </button>
            </div>
          ) : null}

          <div className="text-find-options">
            <button
              type="button"
              className={caseSensitive ? "active" : ""}
              onClick={() => onUpdateCaseSensitive(!caseSensitive)}
              title="Case sensitive"
              aria-pressed={caseSensitive}
            >
              Aa
            </button>
            <button
              type="button"
              className={wholeWord ? "active" : ""}
              onClick={() => onUpdateWholeWord(!wholeWord)}
              title="Whole word"
              aria-pressed={wholeWord}
            >
              Word
            </button>
            <button
              type="button"
              className={replaceOpen ? "active" : ""}
              onClick={() => onReplaceOpenChange(!replaceOpen)}
              aria-pressed={replaceOpen}
            >
              Replace
            </button>
            <button type="button" onClick={onGoToLine} title="Go to line">
              <ListOrdered size={14} />
              Line
            </button>
          </div>

          <div className="text-tool-section primary">
            <span className="text-tool-section-label">File</span>
            <button
              className={`tool-action playback-tool ${dirty ? "active" : ""}`}
              onClick={onSave}
              disabled={!dirty}
              title="Save text"
            >
              <Save size={17} />
              <span>Save</span>
            </button>
            <button className="tool-action playback-tool" onClick={onSaveAs} title="Save text as">
              <SaveAll size={17} />
              <span>Save As</span>
            </button>
            <button className="tool-action playback-tool" onClick={onRevert} disabled={!dirty} title="Revert unsaved text">
              <RefreshCcw size={17} />
              <span>Revert</span>
            </button>
          </div>

          <div className="text-tool-section">
            <span className="text-tool-section-label">Write</span>
            <button className="tool-action playback-tool" onClick={onUndo} title="Undo text edit">
              <Undo2 size={17} />
              <span>Undo</span>
            </button>
            <button className="tool-action playback-tool" onClick={onRedo} title="Redo text edit">
              <Redo2 size={17} />
              <span>Redo</span>
            </button>
            <button
              className={`tool-action playback-tool ${wordWrap ? "active" : ""}`}
              onClick={onToggleWordWrap}
              title="Toggle word wrap"
            >
              <FileText size={17} />
              <span>Wrap</span>
            </button>
            <button
              className={`tool-action playback-tool ${writingPresetActive ? "active" : ""}`}
              onClick={onApplyWritingPreset}
              title={writingPresetActive ? "Exit writing mode" : "Enter writing mode"}
              aria-pressed={writingPresetActive}
            >
              <PenLine size={17} />
              <span>Writing</span>
            </button>
          </div>

          <div className="text-tool-section secondary">
            <span className="text-tool-section-label">View</span>
            <button
              className="tool-action playback-tool"
              onClick={onToggleFullscreen}
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
              <span>Fullscreen</span>
            </button>
            <button className={`tool-action panel-tool ${activeShelf === "recent" ? "active" : ""}`} onClick={onOpenRecent}>
              <History size={17} />
              <span>Recent</span>
            </button>
            <button className={`tool-action panel-tool ${activeShelf === "library" ? "active" : ""}`} onClick={onOpenLibrary}>
              <FolderOpen size={17} />
              <span>Library</span>
            </button>
            <button className={`tool-action system-tool ${activeShelf === "info" ? "active" : ""}`} onClick={onOpenInfo}>
              <Info size={17} />
              <span>Info</span>
            </button>
            <button
              className={`tool-action system-tool ${activeShelf === "settings" ? "active" : ""}`}
              onClick={onOpenSettings}
            >
              <Settings2 size={17} />
              <span>Settings</span>
            </button>
          </div>
        </div>
      ) : null}

      <button
        className={`icon-button text-floating-toggle ${toolsOpen ? "active" : ""} ${dirty ? "has-dirty" : ""}`}
        onClick={onToggleTools}
        title="Text tools"
        aria-label="Text tools"
      >
        <MoreHorizontal size={19} />
      </button>
    </div>
  );
}
