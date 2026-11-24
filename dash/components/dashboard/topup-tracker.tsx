'use client';

// 04 Track my top-up: the status of one payment, from the wallet approval to spendable credit. The open top-up lives in
// this browser (lib/anonymo/topup-attempt.ts), so a reload, a suspended tab or a second tap lands back here.

import Link from 'next/link';
import { CheckCircle2, Clock3, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { chainName } from '@/lib/anonymo/chains';
import { formatUsdAmount } from '@/lib/anonymo/money';
import type { DepositRow, Hex } from '@/lib/anonymo/types';
import {
  attemptSlot,
  heldReason,
  parseAttempt,
  pollDelay,
  topupView,
  type TopupAttempt,
  type TopupRail,
} from '@/lib/anonymo/topup-attempt';

// ---- the open top-up, shared by every component on the page and across tabs ---------------------------------------

const listeners = new Set<() => void>();
const memory = new Map<string, string>(); // used when this browser blocks storage
const parsed = new Map<string, { raw: string | null; value: TopupAttempt | null }>();
const emit = () => { for (const listener of listeners) listener(); };

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

function rawAttempt(slot: string) {
  try {
    return localStorage.getItem(slot) ?? memory.get(slot) ?? null;
  } catch {
    return memory.get(slot) ?? null;
  }
}

function snapshot(keyCommit: string, rail: TopupRail) {
  const slot = attemptSlot(keyCommit, rail);
  const raw = rawAttempt(slot);
  const cached = parsed.get(slot);
  if (cached && cached.raw === raw) return cached.value;
  const value = parseAttempt(raw, keyCommit, rail);
  parsed.set(slot, { raw, value });
  return value;
}

function store(attempt: TopupAttempt | null, keyCommit: string, rail: TopupRail) {
  const slot = attemptSlot(keyCommit, rail);
  memory.delete(slot);
  try {
    if (attempt) localStorage.setItem(slot, JSON.stringify(attempt));
    else localStorage.removeItem(slot);
  } catch {
    if (attempt) memory.set(slot, JSON.stringify(attempt));
  }
  emit();
}

export type Topup = {
  attempt: TopupAttempt | null;
  save: (attempt: TopupAttempt) => void;
  update: (patch: Partial<TopupAttempt>) => void;
  clear: () => void;
};

export function useTopupAttempt(keyCommit: string | null | undefined, rail: TopupRail): Topup {
  const get = useCallback(() => (keyCommit ? snapshot(keyCommit, rail) : null), [keyCommit, rail]);
  const attempt = useSyncExternalStore(subscribe, get, () => null);
  const save = useCallback((next: TopupAttempt) => { if (keyCommit) store(next, keyCommit, rail); }, [keyCommit, rail]);
  const update = useCallback((patch: Partial<TopupAttempt>) => {
    const current = keyCommit ? snapshot(keyCommit, rail) : null;
    if (current && keyCommit) store({ ...current, ...patch }, keyCommit, rail);
  }, [keyCommit, rail]);
  const clear = useCallback(() => { if (keyCommit) store(null, keyCommit, rail); }, [keyCommit, rail]);
  return { attempt, save, update, clear };
}

/** While a top-up waits for credit, re-read the ledger: often at first, then less often, and at once on return. */
export function useTopupPolling(startedAt: number | null, refresh: () => void) {
  useEffect(() => {
    if (startedAt === null) return;
    let timer = 0;
    const tick = () => {
      if (document.visibilityState === 'visible') refresh();
      timer = window.setTimeout(tick, pollDelay(Date.now() - startedAt));
    };
    timer = window.setTimeout(tick, pollDelay(Date.now() - startedAt));
    const back = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
    window.addEventListener('pageshow', back);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', back);
      window.removeEventListener('focus', back);
      window.removeEventListener('pageshow', back);
    };
  }, [startedAt, refresh]);
}

/** Re-render on a slow clock so "taking longer than usual" appears without a new poll result. */
function useNow(periodMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), periodMs);
    return () => window.clearInterval(timer);
  }, [periodMs]);
  return now;
}

// ---- the status card --------------------------------------------------------------------------------------------

const HASH = /^0x[0-9a-fA-F]{64}$/;

type Step = { title: string; detail: string; state: 'done' | 'active' | 'next' | 'held' };

export function TopupTracker({
  attempt,
  rows,
  confirmations,
  network = chainName(attempt.chain),
  wallet,
  back,
  onClaim,
  onHash,
  onCancel,
  onDone,
}: {
  attempt: TopupAttempt;
  rows: DepositRow[];
  confirmations: number;
  network?: string;
  /** The wallet controls while the payment still needs the wallet (chooser, pay button, progress). */
  wallet: ReactNode;
  back: { href: string; label: string } | null;
  onClaim: (ref: string) => void;
  onHash?: (hash: Hex) => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  const now = useNow(30_000);
  const view = topupView(attempt, rows, now);
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [stopping, setStopping] = useState(false);
  const [pasted, setPasted] = useState('');
  const [pasteError, setPasteError] = useState('');
  const coin = attempt.rail === 'coin';
  const solana = attempt.rail === 'solana';
  const sent = attempt.walletOpenedAt !== null || attempt.hash !== null;

  // Focus follows the payment: when the card first appears and when the credit lands.
  useEffect(() => { heading.current?.focus({ preventScroll: false }); }, [attempt.id, view.stage]);

  const credit = view.row ? formatUsdAmount(view.row.amount_usd) : '';
  const steps: Step[] = [
    {
      title: 'Confirm in wallet',
      detail: view.stage === 'wallet'
        ? (solana || !attempt.walletOpenedAt ? 'Approve the payment in your wallet.' : 'Waiting for your approval. Come back here after you confirm.')
        : 'Approved in your wallet.',
      state: view.stage === 'wallet' ? 'active' : 'done',
    },
    {
      title: 'Network confirmation',
      detail: view.stage === 'wallet' ? (solana ? 'We’ll check for your payment after you confirm.' : 'Starts after you confirm.')
        : view.stage === 'network' ? `Waiting for ${confirmations} confirmation${confirmations === 1 ? '' : 's'} on ${network}.`
        : 'Confirmed on the network.',
      state: view.stage === 'wallet' ? 'next' : view.stage === 'network' ? 'active' : 'done',
    },
    {
      title: view.stage === 'held' ? 'Credit held' : 'Credit available',
      detail: view.stage === 'credited' ? `${credit} added to your balance.`
        : view.stage === 'held' ? `${credit} received but not spendable yet. ${heldReason(view.row?.reason)}`
        : coin ? 'Appears as usage-only credit in your chat balance.' : 'Appears in your chat balance.',
      state: view.stage === 'credited' ? 'done' : view.stage === 'held' ? 'held' : 'next',
    },
  ];
  const announcement = view.stage === 'credited' ? `Top-up complete. ${credit} added to your balance.`
    : view.stage === 'held' ? `Payment received but held. ${heldReason(view.row?.reason)}`
    : view.stage === 'network' ? 'Payment submitted. Waiting for network confirmation.'
    : 'Waiting for your wallet.';

  function findByHash(event: { preventDefault: () => void }) {
    event.preventDefault();
    const value = pasted.trim();
    if (!HASH.test(value)) return setPasteError('A transaction hash is 0x followed by 64 letters and numbers.');
    setPasteError('');
    onHash?.(value.toLowerCase() as Hex);
  }

  const finished = view.stage === 'credited' || view.stage === 'held';
  return (
    <section className="topup-tracker" aria-labelledby={headingId}>
      <header className="topup-head">
        <span className="topup-kicker">Payment status</span>
        <h2 id={headingId} ref={heading} tabIndex={-1}>
          <span className="sr-only">Payment status: </span>
          {/* The typed amount is dollars on the NYMO rail and token units on the stablecoin rails. */}
          {coin ? `${formatUsdAmount(attempt.amount)} of NYMO` : `${attempt.amount} ${attempt.token}`}
        </h2>
        <p className="wallet-network">{coin ? `${attempt.coinAmount ? `${attempt.coinAmount} NYMO quoted · ` : ''}${network} · usage-only credit` : network}</p>
      </header>

      <ol className="topup-steps">
        {steps.map((step, n) => (
          <li key={step.title} className={`topup-step is-${step.state}`} aria-current={step.state === 'active' ? 'step' : undefined}>
            <span className="topup-mark" aria-hidden="true">
              {step.state === 'done' ? <CheckCircle2 size={22} /> : step.state === 'held' ? <ShieldAlert size={22} /> : n + 1}
            </span>
            <span>
              <strong>{step.title}</strong>
              <small>{step.detail}</small>
            </span>
          </li>
        ))}
      </ol>
      <output className="sr-only" aria-live="polite">{announcement}</output>

      {view.delayed && !finished && (
        <p className="topup-delay"><Clock3 size={16} aria-hidden="true" />
          {view.stage === 'network'
            ? 'This is taking longer than usual. The payment is safe; we keep checking.'
            : 'No payment has reached this key yet. If you approved it, it can take a few minutes. We keep checking.'}
        </p>
      )}

      {attempt.uncertain && !finished && (
        <p className="topup-delay"><Clock3 size={16} aria-hidden="true" />
          Your wallet stopped answering after it sent the payment. We are checking the network for it, so there is no need to pay again.
        </p>
      )}

      {view.stage === 'credited' && view.by === 'amount' && (
        <p className="faint">Matched to your payment by amount and time.</p>
      )}

      {!finished && view.stage === 'wallet' && wallet}

      {!finished && view.candidates.length > 0 && (
        <div className="topup-candidates">
          {view.candidates.slice(0, 3).map(row => (
            <div key={row.ref}>
              <p>
                {coin ? 'A NYMO payment' : `A ${formatUsdAmount(row.amount_usd)} ${row.token} deposit`} reached this key at{' '}
                {new Date(row.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                {coin ? ` (${formatUsdAmount(row.amount_usd)} credit)` : ''}. Was this your payment?
              </p>
              <button type="button" className="btn btn-small" onClick={() => onClaim(row.ref)}>Yes, that was mine</button>
            </div>
          ))}
        </div>
      )}

      {!finished && onHash && !attempt.hash && sent && (
        <details className="wallet-payment-details">
          <summary>Have the transaction hash?</summary>
          <form className="topup-hash" onSubmit={findByHash}>
            <label className="field">Transaction hash
              <input className="input mono" value={pasted} spellCheck={false} autoComplete="off" inputMode="text"
                onChange={event => { setPasted(event.target.value); setPasteError(''); }} />
            </label>
            <button type="submit" className="btn btn-small">Find payment</button>
            {pasteError && <p className="error-text" role="alert">{pasteError}</p>}
          </form>
        </details>
      )}

      {finished ? (
        <div className="topup-actions">
          {view.stage === 'credited' && back && <Link className="btn btn-primary wallet-primary" href={back.href}>{back.label}</Link>}
          <button type="button" className={view.stage === 'credited' && back ? 'btn btn-ghost' : 'btn'} onClick={onDone}>
            {view.stage === 'credited' ? 'Done' : 'Close'}
          </button>
        </div>
      ) : stopping ? (
        <div className="topup-stop">
          <p>Stop tracking this top-up? If your wallet already sent it, the credit still arrives on this key.</p>
          <div className="topup-actions">
            <button type="button" className="btn" onClick={onCancel}>Stop tracking</button>
            <button type="button" className="btn btn-ghost" onClick={() => setStopping(false)}>Keep waiting</button>
          </div>
        </div>
      ) : (
        <button type="button" className="wallet-edit" onClick={() => (sent ? setStopping(true) : onCancel())}>
          Cancel top-up
        </button>
      )}
    </section>
  );
}
