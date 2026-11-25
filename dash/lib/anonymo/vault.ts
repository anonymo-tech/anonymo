import {
  createVaultKey,
  decryptRecord,
  encryptRecord,
  unlockVaultKey,
  type EncryptedRecord,
  type VaultConfig,
} from './vault-crypto.ts';
import type { VaultDisk } from './vault-db.ts';

export const historySlot = (demo: boolean) => demo ? 'anonymo.demo.history.v1' : 'anonymo.history.v1';
const historySlots = [historySlot(false), historySlot(true)];
export const storySlot = (demo: boolean) => demo ? 'anonymo.demo.stories.v1' : 'anonymo.stories.v1';
export const memorySlot = (demo: boolean) => demo ? 'anonymo.demo.memory.v1' : 'anonymo.memory.v1';
export const aboutYouSlot = (demo: boolean) => demo ? 'anonymo.demo.aboutyou.v1' : 'anonymo.aboutyou.v1';
// Chats and stories can live in legacy localStorage. Memory and About you always use the vault's IndexedDB store.
const legacySlots = [...historySlots, storySlot(false), storySlot(true)];
const partySlot = (demo: boolean) => demo ? 'anonymo.demo.party.v1' : 'anonymo.party.v1';
const recordSlots = [...legacySlots, memorySlot(false), memorySlot(true), aboutYouSlot(false), aboutYouSlot(true), partySlot(false), partySlot(true)];
const memorySecretSlot = (demo: boolean) => demo ? 'anonymo.demo.memory-secret.v1' : 'anonymo.memory-secret.v1';
recordSlots.push(memorySecretSlot(false), memorySecretSlot(true));
const configSlot = 'config';
const imagePrefix = 'image:';
const utf8 = new TextEncoder();
const decoder = new TextDecoder();

type Mode = 'loading' | 'off' | 'unlocked' | 'locked' | 'unavailable';
type StoredRecord = ArrayBuffer | EncryptedRecord;
export type VaultNotice = 'data' | 'config' | 'wiped' | 'locked';
type Options = {
  disk: VaultDisk;
  legacy: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  announce?: (notice: VaultNotice) => void;
};

export class VaultLocked extends Error {
  constructor() {
    super('Unlock the vault to continue.');
  }
}

export function createVault({ disk, legacy, exclusive, announce }: Options) {
  // undefined means legacy chats still belong in localStorage; null means migrated, with encryption off.
  let config: VaultConfig | null | undefined;
  let key: CryptoKey | null = null;
  let epoch = 0;
  let state = { mode: 'loading' as Mode, revision: 0 };
  let histories = new Map<string, unknown[]>();
  const listeners = new Set<() => void>();
  const lockListeners = new Set<(chats: Map<string, unknown[]>) => void>();
  let queue = Promise.resolve();

  function emit(mode: Mode = state.mode) {
    state = { mode, revision: state.revision + 1 };
    for (const listener of listeners) listener();
  }

  function forget(mode: Mode) {
    const previous = histories;
    histories = new Map();
    key = null;
    epoch++;
    for (const listener of lockListeners) listener(previous);
    emit(mode);
  }

  function run<T>(operation: (current: number) => Promise<T>) {
    const requested = epoch;
    const next = queue.then(() => exclusive(() => operation(requested)));
    queue = next.then(() => undefined, () => undefined);
    return next;
  }

  function assertCurrent(current: number) {
    if (current !== epoch) throw new VaultLocked();
  }

  async function syncConfig(current: number) {
    assertCurrent(current);
    const stored = await disk.get(configSlot) as VaultConfig | null | undefined;
    assertCurrent(current);
    if (stored?.salt.toString() !== config?.salt.toString()) {
      config = stored;
      forget(stored ? 'locked' : 'loading');
      return epoch;
    }
    config = stored;
    return current;
  }

  function readLegacy(slot: string): unknown[] {
    const raw = legacy().getItem(slot);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Match the legacy history reader for malformed values.
      return [];
    }
  }

  async function unpack(recordKey: string, value: StoredRecord, withKey: CryptoKey | null) {
    if (value instanceof ArrayBuffer && !withKey) return value;
    if (!(value instanceof ArrayBuffer) && withKey) return decryptRecord(withKey, recordKey, value);
    throw new Error('Vault record does not match its storage format.');
  }

  async function unpackChats(slot: string, values: StoredRecord[], withKey: CryptoKey | null) {
    return Promise.all(values.map(async (value, i) => JSON.parse(decoder.decode(await unpack(`${slot}/${i}`, value, withKey))) as unknown));
  }

  async function packChats(slot: string, chats: unknown[], withKey: CryptoKey | null) {
    return Promise.all(chats.map((chat, i) => {
      const bytes = utf8.encode(JSON.stringify(chat));
      return withKey ? encryptRecord(withKey, `${slot}/${i}`, bytes) : bytes.buffer;
    }));
  }

  async function readChats(slot: string, withKey: CryptoKey | null, current: number) {
    if (config === undefined && legacySlots.includes(slot)) return readLegacy(slot);
    const records = (await disk.get(slot) ?? []) as StoredRecord[];
    assertCurrent(current);
    return unpackChats(slot, records, withKey);
  }

  async function refresh(current: number) {
    if (config && !key) {
      if (state.mode !== 'locked') emit('locked');
      return;
    }
    const chats = await Promise.all(recordSlots.map(async (slot) => [slot, await readChats(slot, key, current)] as const));
    assertCurrent(current);
    histories = new Map(chats);
    emit(config ? 'unlocked' : 'off');
  }

  async function migrateLegacy(current: number) {
    if (config === undefined) {
      const chats = await Promise.all(legacySlots.map(async (slot): Promise<[string, unknown]> => [slot, await packChats(slot, readLegacy(slot), null)]));
      assertCurrent(current);
      await disk.commit([[configSlot, null], ...chats]);
      config = null;
    }
    // Finish legacy cleanup before committing any enabled configuration. An interrupted import can be retried.
    for (const slot of legacySlots) legacy().removeItem(slot);
  }

  async function reencrypt(current: number, previous: CryptoKey | null, next: CryptoKey | null, nextConfig: VaultConfig | null) {
    const puts: [string, unknown][] = [[configSlot, nextConfig]];
    const nextHistories = new Map<string, unknown[]>();
    for (const slot of recordSlots) {
      const chats = await readChats(slot, previous, current);
      puts.push([slot, await packChats(slot, chats, next)]);
      nextHistories.set(slot, chats);
    }
    for (const [slot, value] of await disk.entries(imagePrefix)) {
      assertCurrent(current);
      const bytes = await unpack(slot, value as StoredRecord, previous);
      puts.push([slot, next ? await encryptRecord(next, slot, bytes) : bytes]);
    }
    assertCurrent(current);
    await disk.commit(puts);
    config = nextConfig;
    announce?.('config');
    if (current === epoch) {
      key = next;
      histories = nextHistories;
    }
    emit(nextConfig ? (key ? 'unlocked' : 'locked') : 'off');
  }

  function updateList(
    slot: string,
    update: (previous: unknown[], related?: unknown) => unknown[] | Promise<unknown[]>,
    extra?: { slot: string; replacement?: unknown },
  ) {
    return run(async (current) => {
      current = await syncConfig(current);
      if (config && !key) throw new VaultLocked();
      const previous = await readChats(slot, key, current);
      assertCurrent(current);
      const related = extra ? (await readChats(extra.slot, key, current))[0] : undefined;
      assertCurrent(current);
      const changed = update(previous, related);
      const list = changed instanceof Promise ? await changed : changed;
      assertCurrent(current);
      if (list === previous && !legacySlots.includes(slot)) return;
      if (config === undefined && legacySlots.includes(slot)) legacy().setItem(slot, JSON.stringify(list));
      else {
        const data = await packChats(slot, list, key);
        assertCurrent(current);
        const puts: [string, unknown][] = [[slot, data]];
        if (extra?.replacement !== undefined) puts.push([extra.slot, await packChats(extra.slot, [extra.replacement], key)]);
        assertCurrent(current);
        await disk.commit(puts);
      }
      assertCurrent(current);
      histories.set(slot, list);
      if (extra?.replacement !== undefined) histories.set(extra.slot, [extra.replacement]);
      emit(config ? 'unlocked' : 'off');
      announce?.('data');
    });
  }

  return {
    state: () => state,
    session: () => epoch,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    onLock(listener: (chats: Map<string, unknown[]>) => void) {
      lockListeners.add(listener);
      return () => { lockListeners.delete(listener); };
    },
    snapshotChats(demo: boolean) {
      return histories.get(historySlot(demo)) ?? [];
    },
    snapshotStories(demo: boolean) {
      return histories.get(storySlot(demo)) ?? [];
    },
    refresh() {
      return run(async (current) => refresh(await syncConfig(current))).catch((error) => {
        if (!(error instanceof VaultLocked)) forget('unavailable');
        throw error;
      });
    },
    received(notice: VaultNotice) {
      if (notice === 'locked' && config) forget('locked');
      if (notice === 'wiped' || notice === 'config') forget('loading');
      if (notice === 'wiped') config = undefined;
      return this.refresh();
    },
    lock() {
      forget(config ? 'locked' : 'loading');
    },
    enable(passphrase: string) {
      return run(async (current) => {
        current = await syncConfig(current);
        if (config) throw new Error('The vault is already on.');
        const next = await createVaultKey(passphrase);
        assertCurrent(current);
        await migrateLegacy(current);
        await reencrypt(current, null, next.key, next.config);
      });
    },
    unlock(passphrase: string) {
      return run(async (current) => {
        current = await syncConfig(current);
        if (!config) throw new Error('The vault is off.');
        const unlocked = await unlockVaultKey(passphrase, config);
        assertCurrent(current);
        // Authenticate and read every saved chat before publishing the key or the unlocked state.
        const chats = await Promise.all(recordSlots.map(async (slot) => [slot, await readChats(slot, unlocked, current)] as const));
        assertCurrent(current);
        key = unlocked;
        histories = new Map(chats);
        emit('unlocked');
      });
    },
    changePassphrase(passphrase: string, replacement: string) {
      return run(async (current) => {
        current = await syncConfig(current);
        if (!config) throw new Error('The vault is off.');
        const old = await unlockVaultKey(passphrase, config);
        const next = await createVaultKey(replacement);
        assertCurrent(current);
        await reencrypt(current, old, next.key, next.config);
      });
    },
    disable(passphrase: string) {
      return run(async (current) => {
        current = await syncConfig(current);
        if (!config) throw new Error('The vault is already off.');
        const old = await unlockVaultKey(passphrase, config);
        assertCurrent(current);
        await reencrypt(current, old, null, null);
      });
    },
    updateChats(demo: boolean, update: (chats: unknown[]) => unknown[]) {
      return updateList(historySlot(demo), update);
    },
    updateStories(demo: boolean, update: (stories: unknown[]) => unknown[]) {
      return updateList(storySlot(demo), update);
    },
    snapshotParty(demo: boolean) {
      return histories.get(partySlot(demo)) ?? [];
    },
    updateParty(demo: boolean, update: (records: unknown[]) => unknown[]) {
      return updateList(partySlot(demo), update);
    },
    snapshotMemory(demo: boolean) {
      return histories.get(memorySlot(demo)) ?? [];
    },
    updateMemory(demo: boolean, update: (records: unknown[]) => unknown[]) {
      return updateList(memorySlot(demo), update);
    },
    updateVaultMemory(demo: boolean, update: (records: unknown[], secret?: unknown) => Promise<unknown[]>, replacement?: unknown) {
      return updateList(memorySlot(demo), update, { slot: memorySecretSlot(demo), replacement });
    },
    snapshotMemorySecret(demo: boolean) {
      return histories.get(memorySecretSlot(demo))?.[0];
    },
    updateMemorySecret(demo: boolean, update: (previous: unknown) => unknown) {
      return updateList(memorySecretSlot(demo), (records) => {
        const next = update(records[0]);
        return next === records[0] ? records : next === undefined ? [] : [next];
      });
    },
    clearMemorySecret(demo: boolean) {
      return run(async () => {
        const slot = memorySecretSlot(demo);
        await disk.commit([], [slot]);
        histories.delete(slot);
        emit();
        announce?.('data');
      });
    },
    snapshotAboutYou(demo: boolean) {
      return histories.get(aboutYouSlot(demo))?.[0];
    },
    updateAboutYou(demo: boolean, update: (profile: unknown) => unknown) {
      return updateList(aboutYouSlot(demo), (records) => {
        const next = update(records[0]);
        return next === records[0] ? records : next === undefined ? [] : [next];
      });
    },
    clearChats() {
      return run(async () => {
        // Clearing history needs no key and can finish even if the vault locks during the delete.
        for (const slot of historySlots) legacy().removeItem(slot);
        await disk.commit([], historySlots);
        for (const slot of historySlots) histories.delete(slot);
        emit();
        announce?.('data');
      });
    },
    images(demo: boolean) {
      return run(async (current) => {
        current = await syncConfig(current);
        const active = key;
        if (config && !active) throw new VaultLocked();
        const records = await disk.entries(imagePrefix + (demo ? 'demo:' : 'live:'));
        assertCurrent(current);
        const images = await Promise.all(records.map(async ([id, value]) => [id, await unpack(id, value as StoredRecord, active)] as const));
        assertCurrent(current);
        return images;
      });
    },
    saveImages(images: [string, ArrayBuffer][]) {
      return run(async (current) => {
        current = await syncConfig(current);
        const active = key;
        if (config && !active) throw new VaultLocked();
        const puts = await Promise.all(images.map(async ([id, value]): Promise<[string, unknown]> => [id, active ? await encryptRecord(active, id, value) : value]));
        assertCurrent(current);
        await disk.commit(puts);
        announce?.('data');
        emit();
      });
    },
    deleteImages(prefix: string, id?: string) {
      return run(async (current) => {
        current = await syncConfig(current);
        if (config && !key) throw new VaultLocked();
        const ids = id ? [id] : (await disk.entries(prefix)).map(([slot]) => slot);
        assertCurrent(current);
        await disk.commit([], ids);
        announce?.('data');
        emit();
      });
    },
    wipe(removeLocal: () => number) {
      forget('loading');
      return run(async () => {
        await disk.clear();
        const count = removeLocal();
        config = undefined;
        announce?.('wiped');
        emit('off');
        return count;
      });
    },
  };
}
