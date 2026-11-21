// The Move In archive as the browser sees it: one copy in memory for the wall, the memory boards and the chat page,
// read from IndexedDB and kept in step across tabs. The chat page asks it, without waiting, for a character's memory.
//
// Wipes. "Wipe this device" (wipeDevice in device-store.ts, which the panic key's wipe also runs) deletes the
// database and announces it on the channel; this store then stops any import and forgets what it holds. As a second lock, a marker sits in browser
// storage under the `anonymo.` prefix that every wipe removes: when the marker is gone, anything still in the database
// is from before a wipe, so it is deleted before it can be read.

import { useEffect, useSyncExternalStore } from 'react';
import { cardHash, normalizeCard, type MemoryInput } from '../card.ts';
import { isDemoMode } from '../config.ts';
import { updateOn } from '../updates.ts';
import { clearArchive, loadArchive, memoryDisk, removeCharacter, writeBoard, writeCharacters, type ArchiveCharacter, type ArchiveDisk, type ArchiveView } from './archive.ts';
import { ARCHIVE_CHANNEL, dropArchiveDb, hasIndexedDb, idbDisk } from './archive-idb.ts';
import { boardMemory, type Board } from './memory.ts';

const KEPT = 'anonymo.movein.kept.v1';

export type MoveInState = { loaded: boolean; characters: ArchiveCharacter[]; boards: Record<string, Board> };
const EMPTY: MoveInState = { loaded: false, characters: [], boards: {} };
const state: { live: MoveInState; demo: MoveInState } = { live: EMPTY, demo: EMPTY };
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const slot = (demo: boolean) => (demo ? 'demo' : 'live');

function storageWorks(): boolean {
  try {
    localStorage.setItem(`${KEPT}.probe`, '1');
    localStorage.removeItem(`${KEPT}.probe`);
    return true;
  } catch {
    return false;
  }
}
const isKept = () => {
  try {
    return localStorage.getItem(KEPT) === '1';
  } catch {
    return false;
  }
};

// Without IndexedDB, or without the browser storage the wipe marker needs, an import lasts for this tab only.
let persistent: boolean | null = null;
let tabDisk = memoryDisk();
export function moveInPersists(): boolean {
  persistent ??= typeof window !== 'undefined' && hasIndexedDb() && storageWorks();
  return persistent;
}
export const archiveDisk = (): ArchiveDisk => (moveInPersists() ? idbDisk : tabDisk);

let channel: BroadcastChannel | null = null;
let listening = false;
function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(ARCHIVE_CHANNEL);
    channel.onmessage = (event: MessageEvent) => {
      // After a wipe nothing is read again: that would only create the database anew, empty.
      if (event.data === 'wiped') forgetEverything();
      else void reload();
    };
  }
  // Another tab wiped the device (the marker went with everything else).
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key === KEPT) void reload();
  });
}
const announce = () => channel?.postMessage('changed');

const afterPanic = () => typeof document !== 'undefined' && document.documentElement.hasAttribute('data-anonymo-panic');

/** Deletes what a wipe left behind. After this the database holds only what was written since the marker was set. */
async function guard() {
  if (!moveInPersists() || isKept()) return;
  await dropArchiveDb().catch(() => undefined);
}

const loading: { live: Promise<void> | null; demo: Promise<void> | null } = { live: null, demo: null };

/** Reads the archive for this mode into memory. Safe to call often: one read runs at a time. */
export function loadMoveIn(demo: boolean): Promise<void> {
  const key = slot(demo);
  listen();
  loading[key] ??= (async () => {
    let view: ArchiveView = { characters: [], boards: {} };
    try {
      await guard();
      // Nothing was ever kept: do not create a database just to find it empty.
      if (!moveInPersists() || isKept()) view = await loadArchive(archiveDisk(), demo);
    } catch {
      // Storage refused: the wall shows nothing rather than failing the page.
    }
    state[key] = { loaded: true, ...view };
    loading[key] = null;
    emit();
  })();
  return loading[key]!;
}

async function reload() {
  await Promise.all([state.live.loaded ? loadMoveIn(false) : null, state.demo.loaded ? loadMoveIn(true) : null]);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The archive for this mode, read again each time a page that shows it opens. */
export function useMoveIn(demo: boolean): MoveInState {
  useEffect(() => {
    void loadMoveIn(demo);
  }, [demo]);
  return useSyncExternalStore(
    subscribe,
    () => state[slot(demo)],
    () => EMPTY,
  );
}

/** Call before anything is written: clears what a wipe left behind, then sets the marker. False after the panic key. */
export async function beginWrite(): Promise<boolean> {
  if (afterPanic()) return false;
  await guard();
  if (moveInPersists()) localStorage.setItem(KEPT, '1');
  return true;
}

/** Call after the archive changed (an import finished): re-reads it here and tells other tabs. */
export async function archiveChanged(demo: boolean) {
  await loadMoveIn(demo);
  announce();
}

/**
 * What a character remembers, for the chat page: the `memory` option of buildCharacterMessages. Answers at once from
 * what is in memory; undefined when the update is off, the character has no board, or the board is empty.
 */
export function memoryFor(demo: boolean, characterId: string): MemoryInput | undefined {
  if (!updateOn('movein', demo)) return undefined;
  const current = state[slot(demo)];
  if (!current.loaded) void loadMoveIn(demo);
  return boardMemory(current.boards[characterId]);
}

/** Saves a board (or removes it with null). The copy in memory changes at once, so the next message uses it. */
export async function saveBoard(demo: boolean, characterId: string, board: Board | null): Promise<boolean> {
  if (!(await beginWrite())) return false;
  const key = slot(demo);
  const boards = { ...state[key].boards };
  if (board) boards[characterId] = board;
  else delete boards[characterId];
  state[key] = { ...state[key], boards };
  emit();
  try {
    await writeBoard(archiveDisk(), demo, characterId, board);
    announce();
    return true;
  } catch {
    return false;
  }
}

/**
 * Gives a character whose card Move In built a new name (an export that names nobody leaves "Unnamed character").
 * The character keeps its id, so its chats and memory stay with it. Null when nothing changed.
 */
export async function renameCharacter(demo: boolean, character: ArchiveCharacter, name: string): Promise<ArchiveCharacter | null> {
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!clean || clean === character.name || !(await beginWrite())) return null;
  const card = normalizeCard({ ...character.card, data: { ...character.card.data, name: clean } });
  const next: ArchiveCharacter = { ...character, name: clean, card, hash: await cardHash(card) };
  await writeCharacters(archiveDisk(), demo, [next]);
  await archiveChanged(demo);
  return next;
}

/** Removes one character that moved in: its chats and its memory. */
export async function forgetCharacter(demo: boolean, character: ArchiveCharacter) {
  await removeCharacter(archiveDisk(), demo, character);
  await archiveChanged(demo);
}

/** Removes everything that moved in, in this mode. */
export async function forgetAll(demo: boolean) {
  await clearArchive(archiveDisk(), demo);
  await archiveChanged(demo);
}

// A running import is stopped by a wipe, so nothing is written after it.
let stopImport: (() => void) | null = null;
export function importRunning(stop: (() => void) | null) {
  stopImport = stop;
}

/** After a wipe: a running import stops, so nothing is written after it, and nothing is held in memory. */
function forgetEverything() {
  stopImport?.();
  stopImport = null;
  tabDisk = memoryDisk();
  state.live = { ...EMPTY, loaded: true };
  state.demo = { ...EMPTY, loaded: true };
  emit();
}

// The chat page reads memory without waiting, so the boards are fetched as soon as this module loads in a browser
// where the update is on. Nothing is opened for someone who never moved anything in (see loadMoveIn).
if (typeof window !== 'undefined' && updateOn('movein', isDemoMode())) void loadMoveIn(isDemoMode());
