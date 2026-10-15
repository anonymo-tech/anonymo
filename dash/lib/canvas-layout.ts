export type CanvasPoint = { x: number; y: number };
export type CanvasViewport = CanvasPoint & { zoom: number };
export type CanvasLayout = {
  version: 1;
  positions: Record<string, CanvasPoint>;
  viewport: CanvasViewport;
};
const maxNodes = 3000;
const coordinate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10_000_000;
const point = (value: unknown): value is CanvasPoint => {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return coordinate(item.x) && coordinate(item.y);
};
export function canvasLayoutKey(account: string, project: string) {
  return `conclave:canvas-layout:v1:${encodeURIComponent(account)}:${encodeURIComponent(project)}`;
}
/** Store coordinates only. Prompts, answers and account credentials never enter this record. */
export function parseCanvasLayout(value: unknown): CanvasLayout | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || !point(item.viewport)) return null;
  const viewport = item.viewport as CanvasViewport;
  if (!Number.isFinite(viewport.zoom) || viewport.zoom < 0.25 || viewport.zoom > 1.8)
    return null;
  if (!item.positions || typeof item.positions !== 'object' || Array.isArray(item.positions)) return null;
  const entries = Object.entries(item.positions);
  if (entries.length > maxNodes || entries.some(([id, value]) =>
    !id || id.length > 200 || ['__proto__', 'constructor', 'prototype'].includes(id) || !point(value))) return null;
  return {
    version: 1,
    positions: Object.fromEntries(entries.map(([id, value]) => [id, { x: value.x, y: value.y }])),
    viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom },
  };
}
export function snapshotCanvasLayout(
  nodes: readonly { id: string; position: CanvasPoint }[],
  viewport: CanvasViewport,
) {
  return parseCanvasLayout({
    version: 1,
    positions: Object.fromEntries(nodes.map(({ id, position }) => [id, position])),
    viewport,
  });
}
