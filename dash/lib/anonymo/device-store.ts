// Values kept in this browser (the API key, receipt ids, imported characters, the 18+ confirmation, the last model),
// exposed as external stores so components read them with useSyncExternalStore: the server renders the fallback, the
// browser renders what is stored, and every reader updates when a value changes here or in another tab.

import { useSyncExternalStore } from 'react';

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
