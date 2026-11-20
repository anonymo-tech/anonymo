// Chats saved in this browser (update "history"). Off unless the person turns it on: by default a conversation lives
// in the tab's memory only. When on, finished turns are written to localStorage on this device and nowhere else;
// nothing is sent to Anonymo, and "Wipe this device" removes it with everything else Anonymo keeps here.
// Live and demo chats are kept apart. Receipts are kept by id only (the gateway serves them); council seat texts and
// streaming turns are not kept.

import { deviceStore, readJson, writeJson } from './device-store.ts';

export type SavedTurn = {
  id: string;
  model: string;
  prompt: string;
  attachment: string | null;
  character: string | null;
  content: string;
  status: 'done' | 'stopped' | 'error';
  error: string | null;
  receiptId: string | null;
  councilMode: 'merge' | 'select' | null;
  recap?: boolean;
};
export type SavedChat = { id: string; title: string; createdAt: string; updatedAt: string; model: string; turns: SavedTurn[] };

/** The fields of a live turn that are saved. Kept structural so this file has no React or component imports. */
type TurnLike = Omit<SavedTurn, 'status'> & { status: string };

export const MAX_CHATS = 60;
/** Roughly 2.5 MB of JSON: localStorage holds about 5 MB per site, shared with keys, characters and receipts. */
export const MAX_BYTES = 2_500_000;
const TITLE_MAX = 60;

const keepSlot = 'anonymo.history.keep.v1';
const listSlot = (demo: boolean) => (demo ? 'anonymo.demo.history.v1' : 'anonymo.history.v1');

export function titleOf(turns: { prompt: string; character: string | null }[]): string {
  const first = turns.find((t) => t.prompt.trim());
  if (!first) return 'New chat';
  const text = first.prompt.replace(/\s+/g, ' ').trim();
  const title = text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1).trimEnd()}…` : text;
  return first.character ? `${first.character}: ${title}` : title;
}

/** Finished turns only, in the saved shape. A turn still streaming is left out until it ends. */
export function toSaved(turns: TurnLike[]): SavedTurn[] {
  const out: SavedTurn[] = [];
  for (const t of turns) {
    if (t.status !== 'done' && t.status !== 'stopped' && t.status !== 'error') continue;
    out.push({
      id: t.id,
      model: t.model,
      prompt: t.prompt,
      attachment: t.attachment,
      character: t.character,
      content: t.content,
      status: t.status,
      error: t.error,
      receiptId: t.receiptId,
      councilMode: t.councilMode,
      ...(t.recap ? { recap: true } : {}),
    });
  }
  return out;
}

/** Puts a chat first (newest), replacing an older copy, then trims to MAX_CHATS and MAX_BYTES by dropping the oldest. */
export function upsert(list: SavedChat[], chat: SavedChat, limits = { chats: MAX_CHATS, bytes: MAX_BYTES }): SavedChat[] {
  const next = [chat, ...list.filter((c) => c.id !== chat.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limits.chats);
  while (next.length > 1 && JSON.stringify(next).length > limits.bytes) next.pop();
  return next;
}

export function rename(list: SavedChat[], id: string, title: string): SavedChat[] {
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, 120);
  return clean ? list.map((c) => (c.id === id ? { ...c, title: clean } : c)) : list;
}

export const remove = (list: SavedChat[], id: string) => list.filter((c) => c.id !== id);

export function toMarkdown(chat: SavedChat): string {
  const lines = [`# ${chat.title}`, '', `_Saved from Anonymo on this device · ${chat.model} · ${chat.createdAt.slice(0, 10)}_`, ''];
  for (const t of chat.turns) {
    lines.push(`**You${t.character ? ` (to ${t.character})` : ''}:**`, '', t.prompt, '');
    if (t.content) lines.push(`**${t.character ?? t.model}:**`, '', t.content, '');
    if (t.status === 'error' && t.error) lines.push(`_Error: ${t.error}_`, '');
    if (t.receiptId) lines.push(`_Receipt: ${t.receiptId}_`, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export const toJson = (chat: SavedChat) => `${JSON.stringify({ format: 'anonymo-chat', version: 1, ...chat }, null, 2)}\n`;

/** A file name from the title: letters, digits and dashes only. */
export function fileNameOf(chat: SavedChat, ext: 'md' | 'json') {
  const base = chat.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'chat';
  return `anonymo-${base}.${ext}`;
}

function valid(c: unknown): c is SavedChat {
  const x = c as SavedChat;
  return !!x && typeof x.id === 'string' && typeof x.title === 'string' && typeof x.updatedAt === 'string' && Array.isArray(x.turns);
}

// ---- Storage -------------------------------------------------------------------------------------------------------
export const keepStore = deviceStore<boolean>(() => readJson<boolean>(keepSlot, false) === true, false);

export function loadChats(demo: boolean): SavedChat[] {
  const parsed = readJson<unknown>(listSlot(demo), []);
  return Array.isArray(parsed) ? parsed.filter(valid) : [];
}
const stores = { live: deviceStore<SavedChat[]>(() => loadChats(false), []), demo: deviceStore<SavedChat[]>(() => loadChats(true), []) };
export const chatsStore = (demo: boolean) => (demo ? stores.demo : stores.live);

function write(demo: boolean, list: SavedChat[]) {
  const ok = writeJson(listSlot(demo), list);
  chatsStore(demo).changed();
  return ok;
}

/** Turning keeping off also deletes what was kept, so "off" always means nothing is on this device. */
export function setKeep(on: boolean) {
  writeJson(keepSlot, on);
  keepStore.changed();
  if (!on) {
    for (const demo of [false, true]) {
      try {
        localStorage.removeItem(listSlot(demo));
      } catch {
        // storage blocked: nothing was kept
      }
      chatsStore(demo).changed();
    }
  }
}

export function saveChat(demo: boolean, id: string, turns: TurnLike[], createdAt?: string): boolean {
  const saved = toSaved(turns);
  if (!saved.length) return true;
  const now = new Date().toISOString();
  const prior = chatsStore(demo).get().find((c) => c.id === id);
  const chat: SavedChat = {
    id,
    title: prior?.title && prior.title !== titleOf(prior.turns) ? prior.title : titleOf(saved), // keep a rename
    createdAt: prior?.createdAt ?? createdAt ?? now,
    updatedAt: now,
    model: saved[saved.length - 1].model,
    turns: saved,
  };
  return write(demo, upsert(chatsStore(demo).get(), chat));
}

export const renameChat = (demo: boolean, id: string, title: string) => write(demo, rename(chatsStore(demo).get(), id, title));
export const deleteChat = (demo: boolean, id: string) => write(demo, remove(chatsStore(demo).get(), id));
export const deleteAllChats = (demo: boolean) => write(demo, []);

/** Every key Anonymo keeps in this browser starts with this prefix (key, chats, characters, receipts, choices). */
export const DEVICE_PREFIX = 'anonymo.';

/** "Wipe this device": removes everything Anonymo keeps in this browser's storage. Returns how many entries went. */
export function wipeDevice(storages: Storage[] = defaultStorages()): number {
  let removed = 0;
  for (const s of storages) {
    const doomed: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(DEVICE_PREFIX)) doomed.push(k);
    }
    for (const k of doomed) s.removeItem(k);
    removed += doomed.length;
  }
  return removed;
}

function defaultStorages(): Storage[] {
  const out: Storage[] = [];
  try {
    out.push(localStorage);
  } catch {
    // blocked
  }
  try {
    out.push(sessionStorage);
  } catch {
    // blocked
  }
  return out;
}
