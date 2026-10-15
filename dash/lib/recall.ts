export type RecallHit = {
  projectId: string;
  projectTitle: string;
  comparisonId: string;
  prompt: string;
  excerpt: string;
};
export function findExcerpt(text: string, query: string): string | null {
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return null;
  const start = Math.max(0, index - 90),
    end = Math.min(text.length, index + query.length + 160);
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
