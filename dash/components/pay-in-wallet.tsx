'use client';

// /pay: a wallet payment for one key, opened inside a wallet app's own browser (phones have no browser wallet). The
// link names the key only by its keyCommit; the router and token come from the gateway, never from the link, so a
// link cannot send a payment to another contract. No key is stored or needed here, so the credit is shown on the
// dashboard, not on this page.

import Link from 'next/link';
import { ArrowUpRight, Copy, Wallet } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useAnonymo } from './anonymo-provider';
import './wallet-payment.css';
import { chainName, evmNetwork, shortAddress } from '@/lib/anonymo/chains';
import { describeError, type AnonymoClient } from '@/lib/anonymo/client';
import { parseUsd } from '@/lib/anonymo/money';
import type { DepositContracts, Hex, NymoQuote, PublicCoinInstructions } from '@/lib/anonymo/types';
import { depositStablecoin, describeWalletError, formatUnits, injectedProvider, payWithCoin, stableUnits, type PayResult, type PayStep } from '@/lib/anonymo/wallet';
import { nymoCreditText, readNymoQuote, sameNymoQuote } from '@/lib/anonymo/nymo-quote';
import { nymoQuoteError, useNymoQuote } from './use-nymo-quote';
import { availableNymoRail, isMobileBrowser, parsePayLink, payUrl, walletAppLinks, type PayLink } from '@/lib/anonymo/wallet-links';
import { readAttempt, writeAttempt, type TopupRail } from '@/lib/anonymo/topup-attempt';
import { CopyButton } from './copy-button';

/**
 * In a wallet app whose browser also holds the dashboard (an in-wallet browser), the top-up that opened /pay is in
 * this browser's storage: give it the transaction hash so Balance matches the exact deposit. Elsewhere there is none.
 */
function recordHash(keyCommit: string, rail: TopupRail, hash: Hex): boolean {
  if (typeof localStorage === 'undefined') return false;
  const attempt = readAttempt(localStorage, keyCommit, rail);
  if (!attempt) return false;
  if (!attempt.hash) writeAttempt(localStorage, { ...attempt, hash, submittedAt: Date.now() });
  return true;
}

/** After a payment, show the hash or a link back to Balance. */
function PaidNext({ hash, linked }: { hash: Hex; linked: boolean }) {
  return (
    <div className="wallet-paid-next">
      {linked
        ? <Link className="btn btn-primary" href="/dashboard/funds">Back to Balance</Link>
        : <p className="faint">If your Balance page is open in another browser, it finds this payment on its own. You can also paste the transaction hash there.</p>}
      <CopyButton text={hash} label="Copy transaction hash" />
    </div>
  );
}

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
  const { ready, client, demo } = useAnonymo();
  const [link, setLink] = useState<PayLink | null | undefined>(undefined);
  const [contracts, setContracts] = useState<DepositContracts | null>(null);
  const [loadError, setLoadError] = useState('');
  const [amount, setAmount] = useState('10');
  const payment = useWalletPayment();
  const { step, result, hash, setError } = payment;
  const access = useWalletAccess();
  const hasWallet = access === 'injected';
  const [linked, setLinked] = useState(false);

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
        This payment link is incomplete. Open Balance and tap the wallet button again to get a fresh link.
      </p>
    );
  if (loadError) return <p className="error-text" role="alert">{loadError}</p>;
  if (!contracts) return <p className="muted">Loading the deposit contract…</p>;
  if (contracts.paused) return <p className="notice notice-amber">New deposits are paused right now. Nothing was sent.</p>;
  if (link.token === 'NYMO') {
    if (demo) return <p className="notice">Open Balance in live mode to pay with NYMO.</p>;
    if (!availableNymoRail(contracts.coin))
      return <p className="notice notice-amber">NYMO payments are unavailable on Robinhood Chain. Return to Balance to choose another payment method.</p>;
    return <CoinPayInWallet client={client} coin={contracts.coin} link={link} onRefresh={setContracts} />;
  }
  if (!entry || !token || !network)
    return (
      <p className="notice notice-amber">
        Deposits are unavailable for {link.token} on {chainName(link.chain)}. Open Balance to see which networks you can use.
      </p>
    );

  function pay() {
    const musd = parseUsd(amount);
    if (!musd) return setError('Enter a positive amount in USD.');
    const provider = injectedProvider();
    if (!provider || !network || !entry || !token || !link) return setError('Open this page in your wallet app to pay.');
    const keyCommit = link.keyCommit;
    void payment.submit((callbacks) => depositStablecoin({
      provider, network, router: entry.router, token, keyCommit,
      amount: stableUnits(musd, token.decimals), ...callbacks,
      onBroadcast: (value) => { callbacks.onBroadcast(value); setLinked(recordHash(keyCommit, 'evm', value)); },
    }));
  }

  return (
    <div className="panel panel-stack">
      <p className="wallet-network">{token.symbol} on {network.name}</p>
      {result ? (
        <>
          <output className="notice notice-signal" aria-live="polite">
            Paid. Transaction <span className="mono">{shortAddress(result.hash, 8)}</span> is mined. Your credit appears on your Balance page after{' '}
            {entry.confirmations} confirmations.
          </output>
          <PaidNext hash={result.hash} linked={linked} />
        </>
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
        <p>Credit goes to the key with this commitment after {entry.confirmations} confirmations. Compare it with the key commitment on your Balance page before paying.</p>
        <code>{link.keyCommit}</code>
      </details>
    </div>
  );
}

function CoinPayInWallet({ client, coin, link, onRefresh }: {
  client: AnonymoClient;
  coin: PublicCoinInstructions;
  link: PayLink;
  onRefresh: (contracts: DepositContracts) => void;
}) {
  const [amount, setAmount] = useState(link.amount ?? '10');
  const [consent, setConsent] = useState<NymoQuote | null>(null);
  const access = useWalletAccess();
  const payment = useWalletPayment();
  const { step, hash, result } = payment;
  const busy = !!step || !!hash;
  const musd = parseUsd(amount);
  const review = useNymoQuote(client, coin, musd);
  const quote = review.quote;
  const understood = !!consent && !!quote && sameNymoQuote(consent, quote);
  const units = quote ? formatUnits(BigInt(quote.amount_raw), coin.token.decimals, coin.token.decimals) : '';
  const [checking, setChecking] = useState(false);
  const [linked, setLinked] = useState(false);

  function pay() {
    const provider = injectedProvider();
    if (!provider || !musd || !quote || !understood) return;
    void payment.submit(async callbacks => {
      const verify = async (afterApproval: boolean) => {
        setChecking(true);
        const allowanceNote = afterApproval ? ' A token allowance may already exist in your wallet.' : '';
        let latest: DepositContracts;
        let next: NymoQuote;
        try {
          latest = await client.depositContracts();
          const fresh = latest.paused ? null : latest.coin;
          if (!availableNymoRail(fresh)) {
            onRefresh(latest);
            throw new Error('NYMO payments are currently unavailable.');
          }
          next = await readNymoQuote(client, fresh, musd);
        } catch (error) {
          setConsent(null);
          const message = nymoQuoteError(error);
          review.replace({ message });
          throw new Error(message + allowanceNote);
        } finally {
          setChecking(false);
        }
        if (!sameNymoQuote(quote, next)) {
          setConsent(null);
          onRefresh(latest);
          review.replace({ quote: next });
          const change = quote.coin_pay.toLowerCase() !== next.coin_pay.toLowerCase()
            ? `The payment contract changed to ${next.coin_pay}. Review the new recipient before confirming.`
            : 'The quote changed. Review the burn amount and estimated credit before confirming.';
          throw new Error(change + allowanceNote);
        }
        return next;
      };
      const fresh = await verify(false);
      return payWithCoin({
        provider, network: evmNetwork('rhc', { chain_id: fresh.chain_id }), coinPay: fresh.coin_pay,
        token: fresh.token, keyCommit: link.keyCommit, amount: BigInt(fresh.amount_raw), beforeBurn: async () => { await verify(true); }, ...callbacks,
        onBroadcast: (value) => { callbacks.onBroadcast(value); setLinked(recordHash(link.keyCommit, 'coin', value)); },
      });
    });
  }

  return (
    <div className="panel panel-stack">
      <p className="wallet-network">NYMO on Robinhood Chain</p>
      {result ? (
        <>
          <output className="notice notice-signal" aria-live="polite">
            Transaction <span className="mono">{shortAddress(result.hash, 8)}</span> is mined. Your usage credit appears on your Balance page after {coin.confirmations} confirmations.
          </output>
          <PaidNext hash={result.hash} linked={linked} />
        </>
      ) : (
        <>
          <p>Paying burns NYMO permanently. Your key receives usage-only credit at the confirmed market price. You can spend that credit on requests and cannot withdraw it.</p>
          <label className="field">
            Amount (USD)
            <input className="input" inputMode="decimal" value={amount} disabled={busy || checking}
              onChange={(e) => { setAmount(e.target.value); setConsent(null); }} />
          </label>
          {quote && musd ? (
            <>
              <p><strong>{units} NYMO</strong>. {nymoCreditText(quote, musd)} Credit is posted after {quote.confirmations} confirmations.</p>
              {access === 'injected' && !hash ? (
                <>
                  <label className="checkbox">
                    <input type="checkbox" checked={understood} disabled={busy || checking} onChange={e => setConsent(e.target.checked ? quote : null)} />
                    I understand this burns {units} NYMO for usage-only credit.
                  </label>
                  <button type="button" className="btn btn-primary" disabled={!understood || busy || checking} onClick={pay}>
                    <Wallet size={16} aria-hidden="true" />
                    {checking ? 'Checking current quote…' : busy ? 'Payment in progress' : 'Confirm NYMO burn in wallet'}
                  </button>
                </>
              ) : !hash && <OpenInWalletApp url={payUrl(window.location.origin, { ...link, amount })} showApps={access === 'app'} />}
            </>
          ) : (
            <p className="notice" role="status">
              {review.message} {review.failed && <button type="button" className="btn" onClick={review.retry}>Retry quote</button>}
            </p>
          )}
          <WalletProgress payment={payment} />
          {hash && !step && <button type="button" className="btn" onClick={() => { setConsent(null); payment.startAnother(); }}>Start another payment</button>}
        </>
      )}
      <details className="wallet-payment-details">
        <summary>Payment details</summary>
        <p>Compare this key commitment with the one in your original Balance tab.</p><code>{link.keyCommit}</code>
        <p>NYMO token</p><code>{coin.token.address}</code>
        <p>CoinPay contract</p><code>{coin.coin_pay}</code>
      </details>
    </div>
  );
}

/**
 * The app opens its own browser. The original dashboard keeps the key and shows the credited balance. Everything here
 * is visible without unfolding anything: the wallet apps on a phone, and on every device a payment link to copy.
 */
export function OpenInWalletApp({ url, showApps = true, onWalletOpen }: {
  url: string;
  showApps?: boolean;
  onWalletOpen?: () => void;
}) {
  const [copied, setCopied] = useState('');
  const [copyFailed, setCopyFailed] = useState(false);
  const [opened, setOpened] = useState<{ name: string; href: string } | null>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      setCopyFailed(false);
      onWalletOpen?.();
    } catch {
      setCopyFailed(true);
      requestAnimationFrame(() => { linkInput.current?.focus(); linkInput.current?.select(); });
    }
  }

  if (!url) return <p className="muted" role="status">Enter a positive USD amount to open a payment link.</p>;
  const apps = walletAppLinks(url);
  return (
    <div className="wallet-handoff">
      {showApps ? (
        <>
          <h3>Open in your wallet</h3>
          <div className="wallet-app-buttons">
            {apps.map((app) => (
              <a key={app.name} href={app.href} target="_blank" rel="noopener noreferrer" onClick={() => { setOpened(app); onWalletOpen?.(); }}>
                {app.name}<ArrowUpRight size={16} aria-hidden="true" />
              </a>
            ))}
          </div>
          {opened && (
            <p className="wallet-retry" role="status">
              Wallet didn’t open?{' '}
              <a href={opened.href} target="_blank" rel="noopener noreferrer" onClick={onWalletOpen}>Try {opened.name} again</a>, or copy the link below.
            </p>
          )}
        </>
      ) : (
        <>
          <h3>Pay from the wallet on your phone</h3>
          <p className="faint">Copy this payment link and open it in your wallet app’s browser. Your key never leaves this tab.</p>
        </>
      )}
      <div className="wallet-copy-link">
        <button type="button" className="btn" onClick={() => void copyLink()}><Copy size={15} aria-hidden="true" />Copy payment link</button>
        <span className="faint">{showApps ? 'For another wallet.' : 'Then return here.'}</span>
      </div>
      {copied === url && <p role="status">Payment link copied. Open it in your wallet, confirm, then come back here.</p>}
      {copyFailed && (
        <>
          <input ref={linkInput} className="input" type="url" aria-label="Payment link" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
          <p role="status">Select the payment link and use your browser’s Copy action.</p>
        </>
      )}
    </div>
  );
}
