import { AnonymoApiError } from '../client.ts';
import { loadCharacters } from '../characters-store.ts';
import { currentMemorySecret, decodeMemorySecret, encodeMemorySecret, ensureMemorySecret, readMemorySecret } from '../memory-secret.ts';
import { emptyMemory, type CharacterMemory } from '../memory.ts';
import { characterMemoryRecords as legacyRecords } from '../memory-storage.ts';
import { startVault, vault } from '../vault-browser.ts';
import { VaultLocked } from '../vault.ts';
import { blobWins, memoryKeys, openItem, sealItem, type MemoryBlob, type MemoryItem, type MemoryKeys } from './crypto.ts';
import { asFact, ASSISTANT, memoryId, scopeOf } from './items.ts';
import type { memoryTransport } from './sync.ts';

type StoredVault = {
  format: 'vault-memory-v1';
  id: string;
  rows: MemoryBlob[];
  pending: string[];
  sources: Record<string, string>;
  sync: boolean;
};
export type MemorySnapshot = { stored: StoredVault; items: MemoryItem[] };
type Transport = ReturnType<typeof memoryTransport>;

export function scopeFor(id: string): string | null {
  if (id === ASSISTANT) return null;
  const character = loadCharacters().find((card) => card.id === id);
  return character ? scopeOf(character.hash) : id;
}

const isStoredVault = (entry: unknown): entry is StoredVault => (entry as StoredVault | null)?.format === 'vault-memory-v1';
const docFor = (records: unknown[], id: string): StoredVault | undefined =>
  records.find((entry): entry is StoredVault => isStoredVault(entry) && entry.id === id);
export const hasMigratedVaultMemory = (demo: boolean) => vault.snapshotMemory(demo).some(isStoredVault);
const emptyDoc = (id: string, sync: boolean): StoredVault =>
  ({ format: 'vault-memory-v1', id, rows: [], pending: [], sources: {}, sync });
const replaceDoc = (records: unknown[], stored: StoredVault) => [...records.filter((entry) => entry !== docFor(records, stored.id)), stored];

async function unpack(keys: MemoryKeys, stored: StoredVault) {
  return (await Promise.all(stored.rows.map((row) => openItem(keys, row)))).filter((item): item is MemoryItem => !!item);
}

async function migrate(records: unknown[], keys: MemoryKeys, stored: StoredVault) {
  const rows = new Map(stored.rows.map((row) => [row.id, row]));
  const pending = new Set(stored.pending);
  const sources = { ...stored.sources };
  const replacements = new Map<CharacterMemory, CharacterMemory>();
  for (const memory of legacyRecords(records)) {
    if (!memory.facts.length) continue;
    const characterId = scopeFor(memory.characterId);
    for (const fact of memory.facts) {
      let id = await memoryId(characterId, fact.id);
      if (rows.has(id)) id = crypto.randomUUID();
      const item: MemoryItem = { id, characterId, kind: fact.kind ?? 'fact', text: fact.text, createdAt: fact.at, weight: 1 };
      rows.set(id, await sealItem(keys, item, 1));
      pending.add(id);
      if (fact.chatId) sources[id] = fact.chatId;
    }
    replacements.set(memory, { ...memory, facts: [] });
  }
  if (!replacements.size) return { stored, records };
  return {
    stored: { ...stored, rows: [...rows.values()], pending: [...pending], sources },
    records: records.map((entry) => replacements.get(entry as CharacterMemory) ?? entry),
  };
}

const cache = new Map<boolean, {
  records: unknown[];
  secret: string;
  loaded: Promise<MemorySnapshot | null>;
  snapshot?: MemorySnapshot;
}>();
const loading = new Map<boolean, Promise<MemorySnapshot | null>>();
vault.onLock(() => { cache.clear(); loading.clear(); });

export function currentVaultMemory(demo: boolean): MemorySnapshot | null {
  const cached = cache.get(demo);
  return cached?.secret === vault.snapshotMemorySecret(demo) ? cached?.snapshot ?? null : null;
}

/** Publish a decrypted read for the current passphrase session only. */
export function loadVaultMemory(demo: boolean): Promise<MemorySnapshot | null> {
  const active = loading.get(demo);
  if (active) return active.then((result) =>
    result && cache.get(demo)?.records === vault.snapshotMemory(demo) && currentVaultMemory(demo) === result
      ? result : loadVaultMemory(demo));
  startVault();
  const session = vault.session();
  const promise = (async () => {
    const existing = await readMemorySecret(demo);
    const secret = existing ?? await ensureMemorySecret(demo);
    const keys = await memoryKeys(secret);
    if (vault.session() !== session) throw new VaultLocked();
    let records = vault.snapshotMemory(demo);
    let stored = docFor(records, keys.id);
    if (!stored || legacyRecords(records).some(({ facts }) => facts.length)) {
      await vault.updateVaultMemory(demo, async (latest, current) => {
        if (current !== encodeMemorySecret(secret)) throw new Error('The active memory vault changed. Try again.');
        const previous = docFor(latest, keys.id);
        const migrated = await migrate(latest, keys, previous ?? emptyDoc(keys.id, !!existing && !demo));
        return previous === migrated.stored ? latest : replaceDoc(migrated.records, migrated.stored);
      });
      records = vault.snapshotMemory(demo);
      stored = docFor(records, keys.id);
    }
    if (!stored || vault.session() !== session || vault.snapshotMemorySecret(demo) !== encodeMemorySecret(secret)) return null;
    const saved = cache.get(demo);
    if (saved?.records === records && saved.secret === encodeMemorySecret(secret)) return saved.loaded;
    const retained = stored;
    const token = encodeMemorySecret(secret);
    const entry: NonNullable<ReturnType<typeof cache.get>> = { records, secret: token, loaded: Promise.resolve(null) };
    entry.loaded = unpack(keys, retained).then((items) => {
      if (cache.get(demo) !== entry || vault.session() !== session || vault.snapshotMemorySecret(demo) !== token) return null;
      return (entry.snapshot = { stored: retained, items });
    }).catch((error: unknown) => {
      if (cache.get(demo) === entry) cache.delete(demo);
      throw error;
    });
    cache.set(demo, entry);
    return entry.loaded;
  })();
  loading.set(demo, promise);
  const done = () => { if (loading.get(demo) === promise) loading.delete(demo); };
  void promise.then(done, done);
  return promise;
}

async function change(
  demo: boolean,
  edit: (stored: StoredVault, keys: MemoryKeys, records: unknown[]) => Promise<{ stored: StoredVault; records?: unknown[] }>,
  expectedId?: string,
) {
  const snapshot = await loadVaultMemory(demo);
  const id = expectedId ?? snapshot?.stored.id;
  await vault.updateVaultMemory(demo, async (records, current) => {
    const secret = decodeMemorySecret(current);
    if (!secret) throw new VaultLocked();
    const keys = await memoryKeys(secret);
    if (id !== keys.id) throw new Error('The active memory vault changed. Try again.');
    const previous = docFor(records, keys.id);
    if (!previous) throw new Error('The active memory vault changed. Try again.');
    const next = await edit(previous, keys, records);
    return next.stored === previous && !next.records ? records : replaceDoc(next.records ?? records, next.stored);
  });
  return loadVaultMemory(demo);
}

export function vaultCharacter(demo: boolean, id: string, records = vault.snapshotMemory(demo), snapshot = currentVaultMemory(demo)) {
  const current = legacyRecords(records).find(({ characterId }) => characterId === id) ?? emptyMemory(id);
  if (!snapshot) return current;
  const scope = scopeFor(id);
  return { ...current, facts: snapshot.items.filter((item) => item.characterId === scope)
    .map((item) => ({ ...asFact(item, snapshot.stored.sources[item.id]), kind: item.kind })) };
}

export async function editVaultCharacter(demo: boolean, id: string, update: (current: CharacterMemory) => CharacterMemory) {
  let result = emptyMemory(id);
  await change(demo, async (stored, keys, records) => {
    const items = await unpack(keys, stored);
    const current = vaultCharacter(demo, id, records, { stored, items });
    const next = update(current);
    if (next === current) {
      result = current;
      return { stored };
    }
    const generation = next.generation || crypto.randomUUID();
    const characterId = scopeFor(id);
    const byId = new Map(items.map((item) => [item.id, item]));
    const nextIds = new Set<string>();
    const patches = new Map<string, MemoryItem | null>();
    const sources = { ...stored.sources };
    const facts = [];
    for (const fact of next.facts) {
      const itemId = await memoryId(characterId, fact.id);
      nextIds.add(itemId);
      const previous = byId.get(itemId);
      const item: MemoryItem = {
        id: itemId, characterId, text: fact.text,
        kind: fact.kind ?? previous?.kind ?? 'fact',
        createdAt: previous?.createdAt ?? fact.at, weight: previous?.weight ?? 1,
      };
      if (!previous || previous.text !== item.text || previous.kind !== item.kind) patches.set(itemId, item);
      if (fact.chatId) sources[itemId] = fact.chatId;
      facts.push({ ...fact, id: itemId });
    }
    for (const fact of current.facts) if (!nextIds.has(fact.id)) {
      patches.set(fact.id, null);
      delete sources[fact.id];
    }
    result = { ...next, generation, facts };
    return {
      stored: { ...await patch(stored, keys, patches), sources },
      records: [...records.filter((entry) => !legacyRecords([entry]).some((record) => record.characterId === id)),
        { ...result, facts: [] }],
    };
  });
  return result;
}

async function patch(stored: StoredVault, keys: MemoryKeys, changes: Map<string, MemoryItem | null>) {
  const rows = new Map(stored.rows.map((row) => [row.id, row]));
  const pending = new Set(stored.pending);
  const sources = { ...stored.sources };
  for (const [id, item] of changes) {
    const previous = rows.get(id);
    if (previous?.deleted) {
      if (item) throw new Error('This memory was deleted on another device.');
      continue;
    }
    if (!item && !previous) continue;
    if (!item) delete sources[id];
    const version = Math.min((previous?.version ?? 0) + 1, 2_147_483_647);
    if (!item && !stored.sync) {
      rows.delete(id);
      pending.delete(id);
      continue;
    }
    if (item && previous?.version === version) throw new Error('This memory reached its version limit.');
    rows.set(id, item ? await sealItem(keys, item, version) : { id, version, deleted: true, ciphertext: '' });
    pending.add(id);
  }
  return { ...stored, rows: [...rows.values()], pending: [...pending], sources };
}

export function updateMemoryItem(demo: boolean, id: string, edit: (item: MemoryItem) => MemoryItem | null) {
  return change(demo, async (stored, keys) => {
    const current = stored.rows.find((row) => row.id === id);
    const item = current && await openItem(keys, current);
    if (!item) throw new Error('This memory was removed.');
    return { stored: await patch(stored, keys, new Map([[id, edit(item)]])) };
  });
}

export function wipeVaultMemory(demo: boolean) {
  return change(demo, async (stored, keys, records) => ({
    stored: { ...await patch(stored, keys, new Map(stored.rows.map(({ id }) => [id, null]))), sources: {} },
    records: records.filter((entry) => !isStoredVault(entry) || entry === stored)
      .map((entry) => legacyRecords([entry]).length ? { ...(entry as CharacterMemory), generation: crypto.randomUUID(), dismissed: [] } : entry),
  }));
}

export async function bringVaultMemory(demo: boolean, secret: Uint8Array, rows: MemoryBlob[] = [], allowSwitch = false) {
  await loadVaultMemory(demo);
  const incoming = await memoryKeys(secret);
  await vault.updateVaultMemory(demo, async (records, current) => {
    const priorSecret = decodeMemorySecret(current);
    if (!priorSecret) throw new VaultLocked();
    const oldKeys = await memoryKeys(priorSecret);
    const old = docFor(records, oldKeys.id);
    if (old && incoming.id !== oldKeys.id && old.rows.some(({ deleted }) => !deleted) && !allowSwitch)
      throw new Error('This device has a different memory vault. Export it first if you want to reopen it later, then confirm switching vaults.');
    // Keep the previous vault in its own namespace. Joining a vault never uploads another vault's memories.
    const next = docFor(records, incoming.id) ?? emptyDoc(incoming.id, !demo);
    const merged = await merge(next, incoming, rows, false);
    return replaceDoc(records, { ...merged, sync: !demo });
  }, encodeMemorySecret(secret));
  return loadVaultMemory(demo);
}

async function merge(stored: StoredVault, keys: MemoryKeys, remote: MemoryBlob[], acknowledge: boolean) {
  const rows = new Map(stored.rows.map((row) => [row.id, row]));
  const pending = new Set(stored.pending);
  const sources = { ...stored.sources };
  let changed = false;
  for (const blob of remote) {
    const current = rows.get(blob.id);
    if (current && blobWins(current, blob)) continue;
    if (blobWins(blob, current)) {
      await openItem(keys, blob);
      rows.set(blob.id, blob);
      if (blob.deleted) delete sources[blob.id];
      changed = true;
    }
    if (acknowledge) changed = pending.delete(blob.id) || changed;
    else if (!current || blobWins(blob, current)) pending.add(blob.id);
  }
  return changed ? { ...stored, rows: [...rows.values()], pending: [...pending], sources } : stored;
}

export async function enableVaultSync(demo: boolean, transport: Transport, apiKey: string) {
  const keys = await memoryKeys(await ensureMemorySecret(demo));
  await transport.enroll(apiKey, keys);
  await change(demo, async (stored) => ({ stored: { ...stored, sync: true } }), keys.id);
}

let syncing: Promise<boolean> | null = null;
export function syncVaultMemory(transport: Transport, signal?: AbortSignal): Promise<boolean> {
  if (syncing) return syncing;
  syncing = runSync(transport, signal);
  const done = () => { syncing = null; };
  void syncing.then(done, done);
  return syncing;
}

export async function reconcileBeforeWipe(transport: Transport) {
  await syncing?.catch(() => false);
  return runSync(transport, undefined, false);
}

async function runSync(transport: Transport, signal?: AbortSignal, uploadPending = true) {
  const snapshot = await loadVaultMemory(false);
  const secret = currentMemorySecret(false);
  if (!snapshot?.stored.sync || !secret) return false;
  const keys = await memoryKeys(secret);
  if (keys.id !== snapshot.stored.id) return false;
  const session = vault.session();
  function current() {
    signal?.throwIfAborted();
    if (vault.session() !== session || !currentMemorySecret(false)?.every((byte, i) => byte === secret![i])) throw new VaultLocked();
  }
  let remote: MemoryBlob[];
  try {
    current();
    remote = await transport.read(keys, signal);
  } catch (error) {
    if (error instanceof AnonymoApiError && error.code === 'vault_sync_not_enabled') return false;
    throw error;
  }
  current();
  const merged = await change(false, async (stored) => ({ stored: await merge(stored, keys, remote, true) }), keys.id);
  if (!merged) return false;
  if (!uploadPending) return true;
  const pending = new Set(merged.stored.pending);
  const remoteIds = new Set(remote.map(({ id }) => id));
  const rows = merged.stored.rows.filter(({ id }) => pending.has(id));
  const existing = rows.filter(({ id }) => remoteIds.has(id));
  const additions = rows.filter(({ id }) => !remoteIds.has(id)).sort((a, b) => Number(a.deleted) - Number(b.deleted));
  const space = 512 - remoteIds.size;
  for (const upload of [existing, additions.slice(0, space)]) {
    for (let i = 0; i < upload.length; i += 16) {
      current();
      const response = await transport.write(keys, upload.slice(i, i + 16), signal);
      current();
      await change(false, async (stored) => ({ stored: await merge(stored, keys, response, true) }), keys.id);
    }
  }
  if (additions.slice(space).some((row) => !row.deleted)) throw new Error('The sync limit is 512 items, including deleted items. Extra memories stay on this device.');
  return true;
}
