'use client';

// Tickets (update "tickets"): hand another adult a funded key as a link, a QR code or a printed ticket.
//
// A ticket is a new key (POST /keys) funded from the giver's own wallet through the deposit router, like any deposit.
// Credit never moves between keys, so there is no "pay from my balance". What is left can only go back to the wallet
// that paid, with POST /withdraw and the ticket's key. The key is kept on this device and in the ticket, nowhere else.
// Money moves only on a click on a control that shows the amount.

import { Download, Maximize2, RefreshCw, Ticket as TicketIcon, Trash2, Undo2, Wallet, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { CopyButton } from '../copy-button';
import { checkTicket, depositFor, keyRefusal, sourceOf, useTicketClient } from './ticket-client';
import { TicketPrinter } from './ticket-printer';
import { chainName, evmNetwork, shortAddress } from '@/lib/anonymo/chains';
import { describeError, newIdempotencyKey, type AnonymoClient } from '@/lib/anonymo/client';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { maskKey } from '@/lib/anonymo/key-store';
import { formatUsd, usdToMusd } from '@/lib/anonymo/money';
import { encodeQr, QR_QUIET_ZONE, qrPath } from '@/lib/anonymo/qr';
import { saveTicketPng, ticketDate, ticketFileName } from '@/lib/anonymo/ticket-art';
import {
  applyToTicket,
  canTakeBack,
  checkTicketAmount,
  daysLeft,
  timeLeft,
  DEFAULT_EXPIRY_DAYS,
  expiresSoon,
  expiryFor,
  forgetTicket,
  isSettled,
  keepTicket,
  loadTickets,
  MAX_TICKETS,
  newTicket,
  TICKET_AMOUNTS,
  TICKET_EXPIRY_DAYS,
  TICKET_MAX,
  TICKET_MIN,
  TICKET_STATUS_LABEL,
  ticketLink,
  ticketsStore,
  ticketStatus,
  type GivenTicket,
  type TicketStatus,
} from '@/lib/anonymo/tickets';
import type { DepositInstructions, EvmChain, EvmInstructions, Withdrawal } from '@/lib/anonymo/types';
import { depositStablecoin, describeWalletError, injectedProvider, rowForTx, stableUnits, type PayStep } from '@/lib/anonymo/wallet';
import './tickets.css';

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `t${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);
const linkOf = (ticket: GivenTicket) => ticketLink(window.location.origin, ticket.key);
const expiryLabel = (days: number | null) => (days === null ? 'No expiry' : `${days} days`);

const STATUS_CHIP: Record<TicketStatus, string> = {
  unpaid: 'chip',
  pending: 'chip chip-amber',
  held: 'chip chip-amber',
  ready: 'chip chip-signal',
  in_use: 'chip chip-signal',
  used_up: 'chip',
  taken_back: 'chip',
  expired: 'chip chip-rose',
  unknown: 'chip chip-rose',
};

export function TicketsPanel() {
  const { ready } = useAnonymo();
  // Everything below reads this device and the clock, so it starts once the page is running in the browser.
  return ready ? <Tickets /> : null;
}

function Tickets() {
  const { demo } = useAnonymo();
  const tickets = useDeviceStore(ticketsStore(demo));
  const clientFor = useTicketClient();
  const [amountMusd, setAmountMusd] = useState(TICKET_AMOUNTS[1]);
  const [days, setDays] = useState<number | null>(DEFAULT_EXPIRY_DAYS);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [shownId, setShownId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const canvas = useRef<HTMLCanvasElement>(null);
  const printer = useRef<HTMLElement>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Ask the gateway about every ticket that can still change, one after another, on arrival and on "Refresh".
  const [round, setRound] = useState(0);
  const [checked, setChecked] = useState<{ round: number; failed: number } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      let failed = 0;
      for (const t of loadTickets(demo)) {
        if (controller.signal.aborted) return;
        if (isSettled(ticketStatus(t, Date.now()))) continue;
        try {
          await checkTicket(clientFor(t.key), demo, t, controller.signal);
        } catch {
          failed++;
        }
      }
      if (!controller.signal.aborted) setChecked({ round, failed });
    })();
    return () => controller.abort();
  }, [demo, clientFor, round]);
  const checking = checked?.round !== round;
  // A payment that is mined but not yet credited is asked about again every 15 seconds while this page is open, so
  // the ticket turns up on its own even if the payment step was closed.
  const waiting = tickets.some((t) => t.credit === 'pending');
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setRound((r) => r + 1), 15_000);
    return () => clearInterval(timer);
  }, [waiting]);

  const paying = tickets.find((t) => t.id === payingId) ?? null;
  const shown = tickets.find((t) => t.id === shownId && t.credit === 'credited') ?? null;
  const previewExpiry = useMemo(() => expiryFor(days, now), [days, now]);
  const onPaper = shown
    ? { amountMusd: shown.amountMusd, expiresAt: shown.expiresAt, link: linkOf(shown) }
    : paying
      ? { amountMusd: paying.amountMusd, expiresAt: paying.expiresAt, link: null }
      : { amountMusd, expiresAt: previewExpiry, link: null };

  const show = useCallback((id: string) => {
    setShownId(id);
    setPayingId(null); // a payment step left open stays reachable from the list ("Pay" or "See the payment")
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // On a phone the printer sits below the form: bring it into view so the ticket is seen coming out.
    requestAnimationFrame(() => printer.current?.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'nearest' }));
  }, []);

  return (
    <div className="tk-layout">
      <div className="tk-top">
        {paying && paying.credit !== 'credited' ? (
          <PayStep
            key={paying.id}
            ticket={paying}
            client={clientFor(paying.key)}
            onLeave={() => setPayingId(null)}
            onCredited={() => show(paying.id)}
          />
        ) : shown ? (
          <HandOver key={shown.id} ticket={shown} canvas={canvas} onAnother={() => setShownId(null)} />
        ) : (
          <GiveForm
            amountMusd={amountMusd}
            setAmountMusd={setAmountMusd}
            days={days}
            setDays={setDays}
            expiresAt={previewExpiry}
            full={tickets.length >= MAX_TICKETS}
            onMade={(id) => {
              setShownId(null);
              setPayingId(id);
            }}
          />
        )}
      </div>

      <aside className="tk-side" ref={printer} aria-label={shown ? 'The ticket' : 'Ticket preview'}>
        <TicketPrinter ticket={onPaper} feed={shown ? shown.id : 'preview'} canvasRef={canvas} />
        <p className="faint tk-caption">
          {shown ? 'This picture is the ticket. “Save picture” saves exactly this.' : 'A preview. The code prints once the ticket is paid for.'}
        </p>
      </aside>

      <div className="tk-list-area">
        <GivenList
          tickets={tickets}
          now={now}
          checking={checking}
          failed={checked?.round === round ? checked.failed : 0}
          onRefresh={() => setRound((r) => r + 1)}
          onShow={show}
          onPay={(id) => {
            setShownId(null);
            setPayingId(id);
          }}
          onForgot={(id) => {
            if (id === shownId) setShownId(null);
            if (id === payingId) setPayingId(null);
          }}
        />
      </div>
    </div>
  );
}

// ---- the ticket, ready to hand over -----------------------------------------------------------------------------

function HandOver({ ticket, canvas, onAnother }: { ticket: GivenTicket; canvas: RefObject<HTMLCanvasElement | null>; onAnother: () => void }) {
  const [large, setLarge] = useState(false);
  const [saved, setSaved] = useState<'yes' | 'no' | null>(null);
  const link = linkOf(ticket);
  return (
    <section className="panel" aria-labelledby="tk-hand-title">
      <header>
        <h2 id="tk-hand-title">Your ticket is ready</h2>
        <button type="button" className="btn btn-small btn-ghost" onClick={onAnother}>
          Give another
        </button>
      </header>
      <p className="tk-ready" role="status">
        <TicketIcon size={16} aria-hidden="true" /> {formatUsd(ticket.amountMusd)} of chat credit, {ticket.expiresAt ? `good until ${ticketDate(ticket.expiresAt)}` : 'with no expiry'}.
      </p>
      <p className="lede">Hand it over as a link, as a code to scan, or as a picture to print. All three open the same ticket.</p>
      <div className="address-box">
        <span className="faint">The link. The part after # is the key: a browser keeps it to itself and never sends it to a server.</span>
        <code className="tk-link">{`${window.location.origin}/ticket#k=${maskKey(ticket.key)}`}</code>
        <div className="row">
          <CopyButton text={link} label="Copy link" />
          <button
            type="button"
            className="btn btn-small"
            onClick={async () => {
              if (canvas.current) setSaved((await saveTicketPng(canvas.current, ticketFileName(ticket.amountMusd))) ? 'yes' : 'no');
            }}
          >
            <Download size={14} aria-hidden="true" /> Save picture
          </button>
          <button type="button" className="btn btn-small" onClick={() => setLarge(true)}>
            <Maximize2 size={14} aria-hidden="true" /> Show code large
          </button>
        </div>
      </div>
      {saved === 'yes' && <output className="faint">Saved as a PNG. Print it, or send it the way you would send the link.</output>}
      {saved === 'no' && (
        <p className="error-text" role="alert">
          This browser would not save the picture. Copy the link instead.
        </p>
      )}
      <p className="notice notice-amber">
        <strong>Anyone holding this ticket can spend it.</strong> Hand it to one adult, privately, the way you would hand over cash. What
        they leave unspent can come back only to the wallet that paid, from “Tickets you gave” on this device.
      </p>
      {large && <LargeCode link={link} amountMusd={ticket.amountMusd} onClose={() => setLarge(false)} />}
    </section>
  );
}

// ---- step 1: amount and expiry ----------------------------------------------------------------------------------

function GiveForm({
  amountMusd,
  setAmountMusd,
  days,
  setDays,
  expiresAt,
  full,
  onMade,
}: {
  amountMusd: number;
  setAmountMusd: (musd: number) => void;
  days: number | null;
  setDays: (days: number | null) => void;
  expiresAt: string | null;
  full: boolean;
  onMade: (id: string) => void;
}) {
  const { demo } = useAnonymo();
  const clientFor = useTicketClient();
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const check = typing ? checkTicketAmount(typed) : null;

  async function make() {
    setError('');
    const amount = typing ? checkTicketAmount(typed) : { ok: true as const, musd: amountMusd };
    if (!amount.ok) return setError(amount.reason);
    const fullNote = `This device already keeps ${MAX_TICKETS} tickets. Forget one you no longer need, then try again.`;
    if (full) return setError(fullNote);
    setBusy(true);
    try {
      const at = Date.now();
      const until = expiryFor(days, at);
      // No key is sent: POST /keys needs none. The new key is the ticket.
      const made = await clientFor(null).createKey(until ? { caps: { expires_at: until } } : {});
      const ticket = newTicket({ id: newId(), key: made.key, amountMusd: amount.musd, createdAt: new Date(at).toISOString(), expiresAt: made.caps.expires_at ?? until });
      // Before any payment: a ticket whose key is not kept here could never be taken back.
      if (!keepTicket(demo, ticket))
        return setError(
          loadTickets(demo).length >= MAX_TICKETS
            ? fullNote
            : 'This browser would not keep the ticket on this device, so it was not made and nothing was paid. Private windows often block storage.',
        );
      onMade(ticket.id);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="tk-give-title">
      <header>
        <h2 id="tk-give-title">Give a key</h2>
        <span className="faint">Step 1 of 2 · nothing is paid yet</span>
      </header>
      <p className="lede">
        Pick an amount. You pay it from your own wallet into a brand-new key, and the ticket is that key. Whoever opens it is
        chatting in seconds, with no account and no wallet. Adults only, like everything here.
      </p>
      <form
        className="panel-stack"
        onSubmit={(e) => {
          e.preventDefault();
          void make();
        }}
      >
        <fieldset className="tk-field">
          <legend>Amount</legend>
          <div className="segmented">
            {TICKET_AMOUNTS.map((musd) => (
              <button
                key={musd}
                type="button"
                aria-pressed={!typing && amountMusd === musd}
                disabled={busy}
                onClick={() => {
                  setTyping(false);
                  setAmountMusd(musd);
                  setError('');
                }}
              >
                {formatUsd(musd).replace(/\.00$/, '')}
              </button>
            ))}
            <button type="button" aria-pressed={typing} disabled={busy} onClick={() => setTyping(true)}>
              Other
            </button>
          </div>
          {typing && (
            <label className="field tk-typed">
              Amount in dollars ({formatUsd(TICKET_MIN).replace(/\.00$/, '')} to {formatUsd(TICKET_MAX).replace(/\.00$/, '')})
              <input
                className="input"
                inputMode="decimal"
                autoComplete="off"
                autoFocus
                value={typed}
                disabled={busy}
                aria-invalid={typed !== '' && check !== null && !check.ok}
                aria-describedby="tk-typed-note"
                onChange={(e) => {
                  setTyped(e.target.value);
                  setError('');
                  const next = checkTicketAmount(e.target.value);
                  if (next.ok) setAmountMusd(next.musd);
                }}
              />
              <span id="tk-typed-note" className={typed !== '' && check && !check.ok ? 'error-text' : 'faint'}>
                {typed !== '' && check && !check.ok ? check.reason : 'Whole cents. A ticket is kept small because anyone holding it can spend it.'}
              </span>
            </label>
          )}
        </fieldset>
        <fieldset className="tk-field">
          <legend>Stops working after</legend>
          <div className="segmented">
            {TICKET_EXPIRY_DAYS.map((d) => (
              <button key={String(d)} type="button" aria-pressed={days === d} disabled={busy} onClick={() => setDays(d)}>
                {expiryLabel(d)}
              </button>
            ))}
          </div>
          <p className="faint">
            {expiresAt
              ? `Good until ${ticketDate(expiresAt)}. After that the key is refused for everything, taking credit back included, so take back what is left before then.`
              : 'It works until the credit is spent or you take it back.'}
          </p>
        </fieldset>
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={busy || (typing && !check?.ok)}>
            {busy ? 'Making the key…' : 'Continue to payment'}
          </button>
          <span className="faint">Makes the key. You pay on the next step.</span>
        </div>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}

// ---- step 2: pay from the wallet --------------------------------------------------------------------------------

const STEP_TEXT: Record<PayStep, string> = {
  connecting: 'Connect your wallet…',
  switching: 'Switching your wallet to the right chain…',
  checking: 'Checking your balance and allowance…',
  signing: 'Sign the permit in your wallet (no gas)…',
  approving: 'Approve the spend in your wallet, then wait for it to confirm…',
  sending: 'Confirm the payment in your wallet…',
  confirming: 'Waiting for the transaction to be mined…',
  submitted: 'Mined.',
};
const POLL_MS = 5_000;
const POLL_FOR_MS = 45 * 60_000;

function PayStep({ ticket, client, onLeave, onCredited }: { ticket: GivenTicket; client: AnonymoClient; onLeave: () => void; onCredited: () => void }) {
  const { demo, mock } = useAnonymo();
  const [instructions, setInstructions] = useState<DepositInstructions | null>(null);
  const [error, setError] = useState('');
  const [step, setStep] = useState<PayStep | null>(null);
  const [tried, setTried] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const busy = step !== null && step !== 'submitted';
  const amount = formatUsd(ticket.amountMusd);
  const { id, txHash, credit, amountMusd } = ticket;
  // The parent passes a new function on every render; the wait for credit below must not restart each time.
  const credited = useRef(onCredited);
  useEffect(() => {
    credited.current = onCredited;
  }, [onCredited]);

  // The deposit instructions belong to the ticket's own key: its key_commit is what the payment names.
  useEffect(() => {
    const controller = new AbortController();
    client.deposits(controller.signal).then(
      (d) => !controller.signal.aborted && setInstructions(d.instructions),
      (e: unknown) => !controller.signal.aborted && setError(describeError(e)),
    );
    return () => controller.abort();
  }, [client]);

  // Once the payment is mined, wait for the gateway to record it (it credits after the chain's confirmations).
  useEffect(() => {
    if (credit !== 'pending' || !txHash) return;
    let live = true;
    const until = Date.now() + POLL_FOR_MS;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const row = rowForTx((await client.deposits(controller.signal)).data, txHash);
        if (!live) return;
        if (row?.status === 'credited') {
          applyToTicket(demo, id, { type: 'credited', amountMusd: usdToMusd(row.amount_usd), from: sourceOf(row) });
          return credited.current();
        }
        if (row?.status === 'held') return void applyToTicket(demo, id, { type: 'held' });
      } catch {
        // a missed poll is retried
      }
      if (!live) return;
      if (Date.now() > until) return setGaveUp(true);
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, credit, txHash, demo, id]);

  async function payDemo() {
    if (!mock) return;
    setError('');
    setTried(true);
    try {
      const ref = await mock.simulateDeposit(ticket.key, 'rhc', 'USDG', amountMusd);
      const rows = (await client.deposits()).data;
      const row = rows.find((r) => r.ref === ref) ?? depositFor(rows, null);
      if (!row) throw new Error('The demo gateway did not record the payment.');
      applyToTicket(demo, id, { type: 'credited', amountMusd: usdToMusd(row.amount_usd), from: sourceOf(row) });
      onCredited();
    } catch (e) {
      setError(describeError(e));
    }
  }

  return (
    <section className="panel" aria-labelledby="tk-pay-title">
      <header>
        <h2 id="tk-pay-title">Pay for the ticket</h2>
        <span className="faint">Step 2 of 2</span>
      </header>
      <dl className="kv">
        <div>
          <dt>Ticket</dt>
          <dd>
            <strong>{amount}</strong> of chat credit, on a new key
          </dd>
        </div>
        <div>
          <dt>Stops working</dt>
          <dd>{ticket.expiresAt ? ticketDate(ticket.expiresAt) : 'Never. It works until it is spent or taken back'}</dd>
        </div>
        <div>
          <dt>Unspent credit</dt>
          <dd>Can come back only to the wallet you pay from</dd>
        </div>
      </dl>
      <p className="notice notice-amber">
        <strong>Before you pay:</strong> this credit can only ever return to the paying wallet, and only while this device still keeps
        the ticket. Anyone holding the ticket can spend it.
      </p>

      {credit === 'pending' ? (
        <output className="notice notice-signal panel-stack" aria-live="polite">
          <span>
            Paid. Transaction <span className="mono">{txHash ? shortAddress(txHash, 8) : ''}</span> is mined.
          </span>
          {gaveUp ? (
            <span>Not credited yet. It is safe to leave: the ticket shows under “Tickets you gave” once the gateway sees the payment.</span>
          ) : (
            <span>Waiting for the gateway to credit it. This updates on its own, and the ticket prints as soon as it lands.</span>
          )}
        </output>
      ) : credit === 'held' ? (
        <p className="notice notice-amber">
          The payment arrived but is held for review, so the ticket can’t be used or taken back until the operator releases it.
        </p>
      ) : demo ? (
        <div className="notice notice-amber row">
          <span style={{ flex: 1, minWidth: 200 }}>Demo: no wallet is needed. This simulates a confirmed payment from a test wallet.</span>
          <button type="button" className="btn btn-primary" disabled={!mock} onClick={() => void payDemo()}>
            <Wallet size={16} aria-hidden="true" /> Pay {amount} with test USDG
          </button>
        </div>
      ) : !instructions ? (
        !error && <output className="muted">Loading how to pay…</output>
      ) : instructions.paused ? (
        <p className="notice notice-amber">New deposits are paused right now, so a ticket can’t be paid for. Withdrawals are not affected.</p>
      ) : !instructions.evm || instructions.evm.chains.length === 0 ? (
        <p className="notice">This gateway takes no wallet deposits right now, so a ticket can’t be paid for here.</p>
      ) : (
        <WalletPay
          evm={instructions.evm}
          amountMusd={amountMusd}
          busy={busy}
          onPay={async (o) => {
            setError('');
            setTried(true);
            const provider = injectedProvider();
            if (!provider) return setError('No browser wallet found on this page. Install one, then try again.');
            try {
              const paid = await depositStablecoin({ ...o, provider, keyCommit: instructions.evm!.key_commit, amount: stableUnits(amountMusd, o.token.decimals), onStep: setStep });
              applyToTicket(demo, id, { type: 'payment_sent', txHash: paid.hash, from: { chain: o.chain, address: paid.from } });
            } catch (e) {
              setError(describeWalletError(e));
            } finally {
              setStep(null);
            }
          }}
        />
      )}
      {step && <p className="notice">{STEP_TEXT[step]}</p>}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {credit !== 'pending' && (
        <div className="row">
          <button
            type="button"
            className="btn btn-ghost btn-small"
            disabled={busy}
            onClick={() => {
              // Nothing was ever sent to this key, so it can be dropped. Once a payment was tried it is kept, in case
              // the payment went out after all: the list then shows it as soon as the credit lands.
              if (!tried && credit === 'none') forgetTicket(demo, id);
              onLeave();
            }}
          >
            {tried || credit !== 'none' ? 'Close' : 'Back'}
          </button>
          {(tried || credit !== 'none') && <span className="faint">The ticket stays under “Tickets you gave”.</span>}
        </div>
      )}
    </section>
  );
}

type PayChoice = { chain: EvmChain; network: ReturnType<typeof evmNetwork>; router: EvmInstructions['chains'][number]['router']; token: EvmInstructions['chains'][number]['tokens'][number] };

/** Chain and token for the payment, then one button that names the amount. The amount itself is fixed by the ticket. */
function WalletPay({ evm, amountMusd, busy, onPay }: { evm: EvmInstructions; amountMusd: number; busy: boolean; onPay: (choice: PayChoice) => Promise<void> }) {
  const preferred = evm.chains.find((c) => c.chain === 'rhc') ?? evm.chains[0];
  const [chain, setChain] = useState<EvmChain>(preferred.chain);
  const entry = evm.chains.find((c) => c.chain === chain) ?? preferred;
  const [symbol, setSymbol] = useState(entry.tokens.find((t) => t.symbol === 'USDG')?.symbol ?? entry.tokens[0]?.symbol);
  const token = entry.tokens.find((t) => t.symbol === symbol) ?? entry.tokens[0];
  const network = useMemo(() => evmNetwork(entry.chain, entry), [entry]);
  if (!token) return <p className="notice">This chain lists no token to pay with.</p>;
  return (
    <div className="panel-stack">
      <div className="row">
        {evm.chains.length > 1 && (
          <fieldset className="segmented">
            <legend className="sr-only">Chain</legend>
            {evm.chains.map((c) => (
              <button
                key={c.chain}
                type="button"
                aria-pressed={c.chain === entry.chain}
                disabled={busy}
                onClick={() => {
                  setChain(c.chain);
                  setSymbol(c.tokens.find((t) => t.symbol === 'USDG')?.symbol ?? c.tokens[0]?.symbol);
                }}
              >
                {chainName(c.chain)}
              </button>
            ))}
          </fieldset>
        )}
        {entry.tokens.length > 1 && (
          <label className="field tk-token">
            <span className="sr-only">Token</span>
            <select className="select input" value={token.symbol} disabled={busy} onChange={(e) => setSymbol(e.target.value as typeof symbol)}>
              {entry.tokens.map((t) => (
                <option key={t.symbol} value={t.symbol}>
                  {t.symbol}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void onPay({ chain: entry.chain, network, router: entry.router, token })}>
          <Wallet size={16} aria-hidden="true" />
          {busy ? 'Working…' : `Pay ${formatUsd(amountMusd)} from wallet`}
        </button>
        <span className="faint">
          {formatUsd(amountMusd)} in {token.symbol} on {network.name}, credited 1:1 after {entry.confirmations} confirmations.
        </span>
      </div>
    </div>
  );
}

// ---- the code, large enough to scan across a table --------------------------------------------------------------

function LargeCode({ link, amountMusd, onClose }: { link: string; amountMusd: number; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const qr = useMemo(() => {
    try {
      return encodeQr(link);
    } catch {
      return null;
    }
  }, [link]);
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);
  const side = qr ? qr.size + QR_QUIET_ZONE * 2 : 0;
  return (
    <dialog ref={dialog} className="tk-dialog" aria-labelledby="tk-code-title" onClose={onClose} onClick={(e) => e.target === dialog.current && dialog.current?.close()}>
      <div className="tk-dialog-card">
        <header>
          <h2 id="tk-code-title">{formatUsd(amountMusd)} ticket</h2>
          <button type="button" className="btn btn-ghost btn-small" aria-label="Close" onClick={() => dialog.current?.close()}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        {qr ? (
          <svg className="tk-code" viewBox={`0 0 ${side} ${side}`} role="img" aria-label="QR code of the ticket link" shapeRendering="crispEdges">
            <rect width={side} height={side} fill="#fbf6ef" />
            <path d={qrPath(qr)} fill="#24092a" />
          </svg>
        ) : (
          <p className="notice">This link is too long for a code. Copy the link instead.</p>
        )}
        <p className="faint">Point a phone camera at it. Whoever scans it holds the ticket: anyone holding it can spend it.</p>
      </div>
    </dialog>
  );
}

// ---- tickets you gave -------------------------------------------------------------------------------------------

function GivenList({
  tickets,
  now,
  checking,
  failed,
  onRefresh,
  onShow,
  onPay,
  onForgot,
}: {
  tickets: GivenTicket[];
  now: number;
  checking: boolean;
  failed: number;
  onRefresh: () => void;
  onShow: (id: string) => void;
  onPay: (id: string) => void;
  onForgot: (id: string) => void;
}) {
  return (
    <section className="panel" aria-labelledby="tk-list-title">
      <header>
        <h2 id="tk-list-title">Tickets you gave</h2>
        <button type="button" className="btn btn-small btn-ghost" disabled={checking || tickets.length === 0} onClick={onRefresh}>
          <RefreshCw size={14} aria-hidden="true" /> {checking && tickets.length > 0 ? 'Checking…' : 'Refresh'}
        </button>
      </header>
      <p className="lede">
        Kept on this device only. Each ticket’s key is here and in the ticket, nowhere else, so this list is the only place you can
        take credit back from. “Wipe this device” forgets them all.
      </p>
      {failed > 0 && (
        <p className="notice" role="status">
          {failed === 1 ? 'One ticket' : `${failed} tickets`} could not be checked just now. What is shown is from the last time the gateway answered.
        </p>
      )}
      {tickets.length === 0 ? (
        <p className="muted">No tickets yet. The ones you give show up here with what is left on them.</p>
      ) : (
        <ul className="tk-list">
          {tickets.map((t) => (
            <TicketRow key={t.id} ticket={t} now={now} onShow={onShow} onPay={onPay} onForgot={onForgot} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TicketRow({ ticket, now, onShow, onPay, onForgot }: { ticket: GivenTicket; now: number; onShow: (id: string) => void; onPay: (id: string) => void; onForgot: (id: string) => void }) {
  const { demo, refreshBalance } = useAnonymo();
  const clientFor = useTicketClient();
  const client = useMemo(() => clientFor(ticket.key), [clientFor, ticket.key]);
  const status = ticketStatus(ticket, now);
  const [open, setOpen] = useState<'take' | 'forget' | null>(null);
  const [quote, setQuote] = useState<{ chain: Withdrawal['chain']; address: string; musd: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Withdrawal | null>(null);
  // One Idempotency-Key per attempt, reused when the same attempt is retried, so a retry can never pay twice.
  const attempt = useRef<string | null>(null);
  // A confirmation that opens below the fold (a phone, a long list) is brought into view.
  const confirm = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    confirm.current?.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'nearest' });
  }, [open, quote]);
  const left = ticket.leftMusd;
  const days = daysLeft(ticket.expiresAt, now);

  const refused = (e: unknown) => {
    const refusal = keyRefusal(e);
    if (refusal) applyToTicket(demo, ticket.id, { type: refusal });
    setError(
      refusal === 'key_expired'
        ? 'The gateway refused this key because it has expired. An expired key cannot send credit back, so nothing was moved.'
        : refusal === 'key_unknown'
          ? 'The gateway does not know this key, so there is nothing to take back.'
          : describeError(e),
    );
  };

  /** Reads what is left right now, so the button that moves money shows today's figure. */
  async function askTakeBack() {
    setOpen('take');
    setError('');
    setResult(null);
    setQuote(null);
    setBusy(true);
    try {
      const balance = await client.balance();
      const leftNow = usdToMusd(balance.available_usd);
      applyToTicket(demo, ticket.id, { type: 'balance', leftMusd: leftNow > 0 ? leftNow : 0, at: new Date().toISOString() });
      // Only the wallet that paid for this ticket. If someone else added credit, their part is theirs to take back.
      const paid = ticket.paidFrom;
      const dest = (paid && balance.withdraw_to.find((d) => d.chain === paid.chain && d.address.toLowerCase() === paid.address.toLowerCase())) ?? balance.withdraw_to[0];
      const musd = dest ? usdToMusd(dest.max_usd) : 0;
      if (!dest || !(musd > 0)) setError('Nothing is left to take back.');
      else setQuote({ chain: dest.chain, address: dest.address, musd });
    } catch (e) {
      refused(e);
    } finally {
      setBusy(false);
    }
  }

  async function takeBack() {
    if (!quote) return;
    setError('');
    setBusy(true);
    attempt.current ??= newIdempotencyKey();
    try {
      // "all": everything that can go back to that wallet at this moment, which is the figure on the button or, if
      // the holder spent some in the last seconds, less. Never more, and never to another address.
      const done = await client.withdraw({ chain: quote.chain, to: quote.address, amount_usd: 'all' }, attempt.current);
      attempt.current = null;
      applyToTicket(demo, ticket.id, { type: 'taken_back', amountMusd: usdToMusd(done.withdrawal.amount_usd), at: new Date().toISOString() });
      setResult(done.withdrawal);
      setOpen(null);
      setQuote(null);
      void checkTicket(client, demo, ticket).catch(() => undefined);
      refreshBalance(); // the top bar's figure, in case this device's own key is this ticket
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      if (code === 'below_minimum') {
        attempt.current = null;
        setError(`${describeError(e)} What is left is less than that, so it cannot be sent back.`);
      } else if (code === 'nothing_to_withdraw') {
        attempt.current = null;
        setError('Nothing is left to take back.');
      } else refused(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="tk-row" data-status={status}>
      <div className="tk-row-head">
        <strong className="tk-amount">{formatUsd(ticket.amountMusd)}</strong>
        <span className={STATUS_CHIP[status]}>{TICKET_STATUS_LABEL[status]}</span>
        <span className="faint tk-key" title="The start and end of the ticket's key">
          {maskKey(ticket.key)}
        </span>
      </div>
      <p className="tk-row-text">{describe(ticket, status, left)}</p>
      <p className="faint tk-row-text">
        Made {ticketDate(ticket.createdAt)}
        {' · '}
        {ticket.expiresAt === null ? 'no expiry' : status === 'expired' ? (Date.parse(ticket.expiresAt) <= now ? `expired ${ticketDate(ticket.expiresAt)}` : 'expired') : `good until ${ticketDate(ticket.expiresAt)} (${timeLeft(ticket.expiresAt, now)})`}
        {ticket.paidFrom && (
          <>
            {' · paid from '}
            <span className="mono">{shortAddress(ticket.paidFrom.address)}</span> on {chainName(ticket.paidFrom.chain)}
          </>
        )}
      </p>
      {expiresSoon(ticket, now) && (
        <p className="notice notice-amber">
          {days === 1 ? 'It expires within a day.' : `It expires in ${days} days.`} Take back what is left before then: once a key has expired the
          gateway refuses it, and its credit can no longer be sent back.
        </p>
      )}
      <div className="row tk-actions">
        {(status === 'ready' || status === 'in_use') && (
          <>
            <CopyButton text={linkOf(ticket)} label="Copy link" />
            <button type="button" className="btn btn-small" onClick={() => onShow(ticket.id)}>
              <TicketIcon size={14} aria-hidden="true" /> Show ticket
            </button>
          </>
        )}
        {(status === 'unpaid' || status === 'pending' || status === 'held') && (
          <button type="button" className="btn btn-small" onClick={() => onPay(ticket.id)}>
            <Wallet size={14} aria-hidden="true" /> {status === 'unpaid' ? `Pay ${formatUsd(ticket.amountMusd)}` : 'See the payment'}
          </button>
        )}
        {canTakeBack(ticket) && (
          <button type="button" className="btn btn-small" aria-expanded={open === 'take'} disabled={busy} onClick={() => void askTakeBack()}>
            <Undo2 size={14} aria-hidden="true" /> Take back what’s left
          </button>
        )}
        <button
          type="button"
          className="btn btn-small btn-ghost"
          aria-expanded={open === 'forget'}
          disabled={busy}
          onClick={() => {
            setError('');
            setOpen(open === 'forget' ? null : 'forget');
          }}
        >
          <Trash2 size={14} aria-hidden="true" /> Forget
        </button>
        {demo && canTakeBack(ticket) && status !== 'expired' && (
          <button
            type="button"
            className="btn btn-small btn-ghost"
            title="Demo only: moves this ticket's expiry into the past, through the gateway's own PATCH /keys/caps"
            onClick={() => {
              // An ordinary gateway call with the ticket's key. From here on the key is refused, like any expired key.
              void client.updateCaps({ expires_at: new Date(Date.now() - 1000).toISOString() }).then(
                () => checkTicket(client, demo, ticket).catch(() => undefined),
                (e: unknown) => refused(e),
              );
            }}
          >
            Demo: expire it now
          </button>
        )}
      </div>

      {open === 'take' && (
        <div className="tk-confirm" ref={confirm} role="group" aria-label="Take back what is left">
          {quote ? (
            <>
              <p>
                Send <strong>{formatUsd(quote.musd)}</strong> back to <span className="mono">{shortAddress(quote.address)}</span> on {chainName(quote.chain)},
                the wallet that paid for this ticket? Whoever holds the ticket is left with nothing to spend.
              </p>
              <div className="row">
                <button type="button" className="btn btn-primary btn-small" disabled={busy} onClick={() => void takeBack()}>
                  <Undo2 size={14} aria-hidden="true" /> {busy ? 'Sending…' : `Take back ${formatUsd(quote.musd)}`}
                </button>
                <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => setOpen(null)}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            !error && <output className="muted">Reading what is left…</output>
          )}
        </div>
      )}
      {open === 'forget' && (
        <div className="tk-confirm" ref={confirm} role="group" aria-label="Forget this ticket">
          <p>
            {(left ?? 0) > 0 || ticket.credit === 'pending' || ticket.credit === 'held' || (ticket.credit === 'none' && status !== 'unknown') ? (
              <>
                <strong>This device is the only place this ticket’s key is kept, besides the ticket itself.</strong>{' '}
                {(left ?? 0) > 0
                  ? `Forget it and the ${formatUsd(left ?? 0)} left on it can no longer be taken back.`
                  : 'Forget it and any payment still on its way to it can never be taken back.'}{' '}
                Whoever holds the ticket can still spend it.
              </>
            ) : (
              'Nothing is left on this ticket. Forgetting it only removes it from this list.'
            )}
          </p>
          <div className="row">
            <button
              type="button"
              className="btn btn-danger btn-small"
              onClick={() => {
                forgetTicket(demo, ticket.id);
                onForgot(ticket.id);
              }}
            >
              <Trash2 size={14} aria-hidden="true" /> Forget this ticket
            </button>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setOpen(null)}>
              Keep it
            </button>
          </div>
        </div>
      )}
      {result && (
        <output className="notice notice-signal">
          {formatUsd(usdToMusd(result.amount_usd))} {result.token} {result.status === 'sent' ? 'sent' : 'queued'} to <span className="mono">{shortAddress(result.to)}</span> on{' '}
          {chainName(result.chain)}
          {result.tx && (
            <>
              {' '}
              · tx <span className="mono">{shortAddress(result.tx, 8)}</span>
            </>
          )}
          {result.status === 'pending' ? '. It is recorded and debited; the payout is retried until it goes through.' : '.'}
        </output>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

function describe(ticket: GivenTicket, status: TicketStatus, left: number | null): string {
  const of = formatUsd(ticket.amountMusd);
  switch (status) {
    case 'unpaid':
      return 'Nothing has been paid into this ticket.';
    case 'pending':
      return 'Paid. Waiting for the gateway to credit it.';
    case 'held':
      return 'The payment arrived but is held for review, so it can’t be spent or taken back yet.';
    case 'ready':
      return left === null ? `${of} on it. Not checked yet.` : `${formatUsd(left)} left of ${of}. Nobody has used it yet.`;
    case 'in_use':
      return `${formatUsd(left ?? 0)} left of ${of}.`;
    case 'used_up':
      return `Nothing left of ${of}: it was spent.`;
    case 'taken_back':
      return `Nothing left. You took back ${formatUsd(ticket.takenBackMusd)} of ${of}.`;
    case 'expired':
      return ticket.keyState === 'expired'
        ? `${left && left > 0 ? `${formatUsd(left)} was left when it was last checked. ` : ''}The gateway refuses an expired key for everything, taking credit back included, so what was left on it cannot be sent back.`
        : `${left && left > 0 ? `${formatUsd(left)} left. ` : ''}Its date has passed.`;
    case 'unknown':
      return 'The gateway does not know this key.';
  }
}
