// Features 02/03/07: where each piece of a PDF page's text sits. pdf.js gives text items in content order with a
// transform; this keeps, per item, its character range in the page text (built exactly as Paper Trail always has)
// and its box on the page, normalised 0–1 against the rotated page (top-left origin). Pure: no pdf.js import, so it
// runs in Node tests with pdf.js's legacy build.

export type PdfItem = { text: string; start: number; end: number; x: number; y: number; w: number; h: number };
export type PageLayout = { width: number; height: number; items: PdfItem[] };

/** The parts of a pdf.js text item this file reads. Marked-content items have no `str`. */
export type RawTextItem = { str?: string; hasEOL?: boolean; transform?: number[]; width?: number; height?: number };
export type RawViewport = { width: number; height: number; scale: number; transform: number[] };

/** pdf.js Util.transform: the product of two affine matrices [a, b, c, d, e, f]. */
export function multiply(m1: readonly number[], m2: readonly number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/**
 * The page text (same string Paper Trail has always sent: item text, a space or a line break after each, trimmed)
 * and the layout of every non-empty item.
 */
export function pageLayout(items: readonly RawTextItem[], viewport: RawViewport): { text: string; layout: PageLayout } {
  let raw = '';
  const placed: { item: RawTextItem; start: number }[] = [];
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    if (item.str.trim()) placed.push({ item, start: raw.length });
    raw += item.str + (item.hasEOL ? '\n' : ' ');
  }
  const lead = raw.length - raw.trimStart().length;
  const text = raw.trim();
  const out: PdfItem[] = [];
  for (const { item, start: rawStart } of placed) {
    const str = item.str!;
    const start = Math.max(0, rawStart - lead);
    const end = Math.min(text.length, start + str.length);
    const box = boxOf(item, viewport);
    if (!box || end <= start) continue;
    out.push({ text: str, start, end, ...box });
  }
  return { text, layout: { width: viewport.width, height: viewport.height, items: out } };
}

function boxOf(item: RawTextItem, viewport: RawViewport): { x: number; y: number; w: number; h: number } | null {
  if (!item.transform || item.transform.length < 6) return null;
  const tx = multiply(viewport.transform, item.transform);
  const height = Math.hypot(tx[2], tx[3]) || (item.height ?? 0) * viewport.scale;
  const length = (item.width ?? 0) * viewport.scale;
  const angle = Math.atan2(tx[1], tx[0]);
  const along = [Math.cos(angle), Math.sin(angle)];
  // In viewport space y grows downward, so "up" from the baseline is the along-vector turned a quarter the other way.
  const up = [along[1], -along[0]];
  const ox = tx[4], oy = tx[5];
  const xs = [ox, ox + along[0] * length, ox + up[0] * height, ox + along[0] * length + up[0] * height];
  const ys = [oy, oy + along[1] * length, oy + up[1] * height, oy + along[1] * length + up[1] * height];
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  if (!Number.isFinite(minX + maxX + minY + maxY) || viewport.width <= 0 || viewport.height <= 0) return null;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const x = clamp(minX / viewport.width), y = clamp(minY / viewport.height);
  return { x, y, w: clamp(maxX / viewport.width) - x, h: clamp(maxY / viewport.height) - y };
}
