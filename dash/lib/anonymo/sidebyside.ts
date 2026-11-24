// Update "sidebyside": Side by Side. One question goes to three models at the same time, each in its own column with
// its own signed receipt, and one more request then merges the answers into one. This file is the plain logic the page
// and its checks share: which models fill the three slots, the price shown before sending, the merge request, what a
// receipt says about a refusal, the money, and the state of a round. Nothing here stores or sends anything.

import type { Turn } from '../../components/dashboard/chat-types.ts';
import { NON_STREAMING_MODELS } from './client.ts';
import { formatUsd, usdToMusd } from './money.ts';
import { ANONYMO_MODEL_IDS, type ChatMessage, type MicroUsd, type ModelInfo, type Receipt, type ReceiptRoute } from './types.ts';

export const SLOTS = ['A', 'B', 'C'] as const;
/** The model that merges the answers. */
export const MERGE_MODEL = 'anonymo-1';
/** The longest answer a column or the merge may write. With the listed prices it is what makes "up to" true. */
export const ANSWER_MAX_TOKENS = 1200;
export const MERGE_MAX_TOKENS = 1500;
/** How much of the question and of each answer goes into the merge request. */
export const MERGE_QUESTION_CHARS = 4000;
export const MERGE_ANSWER_CHARS = 6000;

// ---- which models fill the slots -------------------------------------------------------------------------------------

/** Models a column can ask: every listed model that streams. The council answers as one body and is three models itself. */
export function slotModels(models: readonly ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  // anonymo-auto has no list price of its own (it bills the model it picks), so it cannot be priced before sending.
  return models.filter((m) => !NON_STREAMING_MODELS.includes(m.id) && m.id !== 'anonymo-auto' && !seen.has(m.id) && !!seen.add(m.id));
}

const isRouted = (id: string) => (ANONYMO_MODEL_IDS as readonly string[]).includes(id);

/**
 * The three models a first visit starts with: anonymo-1, then one model each from the two other families that refused
 * least over the last 30 days. Direct model ids come before Anonymo's routed ids, which choose a family per request.
 * With fewer than three families listed the slots are filled with whatever else is listed; with fewer than three
 * models, fewer ids come back.
 */
export function defaultSlots(models: readonly ModelInfo[]): string[] {
  const pool = slotModels(models);
  const rate = (m: ModelInfo) => m.refusal_rate_30d ?? 2; // a rate is 0..1, so "no figure yet" sorts last
  const ordered = [...pool].sort((a, b) => Number(isRouted(a.id)) - Number(isRouted(b.id)) || rate(a) - rate(b));
  const first = pool.find((m) => m.id === MERGE_MODEL) ?? ordered[0];
  if (!first) return [];
  const picked = [first];
  for (const m of ordered) {
    if (picked.length === SLOTS.length) break;
    if (!picked.includes(m) && m.family && picked.every((p) => p.family !== m.family)) picked.push(m);
  }
  for (const m of ordered) {
    if (picked.length === SLOTS.length) break;
    if (!picked.includes(m)) picked.push(m);
  }
  return picked.map((m) => m.id);
}

/** Puts a model in a slot. A model that already sits in another slot trades places, so the three stay different. */
export function setSlot(slots: readonly string[], index: number, id: string): string[] {
  const next = [...slots];
  const other = next.indexOf(id);
  if (index < 0 || index >= next.length || other === index) return next;
  if (other !== -1) next[other] = next[index];
  next[index] = id;
  return next;
}

/** Keeps the chosen models that are still listed and fills the rest from the defaults. */
export function reconcileSlots(chosen: readonly string[] | null, models: readonly ModelInfo[]): string[] {
  const listed = new Set(slotModels(models).map((m) => m.id));
  const kept = (chosen ?? []).filter((id, i, all) => listed.has(id) && all.indexOf(id) === i).slice(0, SLOTS.length);
  if (kept.length === SLOTS.length) return kept;
  const rest = defaultSlots(models).filter((id) => !kept.includes(id));
  const more = slotModels(models).map((m) => m.id).filter((id) => !kept.includes(id) && !rest.includes(id));
  return [...kept, ...rest, ...more].slice(0, SLOTS.length);
}

/** Every word typed must appear in the model's id, name or family. */
export function searchModels(models: readonly ModelInfo[], query: string): ModelInfo[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return slotModels(models).filter((m) => {
    const hay = `${m.id} ${m.name ?? ''} ${m.family ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** "0.18% said no" over the last 30 days, the same figure the leaderboard shows. */
export function refusalLabel(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return 'no refusal figure yet';
  return `${(rate * 100).toFixed(rate < 0.01 ? 2 : 1)}% said no in 30 days`;
}

// ---- the price shown before sending --------------------------------------------------------------------------------

/** A model's listed price in micro-USD per million tokens. */
export type ListPrice = { in: number; out: number };

/** A USD-per-token decimal string ("0.00000045") as micro-USD per million tokens (450000), rounded up. */
function perMillion(usdPerToken: unknown): number | null {
  const m = typeof usdPerToken === 'string' ? /^\s*(\d{1,3})(?:\.(\d*))?\s*$/.exec(usdPerToken) : null;
  if (!m) return null;
  const frac = m[2] ?? '';
  // USD per token times 10^12 is micro-USD per million tokens: move the point twelve places.
  return Number(m[1] + frac.slice(0, 12).padEnd(12, '0')) + (/[1-9]/.test(frac.slice(12)) ? 1 : 0);
}

/** The listed price of a model, or null when the gateway lists none (a price of zero for both counts as none). */
export function listPrice(model: Pick<ModelInfo, 'pricing'> | null | undefined): ListPrice | null {
  const input = perMillion(model?.pricing?.prompt);
  const output = perMillion(model?.pricing?.completion);
  if (input === null || output === null || (input === 0 && output === 0)) return null;
  return { in: input, out: output };
}

/** Tokens a text may be billed as, counted high on purpose: about two characters a token, plus the chat wrapper. */
export const upperTokens = (text: string) => Math.ceil(text.length / 2) + 16;

/** The most one request can cost: the whole prompt in, and an answer as long as the cap allows out. */
export const maxCost = (promptTokens: number, price: ListPrice, maxOut: number): MicroUsd =>
  Math.ceil((promptTokens * price.in + maxOut * price.out) / 1_000_000);

/** The most asking every slot can cost, or null when any slot's price is not listed. */
export function askEstimate(question: string, prices: readonly (ListPrice | null)[]): MicroUsd | null {
  if (!prices.length || prices.some((p) => p === null)) return null;
  const tokens = upperTokens(question);
  return prices.reduce((sum, p) => sum + maxCost(tokens, p!, ANSWER_MAX_TOKENS), 0);
}

/** The most a merge request can cost, or null when the merge model's price is not listed. */
export function mergeEstimate(messages: readonly ChatMessage[], price: ListPrice | null): MicroUsd | null {
  if (!price) return null;
  return maxCost(upperTokens(messages.map((m) => m.content).join('\n')), price, MERGE_MAX_TOKENS);
}

/** An estimate rounded up to two significant digits, so a button reads "$0.0066" and never understates. */
export function roundUpEstimate(musd: MicroUsd): MicroUsd {
  if (!Number.isSafeInteger(musd) || musd <= 0) return 0;
  const unit = 10 ** Math.max(0, String(musd).length - 2);
  return Math.ceil(musd / unit) * unit;
}

// ---- the merge request --------------------------------------------------------------------------------------------

export type LabelledAnswer = { label: string; model: string; content: string };

/**
 * The last message of a merge request. It is sent as a turn of its own, after the answers, so it reads as an
 * instruction and not as part of an answer.
 */
export const MERGE_INSTRUCTION = [
  'Merge the answers above into one answer to my question.',
  'Keep what they agree on. Where they disagree, give the version that is best supported and say plainly that the answers disagreed.',
  'Add nothing that none of them said, and do not mention the labels in the main answer.',
  'End with a short list under the exact heading "Where they differed": one line for each real difference, naming the answers by their labels.',
  'If they did not differ, write one line under that heading saying so.',
].join(' ');

const clip = (text: string, max: number) => {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max).trimEnd()} […]` : trimmed;
};

/**
 * The request that merges the answers: the question and every answer once, each under its label and capped in length,
 * then the instruction. Blank answers are left out.
 */
export function mergeRequest(question: string, answers: readonly LabelledAnswer[]): ChatMessage[] {
  const given = answers.filter((a) => a.content.trim());
  const parts = given.map((a) => `Answer ${a.label} (from ${a.model}):\n${clip(a.content, MERGE_ANSWER_CHARS)}`);
  const count = `${given.length} ${given.length === 1 ? 'answer' : 'answers'}`;
  return [
    {
      role: 'user',
      content: `I asked different AI models the same question. Here is my question, then ${count}, each under its own label.\n\nMy question:\n${clip(question, MERGE_QUESTION_CHARS)}\n\n${parts.join('\n\n')}`,
    },
    { role: 'assistant', content: `Got it. I have your question and the ${count}.` },
    { role: 'user', content: MERGE_INSTRUCTION },
  ];
}

// ---- what a receipt says ------------------------------------------------------------------------------------------

export type Reroute = {
  /** Routes that refused. Each is billed nothing. */
  saidNo: ReceiptRoute[];
  /** The route that answered after a refusal, or null when nobody did. */
  steppedIn: ReceiptRoute | null;
  /** The text that came back is itself a refusal: no other family could take it, or a second one refused too. */
  servedRefusal: boolean;
};

/** What the refusal catch did for an answer, read from its receipt. Null when no route refused. */
export function rerouteOf(receipt: Receipt | null | undefined): Reroute | null {
  if (!receipt) return null;
  const saidNo = receipt.routes.filter((r) => r.status === 'refused' || r.refused);
  if (!saidNo.length && !receipt.refused) return null;
  const answered = receipt.routes.filter((r) => r.status === 'ok' && !r.refused);
  const steppedIn = receipt.refused ? null : (answered.find((r) => r.role === 'retry') ?? answered[answered.length - 1] ?? null);
  return { saidNo, steppedIn, servedRefusal: receipt.refused };
}

/** What a receipt charged, in micro-USD. Null without a receipt or a readable amount. */
export function costOf(receipt: Receipt | null | undefined): MicroUsd | null {
  if (!receipt) return null;
  const musd = usdToMusd(receipt.cost);
  return Number.isSafeInteger(musd) ? musd : null;
}

/** The sum of what the receipts charged, in micro-USD. */
export const totalCost = (receipts: readonly (Receipt | null | undefined)[]): MicroUsd =>
  receipts.reduce((sum: number, r) => sum + (costOf(r) ?? 0), 0);

// ---- a round: one question, three answers, one merge ---------------------------------------------------------------

export type SlotId = number | 'merge';

export type Answer = {
  model: string;
  status: 'streaming' | 'done' | 'stopped' | 'error';
  content: string;
  error: string | null;
  /** The balance was too low for the request. Offer the Balance page. */
  needsFunds: boolean;
  receiptId: string | null;
  receipt: Receipt | null;
  /** The answer reached the length cap before the model finished. */
  cutOff: boolean;
};

export type Round = {
  /** Counts the questions asked in this tab. 0 means nothing was asked yet. */
  run: number;
  question: string;
  columns: Answer[];
  merge: Answer | null;
  /** Show the "you're talking to an AI" reminder with this round. */
  aiReminder: boolean;
  /** The question mentioned suicide or self-harm: show the crisis lines with the answers. */
  crisis: boolean;
};

export const EMPTY_ROUND: Round = { run: 0, question: '', columns: [], merge: null, aiReminder: false, crisis: false };

export type RoundAction =
  | { type: 'ask'; run: number; question: string; models: readonly string[]; aiReminder: boolean; crisis: boolean }
  | { type: 'merge'; run: number; model: string }
  | { type: 'delta'; run: number; slot: SlotId; text: string }
  | { type: 'done'; run: number; slot: SlotId; content: string; receiptId: string | null; receipt: Receipt | null; cutOff: boolean }
  | { type: 'receipt'; run: number; slot: SlotId; receipt: Receipt }
  | { type: 'stopped'; run: number; slot: SlotId }
  | { type: 'error'; run: number; slot: SlotId; message: string; needsFunds: boolean }
  | { type: 'clear' };

const fresh = (model: string): Answer => ({ model, status: 'streaming', content: '', error: null, needsFunds: false, receiptId: null, receipt: null, cutOff: false });

function step(answer: Answer, action: Exclude<RoundAction, { type: 'ask' | 'merge' | 'clear' }>): Answer {
  // The receipt may arrive after the answer has settled; everything else only changes an answer that is still arriving.
  if (action.type === 'receipt')
    return answer.status === 'done' && !answer.receipt && answer.receiptId === action.receipt.request_id ? { ...answer, receipt: action.receipt } : answer;
  if (answer.status !== 'streaming') return answer;
  switch (action.type) {
    case 'delta':
      return action.text ? { ...answer, content: answer.content + action.text } : answer;
    case 'done':
      return { ...answer, status: 'done', content: action.content || answer.content, receiptId: action.receiptId, receipt: action.receipt, cutOff: action.cutOff };
    case 'stopped':
      return { ...answer, status: 'stopped' };
    case 'error':
      return { ...answer, status: 'error', error: action.message, needsFunds: action.needsFunds };
  }
}

/** Anything still arriving. A new question or a merge waits for it. */
export const isBusy = (round: Round) => round.columns.some((c) => c.status === 'streaming') || round.merge?.status === 'streaming';

/**
 * One round's state. Every event carries the run it belongs to, so a late event from an earlier question (a stream that
 * was stopped, a receipt that took a while) never lands in the current one, and a settled answer never changes again.
 */
export function roundReducer(state: Round, action: RoundAction): Round {
  // The run number is kept, so whatever an earlier question still has in flight finds nothing to write to.
  if (action.type === 'clear') return { ...EMPTY_ROUND, run: state.run };
  if (action.type === 'ask') {
    if (action.run <= state.run || isBusy(state) || !action.models.length) return state;
    return { run: action.run, question: action.question, columns: action.models.map(fresh), merge: null, aiReminder: action.aiReminder, crisis: action.crisis };
  }
  if (action.run !== state.run) return state;
  if (action.type === 'merge') return canMerge(state) ? { ...state, merge: fresh(action.model) } : state;
  const current = action.slot === 'merge' ? state.merge : state.columns[action.slot];
  if (!current) return state;
  const next = step(current, action);
  if (next === current) return state;
  return action.slot === 'merge' ? { ...state, merge: next } : { ...state, columns: state.columns.map((c, i) => (i === action.slot ? next : c)) };
}

/**
 * The answers a merge reads: every column that finished (or was stopped) with text, under its letter. A column whose
 * receipt says the text is itself a refusal is left out, and so is one that failed.
 */
export function mergeable(round: Round): LabelledAnswer[] {
  return round.columns.flatMap((c, i) =>
    (c.status === 'done' || c.status === 'stopped') && c.content.trim() && !c.receipt?.refused ? [{ label: SLOTS[i] ?? String(i + 1), model: c.model, content: c.content }] : [],
  );
}

/** A merge needs at least two answers, nothing still arriving, and no merge already written. */
export const canMerge = (round: Round) => !isBusy(round) && round.merge?.status !== 'done' && mergeable(round).length >= 2;

/** Every receipt of the round: the columns, then the merge. */
export const roundReceipts = (round: Round) => [...round.columns.map((c) => c.receipt), round.merge?.receipt ?? null];

// ---- the strip of receipt paper ------------------------------------------------------------------------------------

export type StripRow =
  | { kind: 'pair'; label: string; value: string; stamp?: string; tone?: 'amber' }
  | { kind: 'head'; label: string; text: string }
  | { kind: 'center'; text: string; big?: boolean }
  | { kind: 'rule' }
  | { kind: 'logo' };

/** How one settled answer reads on the paper: who said no (stamped), who answered, and what it cost. */
function answerRows(answer: Answer, verb = 'answered'): StripRow[] {
  const cost = costOf(answer.receipt);
  const price = cost === null ? 'on its receipt' : formatUsd(cost);
  if (answer.status === 'error') return [{ kind: 'pair', label: 'no answer', value: formatUsd(0) }];
  const reroute = rerouteOf(answer.receipt);
  if (!reroute) {
    if (answer.status === 'stopped') return [{ kind: 'pair', label: 'stopped early', value: answer.receipt ? price : 'see History' }];
    return [{ kind: 'pair', label: verb, value: price }];
  }
  const refused: StripRow[] = (reroute.saidNo.length ? reroute.saidNo.map((r) => r.model) : [answer.model]).map((model) => ({
    kind: 'pair',
    label: model,
    value: 'said no',
    stamp: 'REFUNDED',
  }));
  if (!reroute.steppedIn) return [...refused, { kind: 'pair', label: 'charged', value: price }];
  return [...refused, { kind: 'pair', label: reroute.steppedIn.model, value: 'answered' }, { kind: 'pair', label: 'charged', value: price }];
}

/** The receipt for a round: each model with "answered" or "said no", the merge, and the total. */
export function receiptStrip(round: Round): StripRow[] {
  const rows: StripRow[] = [{ kind: 'logo' }, { kind: 'center', text: 'ANONYMO', big: true }, { kind: 'center', text: 'Side by side' }];
  round.columns.forEach((c, i) => {
    rows.push({ kind: 'head', label: SLOTS[i] ?? String(i + 1), text: c.model });
    rows.push(...(c.status === 'streaming' ? [{ kind: 'pair', label: 'still writing', value: '…' } as StripRow] : answerRows(c)));
  });
  if (round.merge && round.merge.status !== 'streaming') {
    rows.push({ kind: 'head', label: '+', text: `Merged by ${round.merge.model}` }, ...answerRows(round.merge, 'merged'));
  }
  rows.push({ kind: 'rule' }, { kind: 'pair', label: 'Total', value: formatUsd(totalCost(roundReceipts(round))), tone: 'amber' }, { kind: 'center', text: 'Thank you. Sleep well.' });
  return rows;
}

// ---- continue in chat ----------------------------------------------------------------------------------------------

/** The first turn of a chat that carries on from one answer: the question, and that answer as the reply. */
export function chatTurn(id: string, question: string, answer: Pick<Answer, 'model' | 'content' | 'receiptId' | 'receipt' | 'status'>): Turn {
  return {
    id,
    model: answer.model,
    prompt: question,
    attachment: null,
    character: null,
    content: answer.content,
    status: answer.status === 'stopped' ? 'stopped' : 'done',
    error: null,
    receiptId: answer.receiptId,
    receipt: answer.receipt,
    council: null,
    councilMode: null,
  };
}
