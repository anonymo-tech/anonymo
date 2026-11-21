// "What <name> remembers": a summary and short facts for each character that moved in, kept on this device and sent
// with every message to that character (card.ts puts them in the system message). The person can edit, pin, delete and
// add patches. "Build memory" writes them from the imported chats: the history is cut into chunks, each chunk is folded
// into a running summary with card.ts's summaryRequest, and one small request then asks for the facts. These are
// ordinary chat calls: priced, receipted and floor-checked like any other.

import { memoryForPrompt, messageText, summaryRequest, type ChatMessage as LogLine, type MemoryInput } from '../card.ts';
import { estimateTokens } from '../catchup.ts';
import type { ChatMessage, ChatRequest } from '../types.ts';
import type { FoundMessage } from './types.ts';

// ---- the board --------------------------------------------------------------------------------------------------

export type Patch = {
  id: string;
  kind: 'summary' | 'fact';
  text: string;
  pinned: boolean;
  /** Who wrote it: a model during a build, the person, or the export it came with. */
  by: 'model' | 'you' | 'export';
  at: number;
};
/** Where a build stopped, so it can carry on from the same place instead of paying for the start again. */
export type Unfinished = { done: number; of: number; plan: string; costMusd: number };
export type BuiltNote = { at: number; model: string; messages: number; requests: number; costMusd: number };
export type Board = { patches: Patch[]; built?: BuiltNote; unfinished?: Unfinished };

export const PATCH_MAX_CHARS = 2000;
/** At most this many facts ride along with a message; pinned ones go first. */
export const SENT_FACTS = 24;

export const emptyBoard = (): Board => ({ patches: [] });
const clean = (text: string) => text.replace(/\r\n?/g, '\n').trim().slice(0, PATCH_MAX_CHARS);

/** A rebuild replaces only what a model wrote and the person has not pinned. */
export const isProtected = (patch: Patch) => patch.pinned || patch.by !== 'model';

export const summaryOf = (board: Board) => board.patches.find((p) => p.kind === 'summary');

/** The board as the `memory` a character prompt takes: the summary, then the facts, pinned first. */
export function boardMemory(board: Board | undefined): MemoryInput | undefined {
  if (!board) return undefined;
  const live = board.patches.filter((p) => p.text.trim());
  if (!live.length) return undefined;
  const ordered = [...live.filter((p) => p.pinned), ...live.filter((p) => !p.pinned)];
  const memory = memoryForPrompt(ordered.map((p) => ({ kind: p.kind, text: p.text.trim(), at: p.at })));
  return { ...(memory.summary ? { summary: memory.summary } : {}), facts: (memory.facts ?? []).slice(0, SENT_FACTS) };
}

export function addPatch(board: Board, text: string, id: string, now: number, by: Patch['by'] = 'you'): Board {
  const body = clean(text);
  if (!body) return board;
  return { ...board, patches: [...board.patches, { id, kind: 'fact', text: body, pinned: false, by, at: now }] };
}

/** Editing makes a patch the person's own, so a rebuild leaves it alone. An emptied patch is removed. */
export function editPatch(board: Board, id: string, text: string, now: number): Board {
  const body = clean(text);
  if (!body) return removePatch(board, id);
  return { ...board, patches: board.patches.map((p) => (p.id === id && p.text !== body ? { ...p, text: body, by: 'you', at: now } : p)) };
}

export const pinPatch = (board: Board, id: string, pinned: boolean): Board => ({ ...board, patches: board.patches.map((p) => (p.id === id ? { ...p, pinned } : p)) });
export const removePatch = (board: Board, id: string): Board => ({ ...board, patches: board.patches.filter((p) => p.id !== id) });

/** Memory that came inside an export, as patches. Nothing is added twice. */
export function withExportMemory(board: Board, memory: { summary?: string; facts?: string[] } | undefined, newId: () => string, now: number): Board {
  if (!memory) return board;
  const have = new Set(board.patches.map((p) => p.text));
  const patches = [...board.patches];
  const summary = clean(memory.summary ?? '');
  if (summary && !have.has(summary) && !summaryOf(board)) patches.push({ id: newId(), kind: 'summary', text: summary, pinned: false, by: 'export', at: now });
  for (const fact of memory.facts ?? []) {
    const body = clean(fact);
    if (!body || have.has(body)) continue;
    have.add(body);
    patches.push({ id: newId(), kind: 'fact', text: body, pinned: false, by: 'export', at: now });
  }
  return patches.length === board.patches.length ? board : { ...board, patches };
}

/**
 * The board after a build step. A new summary replaces the model's last one; new facts replace the model's unpinned
 * ones. Pinned patches, the person's own and the ones that came with an export are never touched.
 */
export function applyBuild(board: Board, result: { summary?: string; facts?: string[] }, newId: () => string, now: number): Board {
  let patches = board.patches;
  const summary = clean(result.summary ?? '');
  if (summary) {
    const kept = summaryOf(board);
    if (!kept || !isProtected(kept)) patches = [{ id: kept?.id ?? newId(), kind: 'summary', text: summary, pinned: false, by: 'model', at: now }, ...patches.filter((p) => p.kind !== 'summary')];
  }
  if (result.facts) {
    patches = patches.filter((p) => p.kind !== 'fact' || isProtected(p));
    const have = new Set(patches.map((p) => p.text.toLowerCase()));
    for (const fact of result.facts) {
      const body = clean(fact);
      if (!body || have.has(body.toLowerCase())) continue;
      have.add(body.toLowerCase());
      patches.push({ id: newId(), kind: 'fact', text: body, pinned: false, by: 'model', at: now });
    }
  }
  return { ...board, patches };
}

// ---- the build --------------------------------------------------------------------------------------------------

/** The start of card.ts's summary instruction. The demo gateway recognizes a summary request by it. */
export const SUMMARY_MARKER = 'Update the running summary of a role-play chat.';
/** The start of the facts instruction below, for the same reason. */
export const FACTS_MARKER = 'List what is worth remembering from a role-play chat.';

export const CHUNK_CHARS = 24_000;
export const SUMMARY_WORDS = 200;
export const SUMMARY_MAX_TOKENS = 420;
export const FACTS_MAX = 12;
export const FACTS_MAX_TOKENS = 360;
/** How much of the newest history the facts request reads beside the summary. */
const RECENT_CHARS = 6000;

const lineOf = (line: LogLine) => `${line.name ?? line.role}: ${messageText(line.content)}`;

/** Imported messages as the log lines a summary request takes, each under the name that spoke it. */
export function toLog(messages: FoundMessage[], character: string): LogLine[] {
  return messages.filter((m) => m.text.trim()).map((m) => ({ role: m.role, content: m.text.trim(), name: m.name?.trim() || (m.role === 'user' ? 'User' : character) }));
}

/** The log cut into pieces of about `maxChars`, never splitting a message. One longer than a piece is shortened. */
export function chunkLog(log: LogLine[], maxChars = CHUNK_CHARS): LogLine[][] {
  const chunks: LogLine[][] = [];
  let current: LogLine[] = [];
  let size = 0;
  for (const line of log) {
    let entry = line;
    let length = lineOf(entry).length + 1;
    if (length > maxChars) {
      const room = Math.max(0, maxChars - (entry.name ?? entry.role).length - 8);
      entry = { ...entry, content: `${messageText(entry.content).slice(0, room)} […]` };
      length = lineOf(entry).length + 1;
    }
    if (current.length && size + length > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(entry);
    size += length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** One step of the running summary: card.ts's request, with a cap on the reply so its cost is known beforehand. */
export function summaryStep(model: string, previous: string, chunk: LogLine[]): ChatRequest {
  const request = summaryRequest(model, previous, chunk, SUMMARY_WORDS);
  return { model: request.model, messages: request.messages as ChatMessage[], temperature: request.temperature, max_tokens: SUMMARY_MAX_TOKENS };
}

/** The one request that asks for short facts, from the summary and the newest turns. */
export function factsRequest(model: string, character: string, summary: string, recent: LogLine[], max = FACTS_MAX): ChatRequest {
  return {
    model,
    messages: [
      {
        role: 'system',
        content: `${FACTS_MARKER} Write at most ${max} short facts ${character} should remember: names, likes and dislikes, promises, shared history, where things stand now. One fact per line, at most 18 words each. No numbering, no headings, nothing else.`,
      },
      { role: 'user', content: `Summary:\n${summary.trim() || '(none)'}\n\nNewest turns:\n${recent.map(lineOf).join('\n') || '(none)'}` },
    ],
    temperature: 0.2,
    max_tokens: FACTS_MAX_TOKENS,
  };
}

/** The newest lines of a log, up to a size, for the facts request. */
export function recentLines(log: LogLine[], maxChars = RECENT_CHARS): LogLine[] {
  const out: LogLine[] = [];
  let size = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    size += lineOf(log[i]!).length + 1;
    if (out.length && size > maxChars) break;
    out.unshift(log[i]!);
  }
  return chunkLog(out, maxChars).at(-1) ?? [];
}

/** A model's reply to the facts request as a list: one per line, bullets and numbers removed, no repeats. */
export function parseFacts(reply: string, max = FACTS_MAX): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of reply.split(/\r?\n/)) {
    const fact = raw
      .replace(/^\s*(?:[-*•–—]+|\d{1,2}[.)])\s*/, '')
      .replace(/^["“”']+|["“”']+$/g, '')
      .trim();
    if (!fact || fact.endsWith(':') || fact.length > 300) continue;
    const key = fact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
    if (out.length >= max) break;
  }
  return out;
}

export type BuildPlan = {
  /** The pieces of history the running summary is built from; empty when only the facts are rebuilt. */
  chunks: LogLine[][];
  recent: LogLine[];
  messages: number;
  requests: number;
  /** Estimated tokens sent, and the most the replies can be. */
  tokensIn: number;
  tokensOut: number;
  /** The same per request, in the order they are sent: `[tokens in, most tokens out]`. */
  steps: [number, number][];
  /** Identifies this exact plan, so a stopped build can only resume the plan it stopped in. */
  id: string;
};

/**
 * What a build will send. `newest` limits it to the newest messages; `summary: false` skips the running summary (the
 * board already has one the build must not replace) and asks only for facts.
 */
export function planBuild(messages: FoundMessage[], character: string, opts: { newest?: number; summary?: boolean; maxChars?: number } = {}): BuildPlan {
  const scoped = opts.newest && opts.newest > 0 ? messages.slice(-opts.newest) : messages;
  const log = toLog(scoped, character);
  const chunks = opts.summary === false ? [] : chunkLog(log, opts.maxChars ?? CHUNK_CHARS);
  const recent = recentLines(log);
  // Every step but the first also carries the summary so far, which is at most SUMMARY_WORDS long.
  const carried = SUMMARY_WORDS * 7;
  const sent = (request: ChatRequest) => request.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const steps: [number, number][] = chunks.map((chunk, i) => [sent(summaryStep('', i === 0 ? '' : 'x'.repeat(carried), chunk)), SUMMARY_MAX_TOKENS]);
  if (log.length) steps.push([sent(factsRequest('', character, 'x'.repeat(carried), recent)), FACTS_MAX_TOKENS]);
  const last = log.at(-1);
  return {
    chunks,
    recent,
    messages: log.length,
    requests: steps.length,
    tokensIn: steps.reduce((sum, step) => sum + step[0], 0),
    tokensOut: steps.reduce((sum, step) => sum + step[1], 0),
    steps,
    id: `${log.length}:${chunks.length}:${opts.maxChars ?? CHUNK_CHARS}:${last ? messageText(last.content).length : 0}`,
  };
}

/** What is still to send when a plan is picked up at request `from` (a build that was stopped carries on there). */
export function planFrom(plan: BuildPlan, from: number): Pick<BuildPlan, 'requests' | 'tokensIn' | 'tokensOut'> {
  const rest = plan.steps.slice(Math.max(0, from));
  return { requests: rest.length, tokensIn: rest.reduce((sum, step) => sum + step[0], 0), tokensOut: rest.reduce((sum, step) => sum + step[1], 0) };
}

// ---- what it costs ----------------------------------------------------------------------------------------------

/** A text model's price in micro-USD per million tokens. */
export type TextPrice = { in: number; out: number };

/** A USD-per-token amount as the gateway lists it ("0.00000045") in micro-USD per million tokens, exactly. */
export function perTokenToPerMillion(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value * 1e12) : null;
  if (typeof value !== 'string') return null;
  const m = /^\s*(\d{1,6})(?:\.(\d{0,18}))?\s*$/.exec(value);
  if (!m) return null;
  const frac = (m[2] ?? '').padEnd(13, '0');
  const n = Number(m[1]) * 1e12 + Number(frac.slice(0, 12)) + (Number(frac[12]) >= 5 ? 1 : 0);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * The price `GET /v1/models` lists for a model (`pricing.prompt` and `pricing.completion`, USD per token; see
 * gateway/src/api/models.ts). Null when the gateway lists none, in which case no estimate can be shown.
 */
export function listedPrice(model: unknown): TextPrice | null {
  const pricing = (model as { pricing?: { prompt?: unknown; completion?: unknown } } | null)?.pricing;
  if (!pricing) return null;
  const input = perTokenToPerMillion(pricing.prompt);
  const output = perTokenToPerMillion(pricing.completion);
  if (input === null || output === null || (input === 0 && output === 0)) return null;
  return { in: input, out: output };
}

/** The most a plan can cost at a price, in micro-USD, rounded up. Each request is charged what it really used. */
export function estimateMusd(plan: Pick<BuildPlan, 'tokensIn' | 'tokensOut'>, price: TextPrice): number {
  return Math.ceil((plan.tokensIn * price.in + plan.tokensOut * price.out) / 1_000_000);
}
