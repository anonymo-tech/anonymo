'use client';

// The purse: balance, how to deposit on each rail the gateway offers (GET /deposits), browser-wallet payments,
// recent deposits, and withdrawals that can only go back to an address the credit came from.

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { setupHref, setupReturn } from '@/lib/anonymo/setup-return';
import { ArrowDownLeft, ArrowLeft, ArrowRight, ArrowUpRight, ChevronDown, Clock3, KeyRound, RefreshCw, Wallet } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { PassesPanel } from './passes-panel';
import { CopyButton } from '../copy-button';
import { CoinWalletPay, EvmWalletPay, type TopupProps } from './wallet-pay';
import { SolanaWalletPay } from './solana-wallet-pay';
import { useTopupAttempt, useTopupPolling, type Topup } from './topup-tracker';
import { heldReason, matchAttempt } from '@/lib/anonymo/topup-attempt';
import { availableNymoRail } from '@/lib/anonymo/wallet-links';
import { chainName, shortAddress } from '@/lib/anonymo/chains';
import { describeError, newIdempotencyKey } from '@/lib/anonymo/client';
import { formatUsd, formatUsdAmount, musdToUsdString, parseUsd, usdToMusd } from '@/lib/anonymo/money';
import type { Balance, BtcpayInvoice, DepositInstructions, DepositRow, Deposits as DepositData, SolanaInstructions, Withdrawal } from '@/lib/anonymo/types';
import { updateOn } from '@/lib/anonymo/updates';

type Loaded = { balance: Balance | null; deposits: DepositData | null; withdrawals: Withdrawal[] | null; errors: string[] };
type Target = ReturnType<typeof setupReturn>;

export function FundsPanel() {
  const { ready, key, demo } = useAnonymo();
  const target = setupReturn(useSearchParams().get('returnTo'));
  if (!ready) return <p className="muted" role="status">Opening Balance…</p>;
  if (key) return <KeyFunds key={key} keySuffix={key.slice(-4)} target={target} />;
  return (
    <section className="funds-page funds-guest">
      {target?.href.split('?')[0] === '/dashboard/chat' && <Link className="funds-back" href={target.href}><ArrowLeft size={15} aria-hidden="true" /> Back to chat</Link>}
      <KeyRound size={26} aria-hidden="true" />
      <h1>Add funds</h1>
      <p>Create a key or connect one you already have. Your key holds the credit you spend across Anonymo.</p>
      <Link className="btn btn-primary" href={setupHref('key', target?.href)}>Set up your key <ArrowRight size={17} aria-hidden="true" /></Link>
      {updateOn('codes', demo) && <Link className="funds-back" href={setupHref('redeem', target?.href)}>Have a code?</Link>}
    </section>
  );
}

function KeyFunds({ keySuffix, target }: { keySuffix: string; target: Target }) {
  const { client, balanceVersion, demo, refreshBalance } = useAnonymo();
  const [data, setData] = useState<Loaded | null>(null);
  const [task, setTask] = useState<'Deposit' | 'Withdraw' | 'Activity'>('Deposit');
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let live = true;
    Promise.allSettled([client.balance(), client.deposits(), client.withdrawals()]).then(([balance, deposits, withdrawals]) => {
      if (!live) return;
      const errors: string[] = [];
      if (balance.status === 'rejected') errors.push(`Balance unavailable. ${describeError(balance.reason)}`);
      if (deposits.status === 'rejected') errors.push(`Deposit details unavailable. ${describeError(deposits.reason)}`);
      if (withdrawals.status === 'rejected') errors.push(`Withdrawal history unavailable. ${describeError(withdrawals.reason)}`);
      setData({
        balance: balance.status === 'fulfilled' ? balance.value : null,
        deposits: deposits.status === 'fulfilled' ? deposits.value : null,
        withdrawals: withdrawals.status === 'fulfilled' ? withdrawals.value : null,
        errors,
      });
    });
    return () => { live = false; };
  }, [client, balanceVersion]);

  useEffect(() => {
    const resume = () => { if (document.visibilityState === 'visible' && document.hasFocus()) refreshBalance(); };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
    };
  }, [refreshBalance]);

  const balance = data?.balance;
  const instructions = data?.deposits?.instructions;
  const rows = data?.deposits?.data;
  // 04: the open top-up on each rail, kept in this browser. While one waits for credit, keep reading the ledger.
  const evmTopup = useTopupAttempt(instructions && !instructions.paused ? instructions.evm?.key_commit : null, 'evm');
  const coinTopup = useTopupAttempt(coinOf(instructions)?.key_commit, 'coin');
  const solpay = updateOn('solpay', demo);
  const solanaTopup = useTopupAttempt(solpay && instructions && !instructions.paused ? instructions.solana?.reference : null, 'solana');
  // A held deposit can still be released, so it keeps being checked; a credited one is finished.
  const waiting = [evmTopup.attempt, coinTopup.attempt, solanaTopup.attempt].flatMap(a => {
    if (!a) return [];
    const m = rows ? matchAttempt(a, rows) : null;
    return m?.kind === 'found' && m.row.status === 'credited' ? [] : [a.startedAt];
  });
  useTopupPolling(waiting.length ? Math.min(...waiting) : null, refreshBalance);
  const stopTracking = useCallback(async (topup: Topup) => {
    const attempt = topup.attempt;
    if (!attempt) return true;
    if (!attempt.walletOpenedAt && !attempt.hash) {
      topup.clear(); // nothing ever reached a wallet
      return true;
    }
    // Reconcile before letting go: a payment that already reached the ledger is shown, not forgotten.
    try {
      const latest = await client.deposits();
      if (matchAttempt(attempt, latest.data).kind === 'found') {
        refreshBalance();
        return false;
      }
    } catch {
      // the ledger could not be read; the person chose to stop tracking, and any credit still lands on the key
    }
    topup.clear();
    return true;
  }, [client, refreshBalance]);
  const hasCredit = !!balance && usdToMusd(balance.available_usd) > 0;
  const resume = target ? (!target.needsCredit || hasCredit) : hasCredit;
  const activity = rows;
  const fromChat = target?.href.split('?')[0] === '/dashboard/chat';
  const back = fromChat && target ? { href: target.href, label: 'Back to chat' }
    : target ? { href: target.href, label: `Return to ${target.label}` } : { href: '/dashboard/chat', label: 'Continue to chat' };
  const tracking = !!evmTopup.attempt || !!coinTopup.attempt || !!solanaTopup.attempt;
  const title = task === 'Deposit' ? 'Add funds' : task === 'Withdraw' ? 'Withdraw funds' : 'Account activity';
  function switchTask(next: typeof task) {
    setTask(next);
    requestAnimationFrame(() => { heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ block: 'nearest' }); });
  }

  return (
    <section className="funds-page" aria-labelledby="funds-title">
      {fromChat && target && <Link className="funds-back" href={target.href}><ArrowLeft size={15} aria-hidden="true" /> Back to chat</Link>}
      <h1 id="funds-title" ref={heading} tabIndex={-1}>{title}</h1>
      <div className="funds-balance" role="region" aria-label="Available credit">
        <Wallet size={17} aria-hidden="true" />
        <div><span>Available credit</span><small>Key ending {keySuffix}</small></div>
        <strong>{balance ? formatUsdAmount(balance.available_usd) : '—'}</strong>
        <button className="funds-refresh" type="button" onClick={refreshBalance} aria-label="Refresh balance" title="Refresh balance"><RefreshCw size={16} aria-hidden="true" /></button>
      </div>
      {balance && usdToMusd(balance.held_usd) > 0 && <p className="funds-credit-detail">{formatUsdAmount(balance.held_usd)} held for active requests.</p>}
      {balance && usdToMusd(balance.usage_only_usd ?? 0) > 0 && <p className="funds-credit-detail">
        {formatUsdAmount(balance.usage_only_usd)} in usage-only credit{balance.code_credit_usd ? '.' : ` from ${coinOf(instructions)?.token.symbol ?? 'coin payments'}.`}
      </p>}
      {data?.errors.map(message => <p className="notice notice-rose" role="alert" key={message}>{message}</p>)}
      {resume && !fromChat && !tracking && <Link className="funds-continue" href={target?.href ?? '/dashboard/chat'}>{target ? `Return to ${target.label}` : 'Continue to chat'} <ArrowRight size={15} aria-hidden="true" /></Link>}
      <div className="funds-body">
        {!data && <p className="muted" role="status">Loading your balance…</p>}
        {instructions && rows && <div hidden={task !== 'Deposit'}>
          <Deposits instructions={instructions} onCredited={refreshBalance} evmTopup={evmTopup} coinTopup={coinTopup}
            solpay={solpay} solanaTopup={solanaTopup} rows={rows} back={back} stopTracking={stopTracking} />
        </div>}
        {balance && <div hidden={task !== 'Withdraw'}><Withdrawals balance={balance} onDone={refreshBalance} /></div>}
        {data && task === 'Activity' && <div className="funds-history">
          {activity && activity.length > 0 && <DepositList rows={activity} />}
          {data.withdrawals && data.withdrawals.length > 0 && <WithdrawalList rows={data.withdrawals} />}
          {activity?.length === 0 && data.withdrawals?.length === 0 && <p className="muted">Deposits and withdrawals will appear here.</p>}
        </div>}
      </div>
      {task === 'Deposit' && updateOn('passes', demo) && <PassesPanel />}
      <nav className="funds-secondary" aria-label="Fund actions">
        {updateOn('codes', demo) && <Link className="funds-back" href={setupHref('redeem', target?.href)}>Have a code?</Link>}
        {task !== 'Deposit' && <button onClick={() => switchTask('Deposit')} type="button"><ArrowDownLeft size={15} aria-hidden="true" /> Add funds</button>}
        {task !== 'Activity' && <button onClick={() => switchTask('Activity')} type="button"><Clock3 size={15} aria-hidden="true" /> Account activity</button>}
        {task !== 'Withdraw' && <button onClick={() => switchTask('Withdraw')} type="button"><ArrowUpRight size={15} aria-hidden="true" /> Withdraw</button>}
      </nav>
    </section>
  );
}

type Rail = 'evm' | 'coin' | 'solana' | 'tron' | 'btc';
const RAIL_LABEL: Record<Rail, string> = { evm: 'Stablecoin wallet', coin: 'NYMO', solana: 'Solana', tron: 'Tron', btc: 'Bitcoin / Lightning' };
const coinOf = (i?: DepositInstructions) => (i && !i.paused ? (i.coin ?? null) : null);
const railLabel = (r: Rail, i: DepositInstructions) => {
  const coin = coinOf(i);
  if (r === 'coin') return availableNymoRail(coin) && coin.price_usd ? 'NYMO · usage credit' : 'NYMO · unavailable';
  if (r === 'evm' && !i.paused) return i.evm?.chains.flatMap(c => c.tokens.map(t => t.symbol)).filter((s, n, tokens) => tokens.indexOf(s) === n).join(' / ') || 'Stablecoin wallet';
  return RAIL_LABEL[r];
};

function Deposits({ instructions, onCredited, evmTopup, coinTopup, solpay, solanaTopup, rows, back, stopTracking }: Omit<TopupProps, 'topup'> & {
  instructions: DepositInstructions;
  onCredited: () => void;
  evmTopup: Topup;
  coinTopup: Topup;
  solpay: boolean;
  solanaTopup: Topup;
}) {
  const { demo, mock, key } = useAnonymo();
  const rails: Rail[] = [];
  if (!instructions.paused) {
    if (instructions.evm?.chains.some(chain => chain.tokens.length > 0)) rails.push('evm');
    if (instructions.solana?.tokens.length) rails.push('solana');
    if (instructions.tron?.tokens.length && instructions.tron.address) rails.push('tron');
    if (instructions.btc) rails.push('btc');
    if (instructions.coin || instructions.evm?.chains.some(c => c.chain === 'rhc')) rails.push('coin');
  }
  // An open top-up keeps its currency until it is finished or cancelled.
  const paymentLocked = !!evmTopup.attempt || !!coinTopup.attempt || !!solanaTopup.attempt;
  const [rail, setRail] = useState<Rail | null>(null);
  const [amount, setAmount] = useState('10');
  const open: Rail | undefined = ([['coin', coinTopup], ['evm', evmTopup], ['solana', solanaTopup]] as const)
    .find(([method, topup]) => topup.attempt && rails.includes(method))?.[0];
  const active = open ?? (rail && rails.includes(rail) ? rail : (rails[0] ?? null));
  const tracked = active === 'coin' ? coinTopup : active === 'evm' ? evmTopup : null;
  const shared = { rows, back, stopTracking };
  const [note, setNote] = useState('');

  const coin = coinOf(instructions);
  const primaryCurrencies = rails.includes('evm') && rails.includes('coin');
  const methodPicker = rails.length > (primaryCurrencies ? 2 : 1) ? (
    <label className="funds-rail-choice">
      Change <ChevronDown size={14} aria-hidden="true" />
      <select aria-label="Payment method" disabled={paymentLocked} value={active ?? ''} onChange={event => setRail(event.target.value as Rail)}>
        {rails.map(r => <option key={r} value={r}>{railLabel(r, instructions)}</option>)}
      </select>
    </label>
  ) : null;

  return (
    <div className="funds-deposit">
      {instructions.paused ? (
        <p className="notice notice-amber">New deposits are paused right now. Withdrawals are not affected and are never paused.</p>
      ) : rails.length === 0 ? (
        <p className="lede">Deposits are unavailable. Check back for payment options.</p>
      ) : (
        <>
          {primaryCurrencies && <fieldset className="funds-currencies">
            <legend>Pay with</legend>
            <button type="button" disabled={paymentLocked} aria-pressed={active === 'evm'} onClick={() => setRail('evm')}>
              {railLabel('evm', instructions).includes('/') ? 'Stablecoin' : railLabel('evm', instructions)}
            </button>
            <button type="button" disabled={paymentLocked} aria-pressed={active === 'coin'} onClick={() => setRail('coin')}>NYMO</button>
          </fieldset>}
          {active && active !== 'evm' && (active !== 'coin' || methodPicker) && <div className="funds-alt-method">
            <strong>{RAIL_LABEL[active]}</strong>{methodPicker}
          </div>}
          {active === 'evm' && instructions.evm && <EvmWalletPay amount={amount} setAmount={setAmount} evm={instructions.evm} methodPicker={methodPicker} topup={evmTopup} {...shared} />}
          {active === 'coin' && (availableNymoRail(coin) && coin.price_usd
            ? <CoinWalletPay amount={amount} setAmount={setAmount} coin={coin} topup={coinTopup} {...shared} />
            : <div className="panel-stack">
                <p role="status">NYMO payments are currently unavailable. A verified dollar price is needed to calculate your credit.</p>
                {rails.includes('evm') && <button type="button" className="btn btn-primary" onClick={() => setRail('evm')}>Pay with {railLabel('evm', instructions)}</button>}
              </div>)}
          {active === 'solana' && instructions.solana && (
            solpay ? <>
              <SolanaWalletPay solana={instructions.solana} topup={solanaTopup} {...shared} />
              <details className="wallet-payment-details">
                <summary>Pay by hand instead</summary>
                <SolanaManual solana={instructions.solana} />
              </details>
            </> : <SolanaManual solana={instructions.solana} />
          )}
          {active === 'tron' && instructions.tron && (
            <div className="address-box">
              <span className="faint">
                Your Tron deposit address · only for this key · USDT · credited after {instructions.tron.confirmations} confirmations
              </span>
              <code>{instructions.tron.address}</code>
              <div className="row">
                <CopyButton text={instructions.tron.address} label="Copy address" />
              </div>
            </div>
          )}
          {active === 'btc' && <BtcpayForm />}

        </>
      )}
      {demo && mock && key && (
        <div className="notice notice-amber row">
          <span style={{ flex: 1, minWidth: 200 }}>Demo: simulate a confirmed payment to this key.</span>
          {tracked?.attempt && (() => {
            const a = tracked.attempt;
            // Stands in for the wallet sending this top-up and the watcher confirming it.
            const send = async (held: boolean) => {
              const hash = a.hash ?? (`0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')}` as const);
              if (!a.hash && a.rail === 'coin') tracked.update({ hash, submittedAt: Date.now() });
              const ref = a.rail === 'coin'
                ? await mock.simulateCoinPayment(key, a.musd, { hash })
                : await mock.simulateDeposit(key, a.chain, a.token, a.musd, { hash: a.hash ?? undefined, held: held ? 'screening_unavailable' : undefined });
              setNote(held ? 'A test payment was received and held for review.' : `Test payment of ${a.amount} ${a.token} confirmed (${ref.slice(0, 14)}…).`);
              onCredited();
            };
            return <>
              <button type="button" className="btn btn-small" onClick={() => void send(false)}>Confirm test payment</button>
              {a.rail === 'evm' && <button type="button" className="btn btn-small" onClick={() => void send(true)}>Hold test payment</button>}
            </>;
          })()}
          <button
            type="button"
            className="btn btn-small"
            onClick={async () => {
              await mock.simulateDeposit(key, 'rhc', 'USDG', 10_000_000);
              setNote('$10.00 in USDG credited from a test Robinhood Chain wallet.');
              onCredited();
            }}
          >
            Send test USDG
          </button>
          <button
            type="button"
            className="btn btn-small"
            onClick={async () => {
              await mock.simulateCoinPayment(key, 5_000_000);
              setNote('$5.00 of NYMO burned for usage-only credit.');
              onCredited();
            }}
          >
            Burn test NYMO
          </button>
        </div>
      )}
      {note && <output className="notice notice-signal">{note}</output>}
    </div>
  );
}

function SolanaManual({ solana }: { solana: SolanaInstructions }) {
  return (
    <div className="address-box">
      <span className="faint">
        Send {solana.tokens.map((t) => t.symbol).join(' or ')} on Solana ({solana.cluster}). {solana.how}
      </span>
      <dl className="kv">
        {solana.tokens.map((t) => (
          <div key={t.mint}>
            <dt>{t.symbol} token account</dt>
            <dd className="hash">{t.token_account} <CopyButton text={t.token_account} label={`Copy ${t.symbol} address`} /></dd>
          </div>
        ))}
        <div>
          <dt>Reference</dt>
          <dd className="hash">{solana.reference}</dd>
        </div>
      </dl>
      <div className="row">
        <CopyButton text={solana.reference} label="Copy reference" />
      </div>
    </div>
  );
}

function BtcpayForm() {
  const { client } = useAnonymo();
  const [amount, setAmount] = useState('10');
  const [refund, setRefund] = useState('');
  const [invoice, setInvoice] = useState<BtcpayInvoice | null>(null);
  const [error, setError] = useState('');
  return (
    <div className="panel-stack">
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          setError('');
          setInvoice(null);
          const musd = parseUsd(amount);
          if (!musd) return setError('Enter an amount in USD.');
          if (!refund.trim()) return setError('Enter a Bitcoin address or a Lightning address for refunds.');
          try {
            setInvoice(await client.btcpayInvoice({ amount_usd: musdToUsdString(musd), refund_address: refund.trim() }));
          } catch (err) {
            setError(describeError(err));
          }
        }}
      >
        <label className="field" style={{ flex: '0 1 140px' }}>
          Amount (USD)
          <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="field" style={{ flex: '1 1 240px' }}>
          Refund address (BTC or name@host)
          <input className="input mono" spellCheck={false} autoComplete="off" value={refund} onChange={(e) => setRefund(e.target.value)} />
        </label>
        <button type="submit" className="btn" style={{ alignSelf: 'flex-end' }}>
          Get invoice
        </button>
      </form>
      <p className="faint">Withdrawals of a BTC or Lightning deposit go to the refund address you give here.</p>
      {invoice && (
        <div className="address-box">
          <span className="faint">
            Invoice {invoice.invoice_id} · ${invoice.amount_usd} · refunds to {chainName(invoice.refund.chain)}{' '}
            <span className="mono">{shortAddress(invoice.refund.address)}</span>
          </span>
          {invoice.checkout_link ? (
            <a className="btn btn-primary" href={invoice.checkout_link} target="_blank" rel="noreferrer noopener">
              Open the BTCPay checkout
            </a>
          ) : (
            <span>The invoice was created; this gateway did not return a checkout link.</span>
          )}
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function DepositList({ rows }: { rows: DepositRow[] }) {
  return (
    <section>
      <h2>Recent deposits</h2>
      <ul className="list">
        {rows.slice(0, 20).map((r) => (
          <li key={r.ref}>
            <span>
              <strong>{chainName(r.chain)}</strong> {r.chain === 'coin' ? '' : r.token}{' '}
              {r.chain === 'coin' && <span className="chip">usage only, can&apos;t be withdrawn</span>}
              {r.from && <small className="funds-from">From {shortAddress(r.from)}</small>}
              {r.status === 'held' && <span className="chip chip-amber" title={heldReason(r.reason)}>held{r.reason === 'over_cap' ? ' · over the per-payment cap' : ''}</span>}
            </span>
            <span className="faint">{new Date(r.created_at).toLocaleString()}</span>
            <span className="mono">{formatUsdAmount(r.amount_usd, { sign: true })}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Withdrawals({ balance, onDone }: { balance: Balance; onDone: () => void }) {
  const { client } = useAnonymo();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Withdrawal | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // One idempotency key per destination and attempt, reused if the same request is retried after a network error.
  const [attempts, setAttempts] = useState<Record<string, string>>({});
  const usageOnly = balance.usage_only_usd ?? 0;

  async function withdraw(dest: Balance['withdraw_to'][number], all: boolean) {
    const id = `${dest.chain}:${dest.address}`;
    setError('');
    setResult(null);
    const musd = all ? null : parseUsd(amounts[id] ?? '');
    if (!all && !musd) return setError('Enter an amount in USD, or withdraw all.');
    const amount = all ? 'all' : musdToUsdString(musd!);
    const sig = `${id}|${amount}`;
    const idem = attempts[sig] ?? newIdempotencyKey();
    setAttempts((m) => ({ ...m, [sig]: idem }));
    setBusy(id);
    try {
      const r = await client.withdraw({ chain: dest.chain, to: dest.address, amount_usd: amount }, idem);
      setResult(r.withdrawal);
      setAmounts((m) => ({ ...m, [id]: '' }));
      setAttempts((m) => {
        const { [sig]: _done, ...rest } = m;
        return rest;
      });
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="funds-withdraw" aria-labelledby="withdraw-title">
      <header>
        <h2 id="withdraw-title">Withdraw to source</h2>
        <p className="muted">Return credit to the wallet that originally sent it.</p>
      </header>
      {balance.withdraw_to.length === 0 ? (
        <p className="lede">No source wallet has funds to withdraw yet.</p>
      ) : (
        <ul className="list">
          {balance.withdraw_to.map((d) => {
            const id = `${d.chain}:${d.address}`;
            const max = usdToMusd(d.max_usd);
            return (
              <li key={id}>
                <span>
                  <strong>{chainName(d.chain)}</strong> <span className="mono faint">→ {shortAddress(d.address)}</span>
                </span>
                <span className="row">
                  <label className="sr-only" htmlFor={`wd-${id}`}>
                    Amount (USD)
                  </label>
                  <input
                    id={`wd-${id}`}
                    className="input"
                    style={{ width: 88, minHeight: 32 }}
                    inputMode="decimal"
                    placeholder="Amount"
                    value={amounts[id] ?? ''}
                    onChange={(e) => setAmounts((m) => ({ ...m, [id]: e.target.value }))}
                  />
                  <button type="button" className="btn btn-small" disabled={busy !== null || !(max > 0)} onClick={() => void withdraw(d, false)}>
                    Withdraw
                  </button>
                  <button
                    type="button"
                    className="btn btn-small btn-ghost"
                    title="The most that can go back to this address now"
                    disabled={busy !== null || !(max > 0)}
                    onClick={() => void withdraw(d, true)}
                  >
                    All <span className="mono">{formatUsd(max)}</span>
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {usageOnly > 0 && (
        <p className="faint">{formatUsdAmount(usageOnly)} {balance.code_credit_usd
          ? 'is reserved for usage.'
          : 'was paid in the coin. It is usage only and can’t be withdrawn, so it is not counted above.'}</p>
      )}
      {result && (
        <output className="notice notice-signal">
          {formatUsdAmount(result.amount_usd)} {result.token} {result.status === 'sent' ? 'sent' : 'queued'} to{' '}
          <span className="mono">{shortAddress(result.to)}</span>
          {result.tx && (
            <>
              {' '}
              · tx <span className="mono">{shortAddress(result.tx, 8)}</span>
            </>
          )}
          {result.status === 'pending' && '. It is recorded and debited; the payout is retried until it goes through.'}
        </output>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function WithdrawalList({ rows }: { rows: Withdrawal[] }) {
  return (
    <section>
      <h2>Withdrawals</h2>
      <ul className="list">
        {rows.slice(0, 20).map((w) => (
          <li key={w.id}>
            <span>
              <strong>{chainName(w.chain)}</strong> {w.token} <span className="mono faint">→ {shortAddress(w.to)}</span>{' '}
              <span className={w.status === 'sent' ? 'chip chip-signal' : 'chip'}>{w.status}</span>
            </span>
            <span className="faint">{new Date(w.created_at).toLocaleString()}</span>
            <span className="mono">{formatUsdAmount(-w.amount_usd, { sign: true })}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
