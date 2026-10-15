export type ModelPanel = { id: string; name: string; models: string[] };
export function isModelPanels(value: unknown): value is ModelPanel[] {
  return Array.isArray(value) && value.length <= 20 && value.every(p => p && typeof p === 'object' && typeof p.id === 'string' && p.id.length <= 80 && typeof p.name === 'string' && p.name.trim().length > 0 && p.name.length <= 48 && Array.isArray(p.models) && p.models.length > 0 && p.models.length <= 4 && new Set(p.models).size === p.models.length && p.models.every((m: unknown) => typeof m === 'string' && m.length <= 160));
}
export function panelAvailable(panel: ModelPanel, available: readonly string[]) { return panel.models.every(id => available.includes(id)); }
