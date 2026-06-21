import { lazy, Suspense, type RefObject } from "react";

import type { PlayerSettings } from "../player/settings";
import type { MediaShelfMode } from "../ui/MediaShelves";
import type { TextEditorHandle, TextViewState } from "./text";
import { TextTools } from "./textTools";
import type { TextMatch } from "./textSearch";

const TextEditorSurface = lazy(() =>
  import("./textEditorSurface").then((module) => ({
    default: module.TextEditorSurface,
  })),
);

type TextWorkspaceProps = {
  activeSearchIndex: number;
  activeShelf: MediaShelfMode;
  caseSensitive: boolean;
  currentPath: string | null;
  currentTitle: string;
  editorRef: RefObject<TextEditorHandle | null>;
  findInputRef: RefObject<HTMLInputElement | null>;
  findMatchCount: number;
  findPositionLabel: string;
  findQuery: string;
  isFullscreen: boolean;
  onChange: (draft: string) => void;
  onApplyWritingPreset: () => void;
  onFind: (direction: -1 | 1) => void;
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
  saveReady: boolean;
  searchMatches: TextMatch[];
  settings: PlayerSettings;
  toolsOpen: boolean;
  view: TextViewState;
  wholeWord: boolean;
  writingMode: boolean;
  writingPresetActive: boolean;
  wordWrap: boolean;
};

export function TextWorkspace({
  activeSearchIndex,
  activeShelf,
  caseSensitive,
  currentPath,
  currentTitle,
  editorRef,
  findInputRef,
  findMatchCount,
  findPositionLabel,
  findQuery,
  isFullscreen,
  onChange,
  onApplyWritingPreset,
  onFind,
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
  saveReady,
  searchMatches,
  settings,
  toolsOpen,
  view,
  wholeWord,
  writingMode,
  writingPresetActive,
  wordWrap,
}: TextWorkspaceProps) {
  const toolShelf =
    activeShelf === "info" ||
    activeShelf === "library" ||
    activeShelf === "recent" ||
    activeShelf === "settings"
      ? activeShelf
      : null;

  return (
    <>
      <Suspense
        fallback={
          <div className="text-viewport">
            <div className="text-status">Loading editor...</div>
          </div>
        }
      >
        <TextEditorSurface
          activeSearchIndex={activeSearchIndex}
          autoCloseBrackets={settings.textAutoCloseBrackets}
          enableIntegratedTerminal={settings.enableIntegratedTerminal}
          fontFamily={settings.textFontFamily}
          fontSize={settings.textFontSize}
          lineNumbersVisible={settings.textLineNumbers}
          path={currentPath}
          searchMatches={searchMatches}
          syntaxHighlightingEnabled={settings.textSyntaxHighlighting}
          tabSize={settings.textTabSize}
          title={currentTitle}
          view={view}
          writingMode={writingMode}
          onChange={onChange}
          editorRef={editorRef}
          wordWrap={wordWrap}
        />
      </Suspense>

      <TextTools
        activeShelf={toolShelf}
        caseSensitive={caseSensitive}
        dirty={saveReady}
        findInputRef={findInputRef}
        findMatchCount={findMatchCount}
        findPositionLabel={findPositionLabel}
        findQuery={findQuery}
        isFullscreen={isFullscreen}
        onApplyWritingPreset={onApplyWritingPreset}
        onFind={onFind}
        onFindQueryChange={onFindQueryChange}
        onGoToLine={onGoToLine}
        onOpenInfo={onOpenInfo}
        onOpenLibrary={onOpenLibrary}
        onOpenRecent={onOpenRecent}
        onOpenSettings={onOpenSettings}
        onReplaceAll={onReplaceAll}
        onReplaceCurrent={onReplaceCurrent}
        onReplaceOpenChange={onReplaceOpenChange}
        onReplaceQueryChange={onReplaceQueryChange}
        onRevert={onRevert}
        onRedo={onRedo}
        onSave={onSave}
        onSaveAs={onSaveAs}
        onToggleFullscreen={onToggleFullscreen}
        onToggleTools={onToggleTools}
        onToggleWordWrap={onToggleWordWrap}
        onUndo={onUndo}
        onUpdateCaseSensitive={onUpdateCaseSensitive}
        onUpdateWholeWord={onUpdateWholeWord}
        replaceInputRef={replaceInputRef}
        replaceOpen={replaceOpen}
        replaceQuery={replaceQuery}
        toolsOpen={toolsOpen}
        wholeWord={wholeWord}
        writingPresetActive={writingPresetActive}
        wordWrap={wordWrap}
      />
    </>
  );
}
