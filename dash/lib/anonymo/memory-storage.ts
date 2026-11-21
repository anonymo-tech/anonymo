import { emptyMemory, type CharacterMemory } from './memory.ts';
import type { createVault } from './vault.ts';

type MemoryVault = Pick<ReturnType<typeof createVault>, 'snapshotMemory' | 'updateMemory'>;

export function readCharacterMemory(vault: MemoryVault, demo: boolean, id: string) {
  return records(vault.snapshotMemory(demo)).find(({ characterId }) => characterId === id) ?? emptyMemory(id);
}

export async function changeCharacterMemory(
  vault: MemoryVault,
  demo: boolean,
  id: string,
  change: (memory: CharacterMemory) => CharacterMemory,
) {
  let result = emptyMemory(id);
  await vault.updateMemory(demo, (previous) => {
    const all = records(previous);
    const current = all.find(({ characterId }) => characterId === id) ?? emptyMemory(id);
    const next = change(current);
    result = next === current ? current : { ...next, generation: next.generation || crypto.randomUUID() };
    return next === current ? previous : [...all.filter(({ characterId }) => characterId !== id), result];
  });
  return result;
}

function records(list: unknown[]): CharacterMemory[] {
  return list.filter((item): item is CharacterMemory => {
    const value = item as Partial<CharacterMemory> | null;
    return !!value && typeof value.characterId === 'string' && typeof value.generation === 'string' &&
      Array.isArray(value.facts) && Array.isArray(value.dismissed);
  });
}
