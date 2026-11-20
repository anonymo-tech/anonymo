'use client';

// Update "usage": what this key spent (by day and by model), how long the balance lasts at this pace, a CSV of the
// activity, and the key's spending limits (PATCH /keys/caps). Amounts and models only: Anonymo never stores what was
// asked or answered, so there is nothing else to show.

import Link from 'next/link';
import { AlertTriangle, Download, Gauge, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { describeError } from '@/lib/anonymo/client';
import type { KeyCaps, Runway, SpendPeriod, SpendReport } from '@/lib/anonymo/types';

const PERIODS: { id: SpendPeriod; label: string }[] = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
];
/** Dollars to the cent; amounts under a cent say so rather than showing six decimals. */
const money = (usd: number) =>
  usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const short = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString([], { day: 'numeric', month: 'short', timeZone: 'UTC' });

export function UsagePanel() {
  const { ready, key, client, balanceVersion, refreshBalance } = useAnonymo();
  const [period, setPeriod] = useState<SpendPeriod>('30d');
  const [days, setDays] = useState<SpendReport | null>(null);
  const [models, setModels] = useState<SpendReport | null>(null);
  const [run, setRun] = useState<Runway | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || !key) return;
    const abort = new AbortController();
    setError(null);
    Promise.all([client.spend(period, 'day', abort.signal), client.spend(period, 'model', abort.signal), client.runway(abort.signal)]).then(
      ([d, m, r]) => {
        setDays(d);
        setModels(m);
        setRun(r);
      },
      (e) => !abort.signal.aborted && setError(describeError(e)),
    );
    return () => abort.abort();
  }, [ready, key, client, period, balanceVersion]);

  if (ready && !key)
    return (
      <div className="notice row">
        <span style={{ flex: 1 }}>Usage belongs to a key. Create one or paste yours first.</span>
        <Link className="btn btn-primary btn-small" href="/dashboard/key">
          Create a key
        </Link>
      </div>
    );

  return (
    <div className="usage">
      <div className="usage-bar">
        <div className="segmented" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button key={p.id} type="button" aria-pressed={p.id === period} onClick={() => setPeriod(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        <CsvButton />
      </div>

      {error && <div className="notice notice-rose">{error}</div>}

      {days?.anomaly.flagged && (
        <div className="notice notice-amber row" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>
            Today’s spend ({money(days.anomaly.today_usd)}) is {days.anomaly.ratio}× your daily average. If that’s not you, set a daily limit below, or wipe
            the key from devices you don’t trust.
          </span>
        </div>
      )}

      <section className="usage-stats" aria-label="Totals">
        <Stat label="Balance" value={run ? money(run.balance_usd) : '—'} note={run ? runwayText(run) : 'Loading…'} strong />
        <Stat label="Today" value={days ? money(days.totals.today_usd) : '—'} note="UTC day" />
        <Stat label="Last 7 days" value={days ? money(days.totals.last_7d_usd) : '—'} note={run ? `${money(run.per_day_usd)} a day on average` : ''} />
        <Stat
          label="This month"
          value={days ? money(days.totals.month_to_date_usd) : '—'}
          note={days ? `On pace for ${money(days.totals.projected_month_usd)}` : ''}
        />
      </section>

      <section className="panel usage-chart-card">
        <header className="panel-head">
          <h2>Spend per day</h2>
          <span className="muted">{days ? `${money(days.totals.period_usd)} · ${days.totals.period_requests.toLocaleString()} requests` : ''}</span>
        </header>
        {days ? <DayChart report={days} /> : <div className="usage-chart-empty muted">Loading…</div>}
      </section>

      <div className="usage-cols">
        <section className="panel">
          <header className="panel-head">
            <h2>By model</h2>
          </header>
          {!models ? (
            <p className="muted">Loading…</p>
          ) : models.breakdown.length === 0 ? (
            <p className="muted">Nothing spent in this period.</p>
          ) : (
            <table className="usage-table">
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col" className="num">
                    Requests
                  </th>
                  <th scope="col" className="num">
                    Spent
                  </th>
                  <th scope="col">Share</th>
                </tr>
              </thead>
              <tbody>
                {models.breakdown.map((b) => (
                  <tr key={b.id}>
                    <th scope="row">{b.id}</th>
                    <td className="num">{b.requests.toLocaleString()}</td>
                    <td className="num">{money(b.cost_usd)}</td>
                    <td>
                      <span className="share" aria-label={`${Math.round(b.share * 100)}%`}>
                        <span style={{ width: `${Math.max(2, b.share * 100)}%` }} />
                      </span>
                      <small>{Math.round(b.share * 100)}%</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <Limits spentToday={days?.totals.today_usd ?? null} spentMonth={days?.totals.month_to_date_usd ?? null} onSaved={refreshBalance} />
      </div>

      <p className="usage-privacy muted">Usage shows amounts and models only. Anonymo never stores what you asked or what came back.</p>
    </div>
  );
}

function runwayText(r: Runway) {
  if (r.days_left === null) return 'No spend in the last 7 days';
  if (r.days_left < 1) return 'Runs out today at this pace';
  return `About ${r.days_left.toLocaleString()} ${r.days_left === 1 ? 'day' : 'days'} left at this pace`;
}

function Stat({ label, value, note, strong }: { label: string; value: string; note: string; strong?: boolean }) {
  return (
    <div className={strong ? 'stat-tile is-strong' : 'stat-tile'}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}

/** One series of bars: thin, rounded at the top, anchored to the baseline, a tooltip per bar and a table for readers. */
function DayChart({ report }: { report: SpendReport }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = useMemo(() => Math.max(...report.series.map((s) => s.cost_usd), 0.0001), [report]);
  const n = report.series.length;
  const ticks = [0, Math.floor((n - 1) / 2), n - 1];
  const tip = hover === null ? null : report.series[hover];
  return (
    <figure className="usage-chart">
      <div className="usage-plot" onMouseLeave={() => setHover(null)}>
        <span className="usage-max muted">{money(max)}</span>
        <div className="usage-bars" style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }}>
          {report.series.map((s, i) => (
            <button
              key={s.date}
              type="button"
              className={i === hover ? 'usage-col is-hover' : 'usage-col'}
              aria-label={`${short(s.date)}: ${money(s.cost_usd)}, ${s.requests} requests`}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
            >
              <span style={{ height: `${s.cost_usd ? Math.max(2, (s.cost_usd / max) * 100) : 0}%` }} />
            </button>
          ))}
        </div>
        {tip && (
          <div className="usage-tip" style={{ left: `${((hover! + 0.5) / n) * 100}%` }} role="status">
            <strong>{money(tip.cost_usd)}</strong>
            <span>
              {short(tip.date)} · {tip.requests} {tip.requests === 1 ? 'request' : 'requests'}
            </span>
          </div>
        )}
      </div>
      <div className="usage-axis muted" aria-hidden="true">
        {ticks.map((t) => (
          <span key={t} style={{ left: `${((t + 0.5) / n) * 100}%` }}>
            {short(report.series[t].date)}
          </span>
        ))}
      </div>
      <figcaption className="sr-only">
        <table>
          <caption>Spend per day, UTC</caption>
          <thead>
            <tr>
              <th>Day</th>
              <th>Spent</th>
              <th>Requests</th>
            </tr>
          </thead>
          <tbody>
            {report.series.map((s) => (
              <tr key={s.date}>
                <td>{s.date}</td>
                <td>{money(s.cost_usd)}</td>
                <td>{s.requests}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </figcaption>
    </figure>
  );
}

function CsvButton() {
  const { client } = useAnonymo();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="row" style={{ gap: 8 }}>
      {error && <small className="error-text">{error}</small>}
      <button
        type="button"
        className="btn btn-ghost btn-small"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const csv = await client.activityCsv();
            const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = `anonymo-activity-${new Date().toISOString().slice(0, 10)}.csv`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } catch (e) {
            setError(describeError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Download size={15} aria-hidden="true" /> Download CSV
      </button>
    </span>
  );
}

type Draft = { daily: string; monthly: string; lifetime: string };
const toDraft = (c: KeyCaps): Draft => ({ daily: c.daily_usd?.toString() ?? '', monthly: c.monthly_usd?.toString() ?? '', lifetime: c.lifetime_usd?.toString() ?? '' });
const USD_RE = /^\d{1,9}(\.\d{1,6})?$/;

/** The key's spend limits. Empty means no limit. Once a limit is reached the gateway refuses calls (402) until the window resets. */
function Limits({ spentToday, spentMonth, onSaved }: { spentToday: number | null; spentMonth: number | null; onSaved: () => void }) {
  const { ready, key, client } = useAnonymo();
  const [caps, setCaps] = useState<KeyCaps | null>(null);
  const [draft, setDraft] = useState<Draft>({ daily: '', monthly: '', lifetime: '' });
  const [state, setState] = useState<{ kind: 'idle' | 'saving' | 'saved' } | { kind: 'error'; text: string }>({ kind: 'idle' });

  useEffect(() => {
    if (!ready || !key) return;
    client.keyInfo().then(
      (info) => {
        setCaps(info.caps);
        setDraft(toDraft(info.caps));
      },
      () => undefined,
    );
  }, [ready, key, client]);

  const invalid = (['daily', 'monthly', 'lifetime'] as const).find((f) => draft[f].trim() && !USD_RE.test(draft[f].trim()));
  const changed = caps !== null && JSON.stringify(toDraft(caps)) !== JSON.stringify(draft);
  const value = (s: string) => (s.trim() ? s.trim() : null);

  async function save() {
    if (invalid) return;
    setState({ kind: 'saving' });
    try {
      const res = await client.updateCaps({ daily_usd: value(draft.daily), monthly_usd: value(draft.monthly), lifetime_usd: value(draft.lifetime) });
      setCaps(res.caps);
      setDraft(toDraft(res.caps));
      setState({ kind: 'saved' });
      onSaved();
    } catch (e) {
      setState({ kind: 'error', text: describeError(e) });
    }
  }

  const meter = (used: number | null, cap: number | null | undefined) =>
    used === null || cap == null || cap <= 0 ? null : (
      <span className="share share-meter" aria-label={`${money(used)} of ${money(cap)} used`}>
        <span style={{ width: `${Math.min(100, (used / cap) * 100)}%` }} data-full={used >= cap ? 'true' : undefined} />
      </span>
    );

  return (
    <section className="panel limits">
      <header className="panel-head">
        <h2>
          <Gauge size={18} aria-hidden="true" /> Spending limits
        </h2>
      </header>
      <p className="muted limits-lede">Stop this key at an amount you choose. Leave a box empty for no limit. Limits reset at midnight UTC and on the 1st.</p>
      <form
        className="limits-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {(
          [
            ['daily', 'Per day', spentToday, caps?.daily_usd],
            ['monthly', 'Per month', spentMonth, caps?.monthly_usd],
            ['lifetime', 'Ever', null, caps?.lifetime_usd],
          ] as const
        ).map(([f, label, used, cap]) => (
          <label key={f} className="limit-row">
            <span>{label}</span>
            <span className="money-input">
              <span aria-hidden="true">$</span>
              <input
                className="input"
                inputMode="decimal"
                placeholder="No limit"
                value={draft[f]}
                aria-invalid={invalid === f || undefined}
                onChange={(e) => {
                  setDraft((d) => ({ ...d, [f]: e.target.value }));
                  setState({ kind: 'idle' });
                }}
              />
            </span>
            {meter(used, cap)}
            {used !== null && cap != null && <small className="muted">{money(used)} used</small>}
          </label>
        ))}
        <div className="row" style={{ gap: 10 }}>
          <button type="submit" className="btn btn-primary btn-small" disabled={!changed || !!invalid || state.kind === 'saving'}>
            <Save size={15} aria-hidden="true" /> {state.kind === 'saving' ? 'Saving…' : 'Save limits'}
          </button>
          {invalid && <small className="error-text">Enter dollars, like 5 or 12.50.</small>}
          {state.kind === 'saved' && <small className="ok-text">Saved. The gateway enforces them from the next request.</small>}
          {state.kind === 'error' && <small className="error-text">{state.text}</small>}
        </div>
      </form>
    </section>
  );
}
