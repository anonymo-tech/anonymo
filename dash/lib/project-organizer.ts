export type ProjectView = { layout: 'cards' | 'list'; sort: 'recent' | 'name' | 'oldest' };
export const PROJECT_VIEW_DEFAULT: ProjectView = { layout: 'cards', sort: 'recent' };
export function isProjectView(value: unknown): value is ProjectView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (item.layout === 'cards' || item.layout === 'list') && ['recent', 'name', 'oldest'].includes(String(item.sort));
}
export function sortProjects<T extends { id: string; name: string; updatedAt: number }>(projects: T[], sort: ProjectView['sort']): T[] {
  return projects.toSorted((a,b) => (sort === 'name' ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) : sort === 'oldest' ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
}
