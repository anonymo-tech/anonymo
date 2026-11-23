// Feature 01 "Mask my details": personal-detail detectors for the composer's local review. They suggest masks; they
// never block a send and never decide what is safe. Like the secret scanner in index.ts this is pure: it returns
// offsets and a kind only, never the matched text, and it never sends, stores or logs anything.

export type PersonalKind = 'name' | 'email' | 'phone' | 'card' | 'account' | 'address' | 'reference';

export interface PersonalFinding {
  start: number;
  end: number;
  kind: PersonalKind;
  code: string;
  /** Suggested on by default. References are offered (underlined) but left for the person to tap. */
  suggested: boolean;
}

/** A bound on the work one scan may do, matching the secret scanner's finding limit. */
export const MAX_PERSONAL_FINDINGS = 512;

const digitsOf = (s: string) => s.replace(/\D/g, '');

/** Luhn checksum, used for payment card numbers. */
export function luhnValid(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** ISO 13616 mod-97 check for an IBAN, spaces removed. */
export function ibanValid(value: string): boolean {
  const iban = value.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of moved) {
    const code = ch.charCodeAt(0);
    const part = code >= 65 ? String(code - 55) : ch;
    for (const digit of part) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/** Words that follow a greeting but are not names. */
const NOT_NAMES = new Set([
  'there', 'all', 'team', 'everyone', 'everybody', 'folks', 'friend', 'friends', 'sir', 'madam', 'again', 'anonymo',
  'nymo', 'support', 'customer', 'service', 'the', 'my', 'a', 'an', 'this', 'that', 'i', 'we', 'you', 'thanks',
  'thank', 'regards', 'hello', 'hi', 'hey', 'dear', 'good', 'morning', 'afternoon', 'evening', 'is', 'and', 'or',
]);

const STREET =
  '(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Court|Ct|Way|Place|Pl|Terrace|Close|Crescent|Square|Sq|Parkway|Pkwy|Highway|Hwy|Row|Gardens|Grove|Hill|Mews|Walk)';

/** Pure scan for personal details. Overlapping findings are resolved so each character belongs to at most one. */
export function scanPersonal(text: string): PersonalFinding[] {
  if (typeof text !== 'string' || !text) return [];
  const found: PersonalFinding[] = [];
  const add = (start: number, end: number, kind: PersonalKind, code: string, suggested = true) => {
    if (found.length < MAX_PERSONAL_FINDINGS && end > start) found.push({ start, end, kind, code, suggested });
  };

  for (const m of text.matchAll(/(?<![\w.+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}(?![\w-])/g))
    add(m.index, m.index + m[0].length, 'email', 'email');

  // IBANs before cards and phones: their digits would otherwise be read as one of those.
  for (const m of text.matchAll(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g))
    if (ibanValid(m[0])) add(m.index, m.index + m[0].length, 'account', 'iban');

  for (const m of text.matchAll(/(?<![\d-])\d(?:[ -]?\d){11,18}(?![\d-])/g))
    if (luhnValid(digitsOf(m[0]))) add(m.index, m.index + m[0].length, 'card', 'card.luhn');

  // A labelled account, customer or routing number: the value after the label.
  for (const m of text.matchAll(
    /\b(?:account|acct|a\/c|iban|routing|sort code|customer|member|policy|membership|meter|subscriber)(?:\s+(?:no\.?|number|num|id|#))?\s*[:#]?\s*((?=[A-Z0-9-]*\d[A-Z0-9-]*\d[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{3,33}[A-Z0-9])\b/gi,
  )) {
    const start = m.index + m[0].lastIndexOf(m[1]);
    add(start, start + m[1].length, 'account', 'account.labelled');
  }

  // Phone numbers: a leading + or (area), or a phone label, or at least nine digits split into groups.
  for (const m of text.matchAll(/(?<![\w+])(\+\d{1,3}[\s.-]?)?(\(\d{1,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]\d{2,5}){1,4}(?![\w])/g)) {
    const value = m[0];
    const digits = digitsOf(value).length;
    if (digits < 7 || digits > 15) continue;
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(value) || /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(value)) continue; // dates
    const before = text.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    const labelled = /\b(?:phone|tel|telephone|mobile|cell|call|text|whatsapp|fax)\b[^\n]{0,8}$/.test(before);
    if (m[1] || m[2] || labelled || digits >= 9) add(m.index, m.index + value.length, 'phone', 'phone');
  }

  for (const m of text.matchAll(
    new RegExp(String.raw`\b\d{1,5}[A-Za-z]?\s+(?:[A-Z][\p{L}'-]+\s+){1,3}${STREET}\b(?:,?\s*(?:Apt|Apartment|Unit|Suite|Flat|#)\s*[\w-]+)?`, 'gu'),
  ))
    add(m.index, m.index + m[0].length, 'address', 'address.street');

  // Names after a title, a greeting or "my name is". The lead-in is matched without case; the name must be capitalised.
  const nameRe =
    /\b(?:(mr|mrs|ms|mx|miss|dr|prof)\.?|my name is|name\s*:|dear|hello|hi|hey|signed|regards|sincerely|cheers|thanks|from)[,:]?\s+(?=(\p{L}[\p{L}'’-]+(?:\s+\p{L}[\p{L}'’-]+)?))/giu;
  for (const m of text.matchAll(nameRe)) {
    const words = m[2].split(/\s+/);
    const keep: string[] = [];
    for (const word of words) {
      if (!/^\p{Lu}/u.test(word) || NOT_NAMES.has(word.toLowerCase())) break;
      keep.push(word);
    }
    if (!keep.length) continue;
    // A greeting needs no title; "From Monday" is not a name, so "from" needs two capitalised words.
    if (/^from$/i.test(m[0].split(/\s/)[0]) && keep.length < 2) continue;
    const value = keep.join(' ');
    // The name is a lookahead, so a lead-in that finds no name ("Hello, my name is …") leaves the next lead-in to match.
    const start = m.index + m[0].length;
    add(start, start + value.length, 'name', m[1] ? 'name.title' : 'name.lead-in');
  }

  // Invoice, order, ticket and other reference ids: offered, not masked by default.
  for (const m of text.matchAll(/\b(?:INV|REF|ORD|ORDER|CASE|TKT|TICKET|PO|BILL|CLM|BKG|CONF|DEMO)[-#]?\d{2,}[A-Z0-9-]*\b/gi))
    add(m.index, m.index + m[0].length, 'reference', 'reference.id', false);
  for (const m of text.matchAll(
    /\b(?:invoice|reference|ref|order|case|ticket|claim|booking|confirmation|tracking)(?:\s+(?:no\.?|number|num|id|#))?\s*[:#]\s*((?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{2,30})\b/gi,
  )) {
    const start = m.index + m[0].lastIndexOf(m[1]);
    add(start, start + m[1].length, 'reference', 'reference.labelled', false);
  }

  return resolveOverlaps(found);
}

/** Earlier, then longer, findings win; a finding that overlaps one already kept is dropped. */
export function resolveOverlaps<T extends { start: number; end: number }>(findings: T[]): T[] {
  const sorted = [...findings].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: T[] = [];
  let reach = -1;
  for (const f of sorted) {
    if (f.start < reach) continue;
    out.push(f);
    reach = f.end;
  }
  return out;
}
