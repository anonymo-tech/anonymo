// The fallback for apps with no parser of their own: any JSON that holds a list of messages, each with something that
// says who spoke (a role or sender, or a flag like `is_user`) and some text. One list is one chat; a list of objects
// that each hold such a list is several chats.

import { isObj, parseWhen, shortId, text, type FoundChat, type FoundMessage } from './types.ts';

const USER = new Set(['user', 'human', 'you', 'me', 'customer', 'prompter', 'player']);
const ASSISTANT = new Set(['assistant', 'ai', 'bot', 'gpt', 'model', 'character', 'char', 'chatbot', 'companion', 'narrator']);
const ROLE_KEYS = ['role', 'sender', 'from', 'author', 'speaker', 'type'];
const USER_FLAGS = ['is_user', 'isUser', 'is_human', 'isHuman', 'from_user', 'fromUser'];
const TEXT_KEYS = ['content', 'text', 'message', 'value', 'mes', 'body', 'raw_content'];
const LIST_KEYS = ['messages', 'conversation', 'conversations', 'chat', 'history', 'turns', 'log', 'msgs', 'dialogue'];
const TIME_KEYS = ['created_at', 'create_time', 'timestamp', 'time', 'date', 'send_date', 'createdAt'];
const NAME_KEYS = ['character', 'character_name', 'char_name', 'bot_name', 'botName', 'assistant_name'];

function roleOf(row: Record<string, unknown>): 'user' | 'assistant' | null {
  for (const key of USER_FLAGS) if (typeof row[key] === 'boolean') return row[key] ? 'user' : 'assistant';
  for (const key of ROLE_KEYS) {
    const raw = row[key];
    const value = (isObj(raw) ? text(raw.role) || text(raw.type) : text(raw)).trim().toLowerCase();
    if (USER.has(value)) return 'user';
    if (ASSISTANT.has(value)) return 'assistant';
  }
  return null;
}

function textOf(row: Record<string, unknown>): string {
  for (const key of TEXT_KEYS) {
    const raw = row[key];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    // OpenAI-style content parts: [{ type: "text", text: "…" }]
    if (Array.isArray(raw)) {
      const joined = raw.map((part) => (typeof part === 'string' ? part : isObj(part) ? text(part.text) : '')).filter((part) => part.trim()).join('\n').trim();
      if (joined) return joined;
    }
  }
  return '';
}

/** A row that reads as one message. */
export function genericMessage(row: unknown): FoundMessage | null {
  if (!isObj(row)) return null;
  const role = roleOf(row);
  const body = textOf(row);
  if (!role || !body) return null;
  const name = text(row.name).trim();
  let at: number | undefined;
  for (const key of TIME_KEYS) at ??= parseWhen(row[key]);
  return { role, text: body, ...(name ? { name } : {}), ...(at !== undefined ? { at } : {}) };
}

/** True when most of a list's rows read as messages. */
function isMessageList(rows: unknown): rows is unknown[] {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  const sample = rows.slice(0, 40);
  return sample.filter((row) => genericMessage(row)).length >= Math.max(1, Math.ceil(sample.length * 0.6));
}

/** The message list an object holds, directly or one level down (`{ chat: { messages: [...] } }`). */
function listIn(value: Record<string, unknown>, deep = true): unknown[] | null {
  for (const key of LIST_KEYS) if (isMessageList(value[key])) return value[key] as unknown[];
  if (deep)
    for (const key of LIST_KEYS) {
      const inner = value[key];
      const rows = isObj(inner) ? listIn(inner, false) : null;
      if (rows) return rows;
    }
  return null;
}

function chatFrom(rows: unknown[], holder: Record<string, unknown>, fallback: string, index: number): FoundChat | null {
  const messages = rows.map(genericMessage).filter((m): m is FoundMessage => m !== null);
  if (!messages.length) return null;
  const named =
    NAME_KEYS.map((key) => text(holder[key]).trim()).find(Boolean) ??
    (isObj(holder.character) ? text(holder.character.name).trim() : '') ??
    '';
  const speaker = named || messages.find((m) => m.role === 'assistant' && m.name)?.name;
  const title = text(holder.title).trim() || text(holder.name).trim() || (index ? `${fallback} ${index + 1}` : fallback);
  const first = messages.find((m) => m.at !== undefined)?.at;
  const last = [...messages].reverse().find((m) => m.at !== undefined)?.at;
  return {
    source: 'generic',
    key: text(holder.id) || text(holder.uuid) || shortId(`${title}\n${messages.length}\n${messages[0]!.text.slice(0, 200)}`),
    title,
    character: speaker || fallback,
    ...(first !== undefined ? { createdAt: first } : {}),
    ...(last !== undefined ? { updatedAt: last } : {}),
    messages,
  };
}

/** True when the JSON holds at least one list of messages this parser can read. */
export function detectGeneric(value: unknown): boolean {
  if (isMessageList(value)) return true;
  if (isObj(value)) return listIn(value) !== null;
  return Array.isArray(value) && value.slice(0, 20).some((item) => isObj(item) && listIn(item) !== null);
}

/** Every chat in the JSON. `label` names chats and the character when the file itself does not (its file name). */
export function parseGeneric(value: unknown, label = 'Imported chat'): FoundChat[] {
  if (isMessageList(value)) return [chatFrom(value, {}, label, 0)].filter((c): c is FoundChat => c !== null);
  if (isObj(value)) {
    const rows = listIn(value);
    return rows ? [chatFrom(rows, value, label, 0)].filter((c): c is FoundChat => c !== null) : [];
  }
  if (!Array.isArray(value)) return [];
  const out: FoundChat[] = [];
  value.forEach((item, i) => {
    const rows = isObj(item) ? listIn(item) : null;
    const chat = rows ? chatFrom(rows, item as Record<string, unknown>, label, i) : null;
    if (chat) out.push(chat);
  });
  return out;
}

/** JSONL where every line is one message (a chat log from a script or another frontend). */
export function parseGenericLines(source: string, label = 'Imported chat'): FoundChat[] {
  const rows: unknown[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // skip a damaged line
    }
  }
  const list: unknown = rows;
  return isMessageList(list) ? parseGeneric(list, label) : rows.flatMap((row) => parseGeneric(row, label));
}

/** A plain transcript with speaker labels on their own turns. Lines without a label continue the preceding turn. */
export function parseTranscript(source: string, character: string): FoundChat | null {
  const rows: { role: 'user' | 'assistant'; content: string }[] = [];
  let current: { role: 'user' | 'assistant'; content: string } | undefined;
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*([^:\r\n]{1,60}):\s*(.*)$/.exec(line);
    const speaker = match?.[1]?.trim().toLowerCase();
    if (match && speaker && (USER.has(speaker) || ASSISTANT.has(speaker) || speaker === character.trim().toLowerCase())) {
      current = { role: USER.has(speaker) ? 'user' : 'assistant', content: match[2] ?? '' };
      rows.push(current);
    } else if (current) {
      current.content += `\n${line}`;
    }
  }
  if (!rows.some((row) => row.role === 'user' && row.content.trim()) || !rows.some((row) => row.role === 'assistant' && row.content.trim())) return null;
  return chatFrom(rows, { id: shortId(source) }, character, 0);
}
