import assert from 'node:assert/strict';
import test from 'node:test';
import { characterDestination, setupHref, setupReturn, storyDestination } from '../lib/anonymo/setup-return.ts';
import { dashboardSignup } from '../lib/anonymo/dashboard-signup.ts';
import { wipeDevice } from '../lib/anonymo/device-store.ts';
import { workspaceStage } from '../lib/anonymo/workspace-guide.ts';
import { chatSetupStep, clearSetupDraft, readSetupDraft, writeSetupDraft } from '../lib/anonymo/chat-setup.ts';
import { parseUsdAtto } from '../lib/anonymo/pricetag.ts';

test('overview offers chat to connected keys regardless of prepaid credit', () => {
  assert.equal(workspaceStage(false, false), 'key');
  assert.equal(workspaceStage(false, true), 'key');
  assert.equal(workspaceStage(true, false), 'first-chat');
  assert.equal(workspaceStage(true, true), 'returning');
});

test('send asks for a key first and only asks for funds when credit is known to be too low', () => {
  const price = parseUsdAtto('0.00005');
  assert.equal(chatSetupStep(false, undefined), 'key');
  assert.equal(chatSetupStep(false, 0), 'key');
  assert.equal(chatSetupStep(true, 0), 'funds');
  assert.equal(chatSetupStep(true, 0.000000000001, price), 'funds');
  assert.equal(chatSetupStep(true, 0.00004, price), 'funds');
  assert.equal(chatSetupStep(true, 0.00005, price), null);
  assert.equal(chatSetupStep(true, 0.00006, price), null);
  assert.equal(chatSetupStep(true, 0.00004), null);
  assert.equal(chatSetupStep(true, undefined, price), null);
  assert.equal(chatSetupStep(true, NaN, price), null);
});

test('the setup slot keeps only text in the supplied tab storage and matches the chat destination and mode', () => {
  const rows = new Map();
  const storage = {
    getItem: (key) => rows.get(key) ?? null,
    setItem: (key, value) => rows.set(key, value),
    removeItem: (key) => rows.delete(key),
  };
  const main = { destination: '/dashboard/chat', demo: false };
  const character = { destination: characterDestination('chat', '0123456789abcdef'), demo: false };
  const demo = { ...character, demo: true };
  const text = '  A first line.\nAnother line.  ';
  assert.equal(writeSetupDraft(storage, { ...character, attachment: 'sample.pdf' }, text), true);
  assert.deepEqual([...rows.values()].map(JSON.parse), [{ ...character, text }]);
  assert.equal(readSetupDraft(storage, main), null);
  assert.equal(readSetupDraft(storage, demo), null);
  clearSetupDraft(storage, main);
  assert.equal(readSetupDraft(storage, character), text);
  assert.equal(writeSetupDraft(storage, character, '  '), true);
  assert.equal(readSetupDraft(storage, character), null);
  assert.equal(writeSetupDraft(storage, character, text), true);
  clearSetupDraft(storage, character);
  assert.equal(rows.size, 0);
  assert.equal(writeSetupDraft(null, main, text), false);
  assert.equal(readSetupDraft(null, main), null);
  const blocked = new Proxy({}, { get() { throw new Error('storage unavailable'); } });
  assert.equal(writeSetupDraft(blocked, main, text), false);
  assert.equal(readSetupDraft(blocked, main), null);
  assert.doesNotThrow(() => clearSetupDraft(blocked, main));
});

test('setup retains only supported tools and opaque workspace IDs across the key and funds pages', () => {
  const id = '0123456789abcdef';
  const book = 'feb69e78-08ed-4462-b0d7-50de9174a963';
  const chapter = '33b8856c-e16d-4564-a30b-fa3b058733b1';
  for (const [href, label] of [
    [characterDestination('chat', id), 'character chat'], [characterDestination('call', id), 'Night Call'],
    [characterDestination('characters', id), 'Character studio'], [characterDestination('move-in', id), 'Move in'], [storyDestination(book, chapter), 'Story Studio'],
    ['/dashboard/images', 'Image studio'], ['/dashboard/video', 'Video studio'], ['/dashboard/side-by-side', 'Side by side'],
    ['/dashboard/move-in', 'Move in'], ['/dashboard/ventures/v_0123456789abcdef01234567', 'venture board'],
    ['/dashboard/presets', 'frontend presets'], ['/dashboard/usage', 'Usage & limits'],
  ]) {
    for (const step of ['key', 'funds']) {
      const location = new URL(setupHref(step, href), 'https://workspace.example');
      assert.equal(location.pathname, `/dashboard/${step}`);
      assert.deepEqual(setupReturn(location.searchParams.get('returnTo')), { href, label, needsCredit: !['frontend presets', 'Usage & limits', 'venture board'].includes(label) });
    }
  }
  assert.equal(characterDestination('chat', 'sample display name'), '/dashboard/chat');
  assert.equal(storyDestination('sample-story', 'sample-chapter-one'), '/dashboard/story?story=sample-story&chapter=sample-chapter-one');
});

test('unknown paths, URL schemes, freeform values and unexpected query parameters never become a setup destination', () => {
  for (const value of [null, '', '/dashboard/key', '//workspace.example/dashboard/chat', 'https://workspace.example/dashboard/chat',
    '/dashboard/images/../chat', '/dashboard/chat#fragment', '/dashboard/chat?prompt=sample', '/dashboard/chat?character=0123456789abcdef&draft=private',
    '/dashboard/chat?character=sample', '/dashboard/chat?character=0123456789abcdef?', '/dashboard/chat?character=%30', '/dashboard/story?story=sample-story&chapter=private',
    '/dashboard/ventures/v_freeform', '/dashboard/images\\anything', '/dashboard/funds?returnTo=/dashboard/chat']) {
    assert.equal(setupReturn(value), null);
    assert.equal(setupHref('funds', value), '/dashboard/funds');
    assert.equal(setupHref('key', value), '/dashboard/key');
  }
});


test('dashboard signup remains stable over key mints and resets with Wipe, including when storage is unavailable', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const rows = new Map();
  const storage = {
    get length() { return rows.size; }, key: i => [...rows.keys()][i], getItem: key => rows.get(key) ?? null,
    setItem: (key, value) => rows.set(key, value), removeItem: key => rows.delete(key),
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    const [first, second] = await Promise.all([dashboardSignup(false), dashboardSignup(false)]);
    assert.equal(second, first);
    assert.match(first, /^[a-f0-9-]{14}4[a-f0-9-]{4}[89ab][a-f0-9-]{16}$/);
    assert.notEqual(await dashboardSignup(true), first);
    void wipeDevice([storage]);
    assert.notEqual(await dashboardSignup(false), first);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('storage unavailable'); } });
    const temporary = await dashboardSignup(false);
    assert.equal(await dashboardSignup(false), temporary);
    void wipeDevice([storage]);
    assert.notEqual(await dashboardSignup(false), temporary);
  } finally {
    void wipeDevice([storage]);
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});
