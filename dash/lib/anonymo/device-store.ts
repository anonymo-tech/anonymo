// Values kept in this browser (the API key, receipt ids, imported characters, the 18+ confirmation, the last model),
// exposed as external stores so components read them with useSyncExternalStore: the server renders the fallback, the
// browser renders what is stored, and every reader updates when a value changes here or in another tab.

import { useSyncExternalStore } from 'react';
import { forgetSignupMemory } from './dashboard-signup.ts';
import { wipeFaces } from './faces-store.ts';
import { startVault, vault } from './vault-browser.ts';
import { deleteArchiveDb } from './movein/archive-idb.ts';

export type DeviceStore<T> = {
  subscribe: (listener: () => void) => () => void;
  get: () => T;
  server: () => T;
  changed: () => void;
};

export function deviceStore<T>(read: () => T, fallback: T): DeviceStore<T> {
  const listeners = new Set<() => void>();
  let cache: { value: T } | null = null;
  const changed = () => {
    cache = null;
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      window.addEventListener('storage', changed);
      return () => {
        listeners.delete(listener);
        window.removeEventListener('storage', changed);
      };
    },
    get() {
      if (!cache) cache = { value: read() };
      return cache.value;
    },
    server: () => fallback,
    changed,
  };
}

export const useDeviceStore = <T,>(store: DeviceStore<T>) => useSyncExternalStore(store.subscribe, store.get, store.server);

const never = () => () => {};
/** False on the server and during hydration, true once running in the browser. */
export const useHydrated = () =>
  useSyncExternalStore(
    never,
    () => true,
    () => false,
  );

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const DEVICE_PREFIX = 'anonymo.';

export function wipeDevice(): Promise<number>;
export function wipeDevice(storages: Storage[]): number;
export function wipeDevice(storages?: Storage[]) {
  forgetSignupMemory();
  if (storages) return removeDeviceKeys(storages);
  startVault();
  // The vault wipe clears saved chats, stories and character memory (live and demo) with their legacy device keys.
  const moveIn = deleteArchiveDb(); // update "movein": what moved in lives in its own IndexedDB database
  return Promise.all([vault.wipe(() => removeDeviceKeys([localStorage, sessionStorage])), wipeFaces(), moveIn]).then(([removed]) => removed);
}

function removeDeviceKeys(storages: Storage[]) {
  let removed = 0;
  for (const storage of storages) {
    const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i));
    for (const key of keys) {
      if (!key?.startsWith(DEVICE_PREFIX)) continue;
      storage.removeItem(key);
      removed++;
    }
  }
  return removed;
}
