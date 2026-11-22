'use client';

// /pay: a stablecoin deposit for one key, opened inside a wallet app's own browser (phones have no browser wallet). The
// link names the key only by its keyCommit; the router and token come from the gateway, never from the link, so a
// link cannot send a payment to another contract. No key is stored or needed here, so the credit is shown on the
// dashboard, not on this page.

import { Wallet } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAnonymo } from './anonymo-provider';
import { CopyButton } from './copy-button';
import { chainName, evmNetwork, shortAddress } from '@/lib/anonymo/chains';
import { describeError } from '@/lib/anonymo/client';
import { parseUsd } from '@/lib/anonymo/money';
import type { DepositContracts } from '@/lib/anonymo/types';
import { depositStablecoin, describeWalletError, injectedProvider, stableUnits, type PayResult, type PayStep } from '@/lib/anonymo/wallet';
import { parsePayLink, walletAppLinks, type PayLink } from '@/lib/anonymo/wallet-links';

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

export function PayInWallet() {
  const { ready, client } = useAnonymo();
  const [link, setLink] = useState<PayLink | null | undefined>(undefined);
  const [here, setHere] = useState('');
  const [contracts, setContracts] = useState<DepositContracts | null>(null);
  const [loadError, setLoadError] = useState('');
  const [amount, setAmount] = useState('10');
  const [step, setStep] = useState<PayStep | null>(null);
  const [result, setResult] = useState<PayResult | null>(null);
  const [error, setError] = useState('');
  const [hasWallet, setHasWallet] = useState(false);

  useEffect(() => {
    const parsed = parsePayLink(window.location.search);
    setLink(parsed);
    setHere(window.location.href);
    if (parsed?.amount) setAmount(parsed.amount);
    // Wallet browsers inject their provider early, but give a slow one a moment.
    setHasWallet(injectedProvider() !== null);
    const t = setTimeout(() => setHasWallet(injectedProvider() !== null), 600);
    return () => clearTimeout(t);
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
  const busy = step !== null && step !== 'submitted';

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

  async function pay() {
    setError('');
    setResult(null);
    const musd = parseUsd(amount);
    if (!musd) return setError('Enter an amount in USD, like 10 or 25.50.');
    const provider = injectedProvider();
    if (!provider) return setError('No wallet on this page. Open it in your wallet app with a button below.');
    try {
      setResult(
        await depositStablecoin({
          provider,
          network: network!,
          router: entry!.router,
          token: token!,
          keyCommit: link!.keyCommit,
          amount: stableUnits(musd, token!.decimals),
          onStep: setStep,
        }),
      );
    } catch (e) {
      setError(describeWalletError(e));
    } finally {
      setStep(null);
    }
  }

  return (
    <div className="panel panel-stack">
      <dl className="kv">
        <div>
          <dt>Pays</dt>
          <dd>
            {token.symbol} on {network.name}, credited 1:1 after {entry.confirmations} confirmations
          </dd>
        </div>
        <div>
          <dt>To the key with keyCommit</dt>
          <dd className="hash">{shortAddress(link.keyCommit, 10)}</dd>
        </div>
      </dl>
      <p className="faint">Check that keyCommit matches the one under Funds → Send manually on your dashboard before you pay.</p>
      {result ? (
        <output className="notice notice-signal" aria-live="polite">
          Paid. Transaction <span className="mono">{shortAddress(result.hash, 8)}</span> is mined. Your dashboard shows the credit after{' '}
          {entry.confirmations} confirmations. You can close this page.
        </output>
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
          <button type="submit" className="btn btn-primary" style={{ alignSelf: 'flex-end' }} disabled={busy || !hasWallet}>
            <Wallet size={16} aria-hidden="true" />
            {busy ? 'Working…' : `Pay ${token.symbol}`}
          </button>
        </form>
      )}
      {step && <p className="notice">{STEP_TEXT[step]}</p>}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {!hasWallet && !result && <OpenInWalletApp url={here} />}
    </div>
  );
}

/** Buttons that reopen a page inside a wallet app's browser, for phones (no browser wallet there). */
export function OpenInWalletApp({ url }: { url: string }) {
  if (!url) return null;
  return (
    <div className="panel-stack">
      <p className="muted">Your phone&apos;s browser has no wallet. Open this payment in your wallet app:</p>
      <div className="row">
        {walletAppLinks(url).map((w) => (
          <a key={w.name} className="btn" href={w.href} rel="noopener noreferrer">
            {w.name}
          </a>
        ))}
        <CopyButton text={url} label="Copy link" />
      </div>
      <p className="faint">Another wallet: copy the link and open it in that wallet&apos;s built-in browser.</p>
    </div>
  );
}
