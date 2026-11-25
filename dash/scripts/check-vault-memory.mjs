import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { memorySlot, VaultLocked } from '../lib/anonymo/vault.ts';
import { vault } from '../lib/anonymo/vault-browser.ts';
import { vaultDisk } from '../lib/anonymo/vault-db.ts';
import { ensureMemorySecret, forgetMemorySecret, readMemorySecret } from '../lib/anonymo/memory-secret.ts';
import { emptyMemory, memorySize, parseMemoryProposals, prepareSuggestions, saveSuggestions } from '../lib/anonymo/memory.ts';
import { vaultWriterModel } from '../lib/anonymo/memory-request.ts';
import { getMemory, usesVaultMemoryStore } from '../lib/anonymo/memory-store.ts';
import { parseUpdates, updateOn } from '../lib/anonymo/updates.ts';
import {
  answerPairing, blobWins, exportRecovery, importRecovery, memoryKeys, newPairing, openItem, sealItem,
} from '../lib/anonymo/vault-memory/crypto.ts';
import { ASSISTANT, recall, scopeOf } from '../lib/anonymo/vault-memory/items.ts';
import {
  bringVaultMemory, currentVaultMemory, editVaultCharacter, loadVaultMemory, syncVaultMemory, updateMemoryItem, vaultCharacter, wipeVaultMemory,
} from '../lib/anonymo/vault-memory/store.ts';
import { memoryTransport } from '../lib/anonymo/vault-memory/sync.ts';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const start = '2026-03-01T00:00:00Z';
const memory = (text, traits = {}) => ({
  id: crypto.randomUUID(), characterId: null, kind: 'fact', text, createdAt: start, weight: 1, ...traits,
});

test('Vault Memory is opt-in for live and visible in demo', () => {
  assert.equal(parseUpdates().has('vaultsync'), false);
  assert.equal(parseUpdates('history,vaultsync').has('vaultsync'), true);
  assert.equal(updateOn('vaultsync', true), true);
});

test('AES-GCM uses fresh nonces and authenticates the item, version and vault', async () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const keys = await memoryKeys(secret);
  const peer = await memoryKeys(secret.slice());
  const wrong = await memoryKeys(crypto.getRandomValues(new Uint8Array(32)));
  const item = memory('Repairs radios.');
  const first = await sealItem(keys, item, 1);
  const second = await sealItem(keys, item, 1);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.deepEqual(await openItem(peer, first), item);
  await assert.rejects(openItem(wrong, first));
  await assert.rejects(openItem(keys, { ...first, id: crypto.randomUUID() }));
  await assert.rejects(openItem(keys, { ...first, version: 2 }));
  await assert.rejects(sealItem(keys, memory('💬'.repeat(2048)), 1), /too large/);
  const deleted = { ...first, ciphertext: '', deleted: true };
  assert.equal(blobWins(deleted, { ...second, version: 99 }), true);
  assert.equal(blobWins({ ...second, version: 99 }, deleted), false);
});

test('BM25 returns the scoped summary, pinned and relevant items within the prompt budget', () => {
  const scope = scopeOf('sample-card');
  const summary = memory('Arrived at the observatory.', { characterId: scope, kind: 'summary' });
  const general = memory('Repairs radios.');
  const pin = memory('Prefers onions.', { kind: 'pref', weight: 2 });
  const exact = memory('The telescope tracks comets.', { characterId: scope, kind: 'event' });
  const offTopic = memory('A tray of lemon biscuits.');
  const unrelated = memory('The telescope will be disassembled.', { characterId: scopeOf('other-card') });
  const latest = ['What did the telescope see?'];
  const items = [offTopic, summary, general, unrelated, exact, pin];
  assert.deepEqual(recall(items, scope, latest, 2).map(({ id }) => id), [summary.id, pin.id, exact.id]);
  assert.ok(!recall(items, null, latest).some(({ id }) => id === summary.id || id === unrelated.id));
  const large = Array.from({ length: 20 }, () => memory('🔭'.repeat(200)));
  const recalled = recall([...items, ...large], scope, latest);
  assert.ok(memorySize(recalled) <= 4096);
  assert.equal(recalled[0].id, summary.id);
});

test('recovery round-trips the memory secret, rows and tombstones and rejects a wrong passphrase', async () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const keys = await memoryKeys(secret);
  const item = memory('Tea with orange.');
  const live = await sealItem(keys, item, 1);
  const tombstone = { id: crypto.randomUUID(), version: 2, ciphertext: '', deleted: true };
  const passphrase = 'sample recovery passphrase';
  const data = await exportRecovery(secret, [live, tombstone], passphrase);
  assert.ok(!data.includes(item.text) && !data.includes(live.ciphertext));
  await assert.rejects(importRecovery(data, 'sample incorrect passphrase'));
  const recovered = await importRecovery(data, passphrase);
  assert.deepEqual(recovered.secret, secret);
  assert.deepEqual(recovered.rows, [live, tombstone]);
  assert.deepEqual(await openItem(await memoryKeys(recovered.secret), live), item);
});

test('pairing is recipient-bound, time-limited, and consumes the one-time request', async () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const [receiver, other] = await Promise.all([newPairing(), newPairing()]);
  const response = await answerPairing(receiver.code, secret);
  await assert.rejects(other.accept(response), /could not be opened/);
  assert.deepEqual(await receiver.accept(response), secret);
  await assert.rejects(receiver.accept(response), /already used/);
  await assert.rejects(answerPairing(receiver.code, secret, Date.now() + 6 * 60_000), /expired/);
});

test('the writer can make preferences and roll the summary, preserving sealed routing', async () => {
  const prior = { id: crypto.randomUUID(), chatId: null, text: 'The crew reached shore.', kind: 'summary', at: start };
  const proposals = parseMemoryProposals(JSON.stringify([
    { text: 'You’re vegetarian.', kind: 'pref' },
    { text: 'The crew reached shore and found a map.', kind: 'summary', replace: prior.id },
    { text: 'Extra summary.', kind: 'summary' },
  ]), true);
  const prepared = await prepareSuggestions(proposals, [prior]);
  const result = saveSuggestions({ ...emptyMemory(ASSISTANT), facts: [prior] }, prepared, 'sample-chat', start);
  assert.deepEqual(result.facts.map(({ kind }) => kind).sort(), ['pref', 'summary']);
  assert.equal(result.facts.find(({ id }) => id === prior.id).text, 'The crew reached shore and found a map.');
  assert.equal(vaultWriterModel('anonymo-1', true, []), 'anonymo-sealed');
  assert.equal(vaultWriterModel('anonymo-sealed', false, []), 'anonymo-sealed');
  assert.equal(vaultWriterModel('anonymo-1', false, [{
    id: 'sample-flash', family: 'sample', architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    pricing: { prompt: '0.1', completion: '0.2' },
  }]), 'sample-flash');
});

test('the browser store migrates every legacy fact once, persists edits, pins and sync tombstones, and locks the secret', async (t) => {
  t.after(() => vault.lock());
  const local = new Map();
  const records = new Map();
  Object.defineProperty(globalThis, 'localStorage', { value: {
    getItem: (key) => local.get(key) ?? null,
    setItem: (key, value) => local.set(key, value),
    removeItem: (key) => local.delete(key),
  }, configurable: true });
  Object.defineProperty(globalThis, 'BroadcastChannel', { value: undefined, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true });
  Object.defineProperty(globalThis, 'document', { value: new EventTarget(), configurable: true });
  Object.assign(vaultDisk, {
    async get(key) { return structuredClone(records.get(key)); },
    async entries(prefix) { return structuredClone([...records].filter(([key]) => key.startsWith(prefix))); },
    async commit(puts, deletes = []) {
      for (const key of deletes) records.delete(key);
      for (const [key, value] of puts) records.set(key, structuredClone(value));
    },
    async clear() { records.clear(); },
  });

  const cardId = 'sample-character';
  local.set('anonymo.characters.v1', JSON.stringify([{ id: cardId, hash: 'sample-card' }]));
  const legacy = {
    ...emptyMemory(cardId), generation: 'sample-generation', autoSave: true, dismissed: ['dismissed-hash'],
    facts: [{ id: 'legacy-fact', text: 'Keeps a brass compass.', chatId: 'sample-chat', at: start }],
  };
  await vault.updateMemory(false, () => [legacy]);
  assert.equal(usesVaultMemoryStore(false), updateOn('vaultsync', false));
  assert.equal(getMemory(false, cardId).facts[0].text, legacy.facts[0].text);
  const first = await loadVaultMemory(false);
  const [migrated] = first.items;
  assert.equal(migrated.text, legacy.facts[0].text);
  assert.equal(migrated.characterId, scopeOf('sample-card'));
  assert.equal(usesVaultMemoryStore(false), true);
  assert.equal(getMemory(false, cardId).facts[0].text, migrated.text);
  assert.equal(migrated.createdAt, start);
  assert.deepEqual(vaultCharacter(false, cardId).dismissed, legacy.dismissed);
  assert.equal(vaultCharacter(false, cardId).facts[0].chatId, legacy.facts[0].chatId);
  const diskText = records.get(memorySlot(false)).map((bytes) => new TextDecoder().decode(bytes)).join('\n');
  assert.ok(!diskText.includes(migrated.text));
  assert.equal((await loadVaultMemory(false)).items.length, 1);

  await updateMemoryItem(false, migrated.id, (item) => ({ ...item, text: 'Keeps an old brass compass.', weight: 2 }));
  assert.equal((await loadVaultMemory(false)).items[0].weight, 2);
  const saved = await ensureMemorySecret();
  const different = crypto.getRandomValues(new Uint8Array(32));
  await assert.rejects(bringVaultMemory(false, different), /different memory vault/);
  assert.equal((await loadVaultMemory(false)).items.length, 1);
  await bringVaultMemory(false, different, [], true);
  assert.equal((await loadVaultMemory(false)).items.length, 0);
  await bringVaultMemory(false, saved);
  assert.equal((await loadVaultMemory(false)).items.length, 1);
  const remoteItem = memory('The workshop has a wooden door.');
  const remoteKeys = await memoryKeys(saved);
  const remote = await sealItem(remoteKeys, remoteItem, 1);
  await bringVaultMemory(false, saved);
  const writes = [];
  const transport = {
    async read(keys) {
      assert.equal(keys.authorization, remoteKeys.authorization);
      return [remote];
    },
    async write(_keys, rows) { writes.push(...rows); return rows; },
  };
  assert.equal(await syncVaultMemory(transport), true);
  assert.equal((await loadVaultMemory(false)).items.length, 2);
  assert.equal(writes.length, 1);
  await editVaultCharacter(false, ASSISTANT, (data) => ({ ...data, autoSave: true }));
  assert.equal(vaultCharacter(false, ASSISTANT).autoSave, true);
  await wipeVaultMemory(false);
  assert.equal((await loadVaultMemory(false)).items.length, 0);
  await syncVaultMemory(transport);
  assert.ok(writes.some(({ id, deleted }) => id === remoteItem.id && deleted));
  assert.equal((await loadVaultMemory(false)).items.length, 0);

  await vault.enable('sample device passphrase');
  vault.lock();
  assert.equal(currentVaultMemory(false), null);
  await assert.rejects(readMemorySecret(), VaultLocked);
  await vault.unlock('sample device passphrase');
  assert.deepEqual(await readMemorySecret(), saved);
  assert.equal((await loadVaultMemory(false)).items.length, 0);
  vault.lock();
  await forgetMemorySecret();
  await vault.unlock('sample device passphrase');
  assert.equal(await readMemorySecret(), null);
});

test('ordinary client sync sends only the derived vault credential and encrypted envelopes', async () => {
  const keys = await memoryKeys(new Uint8Array(32).fill(7));
  const sample = memory('A sentence that stays on the device.');
  const encrypted = await sealItem(keys, sample, 1);
  const calls = [];
  const transport = memoryTransport('https://gateway.example', async (url, init) => {
    calls.push({ url, ...init });
    return Response.json({ items: [encrypted] });
  });
  await transport.read(keys);
  await transport.write(keys, [encrypted]);
  assert.ok(calls.every((call) => call.credentials === 'omit' && call.headers.authorization === keys.authorization));
  assert.equal(calls[0].body, undefined);
  assert.ok(!calls[1].body.includes(sample.text));
});
