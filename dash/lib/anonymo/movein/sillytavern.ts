// SillyTavern chat logs (`.jsonl`): the first line is the chat's metadata, then one message per line with `name`,
// `is_user`, `is_system`, `send_date` and `mes`. Older builds wrote the names into the first line (`user_name`,
// `character_name`, `create_date`); current ones write the placeholder "unused" there and keep only `chat_metadata`,
// so the character is taken from who speaks in the log, or from the folder the log sits in.
// Character cards are Tavern cards, which card.ts already reads (JSON, or a PNG with a `chara`/`ccv3` chunk).

import { isObj, parseWhen, shortId, snippetTitle, text, type FoundChat, type FoundMessage } from './types.ts';

function lines(source: string): unknown[] {
  const out: unknown[] = [];
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      out.push(null); // one damaged line does not lose the chat
    }
  }
  return out;
}

const isHeader = (row: unknown) => isObj(row) && ('chat_metadata' in row || 'character_name' in row || 'user_name' in row) && !('mes' in row);
const isMessage = (row: unknown): row is Record<string, unknown> => isObj(row) && typeof row.mes === 'string' && ('is_user' in row || 'name' in row);

/** True for a JSONL text whose lines are SillyTavern messages (with or without the metadata line). */
export function detectSillyTavernChat(source: string): boolean {
  const first = lines(source.slice(0, 200_000)).filter((r) => r !== null).slice(0, 3);
  return first.some(isMessage) && (isHeader(first[0]) || isMessage(first[0]));
}

/** The folder and file a chat sits in: SillyTavern keeps `chats/<character>/<chat name>.jsonl`. */
function placeOf(path: string): { folder: string; base: string } {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  const file = parts.pop() ?? '';
  return { folder: parts.pop() ?? '', base: file.replace(/\.jsonl$/i, '') };
}

/** The folder a chat log sits in, when it names a character (a card's file name, which is how a chat finds its card). */
export const chatFolderOf = (path: string) => {
  const { folder } = placeOf(path);
  return /^(chats|group chats|backups)$/i.test(folder) ? '' : folder;
};

/** A name written into the header by a build that still did, not today's placeholder. */
const headerName = (value: unknown) => {
  const name = text(value).trim();
  return name && name.toLowerCase() !== 'unused' ? name : '';
};

/** A file name SillyTavern made up ("Juniper - 2026-10-02@23h10m04s") says nothing the date does not. */
const isStamped = (base: string) => /\d{4}-\d{1,2}-\d{1,2}\s*@\s*\d{1,2}h\s*\d{1,2}m/.test(base) || /^chat_\d+$/i.test(base);

/**
 * One chat log as a conversation. Hidden and system lines (`is_system`) are left out, as SillyTavern left them out of
 * the prompt. In a group chat every character's line is kept with its name, and the chat goes to whoever spoke most.
 */
export function parseSillyTavernChat(source: string, path = ''): FoundChat | null {
  const rows = lines(source);
  const header = isHeader(rows[0]) ? (rows[0] as Record<string, unknown>) : null;
  const { base } = placeOf(path);
  const folder = chatFolderOf(path);
  const messages: FoundMessage[] = [];
  const speakers = new Map<string, number>();
  for (const row of rows) {
    if (!isMessage(row) || row.is_system === true) continue;
    const body = text(row.mes).trim();
    if (!body) continue;
    const isUser = row.is_user === true;
    const name = text(row.name).trim();
    const at = parseWhen(row.send_date);
    messages.push({ role: isUser ? 'user' : 'assistant', text: body, ...(name ? { name } : {}), ...(at !== undefined ? { at } : {}) });
    if (!isUser && name) speakers.set(name, (speakers.get(name) ?? 0) + 1);
  }
  if (!messages.length) return null;
  const mostHeard = [...speakers.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const character = headerName(header?.character_name) || mostHeard || folder || 'Imported character';
  const createdAt = parseWhen(header?.create_date) ?? parseWhen(/\d{4}-\d{1,2}-\d{1,2}\s*@.*$/.exec(base)?.[0]) ?? messages.find((m) => m.at !== undefined)?.at;
  const updatedAt = [...messages].reverse().find((m) => m.at !== undefined)?.at ?? createdAt;
  return {
    source: 'sillytavern',
    key: shortId(`${character}\n${base}\n${messages.length > 1 ? messages[1]!.text.slice(0, 200) : messages[0]!.text.slice(0, 200)}`),
    title: base && !isStamped(base) ? base : snippetTitle(messages, `Chat with ${character}`),
    character,
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    messages,
  };
}
