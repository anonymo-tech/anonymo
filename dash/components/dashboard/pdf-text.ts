'use client';

import {
  appendPdfPage,
  emptyPdfText,
  pdfTextDecision,
  PDF_PAGE_LIMIT,
  type PdfText,
} from '../../lib/client/pdf-references.ts';
// oxlint-disable-next-line import/default -- Vite's worker URL loader supplies this default export.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?worker&url';

export type PdfReadResult =
  | { status: 'ok'; result: PdfText }
  | { status: 'no-text' | 'little-text' | 'limit' | 'password' | 'invalid' };

/** Imported only after the gated chat picker receives a PDF. No rendering or OCR. */
export async function readPdfText(
  file: File,
  maxBytes: number,
): Promise<PdfReadResult> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const options = {
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    enableXfa: false,
    stopAtErrors: true,
    verbosity: 0,
  };
  const task = pdfjs.getDocument(options);
  try {
    const document = await task.promise;
    let result = emptyPdfText(document.numPages, maxBytes);
    for (
      let pageNumber = 1;
      pageNumber <= Math.min(document.numPages, PDF_PAGE_LIMIT);
      pageNumber++
    ) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const text = content.items
          .map((item) =>
            'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '',
          )
          .join('');
        result = appendPdfPage(result, text);
      } finally {
        page.cleanup();
      }
      if (result.byteLimited || result.bytes >= result.maxBytes) break;
    }
    const status = pdfTextDecision(result);
    return status === 'ok' ? { status, result } : { status };
  } catch (error) {
    return {
      status:
        error instanceof Error && error.name === 'PasswordException'
          ? 'password'
          : 'invalid',
    };
  } finally {
    await task.destroy();
  }
}
