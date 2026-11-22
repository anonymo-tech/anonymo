'use client';

// Pay from a browser wallet (plain EIP-1193, no wallet SDK): stablecoins through the DepositRouter, or ANMO through
// CoinPay. After the transaction confirms, GET /deposits is polled until the gateway records the deposit.

import { ArrowLeft, ArrowRight, Coins, Wallet } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { CopyButton } from '../copy-button';
import { OpenInWalletApp, useWalletAccess, useWalletPayment, WalletProgress } from '../pay-in-wallet';
import { chainName, evmNetwork, shortAddress } from '@/lib/anonymo/chains';
import { formatUsd, formatUsdAmount, parseUsd } from '@/lib/anonymo/money';
import type { CoinInstructions, DepositRow, EvmChain, EvmInstructions } from '@/lib/anonymo/types';
import {
  depositStablecoin,
  formatUnits,
  injectedProvider,
  rowForTx,
  stableUnits,
  type PayResult,
} from '@/lib/anonymo/wallet';
import { nymoCreditText } from '@/lib/anonymo/nymo-quote';
import { useNymoQuote } from '../use-nymo-quote';
import { payUrl } from '@/lib/anonymo/wallet-links';

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

function PaymentStatus({ result, confirmations, onCredited }: { result: PayResult; confirmations: number; onCredited: () => void }) {
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
          Credited {formatUsdAmount(row.amount_usd)}. The sending wallet is now a withdrawal address for it.
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
type FundingAmount = { amount: string; setAmount: (amount: string) => void };
type EvmWalletProps = FundingAmount & { evm: EvmInstructions; onCredited: () => void; onWalletOpen?: () => void; methodPicker?: ReactNode; setPaymentLocked: (locked: boolean) => void };
export function EvmWalletPay({ evm, ...events }: EvmWalletProps) {
  const chains = evm.chains.filter((entry) => entry.tokens.length > 0);
  if (!chains.length) return <p className="muted">Stablecoin deposits are unavailable on this network.</p>;
  return <StablecoinPayment evm={{ ...evm, chains }} {...events} />;
}

function AmountChooser({ amount, setAmount, busy = false }: FundingAmount & { busy?: boolean }) {
  const [custom, setCustom] = useState(!['5', '10', '25'].includes(amount));
  const amountInput = useRef<HTMLInputElement>(null);
  return (
    <div className="wallet-amount-section">
    <label htmlFor="wallet-topup-amount">Amount to add</label>
    <div className="wallet-amount-display">
      <span aria-hidden="true">$</span>
      <input ref={amountInput} id="wallet-topup-amount" aria-label="Amount (USD)" inputMode="decimal" autoComplete="off"
        size={Math.max(1, Math.min(16, amount.length))} value={amount} placeholder="0" disabled={busy}
        style={{ width: `${Math.max(1, Math.min(16, amount.length))}ch`, fontSize: amount.length > 8 ? '0.58em' : undefined }}
        onChange={event => { setCustom(true); setAmount(event.target.value); }} />
    </div>
    <div className="wallet-amount-options" role="group" aria-label="Choose an amount">
      {['5', '10', '25'].map(value => (
        <button key={value} type="button" disabled={busy} aria-pressed={!custom && amount === value}
          onClick={() => { setAmount(value); setCustom(false); }}>${value}</button>
      ))}
      <button type="button" disabled={busy} aria-pressed={custom} onClick={() => {
        setCustom(true); amountInput.current?.focus(); amountInput.current?.select();
      }}>Custom</button>
    </div>
  </div>
  );
}

function StablecoinPayment({ evm, onCredited, onWalletOpen, methodPicker, amount, setAmount, setPaymentLocked }: EvmWalletProps) {
  const preferred = evm.chains.find((c) => c.chain === 'rhc') ?? evm.chains[0];
  const [chain, setChain] = useState<EvmChain>(preferred.chain);
  const entry = evm.chains.find((c) => c.chain === chain) ?? preferred;
  const [symbol, setSymbol] = useState(entry.tokens.find((t) => t.symbol === 'USDG')?.symbol ?? entry.tokens[0]?.symbol);
  const token = entry.tokens.find((t) => t.symbol === symbol) ?? entry.tokens[0];
  const network = useMemo(() => evmNetwork(entry.chain, entry), [entry]);
  const [review, setReview] = useState(false);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const continueButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (review) reviewHeading.current?.focus(); }, [review]);
  const validAmount = !!parseUsd(amount);
  const payment = useWalletPayment();
  const { step, hash, result, setError } = payment;
  const busy = !!step || !!hash;
  useEffect(() => { setPaymentLocked(busy); return () => setPaymentLocked(false); }, [busy, setPaymentLocked]);
  const access = useWalletAccess();
  const hasWallet = access === 'injected';
  const useWalletApp = access === 'app';
  const walletAppUrl =
    !hasWallet && typeof window !== 'undefined'
      ? payUrl(window.location.origin, { keyCommit: evm.key_commit, chain: entry.chain, token: token.symbol, amount })
      : '';

  function pay() {
    const musd = parseUsd(amount);
    if (!musd) return setError('Enter a positive amount in USD.');
    const provider = injectedProvider();
    if (!provider) return setError('Open this payment in your wallet app.');
    void payment.submit((callbacks) => depositStablecoin({
      provider, network, router: entry.router, token, keyCommit: evm.key_commit,
      amount: stableUnits(musd, token.decimals), ...callbacks,
    }));
  }

  return (
    <div className="wallet-checkout">
      {!review && !hash ? (
        <form className="wallet-amount-form" onSubmit={event => {
          event.preventDefault();
          if (!validAmount || busy) return;
          if (hasWallet) pay();
          else setReview(true);
        }}>
          <AmountChooser amount={amount} setAmount={value => { setAmount(value); setError(''); }} busy={busy} />
          <div className="wallet-pay-method">
            <div className="wallet-pay-token"><Coins size={21} aria-hidden="true" /></div>
            <div><span>Payment network</span><strong>{token.symbol} <small>on {network.name}</small></strong></div>
            {methodPicker}
          </div>
          {(evm.chains.length > 1 || entry.tokens.length > 1) && (
            <details className="wallet-network-options">
              <summary>Change network or token</summary>
              <label className="field">Network
                <select className="select" value={entry.chain} disabled={busy} onChange={event => {
                  const next = evm.chains.find(c => c.chain === event.target.value);
                  if (!next) return;
                  setChain(next.chain); setSymbol(next.tokens.find(t => t.symbol === 'USDG')?.symbol ?? next.tokens[0].symbol); setError('');
                }}>
                  {evm.chains.map(c => <option key={c.chain} value={c.chain}>{chainName(c.chain)}</option>)}
                </select>
              </label>
              {entry.tokens.length > 1 && <label className="field">Token
                <select className="select" value={token.symbol} disabled={busy} onChange={event => setSymbol(event.target.value as typeof symbol)}>
                  {entry.tokens.map(t => <option key={t.symbol} value={t.symbol}>{t.symbol}</option>)}
                </select>
              </label>}
            </details>
          )}
          <button ref={continueButton} className="wallet-primary btn btn-primary" type="submit" disabled={busy || !validAmount}>
            {busy ? 'Payment in progress' : hasWallet ? `Pay ${amount.trim()} ${token.symbol}` : 'Continue to wallet'}
            {hasWallet ? <Wallet size={17} aria-hidden="true" /> : <ArrowRight size={18} aria-hidden="true" />}
          </button>
          {!validAmount && <p className="faint" role="status">Enter an amount greater than zero.</p>}
        </form>
      ) : !hash && (
        <div className="wallet-review">
          <button type="button" className="wallet-edit" onClick={() => {
            setReview(false); requestAnimationFrame(() => continueButton.current?.focus());
          }}><ArrowLeft size={15} aria-hidden="true" />Edit amount</button>
          <h2 ref={reviewHeading} tabIndex={-1}>{amount.trim()} {token.symbol}</h2>
          <p className="wallet-network">{network.name}</p>
          {hasWallet ? <button type="button" className="wallet-primary btn btn-primary" disabled={busy} onClick={pay}>Pay {amount.trim()} {token.symbol}</button>
            : <OpenInWalletApp url={walletAppUrl} showApps={useWalletApp} onWalletOpen={onWalletOpen} />}
        </div>
      )}
      <WalletProgress payment={payment} />
      {result && <PaymentStatus key={result.hash} result={result} confirmations={entry.confirmations} onCredited={onCredited} />}
      {hash && !step && <button type="button" className="btn wallet-new-payment" onClick={() => { setReview(false); payment.startAnother(); }}>Start another payment</button>}
      <details className="wallet-payment-details">
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

/** Pay with the coin (launched on Pons) through CoinPay. The coins go to the dead address; the credit is usage-only. */
export function CoinWalletPay({ coin, onWalletOpen, amount, setAmount }: FundingAmount & { coin: CoinInstructions; onWalletOpen: () => void }) {
  const { client, demo } = useAnonymo();
  const [review, setReview] = useState(false);
  const access = useWalletAccess();
  const musd = parseUsd(amount);
  const { quote, message, failed, retry } = useNymoQuote(client, coin, musd);
  const paymentUrl = !demo && quote && typeof window !== 'undefined'
    ? payUrl(window.location.origin, { keyCommit: coin.key_commit, chain: 'rhc', token: 'NYMO', amount }) : '';

  return (
    <div className="wallet-checkout">
      <p>Pay with NYMO on Robinhood Chain for chat credit. The payment burns your coins. This credit can only be spent on Anonymo.</p>
      <AmountChooser amount={amount} setAmount={value => { setAmount(value); setReview(false); }} />
      {quote && musd ? <p><strong>{formatUnits(BigInt(quote.amount_raw), coin.token.decimals, coin.token.decimals)} NYMO</strong>. {nymoCreditText(quote, musd)} The final credit uses the price at confirmation.</p>
        : <p role="status">{message} {failed && <button type="button" className="btn" onClick={retry}>Retry quote</button>}</p>}
      {demo ? <p className="muted">This preview uses a simulated coin payment.</p>
        : access === 'injected' && paymentUrl ? <a className="wallet-primary btn btn-primary" href={paymentUrl} target="_blank" rel="noopener noreferrer" onClick={onWalletOpen}>Review NYMO payment <ArrowRight size={17} aria-hidden="true" /></a>
        : review && paymentUrl ? <OpenInWalletApp url={paymentUrl} showApps={access === 'app'} onWalletOpen={onWalletOpen} />
        : <button type="button" className="wallet-primary btn btn-primary" disabled={!paymentUrl} onClick={() => setReview(true)}>Continue to wallet <ArrowRight size={17} aria-hidden="true" /></button>}
    </div>
  );
}
