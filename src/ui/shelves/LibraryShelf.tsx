import { FolderOpen, Search } from "lucide-react";
import { formatBytes, formatModifiedDate, libraryKindLabel } from "../../lib/mediaFormat";
import { MediaThumbnail } from "../MediaThumbnail";
import { ShelfCloseButton, ShelfHeader } from "./ShelfHeader";
import { libraryFilters, type LibrarySort, type MediaShelvesProps } from "./types";

export function LibraryShelf({
  currentPath,
  libraryFilter,
  libraryFolder,
  libraryFolderLabel,
  libraryLoading,
  librarySearch,
  librarySort,
  onChooseLibraryFolder,
  onClose,
  onLibraryFilterChange,
  onLibrarySearchChange,
  onLibrarySortChange,
  onLoadLibraryFolder,
  onOpenLibraryItem,
  visibleLibraryItems,
}: MediaShelvesProps) {
  return (
    <div className="shelf-section library-section">
      <ShelfHeader
        icon={<FolderOpen size={17} />}
        title="Library"
        meta={libraryLoading ? "Loading..." : libraryFolderLabel}
        metaTitle={libraryFolder?.path}
        actions={
          <>
            {libraryFolder?.parent ? (
              <button type="button" onClick={() => onLoadLibraryFolder(libraryFolder.parent ?? "")}>
                Up
              </button>
            ) : null}
            <button type="button" onClick={onChooseLibraryFolder}>
              Open folder
            </button>
            <ShelfCloseButton label="Close library" onClose={onClose} />
          </>
        }
      />

      <div className="library-toolbar" data-wheel-volume="ignore">
        <label className="library-search">
          <Search size={15} />
          <input
            type="search"
            value={librarySearch}
            onChange={(event) => onLibrarySearchChange(event.currentTarget.value)}
            placeholder="Search media"
            aria-label="Search library"
          />
        </label>
        <div className="library-filters" aria-label="Library filters">
          {libraryFilters.map((filter) => (
            <button
              key={filter}
              type="button"
              className={libraryFilter === filter ? "active" : ""}
              onClick={() => onLibraryFilterChange(filter)}
            >
              {filter === "all" ? "All" : filter === "folder" ? "Folders" : filter}
            </button>
          ))}
        </div>
        <select
          className="library-sort-select"
          value={librarySort}
          onChange={(event) => onLibrarySortChange(event.currentTarget.value as LibrarySort)}
          aria-label="Sort library"
        >
          <option value="name">Name</option>
          <option value="date">Modified</option>
          <option value="type">Type</option>
          <option value="size">Size</option>
        </select>
      </div>

      <div className="library-list">
        {libraryLoading ? (
          <p className="empty-state">Loading folder...</p>
        ) : visibleLibraryItems.length === 0 ? (
          <p className="empty-state">No matching media in this folder</p>
        ) : (
          visibleLibraryItems.slice(0, 80).map((item) => (
            <button
              key={item.path}
              type="button"
              className={item.path === currentPath ? "active" : ""}
              onClick={() => onOpenLibraryItem(item)}
              title={item.path}
            >
              {item.kind === "folder" ? (
                <FolderOpen size={15} />
              ) : (
                <MediaThumbnail path={item.path} kind={item.kind} size={15} />
              )}
              <strong>{item.display_name}</strong>
              <span>
                {item.kind === "folder" ? "Folder" : `${libraryKindLabel(item)} ${formatBytes(item.byte_len)}`}
              </span>
              <small>{formatModifiedDate(item.modified_at)}</small>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
