// Update "catchup": when a chat grows long, "Catch me up" asks the same model for a recap of it and continues in a fresh
// chat that starts from that recap. Long threads cost more on every reply (the whole thread is resent) and drift as
// they outgrow the model's memory; a recap keeps both in check. Everything here runs in the browser: the recap is an
// ordinary chat request, priced and checked like any other.

import type { ChatMessage } from './types.ts';

/** About four characters a token, the same rough rule the gateway's estimate uses. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export type TurnText = { prompt: string; content: string; recap?: boolean };

export function threadTokens(turns: TurnText[]): number {
  return turns.reduce((sum, t) => sum + estimateTokens(t.prompt) + estimateTokens(t.content), 0);
}

/** Past this, the bar suggests a recap. */
export const SUGGEST_TOKENS = 6000;
export const SUGGEST_TURNS = 16;
/** The button appears once there is something to recap. */
export const MIN_TURNS = 4;

export const suggestRecap = (turns: TurnText[]) => turns.length >= SUGGEST_TURNS || threadTokens(turns) >= SUGGEST_TOKENS;
export const canRecap = (turns: TurnText[]) => turns.length >= MIN_TURNS;

export const RECAP_INSTRUCTION = [
  'Write a recap of our conversation so far, so it can continue in a fresh chat that has no other context.',
  'Include: who is who (names, roles, relationships), the setting and the situation right now, key facts and decisions,',
  'plans or promises still open, and the tone and style to keep. If this is a story or role-play, stop exactly where the',
  'story stands now. Write plain notes, at most 350 words. Do not continue the story and do not answer anything new.',
].join(' ');

/** The request that asks for the recap: the thread so far, then the instruction. */
export const recapRequest = (thread: ChatMessage[]): ChatMessage[] => [...thread, { role: 'user', content: RECAP_INSTRUCTION }];

/** How a recap turn is sent as context at the start of the new chat. */
export function recapContext(summary: string): ChatMessage[] {
  return [
    { role: 'user', content: `Here is a recap of our earlier conversation. Continue from it as if nothing was lost.\n\n${summary.trim()}` },
    { role: 'assistant', content: 'Got it. I have the recap and will pick up from there.' },
  ];
}

/** "1.2k tokens" style label. */
export function tokenLabel(n: number) {
  return n < 1000 ? `${n} tokens` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k tokens`;
}
