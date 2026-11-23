// Features 02, 03 and 06: a selection on an attachment, as a rectangle normalised 0–1 against the oriented source
// (the rotated PDF page, or the image as its EXIF orientation shows it), never against display pixels. Plus the text
// inside a selection on a PDF page, the line under a tap, and the lines next to a selection. Pure functions.

import type { PageLayout, PdfItem } from '../pdf-layout.ts';

export type Rect = { x: number; y: number; w: number; h: number };
export type Point = { x: number; y: number };
export type Handle = 'nw' | 'ne' | 'sw' | 'se';

export const MIN_SIZE = 0.02;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Keeps a rectangle inside the source and at least MIN_SIZE on each side. */
export function clampRect(r: Rect): Rect {
  const w = Math.min(1, Math.max(MIN_SIZE, r.w)), h = Math.min(1, Math.max(MIN_SIZE, r.h));
  return { x: Math.min(1 - w, clamp01(r.x)), y: Math.min(1 - h, clamp01(r.y)), w, h };
}

export function rectFromPoints(a: Point, b: Point): Rect {
  return clampRect({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
}

export const moveRect = (r: Rect, dx: number, dy: number): Rect => clampRect({ ...r, x: r.x + dx, y: r.y + dy });

/** Drags one corner; the opposite corner stays put. */
export function resizeRect(r: Rect, handle: Handle, dx: number, dy: number): Rect {
  let x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
  if (handle.includes('w')) x0 = Math.min(x1 - MIN_SIZE, x0 + dx);
  else x1 = Math.max(x0 + MIN_SIZE, x1 + dx);
  if (handle.includes('n')) y0 = Math.min(y1 - MIN_SIZE, y0 + dy);
  else y1 = Math.max(y0 + MIN_SIZE, y1 + dy);
  x0 = clamp01(x0); y0 = clamp01(y0); x1 = clamp01(x1); y1 = clamp01(y1);
  return { x: x0, y: y0, w: Math.max(MIN_SIZE, x1 - x0), h: Math.max(MIN_SIZE, y1 - y0) };
}

/** Grows (positive) or shrinks the right and bottom edges, for Shift+arrow keys. */
export const growRect = (r: Rect, dw: number, dh: number): Rect => clampRect({ ...r, w: r.w + dw, h: r.h + dh });

/** Integer pixel box of a normalised rectangle on a source of `width` × `height`. Always at least 1 × 1. */
export function toPixels(r: Rect, width: number, height: number): { sx: number; sy: number; sw: number; sh: number } {
  const sx = Math.min(width - 1, Math.max(0, Math.floor(r.x * width)));
  const sy = Math.min(height - 1, Math.max(0, Math.floor(r.y * height)));
  const ex = Math.min(width, Math.max(sx + 1, Math.ceil((r.x + r.w) * width)));
  const ey = Math.min(height, Math.max(sy + 1, Math.ceil((r.y + r.h) * height)));
  return { sx, sy, sw: ex - sx, sh: ey - sy };
}

/** A display-space point (pixels in an element of `box` size, possibly scrolled or zoomed) to source space. */
export function toSource(clientX: number, clientY: number, box: { left: number; top: number; width: number; height: number }): Point {
  return { x: clamp01((clientX - box.left) / box.width), y: clamp01((clientY - box.top) / box.height) };
}

const area = (r: Rect) => Math.max(0, r.w) * Math.max(0, r.h);
function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Items at least half inside the selection. */
export function itemsIn(layout: PageLayout, rect: Rect): PdfItem[] {
  return layout.items.filter((item) => area(item) > 0 && overlap(item, rect) / area(item) >= 0.5);
}

/**
 * The page text of `items`, in the page's own reading order (so a two-column page reads column by column, not across).
 * Neighbouring items keep the separator between them; items that are not neighbours on the page start a new line.
 */
export function textOfItems(text: string, items: readonly PdfItem[]): string {
  const sorted = [...items].sort((a, b) => a.start - b.start);
  let out = '';
  sorted.forEach((item, i) => {
    if (i) {
      const prev = sorted[i - 1];
      const between = text.slice(prev.end, item.start);
      out += /^\s*$/.test(between) ? (between.includes('\n') ? '\n' : ' ') : '\n';
    }
    out += text.slice(item.start, item.end);
  });
  return out.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

export const textInRegion = (text: string, layout: PageLayout, rect: Rect) => textOfItems(text, itemsIn(layout, rect));

const centreY = (r: Rect) => r.y + r.h / 2;
const unionRect = (rs: readonly Rect[]): Rect => {
  const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.w)), y1 = Math.max(...rs.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/**
 * The text line that `item` sits on: items on the same baseline, chained left and right while the gap between them is
 * small. A wide gutter stops the chain, so a tap in one column never selects the other column's line.
 */
export function lineOf(layout: PageLayout, item: PdfItem): PdfItem[] {
  const same = layout.items.filter((other) => Math.abs(centreY(other) - centreY(item)) < Math.max(item.h, other.h) * 0.5);
  same.sort((a, b) => a.x - b.x);
  const gap = item.h * 2.5;
  let lo = same.indexOf(item), hi = lo;
  while (lo > 0 && same[lo].x - (same[lo - 1].x + same[lo - 1].w) < gap) lo--;
  while (hi < same.length - 1 && same[hi + 1].x - (same[hi].x + same[hi].w) < gap) hi++;
  return same.slice(lo, hi + 1);
}

/** A selection padded around a line of items. */
export function lineRect(line: readonly PdfItem[]): Rect {
  const u = unionRect(line);
  const pad = Math.max(...line.map((i) => i.h)) * 0.35;
  return clampRect({ x: u.x - pad, y: u.y - pad, w: u.w + pad * 2, h: u.h + pad * 2 });
}

/** The line under a tap, or the nearest line within a small distance; null on blank space. */
export function lineAt(layout: PageLayout, p: Point, reach = 0.03): Rect | null {
  let best: PdfItem | null = null, bestDistance = Infinity;
  for (const item of layout.items) {
    const dx = Math.max(item.x - p.x, 0, p.x - (item.x + item.w));
    const dy = Math.max(item.y - p.y, 0, p.y - (item.y + item.h));
    const d = Math.hypot(dx, dy);
    if (d < bestDistance) { best = item; bestDistance = d; }
  }
  return best && bestDistance <= reach ? lineRect(lineOf(layout, best)) : null;
}

/** The next text line above (-1) or below (+1) a selection, within its column; null at the edge. */
export function adjacentLine(layout: PageLayout, rect: Rect, direction: -1 | 1): Rect | null {
  const centre = centreY(rect);
  const candidates = layout.items.filter((item) => {
    const horizontal = Math.min(item.x + item.w, rect.x + rect.w) - Math.max(item.x, rect.x) > 0;
    const c = centreY(item);
    return horizontal && (direction < 0 ? c < rect.y : c > rect.y + rect.h) && Math.abs(c - centre) > 0;
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => (direction < 0 ? centreY(b) - centreY(a) : centreY(a) - centreY(b)));
  return lineRect(lineOf(layout, candidates[0]));
}

/**
 * "Include nearby lines": the one line above and below the selection, in its column. Returned separately so the
 * preview can show exactly which words would be added.
 */
export function nearbyText(text: string, layout: PageLayout, rect: Rect): { before: string; after: string } {
  const pick = (dir: -1 | 1) => {
    const line = adjacentLine(layout, rect, dir);
    if (!line) return '';
    const inside = new Set(itemsIn(layout, rect));
    return textOfItems(text, itemsIn(layout, line).filter((i) => !inside.has(i)));
  };
  return { before: pick(-1), after: pick(1) };
}
