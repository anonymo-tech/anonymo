import { readCampaignSave, type CampaignSave } from '../party.ts';
import { memoryId } from './items.ts';
import type { MemoryItem } from './crypto.ts';

const PART_SIZE = 600;
const MAX_PARTS = 96;
const prefix = 'party:';

export async function campaignMemory(save: CampaignSave): Promise<MemoryItem[]> {
  const text = JSON.stringify(save);
  const count = Math.ceil(text.length / PART_SIZE);
  const scope = prefix + save.checkpoint.id;
  if (count > MAX_PARTS) throw new Error('This campaign save is too large for Vault Memory.');
  return Promise.all(Array.from({ length: count }, async (_, index) => ({
    id: await memoryId(null, scope + ':' + index),
    characterId: scope,
    kind: 'event' as const,
    createdAt: save.savedAt,
    weight: 1,
    text: JSON.stringify([index, count, text.slice(index * PART_SIZE, (index + 1) * PART_SIZE)]),
  })));
}

export function campaignsFromMemory(items: readonly MemoryItem[]) {
  const groups = new Map<string, MemoryItem[]>();
  for (const item of items) {
    if (item.characterId?.startsWith(prefix)) {
      const group = groups.get(item.characterId) ?? [];
      group.push(item);
      groups.set(item.characterId, group);
    }
  }
  return [...groups.values()].flatMap((group) => {
    try {
      const pieces = group.map(({ text }) => JSON.parse(text) as [number, number, string]).sort((a, b) => a[0] - b[0]);
      if (pieces.length > MAX_PARTS || pieces.some(([i, count, part], index) => i !== index || count !== pieces.length || typeof part !== 'string')) return [];
      const saved = readCampaignSave(JSON.parse(pieces.map(([, , text]) => text).join('')));
      return saved ? [saved] : [];
    } catch {
      return [];
    }
  });
}
