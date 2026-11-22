// Sealed Share (update "share"): a chat shared through a link that Anonymo can't read.
//
// The link is built entirely in this browser. The chat becomes a small JSON document, is compressed, and is sealed
// with AES-256-GCM under a fresh random key. Everything rides in the link's fragment (after the #), which a browser
// never sends to any server:
//
//   <origin>/s#<payload>.<key>     anyone with the whole link can read the chat
//   <origin>/s#<payload>           the key comes from a passphrase (PBKDF2-SHA256), which the reader must type
//
// The payload is base64url of: version (1 byte), mode (1 byte: 0 = key in the link, 1 = passphrase), the PBKDF2 salt
// (16 bytes, passphrase mode only), the AES-GCM IV (12 bytes) and the ciphertext. The header bytes are bound to the
// ciphertext as additional data, so changing any byte of the link makes it fail to open.
//
// Only message text, who said it, the model id and the character's display name go in. Keys, balances, receipts,
// memory facts, vault data, images and attachments never do: the document is built from an allowlist of fields.

export const SHARE_VERSION = 1;
export const SHARE_PATH = '/s';
/** The longest link we make, in characters. Some chat apps and browsers cut longer links. */
export const SHARE_LINK_MAX = 60_000;
/** PBKDF2-SHA256 rounds for passphrase links. Part of format version 1: changing it needs a new version. */
export const SHARE_ITERATIONS = 600_000;
export const PASSPHRASE_MIN = 8;

const MODE_KEY = 0;
const MODE_PASSPHRASE = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
/** Largest fragment the viewer will try to read, and largest document it will unpack. */
const FRAGMENT_MAX = 256_000;
const PLAIN_MAX = 4_000_000;
const TITLE_MAX = 120;
const LABEL_MAX = 200;
const MESSAGES_MAX = 5_000;

export type SharedMessage = { role: 'user' | 'assistant'; text: string; model?: string; name?: string };
export type SharedChat = { v: 1; title: string; createdAt: string; messages: SharedMessage[] };

/** The few fields of a chat turn that sharing reads. Anything else on a turn is never looked at. */
export type ShareableTurn = {
  prompt: string;
  content: string;
  model: string;
  character: string | null;
  status: 'streaming' | 'done' | 'stopped' | 'error';
};

export type ShareErrorCode = 'empty' | 'garbled' | 'version' | 'needs_passphrase' | 'wrong_passphrase';

export class ShareLinkError extends Error {
  readonly code: ShareErrorCode;
  constructor(code: ShareErrorCode) {
    super(SHARE_ERROR_TEXT[code]);
    this.code = code;
  }
}

export const SHARE_ERROR_TEXT: Record<ShareErrorCode, string> = {
  empty: 'This link has no chat in it.',
  garbled: 'Part of the link is missing or was changed. Ask for the whole link again.',
  version: 'This link was made by a newer version of Anonymo. Reload the page and try again.',
  needs_passphrase: 'This chat is locked with a passphrase.',
  wrong_passphrase: 'That passphrase doesn’t open this chat. Check it and try again.',
};

// ---- building the document ---------------------------------------------------------------------------------------

/** Turns with a finished answer. Turns still streaming or that failed are left out. */
export const shareableTurns = <T extends ShareableTurn>(turns: readonly T[]): T[] =>
  turns.filter((t) => (t.status === 'done' || t.status === 'stopped') && t.content.trim() !== '');

/** Two messages per turn, built from an allowlist: the prompt, the answer, the model id and the character name. */
export function messagesFrom(turns: readonly ShareableTurn[]): SharedMessage[] {
  const out: SharedMessage[] = [];
  for (const t of shareableTurns(turns)) {
    out.push({ role: 'user', text: String(t.prompt) });
    const answer: SharedMessage = { role: 'assistant', text: String(t.content) };
    if (typeof t.model === 'string' && t.model) answer.model = t.model.slice(0, LABEL_MAX);
    if (typeof t.character === 'string' && t.character) answer.name = t.character.slice(0, LABEL_MAX);
    out.push(answer);
  }
  return out;
}

/** A short title from the first thing the person asked. */
export function titleFor(turns: readonly ShareableTurn[]): string {
  const first = shareableTurns(turns)[0];
  const text = (first?.prompt ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return 'A shared chat';
  return text.length > 60 ? `${text.slice(0, 60).trimEnd()}…` : text;
}

export function sharedChat(title: string, messages: SharedMessage[], now = new Date()): SharedChat {
  return {
    v: SHARE_VERSION,
    title: title.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) || 'A shared chat',
    createdAt: now.toISOString(),
    // Copy field by field so nothing else on a message object can come along.
    messages: messages.map((m) => {
      const out: SharedMessage = { role: m.role === 'assistant' ? 'assistant' : 'user', text: String(m.text) };
      if (m.model) out.model = String(m.model).slice(0, LABEL_MAX);
      if (m.name) out.name = String(m.name).slice(0, LABEL_MAX);
      return out;
    }),
  };
}

// ---- bytes -------------------------------------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INDEX = new Map(B64.split('').map((c, i) => [c, i]));

export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const left = bytes.length - i;
  if (left === 1) {
    const n = bytes[i] << 16;
    out += B64[n >> 18] + B64[(n >> 12) & 63];
  } else if (left === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63];
  }
  return out;
}

/** Strict: any character outside base64url, or a length no encoder makes, is an error. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (text.length % 4 === 1) throw new ShareLinkError('garbled');
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let o = 0;
  for (const c of text) {
    const v = B64_INDEX.get(c);
    if (v === undefined) throw new ShareLinkError('garbled');
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (value >> bits) & 255;
    }
  }
  // The last character's unused bits must be zero, so each byte string has exactly one spelling and changing any
  // character of a link always changes its bytes.
  if (value & ((1 << bits) - 1)) throw new ShareLinkError('garbled');
  return out;
}

/** Characters base64url needs for `n` bytes, without padding. */
export const base64UrlLength = (n: number) => Math.floor(n / 3) * 4 + (n % 3 ? (n % 3) + 1 : 0);

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function readAll(stream: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new ShareLinkError('garbled');
    }
    chunks.push(value);
  }
  return concat(...chunks);
}

const FORMAT = 'deflate-raw';

export async function compress(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return readAll(new Blob([bytes]).stream().pipeThrough(new CompressionStream(FORMAT)), Number.MAX_SAFE_INTEGER);
}

async function decompress(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return await readAll(new Blob([bytes]).stream().pipeThrough(new DecompressionStream(FORMAT)), PLAIN_MAX);
  } catch {
    throw new ShareLinkError('garbled');
  }
}

const utf8 = new TextEncoder();

// ---- keys --------------------------------------------------------------------------------------------------------

export type ShareSecret =
  | { mode: 'key'; key: CryptoKey; raw: Uint8Array<ArrayBuffer> }
  | { mode: 'passphrase'; key: CryptoKey; salt: Uint8Array<ArrayBuffer> };

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', utf8.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: SHARE_ITERATIONS },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

const importRaw = (raw: Uint8Array<ArrayBuffer>) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

/** A null passphrase means a random key that rides in the link. */
export async function newShareSecret(passphrase: string | null): Promise<ShareSecret> {
  if (passphrase === null) {
    const raw = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
    return { mode: 'key', key: await importRaw(raw), raw };
  }
  const check = checkPassphrase(passphrase);
  if (check) throw new Error(check);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return { mode: 'passphrase', key: await deriveKey(passphrase, salt), salt };
}

/** Why a passphrase can't be used, or null when it can. */
export function checkPassphrase(passphrase: string): string | null {
  if (passphrase.length < PASSPHRASE_MIN) return `Use at least ${PASSPHRASE_MIN} characters.`;
  return null;
}

const headerOf = (secret: ShareSecret) =>
  secret.mode === 'key' ? new Uint8Array([SHARE_VERSION, MODE_KEY]) : concat(new Uint8Array([SHARE_VERSION, MODE_PASSPHRASE]), secret.salt);

// ---- sealing -----------------------------------------------------------------------------------------------------

const linkBase = (origin: string) => `${origin.replace(/\/+$/, '')}${SHARE_PATH}#`;

/** How long the link for a document of `compressedBytes` (after compression) will be, without building it. */
export function linkLength(origin: string, mode: ShareSecret['mode'], compressedBytes: number): number {
  const header = mode === 'key' ? 2 : 2 + SALT_BYTES;
  const payload = base64UrlLength(header + IV_BYTES + compressedBytes + TAG_BYTES);
  return linkBase(origin).length + payload + (mode === 'key' ? 1 + base64UrlLength(KEY_BYTES) : 0);
}

const packed = (chat: SharedChat) => compress(utf8.encode(JSON.stringify(chat)));

export async function sealChat(origin: string, chat: SharedChat, secret: ShareSecret): Promise<string> {
  const header = headerOf(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, secret.key, await packed(chat)));
  const payload = toBase64Url(concat(header, iv, sealed));
  return linkBase(origin) + payload + (secret.mode === 'key' ? `.${toBase64Url(secret.raw)}` : '');
}

export type ShareResult =
  | { ok: true; link: string; messages: number }
  | { ok: false; reason: 'too_long'; fitsFrom: number | null }
  | { ok: false; reason: 'empty' };

/**
 * The link for these messages, or why there is none. When the chat is too long, `fitsFrom` is the first message of
 * the most recent part that fits (always a message from the person), or null when even the last exchange is too long.
 */
export async function createShareLink(
  origin: string,
  title: string,
  messages: SharedMessage[],
  secret: ShareSecret,
  opts: { max?: number; now?: Date } = {},
): Promise<ShareResult> {
  const max = opts.max ?? SHARE_LINK_MAX;
  if (!messages.length) return { ok: false, reason: 'empty' };
  const chat = sharedChat(title, messages, opts.now);
  if (linkLength(origin, secret.mode, (await packed(chat)).length) > max)
    return { ok: false, reason: 'too_long', fitsFrom: await fitFrom(origin, chat, secret.mode, max) };
  const link = await sealChat(origin, chat, secret);
  return { ok: true, link, messages: chat.messages.length };
}

/** The earliest start (on a message from the person) whose remaining messages fit in `max`, or null. */
async function fitFrom(origin: string, chat: SharedChat, mode: ShareSecret['mode'], max: number): Promise<number | null> {
  const starts = chat.messages.flatMap((m, i) => (m.role === 'user' && i > 0 ? [i] : []));
  const fits = async (from: number) => linkLength(origin, mode, (await packed({ ...chat, messages: chat.messages.slice(from) })).length) <= max;
  // Fewer messages compress to fewer bytes, so search for the earliest start that fits.
  let lo = 0;
  let hi = starts.length - 1;
  let found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (await fits(starts[mid])) {
      found = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return found === null ? null : starts[found];
}

// ---- opening -----------------------------------------------------------------------------------------------------

export type ParsedShare = { mode: 'key' | 'passphrase'; header: Uint8Array<ArrayBuffer>; salt: Uint8Array<ArrayBuffer> | null; iv: Uint8Array<ArrayBuffer>; sealed: Uint8Array<ArrayBuffer>; key: Uint8Array<ArrayBuffer> | null };

/** Splits a fragment (`#payload.key` or `#payload`, with or without the `#`). Throws ShareLinkError. */
export function parseShareFragment(fragment: string): ParsedShare {
  const raw = (fragment.startsWith('#') ? fragment.slice(1) : fragment).trim();
  if (!raw) throw new ShareLinkError('empty');
  if (raw.length > FRAGMENT_MAX) throw new ShareLinkError('garbled');
  const parts = raw.split('.');
  if (parts.length > 2 || !parts[0]) throw new ShareLinkError('garbled');
  const bytes = fromBase64Url(parts[0]);
  if (bytes.length < 2) throw new ShareLinkError('garbled');
  if (bytes[0] !== SHARE_VERSION) throw new ShareLinkError(bytes[0] > SHARE_VERSION ? 'version' : 'garbled');
  const mode = bytes[1] === MODE_KEY ? 'key' : bytes[1] === MODE_PASSPHRASE ? 'passphrase' : null;
  if (!mode) throw new ShareLinkError('garbled');
  const headerLength = mode === 'key' ? 2 : 2 + SALT_BYTES;
  if (bytes.length < headerLength + IV_BYTES + TAG_BYTES) throw new ShareLinkError('garbled');
  let key: Uint8Array<ArrayBuffer> | null = null;
  if (mode === 'key') {
    if (parts.length !== 2) throw new ShareLinkError('garbled');
    key = fromBase64Url(parts[1]);
    if (key.length !== KEY_BYTES) throw new ShareLinkError('garbled');
  } else if (parts.length !== 1) throw new ShareLinkError('garbled');
  return {
    mode,
    header: bytes.slice(0, headerLength),
    salt: mode === 'passphrase' ? bytes.slice(2, headerLength) : null,
    iv: bytes.slice(headerLength, headerLength + IV_BYTES),
    sealed: bytes.slice(headerLength + IV_BYTES),
    key,
  };
}

/** Whether a fragment needs a passphrase to open. Throws ShareLinkError when the fragment can't be read at all. */
export const needsPassphrase = (fragment: string) => parseShareFragment(fragment).mode === 'passphrase';

/** Opens a share fragment. Throws ShareLinkError with a code the page can explain. */
export async function openShareFragment(fragment: string, passphrase?: string): Promise<SharedChat> {
  const parsed = parseShareFragment(fragment);
  let key: CryptoKey;
  if (parsed.mode === 'key') {
    try {
      key = await importRaw(parsed.key!);
    } catch {
      throw new ShareLinkError('garbled');
    }
  } else {
    if (!passphrase) throw new ShareLinkError('needs_passphrase');
    key = await deriveKey(passphrase, parsed.salt!);
  }
  let packedBytes: Uint8Array<ArrayBuffer>;
  try {
    packedBytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: parsed.iv, additionalData: parsed.header }, key, parsed.sealed));
  } catch {
    // With a passphrase a wrong passphrase and a changed link look the same; the page says so.
    throw new ShareLinkError(parsed.mode === 'passphrase' ? 'wrong_passphrase' : 'garbled');
  }
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await decompress(packedBytes)));
  } catch (e) {
    if (e instanceof ShareLinkError) throw e;
    throw new ShareLinkError('garbled');
  }
  return readChat(doc);
}

/** Checks a decrypted document and keeps only the fields the viewer shows. */
export function readChat(doc: unknown): SharedChat {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new ShareLinkError('garbled');
  const d = doc as Record<string, unknown>;
  if (d.v !== SHARE_VERSION) throw new ShareLinkError(typeof d.v === 'number' && d.v > SHARE_VERSION ? 'version' : 'garbled');
  if (typeof d.title !== 'string' || typeof d.createdAt !== 'string' || !Array.isArray(d.messages)) throw new ShareLinkError('garbled');
  if (d.messages.length > MESSAGES_MAX) throw new ShareLinkError('garbled');
  const messages = d.messages.map((m: unknown): SharedMessage => {
    if (!m || typeof m !== 'object') throw new ShareLinkError('garbled');
    const r = m as Record<string, unknown>;
    if ((r.role !== 'user' && r.role !== 'assistant') || typeof r.text !== 'string') throw new ShareLinkError('garbled');
    const out: SharedMessage = { role: r.role, text: r.text };
    if (typeof r.model === 'string' && r.model) out.model = r.model.slice(0, LABEL_MAX);
    if (typeof r.name === 'string' && r.name) out.name = r.name.slice(0, LABEL_MAX);
    return out;
  });
  return { v: SHARE_VERSION, title: d.title.slice(0, TITLE_MAX), createdAt: d.createdAt.slice(0, 40), messages };
}
