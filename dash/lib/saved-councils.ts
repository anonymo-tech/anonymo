export type SavedCouncil = {
  id: string;
  name: string;
  modelIds: string[];
  createdAt: number;
};

export const councilsKey = 'conclave-councils-v1';
export const councilLimits = { councils: 6, models: 4, name: 24 } as const;

export function councilName(name: string): string {
  return Array.from(name.trim()).slice(0, councilLimits.name).join('').trim();
}

export function validCouncil(value: unknown): SavedCouncil | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || !item.id.trim() || item.id.length > 128 ||
      typeof item.name !== 'string' || !councilName(item.name) ||
      typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt) || item.createdAt < 0 ||
      !Array.isArray(item.modelIds) || item.modelIds.length < 2 || item.modelIds.length > councilLimits.models ||
      item.modelIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 128) ||
      new Set(item.modelIds).size !== item.modelIds.length) return null;
  return { id: item.id, name: councilName(item.name), modelIds: [...item.modelIds], createdAt: item.createdAt };
}

export function parseCouncils(json: string | null): SavedCouncil[] {
  try {
    const value: unknown = JSON.parse(json ?? 'null');
    if (!Array.isArray(value)) return [];
    const result: SavedCouncil[] = [];
    for (const raw of value) {
      const council = validCouncil(raw);
      if (council && !result.some(item => item.id === council.id)) result.push(council);
      if (result.length === councilLimits.councils) break;
    }
    return result;
  } catch {
    return [];
  }
}

type CouncilStorage = Pick<Storage, 'getItem' | 'setItem'>;

// The accessor itself can throw in private windows, as can either storage method.
export function readCouncils(storage: () => CouncilStorage): { councils: SavedCouncil[]; stored: boolean } {
  try {
    return { councils: parseCouncils(storage().getItem(councilsKey)), stored: true };
  } catch {
    return { councils: [], stored: false };
  }
}

export function writeCouncils(storage: () => CouncilStorage, councils: readonly SavedCouncil[]): boolean {
  try {
    storage().setItem(councilsKey, JSON.stringify(parseCouncils(JSON.stringify(councils))));
    return true;
  } catch {
    return false;
  }
}

export function addCouncil(councils: readonly SavedCouncil[], value: SavedCouncil): SavedCouncil[] {
  const council = validCouncil(value);
  if (!council || councils.length >= councilLimits.councils || councils.some(item => item.id === council.id)) return [...councils];
  return [...councils, council];
}

export function selectCouncil(council: SavedCouncil, known: readonly string[], available: readonly string[] | null) {
  const modelIds = [...new Set(council.modelIds)].filter(id => known.includes(id) && (available === null || available.includes(id))).slice(0, councilLimits.models);
  return { modelIds, skipped: council.modelIds.filter(id => !modelIds.includes(id)) };
}
