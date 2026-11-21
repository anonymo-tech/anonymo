// What moved in is kept on this device, in IndexedDB (`anonymo.movein.v1`): browser storage for text is a few
// megabytes, and an export can be hundreds. Nothing here is sent anywhere. Live and demo imports are kept apart, as
// saved chats are (lib/anonymo/history.ts), and "Wipe this device" deletes the whole database.
//
// Three kinds of record, each under `<live|demo>:<id>`:
//   characters  a card, where it came from, and the list of its chats (title and message count, no text)
//   chats       one conversation's messages, read only when it is continued or summarized
//   boards      a character's memory board (memory.ts)
//
// The disk is an interface so the same logic runs on IndexedDB in the browser and on a plain map in the checks.

import type { CharacterCard } from '../card.ts';
import type { Board } from './memory.ts';
import type { FoundMessage, SourceId } from './types.ts';

export const ARCHIVE_DB = 'anonymo.movein.v1';
export const STORES = ['characters', 'chats', 'boards'] as const;
export type StoreName = (typeof STORES)[number];

/** A write: a value to put under a key, or no value to delete the key. */
export type DiskOp = { store: StoreName; key: string; value?: unknown };

export interface ArchiveDisk {
  get(store: StoreName, key: string): Promise<unknown>;
  entries(store: StoreName, prefix: string): Promise<[string, unknown][]>;
  keys(store: StoreName, prefix: string): Promise<string[]>;
  /** All or nothing. */
  commit(ops: DiskOp[]): Promise<void>;
}

export type ChatHead = { id: string; title: string; source: SourceId; messages: number; createdAt?: number; updatedAt?: number };

export type ArchiveCharacter = {
  /** The id the chat page knows the character by: the first 16 hex of its card's hash, as on the Characters page. */
  id: string;
  hash: string;
  name: string;
  source: SourceId;
  card: CharacterCard;
  /** True when the source had no card and Move In built one. */
  built: boolean;
  importedAt: string;
  /** Newest first. */
  chats: ChatHead[];
  messages: number;
};

export type ArchiveChat = { id: string; messages: FoundMessage[] };
export type ArchiveView = { characters: ArchiveCharacter[]; boards: Record<string, Board> };

export const scopeOf = (demo: boolean) => (demo ? 'demo:' : 'live:');
const keyOf = (demo: boolean, id: string) => scopeOf(demo) + id;

const isCharacter = (v: unknown): v is ArchiveCharacter => {
  const c = v as ArchiveCharacter | null;
  return !!c && typeof c.id === 'string' && typeof c.name === 'string' && !!c.card && Array.isArray(c.chats);
};
const isBoard = (v: unknown): v is Board => !!v && Array.isArray((v as Board).patches);

const newestOf = (head: ChatHead) => head.updatedAt ?? head.createdAt ?? 0;
export const byNewest = (a: ChatHead, b: ChatHead) => newestOf(b) - newestOf(a);

/** Everything the wall shows: characters with their chat lists, and the memory boards. No message text. */
export async function loadArchive(disk: ArchiveDisk, demo: boolean): Promise<ArchiveView> {
  const scope = scopeOf(demo);
  const [characters, boards] = await Promise.all([disk.entries('characters', scope), disk.entries('boards', scope)]);
  return {
    characters: characters
      .map(([, value]) => value)
      .filter(isCharacter)
      .sort((a, b) => b.importedAt.localeCompare(a.importedAt) || b.messages - a.messages || a.name.localeCompare(b.name)),
    boards: Object.fromEntries(boards.filter(([, value]) => isBoard(value)).map(([key, value]) => [key.slice(scope.length), value as Board])),
  };
}

export async function readChat(disk: ArchiveDisk, demo: boolean, id: string): Promise<ArchiveChat | null> {
  const value = (await disk.get('chats', keyOf(demo, id))) as ArchiveChat | undefined;
  return value && Array.isArray(value.messages) ? value : null;
}

export const writeChats = (disk: ArchiveDisk, demo: boolean, chats: ArchiveChat[]) =>
  disk.commit(chats.map((chat) => ({ store: 'chats' as const, key: keyOf(demo, chat.id), value: chat })));

/** Saves characters and boards in one step. `drop` names characters whose record and board go (their chats were handed on). */
export const writeCharacters = (disk: ArchiveDisk, demo: boolean, characters: ArchiveCharacter[], boards: Record<string, Board> = {}, drop: string[] = []) =>
  disk.commit([
    ...drop.flatMap((id) => [{ store: 'characters' as const, key: keyOf(demo, id) }, { store: 'boards' as const, key: keyOf(demo, id) }]),
    ...characters.map((c) => ({ store: 'characters' as const, key: keyOf(demo, c.id), value: c })),
    ...Object.entries(boards).map(([id, board]) => ({ store: 'boards' as const, key: keyOf(demo, id), value: board })),
  ]);

/** Saves a memory board, or removes it when it is null. */
export const writeBoard = (disk: ArchiveDisk, demo: boolean, characterId: string, board: Board | null) =>
  disk.commit([{ store: 'boards', key: keyOf(demo, characterId), ...(board ? { value: board } : {}) }]);

/** Removes a character with its chats and its memory. */
export const removeCharacter = (disk: ArchiveDisk, demo: boolean, character: Pick<ArchiveCharacter, 'id' | 'chats'>) =>
  disk.commit([
    { store: 'characters', key: keyOf(demo, character.id) },
    { store: 'boards', key: keyOf(demo, character.id) },
    ...character.chats.map((chat) => ({ store: 'chats' as const, key: keyOf(demo, chat.id) })),
  ]);

/** Removes everything that moved in, in this mode only. */
export async function clearArchive(disk: ArchiveDisk, demo: boolean): Promise<void> {
  const ops: DiskOp[] = [];
  for (const store of STORES) for (const key of await disk.keys(store, scopeOf(demo))) ops.push({ store, key });
  if (ops.length) await disk.commit(ops);
}

/** Chat text no character lists any more (an import that was stopped halfway) is deleted. */
export async function sweepOrphans(disk: ArchiveDisk, demo: boolean): Promise<number> {
  const scope = scopeOf(demo);
  const listed = new Set<string>();
  for (const [, value] of await disk.entries('characters', scope)) if (isCharacter(value)) for (const chat of value.chats) listed.add(scope + chat.id);
  const orphans = (await disk.keys('chats', scope)).filter((key) => !listed.has(key));
  if (orphans.length) await disk.commit(orphans.map((key) => ({ store: 'chats' as const, key })));
  return orphans.length;
}

/**
 * A character's messages across its chats, oldest first, for the memory build. With `newest`, only as many chats are
 * read (newest first) as it takes to reach that many messages.
 */
export async function historyOf(disk: ArchiveDisk, demo: boolean, character: Pick<ArchiveCharacter, 'chats'>, newest?: number): Promise<FoundMessage[]> {
  const chats = [...character.chats].sort(byNewest);
  const parts: FoundMessage[][] = [];
  let count = 0;
  for (const head of chats) {
    const chat = await readChat(disk, demo, head.id);
    if (!chat) continue;
    parts.unshift(chat.messages);
    count += chat.messages.length;
    if (newest && count >= newest) break;
  }
  const all = parts.flat();
  return newest ? all.slice(-newest) : all;
}

/** A disk in memory: for the checks, and for a browser that will not open IndexedDB (the import then lasts for the tab). */
export function memoryDisk(): ArchiveDisk & { size(): number } {
  const data = new Map<string, unknown>();
  const at = (store: StoreName, key: string) => `${store}\n${key}`;
  const within = (store: StoreName, prefix: string) => [...data.keys()].filter((k) => k.startsWith(at(store, prefix))).sort();
  return {
    async get(store, key) {
      return structuredClone(data.get(at(store, key)));
    },
    async entries(store, prefix) {
      return within(store, prefix).map((k) => [k.slice(store.length + 1), structuredClone(data.get(k))]);
    },
    async keys(store, prefix) {
      return within(store, prefix).map((k) => k.slice(store.length + 1));
    },
    async commit(ops) {
      for (const op of ops) {
        if ('value' in op && op.value !== undefined) data.set(at(op.store, op.key), structuredClone(op.value));
        else data.delete(at(op.store, op.key));
      }
    },
    size: () => data.size,
  };
}
