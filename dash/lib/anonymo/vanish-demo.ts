import type { SavedChat } from './history.ts';
import { expiresAfter, MINUTE_MS } from './vanish.ts';

export const VANISH_DEMO_SEEDED = 'anonymo.demo.vanish-seeded.v1';

export function demoExpiringChat(now = Date.now()): SavedChat {
  const updatedAt = new Date(now - 58 * MINUTE_MS).toISOString();
  const prompt = 'Plan a quiet morning by the coast';
  return {
    id: 'demo-coastal-morning',
    title: prompt,
    createdAt: updatedAt,
    updatedAt,
    expiresAt: expiresAfter(updatedAt, 'hour'),
    model: 'anonymo-1',
    turns: [{
      id: 'demo-coastal-morning-reply',
      model: 'anonymo-1',
      prompt,
      attachment: null,
      character: null,
      content: 'Start with coffee by the harbor before the boats go out. Follow the shoreline to the lighthouse, then stop for a warm pastry on the walk back.',
      status: 'done',
      error: null,
      receiptId: null,
      councilMode: null,
    }],
  };
}
