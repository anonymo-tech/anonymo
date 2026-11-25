'use client';

import { useEffect, useSyncExternalStore } from 'react';
import type { StoredCharacter } from '@/lib/anonymo/characters-store';
import { getMemory, initializeMemory, usesVaultMemoryStore } from '@/lib/anonymo/memory-store';
import { ASSISTANT } from '@/lib/anonymo/vault-memory/items';
import { useVaultMemory } from './vault-memory-state';
import { startVault, vault } from '@/lib/anonymo/vault-browser';

const serverState = { mode: 'loading' as const, revision: 0 };

export function useCharacterMemory(demo: boolean, character: StoredCharacter | null, assistant = false) {
  const { mode } = useSyncExternalStore(vault.subscribe, vault.state, () => serverState);
  const encrypted = (character !== null || assistant) && usesVaultMemoryStore(demo);
  const { snapshot } = useVaultMemory(demo, encrypted);
  const available = mode === 'off' || mode === 'unlocked';
  useEffect(() => {
    if (character) startVault();
  }, [character]);
  useEffect(() => {
    if (available && demo && character) void initializeMemory(demo, character).catch(() => {});
  }, [available, demo, character]);
  return { mode, available, memory: available && (!encrypted || snapshot) && (character || assistant) ? getMemory(demo, character?.id ?? ASSISTANT) : null };
}
