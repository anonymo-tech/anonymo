import type { PaperSource } from './paper-trail';
import { pageLayout, type RawTextItem } from './pdf-layout';
export async function readPdf(
  file: File,
  signal: AbortSignal,
): Promise<PaperSource> {
  if (file.size > 10 * 1024 * 1024)
    throw new Error('Choose a PDF smaller than 10 MB.');
  const [{ getDocument, GlobalWorkerOptions }, { default: worker }] =
    await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]);
  if (signal.aborted) throw new Error('PDF reading cancelled.');
  GlobalWorkerOptions.workerSrc = worker;
  // pdf.js takes ownership of the buffer it is given, so the copy kept for drawing pages is a separate one.
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const task = getDocument({
    data: fileBytes.slice(),
    useSystemFonts: true,
    stopAtErrors: true,
  });
  const cancel = () => {
    void task.destroy();
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const document = await task.promise;
    if (document.numPages > 200)
      throw new Error('Choose a PDF with 200 pages or fewer.');
    const pages: PaperSource['pages'] = [];
    let bytes = 0;
    for (let number = 1; number <= document.numPages; number++) {
      if (signal.aborted) throw new Error('PDF reading cancelled.');
      const page = await document.getPage(number),
        content = await page.getTextContent();
      // The same text as before (item text plus a space or line break, trimmed), now with each item's place kept.
      const { text, layout } = pageLayout(content.items as RawTextItem[], page.getViewport({ scale: 1 }));
      bytes += new TextEncoder().encode(text).byteLength;
      if (bytes > 8 * 1024 * 1024)
        throw new Error(
          'This PDF contains too much text for one attachment. Split it into smaller documents.',
        );
      pages.push({ number, text, layout });
      page.cleanup();
    }
    if (!pages.some((page) => page.text))
      throw new Error(
        'This PDF has no selectable text. Add a text-based PDF; scanned pages need OCR first.',
      );
    if (pages.some((page) => !page.text))
      throw new Error(
        'Some pages have no selectable text. Use a text-based copy so every page can be included.',
      );
    return { name: file.name.slice(0, 240), pages, bytes: fileBytes };
  } finally {
    signal.removeEventListener('abort', cancel);
    await task.destroy();
  }
}
