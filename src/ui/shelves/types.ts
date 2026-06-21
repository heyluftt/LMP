import type { PDFDocumentProxy } from "pdfjs-dist";
import { canOpenShelf, type MediaCapabilities } from "../../player/capabilities";
import type { MediaFolder, MediaFolderItem, MediaInspection, MediaInspectionItem, Moment } from "../../player/types";
import type { DocumentViewState } from "../../viewers/pdf";
import type { ClipPresetId, ClipExportProgress } from "../../player/types";

export type MediaShelfMode =
  | "info"
  | "library"
  | "moments"
  | "pages"
  | "queue"
  | "recent"
  | "settings"
  | "trim"
  | "tracks"
  | null;

export type LibraryFilter = "all" | "folder" | "video" | "audio" | "image" | "document" | "text";
export type LibrarySort = "name" | "date" | "type" | "size";

export type MediaShelvesProps = {
  audioInspectionItems: MediaInspectionItem[];
  backendHint: string;
  capabilities: MediaCapabilities;
  currentPath: string | null;
  dataInspectionItems: MediaInspectionItem[];
  documentPageCount: number;
  documentView: DocumentViewState;
  engineHint?: string;
  hasMedia: boolean;
  libraryFilter: LibraryFilter;
  libraryFolder: MediaFolder | null;
  libraryFolderLabel: string;
  libraryLoading: boolean;
  librarySearch: string;
  librarySort: LibrarySort;
  mediaInspection: MediaInspection | null;
  mediaInspectionLoading: boolean;
  moments: Moment[];
  nativeAudioTrackCount: number;
  nativeAudioTrackIndex: number;
  onAddFilesToQueue: () => void;
  onChooseLibraryFolder: () => void;
  onClearQueue: () => void;
  onClearRecent: () => void;
  onClearSubtitleTrack: () => void;
  onClose: () => void;
  onCancelTrimExport: () => void;
  onDeleteMoment: (id: string) => void;
  onExportTrimClip: () => void;
  onJumpMoment: (direction: -1 | 1) => void;
  onJumpToTrimEnd: () => void;
  onJumpToTrimStart: () => void;
  onJumpToMoment: (seconds: number) => void;
  onLibraryFilterChange: (filter: LibraryFilter) => void;
  onLibrarySearchChange: (query: string) => void;
  onLibrarySortChange: (sort: LibrarySort) => void;
  onLoadLibraryFolder: (path: string) => void;
  onOpenLibraryItem: (item: MediaFolderItem) => void;
  onOpenTrimResult: () => void;
  onOpenSubtitle: () => void;
  onMoveQueueItem: (index: number, direction: -1 | 1) => void;
  onPlayQueueIndex: (index: number) => void;
  onPlayRecent: (path: string) => void;
  onPreviewTrimRange: () => void;
  onRefreshInspection: () => void;
  onRemoveQueueItem: (index: number) => void;
  onSelectDocumentPage: (page: number) => void;
  onSelectNativeAudioTrack: (index: number) => void;
  onSetTrimEndFromCurrent: () => void;
  onSetTrimPreset: (preset: ClipPresetId) => void;
  onSetTrimStartFromCurrent: () => void;
  onShowTrimResult: () => void;
  onToggleSubtitles: () => void;
  overviewInspectionItems: MediaInspectionItem[];
  pdfDocument: PDFDocumentProxy | null;
  queue: string[];
  queueCount: number;
  queueIndex: number;
  recent: string[];
  shelfMode: MediaShelfMode;
  streamInspectionItems: MediaInspectionItem[];
  subtitleInspectionItems: MediaInspectionItem[];
  subtitleTrackLabel: string | null;
  subtitlesEnabled: boolean;
  trimCanExport: boolean;
  trimDuration: number;
  trimEnd: number;
  trimError: string | null;
  trimExport: ClipExportProgress | null;
  trimOutputPath: string | null;
  trimPreset: ClipPresetId;
  trimStart: number;
  videoInspectionItems: MediaInspectionItem[];
  visibleLibraryItems: MediaFolderItem[];
};

export const libraryFilters: LibraryFilter[] = ["all", "folder", "video", "audio", "image", "document", "text"];

export function inspectionKindClass(item: MediaInspectionItem) {
  const label = item.label.toLowerCase();
  if (label.startsWith("video")) {
    return "video";
  }
  if (label.startsWith("audio")) {
    return "audio";
  }
  if (label.startsWith("subtitle")) {
    return "subtitle";
  }
  if (label.startsWith("data") || label.startsWith("attachment")) {
    return "data";
  }
  return "meta";
}

export function shouldShowShelf({
  capabilities,
  hasMedia,
  shelfMode,
}: Pick<
  MediaShelvesProps,
  "capabilities" | "hasMedia" | "shelfMode"
>) {
  return hasMedia && shelfMode !== "settings" && canOpenShelf(capabilities, shelfMode);
}

export function shelfClassName(mode: MediaShelfMode) {
  return [
    "media-shelf",
    mode === "info" ? "info-shelf" : "",
    mode === "tracks" ? "tracks-shelf" : "",
    mode === "pages" ? "pages-shelf" : "",
    mode === "library" ? "library-shelf" : "",
    mode === "queue" ? "queue-shelf" : "",
    mode === "recent" ? "recent-shelf" : "",
    mode === "trim" ? "trim-shelf" : "",
  ]
    .filter(Boolean)
    .join(" ");
}
