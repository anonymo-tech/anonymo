'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { updateOn } from '@/lib/anonymo/updates';
import { API_BASE } from '@/lib/anonymo/config';
import { startVault, vault } from '@/lib/anonymo/vault-browser';
import { loadVaultMemory, syncVaultMemory, currentVaultMemory } from '@/lib/anonymo/vault-memory/store';
import { memoryTransport } from '@/lib/anonymo/vault-memory/sync';

const serverState = { mode: 'loading' as const, revision: 0 };
export const vaultMemoryTransport = memoryTransport(API_BASE);

export function useVaultMemory(demo: boolean, enabled = true) {
  const { mode, revision } = useSyncExternalStore(vault.subscribe, vault.state, () => serverState);
  const [loaded, setLoaded] = useState<{ demo: boolean; error: string } | null>(null);
  useEffect(() => { if (enabled) startVault(); }, [enabled]);
  useEffect(() => {
    if (!enabled || (mode !== 'off' && mode !== 'unlocked')) return;
    let active = true;
    void loadVaultMemory(demo).then(
      () => { if (active) setLoaded({ demo, error: '' }); },
      () => { if (active) setLoaded({ demo, error: 'Memory couldn’t be opened on this device.' }); },
    );
    return () => { active = false; };
  }, [demo, enabled, mode, revision]);
  return {
    mode,
    snapshot: enabled && (mode === 'off' || mode === 'unlocked') ? currentVaultMemory(demo) : null,
    error: loaded?.demo === demo ? loaded.error : '',
  };
}

export function useMemoryCapacity(demo: boolean) {
  const { key } = useAnonymo();
  return updateOn('passes', demo) || updateOn('stake', demo) ? key : undefined;
}

export function VaultMemorySync({ demo }: { demo: boolean }) {
  const capacityKey = useMemoryCapacity(demo);
  const { snapshot } = useVaultMemory(demo);
  const id = snapshot?.stored.sync && !demo ? snapshot.stored.id : null;
  const pending = snapshot?.stored.pending;
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    const sync = () => {
      if (!document.hidden && !document.documentElement.hasAttribute('data-anonymo-panic'))
        void syncVaultMemory(vaultMemoryTransport, controller.signal, capacityKey === undefined ? undefined : { key: capacityKey }).catch(() => {});
    };
    sync();
    const timer = window.setInterval(sync, 30_000);
    window.addEventListener('focus', sync);
    window.addEventListener('online', sync);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', sync);
      window.removeEventListener('online', sync);
    };
  }, [id, capacityKey]);
  useEffect(() => {
    if (!id || !pending?.length) return;
    const timer = window.setTimeout(() => {
      if (!document.hidden && !document.documentElement.hasAttribute('data-anonymo-panic'))
        void syncVaultMemory(vaultMemoryTransport, undefined, capacityKey === undefined ? undefined : { key: capacityKey }).catch(() => {});
    }, 750);
    // Let an active upload settle when an acknowledgement changes the pending list.
    return () => window.clearTimeout(timer);
  }, [id, pending, capacityKey]);
  return null;
}
