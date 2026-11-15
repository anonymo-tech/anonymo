'use client';

// The workspace home: the balance, the key on this device, the receipts this device has seen, and where to go next.

import { Photo } from '@/components/photo';
import Link from 'next/link';
import { ArrowRight, Eye, EyeOff, PlusCircle, ShieldCheck, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { CopyButton } from '../copy-button';
import { maskKey } from '@/lib/anonymo/key-store';
import { formatUsdAmount, usdToMusd } from '@/lib/anonymo/money';
import type { Balance } from '@/lib/anonymo/types';

export function Overview() {
  const { ready, demo, key, client, receipts, balanceVersion } = useAnonymo();
  const [balance, setBalance] = useState<Balance | null>(null);
  const [error, setError] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!ready || !key) return;
    const controller = new AbortController();
    client.balance(controller.signal).then(
      (b) => {
        setBalance(b);
        setError(false);
      },
      () => setError(true),
    );
    return () => controller.abort();
  }, [ready, key, client, balanceVersion]);

  if (!ready) return null;

  if (!key)
    return (
      <div className="overview">
        <section className="card span-7">
          <header>
            <h2>Start with a key</h2>
            <span className="chip">No account · no email · no KYC</span>
          </header>
          <p className="lede">
            Your key is your account. Create one, add funds, and use it here or with any OpenAI-compatible client.
          </p>
          <div className="row">
            <Link className="btn btn-primary" href="/dashboard/key">
              Create a key
            </Link>
            <Link className="btn btn-outline" href="/dashboard/chat?demo=1">
              Try the demo
            </Link>
          </div>
        </section>
        <section className="card card-photo span-5">
          <Photo src="/mascot/pillow.jpg" alt="The Anonymo mascot napping in headphones" width={1200} height={900} />
        </section>
      </div>
    );

  const usageOnly = balance?.usage_only_usd ? usdToMusd(balance.usage_only_usd) : 0;

  return (
    <div className="overview">
      <section className="card span-6" aria-labelledby="balance-title">
        <h2 id="balance-title">Available balance</h2>
        <div className="balance-line">
          <span className="big-num">{balance ? formatUsdAmount(balance.available_usd) : error ? '—' : <span className="skeleton" style={{ width: 150, height: 40 }} aria-label="Loading" />}</span>
          {demo && <span className="chip chip-amber">demo</span>}
        </div>
        {balance && (
          <p className="faint">
            {usageOnly > 0 && <>{formatUsdAmount(balance.usage_only_usd)} usage-only · </>}
            {formatUsdAmount(balance.held_usd)} held for requests in flight
          </p>
        )}
        <div className="row">
          <Link className="btn btn-primary" href="/dashboard/funds">
            <PlusCircle size={17} aria-hidden="true" /> Add funds
          </Link>
          <Link className="btn btn-outline" href="/dashboard/funds">
            <Wallet size={17} aria-hidden="true" /> Deposits &amp; withdrawals
          </Link>
        </div>
      </section>

      <section className="card span-6" aria-labelledby="key-title">
        <h2 id="key-title">Your API key</h2>
        <p className="lede">No account. This key is your access.</p>
        <div className="key-field">
          <input className="input" readOnly value={shown ? key : maskKey(key)} aria-label="API key" />
          <button type="button" className="btn" onClick={() => setShown((s) => !s)} aria-label={shown ? 'Hide key' : 'Show key'}>
            {shown ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
          </button>
          <CopyButton text={key} label="Copy" />
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="chip chip-signal">
            <span className="dot" aria-hidden="true" /> {demo ? 'Demo key' : 'Active'}
          </span>
          <Link className="link" href="/dashboard/key">
            Manage key
          </Link>
        </div>
      </section>

      <section className="card span-12" aria-labelledby="recent-title">
        <header>
          <h2 id="recent-title">Recent receipts</h2>
          <Link className="link" href="/dashboard/receipts">
            View all receipts <ArrowRight size={14} aria-hidden="true" style={{ verticalAlign: '-2px' }} />
          </Link>
        </header>
        {receipts.length === 0 ? (
          <p className="lede">
            No receipts on this device yet. Every chat reply comes with one; <Link className="link" href="/dashboard/chat">start a chat</Link>.
          </p>
        ) : (
          <div className="table-wrap" style={{ border: 0, background: 'transparent' }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Model</th>
                  <th>Receipt</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {receipts.slice(0, 6).map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className="row" style={{ gap: 8 }}>
                        <span className="dot" aria-hidden="true" /> Signed
                      </span>
                    </td>
                    <td className="mono">{r.model}</td>
                    <td>
                      <Link className="hash" href={`/dashboard/receipts/${encodeURIComponent(r.id)}`}>
                        {r.id.length > 18 ? `${r.id.slice(0, 10)}…${r.id.slice(-6)}` : r.id}
                      </Link>
                    </td>
                    <td className="faint">{timeAgo(r.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="faint row" style={{ gap: 8 }}>
          <ShieldCheck size={16} aria-hidden="true" /> Receipts hold ids, routes and costs only. No prompt or reply text is kept.
        </p>
      </section>

    </div>
  );
}

function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return new Date(t).toLocaleDateString();
}
