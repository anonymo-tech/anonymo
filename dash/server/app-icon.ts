// The phone app's PNG icons, drawn on the server from the same shapes as public/favicon.svg. The release publisher
// refuses committed binaries (they can carry metadata), so the icons are generated instead: plain RGBA pixels with
// signed-distance antialiasing, written as a minimal PNG with no ancillary chunks.

import { deflateSync } from 'node:zlib';

type Pt = [number, number];
type Kind = 'any' | 'maskable' | 'apple';

const BG = [0x2e, 0x15, 0x31];
const MASK = [0x3b, 0x12, 0x40];
const PINK = [0xff, 0x5f, 0xae];
const GOLD = [0xf6, 0xb8, 0x4b];

const cubic = (a: Pt, b: Pt, c: Pt, d: Pt, n = 24): Pt[] => Array.from({ length: n }, (_, i) => {
  const t = (i + 1) / n, u = 1 - t;
  return [u ** 3 * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t ** 3 * d[0], u ** 3 * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t ** 3 * d[1]];
});
const quad = (a: Pt, b: Pt, c: Pt, n = 20): Pt[] => [a, ...Array.from({ length: n }, (_, i): Pt => {
  const t = (i + 1) / n, u = 1 - t;
  return [u * u * a[0] + 2 * u * t * b[0] + t * t * c[0], u * u * a[1] + 2 * u * t * b[1] + t * t * c[1]];
})];

// favicon.svg, in its 48-unit mask space: the mask outline and the two closed eyes.
const MASK_PATH: Pt[] = [[4, 12],
  ...cubic([4, 12], [4, 5.5], [11, 3.5], [24, 6.5]),
  ...cubic([24, 6.5], [37, 3.5], [44, 5.5], [44, 12]),
  ...cubic([44, 12], [44, 18.5], [37, 20.5], [24, 17.5]),
  ...cubic([24, 17.5], [11, 20.5], [4, 18.5], [4, 12])];
const EYES: Pt[][] = [quad([10.5, 11.5], [15, 15.1], [19.5, 11.5]), quad([28.5, 11.5], [33, 15.1], [37.5, 11.5])];

function segDist(p: Pt, a: Pt, b: Pt) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function lineDist(p: Pt, line: Pt[], closed: boolean) {
  let d = Infinity;
  for (let i = 0; i < line.length - (closed ? 0 : 1); i++) d = Math.min(d, segDist(p, line[i], line[(i + 1) % line.length]));
  return d;
}
function inside(p: Pt, poly: Pt[]) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
const cover = (signed: number, px: number) => Math.max(0, Math.min(1, 0.5 - signed / px));

function draw(size: number, kind: Kind): Uint8Array {
  // The favicon's mask sits at translate(2 10) scale(0.583) in a 32-unit square. A maskable icon keeps it inside
  // the central safe zone; every icon but "any" is a full square, since the phone rounds the corners itself.
  const zoom = kind === 'maskable' ? 0.72 : 0.9;
  const unit = (size / 32) * zoom;
  const off = (size - 32 * unit) / 2;
  const toMask = (x: number, y: number): Pt => [((x - off) / unit - 2) / 0.583, ((y - off) / unit - 10) / 0.583];
  const px = 1 / (unit * 0.583); // one pixel in mask units
  const radius = kind === 'any' ? size * 0.22 : 0;
  const out = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    out[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      // Rounded square background (signed distance to a rounded box).
      const qx = Math.abs(cx - size / 2) - (size / 2 - radius), qy = Math.abs(cy - size / 2) - (size / 2 - radius);
      const box = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
      const a = cover(box, 1);
      let rgb = BG.slice();
      const p = toMask(cx, cy);
      if (p[0] > -2 && p[0] < 50 && p[1] > 0 && p[1] < 24) {
        const edge = lineDist(p, MASK_PATH, true);
        const fill = cover(inside(p, MASK_PATH) ? -edge : edge, px);
        const ring = cover(edge - 1.2, px);
        const eye = cover(Math.min(...EYES.map((e) => lineDist(p, e, false))) - 1, px);
        const mix = (c: number[], k: number) => { rgb = rgb.map((v, i) => v + (c[i] - v) * k); };
        mix(MASK, fill);
        mix(PINK, ring);
        mix(GOLD, eye);
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      out[o] = Math.round(rgb[0]); out[o + 1] = Math.round(rgb[1]); out[o + 2] = Math.round(rgb[2]); out[o + 3] = Math.round(a * 255);
    }
  }
  return out;
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes: Uint8Array) { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const cache = new Map<string, Uint8Array>();
export function appIconPng(size: number, kind: Kind): Uint8Array {
  const id = `${size}:${kind}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(draw(size, kind))), chunk('IEND', new Uint8Array())];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { png.set(p, at); at += p.length; }
  cache.set(id, png);
  return png;
}

export const APP_ICONS: Record<string, { size: number; kind: Kind }> = {
  'icon-192.png': { size: 192, kind: 'any' },
  'icon-512.png': { size: 512, kind: 'any' },
  'icon-maskable-512.png': { size: 512, kind: 'maskable' },
  'apple-touch-icon.png': { size: 180, kind: 'apple' },
};
