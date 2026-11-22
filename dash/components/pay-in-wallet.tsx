'use client';

// /pay: a stablecoin deposit for one key, opened inside a wallet app's own browser (phones have no browser wallet). The
// link names the key only by its keyCommit; the router and token come from the gateway, never from the link, so a
// link cannot send a payment to another contract. No key is stored or needed here, so the credit is shown on the
// dashboard, not on this page.

import { ArrowUpRight, Copy, Wallet } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useAnonymo } from './anonymo-provider';
import './wallet-payment.css';
import { chainName, evmNetwork, shortAddress } from '@/lib/anonymo/chains';
import { describeError } from '@/lib/anonymo/client';
import { parseUsd } from '@/lib/anonymo/money';
import type { DepositContracts, Hex } from '@/lib/anonymo/types';
import { depositStablecoin, describeWalletError, injectedProvider, stableUnits, type PayResult, type PayStep } from '@/lib/anonymo/wallet';
import { isMobileBrowser, parsePayLink, payUrl, walletAppLinks, type PayLink } from '@/lib/anonymo/wallet-links';

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

type PaymentCallbacks = { onStep: (step: PayStep) => void; onBroadcast: (hash: Hex) => void };

/** Keep a sent payment distinct from a retryable connection or signature request. */
export function useWalletPayment() {
  const locked = useRef(false);
  const [step, setStep] = useState<PayStep | null>(null);
  const [hash, setHash] = useState<Hex | null>(null);
  const [result, setResult] = useState<PayResult | null>(null);
  const [error, setError] = useState('');

  async function submit(request: (callbacks: PaymentCallbacks) => Promise<PayResult>) {
    if (locked.current) return;
    locked.current = true;
    let sent = false;
    setError('');
    try {
      setResult(await request({
        onStep: setStep,
        onBroadcast: (value) => {
          sent = true;
          setHash(value);
        },
      }));
    } catch (e) {
      setError(describeWalletError(e));
    } finally {
      setStep(null);
      if (!sent) locked.current = false;
    }
  }

  function startAnother() {
    if (step) return;
    locked.current = false;
    setHash(null);
    setResult(null);
    setError('');
  }
  return { submit, startAnother, step, hash, result, error, setError };
}

export function WalletProgress({ payment }: { payment: ReturnType<typeof useWalletPayment> }) {
  const { step, hash, result, error } = payment;
  return (
    <>
      {step && <p className="notice" role="status">{STEP_TEXT[step]}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      {hash && !result && (
        <div className="wallet-transfer-status">
          <strong>Payment submitted</strong>
          <code>{hash}</code>
          {error && <p>Check this transaction in your wallet before starting another payment.</p>}
        </div>
      )}
    </>
  );
}

function listenForWallet(check: () => void) {
  const timer = window.setTimeout(check, 600);
  window.addEventListener('ethereum#initialized', check);
  window.addEventListener('focus', check);
  return () => {
    window.clearTimeout(timer);
    window.removeEventListener('ethereum#initialized', check);
    window.removeEventListener('focus', check);
  };
}

function walletAccess() {
  if (injectedProvider()) return 'injected';
  return isMobileBrowser() ? 'app' : 'manual';
}

export function useWalletAccess() {
  return useSyncExternalStore(listenForWallet, walletAccess, () => 'manual');
}

export function PayInWallet() {
  const { ready, client } = useAnonymo();
  const [link, setLink] = useState<PayLink | null | undefined>(undefined);
  const [contracts, setContracts] = useState<DepositContracts | null>(null);
  const [loadError, setLoadError] = useState('');
  const [amount, setAmount] = useState('10');
  const payment = useWalletPayment();
  const { step, result, hash, setError } = payment;
  const access = useWalletAccess();
  const hasWallet = access === 'injected';

  useEffect(() => {
    const parsed = parsePayLink(window.location.search);
    setLink(parsed);
    if (parsed?.amount) setAmount(parsed.amount);
  }, []);

  useEffect(() => {
    if (!ready || !link) return;
    const controller = new AbortController();
    client
      .depositContracts(controller.signal)
      .then(setContracts)
      .catch((e: unknown) => !controller.signal.aborted && setLoadError(describeError(e)));
    return () => controller.abort();
  }, [ready, client, link]);

  const entry = contracts && !contracts.paused && link ? contracts.chains.find((c) => c.chain === link.chain) : undefined;
  const token = entry && link ? entry.tokens.find((t) => t.symbol === link.token) : undefined;
  const network = useMemo(() => (entry ? evmNetwork(entry.chain, entry) : null), [entry]);
  const busy = !!step || !!hash;

  if (link === undefined) return <p className="muted">Loading…</p>;
  if (link === null)
    return (
      <p className="notice notice-amber">
        This payment link is incomplete. Open Funds on your dashboard and tap the wallet button again to get a fresh one.
      </p>
    );
  if (loadError) return <p className="error-text" role="alert">{loadError}</p>;
  if (!contracts) return <p className="muted">Loading the deposit contract…</p>;
  if (contracts.paused) return <p className="notice notice-amber">New deposits are paused right now. Nothing was sent.</p>;
  if (!entry || !token || !network)
    return (
      <p className="notice notice-amber">
        {link.token} on {chainName(link.chain)} is not open for deposits. Open Funds on your dashboard for the chains that are.
      </p>
    );

  function pay() {
    const musd = parseUsd(amount);
    if (!musd) return setError('Enter a positive amount in USD.');
    const provider = injectedProvider();
    if (!provider || !network || !entry || !token || !link) return setError('Open this page in your wallet app to pay.');
    void payment.submit((callbacks) => depositStablecoin({
      provider, network, router: entry.router, token, keyCommit: link.keyCommit,
      amount: stableUnits(musd, token.decimals), ...callbacks,
    }));
  }

  return (
    <div className="panel panel-stack">
      <p className="wallet-network">{token.symbol} on {network.name}</p>
      {result ? (
        <output className="notice notice-signal" aria-live="polite">
          Paid. Transaction <span className="mono">{shortAddress(result.hash, 8)}</span> is mined. Return to the original browser tab to see your credit after{' '}
          {entry.confirmations} confirmations.
        </output>
      ) : (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (hasWallet) pay();
          }}
        >
          <label className="field" style={{ flex: '0 1 160px' }}>
            Amount (USD)
            <input className="input" inputMode="decimal" value={amount} disabled={busy} onChange={(e) => setAmount(e.target.value)} />
          </label>
          {hasWallet && !hash && <button type="submit" className="btn btn-primary" style={{ alignSelf: 'flex-end' }} disabled={busy || !parseUsd(amount)}>
            <Wallet size={16} aria-hidden="true" />
            {busy ? 'Payment in progress' : `Pay ${amount.trim()} ${token.symbol}`}
          </button>}
        </form>
      )}
      {hasWallet && !parseUsd(amount) && <p className="faint" role="status">Enter a positive USD amount to pay.</p>}
      <WalletProgress payment={payment} />
      {hash && !step && !result && <button type="button" className="btn" onClick={payment.startAnother}>Start another payment</button>}
      {!hasWallet && !hash && <OpenInWalletApp url={payUrl(window.location.origin, { ...link, amount })} showApps={access === 'app'} />}
      <details className="wallet-payment-details">
        <summary>Payment details</summary>
        <p>Credit goes to the key with this commitment after {entry.confirmations} confirmations. Compare it with the keyCommit in Funds before paying.</p>
        <code>{link.keyCommit}</code>
      </details>
    </div>
  );
}

/** The app opens its own browser. The original dashboard keeps the key and shows the credited balance. */
export function OpenInWalletApp({ url, showApps = true, onWalletOpen }: {
  url: string;
  showApps?: boolean;
  onWalletOpen?: () => void;
}) {
  const [copied, setCopied] = useState('');
  const [copyFailed, setCopyFailed] = useState(false);
  const linkInput = useRef<HTMLInputElement>(null);
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      setCopyFailed(false);
      onWalletOpen?.();
    } catch {
      setCopyFailed(true);
      linkInput.current?.focus();
      linkInput.current?.select();
    }
  }

  if (!url) return <p className="muted" role="status">Enter a positive USD amount to open a payment link.</p>;
  return (
    <div className="wallet-handoff">
      {showApps && (
        <>
          <h3>Open in your wallet</h3>
          <div className="wallet-app-buttons">
            {walletAppLinks(url).map((app) => (
              <a key={app.name} href={app.href} target="_blank" rel="noopener noreferrer" onClick={onWalletOpen}>
                {app.name}<ArrowUpRight size={16} aria-hidden="true" />
              </a>
            ))}
          </div>
          <p className="faint">Confirm the payment in your wallet, then return to the original Funds tab to check your credit.</p>
        </>
      )}
      <details className="wallet-payment-details">
        <summary>{showApps ? 'Use another wallet' : 'Pay from a wallet on your phone'}</summary>
        <p>Copy this link into your wallet’s browser to review the payment. After confirming, return to Funds in the original browser.</p>
        <input ref={linkInput} className="input" type="url" aria-label="Payment link" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn" onClick={() => void copyLink()}><Copy size={15} aria-hidden="true" />Copy payment link</button>
        {copied === url && <p role="status">Payment link copied.</p>}
        {copyFailed && <p role="status">Select the payment link and use your browser’s Copy action.</p>}
      </details>
    </div>
  );
}
