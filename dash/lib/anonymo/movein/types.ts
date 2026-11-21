// Update "movein": people bring their characters and chats from other apps. An export file is read in this browser
// and nothing is uploaded: every module in this folder runs on the device, and only ordinary chat calls ever leave it.
//
// A parser turns one file into the shapes below. It is a pure function behind its own detector, so each source can be
// checked against a small fixture (scripts/check-movein.mjs).

import type { CharacterCard } from '../card.ts';

export const SOURCES = {
  sillytavern: { label: 'SillyTavern', early: false },
  chatgpt: { label: 'ChatGPT', early: false },
  claude: { label: 'Claude', early: false },
  // Built from public descriptions of the export, not from a real file: see characterai.ts.
  characterai: { label: 'Character.AI', early: true },
  generic: { label: 'another app', early: false },
} as const;
export type SourceId = keyof typeof SOURCES;

/** One message as every parser returns it. `at` is epoch milliseconds, when the source carried a time. */
export type FoundMessage = { role: 'user' | 'assistant'; text: string; name?: string; at?: number };

/** A conversation found in a file, before it is tied to a character kept on this device. */
export type FoundChat = {
  source: SourceId;
  /** Stable inside its source, so importing the same export twice replaces a chat instead of doubling it. */
  key: string;
  title: string;
  /** The character this chat belongs to, by the name the source used. */
  character: string;
  createdAt?: number;
  updatedAt?: number;
  messages: FoundMessage[];
};

/** A character found in a file: a whole card when the source had one, else the parts a card is built from. */
export type FoundCharacter = {
  source: SourceId;
  name: string;
  card?: CharacterCard;
  description?: string;
  greeting?: string;
  /** A one-line tagline, kept as the card's personality. */
  personality?: string;
  /** Example dialogue, kept as the card's examples. */
  examples?: string;
  /** Replaces the default "write the next reply in a fictional chat" prompt, for sources that are not role-play. */
  systemPrompt?: string;
  /** What the source itself remembered (saved memories in an export): put on the memory board as patches to edit or delete. */
  memory?: { summary?: string; facts?: string[] };
  /** A card file's base name: SillyTavern names a character's chat folder after it. */
  fileBase?: string;
};

export type Found = { characters: FoundCharacter[]; chats: FoundChat[]; notes: string[] };

export const emptyFound = (): Found => ({ characters: [], chats: [], notes: [] });

// ---- small helpers every parser shares ------------------------------------------------------------------------------

export const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A short, stable id from any string (FNV-1a, two passes). Not secret: it only keeps re-imports from doubling. */
export function shortId(input: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ (c + i), 0x85ebca6b);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** How names are compared when a chat is matched to its character. */
export const nameKey = (name: string) => name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * A time from an export as epoch milliseconds: a number in seconds or milliseconds, an ISO string, SillyTavern's
 * "July 4, 2024 9:15pm" and its file-name stamp "2024-7-4@21h15m03s". Anything else is undefined.
 */
export function parseWhen(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  if (/^\d+(\.\d+)?$/.test(raw)) return parseWhen(Number(raw));
  const stamp = /^(\d{4})-(\d{1,2})-(\d{1,2})\s*@\s*(\d{1,2})h\s*(\d{1,2})m\s*(\d{1,2})s/.exec(raw);
  if (stamp) return localTime(+stamp[1]!, +stamp[2]!, +stamp[3]!, +stamp[4]!, +stamp[5]!, +stamp[6]!);
  const words = /^([A-Za-z]{3,9})\.? (\d{1,2}), (\d{4}),? (\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i.exec(raw);
  if (words) {
    const month = MONTHS.findIndex((m) => m.startsWith(words[1]!.toLowerCase().slice(0, 3)));
    if (month < 0) return undefined;
    const hour = (+words[4]! % 12) + (words[6]!.toLowerCase() === 'p' ? 12 : 0);
    return localTime(+words[3]!, month + 1, +words[2]!, hour, +words[5]!, 0);
  }
  // ISO 8601, and the looser form some exports write: a space for the "T", microseconds, "+00:00".
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?)(?:[.,](\d{1,9}))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i.exec(raw);
  if (!iso) return undefined;
  const time = iso[2] ? (iso[2].length === 5 ? `${iso[2]}:00` : iso[2]) : '';
  const zone = iso[4] ? (/^z$/i.test(iso[4]) ? 'Z' : iso[4].length === 3 ? `${iso[4]}:00` : iso[4].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')) : '';
  const parsed = Date.parse(time ? `${iso[1]}T${time}.${(iso[3] ?? '').padEnd(3, '0').slice(0, 3)}${zone}` : iso[1]!);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** A short title from what the person first wrote, for a chat whose source gave it none. */
export function snippetTitle(messages: FoundMessage[], fallback: string, max = 60): string {
  const first = messages.find((m) => m.role === 'user' && m.text.trim()) ?? messages.find((m) => m.text.trim());
  const body = (first?.text ?? '').replace(/\s+/g, ' ').trim();
  if (!body) return fallback;
  return body.length > max ? `${body.slice(0, max - 1).trimEnd()}…` : body;
}

function localTime(y: number, mo: number, d: number, h: number, mi: number, s: number): number | undefined {
  const t = new Date(y, mo - 1, d, h, mi, s).getTime();
  return Number.isNaN(t) ? undefined : t;
}
