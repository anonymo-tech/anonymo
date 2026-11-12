'use client';

// The purse: balance, deposit addresses per chain and token, Lightning invoices, and withdrawals that can only go back
// to the address the credit came from (Backend §7).

import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { CopyButton } from '../copy-button';
import { CHAIN_ORDER, CHAINS, shortAddress } from '@/lib/anonymo/chains';
import { describeError } from '@/lib/anonymo/client';
import { formatUsd, parseUsd } from '@/lib/anonymo/money';
import type { Balance, DepositAddress, DepositChain, DepositSource, LedgerKind, LightningInvoice, Withdrawal } from '@/lib/anonymo/types';

const KIND_LABEL: Record<LedgerKind, string> = {
  deposit: 'Deposit',
  hold: 'Hold',
  settle: 'Chat',
  release: 'Released',
  refusal_refund: 'Refusal refund',
  withdraw: 'Withdrawal',
  council: 'Council',
  media: 'Media',
};

export function FundsPanel() {
  const { ready, key, client, balanceVersion, refreshBalance } = useAnonymo();
  const [balance, setBalance] = useState<Balance | null>(null);
  const [addresses, setAddresses] = useState<DepositAddress[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!ready || !key) return;
    let live = true;
    Promise.all([client.balance(), client.depositAddresses()]).then(
      ([b, a]) => {
        if (!live) return;
        setError('');
        setBalance(b);
        setAddresses(a);
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
        <p className="lede">Create a key first. Each key gets its own deposit addresses.</p>
        <div className="row">
          <Link className="btn btn-primary" href="/dashboard/key">
            Create a key
          </Link>
        </div>
      </section>
    );

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
            <strong>{balance ? formatUsd(balance.available_musd) : '—'}</strong>
          </div>
          <div className="stat">
            <span>Held for requests in flight</span>
            <strong>{balance ? formatUsd(balance.held_musd) : '—'}</strong>
          </div>
          <div className="stat">
            <span>Refunded for refusals</span>
            <strong>{balance ? formatUsd(balance.refused_refunded_musd) : '—'}</strong>
          </div>
        </div>
      </section>
      {addresses && <Deposits addresses={addresses} onCredited={refreshBalance} />}
      {balance && <Withdrawals sources={balance.sources} onDone={refreshBalance} />}
      {balance && balance.recent.length > 0 && (
        <section className="panel">
          <h2>Recent activity</h2>
          <ul className="list">
            {balance.recent.slice(0, 15).map((row, i) => (
              <li key={`${row.ref}-${i}`}>
                <span>{KIND_LABEL[row.kind] ?? row.kind}</span>
                <span className="faint">{new Date(row.at).toLocaleString()}</span>
                <span className="mono">{formatUsd(row.amount_musd, { sign: true })}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Deposits({ addresses, onCredited }: { addresses: DepositAddress[]; onCredited: () => void }) {
  const { demo, mock, key, client } = useAnonymo();
  const [chain, setChain] = useState<DepositChain>('base');
  const [amount, setAmount] = useState('10');
  const [invoice, setInvoice] = useState<LightningInvoice | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const address = addresses.find((a) => a.chain === chain);
  const info = CHAINS[chain];
  const available = CHAIN_ORDER.filter((c) => addresses.some((a) => a.chain === c));

  return (
    <section className="panel" aria-labelledby="deposit-title">
      <header>
        <h2 id="deposit-title">Deposit</h2>
        <span className="faint">Stablecoins credit 1:1 · BTC at the BTCPay quote</span>
      </header>
      <fieldset className="segmented">
        <legend className="sr-only">Chain</legend>
        {available.map((c) => (
          <button key={c} type="button" aria-pressed={c === chain} onClick={() => { setChain(c); setInvoice(null); setError(''); setNote(''); }}>
            {CHAINS[c].name}
          </button>
        ))}
      </fieldset>
      <p className="lede">
        Send <strong>{info.tokens.join(', ')}</strong> on {info.name}. {info.note}
        {address && address.min_musd > 0 && <> Minimum {formatUsd(address.min_musd)}.</>}
        {address && address.confirmations > 0 && <> Credited after {address.confirmations} confirmations.</>}
      </p>
      {chain === 'ln' ? (
        <div className="panel-stack">
          <form
            className="row"
            onSubmit={async (e) => {
              e.preventDefault();
              setError('');
              const musd = parseUsd(amount);
              if (!musd) return setError('Enter an amount in USD.');
              try {
                setInvoice(await client.lightningInvoice({ amount_musd: musd }));
              } catch (err) {
                setError(describeError(err));
              }
            }}
          >
            <label className="field" style={{ flex: '0 1 180px' }}>
              Amount (USD)
              <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <button type="submit" className="btn" style={{ alignSelf: 'flex-end' }}>
              Get invoice
            </button>
          </form>
          {invoice && (
            <div className="address-box">
              <span className="faint">
                {invoice.amount_sats.toLocaleString()} sats · {formatUsd(invoice.quote_musd)} · expires{' '}
                {new Date(invoice.expires_at).toLocaleTimeString()}
              </span>
              <code>{invoice.bolt11}</code>
              <div className="row">
                <CopyButton text={invoice.bolt11} label="Copy invoice" />
              </div>
            </div>
          )}
        </div>
      ) : (
        address && (
          <div className="address-box">
            <span className="faint">Your {info.name} deposit address · only for this key</span>
            <code>{address.address}</code>
            <div className="row">
              <CopyButton text={address.address} label="Copy address" />
            </div>
          </div>
        )
      )}
      <p className="faint">
        The wallet you send from becomes this credit&apos;s source: withdrawals can only go back there, and are never paused.
      </p>
      {demo && mock && key && (
        <div className="notice notice-amber row">
          <span style={{ flex: 1, minWidth: 200 }}>Demo: simulate a confirmed deposit to this key.</span>
          <label className="sr-only" htmlFor="demo-amount">
            Test amount (USD)
          </label>
          <input id="demo-amount" className="input" style={{ width: 100 }} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <button
            type="button"
            className="btn btn-small"
            onClick={async () => {
              setError('');
              const musd = parseUsd(amount);
              if (!musd) return setError('Enter an amount in USD.');
              try {
                await mock.simulateDeposit(key, chain, info.tokens[0], musd);
                setNote(`${formatUsd(musd)} in ${info.tokens[0]} credited from a test ${info.name} wallet.`);
                onCredited();
              } catch (err) {
                setError(describeError(err));
              }
            }}
          >
            Send test {info.tokens[0]}
          </button>
        </div>
      )}
      {note && <output className="notice notice-signal">{note}</output>}
      {error && <p className="error-text" role="alert">{error}</p>}
    </section>
  );
}

function Withdrawals({ sources, onDone }: { sources: DepositSource[]; onDone: () => void }) {
  const { client } = useAnonymo();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Withdrawal | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  async function withdraw(source: DepositSource, all: boolean) {
    const id = `${source.chain}:${source.address}`;
    setError('');
    setResult(null);
    const typed = amounts[id] ?? '';
    const musd = all ? 'all' : parseUsd(typed);
    if (musd === null || musd === 0) return setError('Enter an amount in USD, or withdraw all.');
    setBusy(id);
    try {
      setResult(await client.withdraw({ chain: source.chain, source_address: source.address, amount_musd: musd }));
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
      {sources.length === 0 ? (
        <p className="lede">Nothing to withdraw yet. Credit can go back only to the wallet it was deposited from.</p>
      ) : (
        <ul className="list">
          {sources.map((s) => {
            const id = `${s.chain}:${s.address}`;
            return (
              <li key={id}>
                <span>
                  <strong>{CHAINS[s.chain].name}</strong> {s.token} <span className="mono faint">→ {shortAddress(s.address)}</span>
                </span>
                <span className="row">
                  <span className="mono">{formatUsd(s.withdrawable_musd)}</span>
                  <label className="sr-only" htmlFor={`wd-${id}`}>
                    Amount (USD)
                  </label>
                  <input
                    id={`wd-${id}`}
                    className="input"
                    style={{ width: 96, minHeight: 32 }}
                    inputMode="decimal"
                    placeholder="Amount"
                    value={amounts[id] ?? ''}
                    onChange={(e) => setAmounts((m) => ({ ...m, [id]: e.target.value }))}
                  />
                  <button type="button" className="btn btn-small" disabled={busy !== null || s.withdrawable_musd === 0} onClick={() => void withdraw(s, false)}>
                    Withdraw
                  </button>
                  <button type="button" className="btn btn-small btn-ghost" disabled={busy !== null || s.withdrawable_musd === 0} onClick={() => void withdraw(s, true)}>
                    All
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {result && (
        <output className="notice notice-signal">
          {formatUsd(result.amount_musd)} {result.token} {result.status === 'sent' ? 'sent' : 'queued'} to{' '}
          <span className="mono">{shortAddress(result.to)}</span>
          {result.tx_hash && (
            <>
              {' '}
              · tx <span className="mono">{shortAddress(result.tx_hash, 8)}</span>
            </>
          )}
        </output>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
    </section>
  );
}
