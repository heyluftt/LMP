import type { PDFDocumentProxy } from "pdfjs-dist";
import { nextAnimationFrame } from "../../lib/animationFrame";

function pdfPrintScale(pageWidth: number, pageCount: number) {
  const targetWidth = pageCount > 80 ? 820 : pageCount > 32 ? 980 : 1220;
  const maxScale = pageCount > 80 ? 1.12 : pageCount > 32 ? 1.28 : 1.55;
  return Math.min(maxScale, Math.max(1, targetWidth / Math.max(1, pageWidth)));
}

export async function printPdfDocument(pdf: PDFDocumentProxy, title: string) {
  const root = document.createElement("div");
  root.className = "pdf-print-root";
  root.setAttribute("aria-hidden", "true");

  const previousTitle = document.title;
  document.title = title || previousTitle;
  document.body.classList.add("printing-pdf-document");
  document.body.append(root);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    document.title = previousTitle;
    document.body.classList.remove("printing-pdf-document");
    root.remove();
  };

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = pdfPrintScale(baseViewport.width, pdf.numPages);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Could not prepare PDF canvas for printing.");
      }

      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.aspectRatio = `${canvas.width} / ${canvas.height}`;

      const pageElement = document.createElement("section");
      pageElement.className = "pdf-print-page";
      if (baseViewport.width > baseViewport.height) {
        pageElement.classList.add("landscape");
      }
      pageElement.append(canvas);
      root.append(pageElement);

      await page.render({ canvas, canvasContext: context, viewport }).promise;
    }

    await nextAnimationFrame();
    window.addEventListener("afterprint", cleanup, { once: true });
    window.print();
    window.setTimeout(cleanup, 10 * 60 * 1000);
  } catch (error) {
    cleanup();
    throw error;
  }
}

export function printCurrentWebView(title?: string) {
  const previousTitle = document.title;
  if (title) {
    document.title = title;
  }

  try {
    window.print();
  } finally {
    window.setTimeout(() => {
      document.title = previousTitle;
    }, 1000);
  }
}
