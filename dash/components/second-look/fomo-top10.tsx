'use client';
import { useEffect, useState } from 'react';
import { ArrowRight, ArrowUpRight, RefreshCw, Trophy } from 'lucide-react';
import { isFomoTopTenSummary, type FomoTopTenSummary } from '../../lib/second-look/fomo-top10';
import { FomoEntityImage } from './fomo-entity-image';
import './fomo-top10.css';

export function FomoTopTen({ onOpen, busy }: { onOpen: (handle: string) => void; busy: boolean }) {
  const [data, setData] = useState<FomoTopTenSummary | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/second-look/fomo/leaderboard', { signal: controller.signal, credentials: 'omit' })
      .then(async r => { if (!r.ok) throw Error(); const d: unknown = await r.json(); if (!isFomoTopTenSummary(d)) throw Error(); setData(d); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [attempt]);
  return <section className="fomo-topten" aria-label="FOMO 30-day top ten">
    <header className="fomo-topten-heading">
      <div><span className="fomo-topten-kicker"><Trophy size={14} /> THE 30-DAY TOP TEN</span><h2>Meet the traders. Read the evidence.</h2></div>
      <span className="fomo-topten-cadence"><RefreshCw size={13} /> Collected daily</span>
    </header>
    {error ? <output className="fomo-topten-status">The collection is temporarily unavailable. <button onClick={() => { setError(false); setAttempt(n => n+1); }}>Try again</button></output>
      : !data ? <output className="fomo-topten-status">Opening the research collection…</output>
      : <>
        <div className="fomo-topten-columns" aria-hidden="true"><span>Rank / trader</span><span>Measured calls</span><span>Call score</span><span /></div>
        <ol className="fomo-topten-list">{data.entries.map(row => <li key={row.handle}>
          <button className="fomo-topten-row" onClick={() => onOpen(row.handle)} disabled={busy} aria-label={`Open rank ${row.rank}, ${row.handle} research`}>
            <span className="fomo-topten-person"><span className="fomo-topten-rank">{String(row.rank).padStart(2,'0')}</span><FomoEntityImage src={row.avatarUrl} kind="profile" label={`${row.handle} profile`} /><span><strong>@{row.handle}</strong>{row.name && row.name !== row.handle && <small>{row.name}</small>}</span></span>
            <span className="fomo-topten-sample"><strong>{row.measured}</strong><small>{row.pending ? `${row.pending} awaiting 24h` : `${row.calls} calls collected`}</small></span>
            <span className={`fomo-topten-score${row.score === null ? ' is-pending' : ''}`}>{row.score === null ? <><span>History building</span><small>Open the evidence</small></> : <><strong>{row.score}</strong><small>/ 100 · call sample</small></>}</span>
            <ArrowRight size={17} className="fomo-topten-arrow" />
          </button>
        </li>)}</ol>
        <footer className="fomo-topten-foot"><span>FOMO-reported ranks via FOMO API · {new Date(data.leaderboard.observedAt).toLocaleString(undefined,{ month:'short',day:'numeric',hour:'numeric',minute:'2-digit' })}</span><a href={data.leaderboard.url} target="_blank" rel="noreferrer">Source <ArrowUpRight size={12} /></a><p>Rank uses reported 30-day PnL. The separate call score measures dated outcomes, downside and market activity. Open a profile for its breakdown.</p></footer>
      </>}
  </section>;
}
