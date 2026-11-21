'use client';

import { useEffect, useSyncExternalStore } from 'react';
import type { StoredCharacter } from '@/lib/anonymo/characters-store';
import { getMemory, initializeMemory } from '@/lib/anonymo/memory-store';
import { startVault, vault } from '@/lib/anonymo/vault-browser';

const serverState = { mode: 'loading' as const, revision: 0 };

export function useCharacterMemory(demo: boolean, character: StoredCharacter | null) {
  const { mode } = useSyncExternalStore(vault.subscribe, vault.state, () => serverState);
  const available = mode === 'off' || mode === 'unlocked';
  useEffect(() => {
    if (character) startVault();
  }, [character]);
  useEffect(() => {
    if (available && demo && character) void initializeMemory(demo, character).catch(() => {});
  }, [available, demo, character]);
  return { mode, available, memory: available && character ? getMemory(demo, character.id) : null };
}
