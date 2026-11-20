'use client';

// Update "status": the public status page. Read from the gateway's GET /api/v1/status/slo (uptime by surface and lane,
// 90 days of daily availability, probes and incidents) and checked live from this browser (the API's health check and
// which models are up). Refreshes every minute. Counts only: no request content exists to show.

import { AlertTriangle, CheckCircle2, CircleDashed, Rss, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useAnonymo } from './anonymo-provider';
import { API_PATHS } from '@/lib/anonymo/client';
import { dayTone, ms, overall, pct, stateTone, stateWord, surfaceName, type Tone } from '@/lib/anonymo/status';
import type { StatusSlo } from '@/lib/anonymo/types';

const MODELS: { id: string; name: string }[] = [
  { id: 'anonymo-1', name: 'anonymo-1' },
  { id: 'anonymo-council', name: 'anonymo-council' },
  { id: 'anonymo-rp', name: 'anonymo-rp' },
  { id: 'anonymo-sealed', name: 'anonymo-sealed' },
];
const REFRESH_MS = 60_000;

function ToneIcon({ tone, size = 18 }: { tone: Tone; size?: number }) {
  if (tone === 'ok') return <CheckCircle2 size={size} aria-hidden="true" />;
  if (tone === 'warn') return <AlertTriangle size={size} aria-hidden="true" />;
  if (tone === 'bad') return <XCircle size={size} aria-hidden="true" />;
  return <CircleDashed size={size} aria-hidden="true" />;
}

const ago = (iso: string | number, now: number) => {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86_400 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
};

export function StatusView() {
  const { ready, client, liveModels } = useAnonymo();
  const [slo, setSlo] = useState<StatusSlo | null>(null);
  const [ping, setPing] = useState<number | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [images, setImages] = useState<boolean | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const [p, s, m] = await Promise.allSettled([client.ping(), client.statusSlo(), client.mediaModels()]);
    setReachable(p.status === 'fulfilled');
    setPing(p.status === 'fulfilled' ? p.value : null);
    if (s.status === 'fulfilled') setSlo(s.value);
    setImages(m.status === 'fulfilled' ? m.value.data.some((x) => x.kind === 'image') : false);
    setCheckedAt(Date.now());
  }, [client]);

  useEffect(() => {
    if (!ready) return;
    void load();
    const every = setInterval(() => void load(), REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => {
      clearInterval(every);
      clearInterval(tick);
    };
  }, [ready, load]);

  const head = overall(slo, reachable);
  const lane = slo?.lanes.find((l) => l.lane === 'public');
  const incidents = slo ? [...slo.incidents.open, ...slo.incidents.recent.filter((r) => !slo.incidents.open.some((o) => o.id === r.id))] : [];

  return (
    <div className="status">
      <section className={`status-banner tone-${head.tone}`} aria-live="polite">
        <ToneIcon tone={head.tone} size={28} />
        <div>
          <h2>{head.title}</h2>
          <p>{head.detail}</p>
        </div>
        <small>{checkedAt ? `Checked ${ago(checkedAt, now)} · refreshes every minute` : ''}</small>
      </section>

      <section className="panel">
        <header className="panel-head">
          <h2>Right now</h2>
          <span className="muted">From your browser</span>
        </header>
        <ul className="status-list">
          <li>
            <span className={`status-dot tone-${reachable === null ? 'none' : reachable ? 'ok' : 'bad'}`}>
              <ToneIcon tone={reachable === null ? 'none' : reachable ? 'ok' : 'bad'} size={16} />
            </span>
            <strong>API</strong>
            <span className="muted">{reachable === null ? 'Checking…' : reachable ? `Answering · ${ms(ping)} round trip` : 'Not answering'}</span>
          </li>
          {MODELS.map((m) => {
            const up = liveModels === null ? null : liveModels.has(m.id);
            const tone: Tone = up === null ? 'none' : up ? 'ok' : 'none';
            return (
              <li key={m.id}>
                <span className={`status-dot tone-${tone}`}>
                  <ToneIcon tone={tone} size={16} />
                </span>
                <strong className="mono">{m.name}</strong>
                <span className="muted">{up === null ? 'Checking…' : up ? 'Live' : 'Not live yet'}</span>
              </li>
            );
          })}
          <li>
            <span className={`status-dot tone-${images ? 'ok' : 'none'}`}>
              <ToneIcon tone={images ? 'ok' : 'none'} size={16} />
            </span>
            <strong>Images</strong>
            <span className="muted">{images === null ? 'Checking…' : images ? 'Live' : 'Not live yet'}</span>
          </li>
        </ul>
      </section>

      {lane?.daily && (
        <section className="panel">
          <header className="panel-head">
            <h2>Uptime, last 90 days</h2>
            <span className="muted">Target {pct(lane.target, 1)} · 30 days {pct(lane.windows['30d'].availability, 3)}</span>
          </header>
          <div className="uptime-strip" role="img" aria-label={`Daily availability for the last 90 days. 30-day availability ${pct(lane.windows['30d'].availability, 3)}.`}>
            {lane.daily.map((d) => {
              const tone = dayTone(d.eligible ? d.availability : null, lane.target);
              return <span key={d.day} className={`uptime-day tone-${tone}`} title={`${d.day}: ${d.eligible ? pct(d.availability, 2) : 'no traffic'}`} />;
            })}
          </div>
          <div className="uptime-axis muted" aria-hidden="true">
            <span>90 days ago</span>
            <span className="uptime-legend">
              <i className="tone-ok" /> At target <i className="tone-warn" /> Within 1 point <i className="tone-bad" /> Below <i className="tone-none" /> No traffic
            </span>
            <span>Today</span>
          </div>
        </section>
      )}

      {slo && (
        <section className="panel">
          <header className="panel-head">
            <h2>By service</h2>
            <span className="muted">Successful requests, server errors only</span>
          </header>
          <div className="table-wrap">
            <table className="data status-table">
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Now</th>
                  <th className="num">24 h</th>
                  <th className="num">7 days</th>
                  <th className="num">30 days</th>
                  <th className="num">Median speed</th>
                </tr>
              </thead>
              <tbody>
                {slo.surfaces.map((s) => (
                  <tr key={s.surface}>
                    <th scope="row">{surfaceName(s.surface)}</th>
                    <td>
                      <span className={`state-chip tone-${stateTone(s.state)}`}>
                        <ToneIcon tone={stateTone(s.state)} size={14} /> {stateWord(s.state)}
                      </span>
                    </td>
                    <td className="num">{pct(s.windows['24h'].availability)}</td>
                    <td className="num">{pct(s.windows['7d'].availability)}</td>
                    <td className="num">{pct(s.windows['30d'].availability)}</td>
                    <td className="num">{ms(s.latency_24h.p50_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted status-foot">
            Upstream checks in the last 24 h: {slo.synthetic_24h.total ? `${pct(slo.synthetic_24h.availability)} passed (${slo.synthetic_24h.ok.toLocaleString()} of ${slo.synthetic_24h.total.toLocaleString()})` : 'none yet'}. When a provider fails a check, the router sends requests to another route.
          </p>
        </section>
      )}

      <section className="panel">
        <header className="panel-head">
          <h2>Incidents</h2>
          <span className="row" style={{ gap: 8 }}>
            <a className="btn btn-ghost btn-small" href={client.url(API_PATHS.incidentsRss)}>
              <Rss size={15} aria-hidden="true" /> RSS
            </a>
            <a className="btn btn-ghost btn-small" href={client.url(API_PATHS.incidentsAtom)}>
              <Rss size={15} aria-hidden="true" /> Atom
            </a>
          </span>
        </header>
        {!slo ? (
          <p className="muted">Loading…</p>
        ) : incidents.length === 0 ? (
          <p className="muted">No incidents reported.</p>
        ) : (
          <ol className="incidents">
            {incidents.map((i) => {
              const tone: Tone = i.status === 'resolved' ? 'ok' : i.impact === 'critical' ? 'bad' : 'warn';
              return (
                <li key={i.id} className={`incident tone-${tone}`}>
                  <header>
                    <span className={`state-chip tone-${tone}`}>
                      <ToneIcon tone={tone} size={14} /> {i.status === 'resolved' ? 'Resolved' : i.status.charAt(0).toUpperCase() + i.status.slice(1)}
                    </span>
                    <strong>{i.title}</strong>
                    <small className="muted">{new Date(i.started_at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small>
                  </header>
                  <ul>
                    {i.updates.map((u) => (
                      <li key={`${u.at}-${u.status}`}>
                        <span className="mono">{new Date(u.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                        <span>
                          <b>{u.status.charAt(0).toUpperCase() + u.status.slice(1)}.</b> {u.text}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}
