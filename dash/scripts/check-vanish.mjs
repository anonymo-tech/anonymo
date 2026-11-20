import assert from 'node:assert/strict';
import test from 'node:test';
import { chatsStore } from '../lib/anonymo/history.ts';
import { demoExpiringChat } from '../lib/anonymo/vanish-demo.ts';
import { loadVanishPrefs, setVanishPrefs } from '../lib/anonymo/vanish-prefs.ts';
import { MINUTE_MS, NEUTRAL_PAGE, chatTiming, expiresAfter, neutralUrl, panicSequence, readVanishPrefs, savedExpiry, sweepExpired, timeLeft } from '../lib/anonymo/vanish.ts';

const hour = 60 * MINUTE_MS;
const now = Date.parse('2026-11-20T12:00:00Z');

function mockStorage(t) {
  const values = new Map();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
    chatsStore(false).changed();
    chatsStore(true).changed();
  });
  return storage;
}

test('expiry uses the last message timestamp and stores a single deadline', () => {
  const updatedAt = new Date(now).toISOString();
  for (const [choice, duration] of [['hour', hour], ['day', 24 * hour], ['week', 168 * hour]]) {
    const expiresAt = expiresAfter(updatedAt, choice);
    assert.equal(expiresAt, now + duration);
    assert.equal(savedExpiry({ updatedAt, expiresAt }), choice);
  }
  assert.equal(expiresAfter(updatedAt, 'never'), undefined);
  assert.equal(expiresAfter('invalid', 'hour'), undefined);
  assert.equal(savedExpiry({ updatedAt }), 'never');
  assert.equal(timeLeft(now + 2 * MINUTE_MS, now), '2 min left');
  assert.equal(timeLeft(now, now), 'Due now');
});

// Saved chats now go through the vault's storage (IndexedDB, encrypted when the vault is on), which only runs in a
// browser. These tests cover the rules history.ts applies on every read and write: the sweep and the deadlines.
test('sweeping removes only chats whose deadline has passed', () => {
  const expired = { ...demoExpiringChat(now), id: 'expired', expiresAt: now - 1 };
  const due = { ...expired, id: 'due', expiresAt: now };
  const future = { ...expired, id: 'future', expiresAt: now + 1 };
  const { expiresAt, ...never } = { ...expired, id: 'never' };
  assert.deepEqual(sweepExpired([expired, due, future, never], now), [future, never]);
});

test('new chats default to never, and only a new message renews their chosen deadline', (t) => {
  mockStorage(t);
  const [turn] = demoExpiringChat(now).turns;
  assert.deepEqual(loadVanishPrefs(), { defaultExpiry: 'never', panicOn: true, neutralPage: NEUTRAL_PAGE, wipeOnPanic: false });
  assert.equal('expiresAt' in chatTiming(undefined, turn, now, null), false);
  assert.equal('expiresAt' in chatTiming(undefined, turn, now, 'never'), false);
  assert.equal(setVanishPrefs({ defaultExpiry: 'hour' }), true);
  assert.equal(loadVanishPrefs().defaultExpiry, 'hour');

  const first = { id: 'new', title: 't', createdAt: new Date(now).toISOString(), model: 'anonymo-1', turns: [turn], ...chatTiming(undefined, turn, now, 'hour') };
  assert.equal(first.expiresAt, now + hour);
  // The same message saved again (a receipt arriving) keeps the deadline.
  assert.equal(chatTiming(first, { ...turn, receiptId: 'sample-receipt' }, now + MINUTE_MS, 'hour').expiresAt, first.expiresAt);
  // A new message restarts the chat's own deadline, not the default.
  const daily = { ...first, expiresAt: expiresAfter(first.updatedAt, 'day') };
  assert.equal(chatTiming(daily, { ...turn, id: 'next' }, now + MINUTE_MS, 'hour').expiresAt, now + MINUTE_MS + 24 * hour);
  const { expiresAt, ...forever } = daily;
  assert.equal('expiresAt' in chatTiming(forever, { ...turn, id: 'later' }, now + 2 * MINUTE_MS, 'hour'), false);
});

test('the demo chat is about to disappear, with readable content', () => {
  const chat = demoExpiringChat(now);
  assert.equal(chat.expiresAt, now + 2 * MINUTE_MS);
  assert.ok(chat.turns[0].content);
  assert.equal(sweepExpired([chat], now + 2 * MINUTE_MS).length, 0);
});

test('panic needs three distinct Escape presses within 1.5 seconds', () => {
  const { press, reset } = panicSequence();
  const esc = { key: 'Escape' };
  assert.equal(press(esc, 0), false);
  assert.equal(press({ ...esc, repeat: true }, 300), false);
  assert.equal(press(esc, 1000), false);
  assert.equal(press(esc, 1500), true);
  assert.equal(press(esc, 2000), false);
  assert.equal(press(esc, 2750), false);
  assert.equal(press(esc, 3501), false);
  assert.equal(press({ key: 'Tab' }, 3600), false);
  assert.equal(press(esc, 3700), false);
  reset();
  assert.equal(press(esc, 3800), false);
  assert.equal(press(esc, 3900), false);
  assert.equal(press(esc, 4000), true);
});

test('an IME Escape never counts or completes a partial panic sequence', () => {
  const { press } = panicSequence();
  const esc = { key: 'Escape' };
  assert.equal(press(esc, 0), false);
  assert.equal(press(esc, 50), false);
  assert.equal(press({ ...esc, isComposing: true }, 100), false);
  assert.equal(press(esc, 150), false);
  assert.equal(press(esc, 200), false);
  assert.equal(press(esc, 250), true);
});

test('neutral destinations accept only absolute HTTPS URLs without credentials', () => {
  assert.equal(neutralUrl('  HTTPS://example.org/reading  '), 'https://example.org/reading');
  for (const bad of ['http://example.org', 'javascript:alert(1)', 'data:text/html,hi', '//example.org', 'https:example.org', 'https://', 'https://sample-user@example.org']) {
    assert.equal(neutralUrl(bad), null);
  }
  assert.deepEqual(readVanishPrefs({ panicOn: false, neutralPage: 'file:///sample', wipeOnPanic: true, defaultExpiry: 'invalid' }), {
    panicOn: false, neutralPage: NEUTRAL_PAGE, wipeOnPanic: true, defaultExpiry: 'never',
  });
});
