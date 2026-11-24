import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { watchAutoLock } from '../lib/anonymo/vault-browser.ts';
import { aboutYouSlot, createVault, historySlot, VaultLocked } from '../lib/anonymo/vault.ts';
import {
  createVaultKey, decryptRecord, encryptRecord, unlockVaultKey, VAULT_ITERATIONS, WrongPassphrase,
} from '../lib/anonymo/vault-crypto.ts';

Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
const utf8 = new TextEncoder();
const decoder = new TextDecoder();
const turn = { id: 'sample-turn', prompt: 'Device-only sample prompt', content: 'Device-only sample reply' };
const chat = { id: 'sample-chat', title: 'Device-only sample title', turns: [turn], expiresAt: '2026-12-20T00:00:00Z' };
const demoChat = { ...chat, id: 'sample-demo-chat' };
const liveImage = 'image:live:sample-image';
const demoImage = 'image:demo:sample-image';
const png = utf8.encode('Device-only sample image bytes').buffer;
const first = 'sample-passphrase one';
const second = 'sample-passphrase two';

function storage() {
  const data = new Map();
  const legacy = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
  const records = new Map();
  let failCommit = false;
  const disk = {
    async get(key) { return structuredClone(records.get(key)); },
    async entries(prefix) {
      return [...records].filter(([key]) => key.startsWith(prefix)).map((entry) => structuredClone(entry));
    },
    async commit(puts, deletes = []) {
      if (failCommit && puts.some(([key, value]) => key === 'config' && value)) throw new Error('Storage full');
      for (const key of deletes) records.delete(key);
      for (const [key, value] of puts) records.set(key, structuredClone(value));
    },
    async clear() { records.clear(); },
  };
  let queue = Promise.resolve();
  const spawn = () => createVault({
    disk,
    legacy: () => legacy,
    exclusive: (operation) => {
      const next = queue.then(operation);
      queue = next.catch(() => {});
      return next;
    },
  });
  return { data, disk, legacy, records, spawn, rejectEncryptedCommit: (value) => { failCommit = value; } };
}

test('WebCrypto authenticates payloads and their record identifiers and uses fresh salt and IVs', async () => {
  assert.ok(VAULT_ITERATIONS >= 600_000);
  const { config, key } = await createVaultKey(first);
  assert.equal(config.salt.byteLength, 16);
  assert.equal(key.extractable, false);
  await assert.rejects(() => unlockVaultKey('wrong', config), WrongPassphrase);
  const unlocked = await unlockVaultKey(first, config);
  const bytes = utf8.encode('Device-only sample payload');
  const records = await Promise.all(Array.from({ length: 32 }, () => encryptRecord(key, 'record-a', bytes)));
  assert.equal(new Set([config.check, ...records].map(({ iv }) => Buffer.from(iv).toString('hex'))).size, 33);
  assert.ok(records.every(({ iv }) => iv.byteLength === 12));
  assert.equal(decoder.decode(await decryptRecord(unlocked, 'record-a', records[0])), decoder.decode(bytes));
  await assert.rejects(() => decryptRecord(unlocked, 'record-b', records[0]));
  const tampered = new Uint8Array(records[0].ciphertext.slice(0));
  tampered[0] ^= 1;
  await assert.rejects(() => decryptRecord(unlocked, 'record-a', { ...records[0], ciphertext: tampered.buffer }));
});

test('migration, reload, lock, change passphrase and disabling round-trip both namespaces', async () => {
  const { data, disk, legacy, records, spawn } = storage();
  const vault = spawn();
  legacy.setItem(historySlot(false), JSON.stringify([chat]));
  legacy.setItem(historySlot(true), JSON.stringify([demoChat]));
  await vault.saveImages([[liveImage, png], [demoImage, png]]);
  await vault.enable(first);

  assert.equal(vault.state().mode, 'unlocked');
  assert.equal(data.size, 0);
  const originalConfig = await disk.get('config');
  const originalImage = await disk.get(liveImage);
  assert.deepEqual(Object.keys(originalConfig).sort(), ['check', 'salt']);
  const ciphertexts = [...records].flatMap(([id, value]) => id === 'config' ? [value.check] : value);
  for (const ciphertext of ciphertexts) {
    assert.deepEqual(Object.keys(ciphertext).sort(), ['ciphertext', 'iv']);
    assert.doesNotMatch(decoder.decode(ciphertext.ciphertext), /Device-only sample/);
  }
  assert.equal(new Set(ciphertexts.map(({ iv }) => Buffer.from(iv).toString('hex'))).size, ciphertexts.length);
  assert.deepEqual(vault.snapshotChats(false), [chat]);
  assert.deepEqual(vault.snapshotChats(true), [demoChat]);

  const reloaded = spawn();
  await reloaded.refresh();
  assert.equal(reloaded.state().mode, 'locked');
  assert.deepEqual(reloaded.snapshotChats(false), []);
  await assert.rejects(() => reloaded.images(false), VaultLocked);
  await assert.rejects(() => reloaded.updateChats(false, () => [chat]), VaultLocked);
  await assert.rejects(() => reloaded.saveImages([[liveImage, png]]), VaultLocked);
  await assert.rejects(() => reloaded.unlock('wrong'), WrongPassphrase);
  await reloaded.unlock(first);
  assert.deepEqual(await reloaded.images(false), [[liveImage, png]]);
  assert.deepEqual(await reloaded.images(true), [[demoImage, png]]);
  await reloaded.changePassphrase(first, second);
  assert.notDeepEqual((await disk.get('config')).salt, originalConfig.salt);
  assert.notDeepEqual((await disk.get(liveImage)).ciphertext, originalImage.ciphertext);
  await vault.refresh();
  assert.equal(vault.state().mode, 'locked');
  reloaded.lock();
  await assert.rejects(() => reloaded.unlock(first), WrongPassphrase);
  await assert.rejects(() => reloaded.disable(first), WrongPassphrase);
  await reloaded.unlock(second);
  assert.deepEqual(reloaded.snapshotChats(false), [chat]);
  await reloaded.disable(second);

  assert.equal(await disk.get('config'), null);
  const off = spawn();
  await off.refresh();
  assert.equal(off.state().mode, 'off');
  assert.deepEqual(off.snapshotChats(false), [chat]);
  assert.deepEqual(off.snapshotChats(true), [demoChat]);
  assert.deepEqual(await off.images(false), [[liveImage, png]]);
  assert.deepEqual(await off.images(true), [[demoImage, png]]);
  assert.match(decoder.decode((await disk.get(historySlot(false)))[0]), /Device-only sample prompt/);
  assert.deepEqual(await disk.get(liveImage), png);
});

test('About you shares vault encryption, is hidden when locked, and is wiped in both namespaces', async () => {
  const { disk, spawn } = storage();
  const profile = { aboutMe: 'Device-only sample profile', answerStyle: '', enabled: true, facts: [] };
  const vault = spawn();
  await vault.updateAboutYou(false, () => profile);
  await vault.updateAboutYou(true, () => ({ ...profile, aboutMe: 'Demo sample profile' }));
  assert.match(decoder.decode((await disk.get(aboutYouSlot(false)))[0]), /Device-only sample profile/);
  await vault.enable(first);
  const [encrypted] = await disk.get(aboutYouSlot(false));
  assert.ok(encrypted.ciphertext instanceof ArrayBuffer);
  assert.doesNotMatch(decoder.decode(encrypted.ciphertext), /Device-only sample profile/);
  const reloaded = spawn();
  await reloaded.refresh();
  assert.equal(reloaded.state().mode, 'locked');
  assert.equal(reloaded.snapshotAboutYou(false), undefined);
  await assert.rejects(() => reloaded.updateAboutYou(false, () => profile), VaultLocked);
  await reloaded.unlock(first);
  assert.deepEqual(reloaded.snapshotAboutYou(false), profile);
  assert.equal(reloaded.snapshotAboutYou(true).aboutMe, 'Demo sample profile');
  await reloaded.wipe(() => 0);
  for (const demo of [false, true]) {
    assert.equal(reloaded.snapshotAboutYou(demo), undefined);
    assert.equal(await disk.get(aboutYouSlot(demo)), undefined);
  }
});

test('failed encryption can be retried after migration and does not strand or drop records', async () => {
  const { legacy, disk, spawn, rejectEncryptedCommit } = storage();
  const vault = spawn();
  legacy.setItem(historySlot(false), JSON.stringify([chat]));
  await vault.saveImages([[liveImage, png]]);
  rejectEncryptedCommit(true);
  await assert.rejects(() => vault.enable(first), /Storage full/);
  await vault.refresh();
  assert.equal(vault.state().mode, 'off');
  assert.equal(await disk.get('config'), null);
  assert.deepEqual(vault.snapshotChats(false), [chat]);
  assert.deepEqual(await vault.images(false), [[liveImage, png]]);
  rejectEncryptedCommit(false);
  await vault.enable(first);
  await vault.updateChats(false, (list) => [...list, { ...chat, id: 'other-chat' }]);
  assert.equal(vault.snapshotChats(false).length, 2);
  await vault.deleteImages('image:live:', liveImage);
  assert.deepEqual(await vault.images(false), []);
  vault.lock();
  assert.deepEqual(vault.snapshotChats(false), []);
});

test('device wipe works while locked and removes the key check, images and chats', async () => {
  const { records, data, spawn } = storage();
  const vault = spawn();
  await vault.updateChats(false, () => [chat]);
  await vault.saveImages([[liveImage, png], [demoImage, png]]);
  await vault.enable(first);
  vault.lock();
  data.set('anonymo.vault.lock-hidden.v1', 'off');
  await vault.wipe(() => { data.clear(); return 1; });
  assert.equal(data.size, 0);
  assert.equal(records.size, 0);
  assert.equal(vault.state().mode, 'off');
  assert.deepEqual(await vault.images(true), []);
  assert.deepEqual(vault.snapshotChats(false), []);
});


test('input resets idle time and the hidden-tab timer honors its setting', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const windowEvents = new EventTarget();
  const documentState = Object.assign(new EventTarget(), { hidden: false });
  let mode = 'locked';
  let hiddenEnabled = true;
  let notify;
  const setMode = (next) => { mode = next; notify(); };
  const reschedule = watchAutoLock({
    state: () => ({ mode }),
    subscribe: (listener) => { notify = listener; },
    lock: () => setMode('locked'),
  }, windowEvents, documentState, () => hiddenEnabled);

  setMode('unlocked');
  t.mock.timers.tick(14 * 60_000);
  windowEvents.dispatchEvent(new Event('keydown'));
  t.mock.timers.tick(60_000);
  assert.equal(mode, 'unlocked');
  t.mock.timers.tick(14 * 60_000);
  assert.equal(mode, 'locked');

  setMode('unlocked');
  documentState.hidden = true;
  documentState.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(5 * 60_000 - 1);
  assert.equal(mode, 'unlocked');
  t.mock.timers.tick(1);
  assert.equal(mode, 'locked');

  hiddenEnabled = false;
  setMode('unlocked');
  t.mock.timers.tick(6 * 60_000);
  assert.equal(mode, 'unlocked');
  hiddenEnabled = true;
  reschedule();
  assert.equal(mode, 'locked');
});

test('locking during a queued clear never retains opted-out chats', async () => {
  const { spawn, disk } = storage();
  const vault = spawn();
  await vault.updateChats(false, () => [chat]);
  await vault.enable(first);
  const clear = vault.clearChats();
  vault.lock();
  await clear;
  assert.equal(vault.state().mode, 'locked');
  assert.equal(await disk.get(historySlot(false)), undefined);
  await vault.unlock(first);
  assert.deepEqual(vault.snapshotChats(false), []);
});


test('locking while history is being read cancels the read before decrypting or writing', async () => {
  const { spawn, disk } = storage();
  const vault = spawn();
  await vault.updateChats(false, () => [chat]);
  await vault.enable(first);
  const get = disk.get;
  let reading;
  let resume;
  const started = new Promise((resolve) => { reading = resolve; });
  const released = new Promise((resolve) => { resume = resolve; });
  disk.get = async (slot) => {
    if (slot !== historySlot(false)) return get(slot);
    reading();
    await released;
    // Any attempt to decrypt this value would fail before reaching the epoch check.
    return [{ iv: new Uint8Array(12), ciphertext: new ArrayBuffer(16) }];
  };
  const write = vault.updateChats(false, () => assert.fail('Locked history must not reach the update callback'));
  await started;
  vault.lock();
  resume();
  await assert.rejects(write, VaultLocked);
  assert.deepEqual(vault.snapshotChats(false), []);
});
