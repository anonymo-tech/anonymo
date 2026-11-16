'use client';

// The purse: balance, how to deposit on each rail the gateway offers (GET /deposits), browser-wallet payments,
// recent deposits, and withdrawals that can only go back to an address the credit came from.

import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { CopyButton } from '../copy-button';
import { CoinWalletPay, EvmWalletPay } from './wallet-pay';
import { chainName, shortAddress } from '@/lib/anonymo/chains';
import { describeError, newIdempotencyKey } from '@/lib/anonymo/client';
import { formatUsd, formatUsdAmount, musdToUsdString, parseUsd, usdToMusd } from '@/lib/anonymo/money';
import type { Balance, BtcpayInvoice, DepositInstructions, DepositRow, Withdrawal } from '@/lib/anonymo/types';

type Loaded = { balance: Balance; instructions: DepositInstructions; deposits: DepositRow[]; withdrawals: Withdrawal[] };

export function FundsPanel() {
  const { ready, key, client, balanceVersion, refreshBalance } = useAnonymo();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!ready || !key) return;
    let live = true;
    Promise.all([client.balance(), client.deposits(), client.withdrawals()]).then(
      ([balance, deposits, withdrawals]) => {
        if (!live) return;
        setError('');
        setData({ balance, instructions: deposits.instructions, deposits: deposits.data, withdrawals });
      },
      (e: unknown) => live && setError(describeError(e)),
    );
    return () => {
      live = false;
    };
  }, [ready, key, client, balanceVersion]);

  if (!ready) return null;
  if (!key)
    return (
      <section className="panel">
        <h2>Balance & deposits</h2>
        <p className="lede">Create a key first. Deposits are tied to the key, not to an account.</p>
        <div className="row">
          <Link className="btn btn-primary" href="/dashboard/key">
            Create a key
          </Link>
        </div>
      </section>
    );

  const b = data?.balance;
  const usageOnly = b?.usage_only_usd ?? 0;
  return (
    <div className="panel-stack">
      {error && <p className="notice notice-rose">{error}</p>}
      <section className="panel" aria-labelledby="balance-title">
        <header>
          <h2 id="balance-title">Balance</h2>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => refreshBalance()}>
            <RefreshCw size={14} aria-hidden="true" /> Refresh
          </button>
        </header>
        <div className="stats">
          <div className="stat">
            <span>Available</span>
            <strong>{b ? formatUsdAmount(b.available_usd) : '—'}</strong>
          </div>
          <div className="stat">
            <span>Held for requests in flight</span>
            <strong>{b ? formatUsdAmount(b.held_usd) : '—'}</strong>
          </div>
          {usageOnly > 0 && (
            <div className="stat">
              <span>Paid in {coinOf(data?.instructions)?.token.symbol ?? 'the coin'} · usage only, can&apos;t be withdrawn</span>
              <strong>{formatUsdAmount(usageOnly)}</strong>
            </div>
          )}
        </div>
      </section>
      {data && <Deposits instructions={data.instructions} onCredited={refreshBalance} />}
      {data && data.deposits.length > 0 && <DepositList rows={data.deposits} />}
      {b && <Withdrawals balance={b} onDone={refreshBalance} />}
      {data && data.withdrawals.length > 0 && <WithdrawalList rows={data.withdrawals} />}
    </div>
  );
}

type Rail = 'evm' | 'coin' | 'solana' | 'tron' | 'btc';
const RAIL_LABEL: Record<Rail, string> = { evm: 'Stablecoin wallet', coin: 'Pay with the coin', solana: 'Solana', tron: 'Tron', btc: 'Bitcoin / Lightning' };
const coinOf = (i?: DepositInstructions) => (i && !i.paused ? (i.coin ?? null) : null);
const railLabel = (r: Rail, i: DepositInstructions) => {
  const coin = coinOf(i);
  return r === 'coin' && coin ? `Pay with ${coin.token.symbol}` : RAIL_LABEL[r];
};

function Deposits({ instructions, onCredited }: { instructions: DepositInstructions; onCredited: () => void }) {
  const { demo, mock, key } = useAnonymo();
  const rails: Rail[] = instructions.paused
    ? []
    : (['evm', 'coin', 'solana', 'tron', 'btc'] as const).filter((r) => (instructions as Record<string, unknown>)[r]);
  const [rail, setRail] = useState<Rail | null>(null);
  const active = rail && rails.includes(rail) ? rail : (rails[0] ?? null);
  const [note, setNote] = useState('');
  const credited = useCallback(() => onCredited(), [onCredited]);

  return (
    <section className="panel" aria-labelledby="deposit-title">
      <header>
        <h2 id="deposit-title">Deposit</h2>
        <span className="faint">Stablecoins credit 1:1 · BTC at the BTCPay quote</span>
      </header>
      {instructions.paused ? (
        <p className="notice notice-amber">New deposits are paused right now. Withdrawals are not affected and are never paused.</p>
      ) : rails.length === 0 ? (
        <p className="lede">This gateway has no deposit rail configured yet.</p>
      ) : (
        <>
          {rails.length > 1 && (
            <fieldset className="segmented">
              <legend className="sr-only">How to pay</legend>
              {rails.map((r) => (
                <button key={r} type="button" aria-pressed={r === active} onClick={() => setRail(r)}>
                  {railLabel(r, instructions)}
                </button>
              ))}
            </fieldset>
          )}
          {active === 'evm' && instructions.evm && <EvmWalletPay evm={instructions.evm} onCredited={credited} />}
          {active === 'coin' && instructions.coin && <CoinWalletPay coin={instructions.coin} onCredited={credited} />}
          {active === 'solana' && instructions.solana && (
            <div className="address-box">
              <span className="faint">
                Send {instructions.solana.tokens.map((t) => t.symbol).join(' or ')} on Solana ({instructions.solana.cluster}). {instructions.solana.how}
              </span>
              <dl className="kv">
                {instructions.solana.tokens.map((t) => (
                  <div key={t.mint}>
                    <dt>{t.symbol} token account</dt>
                    <dd className="hash">{t.token_account}</dd>
                  </div>
                ))}
                <div>
                  <dt>Reference</dt>
                  <dd className="hash">{instructions.solana.reference}</dd>
                </div>
              </dl>
              <div className="row">
                <CopyButton text={instructions.solana.reference} label="Copy reference" />
              </div>
            </div>
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
          {active !== 'coin' && (
            <p className="faint">
              The wallet you send from becomes this credit&apos;s source: withdrawals can only go back there, and are never paused.
            </p>
          )}
        </>
      )}
      {demo && mock && key && (
        <div className="notice notice-amber row">
          <span style={{ flex: 1, minWidth: 200 }}>Demo: simulate a confirmed payment to this key.</span>
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
              setNote('$5.00 of ANMO burned for usage-only credit.');
              onCredited();
            }}
          >
            Burn test ANMO
          </button>
        </div>
      )}
      {note && <output className="notice notice-signal">{note}</output>}
    </section>
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
    <section className="panel">
      <h2>Recent deposits</h2>
      <ul className="list">
        {rows.slice(0, 20).map((r) => (
          <li key={r.ref}>
            <span>
              <strong>{chainName(r.chain)}</strong> {r.chain === 'coin' ? '' : r.token}{' '}
              {r.chain === 'coin' && <span className="chip">usage only, can&apos;t be withdrawn</span>}
              {r.status === 'held' && <span className="chip chip-amber">held{r.reason === 'over_cap' ? ' · over the per-payment cap' : ''}</span>}
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
    <section className="panel" aria-labelledby="withdraw-title">
      <header>
        <h2 id="withdraw-title">Withdraw to source</h2>
        <span className="faint">Never paused · never to another address</span>
      </header>
      {balance.withdraw_to.length === 0 ? (
        <p className="lede">Nothing to withdraw yet. Credit can go back only to the wallet it was deposited from.</p>
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
        <p className="faint">{formatUsdAmount(usageOnly)} was paid in the coin. It is usage only and can&apos;t be withdrawn, so it is not counted above.</p>
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
    <section className="panel">
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
