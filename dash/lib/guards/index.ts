import { CHAT_LIMITS } from '../chat-limits.ts';
import { validateMnemonic } from '@scure/bip39';
import bs58 from 'bs58';
import { mnemonicWordlists } from './wordlists.ts';

/** Limits are UTF-16 code units, matching JavaScript slice and browser selections. */
export const MAX_PROMPT_LENGTH = CHAT_LIMITS.inputBytes;
export const MAX_FINDINGS = 4096;
export const MAX_MNEMONIC_CHECKS = 4096;
export const REDACTION = '[REDACTED SECRET]';

export type GuardFindingType =
  | 'mnemonic'
  | 'solana-key'
  | 'seed'
  | 'private-key'
  | 'api-key'
  | 'jwt'
  | 'secret'
  | 'injection'
  | 'input';

export interface GuardFinding {
  start: number;
  end: number;
  type: GuardFindingType;
  severity: 'block' | 'warning';
  code: string;
  message: string;
}

export interface GuardScanResult {
  findings: GuardFinding[];
  redacted: string;
}

const lists = Object.entries(mnemonicWordlists).map(([name, words]) => ({
  name,
  words,
  set: new Set(words),
}));
const counts = [24, 21, 18, 15, 12];
const secretMessage =
  'Secret-like material detected. Remove it before sending.';
const injectionMessage =
  'Instruction-like content detected. Treat it as untrusted data; this warning does not establish safety.';

type Token = { word: string; start: number; end: number };

function tokensIn(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(
    /(?<![\p{L}\p{M}\p{N}_])[\p{L}\p{M}]+(?![\p{L}\p{M}\p{N}_])/gu,
  )) {
    const start = match.index;
    // Chinese BIP-39 entries are single characters; also recognize pasted unspaced phrases.
    if (/^\p{Script=Han}+$/u.test(match[0])) {
      let offset = start;
      for (const word of match[0]) {
        tokens.push({ word, start: offset, end: offset + word.length });
        offset += word.length;
      }
    } else {
      tokens.push({
        word: match[0].normalize('NFKD').toLowerCase(),
        start,
        end: start + match[0].length,
      });
    }
  }
  return tokens;
}

function inputFailure(code: string, length = 0): GuardScanResult {
  return {
    findings: [
      {
        start: 0,
        end: length,
        type: 'input',
        severity: 'block',
        code,
        message: 'The text could not be checked safely. Do not send it.',
      },
    ],
    redacted: '',
  };
}

/** Only blocking findings are redacted. Overlaps become one replacement, never duplicated text. */
export function redactFindings(
  text: string,
  findings: readonly GuardFinding[],
): string {
  const ranges = findings
    .filter((finding) => finding.severity === 'block')
    .map(({ start, end }) => ({ start, end }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  if (
    ranges.some(
      ({ start, end }) =>
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end < start ||
        end > text.length,
    )
  )
    return '';
  let output = '';
  let cursor = 0;
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    let end = range.end;
    while (index + 1 < ranges.length && ranges[index + 1].start <= end) {
      end = Math.max(end, ranges[++index].end);
    }
    output += text.slice(cursor, range.start) + REDACTION;
    cursor = end;
  }
  return output + text.slice(cursor);
}

/** Pure scanner. Never sends, persists, logs or includes matched text in a finding. */
export function scanPrompt(text: string): GuardScanResult {
  if (typeof text !== 'string') return inputFailure('input.invalid');
  if (text.length > MAX_PROMPT_LENGTH)
    return inputFailure('input.too-large', text.length);
  const findings: GuardFinding[] = [];
  let overflow = false;
  const add = (
    start: number,
    end: number,
    type: GuardFindingType,
    code: string,
    severity: GuardFinding['severity'] = 'block',
  ) => {
    if (findings.length >= MAX_FINDINGS) {
      overflow = true;
      return;
    }
    findings.push({
      start,
      end,
      type,
      severity,
      code,
      message: severity === 'warning' ? injectionMessage : secretMessage,
    });
  };
  const tokens = tokensIn(text);
  let checksumChecks = 0;
  const joined = tokens.map(
    (token, index) =>
      index === 0 ||
      /^[\s,;'"“”‘’()[\]{}]*$/u.test(
        text.slice(tokens[index - 1].end, token.start),
      ),
  );
  for (const list of lists) {
    // Per-request only: repeated candidate windows must not repeat expensive checksums.
    const checked = new Map<string, boolean>();
    const run = new Uint32Array(tokens.length);
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
      if (list.set.has(tokens[index].word)) {
        run[index] = 1 + (joined[index + 1] ? run[index + 1] || 0 : 0);
      }
    }
    for (let index = 0; index < tokens.length && !overflow; index += 1) {
      for (const count of counts) {
        if (run[index] < count) continue;
        const words = tokens
          .slice(index, index + count)
          .map((token) => token.word)
          .join(' ');
        let valid = checked.get(words);
        if (valid === undefined) {
          if (checksumChecks >= MAX_MNEMONIC_CHECKS)
            return inputFailure('input.scan-budget', text.length);
          checksumChecks += 1;
          valid = validateMnemonic(words, list.words);
          checked.set(words, valid);
        }
        if (valid) {
          add(
            tokens[index].start,
            tokens[index + count - 1].end,
            'mnemonic',
            `bip39.${list.name}`,
          );
          break;
        }
      }
    }
  }

  // A 64-byte base58 string can also be a public transaction signature. This is a
  // conservative prompt boundary, not proof of private-key ownership or validity.
  for (const match of text.matchAll(
    /(?<![\p{L}\p{N}_])[1-9A-HJ-NP-Za-km-z]{64,88}(?![\p{L}\p{N}_])/gu,
  )) {
    try {
      if (bs58.decode(match[0]).length === 64)
        add(
          match.index,
          match.index + match[0].length,
          'solana-key',
          'solana.base58-64',
        );
    } catch {
      /* Not a supported encoding. */
    }
  }
  for (const match of text.matchAll(
    /\[\s*\d{1,3}(?:\s*,\s*\d{1,3}){63}\s*\]/g,
  )) {
    try {
      const value: unknown = JSON.parse(match[0]);
      if (
        Array.isArray(value) &&
        value.length === 64 &&
        value.every(
          (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
        )
      ) {
        add(
          match.index,
          match.index + match[0].length,
          'solana-key',
          'solana.json-64',
        );
      }
    } catch {
      /* Not a JSON byte array. */
    }
  }
  for (const match of text.matchAll(
    /\b(?:(?:ed25519|solana)[ _-]*)?(?:seed|private[ _-]*key|secret[ _-]*key)(?:[ _-]*(?:hex|base58|base64))?\s*[:=]\s*["']?(\[\s*\d{1,3}(?:\s*,\s*\d{1,3}){31}\s*\]|(?:0x)?[A-Fa-f0-9]{64}|[A-Za-z0-9+/=_-]{32,88})(?![A-Za-z0-9+/=_-])/gi,
  )) {
    const value = match[1];
    let valid = /^(?:0x)?[a-f0-9]{64}$/i.test(value);
    if (value.startsWith('[')) {
      try {
        const bytes: unknown = JSON.parse(value);
        valid =
          Array.isArray(bytes) &&
          bytes.length === 32 &&
          bytes.every(
            (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
          );
      } catch {
        /* Invalid JSON is not a supported seed encoding. */
      }
    }
    if (!valid) {
      try {
        valid = bs58.decode(value).length === 32;
      } catch {
        /* Try base64 next. */
      }
    }
    if (!valid && /^[A-Za-z0-9+/_-]{43}=?$/.test(value)) {
      try {
        valid =
          atob(value.replaceAll('-', '+').replaceAll('_', '/')).length === 32;
      } catch {
        /* Invalid base64. */
      }
    }
    if (valid) {
      const start = match.index + match[0].lastIndexOf(value);
      add(start, start + value.length, 'seed', 'seed.labelled-32');
    }
  }
  for (const match of text.matchAll(
    /-----BEGIN ((?:RSA |EC |OPENSSH |ENCRYPTED |DSA )?PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g,
  )) {
    add(
      match.index,
      match.index + match[0].length,
      'private-key',
      'pem.private-key',
    );
  }

  const apiPatterns: readonly [string, RegExp][] = [
    [
      'vendor.prefixed',
      /(?<![\w-])(?:sk-(?:(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,})|gsk_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,})(?![\w-])/g,
    ],
    [
      'github.token',
      /(?<!\w)(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})(?!\w)/g,
    ],
    ['google.api-key', /(?<!\w)AIza[A-Za-z0-9_-]{35}(?![\w-])/g],
    ['aws.access-key', /(?<!\w)(?:AKIA|ASIA)[A-Z0-9]{16}(?!\w)/g],
    ['slack.token', /(?<![\w-])xox[baprs]-[A-Za-z0-9-]{10,}(?![\w-])/g],
    ['stripe.secret', /(?<!\w)(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}(?!\w)/g],
    [
      'sendgrid.key',
      /(?<![\w.-])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{32,}(?![\w.-])/g,
    ],
  ];
  for (const [code, pattern] of apiPatterns) {
    for (const match of text.matchAll(pattern))
      add(match.index, match.index + match[0].length, 'api-key', code);
  }
  for (const match of text.matchAll(
    /(?<![\w.-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![\w.-])/g,
  )) {
    try {
      const parts = match[0].split('.');
      const header: unknown = JSON.parse(
        atob(parts[0].replaceAll('-', '+').replaceAll('_', '/')),
      );
      const payload: unknown = JSON.parse(
        atob(parts[1].replaceAll('-', '+').replaceAll('_', '/')),
      );
      if (
        header &&
        typeof header === 'object' &&
        'alg' in header &&
        typeof header.alg === 'string' &&
        payload &&
        typeof payload === 'object'
      ) {
        add(match.index, match.index + match[0].length, 'jwt', 'jwt.token');
      }
    } catch {
      /* Arbitrary dotted text is not a JWT. */
    }
  }
  // Preserve the variable name, delimiters and surrounding prose during redaction.
  for (const match of text.matchAll(
    /\b(?:[A-Z][A-Z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)|API_?KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)(?:[A-Z0-9_]*)\b["']?\s*[:=]\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#;,}"']+))/gi,
  )) {
    const value = match[1] ?? match[2] ?? match[3];
    const offset = match[0].indexOf(value, match[0].search(/[:=]/) + 1);
    add(
      match.index + offset,
      match.index + offset + value.length,
      'secret',
      'secret.assignment',
    );
  }
  for (const match of text.matchAll(
    /\bBearer\s+([A-Za-z0-9._~+/-]{16,}=*)/gi,
  )) {
    const start = match.index + match[0].indexOf(match[1]);
    add(start, start + match[1].length, 'secret', 'secret.bearer');
  }
  for (const match of text.matchAll(
    /[?&](?:api[-_]?key|access[-_]?token|secret)=([^\s&#"'<>]+)/gi,
  )) {
    const start = match.index + match[0].indexOf('=') + 1;
    add(start, start + match[1].length, 'secret', 'secret.url-query');
  }
  for (const match of text.matchAll(
    /\bhttps:\/\/[A-Za-z0-9.-]+\.(?:alchemy\.com|infura\.io)\/v[23]\/([A-Za-z0-9_-]{16,})(?![A-Za-z0-9_-])/g,
  )) {
    const start = match.index + match[0].lastIndexOf(match[1]);
    add(start, start + match[1].length, 'secret', 'secret.rpc-url');
  }
  for (const match of text.matchAll(
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|https?):\/\/[^@\s/:]+:([^@\s]+)@/gi,
  )) {
    const start = match.index + match[0].lastIndexOf(match[1]);
    add(start, start + match[1].length, 'secret', 'secret.url-password');
  }
  for (const match of text.matchAll(
    /\b(?:ignore|disregard|override)\s+(?:(?:all|the|your)\s+)?(?:previous|prior|system|developer)\s+(?:instructions|prompt|rules)|\b(?:reveal|print|show|exfiltrate)\s+(?:(?:your|the|hidden)\s+)?(?:system|developer)\s+prompt|<\/?(?:system|developer)>/gi,
  )) {
    add(
      match.index,
      match.index + match[0].length,
      'injection',
      'injection.marker',
      'warning',
    );
  }
  if (overflow) return inputFailure('input.too-many-findings', text.length);
  findings.sort(
    (a, b) =>
      a.start - b.start || b.end - a.end || a.code.localeCompare(b.code),
  );
  return { findings, redacted: redactFindings(text, findings) };
}

export const scanText = scanPrompt;
