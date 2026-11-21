// Recent conversations are held only by the current tab. Durable history has its own opt-in store.
import type { Turn } from '../../components/dashboard/chat-types.ts';

export type TabChat = { id: string; turns: Turn[] };
export type TabChats = { active: TabChat; recent: TabChat[] };

export function freshTabChats(id: string): TabChats {
  return { active: { id, turns: [] }, recent: [] };
}

export function switchTabChat(
  state: TabChats,
  id: string,
  saved: Turn[] | undefined,
  rememberInTab: boolean,
): TabChats {
  if (
    state.active.id === id ||
    state.active.turns.some((turn) => turn.status === 'streaming')
  )
    return state;
  const prior = state.recent.find((chat) => chat.id === id);
  const recent = rememberInTab
    ? state.recent.filter((chat) => chat.id !== id)
    : [];
  if (rememberInTab && state.active.turns.length) recent.unshift(state.active);
  return {
    active: { id, turns: saved ?? prior?.turns ?? [] },
    recent: recent.slice(0, 12),
  };
}
