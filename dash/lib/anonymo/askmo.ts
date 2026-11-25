import { citationsOf } from './search.ts';
import type { ChatCompletion } from './types.ts';

export const ASK_TOPICS = {
  health: 'Health',
  legal: 'Legal',
  money: 'Money & tax',
  relationships: 'Relationships',
  negotiation: 'Negotiation',
  feedback: 'Feedback',
} as const;

export type AskTopic = keyof typeof ASK_TOPICS;
export type AskMoRequest = { question: string; topic: AskTopic | null };

export function readAskMoReply(reply: ChatCompletion) {
  const message = reply.choices?.[0]?.message;
  const receipt = reply.anonymo_receipt?.payload ?? null;
  return {
    text: message?.content ?? '',
    sources: citationsOf(message?.annotations),
    receipt,
    receiptId: receipt?.request_id ?? null,
    model: reply.model,
    council: reply.council ?? null,
  };
}
export type AskMoReply = ReturnType<typeof readAskMoReply>;

export function answerSections(text: string): { heading?: string; body: string }[] {
  const heading = /^## (What a professional would check|Region notes)$/gm;
  const sections: { heading?: string; body: string }[] = [];
  let label: string | undefined;
  let from = 0;
  for (const match of text.matchAll(heading)) {
    const body = text.slice(from, match.index).trim();
    if (body) sections.push({ heading: label, body });
    label = match[1];
    from = match.index + match[0].length;
  }
  const body = text.slice(from).trim();
  if (body) sections.push({ heading: label, body });
  return sections;
}
