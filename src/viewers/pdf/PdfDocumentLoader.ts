import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

import type { PdfLoadingTask } from "./PdfTypes";

const cMapAssets = import.meta.glob("../../../node_modules/pdfjs-dist/cmaps/*.bcmap", {
  eager: true,
  import: "default",
  query: "?url",
}) as Record<string, string>;

const standardFontAssets = {
  ...(import.meta.glob("../../../node_modules/pdfjs-dist/standard_fonts/*.pfb", {
    eager: true,
    import: "default",
    query: "?url",
  }) as Record<string, string>),
  ...(import.meta.glob("../../../node_modules/pdfjs-dist/standard_fonts/*.ttf", {
    eager: true,
    import: "default",
    query: "?url",
  }) as Record<string, string>),
};

const wasmAssets = {
  ...(import.meta.glob("../../../node_modules/pdfjs-dist/wasm/jbig2.wasm", {
    eager: true,
    import: "default",
    query: "?url",
  }) as Record<string, string>),
  ...(import.meta.glob("../../../node_modules/pdfjs-dist/wasm/openjpeg.wasm", {
    eager: true,
    import: "default",
    query: "?url",
  }) as Record<string, string>),
};

function assetMapFromGlob(assets: Record<string, string>) {
  return new Map(
    Object.entries(assets).map(([path, url]) => {
      const parts = path.split(/[\\/]/);
      return [parts[parts.length - 1] ?? path, url];
    }),
  );
}

const bundledPdfAssets = {
  cMapUrl: assetMapFromGlob(cMapAssets),
  standardFontDataUrl: assetMapFromGlob(standardFontAssets),
  wasmUrl: assetMapFromGlob(wasmAssets),
};

type PdfBinaryKind = keyof typeof bundledPdfAssets;

class BundledPdfBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const assetGroup = bundledPdfAssets[kind as PdfBinaryKind];
    const assetUrl = assetGroup?.get(filename);

    if (!assetUrl) {
      throw new Error(`PDF support asset is missing: ${filename}`);
    }

    const response = await fetch(assetUrl);
    if (!response.ok) {
      throw new Error(`Could not load PDF support asset (${response.status}): ${filename}`);
    }

    return new Uint8Array(await response.arrayBuffer());
  }
}

export async function createPdfLoadingTask(sourceUrl: string): Promise<PdfLoadingTask> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Could not read PDF (${response.status})`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  return pdfjs.getDocument({
    data: bytes,
    cMapPacked: true,
    disableFontFace: false,
    maxImageSize: -1,
    stopAtErrors: false,
    useSystemFonts: true,
    useWasm: true,
    useWorkerFetch: false,
    BinaryDataFactory: BundledPdfBinaryDataFactory,
  }) as PdfLoadingTask;
}
