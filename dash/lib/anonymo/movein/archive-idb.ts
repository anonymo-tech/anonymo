// The Move In archive on IndexedDB. Each operation opens the database, runs one transaction and closes it again, as
// the vault's disk does (lib/anonymo/vault-db.ts): no connection is held open, so a wipe in any tab is never blocked.

import { ARCHIVE_DB, STORES, type ArchiveDisk, type StoreName } from './archive.ts';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ARCHIVE_DB, 1);
    request.onupgradeneeded = () => {
      for (const store of STORES) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Device storage could not be opened.'));
    request.onblocked = () => reject(new Error('Device storage is busy in another tab.'));
  });
}

async function transaction<T>(stores: StoreName[], mode: IDBTransactionMode, run: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error ?? new Error('Device storage refused the change. It may be full.'));
      try {
        run(tx, (next) => {
          value = next;
        });
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  } finally {
    db.close();
  }
}

const range = (prefix: string) => IDBKeyRange.bound(prefix, prefix + '￿');

export const idbDisk: ArchiveDisk = {
  get(store, key) {
    return transaction([store], 'readonly', (tx, done) => {
      const request = tx.objectStore(store).get(key);
      request.onsuccess = () => done(request.result);
    });
  },
  entries(store, prefix) {
    return transaction<[string, unknown][]>([store], 'readonly', (tx, done) => {
      const rows: [string, unknown][] = [];
      const request = tx.objectStore(store).openCursor(range(prefix));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return done(rows);
        rows.push([cursor.key as string, cursor.value]);
        cursor.continue();
      };
    });
  },
  keys(store, prefix) {
    return transaction<string[]>([store], 'readonly', (tx, done) => {
      const request = tx.objectStore(store).getAllKeys(range(prefix));
      request.onsuccess = () => done(request.result.map(String));
    });
  },
  commit(ops) {
    if (!ops.length) return Promise.resolve();
    return transaction<void>([...new Set(ops.map((op) => op.store))], 'readwrite', (tx) => {
      for (const op of ops) {
        if (op.value === undefined) tx.objectStore(op.store).delete(op.key);
        else tx.objectStore(op.store).put(op.value, op.key);
      }
    });
  },
};

/** The channel the Move In store listens on: a wipe tells every tab, this one included, to forget what it holds. */
export const ARCHIVE_CHANNEL = 'anonymo.movein.v1';

/** "Wipe this device": deletes the whole database (every character, chat and memory board, live and demo) and tells
 *  every tab's Move In store to stop any import and forget what it holds. */
export function deleteArchiveDb(): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  try {
    // A new channel object reaches the store's own, even in this tab.
    const channel = new BroadcastChannel(ARCHIVE_CHANNEL);
    channel.postMessage('wiped');
    channel.close();
  } catch {
    // no BroadcastChannel: the marker in browser storage still catches it on the next read
  }
  return dropArchiveDb();
}

/** Deletes the database without telling anyone: for clearing what an earlier wipe left behind. */
export function dropArchiveDb(): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(ARCHIVE_DB);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Device storage could not be cleared.'));
    // Another tab is in the middle of a transaction: the delete goes through as soon as that ends.
    request.onblocked = () => undefined;
  });
}

export const hasIndexedDb = () => typeof indexedDB !== 'undefined';
