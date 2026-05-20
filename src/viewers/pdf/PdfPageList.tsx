import type { PDFDocumentProxy } from "pdfjs-dist";

import { PdfPageThumbnail } from "./PdfThumbnails";

type PdfPageListProps = {
  activePage: number;
  onSelectPage: (page: number) => void;
  pageCount: number;
  pdf: PDFDocumentProxy | null;
};

export function PdfPageList({ activePage, onSelectPage, pageCount, pdf }: PdfPageListProps) {
  return (
    <div className="pdf-page-strip" data-wheel-volume="ignore">
      {pdf && pageCount > 0 ? (
        Array.from({ length: pageCount }, (_, index) => index + 1).map((pageNumber) => (
          <PdfPageThumbnail
            key={pageNumber}
            active={pageNumber === activePage}
            pageNumber={pageNumber}
            pdf={pdf}
            onSelect={() => onSelectPage(pageNumber)}
          />
        ))
      ) : (
        <p className="empty-state">PDF pages are loading...</p>
      )}
    </div>
  );
}
