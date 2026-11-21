// Character.AI. EARLY: nobody working on this has seen a real export file. Everything below is built from public
// descriptions (the help center, one published screenshot of `message.json`, and the source of community tools), so
// it is written defensively, sits behind its own detectors, and the page labels this source "early".
//
// The official export (Settings > Export Data) is a zip holding `data/user.json`, `data/character.json` and
// `data/message.json`. The zip is locked with a password (the account's email in lowercase), which a browser cannot
// open without asking for that address, so the person unzips it first and drops the JSON files.
//
//   message.json    one flat list for every chat, rows mixed together and not in time order. A row is
//                   { chat_id, candidate_id, raw_content, create_time, tti_image_rel_path }. It does NOT say who wrote
//                   the row, and it names no character. So rows are grouped by chat and sorted by time, and the
//                   speakers are inferred: the character opens with its greeting, then the two take turns. That is
//                   what other readers of this export do, and it is wrong for a chat where a reply was regenerated
//                   or the person wrote first.
//   character.json  the characters the account made (name, title, greeting, description, definition). A chat finds
//                   its character only by its opening line matching a greeting; a chat with someone else's character
//                   has no name anywhere and moves in as "Unnamed character".
//   user.json       the account (a name, an email). Never opened.
//
// Also read here, because many people saved their chats with a browser tool instead: the older chat-history shape
// ({ histories: [{ msgs: [{ src: { is_human, name }, text }] }] }, with or without `info.character`), the current one
// ({ turns: [{ author: { is_human, name }, candidates: [{ raw_content }], primary_candidate_id }] }), and tool exports
// that list chats whose messages carry `raw_content` and an `author`.

import { emptyFound, isObj, nameKey, parseWhen, snippetTitle, text, type Found, type FoundCharacter, type FoundChat, type FoundMessage } from './types.ts';

export const UNNAMED = 'Unnamed character';

// ---- the official export: message.json --------------------------------------------------------------------------

/** True for one row of `message.json`: text tied to a chat, with no author. */
export const detectCaiRow = (row: unknown): row is Record<string, unknown> =>
  isObj(row) && typeof row.chat_id === 'string' && typeof row.raw_content === 'string' && !('author' in row) && !('src' in row);

export type CaiRow = { chat: string; text: string; at: number | undefined; order: number };

/** A row reduced to what is used, so a large `message.json` is not held whole. */
export const caiRow = (row: Record<string, unknown>, order: number): CaiRow => ({ chat: text(row.chat_id), text: text(row.raw_content), at: parseWhen(row.create_time), order });

/**
 * Rows as chats: grouped by chat, oldest first, the character speaking first and then turn about. The chats carry no
 * character name; `openingOf` gives the line a chat can be matched to a greeting by.
 */
export function chatsFromRows(rows: CaiRow[]): FoundChat[] {
  const byChat = new Map<string, CaiRow[]>();
  for (const row of rows) {
    if (!row.chat) continue;
    const list = byChat.get(row.chat);
    if (list) list.push(row);
    else byChat.set(row.chat, [row]);
  }
  const chats: FoundChat[] = [];
  for (const [id, list] of byChat) {
    list.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.order - b.order);
    const messages: FoundMessage[] = [];
    list.forEach((row, i) => {
      const body = row.text.trim();
      // An empty row still takes its turn, or everything after it would change sides.
      if (body) messages.push({ role: i % 2 === 0 ? 'assistant' : 'user', text: body, ...(row.at !== undefined ? { at: row.at } : {}) });
    });
    if (!messages.length) continue;
    const first = list.find((r) => r.at !== undefined)?.at;
    const last = [...list].reverse().find((r) => r.at !== undefined)?.at;
    chats.push({
      source: 'characterai',
      key: id,
      title: snippetTitle(messages, 'Chat'),
      character: '',
      ...(first !== undefined ? { createdAt: first } : {}),
      ...(last !== undefined ? { updatedAt: last } : {}),
      messages,
    });
  }
  return chats;
}

/** The same text however it was spaced. */
const squash = (value: string) => value.replace(/\s+/g, ' ').trim();
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a chat's opening line is this greeting. A greeting may hold {{user}} or {{char}} where the chat has a name,
 * so those places match any short run of text.
 */
export function isGreeting(line: string, greeting: string): boolean {
  const wanted = squash(greeting);
  const got = squash(line);
  if (!wanted || !got) return false;
  if (wanted === got) return true;
  const pieces = wanted.split(/\{\{(?:user|char)\}\}|<(?:user|bot)>/i);
  if (pieces.length < 2 || pieces.join('').trim().length < 12) return false;
  return new RegExp(`^${pieces.map(escapeRe).join('.{1,60}?')}$`, 's').test(got);
}

// ---- the official export: character.json ------------------------------------------------------------------------

const characterList = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : isObj(value) && Array.isArray(value.characters) ? value.characters : null);
const isCaiCharacter = (c: unknown): c is Record<string, unknown> =>
  isObj(c) && (typeof c.greeting === 'string' || typeof c.definition === 'string') && (typeof c.name === 'string' || typeof c.title === 'string' || typeof c.participant__name === 'string') && !('first_mes' in c) && !('spec' in c);

/** True for `character.json`: a list of characters with a greeting or a definition. */
export const detectCaiCharacters = (value: unknown): boolean => (characterList(value) ?? []).slice(0, 20).some(isCaiCharacter);

function characterOf(raw: Record<string, unknown>): FoundCharacter | null {
  const name = (text(raw.name) || text(raw.participant__name) || text(raw.title)).trim();
  if (!name) return null;
  const tagline = text(raw.title).trim();
  return {
    source: 'characterai',
    name,
    description: text(raw.description).trim(),
    greeting: text(raw.greeting).trim(),
    // The mapping character tools settled on: the tagline as personality, the definition as example dialogue.
    ...(tagline && tagline !== name ? { personality: tagline } : {}),
    ...(text(raw.definition).trim() ? { examples: text(raw.definition).trim() } : {}),
  };
}

export const parseCaiCharacters = (value: unknown): FoundCharacter[] => (characterList(value) ?? []).filter(isCaiCharacter).map(characterOf).filter((c): c is FoundCharacter => c !== null);

// ---- what browser tools saved ---------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;

const historiesOf = (value: unknown): unknown[] | null => {
  if (!isObj(value)) return null;
  if (isObj(value.histories) && Array.isArray(value.histories.histories)) return value.histories.histories;
  return Array.isArray(value.histories) && value.histories.some((h) => isObj(h) && Array.isArray(h.msgs)) ? value.histories : null;
};
const hasTurns = (value: unknown): value is Rec => isObj(value) && Array.isArray(value.turns) && value.turns.some((t) => isObj(t) && isObj(t.author) && Array.isArray(t.candidates));
const hasAuthoredChats = (value: unknown): value is Rec =>
  isObj(value) && Array.isArray(value.chats) && value.chats.some((c) => isObj(c) && Array.isArray(c.messages) && c.messages.some((m) => isObj(m) && typeof m.raw_content === 'string' && isObj(m.author)));

/** True for anything this file reads other than the rows of `message.json` (those are streamed: see detectCaiRow). */
export const detectCharacterAi = (value: unknown): boolean => detectCaiCharacters(value) || historiesOf(value) !== null || hasTurns(value) || hasAuthoredChats(value);

const mostHeard = (messages: FoundMessage[]) => {
  const counts = new Map<string, number>();
  for (const m of messages) if (m.role === 'assistant' && m.name) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
};

function chatOf(key: string, messages: FoundMessage[], character: string, when: { created?: unknown; updated?: unknown } = {}): FoundChat | null {
  if (!messages.length) return null;
  const createdAt = parseWhen(when.created) ?? messages.find((m) => m.at !== undefined)?.at;
  const updatedAt = parseWhen(when.updated) ?? [...messages].reverse().find((m) => m.at !== undefined)?.at ?? createdAt;
  return {
    source: 'characterai',
    key,
    title: snippetTitle(messages, 'Chat'),
    character,
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    messages,
  };
}

/** Everything in a parsed file that is one of the shapes above. `label` names a character the file does not. */
export function parseCharacterAi(value: unknown, label = UNNAMED): Found {
  const found = emptyFound();
  if (detectCaiCharacters(value)) found.characters.push(...parseCaiCharacters(value));
  const fallback = label.replace(/[_-]+/g, ' ').replace(/\b(tavern|oobabooga|caidump|caidumpanon|chat|history)\b/gi, ' ').replace(/\s+/g, ' ').trim() || UNNAMED;

  const histories = historiesOf(value);
  if (histories) {
    const info = isObj(value) && isObj((value as Rec).info) ? ((value as Rec).info as Rec) : null;
    const described = info && isObj(info.character) ? characterOf(info.character) : null;
    if (described) found.characters.push(described);
    histories.forEach((history, i) => {
      if (!isObj(history) || !Array.isArray(history.msgs)) return;
      const messages: FoundMessage[] = [];
      for (const raw of history.msgs) {
        // An alternative is a reply that was swiped away, not part of the chat as it was read.
        if (!isObj(raw) || raw.is_alternative === true) continue;
        const body = text(raw.text).trim();
        const src = isObj(raw.src) ? raw.src : {};
        if (!body || typeof src.is_human !== 'boolean') continue;
        const name = text(src.name).trim();
        messages.push({ role: src.is_human ? 'user' : 'assistant', text: body, ...(name ? { name } : {}) });
      }
      const chat = chatOf(text(history.external_id) || `${fallback}:${i}`, messages, described?.name || mostHeard(messages) || fallback, { created: history.created, updated: history.last_interaction });
      if (chat) found.chats.push(chat);
    });
  }

  const turnsToMessages = (turns: unknown[]): FoundMessage[] => {
    const rows: { message: FoundMessage; order: number }[] = [];
    turns.forEach((turn, order) => {
      if (!isObj(turn) || !isObj(turn.author) || !Array.isArray(turn.candidates)) return;
      const candidates = turn.candidates.filter(isObj);
      const shown = candidates.find((c) => c.candidate_id === turn.primary_candidate_id) ?? candidates.find((c) => c.is_final === true) ?? candidates.at(-1);
      const body = text(shown?.raw_content).trim();
      if (!body) return;
      const at = parseWhen(turn.create_time);
      const name = text(turn.author.name).trim();
      rows.push({ message: { role: turn.author.is_human === true ? 'user' : 'assistant', text: body, ...(name ? { name } : {}), ...(at !== undefined ? { at } : {}) }, order });
    });
    // The site lists turns newest first; with times they are put in order, without them the list is turned round.
    const timed = rows.every((r) => r.message.at !== undefined);
    if (timed) rows.sort((a, b) => a.message.at! - b.message.at! || b.order - a.order);
    else if (rows.length > 1 && rows[0]!.message.role === 'user' && rows.at(-1)!.message.role === 'assistant') rows.reverse();
    return rows.map((r) => r.message);
  };

  if (hasTurns(value)) {
    const messages = turnsToMessages(value.turns as unknown[]);
    const firstTurn = (value.turns as unknown[]).find(isObj);
    const id = firstTurn && isObj(firstTurn.turn_key) ? text(firstTurn.turn_key.chat_id) : '';
    const chat = chatOf(id || `${fallback}:turns`, messages, mostHeard(messages) || fallback);
    if (chat) found.chats.push(chat);
  }

  if (hasAuthoredChats(value)) {
    const names = new Map<string, string>();
    for (const raw of Array.isArray(value.characters) ? value.characters : []) {
      if (!isObj(raw)) continue;
      const described = characterOf(raw);
      if (!described) continue;
      if (!found.characters.some((c) => nameKey(c.name) === nameKey(described.name))) found.characters.push(described);
      if (text(raw.external_id)) names.set(text(raw.external_id), described.name);
    }
    (value.chats as unknown[]).forEach((raw, i) => {
      if (!isObj(raw) || !Array.isArray(raw.messages)) return;
      const messages: FoundMessage[] = [];
      for (const m of raw.messages) {
        if (!isObj(m) || !isObj(m.author)) continue;
        const body = text(m.raw_content).trim();
        if (!body) continue;
        const at = parseWhen(m.create_time);
        const name = text(m.author.name).trim();
        messages.push({ role: m.author.is_human === true ? 'user' : 'assistant', text: body, ...(name ? { name } : {}), ...(at !== undefined ? { at } : {}) });
      }
      const character = text(raw.character_name).trim() || names.get(text(raw.character_id)) || mostHeard(messages) || fallback;
      const chat = chatOf(text(raw.chat_id) || `${fallback}:${i}`, messages, character);
      if (chat) found.chats.push(chat);
    });
  }
  return found;
}
