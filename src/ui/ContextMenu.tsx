import {
  BookmarkPlus,
  Captions,
  Check,
  FileText,
  FolderOpen,
  Gauge,
  History,
  Info,
  ListOrdered,
  Maximize2,
  Pause,
  Play,
  Printer,
  RefreshCcw,
  Repeat2,
  RotateCw,
  Save,
  SaveAll,
  Scan,
  Search,
  Settings2,
  SkipBack,
  SkipForward,
  Type,
  Undo2,
  Volume2,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";

export type ContextMenuIcon =
  | "captions"
  | "check"
  | "file"
  | "fit"
  | "folder"
  | "fullscreen"
  | "history"
  | "info"
  | "library"
  | "line"
  | "loop"
  | "mark"
  | "next"
  | "pause"
  | "play"
  | "previous"
  | "print"
  | "recent"
  | "repeat"
  | "rotate"
  | "save"
  | "saveAs"
  | "search"
  | "settings"
  | "speed"
  | "text"
  | "undo"
  | "volume"
  | "zoomIn"
  | "zoomOut";

export type ContextMenuAction = {
  disabled?: boolean;
  hint?: string;
  icon?: ContextMenuIcon;
  id: string;
  label: string;
  onSelect: () => void;
};

export type ContextMenuSection = {
  actions: ContextMenuAction[];
  id: string;
};

type ContextMenuProps = {
  onClose: () => void;
  sections: ContextMenuSection[];
  x: number;
  y: number;
};

const iconMap: Record<ContextMenuIcon, LucideIcon> = {
  captions: Captions,
  check: Check,
  file: FileText,
  fit: Scan,
  folder: FolderOpen,
  fullscreen: Maximize2,
  history: History,
  info: Info,
  library: FolderOpen,
  line: ListOrdered,
  loop: Repeat2,
  mark: BookmarkPlus,
  next: SkipForward,
  pause: Pause,
  play: Play,
  previous: SkipBack,
  print: Printer,
  recent: History,
  repeat: RefreshCcw,
  rotate: RotateCw,
  save: Save,
  saveAs: SaveAll,
  search: Search,
  settings: Settings2,
  speed: Gauge,
  text: Type,
  undo: Undo2,
  volume: Volume2,
  zoomIn: ZoomIn,
  zoomOut: ZoomOut,
};

export function ContextMenu({ onClose, sections, x, y }: ContextMenuProps) {
  const visibleSections = sections
    .map((section) => ({
      ...section,
      actions: section.actions.filter(Boolean),
    }))
    .filter((section) => section.actions.length > 0);

  if (visibleSections.length === 0) {
    return null;
  }

  return (
    <div
      className="context-menu-layer"
      data-wheel-volume="ignore"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDown={onClose}
      role="presentation"
    >
      <div
        className="lmp-context-menu"
        role="menu"
        style={{
          left: `min(${x}px, calc(100vw - 276px))`,
          top: `min(${y}px, calc(100vh - 340px))`,
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {visibleSections.map((section, sectionIndex) => (
          <div className="context-menu-section" key={section.id}>
            {sectionIndex > 0 ? <div className="context-menu-divider" /> : null}
            {section.actions.map((action) => {
              const Icon = action.icon ? iconMap[action.icon] : null;
              return (
                <button
                  type="button"
                  role="menuitem"
                  key={action.id}
                  disabled={action.disabled}
                  onClick={() => {
                    if (action.disabled) {
                      return;
                    }
                    onClose();
                    action.onSelect();
                  }}
                >
                  {Icon ? <Icon size={18} strokeWidth={2.15} /> : <span className="context-menu-spacer" />}
                  <span>{action.label}</span>
                  {action.hint ? <small>{action.hint}</small> : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
