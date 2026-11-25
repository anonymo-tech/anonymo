'use client';

import Link from 'next/link';
import { Ticket, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Hex } from 'viem';
import { describeError } from '@/lib/anonymo/client';
import { buyPass, everydayWallet, passPrice, PASS_SKUS, WalletTransactionReverted, type PassOffer, type PassRail, type PassSku } from '@/lib/anonymo/everyday';
import { describeWalletError, formatUnits, injectedProvider } from '@/lib/anonymo/wallet';
import { updateOn } from '@/lib/anonymo/updates';
import { useAnonymo } from '../anonymo-provider';

const labels = { PASS30: '30-day Pass', PASS30_PLUS: '30-day Pass+' };
const demoProducts = {
  PASS30: { usd: 12, voiceSeconds: 10_800, images: 300, council: false, party: 0 },
  PASS30_PLUS: { usd: 29, voiceSeconds: 54_000, images: 1000, council: true, party: 6 },
};
const dateLabel = (value: string) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function PassesPanel() {
  const { client, demo } = useAnonymo();
  const [offer, setOffer] = useState<PassOffer | null>(null);
  const [sku, setSku] = useState<PassSku>('PASS30');
  const [rail, setRail] = useState<PassRail>('USDG');
  const [review, setReview] = useState<{ account: string; amount: bigint } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState<{ orderId: Hex; hash: Hex } | null>(null);
  const [demoPass, setDemoPass] = useState<PassSku | null>(null);
  const now = Date.now();
  const active = demoPass || offer?.passes.some((pass) => Date.parse(pass.starts) <= now && Date.parse(pass.ends) > now);
  const activated = pending && offer?.passes.some((pass) => pass.orderId === pending.orderId);
  const waiting = !!pending && !activated;

  useEffect(() => {
    if (demo) return;
    const abort = new AbortController();
    const refresh = () => client.passes(abort.signal).then(setOffer, (error) => {
      if (!abort.signal.aborted) setMessage(describeError(error));
    });
    void refresh();
    const timer = waiting ? window.setInterval(() => void refresh(), 5000) : undefined;
    return () => { abort.abort(); window.clearInterval(timer); };
  }, [client, demo, waiting]);

  async function begin() {
    if (busy || waiting) return;
    if (demo) {
      if (review) {
        setDemoPass(sku);
        setReview(null);
      } else {
        const rate = rail === 'NYMO' ? 8000n * 10n ** 18n : 1_000_000n;
        setReview({ account: 'Demo wallet', amount: BigInt(demoProducts[sku].usd) * rate });
      }
      return;
    }
    if (!offer?.checkout || offer.checkout.paused) return;
    const provider = injectedProvider();
    if (!provider) { setMessage('Open Anonymo in an Ethereum wallet browser or enable a browser wallet.'); return; }
    setBusy(true);
    setMessage('');
    try {
      const connection = await everydayWallet(provider, offer.chainId);
      if (!review) {
        const { amount } = await passPrice(connection, offer.checkout, sku, rail);
        setReview({ account: connection.account, amount });
      } else {
        if (connection.account.toLowerCase() !== review.account.toLowerCase()) throw new Error('Your wallet changed. Review a fresh quote.');
        const order = await client.passOrder(sku, connection.account);
        await buyPass(connection, offer.checkout, order, rail, review.amount, (hash) => setPending({ orderId: order.orderId, hash }));
        setReview(null);
      }
    } catch (error) {
      if (error instanceof WalletTransactionReverted) setPending(null);
      setMessage(describeWalletError(error));
      setReview(null);
    } finally {
      setBusy(false);
    }
  }

  const products = demo ? demoProducts : offer?.products;
  const nymo = updateOn('stake', demo) && (demo || offer?.checkout?.nymo);
  return (
    <section className="panel panel-stack" id="passes" aria-labelledby="everyday-passes-title">
      <h2 id="everyday-passes-title"><Ticket size={18} aria-hidden="true" /> 30-day Passes</h2>
      <p>One price for the month. Nothing renews.</p>
      {demoPass && <p className="notice notice-signal" role="status">{labels[demoPass]} is active in this demo.</p>}
      {offer?.passes.filter((pass) => Date.parse(pass.ends) > now).map((pass) => (
        <p className="notice notice-signal" key={pass.orderId}>
          {labels[pass.sku]} · {Date.parse(pass.starts) > now ? `Starts ${dateLabel(pass.starts)}` : `Active through ${dateLabel(pass.ends)}`}
        </p>
      ))}
      {active && <Link className="btn" href="/dashboard/chat">Open chat with your Pass</Link>}
      {products && (
        <>
          <label className="field">
            Choose a pass
            <select className="input" value={sku} disabled={busy || waiting} onChange={(e) => { setSku(e.target.value as PassSku); setReview(null); }}>
              {PASS_SKUS.map((id) => <option key={id} value={id}>{labels[id]} · ${products[id].usd} USDG</option>)}
            </select>
          </label>
          <p>Unlimited anonymo-1 chat with fair use, Vault Memory, {products[sku].voiceSeconds / 3600} hours of voice and {products[sku].images.toLocaleString()} images. {products[sku].council && 'Includes access to Council and Party hosting for six.'}</p>
          <p className="muted">Fair use allows {offer?.fairUse ?? 250} chats a day, with one text reply and up to 32,768 input and 2,048 output tokens per request.</p>
          {nymo && (
            <label className="field">
              Pay with
              <select className="input" value={rail} disabled={busy || waiting} onChange={(e) => { setRail(e.target.value as PassRail); setReview(null); }}>
                <option value="USDG">USDG</option>
                <option value="NYMO">$NYMO, 20% less</option>
              </select>
            </label>
          )}
          {rail === 'NYMO' && <p>Your $NYMO payment is burned in the same transaction.</p>}
          {review && <p className="notice" role="status">Pay up to <strong>{formatUnits(review.amount, rail === 'NYMO' ? 18 : 6, 18)} {rail}</strong> on Robinhood Chain with wallet {review.account}.</p>}
          {(demo || offer?.checkout) && <button type="button" className="btn btn-primary" disabled={busy || waiting || !!offer?.checkout?.paused} onClick={() => void begin()}>
            <Wallet size={16} aria-hidden="true" />
            {busy ? 'Check your wallet…' : review ? `Confirm with ${rail}` : 'Review payment'}
          </button>}
        </>
      )}
      {offer && (!offer.checkout || offer.checkout.paused) && <p className="muted">Pass purchases are currently unavailable.</p>}
      {waiting && <p className="notice" role="status">Waiting for {offer?.confirmations} confirmations. Your pass appears here after payment is indexed. Transaction <code>{pending.hash}</code>.</p>}
      {message && <p className="notice notice-rose" role="alert">{message}</p>}
    </section>
  );
}
