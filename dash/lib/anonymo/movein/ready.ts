// A character that moved in is "ready" once its card is among the ones the chat page can pick: the same list the
// Characters page keeps in browser storage (lib/anonymo/characters-store.ts). That list is short (MAX_CARDS), while an
// import can bring hundreds, so the archive holds every card and this list holds the ones in use.

import { charactersStore, MAX_CARDS, saveCharacters, type StoredCharacter } from '../characters-store.ts';
import type { ArchiveCharacter } from './archive.ts';

const entryOf = (character: ArchiveCharacter): StoredCharacter => ({ id: character.id, hash: character.hash, card: character.card, importedAt: character.importedAt });

export type ReadyResult = 'ready' | 'full' | 'refused';

/**
 * Makes one character ready for chat. When the list is full, the place of the oldest character that is also in the
 * archive is taken (it can be made ready again any time); a card that exists only in the list is never pushed out.
 */
export function makeReady(character: ArchiveCharacter, archive: ArchiveCharacter[]): ReadyResult {
  const list = charactersStore.get();
  const at = list.findIndex((c) => c.id === character.id);
  if (at >= 0 && list[at]!.hash === character.hash) return 'ready';
  let next = at >= 0 ? list.map((c, i) => (i === at ? entryOf(character) : c)) : [entryOf(character), ...list];
  if (next.length > MAX_CARDS) {
    const restorable = new Set(archive.map((c) => c.id));
    const spare = next.findLastIndex((c) => c.id !== character.id && restorable.has(c.id));
    if (spare < 0) return 'full';
    next = next.filter((_, i) => i !== spare);
  }
  return saveCharacters(next) ? 'ready' : 'refused';
}

/** After an import: characters take the free places in the list, those with the most messages first. Nobody is pushed out. */
export function makeReadyWhereFree(characters: ArchiveCharacter[]): number {
  const list = charactersStore.get();
  const have = new Set(list.map((c) => c.id));
  const free = Math.max(0, MAX_CARDS - list.length);
  const add = [...characters].filter((c) => !have.has(c.id)).sort((a, b) => b.messages - a.messages).slice(0, free);
  // A card that changed (a built card that learned more) is refreshed where it already sits.
  const fresh = new Map(characters.map((c) => [c.id, c]));
  const kept = list.map((c) => (fresh.has(c.id) && fresh.get(c.id)!.hash !== c.hash ? entryOf(fresh.get(c.id)!) : c));
  if (!add.length && kept.every((c, i) => c === list[i])) return 0;
  return saveCharacters([...add.map(entryOf), ...kept]) ? add.length : 0;
}

/** Takes characters out of the chat list (they were removed from Move In, or a real card replaced a built one). */
export function dropReady(ids: string[]) {
  if (!ids.length) return;
  const gone = new Set(ids);
  const list = charactersStore.get();
  const next = list.filter((c) => !gone.has(c.id));
  if (next.length !== list.length) saveCharacters(next);
}

export const isReady = (list: StoredCharacter[], id: string) => list.some((c) => c.id === id);
