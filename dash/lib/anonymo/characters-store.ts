// Imported character cards live on this device only (normalized JSON, no image). The workspace builds the character
// prompt locally (card.ts, shared with the gateway) and sends it as ordinary chat messages to anonymo-rp.

import { CardError, normalizeCard, readCardFromPng, type CharacterCard } from './card.ts';
import { deviceStore, readJson, writeJson } from './device-store.ts';

const STORE = 'anonymo.characters.v1';
export const MAX_CARDS = 30;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export type StoredCharacter = { id: string; hash: string; card: CharacterCard; importedAt: string };

export function loadCharacters(): StoredCharacter[] {
  const parsed = readJson<unknown>(STORE, []);
  return Array.isArray(parsed) ? (parsed as StoredCharacter[]).filter((c) => c && typeof c.id === 'string') : [];
}

export const charactersStore = deviceStore<StoredCharacter[]>(loadCharacters, []);

/** Returns false when the browser would not store the list (too large, or storage blocked). */
export function saveCharacters(list: StoredCharacter[]) {
  const ok = writeJson(STORE, list.slice(0, MAX_CARDS));
  charactersStore.changed();
  return ok;
}

/** Reads a Tavern card (V1/V2/V3 JSON, or a PNG with a `chara`/`ccv3` chunk). Throws CardError with a plain message. */
export async function readCardFile(file: File): Promise<CharacterCard> {
  if (file.size > MAX_FILE_BYTES) throw new CardError('Choose a card smaller than 8 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isPng = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (isPng) return readCardFromPng(bytes);
  return normalizeCard(new TextDecoder().decode(bytes));
}
