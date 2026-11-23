// Feature 07 "Show me the proof": page citations in an answer, checked against the document kept on this device.
// The model is asked to cite as [p. N "exact quote"]. Each citation is located in the local source (whitespace and
// quote marks normalised, case ignored) and recorded with its page and character range. A located quote shows that
// the words are in the document; it is never presented as proof of the whole claim, and a failed match is never shown
// as verified. Pure: no network, no storage.

export type SourcePage = { number: number; text: string };
export type ProofSource = { name: string; pages: SourcePage[] };

export type Segment = { kind: 'text'; text: string } | { kind: 'cite'; index: number; page: number; quote: string | null; claim: string; raw: string };

/** [p. 2 "words"], [p. 2: “words”], [p 2, 'words'] and the plain [p. 2] of older answers. */
const CITE = /\[\s*p(?:age|\.)?\s*(\d{1,4})\s*(?:[,:;-]\s*)?(?:(["“”'‘’])([\s\S]{1,400}?)\2?["“”'‘’]?\s*)?\]/gi;

/** Splits answer text into plain text and citations, with the claim each citation closes (its sentence up to the mark). */
export function parseCitations(text: string): Segment[] {
  const out: Segment[] = [];
  let cursor = 0;
  let index = 0;
  for (const m of text.matchAll(CITE)) {
    const before = text.slice(cursor, m.index);
    if (before) out.push({ kind: 'text', text: before });
    const quote = m[3] ? m[3].replace(/["“”'‘’]+$/, '').trim() : null;
    out.push({ kind: 'cite', index: ++index, page: Number(m[1]), quote: quote || null, claim: claimBefore(text, m.index), raw: m[0] });
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) out.push({ kind: 'text', text: text.slice(cursor) });
  return out;
}

/** The sentence (or clause after the previous citation) that ends at `at`. */
function claimBefore(text: string, at: number): string {
  const head = text.slice(0, at);
  let boundary = Math.max(head.lastIndexOf('\n'), head.lastIndexOf(']'));
  for (const m of head.matchAll(/[.!?]\s+/g)) boundary = Math.max(boundary, m.index + m[0].length - 1);
  return head.slice(boundary + 1).trim();
}

export const hasCitations = (text: string) => new RegExp(CITE.source, 'i').test(text);

/** Lower-cased text with runs of whitespace as one space and typographic quotes and dashes made plain, plus a map from
 *  each normalised character back to its index in the original. */
export function normalise(text: string): { text: string; map: number[] } {
  let out = '';
  const map: number[] = [];
  let space = false;
  for (let i = 0; i < text.length; i++) {
    let ch = text[i];
    if (/\s/.test(ch)) {
      if (!space && out.length) { out += ' '; map.push(i); }
      space = true;
      continue;
    }
    space = false;
    if ('“”„"'.includes(ch)) ch = '"';
    else if ('‘’‚\''.includes(ch)) ch = "'";
    else if ('–—‐-'.includes(ch)) ch = '-';
    const lower = ch.toLowerCase();
    out += lower.length === 1 ? lower : ch;
    map.push(i);
  }
  if (out.endsWith(' ')) { out = out.slice(0, -1); map.pop(); }
  return { text: out, map };
}

export type Located = { page: number; start: number; end: number };
export type ProofStatus =
  | { status: 'found'; at: Located }
  | { status: 'ambiguous'; at: Located; pages: number[] }
  | { status: 'other-page'; at: Located; pages: number[] }
  | { status: 'missing' }
  | { status: 'expired' }
  | { status: 'page-only' };

/** Finds a quote in the local source. The cited page is preferred; other pages are reported, never silently used. */
export function locate(source: ProofSource | null, page: number, quote: string | null): ProofStatus {
  if (!source) return { status: 'expired' };
  const needle = quote ? normalise(quote.replace(/^(?:…|\.{2,}|\s)+|(?:…|\.{2,}|\s)+$/g, '')).text : '';
  if (needle.length < 4) return { status: 'page-only' };
  const hits: Located[] = [];
  for (const p of source.pages) {
    const hay = normalise(p.text);
    for (let at = hay.text.indexOf(needle); at !== -1; at = hay.text.indexOf(needle, at + 1)) {
      hits.push({ page: p.number, start: hay.map[at], end: hay.map[at + needle.length - 1] + 1 });
    }
  }
  if (!hits.length) return { status: 'missing' };
  const pages = [...new Set(hits.map((h) => h.page))].sort((a, b) => a - b);
  const onCited = hits.find((h) => h.page === page);
  if (onCited && pages.length === 1) return { status: 'found', at: onCited };
  if (onCited) return { status: 'ambiguous', at: onCited, pages };
  return { status: 'other-page', at: hits[0], pages };
}

/** The quote with up to `reach` characters of its page on each side, for the source sheet. */
export function context(source: ProofSource, at: Located, reach = 160) {
  const text = source.pages.find((p) => p.number === at.page)?.text ?? '';
  const from = Math.max(0, at.start - reach), to = Math.min(text.length, at.end + reach);
  return { before: `${from > 0 ? '…' : ''}${text.slice(from, at.start)}`, quote: text.slice(at.start, at.end), after: `${text.slice(at.end, to)}${to < text.length ? '…' : ''}` };
}

const UNIT: [RegExp, string][] = [
  [/\b(?:daily|per day|a day|each day|every day)\b/i, 'day'],
  [/\b(?:weekly|per week|a week|each week|every week)\b/i, 'week'],
  [/\b(?:biweekly|fortnightly|every (?:two|2) weeks)\b/i, 'fortnight'],
  [/\b(?:monthly|per month|a month|each month|every month|\/\s?mo(?:nth)?)\b/i, 'month'],
  [/\b(?:quarterly|per quarter|each quarter|every quarter)\b/i, 'quarter'],
  [/\b(?:yearly|annually|annual|per year|a year|each year|every year|per annum|\/\s?yr)\b/i, 'year'],
];
const unitsOf = (text: string) => new Set(UNIT.filter(([re]) => re.test(text)).map(([, unit]) => unit));
const AMOUNT = /(?:[$€£]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:%|usdg|usdc|usd|eur|gbp|dollars?)\b)/gi;
const amountsOf = (text: string) => new Set([...text.matchAll(AMOUNT)].map((m) => m[0].replace(/[^\d.]/g, '').replace(/\.0+$/, '')));

/**
 * What the claim says that the located quote does not: an amount or a frequency ("every month") the quote never
 * states. A located quote with notes is shown as found, with the gap named, never as support for the whole claim.
 */
export function claimGaps(claim: string, quote: string): ('amount' | 'frequency')[] {
  const gaps: ('amount' | 'frequency')[] = [];
  const claimed = amountsOf(claim), quoted = amountsOf(quote);
  if ([...claimed].some((a) => !quoted.has(a))) gaps.push('amount');
  const claimUnits = unitsOf(claim), quoteUnits = unitsOf(quote);
  if (claimUnits.size && ![...claimUnits].some((u) => quoteUnits.has(u))) gaps.push('frequency');
  return gaps;
}

/** The short label next to a claim, in plain language. */
export function statusLabel(proof: ProofStatus, gaps: readonly string[] = []): string {
  switch (proof.status) {
    case 'found': return gaps.length ? `Quote found; ${gaps.map((g) => `${g} not stated`).join(', ')}` : 'Quote found';
    case 'ambiguous': return 'Found on several pages';
    case 'other-page': return `On a different page (p. ${proof.pages.join(', p. ')})`;
    case 'missing': return 'Not in your document';
    case 'expired': return 'Source no longer on this device';
    case 'page-only': return 'Page cited, no quote to check';
  }
}
