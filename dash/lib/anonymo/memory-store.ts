import { cardHash, normalizeCard } from './card.ts';
import { loadCharacters, type StoredCharacter } from './characters-store.ts';
import { DEMO_MEMORY_FACTS } from './mock/memory.ts';
import { changeCharacterMemory, readCharacterMemory } from './memory-storage.ts';
import type { CharacterMemory } from './memory.ts';
import { SAMPLE_CARD } from './sample-character.ts';
import { startVault, vault } from './vault-browser.ts';
import { VaultLocked } from './vault.ts';
import { updateOn } from './updates.ts';
import { ASSISTANT } from './vault-memory/items.ts';
import { editVaultCharacter, hasMigratedVaultMemory, vaultCharacter } from './vault-memory/store.ts';

// A rollout rollback can still open locally migrated facts through the original Memory tab.
export const usesVaultMemoryStore = (demo: boolean) => updateOn('vaultsync', demo) || hasMigratedVaultMemory(demo);
export const getMemory = (demo: boolean, id: string) => usesVaultMemoryStore(demo) ? vaultCharacter(demo, id) : readCharacterMemory(vault, demo, id);
export const editMemory = (demo: boolean, id: string, change: (memory: CharacterMemory) => CharacterMemory) =>
  usesVaultMemoryStore(demo) ? editVaultCharacter(demo, id, change) : changeCharacterMemory(vault, demo, id, change);

let sampleHash: Promise<string> | undefined;
let session = 0;
let activeSecrets = [vault.snapshotMemorySecret(false), vault.snapshotMemorySecret(true)];
vault.onLock(() => { session++; });
vault.subscribe(() => {
  const next = [vault.snapshotMemorySecret(false), vault.snapshotMemorySecret(true)];
  if (activeSecrets.some((secret, i) => secret !== next[i])) session++;
  activeSecrets = next;
});
export const memorySession = () => session;

export async function initializeMemory(demo: boolean, character: StoredCharacter | null) {
  startVault();
  const requestedSession = session;
  const seeded = demo && character && character.hash === await (sampleHash ??= cardHash(normalizeCard(SAMPLE_CARD)));
  return editMemory(demo, character?.id ?? ASSISTANT, (memory) => {
    if (session !== requestedSession || (character && !loadCharacters().some(({ id }) => id === character.id))) throw new VaultLocked();
    return memory.generation ? memory : { ...memory, facts: usesVaultMemoryStore(demo) && memory.facts.length ? memory.facts : seeded ? DEMO_MEMORY_FACTS : [] };
  });
}
