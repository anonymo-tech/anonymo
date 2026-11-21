// "Continue" opens an imported chat in the chat page. The chat page thinks in turns: one thing the person wrote and
// the reply to it (components/dashboard/chat-types.ts). An export is a flat list of messages, so they are paired here.

import type { Turn } from '../../../components/dashboard/chat-types.ts';
import { mentionsSelfHarm } from '../safety.ts';
import type { FoundMessage } from './types.ts';

export type PairedTurn = { prompt: string; content: string };

/** How many turns "Continue" loads. Anything earlier is carried by the character's memory, not sent again. */
export const RESUME_TURNS = 20;

/**
 * Messages as turns, in the order they were written.
 *   - A turn starts with what the person wrote, so no turn has an empty prompt. Several messages in a row from the
 *     same side are joined into one.
 *   - Lines the character spoke before the person said anything are left out. In nearly every export that is its
 *     greeting, which the card already puts at the top of every chat, so keeping it would say it twice; and a line
 *     with nothing from the person above it has no turn to sit in. It stays in the archive and in the memory build.
 *   - A last message with no reply stays, as a turn with an empty answer.
 */
export function pairTurns(messages: FoundMessage[]): PairedTurn[] {
  const turns: PairedTurn[] = [];
  let open: PairedTurn | null = null;
  for (const message of messages) {
    const body = message.text.trim();
    if (!body) continue;
    if (message.role === 'user') {
      if (open && !open.content) open.prompt = `${open.prompt}\n\n${body}`;
      else {
        open = { prompt: body, content: '' };
        turns.push(open);
      }
    } else if (open) open.content = open.content ? `${open.content}\n\n${body}` : body;
  }
  return turns;
}

export const lastTurns = (turns: PairedTurn[], count = RESUME_TURNS) => (count > 0 ? turns.slice(-count) : []);

/** The line a chat opens with when the character speaks first: what a built card uses as its greeting. */
export function openingLine(messages: FoundMessage[]): string {
  const first = messages.find((m) => m.text.trim());
  return first?.role === 'assistant' ? first.text.trim() : '';
}

/**
 * Paired turns as the chat page's turns: finished, with no receipt (nothing was spent) and the app they came from
 * where a model name would be. Crisis lines show next to a turn that mentions self-harm, as they do for a new message.
 */
export function toChatTurns(paired: PairedTurn[], from: { character: string; label: string }, newId: () => string): Turn[] {
  return paired.map((turn) => ({
    id: newId(),
    model: from.label,
    prompt: turn.prompt,
    attachment: null,
    character: from.character,
    content: turn.content,
    status: 'done',
    error: null,
    receiptId: null,
    receipt: null,
    council: null,
    councilMode: null,
    ...(mentionsSelfHarm(turn.prompt) ? { crisis: true } : {}),
  }));
}
