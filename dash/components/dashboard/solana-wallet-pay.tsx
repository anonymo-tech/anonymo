'use client';

import { Wallet } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { musdToUsdString, parseUsd } from '@/lib/anonymo/money';
import { encodeQr, QR_QUIET_ZONE, qrPath } from '@/lib/anonymo/qr';
import { solanaPayUrl } from '@/lib/anonymo/solana-pay';
import { newAttempt } from '@/lib/anonymo/topup-attempt';
import type { SolanaInstructions } from '@/lib/anonymo/types';
import { isMobileBrowser } from '@/lib/anonymo/wallet-links';
import { TopupTracker } from './topup-tracker';
import { AmountChooser, type TopupProps } from './wallet-pay';

export function SolanaWalletPay({ solana, topup, rows, back, stopTracking }: TopupProps & { solana: SolanaInstructions }) {
  const [amount, setAmount] = useState('10');
  const [mint, setMint] = useState(solana.tokens.find(t => t.symbol === 'USDC')?.mint ?? solana.tokens[0]?.mint);
  const tokenId = useId();
  const { attempt } = topup;
  const token = solana.tokens.find(t => attempt ? t.symbol === attempt.token : t.mint === mint);
  const musd = parseUsd(amount);
  const url = token && solanaPayUrl(solana, token.mint, attempt?.amount ?? amount);
  const network = solana.cluster === 'devnet' ? 'Solana Devnet' : 'Solana';

  if (attempt) {
    return (
      <TopupTracker key={attempt.id} attempt={attempt} rows={rows} back={back} confirmations={1} network={network}
        onClaim={ref => topup.update({ claimedRef: ref })}
        onCancel={() => { void stopTracking(topup); }}
        onDone={topup.clear}
        wallet={url && (isMobileBrowser()
          ? <a className="btn wallet-primary" href={url}>Open wallet</a>
          : <PaymentCode url={url} network={network} />)}
      />
    );
  }

  return (
    <form className="wallet-checkout" onSubmit={event => {
      event.preventDefault();
      if (!url || !token || !musd) return;
      const now = Date.now();
      // Save first so the payment is still tracked if the browser is suspended by the wallet.
      topup.save({
        ...newAttempt({ keyCommit: solana.reference, rail: 'solana', chain: 'solana', token: token.symbol, amount: musdToUsdString(musd), musd, rows, now }),
        walletOpenedAt: now,
      });
      if (isMobileBrowser()) window.location.assign(url);
    }}>
      <AmountChooser amount={amount} setAmount={setAmount} />
      <label className="field" htmlFor={tokenId}>
        Token on {network}
        <select className="input" id={tokenId} value={token?.mint ?? ''} onChange={event => setMint(event.target.value)}>
          {solana.tokens.map(t => <option key={t.mint} value={t.mint}>{t.symbol}</option>)}
        </select>
      </label>
      {!musd && <p className="faint">Enter a positive amount with up to six decimal places.</p>}
      {!!musd && !url && <output className="notice notice-amber">Wallet payment is unavailable. Use the details below to pay by hand.</output>}
      <button type="submit" className="btn btn-primary wallet-primary" disabled={!url}>
        <Wallet size={18} aria-hidden="true" /> Pay with a Solana wallet
      </button>
    </form>
  );
}

function PaymentCode({ url, network }: { url: string; network: string }) {
  const { path, side } = useMemo(() => {
    const qr = encodeQr(url);
    return { path: qrPath(qr), side: qr.size + QR_QUIET_ZONE * 2 };
  }, [url]);
  return (
    <div className="wallet-handoff">
      <p>Scan with your wallet app to pay on {network}.</p>
      <svg width="240" height="240" viewBox={`0 0 ${side} ${side}`} style={{ maxWidth: '100%', height: 'auto' }}
        aria-label="Solana Pay QR code" shapeRendering="crispEdges">
        <title>Solana Pay QR code</title>
        <rect width={side} height={side} fill="#fff" />
        <path d={path} fill="#000" />
      </svg>
    </div>
  );
}
