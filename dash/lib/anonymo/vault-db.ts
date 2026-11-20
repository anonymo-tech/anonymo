export interface VaultDisk {
  get(key: string): Promise<unknown>;
  entries(prefix: string): Promise<[string, unknown][]>;
  commit(puts: [string, unknown][], deletes?: string[]): Promise<void>;
  clear(): Promise<void>;
}

const DB = 'anonymo.vault.v1';
const STORE = 'records';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, result: (value: T) => void) => void,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error ?? new Error('Device storage transaction aborted.'));
      try {
        run(tx.objectStore(STORE), (next) => { value = next; });
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  } finally {
    db.close();
  }
}

export const vaultDisk: VaultDisk = {
  get(key) {
    return transaction('readonly', (store, done) => {
      const request = store.get(key);
      request.onsuccess = () => done(request.result);
    });
  },
  entries(prefix) {
    return transaction('readonly', (store, done) => {
      const records: [string, unknown][] = [];
      const request = store.openCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return done(records);
        records.push([String(cursor.key), cursor.value]);
        cursor.continue();
      };
    });
  },
  commit(puts, deletes = []) {
    return transaction('readwrite', (store) => {
      for (const key of deletes) store.delete(key);
      for (const [key, value] of puts) store.put(value, key);
    });
  },
  clear() {
    return transaction('readwrite', (store) => { store.clear(); });
  },
};
