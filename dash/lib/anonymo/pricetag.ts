// Update "pricetag": the price of a chat message before it is sent, what this chat has really cost so far, and an
// optional per-chat limit kept on this device.
//
// - The estimate uses the selected model's list price from /v1/models (USD per token, decimal strings), the tokens of
//   what will actually be sent (the whole thread, the character prompt and the draft) and the reply: a typical length
//   for "about", and the longest reply the gateway would allow for "up to" (the same bound it holds before a call).
// - "This chat so far" adds up the charge on each reply's Anonymo receipt, never the estimate. A refused reply is
//   billed nothing, so it counts as $0 whatever else the receipt says.
// - Money is counted in BigInt atto-USD (10^-18 USD) and shown in micro-USD, so long threads and tiny per-token prices
//   never drift. A model with no listed price gets no estimate: the tag says the price isn't known.

import { estimateTokens } from './catchup.ts';
import { parseUsd } from './money.ts';
import type { ChatMessage, MicroUsd, ModelInfo, Receipt } from './types.ts';

export type Atto = bigint;

const FRACTION_DIGITS = 18;
const ATTO_PER_MUSD = 10n ** 12n;

/** A non-negative USD decimal string ("0.00000045") as atto-USD. Digits past 18 places round up. Null if unreadable. */
export function parseUsdAtto(value: unknown): Atto | null {
  if (typeof value !== 'string') return null;
  const m = /^\s*(\d{1,15})(?:\.(\d*))?\s*$/.exec(value);
  if (!m) return null;
  const frac = m[2] ?? '';
  const kept = BigInt(m[1] + frac.slice(0, FRACTION_DIGITS).padEnd(FRACTION_DIGITS, '0'));
  return /[1-9]/.test(frac.slice(FRACTION_DIGITS)) ? kept + 1n : kept;
}

/** Atto-USD as whole micro-USD, rounded up (never understates) or to the nearest. */
export function attoToMusd(atto: Atto, round: 'up' | 'nearest' = 'up'): MicroUsd {
  if (atto <= 0n) return 0;
  const musd = round === 'up' ? (atto + ATTO_PER_MUSD - 1n) / ATTO_PER_MUSD : (atto + ATTO_PER_MUSD / 2n) / ATTO_PER_MUSD;
  return Number(musd);
}

export const musdToAtto = (musd: MicroUsd): Atto => BigInt(Math.trunc(musd)) * ATTO_PER_MUSD;

/** Rounds a price to two significant digits for display: "$0.0031", "$0.042". Up for a ceiling, nearest for "about". */
export function roundForDisplay(musd: MicroUsd, round: 'up' | 'nearest'): MicroUsd {
  if (!Number.isSafeInteger(musd) || musd <= 0) return 0;
  const unit = 10 ** Math.max(0, String(musd).length - 2);
  const rounded = (round === 'up' ? Math.ceil(musd / unit) : Math.round(musd / unit)) * unit;
  return Math.max(1, rounded);
}

// ---- prices -------------------------------------------------------------------------------------------------------

/** What the tag reads from a /v1/models entry. The gateway also sends these fields; the shared type lists fewer. */
export type PricedModel = Pick<ModelInfo, 'id'> & {
  context_length?: number;
  pricing?: { prompt?: string; completion?: string; request?: string; internal_reasoning?: string };
  top_provider?: { max_completion_tokens?: number | null };
};

/** Atto-USD per token (and per request). */
export type Rates = { prompt: Atto; completion: Atto; reasoning: Atto; request: Atto };

/**
 * The model's list price, or null when it is not known: no pricing, an unreadable figure, or zero for both prompt and
 * completion (the gateway lists "0" when it has no offer to price from).
 */
export function ratesOf(model: PricedModel | null | undefined): Rates | null {
  const p = model?.pricing;
  if (!p) return null;
  const prompt = parseUsdAtto(p.prompt);
  const completion = parseUsdAtto(p.completion);
  const optional = (v: string | undefined) => (v === undefined ? 0n : parseUsdAtto(v));
  const reasoning = optional(p.internal_reasoning);
  const request = optional(p.request);
  if (prompt === null || completion === null || reasoning === null || request === null) return null;
  if (prompt === 0n && completion === 0n) return null;
  return { prompt, completion, reasoning, request };
}

// ---- tokens -------------------------------------------------------------------------------------------------------

/** A typical reply, used for "about": roughly 375 words. */
export const TYPICAL_REPLY_TOKENS = 500;
/** The gateway's reply cap when neither the request nor the model sets one (router/pricing.ts maxOutputTokens). */
export const GATEWAY_REPLY_CAP = 16_384;
/** Per-message wrapper, in characters: the same allowance the gateway's hold estimate makes. */
const WRAPPER_CHARS = 16;

/** About four characters a token (catchup's estimator), plus each message's wrapper. */
export const typicalPromptTokens = (messages: readonly ChatMessage[]) =>
  messages.reduce((sum, m) => sum + estimateTokens(m.content) + WRAPPER_CHARS / 4, 0);

/** Counted high on purpose for "up to": two characters a token, plus the wrapper. */
export const worstPromptTokens = (messages: readonly ChatMessage[]) =>
  Math.ceil(messages.reduce((sum, m) => sum + m.content.length + WRAPPER_CHARS, 0) / 2) + 8;

/** The longest reply the gateway would allow, as it bounds its hold: the request's cap, the model's, the room left. */
export function maxReplyTokens(model: PricedModel, promptTokens: number, maxTokens?: number): number {
  const ctx = model.context_length && model.context_length > 0 ? model.context_length : null;
  const room = ctx === null ? Number.POSITIVE_INFINITY : Math.max(1, ctx - promptTokens);
  const listed = model.top_provider?.max_completion_tokens;
  const cap = listed && listed > 0 ? listed : Math.max(1, Math.min(room, GATEWAY_REPLY_CAP));
  const asked = maxTokens && maxTokens > 0 ? maxTokens : cap;
  return Math.max(1, Math.min(asked, cap, room));
}

// ---- the estimate -------------------------------------------------------------------------------------------------

/**
 * anonymo-council answers with several proposers and a merge, each billed on its own, so outside demo mode its list price
 * is multiplied: about four calls, up to five (the same spread the story estimate uses).
 */
export function callSpread(model: string, demo: boolean): { low: bigint; high: bigint } {
  return model === 'anonymo-council' && !demo ? { low: 4n, high: 5n } : { low: 1n, high: 1n };
}

export type Estimate =
  | { known: false }
  | {
      known: true;
      /** "About": typical tokens in and a typical reply. */
      typical: Atto;
      /** "Up to": tokens counted high and the longest reply allowed. */
      worst: Atto;
      tokensIn: number;
      typicalOut: number;
      worstOut: number;
    };

export type EstimateInput = {
  model: PricedModel | null | undefined;
  messages: readonly ChatMessage[];
  /** The request's max_tokens, when the chat sets one. */
  maxTokens?: number;
  demo?: boolean;
  /** A flat price added once to the call, in USD (the web search price when search is on). */
  extraUsd?: string;
};

export function estimateMessage({ model, messages, maxTokens, demo = false, extraUsd }: EstimateInput): Estimate {
  const rates = ratesOf(model);
  if (!model || !rates) return { known: false };
  const tokensIn = typicalPromptTokens(messages);
  const highIn = worstPromptTokens(messages);
  const worstOut = maxReplyTokens(model, highIn, maxTokens);
  const typicalOut = Math.min(TYPICAL_REPLY_TOKENS, worstOut);
  const spread = callSpread(model.id, demo);
  // Reasoning tokens are part of the reply and may be priced higher; the worst case bills the whole reply at the dearer.
  const worstOutRate = rates.reasoning > rates.completion ? rates.reasoning : rates.completion;
  const typical = (BigInt(tokensIn) * rates.prompt + BigInt(typicalOut) * rates.completion + rates.request) * spread.low;
  const worst = (BigInt(highIn) * rates.prompt + BigInt(worstOut) * worstOutRate + rates.request) * spread.high;
  const extra = extraUsd ? (parseUsdAtto(extraUsd) ?? 0n) : 0n;
  return { known: true, typical: typical + extra, worst: worst + extra, tokensIn, typicalOut, worstOut };
}

// ---- what this chat has cost ----------------------------------------------------------------------------------------

/** The parts of a chat turn the tally reads (components/dashboard/chat-types.ts `Turn`). */
export type ChargedTurn = {
  status: 'streaming' | 'done' | 'stopped' | 'error';
  content: string;
  receiptId: string | null;
  receipt: Receipt | null;
  needsFunds?: boolean;
  memoryCharge?: { cost: string | null; receiptId: string | null };
};

export type TurnCharge =
  | { kind: 'charged'; atto: Atto } // the receipt's charge
  | { kind: 'refused' } // refused: billed $0
  | { kind: 'none' } // failed before anything ran: nothing billed
  | { kind: 'pending' } // still streaming, or the receipt is on its way
  | { kind: 'unknown' }; // stopped or broke off without a receipt reaching this tab

export function chargeOf(turn: ChargedTurn): TurnCharge {
  if (turn.receipt) {
    if (turn.receipt.refused) return { kind: 'refused' };
    const atto = parseUsdAtto(turn.receipt.cost);
    return atto === null ? { kind: 'unknown' } : { kind: 'charged', atto };
  }
  if (turn.status === 'streaming' || turn.receiptId) return { kind: 'pending' };
  // An error with nothing streamed was turned away before a model ran (low balance, a floor block, a bad key).
  if (turn.status === 'error' && (turn.needsFunds || !turn.content)) return { kind: 'none' };
  return { kind: 'unknown' };
}

export type ChatSpend = {
  /** Sum of the receipts' charges (and memory suggestion charges), refused replies counted as $0. */
  charged: Atto;
  replies: number;
  refused: number;
  pending: number;
  /** Replies whose charge never reached this tab (stopped mid-reply): not in `charged`. */
  unknown: number;
};

export function chatSpend(turns: readonly ChargedTurn[]): ChatSpend {
  const out: ChatSpend = { charged: 0n, replies: 0, refused: 0, pending: 0, unknown: 0 };
  for (const turn of turns) {
    const charge = chargeOf(turn);
    if (charge.kind === 'charged') {
      out.charged += charge.atto;
      out.replies++;
    } else if (charge.kind === 'refused') {
      out.refused++;
      out.replies++;
    } else if (charge.kind === 'pending') out.pending++;
    else if (charge.kind === 'unknown') out.unknown++;
    const memory = parseUsdAtto(turn.memoryCharge?.cost ?? undefined);
    if (memory !== null) out.charged += memory;
  }
  return out;
}

// ---- the per-chat limit --------------------------------------------------------------------------------------------

export type LimitCheck =
  | { blocked: false }
  | { blocked: true; reason: 'over'; limit: MicroUsd; spent: Atto; worst: Atto }
  | { blocked: true; reason: 'unknown_price'; limit: MicroUsd };

/**
 * Whether the next message may be sent: this chat's spend plus the worst case of the message must stay within the limit
 * (reaching it exactly is allowed). With no known price, the limit cannot be checked, so sending is blocked.
 */
export function checkLimit(limit: MicroUsd | null, spend: Pick<ChatSpend, 'charged'>, estimate: Estimate): LimitCheck {
  if (limit === null) return { blocked: false };
  if (!estimate.known) return { blocked: true, reason: 'unknown_price', limit };
  return spend.charged + estimate.worst > musdToAtto(limit)
    ? { blocked: true, reason: 'over', limit, spent: spend.charged, worst: estimate.worst }
    : { blocked: false };
}

/** Reads a typed limit ("0.50", "$2"). Null for anything that is not a positive amount up to $10,000. */
export function parseLimit(input: string): MicroUsd | null {
  const musd = parseUsd(input);
  return musd !== null && musd > 0 && musd <= 10_000 * 1_000_000 ? musd : null;
}

// ---- limits kept on this device -------------------------------------------------------------------------------------

export const limitSlot = (demo: boolean) => (demo ? 'anonymo.demo.pricetag.v1' : 'anonymo.pricetag.v1');
/** Limits for at most this many chats are kept; the oldest set is dropped first. */
export const MAX_LIMITS = 100;

export type Limits = Record<string, MicroUsd>;

/** Stored limits, validated: chat id to a positive whole micro-USD amount. */
export function readLimits(raw: unknown): Limits {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Limits = {};
  for (const [id, musd] of Object.entries(raw as Record<string, unknown>)) {
    if (/^[\w.:-]{1,100}$/.test(id) && typeof musd === 'number' && Number.isSafeInteger(musd) && musd > 0) out[id] = musd;
  }
  return out;
}

/** Sets (or with null, removes) one chat's limit. The newest goes last, so trimming drops the oldest. */
export function withLimit(limits: Limits, chatId: string, musd: MicroUsd | null): Limits {
  const rest = Object.entries(limits).filter(([id]) => id !== chatId);
  const next = musd === null ? rest : [...rest, [chatId, musd] as [string, MicroUsd]];
  return Object.fromEntries(next.slice(-MAX_LIMITS));
}

// ---- words ----------------------------------------------------------------------------------------------------------

/**
 * Micro-USD as dollars with every digit it has, at least two decimals: "$0.042", "$0.0031", "$1.20". (formatUsd shows
 * cents only from one cent up, which would cut "$0.042" to "$0.04".)
 */
export function usdText(musd: MicroUsd): string {
  if (!Number.isSafeInteger(musd) || musd < 0) return '—';
  const whole = String(Math.floor(musd / 1_000_000)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = String(musd % 1_000_000).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `$${whole}.${frac}`;
}

/** An estimate from atto-USD, rounded to two significant digits: up for "up to", to the nearest for "about". */
export const priceLabel = (atto: Atto, round: 'up' | 'nearest' = 'up') => usdText(atto > 0n ? roundForDisplay(attoToMusd(atto, 'up'), round) : 0);

/** A charged amount (receipt totals), to the micro-USD. */
export const spentLabel = (atto: Atto) => usdText(attoToMusd(atto, 'nearest'));
