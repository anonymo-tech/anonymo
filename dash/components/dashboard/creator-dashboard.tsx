'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Wallet } from 'lucide-react';
import type { Address } from 'viem';
import { describeError } from '@/lib/anonymo/client';
import { claimCreator, creatorProvider, signCreatorRequest } from '@/lib/anonymo/creator-wallet';
import { REFERRAL_RE, type CreatorClaim, type CreatorStats } from '@/lib/anonymo/creators';
import { connectWallet, formatUnits } from '@/lib/anonymo/wallet';
import { useAnonymo } from '../anonymo-provider';
import { CopyButton } from '../copy-button';

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 });

export function CreatorDashboard() {
  const { client, demo, key } = useAnonymo();
  const [wallet, setWallet] = useState('');
  const [claims, setClaims] = useState<CreatorClaim[] | null>(null);
  const [stats, setStats] = useState<CreatorStats[] | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const address = /^0x[a-fA-F0-9]{40}$/.test(wallet.trim()) ? wallet.trim().toLowerCase() as Address : null;

  async function run(task: string, work: () => Promise<void>) {
    setBusy(task);
    setError('');
    setNotice('');
    try { await work(); } catch (error) { setError(describeError(error)); } finally { setBusy(''); }
  }

  async function loadStats() {
    const provider = demo ? null : creatorProvider();
    const creatorWallet = provider ? await connectWallet(provider) : '0x1111111111111111111111111111111111111111'; // gitleaks:allow
    const body = JSON.stringify({ creatorWallet, nonce: crypto.randomUUID() });
    const rows = await client.creatorStats(body, provider ? await signCreatorRequest(provider, creatorWallet, body) : '');
    setWallet(creatorWallet);
    setStats(rows);
    setClaims(await client.creatorClaims(creatorWallet));
  }

  async function claim(row: CreatorClaim) {
    if (demo) {
      const demoActions = await import('@/lib/anonymo/mock/creator-actions');
      demoActions.demoClaim(row.epoch, row.wallet);
    } else {
      await claimCreator(await client.creatorContracts(), row);
    }
    setClaims(await client.creatorClaims(row.wallet));
    setNotice('Payout claimed.');
  }

  return <div className="panel-stack">
    <section className="panel">
      <header><h2>Your characters</h2><Link className="btn btn-small" href="/dashboard/characters?view=collection">Open Characters</Link></header>
      <p className="lede">See paid chats and spend for each published character. Audience estimates use aggregate counts. We don’t record which key talks to which character.</p>
      {key ? <div><button className="btn btn-primary" type="button" disabled={!!busy} onClick={() => void run('stats', loadStats)}><Wallet size={16} /> {busy === 'stats' ? 'Loading…' : 'Load creator stats'}</button></div>
        : <div><Link className="btn" href="/dashboard/key">Set up an API key to view stats</Link></div>}
      {stats?.length === 0 && <p>No characters published by this wallet yet.</p>}
      {stats?.map((card) => <article className="creator-stat-card" key={card.id}>
        <h3>{card.name}</h3>
        <dl className="creator-stats">
          <div><dt>Paid chats</dt><dd>{card.chats.toLocaleString()}</dd></div>
          <div><dt>Unique funded users this week</dt><dd>{card.audience?.unique.toLocaleString() ?? '—'}</dd></div>
          <div><dt>Week-2 return</dt><dd>{card.audience?.week2 == null ? '—' : `${card.audience.week2}%`}</dd></div>
          <div><dt>Spend</dt><dd>{USD.format(Number(card.spend))}</dd></div>
        </dl>
        <p className="muted">{USD.format(Number(card.held))} pending{Number(card.frozen) > 0 ? ` · ${USD.format(Number(card.frozen))} under review` : ''}</p>
      </article>)}
    </section>
    <section className="panel">
      <h2>Weekly payouts</h2>
      <p className="lede">Shares and tips can be claimed in USDG on Robinhood Chain once the hold ends and the weekly root is posted.</p>
      <form className="creator-filters" onSubmit={(e) => {
        e.preventDefault();
        if (address) void run('proofs', async () => setClaims(await client.creatorClaims(address)));
      }}>
        <label className="field">Creator wallet address<input className="input mono" value={wallet} spellCheck={false} placeholder="0x…" onChange={(e) => { setWallet(e.target.value); setClaims(null); }} /></label>
        <button className="btn" disabled={!address || !!busy}>{busy === 'proofs' ? 'Loading…' : 'Find payouts'}</button>
      </form>
      {claims?.length === 0 && <p>No payouts to show for this wallet.</p>}
      {claims?.map((row) => <article className="notice notice-action" key={row.epoch}>
        <div><strong>{formatUnits(BigInt(row.amount) + BigInt(row.tip), 6)} USDG</strong><p className="muted">Week of {row.week}{row.tx ? '' : ' · waiting for root'}</p></div>
        <div className="row">
          <CopyButton text={JSON.stringify(row)} label="Copy proof" />
          <button className="btn btn-primary btn-small" type="button" disabled={!row.tx || !!busy} onClick={() => void run('claim', () => claim(row))}>{busy === 'claim' ? 'Confirming…' : 'Claim USDG'}</button>
        </div>
      </article>)}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert" className="notice notice-rose">{error}</p>}
    </section>
    <CreatorReferrals />
  </div>;
}

function CreatorReferrals() {
  const params = useSearchParams();
  const ref = params.get('ref');
  const code = ref && REFERRAL_RE.test(ref) ? ref : null;
  const { key, client } = useAnonymo();
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');

  async function referral() {
    setBusy(true);
    setError('');
    try {
      if (code) {
        await client.acceptReferral(code);
        setAccepted(true);
      } else {
        const result = await client.referralLink();
        setLink(new URL(`/dashboard/creators?ref=${result.code}`, window.location.origin).href);
      }
    } catch (error) {
      setError(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  return <section className="panel">
    <h2>{code ? 'You’ve been invited' : 'Invite a friend'}</h2>
    <p className="lede">You both get credits after their first top-up. The inviter also gets a share of their spend as credits for 90 days.</p>
    <div className="row">
      {accepted ? <Link className="btn btn-primary" href="/dashboard/funds">Add funds to activate credits</Link>
        : key ? <button className="btn" type="button" disabled={busy} onClick={() => void referral()}>{busy ? 'Working…' : code ? 'Accept invite' : 'Get invite link'}</button>
        : <Link className="btn" href={code ? `/dashboard/key?ref=${code}` : '/dashboard/key'}>Create a key</Link>}
      {link && <CopyButton text={link} label="Copy invite link" />}
    </div>
    {error && <p role="alert" className="notice notice-rose">{error}</p>}
  </section>;
}
