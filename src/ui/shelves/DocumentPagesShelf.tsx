import { ListVideo } from "lucide-react";
import { PdfPageThumbnail } from "../../viewers/pdf";
import { ShelfCloseButton, ShelfHeader } from "./ShelfHeader";
import type { MediaShelvesProps } from "./types";

export function DocumentPagesShelf({
  documentPageCount,
  documentView,
  onClose,
  onSelectDocumentPage,
  pdfDocument,
}: MediaShelvesProps) {
  return (
    <div className="shelf-section pages-section">
      <ShelfHeader
        icon={<ListVideo size={17} />}
        title="Pages"
        meta={documentPageCount > 0 ? `${documentView.page}/${documentPageCount}` : "Loading..."}
        actions={<ShelfCloseButton label="Close pages" onClose={onClose} />}
      />

      <div className="pdf-page-strip" data-wheel-volume="ignore">
        {pdfDocument && documentPageCount > 0 ? (
          Array.from({ length: documentPageCount }, (_, index) => index + 1).map((pageNumber) => (
            <PdfPageThumbnail
              key={pageNumber}
              active={pageNumber === documentView.page}
              pageNumber={pageNumber}
              pdf={pdfDocument}
              onSelect={() => onSelectDocumentPage(pageNumber)}
            />
          ))
        ) : (
          <p className="empty-state">PDF pages are loading...</p>
        )}
      </div>
    </div>
  );
}
