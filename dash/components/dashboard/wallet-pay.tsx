'use client';

// Pay from a browser wallet (plain EIP-1193, no wallet SDK): stablecoins through the DepositRouter, or ANMO through
// CoinPay. After the transaction confirms, GET /deposits is polled until the gateway records the deposit.

import { Wallet } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { CopyButton } from '../copy-button';
import { chainName, evmNetwork, shortAddress } from '@/lib/anonymo/chains';
import { formatUsd, formatUsdAmount, parseUsd } from '@/lib/anonymo/money';
import type { CoinInstructions, DepositRow, EvmChain, EvmInstructions } from '@/lib/anonymo/types';
import {
  depositStablecoin,
  describeWalletError,
  formatUnits,
  injectedProvider,
  payWithCoin,
  quoteCoins,
  rowForTx,
  stableUnits,
  type PayResult,
  type PayStep,
} from '@/lib/anonymo/wallet';

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

/** Polls GET /deposits until the gateway has a row for this transaction. */
function useCreditWatch(hash: string | null, onCredited: () => void) {
  const { client } = useAnonymo();
  const [row, setRow] = useState<DepositRow | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  // The caller mounts one watcher per transaction (keyed by its hash), so there is no earlier state to reset.
  useEffect(() => {
    if (!hash) return;
    let live = true;
    const until = Date.now() + POLL_FOR_MS;
    const controller = new AbortController();
    const tick = async () => {
      if (!live) return;
      try {
        const found = rowForTx((await client.deposits(controller.signal)).data, hash);
        if (found && live) {
          setRow(found);
          onCredited();
          return;
        }
      } catch {
        // a missed poll is retried
      }
      if (Date.now() > until) return live && setGaveUp(true);
      if (live) setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      controller.abort();
    };
  }, [hash, client, onCredited]);
  return { row, gaveUp };
}

function PaymentStatus({ result, confirmations, coin, onCredited }: { result: PayResult; confirmations: number; coin: boolean; onCredited: () => void }) {
  const { row, gaveUp } = useCreditWatch(result.hash, onCredited);
  return (
    <output className="notice notice-signal panel-stack" aria-live="polite">
      <span>
        Transaction <span className="mono">{shortAddress(result.hash, 8)}</span> is mined
        {result.method === 'permit' ? ' (permit, one transaction)' : result.method === 'approve' ? ' (approve, then deposit)' : ''}.
      </span>
      {!row && !gaveUp && <span>Pending: the gateway credits it after {confirmations} confirmations. This updates on its own.</span>}
      {!row && gaveUp && (
        <span>
          Not credited yet. It is safe to leave: the credit lands on this key when the gateway sees the payment. Refresh later.
        </span>
      )}
      {row?.status === 'credited' && (
        <strong>
          Credited {formatUsdAmount(row.amount_usd)}
          {coin ? ' as usage-only credit.' : '. The sending wallet is now a withdrawal address for it.'}
        </strong>
      )}
      {row?.status === 'held' && (
        <strong>
          Received but held{row.reason === 'over_cap' ? ': it is above the per-payment cap' : ''}. It is not spendable until the operator
          reviews it.
        </strong>
      )}
    </output>
  );
}

/** Stablecoin deposit through the DepositRouter on an EVM chain. */
export function EvmWalletPay({ evm, onCredited }: { evm: EvmInstructions; onCredited: () => void }) {
  const preferred = evm.chains.find((c) => c.chain === 'rhc') ?? evm.chains[0];
  const [chain, setChain] = useState<EvmChain>(preferred.chain);
  const entry = evm.chains.find((c) => c.chain === chain) ?? preferred;
  const [symbol, setSymbol] = useState(entry.tokens.find((t) => t.symbol === 'USDG')?.symbol ?? entry.tokens[0]?.symbol);
  const token = entry.tokens.find((t) => t.symbol === symbol) ?? entry.tokens[0];
  const network = useMemo(() => evmNetwork(entry.chain, entry), [entry]);
  const [amount, setAmount] = useState('10');
  const [step, setStep] = useState<PayStep | null>(null);
  const [result, setResult] = useState<PayResult | null>(null);
  const [error, setError] = useState('');
  const busy = step !== null && step !== 'submitted';
  const hasWallet = typeof window !== 'undefined' && injectedProvider() !== null;

  async function pay() {
    setError('');
    setResult(null);
    const musd = parseUsd(amount);
    if (!musd) return setError('Enter an amount in USD, like 10 or 25.50.');
    const provider = injectedProvider();
    if (!provider) return setError('No browser wallet found. Install one, or send manually with the details below.');
    try {
      const units = stableUnits(musd, token.decimals);
      setResult(
        await depositStablecoin({ provider, network, router: entry.router, token, keyCommit: evm.key_commit, amount: units, onStep: setStep }),
      );
    } catch (e) {
      setError(describeWalletError(e));
    } finally {
      setStep(null);
    }
  }

  return (
    <div className="panel-stack">
      {evm.chains.length > 1 && (
        <fieldset className="segmented">
          <legend className="sr-only">Chain</legend>
          {evm.chains.map((c) => (
            <button
              key={c.chain}
              type="button"
              aria-pressed={c.chain === chain}
              disabled={busy}
              onClick={() => {
                setChain(c.chain);
                setSymbol(c.tokens.find((t) => t.symbol === 'USDG')?.symbol ?? c.tokens[0]?.symbol);
                setResult(null);
                setError('');
              }}
            >
              {chainName(c.chain)}
            </button>
          ))}
        </fieldset>
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void pay();
        }}
      >
        <label className="field" style={{ flex: '0 1 160px' }}>
          Amount (USD)
          <input className="input" inputMode="decimal" value={amount} disabled={busy} onChange={(e) => setAmount(e.target.value)} />
        </label>
        {entry.tokens.length > 1 && (
          <label className="field" style={{ flex: '0 1 120px' }}>
            Token
            <select className="select input" value={token.symbol} disabled={busy} onChange={(e) => setSymbol(e.target.value as typeof symbol)}>
              {entry.tokens.map((t) => (
                <option key={t.symbol} value={t.symbol}>
                  {t.symbol}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit" className="btn btn-primary" style={{ alignSelf: 'flex-end' }} disabled={busy}>
          <Wallet size={16} aria-hidden="true" />
          {busy ? 'Working…' : `Pay ${token.symbol} with wallet`}
        </button>
      </form>
      <p className="faint">
        {token.symbol} on {network.name} credits 1:1. {token.symbol === 'USDG' ? 'USDG supports permit, so it is one signature and one transaction.' : 'If the token has no permit, your wallet asks for an approval first.'}{' '}
        {!hasWallet && 'No browser wallet detected on this page.'}
      </p>
      {step && <p className="notice">{STEP_TEXT[step]}</p>}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {result && <PaymentStatus key={result.hash} result={result} confirmations={entry.confirmations} coin={false} onCredited={onCredited} />}
      <details>
        <summary className="muted" style={{ cursor: 'pointer' }}>
          Send manually instead
        </summary>
        <div className="address-box" style={{ marginTop: 8 }}>
          <span className="faint">
            Call <code>{evm.method}</code> on the DepositRouter. Approve the router for the amount first, or use depositWithPermit.
          </span>
          <dl className="kv">
            <div>
              <dt>Router on {chainName(entry.chain)}</dt>
              <dd className="hash">{entry.router}</dd>
            </div>
            <div>
              <dt>{token.symbol} token</dt>
              <dd className="hash">
                {token.address} · {token.decimals} decimals
              </dd>
            </div>
            <div>
              <dt>keyCommit</dt>
              <dd className="hash">{evm.key_commit}</dd>
            </div>
            <div>
              <dt>Credited after</dt>
              <dd>{entry.confirmations} confirmations</dd>
            </div>
          </dl>
          <div className="row">
            <CopyButton text={evm.key_commit} label="Copy keyCommit" />
            <CopyButton text={entry.router} label="Copy router" />
          </div>
          <span className="faint">keyCommit is a one-way hash: it ties the deposit to this key without revealing the key.</span>
        </div>
      </details>
    </div>
  );
}

/** Pay with ANMO through CoinPay. The coins are burned; the credit is usage-only. */
export function CoinWalletPay({ coin, onCredited }: { coin: CoinInstructions; onCredited: () => void }) {
  const network = useMemo(() => evmNetwork('rhc', { chain_id: coin.chain_id }), [coin.chain_id]);
  const [amount, setAmount] = useState('10');
  const [step, setStep] = useState<PayStep | null>(null);
  const [result, setResult] = useState<PayResult | null>(null);
  const [error, setError] = useState('');
  const [understood, setUnderstood] = useState(false);
  const busy = step !== null && step !== 'submitted';
  const musd = parseUsd(amount);
  const quote = musd ? quoteCoins(musd, coin) : null;
  const unavailable = coin.price_usd === null;

  async function pay() {
    setError('');
    setResult(null);
    if (!quote || !quote.ok) return;
    const provider = injectedProvider();
    if (!provider) return setError('No browser wallet found. Install one to pay with ANMO.');
    try {
      setResult(
        await payWithCoin({ provider, network, coinPay: coin.coin_pay, token: coin.token, keyCommit: coin.key_commit, amount: quote.coins, onStep: setStep }),
      );
    } catch (e) {
      setError(describeWalletError(e));
    } finally {
      setStep(null);
    }
  }

  return (
    <div className="panel-stack">
      <p className="notice notice-amber">
        <strong>Paying with ANMO burns the coins.</strong> They are destroyed, not held for you. This key is credited the USD value at
        the time of crediting, which may differ slightly from the estimate below. ANMO credit is <strong>usage only</strong>: it pays for
        requests and can never be withdrawn.
      </p>
      {unavailable ? (
        <p className="notice">ANMO payments are unavailable right now (no current price). Try again later, or pay with a stablecoin.</p>
      ) : (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void pay();
          }}
        >
          <label className="field" style={{ flex: '0 1 160px' }}>
            Amount (USD)
            <input className="input" inputMode="decimal" value={amount} disabled={busy} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <button type="submit" className="btn btn-primary" style={{ alignSelf: 'flex-end' }} disabled={busy || !understood || !quote?.ok}>
            <Wallet size={16} aria-hidden="true" />
            {busy ? 'Working…' : 'Burn ANMO and pay'}
          </button>
        </form>
      )}
      {!unavailable && (
        <p className="faint">
          {quote?.ok ? (
            <>
              About <strong className="mono">{formatUnits(quote.coins, coin.token.decimals)} ANMO</strong> at ${coin.price_usd} per ANMO
              (rounded up). At most {formatUsd(quote.maxMusd)} per payment.
            </>
          ) : quote && quote.reason === 'over_max' && quote.maxMusd !== null ? (
            <span className="error-text">The most one payment can be is {formatUsd(quote.maxMusd)}. Split it into smaller payments.</span>
          ) : (
            'Enter an amount in USD.'
          )}{' '}
          Credited after {coin.confirmations} confirmations on {network.name}.
        </p>
      )}
      {!unavailable && (
        <label className="checkbox">
          <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
          I understand the coins are burned and the credit is usage only, never withdrawable
        </label>
      )}
      {step && <p className="notice">{STEP_TEXT[step]}</p>}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {result && <PaymentStatus key={result.hash} result={result} confirmations={coin.confirmations} coin onCredited={onCredited} />}
    </div>
  );
}

