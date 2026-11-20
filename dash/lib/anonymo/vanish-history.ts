import { readJson, writeJson } from './device-store.ts';
import { chatsStore, keepStore, loadChats, remove, upsert, writeChats } from './history.ts';
import { demoExpiringChat, VANISH_DEMO_SEEDED } from './vanish-demo.ts';
import { expiresAfter, hasExpired, type ExpiryChoice } from './vanish.ts';

export function sweepChatStores() {
  for (const demo of [false, true]) {
    loadChats(demo);
    chatsStore(demo).changed();
  }
}

/** Returns true when the new deadline deleted the chat immediately. Saving goes through the vault when it is on. */
export function setChatExpiry(demo: boolean, id: string, choice: ExpiryChoice): boolean {
  const chat = loadChats(demo).find((c) => c.id === id);
  if (!chat) return false;
  const next = { ...chat };
  delete next.expiresAt;
  const expiresAt = expiresAfter(chat.updatedAt, choice);
  if (expiresAt !== undefined) next.expiresAt = expiresAt;
  const gone = hasExpired(next);
  void writeChats(demo, (list) => (gone ? remove(list, id) : list.map((c) => (c.id === id ? { ...next, turns: c.turns } : c))));
  return gone;
}

export function seedDemoHistory() {
  if (!keepStore.get() || readJson(VANISH_DEMO_SEEDED, false)) return;
  void writeChats(true, (list) => upsert(list, demoExpiringChat())).then((ok) => {
    if (ok) writeJson(VANISH_DEMO_SEEDED, true);
  });
}
