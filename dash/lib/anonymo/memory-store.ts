import { cardHash, normalizeCard } from './card.ts';
import { loadCharacters, type StoredCharacter } from './characters-store.ts';
import { DEMO_MEMORY_FACTS } from './mock/memory.ts';
import { changeCharacterMemory, readCharacterMemory } from './memory-storage.ts';
import type { CharacterMemory } from './memory.ts';
import { SAMPLE_CARD } from './sample-character.ts';
import { startVault, vault } from './vault-browser.ts';
import { VaultLocked } from './vault.ts';

export const getMemory = (demo: boolean, id: string) => readCharacterMemory(vault, demo, id);
export const editMemory = (demo: boolean, id: string, change: (memory: CharacterMemory) => CharacterMemory) =>
  changeCharacterMemory(vault, demo, id, change);

let sampleHash: Promise<string> | undefined;
let session = 0;
vault.onLock(() => { session++; });
export const memorySession = () => session;

export async function initializeMemory(demo: boolean, character: StoredCharacter) {
  startVault();
  const requestedSession = session;
  const seeded = demo && character.hash === await (sampleHash ??= cardHash(normalizeCard(SAMPLE_CARD)));
  return editMemory(demo, character.id, (memory) => {
    if (session !== requestedSession || !loadCharacters().some(({ id }) => id === character.id)) throw new VaultLocked();
    return memory.generation ? memory : { ...memory, facts: seeded ? DEMO_MEMORY_FACTS : [] };
  });
}
