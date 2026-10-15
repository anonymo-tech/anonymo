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

export const PROJECT_LABELS = [
  { id: 'work', name: 'Work', color: '#b22c34' },
  { id: 'research', name: 'Research', color: '#3665a0' },
  { id: 'personal', name: 'Personal', color: '#797036' },
  { id: 'later', name: 'Later', color: '#6b527c' },
] as const;
export type ProjectLabelId = typeof PROJECT_LABELS[number]['id'];
export type ProjectLabels = Record<string, ProjectLabelId>;
export const EMPTY_PROJECT_LABELS: ProjectLabels = {};
export function isProjectLabels(value: unknown): value is ProjectLabels {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length <= 1000 && Object.entries(value).every(([id,label]) => /^[a-zA-Z0-9_-]{1,100}$/.test(id) && PROJECT_LABELS.some(item => item.id === label));
}
export function setProjectLabel(labels: ProjectLabels, id: string, label: string): ProjectLabels {
  const next = {...labels};
  if (!label) delete next[id];
  else next[id] = label as ProjectLabelId;
  if (!isProjectLabels(next)) throw new Error('This project label could not be saved.');
  return next;
}
