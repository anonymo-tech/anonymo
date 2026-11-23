'use client';

// Pay from a browser wallet (plain EIP-1193, no wallet SDK): stablecoins through the DepositRouter, or NYMO through
// CoinPay. Every payment is one tracked top-up (04): it starts on the first tap, survives a reload, and only the
// matching deposit row in GET /deposits finishes it.

import { ArrowRight, Coins, Wallet } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { CopyButton } from '../copy-button';
import { OpenInWalletApp, useWalletAccess, useWalletPayment, WalletProgress } from '../pay-in-wallet';
import { chainName, evmNetwork } from '@/lib/anonymo/chains';
import { parseUsd } from '@/lib/anonymo/money';
import type { CoinInstructions, DepositRow, EvmChain, EvmInstructions, Hex } from '@/lib/anonymo/types';
import { depositStablecoin, formatUnits, injectedProvider, stableUnits } from '@/lib/anonymo/wallet';
import { nymoCreditText } from '@/lib/anonymo/nymo-quote';
import { useNymoQuote } from '../use-nymo-quote';
import { payUrl } from '@/lib/anonymo/wallet-links';
import { newAttempt } from '@/lib/anonymo/topup-attempt';
import { TopupTracker, type Topup } from './topup-tracker';

type FundingAmount = { amount: string; setAmount: (amount: string) => void };
/** What every rail needs to track its top-up: the open attempt, the ledger rows, and where to go after credit. */
export type TopupProps = {
  topup: Topup;
  rows: DepositRow[];
  back: { href: string; label: string } | null;
  /** Stop tracking, after checking the ledger once more. Resolves true when it was cleared. */
  stopTracking: (topup: Topup) => Promise<boolean>;
};

function trackerEvents(topup: Topup, stopTracking: TopupProps['stopTracking'], onClosed: () => void) {
  return {
    onClaim: (ref: string) => topup.update({ claimedRef: ref }),
    onHash: (hash: Hex) => topup.update({ hash, submittedAt: Date.now() }),
    onCancel: () => { void stopTracking(topup).then(cleared => { if (cleared) onClosed(); }); },
    onDone: () => { topup.clear(); onClosed(); },
  };
}

/** Stablecoin deposit through the DepositRouter on an EVM chain. */
type EvmWalletProps = FundingAmount & TopupProps & { evm: EvmInstructions; methodPicker?: ReactNode };
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

function StablecoinPayment({ evm, methodPicker, amount, setAmount, topup, rows, back, stopTracking }: EvmWalletProps) {
  const { attempt } = topup;
  const preferred = evm.chains.find((c) => c.chain === 'rhc') ?? evm.chains[0];
  const [chain, setChain] = useState<EvmChain>(preferred.chain);
  const [symbol, setSymbol] = useState(preferred.tokens.find((t) => t.symbol === 'USDG')?.symbol ?? preferred.tokens[0]?.symbol);
  // An open top-up decides the network and token, so a reload resumes exactly what was started.
  const entry = evm.chains.find((c) => c.chain === (attempt?.chain ?? chain)) ?? preferred;
  const token = entry.tokens.find((t) => t.symbol === (attempt?.token ?? symbol)) ?? entry.tokens[0];
  const network = useMemo(() => evmNetwork(entry.chain, entry), [entry]);
  const continueButton = useRef<HTMLButtonElement>(null);
  const [refocus, setRefocus] = useState(0);
  useEffect(() => { if (refocus) continueButton.current?.focus(); }, [refocus]);
  const validAmount = !!parseUsd(amount);
  const payment = useWalletPayment();
  const { step, setError } = payment;
  const access = useWalletAccess();
  const hasWallet = access === 'injected';
  const payAmount = attempt?.amount ?? amount;
  const walletAppUrl = !hasWallet && typeof window !== 'undefined'
    ? payUrl(window.location.origin, { keyCommit: evm.key_commit, chain: entry.chain, token: token.symbol, amount: payAmount })
    : '';

  function pay() {
    const musd = parseUsd(payAmount);
    if (!musd) return setError('Enter a positive amount in USD.');
    const provider = injectedProvider();
    if (!provider) return setError('Open this payment in your wallet app.');
    void payment.submit(async (callbacks) => {
      let sent = false;
      try {
        return await depositStablecoin({
          provider, network, router: entry.router, token, keyCommit: evm.key_commit,
          amount: stableUnits(musd, token.decimals), ...callbacks,
          onBroadcast: (hash) => { sent = true; callbacks.onBroadcast(hash); topup.update({ hash, submittedAt: Date.now(), walletOpenedAt: Date.now() }); },
        });
      } catch (error) {
        // Sent but not confirmed back to us: keep tracking that transaction instead of inviting a second payment.
        if (sent) topup.update({ uncertain: true });
        throw error;
      }
    });
  }

  function start() {
    const musd = parseUsd(amount);
    if (!musd || step) return;
    // A second tap while a top-up is open resumes it; it never starts another.
    if (!attempt) topup.save(newAttempt({ keyCommit: evm.key_commit, rail: 'evm', chain: entry.chain, token: token.symbol, amount, musd, rows, now: Date.now() }));
    if (hasWallet) pay();
  }

  if (attempt) {
    const wallet = hasWallet ? (
      <div className="topup-wallet">
        <button type="button" className="wallet-primary btn btn-primary" disabled={!!step} onClick={pay}>
          {step ? 'Payment in progress' : `Pay ${attempt.amount} ${attempt.token}`}<Wallet size={17} aria-hidden="true" />
        </button>
        <WalletProgress payment={payment} />
      </div>
    ) : (
      <OpenInWalletApp url={walletAppUrl} showApps={access === 'app'} onWalletOpen={() => topup.update({ walletOpenedAt: Date.now() })} />
    );
    return (
      <div className="wallet-checkout">
        <TopupTracker attempt={attempt} rows={rows} confirmations={entry.confirmations} wallet={wallet} back={back}
          {...trackerEvents(topup, stopTracking, () => {
            setAmount(attempt.amount);
            payment.startAnother();
            setRefocus(n => n + 1);
          })} />
      </div>
    );
  }

  return (
    <div className="wallet-checkout">
      <form className="wallet-amount-form" onSubmit={event => { event.preventDefault(); if (validAmount) start(); }}>
        <AmountChooser amount={amount} setAmount={value => { setAmount(value); setError(''); }} busy={!!step} />
        <div className="wallet-pay-method">
          <div className="wallet-pay-token"><Coins size={21} aria-hidden="true" /></div>
          <div><span>Payment network</span><strong>{token.symbol} <small>on {network.name}</small></strong></div>
          {methodPicker}
        </div>
        {(evm.chains.length > 1 || entry.tokens.length > 1) && (
          <details className="wallet-network-options">
            <summary>Change network or token</summary>
            <label className="field">Network
              <select className="select" value={entry.chain} onChange={event => {
                const next = evm.chains.find(c => c.chain === event.target.value);
                if (!next) return;
                setChain(next.chain); setSymbol(next.tokens.find(t => t.symbol === 'USDG')?.symbol ?? next.tokens[0].symbol); setError('');
              }}>
                {evm.chains.map(c => <option key={c.chain} value={c.chain}>{chainName(c.chain)}</option>)}
              </select>
            </label>
            {entry.tokens.length > 1 && <label className="field">Token
              <select className="select" value={token.symbol} onChange={event => setSymbol(event.target.value as typeof symbol)}>
                {entry.tokens.map(t => <option key={t.symbol} value={t.symbol}>{t.symbol}</option>)}
              </select>
            </label>}
          </details>
        )}
        <button ref={continueButton} className="wallet-primary btn btn-primary" type="submit" disabled={!validAmount}>
          {hasWallet ? `Pay ${amount.trim()} ${token.symbol}` : 'Continue to wallet'}
          {hasWallet ? <Wallet size={17} aria-hidden="true" /> : <ArrowRight size={18} aria-hidden="true" />}
        </button>
        {!validAmount && <p className="faint" role="status">Enter an amount greater than zero.</p>}
      </form>
      <WalletProgress payment={payment} />
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

/** Pay with the coin (launched on Pons) through CoinPay. The coins are burned; the credit is usage-only. */
export function CoinWalletPay({ coin, amount, setAmount, topup, rows, back, stopTracking }: FundingAmount & TopupProps & { coin: CoinInstructions }) {
  const { client, demo } = useAnonymo();
  const { attempt } = topup;
  const access = useWalletAccess();
  const musd = parseUsd(amount);
  const { quote, message, failed, retry } = useNymoQuote(client, coin, musd);
  const continueButton = useRef<HTMLButtonElement>(null);
  const [refocus, setRefocus] = useState(0);
  useEffect(() => { if (refocus) continueButton.current?.focus(); }, [refocus]);
  const payAmount = attempt?.amount ?? amount;
  const paymentUrl = !demo && typeof window !== 'undefined'
    ? payUrl(window.location.origin, { keyCommit: coin.key_commit, chain: 'rhc', token: 'NYMO', amount: payAmount }) : '';
  const opened = () => topup.update({ walletOpenedAt: Date.now() });

  if (attempt) {
    const wallet = demo ? <p className="muted">This preview uses a simulated coin payment.</p>
      // Inside a wallet's own browser, /pay opens in this same tab: many wallet browsers ignore a new tab.
      : access === 'injected' ? <a className="wallet-primary btn btn-primary" href={paymentUrl} onClick={opened}>Review NYMO payment <ArrowRight size={17} aria-hidden="true" /></a>
      : <OpenInWalletApp url={paymentUrl} showApps={access === 'app'} onWalletOpen={opened} />;
    return (
      <div className="wallet-checkout">
        <TopupTracker attempt={attempt} rows={rows} confirmations={coin.confirmations} wallet={wallet} back={back}
          {...trackerEvents(topup, stopTracking, () => {
            setAmount(attempt.amount);
            setRefocus(n => n + 1);
          })} />
      </div>
    );
  }

  return (
    <div className="wallet-checkout">
      <p>Pay with NYMO on Robinhood Chain for chat credit. The payment burns your coins. This credit can only be spent on Anonymo.</p>
      <AmountChooser amount={amount} setAmount={setAmount} />
      {quote && musd ? <p><strong>{formatUnits(BigInt(quote.amount_raw), coin.token.decimals, coin.token.decimals)} NYMO</strong>. {nymoCreditText(quote, musd)} The final credit uses the price at confirmation.</p>
        : <p role="status">{message} {failed && <button type="button" className="btn" onClick={retry}>Retry quote</button>}</p>}
      {demo && <p className="muted">This preview uses a simulated coin payment.</p>}
      <button ref={continueButton} type="button" className="wallet-primary btn btn-primary" disabled={!quote || !musd || (!demo && !paymentUrl)}
        onClick={() => {
          if (!musd || attempt) return;
          topup.save(newAttempt({ keyCommit: coin.key_commit, rail: 'coin', chain: 'rhc', token: 'NYMO', amount, musd, rows, now: Date.now() }));
        }}>Continue to wallet <ArrowRight size={17} aria-hidden="true" /></button>
    </div>
  );
}
