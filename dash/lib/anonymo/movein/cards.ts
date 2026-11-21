// Characters that move in become Tavern cards, the same cards the Characters page keeps (lib/anonymo/characters-store.ts).
// A source that has no card gets a V2 card built from a name, a description and a greeting.

import { CardError, normalizeCard, readCardFromPng, type CharacterCard } from '../card.ts';
import { SOURCES, isObj, type FoundCharacter } from './types.ts';

/** A card file's bytes as a card: a PNG with a `chara`/`ccv3` chunk, or card JSON. The same rule as readCardFile. */
export function readCardBytes(bytes: Uint8Array): CharacterCard {
  const isPng = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (isPng) return readCardFromPng(bytes);
  return normalizeCard(new TextDecoder().decode(bytes));
}

/**
 * True for parsed JSON that is a Tavern card: a spec'd V2/V3 card, or V1's flat fields. A name and a description alone
 * are not enough (plenty of other JSON has those): a V1 card also has its greeting or two more of its own fields.
 */
export function detectCard(value: unknown): boolean {
  if (!isObj(value)) return false;
  if (value.spec === 'chara_card_v2' || value.spec === 'chara_card_v3') return isObj(value.data) && typeof value.data.name === 'string';
  if (value.spec !== undefined) return false;
  const flat = isObj(value.data) && typeof value.data.name === 'string' ? value.data : value;
  if (typeof flat.name !== 'string' || !flat.name.trim()) return false;
  const own = ['personality', 'scenario', 'mes_example'].filter((key) => typeof flat[key] === 'string').length;
  return typeof flat.first_mes === 'string' || own >= 2;
}

/** A V2 card for a character whose source had none. */
export function buildCard(found: Pick<FoundCharacter, 'name' | 'description' | 'greeting' | 'personality' | 'examples' | 'systemPrompt' | 'source'>): CharacterCard {
  return normalizeCard({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: found.name.trim() || 'Unnamed character',
      description: (found.description ?? '').trim(),
      personality: (found.personality ?? '').trim(),
      first_mes: (found.greeting ?? '').trim(),
      mes_example: (found.examples ?? '').trim(),
      system_prompt: found.systemPrompt ?? '',
      creator_notes: `Built on this device by Move In from a ${SOURCES[found.source].label} export.`,
      tags: ['moved in'],
    },
  });
}

/** The card of a found character: its own, or one built from its parts. Throws CardError for a card with no name. */
export const cardOf = (found: FoundCharacter): CharacterCard => found.card ?? buildCard(found);

// A character has no picture here, so each gets a ring colour from its name: the same name always wears the same felt.
const FELT = ['#f6b84b', '#ff8fb8', '#8fd3a6', '#8fc7ff', '#c9a7ff', '#ffb48a', '#f3e6dc', '#7fe0d0'];

export function ringOf(name: string): string {
  let h = 0x811c9dc5;
  for (const ch of name.trim().toLowerCase()) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193);
  // Mix the bits, so names that differ only a little still pick different felt.
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return FELT[(h >>> 0) % FELT.length]!;
}

export { CardError, normalizeCard };
