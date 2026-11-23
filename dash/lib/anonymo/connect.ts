// Update 05 "Pair my coding tool": the pure parts of /dashboard/connect. The person adds Anonymo's MCP server to Cursor
// or Claude Code on their computer, runs one test prompt there, and pastes back the receipt id the `chat` tool returned.
// The dashboard never calls /mcp itself (it refuses browser origins): it only looks the receipt up with the person's own
// key at GET /api/v1/generation, which answers 404 unless that key owns the call.
//
// What a receipt can prove: the call was made with this key, came in through the MCP chat tool (`origin: "mcp"`), when
// it was made and with which model. It cannot prove which program sent it, so the dashboard says the tool's own output
// is what shows that. Anything short of all four checks is shown as unconfirmed, never as success.

import type { ModelInfo } from './types.ts';

export type CodingClientId = 'cursor' | 'claude-code';

/** GET /api/v1/generation?id= (gateway/src/api/generation.ts), the fields this page reads. Owner-only. */
export type GenerationView = {
  id: string;
  model: string;
  created_at: string;
  /** "mcp" when the call came in through POST /mcp's chat tool; null (or absent on an older gateway) otherwise. */
  origin?: 'mcp' | null;
  total_cost?: number | null;
  provider_name?: string | null;
  /** The gateway's clock when it answered the lookup (update 05). Lets the page compare times on one clock. */
  checked_at?: string;
};

/** One test: which tool, which model, and when the person started it (this browser's clock, ms). */
export type ConnectAttempt = { client: CodingClientId; model: string; startedAt: number };

export type UnconfirmedReason = 'origin' | 'time' | 'model';
export type ReceiptCheck =
  | { status: 'confirmed'; generation: GenerationView }
  | { status: 'unconfirmed'; reasons: UnconfirmedReason[]; generation: GenerationView };

/**
 * created_at is on the gateway's clock and the test's start on this browser's, which can be minutes apart on a phone.
 * The lookup's checked_at says what the gateway's clock read while it answered, so the offset between the two clocks is
 * checked_at minus the middle of the lookup's round trip. The start is moved onto the gateway's clock with it, less
 * this margin (plus half the round trip, the most the estimate can be off). With no checked_at (an older gateway) the
 * clocks are taken as equal and only this margin applies, so a skewed clock can only make a real test unconfirmed.
 */
export const CLOCK_MARGIN_MS = 2_000;

/** When this browser sent the lookup and got its answer (ms, Date.now()). */
export type LookupTiming = { sentAt: number; receivedAt: number };

/** The test's start on the gateway's clock, minus the margin: a call made earlier than this is not from this test. */
export function earliestCall(attempt: ConnectAttempt, generation: GenerationView, timing: LookupTiming): number {
  const checked = generation.checked_at ? Date.parse(generation.checked_at) : NaN;
  const halfTrip = Math.max(0, timing.receivedAt - timing.sentAt) / 2;
  const offset = Number.isFinite(checked) ? checked - (timing.sentAt + halfTrip) : 0;
  return attempt.startedAt + offset - CLOCK_MARGIN_MS - (Number.isFinite(checked) ? halfTrip : 0);
}

export const UNCONFIRMED_TEXT: Record<UnconfirmedReason, string> = {
  origin: 'It did not come in through the MCP server, so it was not made by a coding tool connected to Anonymo.',
  time: 'It was made before you started this test.',
  model: 'It used a different model from the one this test asked for.',
};

/** All four bindings: the lookup succeeded (the caller passes only an owned generation), MCP origin, time and model. */
export function checkReceipt(attempt: ConnectAttempt, generation: GenerationView, timing: LookupTiming): ReceiptCheck {
  const reasons: UnconfirmedReason[] = [];
  if (generation.origin !== 'mcp') reasons.push('origin');
  const made = Date.parse(generation.created_at);
  if (!Number.isFinite(made) || made < earliestCall(attempt, generation, timing)) reasons.push('time');
  if (generation.model !== attempt.model) reasons.push('model');
  return reasons.length ? { status: 'unconfirmed', reasons, generation } : { status: 'confirmed', generation };
}

/** The gateway's generation ids: `gen-<unix seconds>-<base64url>` (gateway/src/lib/util.ts genId). */
const RECEIPT_ID = /gen-\d{6,12}-[A-Za-z0-9_-]{6,64}/;
export const isReceiptId = (value: string) => new RegExp(`^${RECEIPT_ID.source}$`).test(value);

/** The receipt id in what the person pasted: the id alone, or the tool's whole reply with `receipt_id` in it. */
export function receiptIdIn(pasted: string): string | null {
  return pasted.match(RECEIPT_ID)?.[0] ?? null;
}

export type Recovery = 'missing_credential' | 'unsupported_config' | 'insufficient_funds' | 'unavailable_model';

/**
 * What went wrong, read from an error the coding tool showed and the person pasted (the dashboard cannot see the
 * tool's own calls). Matches the gateway's error types and the wording MCP clients print. Null when nothing matches.
 */
export function diagnosePaste(pasted: string): Recovery | null {
  const t = pasted.toLowerCase();
  if (/missing_key|needs an anonymo api key|unauthori[sz]ed|\b401\b|invalid api key|key was not accepted|invalid_key/.test(t)) return 'missing_credential';
  if (/insufficient_credit|insufficient_balance|payment_required|\b402\b|not enough credit/.test(t)) return 'insufficient_funds';
  if (/model_not_found|temporarily_unavailable|model is unavailable|not live|no such model|unknown model/.test(t)) return 'unavailable_model';
  if (/cross-origin|method not allowed|\b405\b|\b403\b|-3260[01]|econnrefused|enotfound|failed to connect|connection refused|sse error|transport|invalid url|not found.*\/mcp/.test(t)) return 'unsupported_config';
  return null;
}

/** Models that should not be the test: the council answers with several models, sealed refuses without an enclave, and
 *  swarm starts a Ventures run instead of answering. */
const NOT_FOR_TEST = new Set(['anonymo-council', 'anonymo-sealed', 'anonymo-swarm']);
const PREFERRED = ['anonymo-1'];

/** Live text-chat models a test can use, the preferred one first. Empty when the gateway lists none (unavailable). */
export function testModels(catalog: readonly ModelInfo[] | null): string[] {
  if (!catalog) return [];
  const ok = catalog.filter((m) => {
    if (m.availability === 'temporarily_unavailable' || NOT_FOR_TEST.has(m.id)) return false;
    const out = m.architecture?.output_modalities;
    const input = m.architecture?.input_modalities;
    return (!out || (out.includes('text') && out.length === 1)) && (!input || input.includes('text'));
  });
  const ids = ok.map((m) => m.id);
  return [...PREFERRED.filter((id) => ids.includes(id)), ...ids.filter((id) => !PREFERRED.includes(id))];
}

/** What the person asks their coding tool, word for word. It names the model so the receipt can be matched to it. */
export function testPrompt(model: string): string {
  return `Use the anonymo chat tool with model "${model}" and the prompt "Reply with ready." Then show me its reply and the receipt_id it returned.`;
}

/** Remembered for this tab only, so switching to the tool and back keeps the test. Never holds the key. */
const ATTEMPT_SLOT = 'anonymo.connect.attempt.v1';
export function loadAttempt(storage: Pick<Storage, 'getItem'> | null): ConnectAttempt | null {
  try {
    const raw = storage?.getItem(ATTEMPT_SLOT);
    if (!raw) return null;
    const a = JSON.parse(raw) as Partial<ConnectAttempt>;
    if ((a.client !== 'cursor' && a.client !== 'claude-code') || typeof a.model !== 'string' || typeof a.startedAt !== 'number') return null;
    return { client: a.client, model: a.model, startedAt: a.startedAt };
  } catch {
    return null;
  }
}
export function saveAttempt(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, attempt: ConnectAttempt | null) {
  try {
    if (attempt) storage?.setItem(ATTEMPT_SLOT, JSON.stringify(attempt));
    else storage?.removeItem(ATTEMPT_SLOT);
  } catch {
    // storage blocked: the test lasts for this page only
  }
}
