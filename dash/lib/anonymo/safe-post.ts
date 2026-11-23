// Feature 06 "Make this safe to post": which recognised text on a screenshot should be hidden before it is posted.
// Pure: it reads text lines the browser recognised on this device and suggests boxes; it never sends anything.

import type { Rect } from './region.ts';

export type SuggestionKind = 'qr' | 'address' | 'handle' | 'email';
export type Suggestion = { kind: SuggestionKind; rect: Rect };

export const SUGGESTION_LABEL: Record<SuggestionKind, string> = {
  qr: 'QR code',
  address: 'Wallet address',
  handle: 'Account handle',
  email: 'Email address',
};

const PATTERNS: [SuggestionKind, RegExp][] = [
  // EVM (0x + 40 hex), Bitcoin bech32, Solana / base58 (32 to 44 characters, mixed case and digits), Tron (T…).
  ['address', /\b0x[a-fA-F0-9]{40}\b|\b0x[a-fA-F0-9]{4,}(?:…|\.{2,3})[a-fA-F0-9]{3,}\b|\bbc1[a-z0-9]{25,59}\b|\bT[1-9A-HJ-NP-Za-km-z]{33}\b|\b(?=[1-9A-HJ-NP-Za-km-z]*\d)(?=[1-9A-HJ-NP-Za-km-z]*[a-z])(?=[1-9A-HJ-NP-Za-km-z]*[A-Z])[1-9A-HJ-NP-Za-km-z]{32,44}\b/],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
  ['handle', /(?:^|[\s(])@[A-Za-z0-9_.]{2,30}\b/],
];

/** The kind of detail a recognised line holds, if any. A whole line is hidden: a partial box could leave characters. */
export function classifyLine(text: string): SuggestionKind | null {
  for (const [kind, re] of PATTERNS) if (re.test(text)) return kind;
  return null;
}

/** Suggested boxes from QR detections and recognised text lines, padded so edges are covered. */
export function suggestBoxes(qr: readonly Rect[] | null, lines: readonly { text: string; rect: Rect }[] | null, pad = 0.006): Suggestion[] {
  const grow = (r: Rect): Rect => {
    const x = Math.max(0, r.x - pad), y = Math.max(0, r.y - pad);
    return { x, y, w: Math.min(1 - x, r.w + pad * 2), h: Math.min(1 - y, r.h + pad * 2) };
  };
  const out: Suggestion[] = [];
  for (const r of qr ?? []) out.push({ kind: 'qr', rect: grow(r) });
  for (const line of lines ?? []) {
    const kind = classifyLine(line.text);
    if (kind) out.push({ kind, rect: grow(line.rect) });
  }
  return out;
}

/** PNG chunk types in a file, in order. Used to prove an export carries no text, EXIF or time chunks. */
export function pngChunks(bytes: Uint8Array): string[] {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 8 || signature.some((b, i) => bytes[i] !== b)) throw new Error('Not a PNG file.');
  const out: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = view.getUint32(at);
    out.push(String.fromCharCode(...bytes.subarray(at + 4, at + 8)));
    at += 12 + length;
  }
  return out;
}

/** Chunks a flattened export may contain. Anything else (tEXt, iTXt, zTXt, eXIf, tIME, iCCP…) fails the export check. */
export const ALLOWED_CHUNKS = new Set(['IHDR', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'pHYs', 'cHRM']);
