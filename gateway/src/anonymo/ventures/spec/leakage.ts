// WS11 · Spec Filter leakage scan (Ventures Backend spec, PART 4: "The filter output is checked by a second rule pass
// (regex and n-gram scan against all Scout artifact text: no 12+ token span may survive)").
//
// Tokens are lowercase word tokens (runs of letters and digits). The index holds every 12-token window of every Scout
// artifact, read three ways for HTML (raw markup, visible text, tags removed) and with JSON string values decoded, so
// markup or escaping cannot hide a copied span.

import { htmlToText } from "../scout/html.ts";
import type { ScoutArtifact } from "../scout/types.ts";

export const SPAN_TOKENS = 12;

const TOKEN = /[\p{L}\p{N}]+/gu;

export const tokenize = (text: string): string[] => text.toLowerCase().match(TOKEN) ?? [];

/** Tokens with their character offsets in `text`. */
export function tokenizeAt(text: string): { token: string; at: number }[] {
  const lower = text.toLowerCase();
  return [...lower.matchAll(TOKEN)].map((m) => ({ token: m[0], at: m.index ?? 0 }));
}

export type NgramIndex = { n: number; grams: Set<string>; tokens: number };

export function buildIndex(texts: Iterable<string>, n = SPAN_TOKENS): NgramIndex {
  const grams = new Set<string>();
  let tokens = 0;
  for (const t of texts) {
    const toks = tokenize(t);
    tokens += toks.length;
    for (let i = 0; i + n <= toks.length; i++) grams.add(toks.slice(i, i + n).join(" "));
  }
  return { n, grams, tokens };
}

export type TokenSpan = { start: number; end: number };

/** Maximal runs of tokens covered by indexed n-grams (each run is at least n tokens long). */
export function sharedSpansInTokens(tokens: string[], index: NgramIndex, n = index.n): TokenSpan[] {
  const spans: TokenSpan[] = [];
  for (let i = 0; i + n <= tokens.length; i++) {
    if (!index.grams.has(tokens.slice(i, i + n).join(" "))) continue;
    const last = spans[spans.length - 1];
    if (last && i <= last.end) last.end = i + n;
    else spans.push({ start: i, end: i + n });
  }
  return spans;
}

export type SharedSpan = TokenSpan & { length: number; text: string };

/** Spans of `text` that also appear (as `n`+ consecutive tokens) in the Scout index. */
export function findSharedSpans(text: string, index: NgramIndex, n = index.n): SharedSpan[] {
  const toks = tokenize(text);
  return sharedSpansInTokens(toks, index, n).map((s) => ({ ...s, length: s.end - s.start, text: toks.slice(s.start, s.end).join(" ") }));
}

function jsonStrings(v: unknown, out: string[]) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) jsonStrings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) jsonStrings(x, out);
}

/** Every reading of every text-bearing Scout artifact (screenshots and other binaries are skipped). */
export function scoutTexts(artifacts: ScoutArtifact[]): string[] {
  const out: string[] = [];
  for (const a of artifacts) {
    const type = String(a.meta.contentType ?? "");
    if (a.ref.kind === "screenshot" || /^(image|video|audio)\//.test(type)) continue;
    const raw = typeof a.body === "string" ? a.body : new TextDecoder().decode(a.body);
    out.push(raw);
    if (/html|xml/.test(type) || /<(html|body|div|p|section)\b/i.test(raw.slice(0, 4000))) {
      out.push(htmlToText(raw));
      out.push(raw.replace(/<[^>]*>/g, ""));
    }
    const head = raw.trimStart()[0];
    if (head === "{" || head === "[") {
      try {
        const strings: string[] = [];
        jsonStrings(JSON.parse(raw), strings);
        out.push(strings.join("\n"));
        for (const s of strings) if (/<[a-z][\s\S]*>/i.test(s)) out.push(htmlToText(s));
      } catch {
        /* not JSON */
      }
    }
  }
  return out;
}

export const scoutIndex = (artifacts: ScoutArtifact[], n = SPAN_TOKENS) => buildIndex(scoutTexts(artifacts), n);
