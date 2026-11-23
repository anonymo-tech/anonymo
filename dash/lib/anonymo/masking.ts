// Feature 01 "Mask my details": turn a draft into the exact text that will be sent, with personal details replaced by
// stable numbered placeholders ([name 1], [account 1]). The same value always gets the same placeholder within a chat,
// and two different names get [name 1] and [name 2]. The map back to the original values lives in memory only (a
// MaskVault): it restores known values for display on this device and is never sent, stored or logged.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { resolveOverlaps, type PersonalFinding, type PersonalKind } from '../guards/personal.ts';

export type MaskKind = PersonalKind | 'detail';

export type Mask = {
  start: number;
  end: number;
  kind: MaskKind;
  /** Whether the mask applies. A suggestion that is off is shown underlined, ready to tap. */
  on: boolean;
  manual?: boolean;
};

export const MASK_KINDS: readonly MaskKind[] = ['name', 'email', 'phone', 'card', 'account', 'address', 'reference', 'detail'];
const PLACEHOLDER = new RegExp(String.raw`\[(${MASK_KINDS.join('|')}) (\d{1,4})\]`, 'g');

const keyOf = (kind: MaskKind, value: string) => `${kind}\u0000${kind === 'email' ? value.toLowerCase() : value.replace(/\s+/g, ' ')}`;

/** In-memory placeholder map for one chat. Clone it for a draft; commit the clone only when that draft is sent. */
export class MaskVault {
  #byKey = new Map<string, string>();
  #byPlaceholder = new Map<string, string>();
  #counts = new Map<MaskKind, number>();

  placeholder(kind: MaskKind, value: string): string {
    const key = keyOf(kind, value);
    const known = this.#byKey.get(key);
    if (known) return known;
    const n = (this.#counts.get(kind) ?? 0) + 1;
    this.#counts.set(kind, n);
    const placeholder = `[${kind} ${n}]`;
    this.#byKey.set(key, placeholder);
    this.#byPlaceholder.set(placeholder, value);
    return placeholder;
  }

  /** The original value behind a placeholder, if this device still knows it. */
  original(placeholder: string): string | undefined {
    return this.#byPlaceholder.get(placeholder);
  }

  /** Puts known values back for local display. Unknown placeholders stay as they are. */
  restore(text: string): string {
    return text.replace(PLACEHOLDER, (whole) => this.#byPlaceholder.get(whole) ?? whole);
  }

  /**
   * Masks for every value this chat has already masked, wherever it appears again, even where no detector would find
   * it ("thanks Sample Person" has no greeting). On by default, so a known detail is never sent in a later turn.
   */
  knownMasks(text: string): Mask[] {
    const out: Mask[] = [];
    const lower = text.toLowerCase();
    for (const [placeholder, value] of this.#byPlaceholder) {
      if (!value.trim()) continue;
      const kind = placeholder.slice(1, placeholder.lastIndexOf(' ')) as MaskKind;
      const haystack = kind === 'email' ? lower : text;
      const needle = kind === 'email' ? value.toLowerCase() : value;
      for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length))
        out.push({ start: at, end: at + needle.length, kind, on: true });
    }
    return out;
  }

  /**
   * Marks placeholders already present in a chat as taken, so a vault that was cleared (a chat reopened later) never
   * hands out [name 1] again for a different value. Their originals stay unknown.
   */
  reserve(text: string) {
    for (const m of text.matchAll(PLACEHOLDER)) {
      const kind = m[1] as MaskKind, n = Number(m[2]);
      if (n > (this.#counts.get(kind) ?? 0)) this.#counts.set(kind, n);
    }
  }

  clone(): MaskVault {
    const copy = new MaskVault();
    for (const [k, v] of this.#byKey) copy.#byKey.set(k, v);
    for (const [k, v] of this.#byPlaceholder) copy.#byPlaceholder.set(k, v);
    for (const [k, v] of this.#counts) copy.#counts.set(k, v);
    return copy;
  }

  /** Takes over every mapping of `other` (a sent draft's clone of this vault). */
  adopt(other: MaskVault) {
    if (other === this) return;
    this.clear();
    for (const [k, v] of other.#byKey) this.#byKey.set(k, v);
    for (const [k, v] of other.#byPlaceholder) this.#byPlaceholder.set(k, v);
    for (const [k, v] of other.#counts) this.#counts.set(k, v);
  }

  clear() {
    this.#byKey.clear();
    this.#byPlaceholder.clear();
    this.#counts.clear();
  }

  get size() {
    return this.#byPlaceholder.size;
  }
}

/**
 * Suggested masks from the scanner: every finding, with references left off for the person to tap. `known` (from
 * MaskVault.knownMasks) come first, so a value masked earlier in the chat keeps its kind and placeholder.
 */
export function masksFromFindings(findings: readonly PersonalFinding[], known: readonly Mask[] = []): Mask[] {
  return resolveOverlaps([...known, ...findings.map((f) => ({ start: f.start, end: f.end, kind: f.kind, on: f.suggested }))]);
}

export type MaskSegment = { text: string; mask: number | null; placeholder: string | null };

/**
 * The draft split into plain text and masked parts. `placeholder` is set for masks that are on. Placeholders are
 * numbered in reading order from `vault`, which this call extends: pass a clone unless the draft is being sent.
 */
export function maskSegments(text: string, masks: readonly Mask[], vault: MaskVault): MaskSegment[] {
  const out: MaskSegment[] = [];
  let cursor = 0;
  masks.forEach((mask, index) => {
    if (mask.start < cursor || mask.end > text.length || mask.end <= mask.start) return;
    if (mask.start > cursor) out.push({ text: text.slice(cursor, mask.start), mask: null, placeholder: null });
    const value = text.slice(mask.start, mask.end);
    out.push({ text: value, mask: index, placeholder: mask.on ? vault.placeholder(mask.kind, value) : null });
    cursor = mask.end;
  });
  if (cursor < text.length) out.push({ text: text.slice(cursor), mask: null, placeholder: null });
  return out;
}

/** The exact outgoing text for a set of segments. */
export const segmentsText = (segments: readonly MaskSegment[]) => segments.map((s) => s.placeholder ?? s.text).join('');

/**
 * The sent text of the original range [start, end): plain text sliced, masked parts as their placeholder. A masked
 * part that starts inside the range is kept whole. Used to split a reviewed excerpt message back into the question.
 */
export function sanitizedSlice(segments: readonly MaskSegment[], start: number, end: number): string {
  let out = '';
  let at = 0;
  for (const s of segments) {
    const from = at, to = at + s.text.length;
    at = to;
    if (to <= start || from >= end) continue;
    if (s.placeholder) {
      if (from >= start) out += s.placeholder;
      continue;
    }
    out += s.text.slice(Math.max(0, start - from), Math.min(s.text.length, end - from));
  }
  return out;
}

/** Masked text in one call (extends `vault`). */
export function maskText(text: string, masks: readonly Mask[], vault: MaskVault): string {
  return segmentsText(maskSegments(text, masks, vault));
}

/** The whitespace-delimited word around `index`, without surrounding punctuation. */
export function wordAt(text: string, index: number): { start: number; end: number } | null {
  if (index < 0 || index >= text.length || /\s/.test(text[index])) return null;
  let start = index, end = index + 1;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  while (end < text.length && !/\s/.test(text[end])) end++;
  while (start < end && /[\p{P}\p{S}]/u.test(text[start]) && !/[#@+([]/.test(text[start])) start++;
  while (end > start && /[\p{P}\p{S}]/u.test(text[end - 1]) && !/[)\]]/.test(text[end - 1])) end--;
  return end > start ? { start, end } : null;
}

/**
 * Adds a manual mask over [start, end) and over every other exact occurrence of the same text, so a repeated detail
 * cannot slip through unmasked. Masks it overlaps are replaced. Whitespace at the edges is trimmed.
 */
export function addMask(text: string, masks: readonly Mask[], start: number, end: number, kind: MaskKind = 'detail'): Mask[] {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (end <= start) return [...masks];
  const value = text.slice(start, end);
  const ranges: { start: number; end: number }[] = [];
  for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + value.length)) ranges.push({ start: at, end: at + value.length });
  let next = [...masks];
  for (const r of ranges) {
    // An existing mask fully covering this occurrence is simply switched on.
    const cover = next.findIndex((m) => m.start <= r.start && m.end >= r.end);
    if (cover !== -1) {
      next[cover] = { ...next[cover], on: true };
      continue;
    }
    next = next.filter((m) => m.end <= r.start || m.start >= r.end);
    next.push({ start: r.start, end: r.end, kind, on: true, manual: true });
  }
  return next.sort((a, b) => a.start - b.start);
}

/** Switches one mask on or off. A manual mask switched off is removed. */
export function toggleMask(masks: readonly Mask[], index: number): Mask[] {
  const mask = masks[index];
  if (!mask) return [...masks];
  if (mask.manual && mask.on) return masks.filter((_, i) => i !== index);
  return masks.map((m, i) => (i === index ? { ...m, on: !m.on } : m));
}

/**
 * Hex SHA-256 of the exact outgoing text (and image, when an excerpt carries one). A confirmed preview carries it; the
 * send refuses any other payload.
 */
export function payloadDigest(text: string, image?: string | null): string {
  return bytesToHex(sha256(new TextEncoder().encode(image ? `${text}\u0000${image}` : text)));
}

export const hasPlaceholder = (text: string) => new RegExp(PLACEHOLDER.source).test(text);

/** Splits sent text into plain runs and placeholders, for rendering placeholders as chips. */
export function placeholderParts(text: string): { text: string; placeholder: boolean }[] {
  const out: { text: string; placeholder: boolean }[] = [];
  let cursor = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    if (m.index > cursor) out.push({ text: text.slice(cursor, m.index), placeholder: false });
    out.push({ text: m[0], placeholder: true });
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), placeholder: false });
  return out;
}
