// Update "share": Sealed Share. The link format, sealing and opening, passphrase links, tampering, the size cap, and
// the allowlist of what a shared chat may hold (lib/anonymo/share.ts).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import fc from 'fast-check';
import {
  base64UrlLength,
  checkPassphrase,
  createShareLink,
  fromBase64Url,
  linkLength,
  messagesFrom,
  needsPassphrase,
  newShareSecret,
  openShareFragment,
  parseShareFragment,
  sealChat,
  SHARE_ITERATIONS,
  SHARE_LINK_MAX,
  sharedChat,
  ShareLinkError,
  titleFor,
  toBase64Url,
} from '../lib/anonymo/share.ts';
import { UPDATE_IDS, RELEASED, updateOn } from '../lib/anonymo/updates.ts';

const ORIGIN = 'https://anonymo.example';
const SAMPLE_KEY = `anm_live_${'ab'.repeat(32)}`;
const NOW = new Date('2026-01-02T03:04:05.000Z');

const turn = (prompt, content, extra = {}) => ({
  id: `t-${prompt.length}`,
  model: 'anonymo-1',
  prompt,
  attachment: null,
  character: null,
  content,
  status: 'done',
  error: null,
  receiptId: null,
  receipt: null,
  council: null,
  councilMode: null,
  ...extra,
});

const fragmentOf = (link) => new URL(link).hash;
const code = (c) => (e) => e instanceof ShareLinkError && e.code === c;

// ---- the link ---------------------------------------------------------------------------------------------------

test('a link round-trips, and everything secret is after the #', async () => {
  const messages = messagesFrom([turn('Plan a weekend trip.', 'Here is a plan.'), turn('Make it cheaper.', 'Sure, a cheaper one.', { character: 'Mo' })]);
  const secret = await newShareSecret(null);
  const made = await createShareLink(ORIGIN, 'Weekend', messages, secret, { now: NOW });
  assert.equal(made.ok, true);
  const url = new URL(made.link);
  assert.equal(url.origin + url.pathname, `${ORIGIN}/s`);
  assert.equal(url.search, '');
  assert.match(url.hash, /^#[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.equal(made.link.split('#').length, 2);
  const chat = await openShareFragment(url.hash);
  assert.deepEqual(chat, { v: 1, title: 'Weekend', createdAt: NOW.toISOString(), messages });
  assert.equal(chat.messages[3].name, 'Mo');
  assert.equal(chat.messages[3].model, 'anonymo-1');
  assert.equal(needsPassphrase(url.hash), false);
  // The fragment without its leading # opens too.
  assert.deepEqual(await openShareFragment(url.hash.slice(1)), chat);
});

test('any text round-trips, including emoji and every script', async () => {
  const secret = await newShareSecret(null);
  await fc.assert(
    fc.asyncProperty(fc.array(fc.tuple(fc.string({ unit: 'grapheme', maxLength: 200 }), fc.string({ unit: 'grapheme', minLength: 1, maxLength: 200 })), { minLength: 1, maxLength: 6 }), async (pairs) => {
      const turns = pairs.filter(([, a]) => a.trim()).map(([p, a]) => turn(p, a));
      fc.pre(turns.length > 0);
      const messages = messagesFrom(turns);
      const made = await createShareLink(ORIGIN, 'x', messages, secret, { now: NOW });
      assert.equal(made.ok, true);
      assert.deepEqual((await openShareFragment(fragmentOf(made.link))).messages, messages);
    }),
    { numRuns: 40 },
  );
});

test('two links for the same chat never share a key or IV', async () => {
  const messages = messagesFrom([turn('hi', 'hello')]);
  const a = await createShareLink(ORIGIN, 't', messages, await newShareSecret(null), { now: NOW });
  const b = await createShareLink(ORIGIN, 't', messages, await newShareSecret(null), { now: NOW });
  assert.notEqual(a.link, b.link);
  assert.notEqual(a.link.split('.').at(-1), b.link.split('.').at(-1));
});

test('predicted link length matches the built link', async () => {
  for (const passphrase of [null, 'correct horse battery']) {
    const secret = await newShareSecret(passphrase);
    for (const n of [1, 3, 20]) {
      const chat = sharedChat('t', messagesFrom(Array.from({ length: n }, (_, i) => turn(`q${i} ${'word '.repeat(i * 7)}`, `a${i}`))), NOW);
      const link = await sealChat(ORIGIN, chat, secret);
      const compressed = await import('../lib/anonymo/share.ts').then((m) => m.compress(new TextEncoder().encode(JSON.stringify(chat))));
      assert.equal(link.length, linkLength(ORIGIN, secret.mode, compressed.length));
    }
  }
});

test('base64url is strict and round-trips', () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
      const text = toBase64Url(bytes);
      assert.match(text, /^[A-Za-z0-9_-]*$/);
      assert.equal(text.length, base64UrlLength(bytes.length));
      assert.deepEqual(fromBase64Url(text), new Uint8Array(bytes));
    }),
  );
  assert.throws(() => fromBase64Url('ab+c'), code('garbled'));
  assert.throws(() => fromBase64Url('ab=c'), code('garbled'));
  assert.throws(() => fromBase64Url('abcde'), code('garbled'));
});

// ---- passphrases ------------------------------------------------------------------------------------------------

test('a passphrase link holds no key and opens only with the passphrase', async () => {
  assert.ok(SHARE_ITERATIONS >= 600_000);
  const messages = messagesFrom([turn('A secret question', 'A secret answer')]);
  const secret = await newShareSecret('sample passphrase');
  const made = await createShareLink(ORIGIN, 'Locked', messages, secret, { now: NOW });
  assert.equal(made.ok, true);
  const hash = fragmentOf(made.link);
  assert.ok(!hash.includes('.'), 'no key part in the link');
  assert.equal(needsPassphrase(hash), true);
  const parsed = parseShareFragment(hash);
  assert.equal(parsed.salt.length, 16);
  assert.equal(parsed.key, null);
  await assert.rejects(openShareFragment(hash), code('needs_passphrase'));
  await assert.rejects(openShareFragment(hash, 'sample passphrasE'), code('wrong_passphrase'));
  await assert.rejects(openShareFragment(hash, 'wrong one entirely'), code('wrong_passphrase'));
  const chat = await openShareFragment(hash, 'sample passphrase');
  assert.deepEqual(chat.messages, messages);
  assert.equal(chat.title, 'Locked');
});

test('two passphrase links with the same passphrase use different salts', async () => {
  const a = parseShareFragment(fragmentOf((await createShareLink(ORIGIN, 't', messagesFrom([turn('a', 'b')]), await newShareSecret('same passphrase'))).link));
  const b = parseShareFragment(fragmentOf((await createShareLink(ORIGIN, 't', messagesFrom([turn('a', 'b')]), await newShareSecret('same passphrase'))).link));
  assert.notDeepEqual(a.salt, b.salt);
});

test('short passphrases are refused', async () => {
  assert.notEqual(checkPassphrase('short'), null);
  assert.equal(checkPassphrase('long enough'), null);
  await assert.rejects(newShareSecret('1234567'));
});

// ---- tampering --------------------------------------------------------------------------------------------------

test('changing any character of the link makes it fail to open, never open differently', async () => {
  const messages = messagesFrom([turn('Is this intact?', 'Yes, if it opens.')]);
  const made = await createShareLink(ORIGIN, 't', messages, await newShareSecret(null), { now: NOW });
  const hash = fragmentOf(made.link).slice(1);
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  await fc.assert(
    fc.asyncProperty(fc.nat(hash.length - 1), fc.constantFrom(...ALPHABET.split('')), async (at, c) => {
      fc.pre(hash[at] !== '.' && hash[at] !== c);
      const changed = hash.slice(0, at) + c + hash.slice(at + 1);
      await assert.rejects(openShareFragment(changed), (e) => e instanceof ShareLinkError && (e.code === 'garbled' || e.code === 'version'));
    }),
    { numRuns: 150 },
  );
  // Every change to the last character of each part, where base64 can hide unused bits, is caught too.
  const [payload, key] = hash.split('.');
  for (const c of ALPHABET) {
    if (c !== payload.at(-1)) await assert.rejects(openShareFragment(`${payload.slice(0, -1)}${c}.${key}`), (e) => e instanceof ShareLinkError);
    if (c !== key.at(-1)) await assert.rejects(openShareFragment(`${payload}.${key.slice(0, -1)}${c}`), (e) => e instanceof ShareLinkError);
  }
});

test('cut, garbled, empty and swapped links each fail with a clear reason', async () => {
  const keyed = fragmentOf((await createShareLink(ORIGIN, 't', messagesFrom([turn('a', 'b')]), await newShareSecret(null))).link);
  const [payload, key] = keyed.slice(1).split('.');
  await assert.rejects(openShareFragment(''), code('empty'));
  await assert.rejects(openShareFragment('#'), code('empty'));
  await assert.rejects(openShareFragment(payload), code('garbled'), 'key cut off');
  await assert.rejects(openShareFragment(`${payload}.${key.slice(0, 20)}`), code('garbled'), 'key cut short');
  await assert.rejects(openShareFragment(`${payload.slice(0, -10)}.${key}`), code('garbled'), 'payload cut short');
  await assert.rejects(openShareFragment(`${payload}.${key}.extra`), code('garbled'));
  await assert.rejects(openShareFragment('not a link at all!'), code('garbled'));
  await assert.rejects(openShareFragment(`k=${SAMPLE_KEY}`), code('garbled'), 'a ticket fragment is not a share');
  // A key from another link does not open this one.
  const other = fragmentOf((await createShareLink(ORIGIN, 't', messagesFrom([turn('a', 'b')]), await newShareSecret(null))).link).split('.')[1];
  await assert.rejects(openShareFragment(`${payload}.${other}`), code('garbled'));
  // Flipping the mode byte to "passphrase" is caught, not treated as a passphrase link that opens.
  const bytes = fromBase64Url(payload);
  bytes[1] = 1;
  await assert.rejects(openShareFragment(toBase64Url(bytes)), (e) => e instanceof ShareLinkError && ['garbled', 'needs_passphrase'].includes(e.code));
  await assert.rejects(openShareFragment(toBase64Url(bytes), 'any passphrase'), code('wrong_passphrase'));
});

test('a newer version says so instead of calling the link damaged', async () => {
  const keyed = fragmentOf((await createShareLink(ORIGIN, 't', messagesFrom([turn('a', 'b')]), await newShareSecret(null))).link).slice(1);
  const [payload, key] = keyed.split('.');
  const bytes = fromBase64Url(payload);
  bytes[0] = 2;
  await assert.rejects(openShareFragment(`${toBase64Url(bytes)}.${key}`), code('version'));
  bytes[0] = 0;
  await assert.rejects(openShareFragment(`${toBase64Url(bytes)}.${key}`), code('garbled'));
});

// ---- size -------------------------------------------------------------------------------------------------------

test('a chat too long for one link offers the most recent part that fits', async () => {
  // Random-ish text compresses poorly, so a few dozen long turns go over the cap.
  const noise = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789 '[b % 37]).join('');
  const turns = Array.from({ length: 60 }, (_, i) => turn(`question ${i} ${noise(400)}`, `answer ${i} ${noise(1200)}`));
  const messages = messagesFrom(turns);
  const secret = await newShareSecret(null);
  const made = await createShareLink(ORIGIN, 'Long', messages, secret);
  assert.equal(made.ok, false);
  assert.equal(made.reason, 'too_long');
  assert.ok(made.fitsFrom > 0);
  assert.equal(messages[made.fitsFrom].role, 'user', 'the shorter link starts on a message from the person');
  const recent = await createShareLink(ORIGIN, 'Long', messages.slice(made.fitsFrom), secret);
  assert.equal(recent.ok, true);
  assert.ok(recent.link.length <= SHARE_LINK_MAX);
  // One more exchange would not have fit.
  const more = await createShareLink(ORIGIN, 'Long', messages.slice(made.fitsFrom - 2), secret);
  assert.equal(more.ok, false);
  const opened = await openShareFragment(fragmentOf(recent.link));
  assert.equal(opened.messages.at(-1).text, messages.at(-1).text);
});

test('a single exchange too long for a link is refused, not cut', async () => {
  const secret = await newShareSecret(null);
  const made = await createShareLink(ORIGIN, 't', messagesFrom([turn('q', 'z'.repeat(5000))]), secret, { max: 200 });
  assert.deepEqual(made, { ok: false, reason: 'too_long', fitsFrom: null });
  assert.deepEqual(await createShareLink(ORIGIN, 't', [], secret), { ok: false, reason: 'empty' });
});

test('a document that unpacks to something huge is refused', async () => {
  // Built by hand: a valid seal around a deflate bomb (a few KB that unpack to many MB).
  const { compress } = await import('../lib/anonymo/share.ts');
  const secret = await newShareSecret(null);
  const huge = new TextEncoder().encode(`{"v":1,"title":"t","createdAt":"x","messages":[{"role":"user","text":"${'a'.repeat(6_000_000)}"}]}`);
  const packedBytes = await compress(huge);
  const header = new Uint8Array([1, 0]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, secret.key, packedBytes));
  const all = new Uint8Array(header.length + iv.length + sealed.length);
  all.set(header);
  all.set(iv, 2);
  all.set(sealed, 14);
  await assert.rejects(openShareFragment(`${toBase64Url(all)}.${toBase64Url(secret.raw)}`), code('garbled'));
});

// ---- what goes in -----------------------------------------------------------------------------------------------

test('only text, role, model and character name ever go in', async () => {
  const MARK = 'FORBIDDEN-VALUE';
  const turns = [
    turn('Read my PDF', 'Done.', {
      attachment: `${MARK}-attachment.pdf`,
      receiptId: `${MARK}-receipt`,
      receipt: { id: `${MARK}-receipt`, signature: MARK, cost_usd: '0.01' },
      council: { replies: [MARK] },
      memoryCharge: { usd: MARK },
      key: SAMPLE_KEY,
      apiKey: SAMPLE_KEY,
      balance: MARK,
      memory: [MARK],
      vault: MARK,
      images: [`data:image/png;base64,${MARK}`],
      error: MARK,
      needsFunds: true,
      crisis: true,
      aiReminder: true,
    }),
    turn(`${MARK} streaming`, `${MARK} partial`, { status: 'streaming' }),
    turn(`${MARK} failed`, '', { status: 'error', error: MARK }),
  ];
  const messages = messagesFrom(turns);
  assert.equal(messages.length, 2, 'unfinished and failed turns are left out');
  for (const m of messages) assert.deepEqual(Object.keys(m).filter((k) => !['role', 'text', 'model', 'name'].includes(k)), []);
  // Even extra fields on message objects passed in directly are dropped.
  const made = await createShareLink(ORIGIN, 't', [...messages, { role: 'assistant', text: 'x', key: SAMPLE_KEY, receipt: MARK }], await newShareSecret(null));
  const chat = await openShareFragment(fragmentOf(made.link));
  const text = JSON.stringify(chat);
  assert.ok(!text.includes(MARK));
  assert.ok(!text.includes(SAMPLE_KEY));
  assert.deepEqual(Object.keys(chat).sort(), ['createdAt', 'messages', 'title', 'v']);
  for (const m of chat.messages) assert.ok(Object.keys(m).every((k) => ['role', 'text', 'model', 'name'].includes(k)));
});

test('the viewer keeps only allowed fields of what it opens', async () => {
  const { readChat } = await import('../lib/anonymo/share.ts');
  const chat = readChat({ v: 1, title: 't', createdAt: 'c', extra: 1, messages: [{ role: 'user', text: 'a', html: '<b>', key: SAMPLE_KEY }] });
  assert.deepEqual(chat, { v: 1, title: 't', createdAt: 'c', messages: [{ role: 'user', text: 'a' }] });
  assert.throws(() => readChat({ v: 1, title: 't', createdAt: 'c', messages: [{ role: 'system', text: 'a' }] }), code('garbled'));
  assert.throws(() => readChat({ v: 2, title: 't', createdAt: 'c', messages: [] }), code('version'));
  assert.throws(() => readChat([]), code('garbled'));
});

test('titles come from the first question', () => {
  assert.equal(titleFor([turn('  What   is a good name? ', 'x')]), 'What is a good name?');
  assert.equal(titleFor([]), 'A shared chat');
  assert.ok(titleFor([turn('w'.repeat(200), 'x')]).length <= 61);
});

// ---- the switch and the page ------------------------------------------------------------------------------------

test('share ships switched off, and demo mode shows it', () => {
  assert.ok(UPDATE_IDS.includes('share'));
  assert.ok(!RELEASED.has('share'));
  assert.equal(updateOn('share', true), true);
});

test('the share page reads the fragment only, sends nothing, and is not indexed', () => {
  const root = new URL('..', import.meta.url);
  const page = readFileSync(new URL('app/s/page.tsx', root), 'utf8');
  assert.match(page, /robots:\s*\{\s*index:\s*false/);
  const viewer = readFileSync(new URL('components/share-view.tsx', root), 'utf8');
  assert.doesNotMatch(viewer, /fetch\(|sendBeacon|XMLHttpRequest|WebSocket|localStorage|indexedDB|console\./);
  assert.doesNotMatch(viewer, /location\.(href|search)|document\.URL/);
  assert.doesNotMatch(viewer, /saveChat|openChat|setTurns/, 'a shared chat is never imported into the viewer’s chats');
  const dialog = readFileSync(new URL('components/dashboard/share-chat.tsx', root), 'utf8');
  assert.doesNotMatch(dialog, /fetch\(|sendBeacon|client\./);
  assert.match(dialog, /[Ii]mages and attachments are left out/);
});
