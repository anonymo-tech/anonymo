import type { MemoryFact } from '../memory.ts';
import { MEMORY_INSTRUCTION, VAULT_MEMORY_INSTRUCTION } from '../memory-request.ts';
import type { ChatMessage } from '../types.ts';

export const DEMO_MEMORY_FACTS: MemoryFact[] = [
  { id: 'demo-memory-1', text: 'Prefers the night watch.', chatId: 'demo-watch', at: '2026-11-18T12:00:00Z' },
  { id: 'demo-memory-2', text: 'Takes tea with a slice of orange.', chatId: 'demo-tea', at: '2026-11-17T12:00:00Z' },
  { id: 'demo-memory-3', text: 'Collects postcards from each harbor.', chatId: 'demo-postcards', at: '2026-11-16T12:00:00Z' },
];

export function demoMemoryReply(messages: ChatMessage[]): string | null {
  if (messages[0]?.content === VAULT_MEMORY_INSTRUCTION) {
    const user = (JSON.parse(messages[1]?.content ?? '{}') as { user?: string }).user ?? '';
    if (/\bvegetarian\b/i.test(user)) return JSON.stringify([{ kind: 'pref', text: 'You’re vegetarian.', replace: null }]);
    return '[]';
  }
  if (messages[0]?.role !== 'system' || messages[0].content !== MEMORY_INSTRUCTION) return null;
  return JSON.stringify([{ text: 'Keeps a compass from their first voyage.', replace: null }]);
}

export function demoRememberedReply(messages: ChatMessage[]): string | null {
  const latest = messages.findLast((message) => message.role === 'user')?.content;
  if (!latest || !/\bremember\b/i.test(latest)) return null;
  const block = /<character_memory>\n[^\n]*\n(\[[\s\S]*?\])\n<\/character_memory>/.exec(messages[0]?.content ?? '');
  if (!block) return null;
  try {
    const facts: unknown = JSON.parse(block[1]);
    if (!Array.isArray(facts) || !facts.length || facts.some((fact) => typeof fact !== 'string')) return null;
    return `*The captain opens the logbook.* “Here’s what I have from our earlier talks.”\n\n${facts.map((fact) => `• ${fact}`).join('\n')}`;
  } catch {
    return null;
  }
}
