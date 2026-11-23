import { libraryKindLabel } from "../../lib/mediaFormat";
import type { MediaFolderItem } from "../../player/types";
import type { LibrarySort } from "./types";

export function compareLibraryItems(a: MediaFolderItem, b: MediaFolderItem, sort: LibrarySort) {
  if (a.kind === "folder" && b.kind !== "folder") {
    return -1;
  }
  if (a.kind !== "folder" && b.kind === "folder") {
    return 1;
  }

  if (sort === "date") {
    return (b.modified_at ?? 0) - (a.modified_at ?? 0);
  }
  if (sort === "size") {
    return (b.byte_len ?? 0) - (a.byte_len ?? 0);
  }
  if (sort === "type") {
    const kindCompare = libraryKindLabel(a).localeCompare(libraryKindLabel(b), undefined, {
      sensitivity: "base",
    });
    if (kindCompare !== 0) {
      return kindCompare;
    }
  }

  return a.display_name.localeCompare(b.display_name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}
