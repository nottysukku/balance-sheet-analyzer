import type { DocPage, SourceDocument, Token } from './types.js';
import { AppError } from '../http/errors.js';

/**
 * PDF ingestion via pdf.js.
 *
 * We deliberately use the *text content* API rather than a higher-level
 * "pdf to string" helper: the per-item transform matrix gives us x/y for every
 * run, and column geometry is the only reliable way to tell the FY2024 column
 * from the FY2023 column in a two-column balance sheet. A flattened string
 * loses that and interleaves the columns.
 */

// pdf.js ships an ESM legacy build that runs in Node without a DOM. The
// package's type surface does not expose this subpath, so it is imported
// dynamically and narrowed locally.
interface PdfTextItem {
  str?: string;
  width?: number;
  height?: number;
  transform?: number[];
}

interface PdfPageProxy {
  getViewport(opts: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
  cleanup(): void;
}

interface PdfDocumentProxy {
  numPages: number;
  getPage(n: number): Promise<PdfPageProxy>;
  getMetadata(): Promise<{ info?: Record<string, unknown> }>;
  destroy(): Promise<void>;
}

type GetDocumentFn = (src: Record<string, unknown>) => { promise: Promise<PdfDocumentProxy> };

let getDocumentFn: GetDocumentFn | null = null;

async function loadPdfJs(): Promise<GetDocumentFn> {
  if (getDocumentFn) return getDocumentFn;
  const mod = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
    getDocument: GetDocumentFn;
  };
  getDocumentFn = mod.getDocument;
  return getDocumentFn;
}

export async function ingestPdf(buffer: Buffer): Promise<SourceDocument> {
  const getDocument = await loadPdfJs();

  let doc: PdfDocumentProxy;
  try {
    doc = await getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
      // Nothing here needs rendering, and disabling these keeps memory flat.
      disableFontFace: true,
      isEvalSupported: false,
    }).promise;
  } catch (err) {
    throw new AppError(
      'UNREADABLE_PDF',
      'The PDF could not be opened. It may be corrupt or password-protected.',
      422,
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }

  const pages: DocPage[] = [];
  let textLength = 0;

  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const tokens: Token[] = [];

      for (const item of content.items) {
        const text = (item.str ?? '').trim();
        if (!text) continue;
        const t = item.transform;
        if (!t || t.length < 6) continue;
        const x = t[4]!;
        const y = t[5]!;
        // pdf.js reports height 0 for some runs; fall back to the transform
        // scale so row clustering still has a sensible line height.
        const height = item.height && item.height > 0 ? item.height : Math.abs(t[3] ?? 8) || 8;
        tokens.push({ text, x, y, width: item.width ?? 0, height });
        textLength += text.length;
      }

      pages.push({ index: i, width: viewport.width, height: viewport.height, tokens });
      page.cleanup();
    }
  } finally {
    await doc.destroy().catch(() => undefined);
  }

  return { format: 'pdf', pages, textLength };
}
