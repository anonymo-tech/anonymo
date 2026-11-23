// 04 Track my top-up. One open top-up per key and rail, kept in this browser so it survives a reload, a suspended tab
// and a second tap. It holds nothing secret: the key's public keyCommit (already in every payment link and on chain),
// the amount, and once known the transaction hash. Only a deposit row that matches it can finish it: an approval, a
// mined transfer, elapsed time, a balance change or some other deposit on the same key never does.

import { usdToMusd } from './money.ts';
import type { DepositRow, EvmChain, Hex } from './types.ts';

export type TopupRail = 'evm' | 'coin';

export type TopupAttempt = {
  v: 1;
  id: string;
  keyCommit: Hex;
  rail: TopupRail;
  chain: EvmChain;
  token: string;
  /** The amount as the person typed it, and the same in micro-USD. */
  amount: string;
  musd: number;
  startedAt: number;
  walletOpenedAt: number | null;
  hash: Hex | null;
  submittedAt: number | null;
  /** The wallet threw after the transaction was broadcast: reconcile before offering another payment. */
  uncertain: boolean;
  /** Deposit refs that already existed when the top-up started. None of them can finish it. */
  knownRefs: string[];
  /** A deposit the person said was theirs (a different amount, or a coin payment without a hash). */
  claimedRef: string | null;
};

export type TopupMatch =
  | { kind: 'none' }
  | { kind: 'found'; row: DepositRow; by: 'hash' | 'amount' | 'you' }
  | { kind: 'candidates'; rows: DepositRow[] };

const PREFIX = 'anonymo.topup.v1:';
/** Deposits are timestamped by the gateway; allow for a phone clock that runs ahead of it. */
const CLOCK_SKEW_MS = 2 * 60_000;
/** After this long with nothing recorded, say so plainly. Checking continues. */
export const WALLET_DELAY_MS = 15 * 60_000;
export const NETWORK_DELAY_MS = 20 * 60_000;

export const attemptSlot = (keyCommit: string, rail: TopupRail) => `${PREFIX}${keyCommit.toLowerCase()}:${rail}`;

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const isNumOrNull = (n: unknown) => n === null || isNum(n);

/** A stored attempt, or null for anything missing, malformed or belonging to another key. */
export function parseAttempt(raw: string | null, keyCommit: string, rail: TopupRail): TopupAttempt | null {
  if (!raw) return null;
  let a: Partial<TopupAttempt>;
  try {
    a = JSON.parse(raw) as Partial<TopupAttempt>;
  } catch {
    return null;
  }
  if (!a || a.v !== 1 || typeof a.id !== 'string' || typeof a.keyCommit !== 'string' || a.keyCommit.toLowerCase() !== keyCommit.toLowerCase()) return null;
  if (a.rail !== rail || typeof a.chain !== 'string' || typeof a.token !== 'string' || typeof a.amount !== 'string') return null;
  if (!isNum(a.musd) || a.musd <= 0 || !isNum(a.startedAt) || !isNumOrNull(a.walletOpenedAt) || !isNumOrNull(a.submittedAt)) return null;
  if (a.hash !== null && !(typeof a.hash === 'string' && HEX32.test(a.hash))) return null;
  if (!Array.isArray(a.knownRefs) || !a.knownRefs.every(r => typeof r === 'string')) return null;
  if (a.claimedRef !== null && typeof a.claimedRef !== 'string') return null;
  return { ...(a as TopupAttempt), uncertain: a.uncertain === true };
}

export function readAttempt(storage: Storage | undefined, keyCommit: string, rail: TopupRail): TopupAttempt | null {
  try {
    return parseAttempt(storage?.getItem(attemptSlot(keyCommit, rail)) ?? null, keyCommit, rail);
  } catch {
    return null;
  }
}

export function writeAttempt(storage: Storage | undefined, attempt: TopupAttempt) {
  try {
    storage?.setItem(attemptSlot(attempt.keyCommit, attempt.rail), JSON.stringify(attempt));
  } catch {
    // storage blocked: the top-up is tracked for as long as this page stays open
  }
}

export function clearAttempt(storage: Storage | undefined, keyCommit: string, rail: TopupRail) {
  try {
    storage?.removeItem(attemptSlot(keyCommit, rail));
  } catch {
    // nothing stored
  }
}

/** Forget every open top-up in this browser (key change, sign-out, wipe). */
export function clearAllAttempts(storage: Storage | undefined) {
  try {
    if (!storage) return;
    const slots = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((k): k is string => !!k?.startsWith(PREFIX));
    for (const slot of slots) storage.removeItem(slot);
  } catch {
    // nothing stored
  }
}

export function newAttempt(o: {
  keyCommit: Hex;
  rail: TopupRail;
  chain: EvmChain;
  token: string;
  amount: string;
  musd: number;
  rows: Pick<DepositRow, 'ref'>[];
  now: number;
  id?: string;
}): TopupAttempt {
  return {
    v: 1,
    id: o.id ?? randomId(),
    keyCommit: o.keyCommit,
    rail: o.rail,
    chain: o.chain,
    token: o.token,
    amount: o.amount.trim(),
    musd: o.musd,
    startedAt: o.now,
    walletOpenedAt: null,
    hash: null,
    submittedAt: null,
    uncertain: false,
    knownRefs: o.rows.map(r => r.ref),
    claimedRef: null,
  };
}

function randomId() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** EVM refs are `<chain>:<txhash>:<logIndex>`; coin refs `coin:<txhash>:<logIndex>`. Compare the hash part exactly. */
export function refHasTx(ref: string, hash: string) {
  return ref.toLowerCase().split(':').includes(hash.toLowerCase());
}

/** The deposit row that belongs to this top-up, if the ledger has one yet. */
export function matchAttempt(a: TopupAttempt, rows: DepositRow[]): TopupMatch {
  if (a.hash) {
    const row = rows.find(r => refHasTx(r.ref, a.hash!));
    return row ? { kind: 'found', row, by: 'hash' } : { kind: 'none' };
  }
  if (a.claimedRef) {
    const row = rows.find(r => r.ref === a.claimedRef);
    if (row) return { kind: 'found', row, by: 'you' };
  }
  const known = new Set(a.knownRefs);
  const since = a.startedAt - CLOCK_SKEW_MS;
  const fresh = rows.filter(r => {
    if (known.has(r.ref)) return false;
    const at = Date.parse(r.created_at);
    if (!Number.isFinite(at) || at < since) return false;
    return a.rail === 'coin' ? r.chain === 'coin' : r.chain === a.chain && r.token === a.token;
  });
  if (!fresh.length) return { kind: 'none' };
  // A coin payment's credit depends on the price at confirmation, so it never matches by amount alone.
  if (a.rail === 'evm') {
    const exact = fresh.filter(r => usdToMusd(r.amount_usd) === a.musd);
    if (exact.length === 1) return { kind: 'found', row: exact[0], by: 'amount' };
    if (exact.length > 1) return { kind: 'candidates', rows: exact };
  }
  return { kind: 'candidates', rows: fresh };
}

export type TopupStage =
  | 'wallet' // waiting for the person to approve in the wallet
  | 'network' // a transaction is known, waiting for confirmations and the gateway
  | 'credited'
  | 'held';

export type TopupView = { stage: TopupStage; delayed: boolean; row: DepositRow | null; by: 'hash' | 'amount' | 'you' | null; candidates: DepositRow[] };

export function topupView(a: TopupAttempt, rows: DepositRow[], now: number): TopupView {
  const m = matchAttempt(a, rows);
  if (m.kind === 'found') return { stage: m.row.status === 'credited' ? 'credited' : 'held', delayed: false, row: m.row, by: m.by, candidates: [] };
  const candidates = m.kind === 'candidates' ? m.rows : [];
  if (a.hash) return { stage: 'network', delayed: now - (a.submittedAt ?? a.startedAt) > NETWORK_DELAY_MS, row: null, by: null, candidates };
  return { stage: 'wallet', delayed: now - (a.walletOpenedAt ?? a.startedAt) > WALLET_DELAY_MS, row: null, by: null, candidates };
}

/** Plain words for the gateway's held reasons. Held credit is never spendable until it is released. */
export function heldReason(reason: string | null | undefined): string {
  switch (reason) {
    case 'over_cap':
      return 'It is above the per-payment limit.';
    case 'sanctioned':
    case 'screening_unavailable':
      return 'The sending wallet needs a compliance check first.';
    case 'market_depth':
    case 'market_transition':
      return 'The coin market could not support this amount at confirmation.';
    case 'over_invoice':
      return 'It is more than the invoice asked for.';
    default:
      return 'It needs a review first.';
  }
}

/** How often to check while a top-up is open: quick at first, then slower, never stopping on its own. */
export function pollDelay(sinceStartMs: number): number {
  if (sinceStartMs < 2 * 60_000) return 5_000;
  if (sinceStartMs < 10 * 60_000) return 15_000;
  return 30_000;
}
