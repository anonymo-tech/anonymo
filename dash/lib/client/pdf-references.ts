/** Text-only PDF decisions. No PDF parser or browser dependencies belong here. */
export const PDF_PAGE_LIMIT = 200;
// A few characters alone are insufficient to treat a scan as a readable reference.
const MIN_READABLE_CHARACTERS = 20;

export type PdfText = {
  text: string;
  totalPages: number;
  pagesRead: number;
  partialPage: boolean;
  byteLimited: boolean;
  bytes: number;
  maxBytes: number;
  readableCharacters: number;
};

export function utf8Prefix(text: string, maxBytes: number): string {
  const budget = Math.max(0, Math.floor(maxBytes));
  // UTF-8 needs at least one byte per UTF-16 code unit. Bound the temporary buffer.
  const encoded = new TextEncoder().encode(text.slice(0, budget));
  if (text.length <= budget && encoded.length <= budget) return text;
  // stream:true discards an incomplete final code point rather than replacing it.
  return new TextDecoder().decode(encoded.subarray(0, budget), {
    stream: true,
  });
}

export function emptyPdfText(totalPages: number, maxBytes: number): PdfText {
  return {
    text: '',
    totalPages,
    pagesRead: 0,
    partialPage: false,
    byteLimited: false,
    bytes: 0,
    maxBytes: Math.max(0, Math.floor(maxBytes)),
    readableCharacters: 0,
  };
}

export function appendPdfPage(current: PdfText, pageText: string): PdfText {
  if (
    current.byteLimited ||
    current.pagesRead >= Math.min(PDF_PAGE_LIMIT, current.totalPages)
  )
    return current;
  const header = `${current.pagesRead ? '\n\n' : ''}--- Page ${current.pagesRead + 1} ---\n`;
  const encoder = new TextEncoder();
  const headerBytes = encoder.encode(header).length;
  const available = current.maxBytes - current.bytes - headerBytes;
  if (available <= 0) return { ...current, byteLimited: true };
  const kept = utf8Prefix(pageText, available);
  if (pageText.length && !kept.length) return { ...current, byteLimited: true };
  const text = current.text + header + kept;
  let readableCharacters = current.readableCharacters;
  if (readableCharacters < MIN_READABLE_CHARACTERS) {
    for (const character of kept) {
      if (/[\p{L}\p{N}]/u.test(character)) readableCharacters++;
      if (readableCharacters >= MIN_READABLE_CHARACTERS) break;
    }
  }
  return {
    ...current,
    text,
    bytes: current.bytes + headerBytes + encoder.encode(kept).length,
    pagesRead: current.pagesRead + 1,
    partialPage: kept.length < pageText.length,
    byteLimited: kept.length < pageText.length,
    readableCharacters,
  };
}

export function pdfTextDecision(
  result: PdfText,
): 'ok' | 'no-text' | 'little-text' | 'limit' {
  if (result.readableCharacters >= MIN_READABLE_CHARACTERS) return 'ok';
  if (
    result.byteLimited ||
    (result.bytes >= result.maxBytes && result.pagesRead < result.totalPages)
  )
    return 'limit';
  return result.readableCharacters ? 'little-text' : 'no-text';
}

/** These delimiters are request content, kept identical in every UI language. */
export function textReferenceBlock(name: string, text: string): string {
  return `\n\n--- Reference: ${name} ---\n${text}`;
}
