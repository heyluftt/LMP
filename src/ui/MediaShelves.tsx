import { DocumentPagesShelf } from "./shelves/DocumentPagesShelf";
import { InfoShelf } from "./shelves/InfoShelf";
import { LibraryShelf } from "./shelves/LibraryShelf";
import { MomentsShelf } from "./shelves/MomentsShelf";
import { QueueShelf } from "./shelves/QueueShelf";
import { RecentShelf } from "./shelves/RecentShelf";
import { TrimShelf } from "./shelves/TrimShelf";
import { TracksShelf } from "./shelves/TracksShelf";
import { shelfClassName, shouldShowShelf, type MediaShelvesProps } from "./shelves/types";

export type { LibraryFilter, LibrarySort, MediaShelfMode } from "./shelves/types";

export function MediaShelves(props: MediaShelvesProps) {
  const { capabilities, shelfMode } = props;

  if (!shouldShowShelf(props)) {
    return null;
  }

  return (
    <section className={shelfClassName(shelfMode)} aria-label="Media lists">
      {shelfMode === "library" ? <LibraryShelf {...props} /> : null}
      {shelfMode === "pages" && capabilities.documentPages ? <DocumentPagesShelf {...props} /> : null}
      {shelfMode === "info" ? <InfoShelf {...props} /> : null}
      {shelfMode === "tracks" && capabilities.tracks ? <TracksShelf {...props} /> : null}
      {shelfMode === "moments" && capabilities.moments ? <MomentsShelf {...props} /> : null}
      {shelfMode === "trim" ? <TrimShelf {...props} /> : null}
      {shelfMode === "queue" && capabilities.queue ? <QueueShelf {...props} /> : null}
      {shelfMode === "recent" ? <RecentShelf {...props} /> : null}
    </section>
  );
}
