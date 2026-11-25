import { memorySize, MEMORY_PROMPT_BYTES, type MemoryFact } from '../memory.ts';
import { hex, utf8, uuid, type MemoryItem } from './crypto.ts';

export const ASSISTANT = 'vault-memory:assistant';
export const scopeOf = (hash: string) => `card:${hash}`;

export const asFact = (item: MemoryItem, source: string | null = null): MemoryFact => ({
  id: item.id, text: item.text, chatId: source, at: item.createdAt,
});

export async function memoryId(characterId: string | null, id: string) {
  if (uuid.test(id)) return id;
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(JSON.stringify(['vault-memory-legacy', characterId, id]))));
  const key = hex(bytes.subarray(0, 16));
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20)}`;
}

const tokens = (text: string) => text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

export function recall(items: readonly MemoryItem[], characterId: string | null, latest: readonly string[], top = 12) {
  const relevant = items.filter((item) => item.characterId === null || item.characterId === characterId);
  const summaries = relevant.filter(({ kind }) => kind === 'summary').sort((a, b) =>
    Number(b.weight >= 2) - Number(a.weight >= 2) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const summary = summaries.find((item) => item.characterId === characterId) ?? summaries[0];
  const documents = relevant.filter(({ kind }) => kind !== 'summary').map((item) => ({
    item, words: tokens(item.text), counts: new Map<string, number>(),
  }));
  const avg = documents.reduce((sum, doc) => sum + doc.words.length, 0) / (documents.length || 1) || 1;
  const query = new Set(latest.flatMap(tokens));
  const frequency = new Map<string, number>();
  for (const doc of documents) {
    for (const word of doc.words) doc.counts.set(word, (doc.counts.get(word) ?? 0) + 1);
    for (const term of query) if (doc.counts.has(term)) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  }
  const ranked = documents.map(({ item, words, counts }) => {
    let score = 0;
    for (const [term, df] of frequency) {
      const tf = counts.get(term) ?? 0;
      const idf = Math.log1p((documents.length - df + 0.5) / (df + 0.5));
      score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * words.length / avg));
    }
    return { item, score: score * item.weight };
  }).sort((a, b) => Number(b.item.weight >= 2) - Number(a.item.weight >= 2) ||
    b.score - a.score || b.item.createdAt.localeCompare(a.item.createdAt) || a.item.id.localeCompare(b.item.id));
  // Keep BM25 ordering inside the same serialized prompt budget as character memory.
  const facts = [...(summary ? [summary] : []), ...ranked.slice(0, top).map(({ item }) => item)];
  return facts.reduce<MemoryFact[]>((selected, item) => {
    const next = [...selected, { ...asFact(item), kind: item.kind }];
    if (memorySize(next) <= MEMORY_PROMPT_BYTES) return next;
    if (item.kind !== 'summary') return selected;
    return [{ ...next[0]!, text: [...item.text].slice(0, 360).join('') }];
  }, []);
}
