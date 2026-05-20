import { ListVideo } from "lucide-react";
import { PdfPageList } from "../../viewers/pdf";
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

      <PdfPageList
        activePage={documentView.page}
        pageCount={documentPageCount}
        pdf={pdfDocument}
        onSelectPage={onSelectDocumentPage}
      />
    </div>
  );
}
