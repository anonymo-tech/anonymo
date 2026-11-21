'use client';

// Update "ventures": the live crew board for one run. The run's steps are laid out in waves (steps whose needs are
// done run side by side), each with its Mo, its zone and a cost-against-cap meter, and the firewall drawn between the
// side that read the rival and the side that never did. Events stream from GET /v1/ventures/{id}/events (SSE over
// fetch, so the key goes in the Authorization header; resumed with Last-Event-ID), and the board polls every 2 s if
// the stream can't be held open. Once the run ends: the results tabs, the receipt, and the follow-ons (Run Mode, Save
// as Recipe). Crew-made pages are shown in iframes with sandbox="" (no scripts) and srcdoc.

import Link from 'next/link';
import {
  ArrowLeft,
  Ban,
  BookOpen,
  Check,
  Crown,
  Download,
  ExternalLink,
  FileCode2,
  Hash,
  Loader2,
  Lock,
  Monitor,
  Power,
  Radio,
  Repeat2,
  ShieldCheck,
  Smartphone,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Mo } from './mo';
import { useVenturesClient } from './ventures-client';
import { describeError, type AnonymoClient } from '@/lib/anonymo/client';
import {
  CREW,
  RUN_MODE,
  RUN_TASKS,
  RUN_TASK_LABELS,
  TAB_LABELS,
  TIER_RULES,
  VERDICT_LABELS,
  applyEvent,
  clock,
  eventOf,
  feedLine,
  findArtifact,
  firewallAfter,
  isTerminal,
  lanes,
  meter,
  modeTitle,
  parityCounts,
  progress,
  readAds,
  readLicence,
  readPlan,
  readSse,
  readTestReport,
  recipeProblem,
  relTime,
  resultTabs,
  runModeProblem,
  runModeUsage,
  shortHash,
  statusLabel,
  statusTone,
  stepTitle,
  tierLabel,
  usd,
  waves,
  type ArtifactInfo,
  type FeedLine,
  type ResultTab,
  type RunTask,
  type TierInfo,
  type VentureReceipt,
  type VentureSnapshot,
  type VentureStep,
} from '@/lib/anonymo/ventures';
import './ventures.css';

const POLL_MS = 2000;
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
const stillMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

type Live = { run: VentureSnapshot | null; feed: FeedLine[]; error: string | null; link: 'stream' | 'poll' | 'idle'; refresh: () => void };

/** The run, kept current: the snapshot, then events folded in as they stream; polling when the stream fails. */
function useVentureLive(client: AnonymoClient | null, id: string): Live {
  const [run, setRun] = useState<VentureSnapshot | null>(null);
  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<Live['link']>('idle');
  const [round, setRound] = useState(0);
  const [forId, setForId] = useState(id);
  if (forId !== id) {
    // Another run on the same board: start clean.
    setForId(id);
    setRun(null);
    setFeed([]);
    setError(null);
  }
  useEffect(() => {
    if (!client) return;
    const ctl = new AbortController();
    const { signal } = ctl;
    const cur: { v: VentureSnapshot | null } = { v: null };
    let last = 0;
    const show = (v: VentureSnapshot) => {
      cur.v = v;
      setRun(v);
    };
    const going = () => !signal.aborted && !!cur.v && !isTerminal(cur.v.status) && !cur.v.run_mode;
    void (async () => {
      try {
        show(await client.venture(id, signal));
        setError(null);
      } catch (e) {
        if (!signal.aborted) setError(describeError(e));
        return;
      }
      let failures = 0;
      while (going()) {
        try {
          setLink('stream');
          const body = await client.ventureEvents(id, last, signal);
          const reader = body.getReader();
          const decoder = new TextDecoder();
          signal.addEventListener('abort', () => void reader.cancel().catch(() => undefined), { once: true });
          let buf = '';
          let ended = false;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const { frames, rest } = readSse(buf + decoder.decode(value, { stream: true }));
            buf = rest;
            const lines: FeedLine[] = [];
            const snap = cur.v!;
            let next: VentureSnapshot = snap;
            for (const f of frames) {
              if (f.event === 'end') ended = true;
              const e = eventOf(f);
              if (!e) continue;
              if (f.id !== null) last = Math.max(last, f.id);
              // A RUNNING event for a step already running only updates its cost: no new log line.
              const again = e.type === 'step' && e.state === 'RUNNING' && next.steps.some((s) => s.key === e.step && s.state === 'RUNNING');
              next = applyEvent(next, e);
              if (again) continue;
              const line = feedLine(f.id ?? Date.now(), e);
              if (line) lines.push(line);
            }
            if (next !== snap) show(next);
            // A restarted stream replays from the start: keep each event's line once.
            if (lines.length)
              setFeed((prev) => {
                const seen = new Set(prev.map((l) => l.id));
                return [...prev, ...lines.filter((l) => !seen.has(l.id))].slice(-80);
              });
          }
          failures = 0;
          if (!signal.aborted) show(await client.venture(id, signal));
          if (ended) break;
        } catch {
          if (signal.aborted) return;
          failures += 1;
          if (failures < 2) {
            await sleep(1000, signal);
            continue;
          }
          setLink('poll');
          while (going()) {
            await sleep(POLL_MS, signal);
            try {
              show(await client.venture(id, signal));
            } catch {
              // keep polling
            }
          }
        }
      }
      if (!signal.aborted) setLink('idle');
    })();
    return () => ctl.abort();
  }, [client, id, round]);
  const refresh = useCallback(() => setRound((r) => r + 1), []);
  return { run, feed, error, link, refresh };
}

/** A number that eases toward its target (still when the person asked for less motion). */
function useTicker(target: number) {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (stillMotion()) {
      from.current = target;
      setShown(target);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 700);
      const v = a + (target - a) * (1 - (1 - k) ** 3);
      from.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return shown;
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function VentureBoard({ id }: { id: string }) {
  const { client, ready } = useVenturesClient();
  const live = useVentureLive(client, id);
  const { run, error } = live;

  if (ready && !client)
    return (
      <div className="notice notice-action">
        <span>Connect the key that started this run to see it.</span>
        <Link className="btn btn-primary btn-small" href="/dashboard/key">
          Create a key
        </Link>
      </div>
    );
  if (error)
    return (
      <div className="vx">
        <Back />
        <p className="notice notice-rose">{error}</p>
      </div>
    );
  if (!run)
    return (
      <div className="vx">
        <Back />
        <p className="faint vx-loading">
          <Loader2 size={16} className="vx-spin" aria-hidden="true" /> Loading the run…
        </p>
      </div>
    );
  return <Board client={client!} live={live} run={run} />;
}

function Back() {
  return (
    <Link className="vx-back" href="/dashboard/ventures">
      <ArrowLeft size={15} aria-hidden="true" /> All runs
    </Link>
  );
}

function Board({ client, live, run }: { client: AnonymoClient; live: Live; run: VentureSnapshot }) {
  const terminal = isTerminal(run.status);
  const [tier, setTier] = useState<TierInfo | null>(null);
  useEffect(() => {
    const c = new AbortController();
    client.ventureTier(c.signal).then(setTier, () => undefined);
    return () => c.abort();
  }, [client]);
  return (
    <div className="vx vx-board-page">
      <Back />
      <Hud client={client} run={run} link={live.link} />
      <div className="vx-deck">
        <CrewBoard run={run} />
        <Feed run={run} feed={live.feed} />
      </div>
      {terminal && run.mode !== 'RUN' && <Results client={client} run={run} />}
      {run.run_mode && <RunModeStatus client={client} run={run} onChange={live.refresh} />}
      {run.status === 'DONE' && run.mode !== 'RUN' && (
        <div className="vx-followons">
          <RunModePanel client={client} run={run} tier={tier} />
          <RecipePanel client={client} run={run} tier={tier} />
        </div>
      )}
    </div>
  );
}

// ---- the heads-up bar --------------------------------------------------------------------------------------------

function Hud({ client, run, link }: { client: AnonymoClient; run: VentureSnapshot; link: Live['link'] }) {
  const terminal = isTerminal(run.status);
  const now = useNow(!terminal);
  const started = Date.parse(run.created_at);
  const cost = useTicker(run.cost_usd);
  const cap = run.caps?.total ?? run.price_usd;
  const m = meter(run.cost_usd, cap);
  const { done, total } = progress(run.steps);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const tone = statusTone(run.status);
  async function cancel() {
    setCancelling(true);
    setCancelError(null);
    try {
      await client.cancelVenture(run.id);
    } catch (e) {
      setCancelError(describeError(e));
      setCancelling(false);
    }
  }
  return (
    <section className="vx-hud" aria-label="Run status" data-status={run.status}>
      <div className="vx-hud-id">
        <span className="vx-kicker">
          {modeTitle(run.mode)} · {tierLabel(run.tier)} tier
        </span>
        <h2>{run.input?.brand || modeTitle(run.mode)}</h2>
        {run.input?.brief && <p className="faint vx-hud-brief">{run.input.brief}</p>}
      </div>
      <dl className="vx-hud-stats">
        <div>
          <dt>Status</dt>
          <dd>
            <span className={`vx-status tone-${tone === 'live' ? 'ok' : tone}`} data-live={run.status === 'RUNNING' || undefined} aria-live="polite">
              <i aria-hidden="true" />
              {statusLabel(run.status)}
            </span>
          </dd>
        </div>
        <div>
          <dt>{terminal ? 'Started' : 'Elapsed'}</dt>
          <dd className="vx-num">{terminal ? relTime(run.created_at, now) : clock(now - started)}</dd>
        </div>
        <div>
          <dt>Steps</dt>
          <dd className="vx-num">
            {done}/{total}
          </dd>
        </div>
        <div className="vx-hud-cost">
          <dt>Crew spend</dt>
          <dd>
            <span className="vx-num vx-ticker">{usd(cost, true)}</span>
            <span className="faint"> of {usd(run.price_usd)} all-in</span>
            <span className={`vx-meter tone-${m.tone}`} aria-hidden="true">
              <span style={{ inlineSize: `${m.fraction * 100}%` }} />
            </span>
          </dd>
        </div>
      </dl>
      <div className="vx-hud-actions">
        {!terminal && (
          <span className="vx-link faint" title={link === 'poll' ? 'The event stream dropped, so the board checks every 2 seconds.' : 'Events arrive as they happen.'}>
            <Radio size={14} aria-hidden="true" /> {link === 'poll' ? 'Checking every 2 s' : 'Live'}
          </span>
        )}
        {!terminal && run.mode !== 'RUN' && (
          <button type="button" className="btn btn-danger btn-small" onClick={() => void cancel()} disabled={cancelling}>
            <Ban size={14} aria-hidden="true" /> {cancelling ? 'Stopping…' : 'Cancel run'}
          </button>
        )}
        {cancelError && (
          <span className="vx-problem" role="alert">
            {cancelError}
          </span>
        )}
      </div>
    </section>
  );
}

// ---- the board ------------------------------------------------------------------------------------------------------

function CrewBoard({ run }: { run: VentureSnapshot }) {
  const ws = useMemo(() => waves(run.steps), [run.steps]);
  const wall = firewallAfter(ws);
  const specDone = run.steps.some((s) => s.key.endsWith('spec') && s.state === 'DONE');
  return (
    <section className="vx-board" aria-label="The crew at work">
      {wall < 0 && run.mode !== 'RUN' && (
        <p className="vx-zone-note">
          <ShieldCheck size={14} aria-hidden="true" /> No rival to read: every step works in the clean room.
        </p>
      )}
      {wall >= 0 && (
        <p className="vx-zone-label vx-zone-scout">
          <Lock size={13} aria-hidden="true" /> Scout side · saw the rival’s public pages · kept by hash only
        </p>
      )}
      <ol className="vx-waves">
        {ws.map((wave, i) => (
          <WaveRow key={i} index={i} wave={wave} wall={i === wall} specDone={specDone} />
        ))}
      </ol>
    </section>
  );
}

function WaveRow({ index, wave, wall, specDone }: { index: number; wave: VentureStep[]; wall: boolean; specDone: boolean }) {
  const state = wave.some((s) => s.state === 'RUNNING') ? 'RUNNING' : wave.every((s) => s.state === 'DONE') ? 'DONE' : 'QUEUED';
  return (
    <>
      <li className="vx-wave" data-state={state}>
        <span className="vx-wave-rail" aria-hidden="true">
          <span>{index + 1}</span>
        </span>
        <span className="sr-only">Wave {index + 1}</span>
        <ul className="vx-cards">
          {wave.map((s) => (s.select === 'tests' && s.fanout > 1 ? <RaceCard key={s.key} step={s} /> : <StepCard key={s.key} step={s} />))}
        </ul>
      </li>
      {wall && (
        <li className="vx-firewall" data-crossed={specDone || undefined}>
          <span className="vx-firewall-band" aria-hidden="true" />
          <span className="vx-firewall-text">
            <ShieldCheck size={15} aria-hidden="true" /> Firewall · only the Spec crosses
          </span>
          <span className="vx-firewall-spec" aria-hidden="true">
            Spec
          </span>
          <span className="vx-zone-label vx-zone-clean">
            <ShieldCheck size={13} aria-hidden="true" /> Clean side · never saw the rival
          </span>
        </li>
      )}
    </>
  );
}

function ZoneBadge({ zone }: { zone: VentureStep['zone'] }) {
  return <span className={zone === 'SCOUT' ? 'vx-zone vx-zone-s' : 'vx-zone vx-zone-c'}>{zone}</span>;
}

function StepMeter({ step }: { step: VentureStep }) {
  const m = meter(step.cost_usd, step.cap_usd);
  return (
    <span className="vx-step-meter">
      <span className={`vx-meter tone-${m.tone}`} aria-hidden="true">
        <span style={{ inlineSize: `${m.fraction * 100}%` }} />
      </span>
      <span className="vx-num faint">
        {usd(step.cost_usd, true)} <span className="sr-only">spent </span>/ {usd(step.cap_usd, true)} cap
      </span>
    </span>
  );
}

function StepCard({ step }: { step: VentureStep }) {
  const mo = CREW[step.role];
  return (
    <li className="vx-card" data-state={step.state} data-zone={step.zone}>
      <div className="vx-card-top">
        <Mo role={step.role} state={step.state} size={48} />
        <div className="vx-card-name">
          <strong>{stepTitle(step.key)}</strong>
          <span className="faint">
            {mo?.name ?? step.role}
            {step.fanout > 1 && ` ×${step.fanout} · ${step.select === 'council-merge' ? 'council merges' : step.select === 'council-select' ? 'council picks' : 'best kept'}`}
          </span>
        </div>
        <ZoneBadge zone={step.zone} />
      </div>
      <div className="vx-card-foot">
        <StateChip state={step.state} />
        <StepMeter step={step} />
      </div>
      {step.error && <p className="vx-problem">{step.error}</p>}
    </li>
  );
}

function StateChip({ state }: { state: VentureStep['state'] }) {
  return (
    <span className="vx-state" data-state={state}>
      {state === 'RUNNING' ? <Loader2 size={12} className="vx-spin" aria-hidden="true" /> : state === 'DONE' ? <Check size={12} aria-hidden="true" /> : state === 'FAILED' ? <X size={12} aria-hidden="true" /> : null}
      {statusLabel(state)}
    </span>
  );
}

function RaceCard({ step }: { step: VentureStep }) {
  const ls = lanes(step);
  const winner = ls.find((l) => l.chosen);
  return (
    <li className="vx-card vx-race" data-state={step.state} data-zone={step.zone}>
      <div className="vx-card-top">
        <Mo role="tester" state={step.state} chosen={!!winner} size={48} />
        <div className="vx-card-name">
          <strong>{stepTitle(step.key)}</strong>
          <span className="faint">
            {step.fanout} Builder Mos build the same feature in separate sandboxes. Tester Mo keeps the one that passes most.
          </span>
        </div>
        <ZoneBadge zone={step.zone} />
      </div>
      {ls.length === 0 ? (
        <p className="faint vx-race-wait">{step.state === 'QUEUED' ? 'Waiting for the tests and the plan.' : 'Sandboxes starting…'}</p>
      ) : (
        <ol className="vx-lanes">
          {ls.map((l) => (
            <li key={l.family} className="vx-lane" data-state={l.state} data-chosen={l.chosen || undefined}>
              <Mo role="builder" family={l.family} state={l.state === 'refused' ? 'SKIPPED' : l.state === 'racing' ? 'RUNNING' : 'DONE'} chosen={l.chosen} size={34} />
              <span className="vx-lane-name">
                <strong>
                  {l.chosen && <Crown size={14} className="vx-crown" aria-label="Kept" />}
                  {l.family}
                </strong>
                <code>{l.model}</code>
              </span>
              <span className="vx-lane-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={l.passRate === null ? 0 : Math.round(l.passRate * 100)} aria-label={`${l.family}: ${l.note}`}>
                <span style={{ inlineSize: `${(l.passRate ?? (l.state === 'refused' ? 1 : 0)) * 100}%` }} />
              </span>
              <span className="vx-lane-note">{l.state === 'refused' ? 'Refused · rerouted · $0' : l.passRate === null ? '…' : `${Math.round(l.passRate * 100)}%`}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="vx-card-foot">
        <StateChip state={step.state} />
        <StepMeter step={step} />
      </div>
    </li>
  );
}

function Feed({ run, feed }: { run: VentureSnapshot; feed: FeedLine[] }) {
  const list = useRef<HTMLOListElement>(null);
  const lines = useMemo<FeedLine[]>(() => {
    if (feed.length) return feed;
    // A finished run (or one opened mid-way) has no streamed lines yet: show what the snapshot says.
    return run.steps
      .filter((s) => s.state !== 'QUEUED')
      .map((s, i) => ({
        id: i,
        at: run.created_at,
        role: s.role,
        text: `${stepTitle(s.key)} ${statusLabel(s.state).toLowerCase()}${s.state === 'DONE' ? ` · ${usd(s.cost_usd, true)}` : ''}`,
        tone: statusTone(s.state),
      }));
  }, [feed, run.steps, run.created_at]);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <section className="vx-feed" aria-label="Crew log">
      <header>
        <span className="vx-kicker">Crew log</span>
        <span className="faint">{lines.length} {lines.length === 1 ? 'line' : 'lines'}</span>
      </header>
      <ol ref={list} aria-live="polite" aria-relevant="additions">
        {lines.length === 0 && <li className="faint">Boss Mo is splitting the budget…</li>}
        {lines.map((l) => (
          <li key={l.id} data-tone={l.tone}>
            {l.role && <Mo role={l.role} size={22} state={l.tone === 'bad' ? 'FAILED' : l.tone === 'ok' ? 'DONE' : 'RUNNING'} />}
            <span>{l.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---- results ------------------------------------------------------------------------------------------------------

function useArtifactText(client: AnonymoClient, runId: string, art: ArtifactInfo | null) {
  const [state, setState] = useState<{ sha: string; text: string | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!art) return;
    const c = new AbortController();
    client.ventureArtifact(runId, art.sha256, c.signal).then(
      (text) => setState({ sha: art.sha256, text, error: null }),
      (e: unknown) => !c.signal.aborted && setState({ sha: art.sha256, text: null, error: describeError(e) }),
    );
    return () => c.abort();
  }, [client, runId, art]);
  return state && art && state.sha === art.sha256 ? state : null;
}

function useArtifactJson<T>(client: AnonymoClient, runId: string, art: ArtifactInfo | null, read: (raw: unknown) => T) {
  const got = useArtifactText(client, runId, art);
  return useMemo(() => {
    if (!got) return { value: null, error: null };
    if (got.error) return { value: null, error: got.error };
    try {
      return { value: read(JSON.parse(got.text ?? 'null')), error: null };
    } catch {
      return { value: null, error: 'This artifact is not readable JSON.' };
    }
  }, [got, read]);
}

function Results({ client, run }: { client: AnonymoClient; run: VentureSnapshot }) {
  const [arts, setArts] = useState<ArtifactInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const c = new AbortController();
    client.ventureArtifacts(run.id, c.signal).then(setArts, (e: unknown) => !c.signal.aborted && setError(describeError(e)));
    return () => c.abort();
  }, [client, run.id, run.status]);
  const tabs = useMemo(() => (arts ? resultTabs(run.mode, arts) : []), [arts, run.mode]);
  const [tab, setTab] = useState<ResultTab | null>(null);
  const current = tab && tabs.includes(tab) ? tab : (tabs[0] ?? null);
  const baseId = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  function key(e: React.KeyboardEvent) {
    if (!current) return;
    const i = tabs.indexOf(current);
    const next = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length] : e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs.at(-1) : null;
    if (!next) return;
    e.preventDefault();
    setTab(next);
    refs.current[next]?.focus();
  }
  return (
    <section className="vx-results" aria-labelledby={`${baseId}-title`}>
      <header className="vx-section-head">
        <h2 id={`${baseId}-title`}>What the crew made</h2>
        <p className="muted">Everything from the clean side opens here. What Scout Mo saw stays listed by hash only.</p>
      </header>
      {error && <p className="notice notice-rose">{error}</p>}
      {!arts && !error && <p className="faint">Loading results…</p>}
      {arts && current && (
        <>
          <div className="vx-tabs" role="tablist" aria-label="Results" onKeyDown={key}>
            {tabs.map((t) => (
              <button
                key={t}
                ref={(el) => {
                  refs.current[t] = el;
                }}
                type="button"
                role="tab"
                id={`${baseId}-tab-${t}`}
                aria-selected={t === current}
                aria-controls={`${baseId}-panel`}
                tabIndex={t === current ? 0 : -1}
                onClick={() => setTab(t)}
              >
                {TAB_LABELS[t]}
              </button>
            ))}
          </div>
          <div className="vx-panel" role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${current}`} tabIndex={0}>
            {current === 'plan' && <PlanTab client={client} run={run} arts={arts} />}
            {current === 'design' && <PageTab client={client} run={run} art={findArtifact(arts, 'preview')} title="Design system preview" />}
            {current === 'landing' && <PageTab client={client} run={run} art={findArtifact(arts, 'landing')} title="Landing page" />}
            {current === 'comparison' && (
              <>
                {findArtifact(arts, 'comparison') && <PageTab client={client} run={run} art={findArtifact(arts, 'comparison')} title="Comparison page" />}
                {findArtifact(arts, 'alternative') && <PageTab client={client} run={run} art={findArtifact(arts, 'alternative')} title="Switch page" />}
              </>
            )}
            {current === 'ads' && <AdsTab client={client} run={run} arts={arts} />}
            {current === 'code' && <CodeTab client={client} run={run} arts={arts} />}
            {current === 'receipt' && <ReceiptTab client={client} run={run} arts={arts} />}
            {current === 'licence' && <LicenceTab client={client} run={run} arts={arts} />}
          </div>
        </>
      )}
    </section>
  );
}

function Loading({ error }: { error: string | null }) {
  return error ? <p className="notice notice-rose">{error}</p> : <p className="faint">Opening…</p>;
}

function PlanTab({ client, run, arts }: { client: AnonymoClient; run: VentureSnapshot; arts: ArtifactInfo[] }) {
  const { value: plan, error } = useArtifactJson(client, run.id, findArtifact(arts, 'plan'), readPlan);
  if (!plan) return <Loading error={error} />;
  const counts = parityCounts(plan.parity);
  return (
    <div className="vx-plan">
      <header className="vx-plan-head">
        {plan.name && <span className="vx-kicker">{plan.name}</span>}
        <h3>{plan.positioning}</h3>
        <dl>
          {plan.audience && (
            <div>
              <dt>For</dt>
              <dd>{plan.audience}</dd>
            </div>
          )}
          {plan.problem && (
            <div>
              <dt>Problem</dt>
              <dd>{plan.problem}</dd>
            </div>
          )}
        </dl>
      </header>
      {plan.parity.length > 0 && (
        <div className="vx-block">
          <h4>
            Parity+ matrix
            <span className="vx-counts">
              <span className="chip">{counts.parity} parity</span>
              <span className="chip chip-signal">{counts.better} better</span>
              <span className="chip chip-pink">{counts.added} new</span>
            </span>
          </h4>
          <div className="vx-table-wrap">
            <table className="vx-table">
              <thead>
                <tr>
                  <th scope="col">Feature</th>
                  <th scope="col">Theirs</th>
                  <th scope="col">Ours</th>
                  <th scope="col">Note</th>
                </tr>
              </thead>
              <tbody>
                {plan.parity.map((r) => (
                  <tr key={r.feature}>
                    <th scope="row">{r.feature}</th>
                    <td>{r.theirs ? <Check size={15} aria-label="Yes" /> : <span className="faint" aria-label="No">—</span>}</td>
                    <td>
                      <span className={`vx-ours vx-ours-${r.ours}`}>{r.ours === 'new' ? 'New' : r.ours === 'better' ? 'Better' : 'Parity'}</span>
                    </td>
                    <td className="muted">{r.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="vx-plan-grid">
        {plan.gaps.length > 0 && (
          <div className="vx-block">
            <h4>Gaps their users ask for</h4>
            <ul className="vx-bullets">
              {plan.gaps.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          </div>
        )}
        {plan.priceUnder && (
          <div className="vx-block vx-under">
            <h4>Priced under theirs</h4>
            <p>
              <span className="vx-num vx-under-them">{plan.priceUnder.theirs === null ? '—' : usd(plan.priceUnder.theirs)}</span>
              <span className="faint"> theirs → </span>
              <span className="vx-num vx-under-us">{plan.priceUnder.ours === null ? '—' : usd(plan.priceUnder.ours)}</span>
              <span className="faint"> ours, top plan a month</span>
            </p>
            {plan.priceUnder.note && <p className="muted">{plan.priceUnder.note}</p>}
          </div>
        )}
        {plan.improvements.length > 0 && (
          <div className="vx-block">
            <h4>First improvements</h4>
            <ul className="vx-bullets">
              {plan.improvements.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {plan.features.length > 0 && (
        <div className="vx-block">
          <h4>MVP features and the tests behind them</h4>
          <ol className="vx-features">
            {plan.features.map((f) => (
              <li key={f.id}>
                <strong>{f.title}</strong>
                {f.description && <span className="muted">{f.description}</span>}
                <ul>
                  {f.acceptance.map((a) => (
                    <li key={a}>
                      <code>{a}</code>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </div>
      )}
      {plan.pricing.length > 0 && (
        <div className="vx-block">
          <h4>Pricing</h4>
          <ul className="vx-plans">
            {plan.pricing.map((p) => (
              <li key={p.name}>
                <strong>{p.name}</strong>
                <span className="vx-num">{p.price === null ? 'Ask' : p.price === 0 ? 'Free' : `${usd(p.price)}/mo`}</span>
                <span className="faint">{p.features.join(' · ')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function PageTab({ client, run, art, title }: { client: AnonymoClient; run: VentureSnapshot; art: ArtifactInfo | null; title: string }) {
  const got = useArtifactText(client, run.id, art);
  const [phone, setPhone] = useState(false);
  if (!art) return null;
  return (
    <figure className="vx-page">
      <figcaption>
        <span>
          <strong>{title}</strong>
          <span className="faint"> · shown with scripts off · {shortHash(art.sha256)}</span>
        </span>
        <span className="vx-seg" role="group" aria-label="Width">
          <button type="button" aria-pressed={!phone} onClick={() => setPhone(false)}>
            <Monitor size={14} aria-hidden="true" /> Desktop
          </button>
          <button type="button" aria-pressed={phone} onClick={() => setPhone(true)}>
            <Smartphone size={14} aria-hidden="true" /> Phone
          </button>
        </span>
      </figcaption>
      {!got || got.error ? (
        <Loading error={got?.error ?? null} />
      ) : (
        <div className="vx-frame" data-phone={phone || undefined}>
          <iframe title={`${title}, made by the crew`} sandbox="" srcDoc={got.text ?? ''} referrerPolicy="no-referrer" loading="lazy" />
        </div>
      )}
    </figure>
  );
}

function AdsTab({ client, run, arts }: { client: AnonymoClient; run: VentureSnapshot; arts: ArtifactInfo[] }) {
  const { value: kit, error } = useArtifactJson(client, run.id, findArtifact(arts, 'adkit') ?? findArtifact(arts, 'ads'), readAds);
  if (!kit) return <Loading error={error} />;
  return (
    <div className="vx-ads">
      {kit.hooks.length > 0 && (
        <div className="vx-block">
          <h4>Hooks</h4>
          <ul className="vx-hooks">
            {kit.hooks.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="vx-block">
        <h4>
          Ads <span className="faint">· {kit.ads.length}</span>
        </h4>
        <ul className="vx-adgrid">
          {kit.ads.map((a, i) => (
            <li key={i} className="vx-ad">
              <span className="vx-ad-channel">{a.channel}</span>
              <strong>{a.headline}</strong>
              <p>{a.body}</p>
              <span className="vx-ad-foot">
                {a.cta && <span className="vx-ad-cta">{a.cta}</span>}
                {a.angle && <span className="faint">{a.angle}</span>}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {kit.posts.length > 0 && (
        <div className="vx-block">
          <h4>Launch posts</h4>
          <ul className="vx-bullets">
            {kit.posts.map((p, i) => (
              <li key={i}>
                <span className="chip">{p.channel}</span> {p.text}
              </li>
            ))}
          </ul>
        </div>
      )}
      {kit.emails.length > 0 && (
        <div className="vx-block">
          <h4>Welcome emails</h4>
          <ul className="vx-bullets">
            {kit.emails.map((m, i) => (
              <li key={i}>
                <strong>Day {m.day}: </strong>
                {m.subject} <span className="faint">· {m.body}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const readRepo = (raw: unknown) => {
  const o = (raw && typeof raw === 'object' ? raw : {}) as { commit?: unknown; files?: unknown };
  return { commit: typeof o.commit === 'string' ? o.commit : null, files: Array.isArray(o.files) ? o.files.filter((f): f is string => typeof f === 'string').slice(0, 400) : [] };
};

function CodeTab({ client, run, arts }: { client: AnonymoClient; run: VentureSnapshot; arts: ArtifactInfo[] }) {
  const repo = useArtifactJson(client, run.id, findArtifact(arts, 'repo'), readRepo);
  const report = useArtifactJson(client, run.id, findArtifact(arts, 'test-report'), readTestReport);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function download() {
    setDownloading(true);
    setError(null);
    try {
      const blob = await client.ventureExport(run.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${run.id}.tar.gz`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setDownloading(false);
    }
  }
  const r = report.value;
  return (
    <div className="vx-code">
      <div className="vx-code-head">
        <div>
          <h4>The repo</h4>
          <p className="muted">
            {repo.value?.commit ? (
              <>
                Commit <code>{repo.value.commit.slice(0, 12)}</code> · {repo.value.files.length} files · yours to keep, MIT unless the licence report says otherwise.
              </>
            ) : (
              'The crew’s repo for this run.'
            )}
          </p>
        </div>
        <button type="button" className="btn btn-primary btn-small" onClick={() => void download()} disabled={downloading}>
          {downloading ? <Loader2 size={15} className="vx-spin" aria-hidden="true" /> : <Download size={15} aria-hidden="true" />} Download .tar.gz
        </button>
      </div>
      {error && <p className="notice notice-rose">{error}</p>}
      <div className="vx-plan-grid">
        {repo.value && repo.value.files.length > 0 && (
          <div className="vx-block">
            <h4>Files</h4>
            <ul className="vx-files">
              {repo.value.files.map((f) => (
                <li key={f}>
                  <FileCode2 size={13} aria-hidden="true" />
                  <code>{f}</code>
                </li>
              ))}
            </ul>
          </div>
        )}
        {r && (
          <div className="vx-block">
            <h4>Test report</h4>
            {r.winner && (
              <p className="vx-winner">
                <Crown size={15} aria-hidden="true" /> Kept <strong>{r.winner.family}</strong> ({r.winner.model}): {r.winner.passed}/{r.winner.total} tests pass
              </p>
            )}
            <div className="vx-table-wrap">
              <table className="vx-table">
                <thead>
                  <tr>
                    <th scope="col">Family</th>
                    <th scope="col">Tests</th>
                    <th scope="col">Lint</th>
                    <th scope="col">Bundle</th>
                  </tr>
                </thead>
                <tbody>
                  {r.candidates.map((c) => (
                    <tr key={c.family}>
                      <th scope="row">{c.family}</th>
                      <td className="vx-num">{c.refused ? <span className="chip chip-amber">Refused · $0</span> : `${c.passed}/${c.total}`}</td>
                      <td className="vx-num">{c.lintErrors ?? '—'}</td>
                      <td className="vx-num">{c.bundleBytes ? `${Math.round(c.bundleBytes / 1000)} kB` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ReceiptTab({ client, run, arts }: { client: AnonymoClient; run: VentureSnapshot; arts: ArtifactInfo[] }) {
  const [receipt, setReceipt] = useState<VentureReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const c = new AbortController();
    client.ventureReceipt(run.id, c.signal).then(setReceipt, (e: unknown) => !c.signal.aborted && setError(describeError(e)));
    return () => c.abort();
  }, [client, run.id]);
  if (!receipt) return <Loading error={error} />;
  const cr = receipt.clean_room;
  const refused = receipt.candidates.filter((c) => c.refused);
  const parts: [string, ReactNode][] = [
    ['Scout artifacts', `${cr.scoutArtifactHashes.length} hashes`],
    ['Spec', shortHash(cr.specHash, 16)],
    ['Sandbox policy', shortHash(cr.sandboxPolicyHash, 16)],
    ['Builder output', `${cr.builderArtifactHashes.length} hashes`],
    ['Similarity gate', cr.gateReportHash ? shortHash(cr.gateReportHash, 16) : 'not built yet'],
    ['Licence report', shortHash(cr.licenceReportHash, 16)],
  ];
  return (
    <div className="vx-receipt">
      <div className="vx-receipt-paper">
        <header>
          <span className="vx-kicker">Run receipt</span>
          <strong>{modeTitle(receipt.venture.mode)}</strong>
          <code>{receipt.venture.id}</code>
        </header>
        <dl className="vx-receipt-sum">
          <div>
            <dt>Price, all-in</dt>
            <dd className="vx-num">{usd(receipt.venture.price_usd)}</dd>
          </div>
          <div>
            <dt>Crew spend</dt>
            <dd className="vx-num">{usd(receipt.venture.cost_usd, true)}</dd>
          </div>
          <div>
            <dt>Refused attempts</dt>
            <dd className="vx-num">
              {refused.length} · {usd(0, true)}
            </dd>
          </div>
          <div>
            <dt>Model routes</dt>
            <dd className="vx-num">{receipt.steps.reduce((n, s) => n + s.receipts.length, 0)}</dd>
          </div>
        </dl>
        <div className="vx-root">
          <span className="vx-kicker">
            <ShieldCheck size={13} aria-hidden="true" /> Clean-room root
          </span>
          <code>{cr.root}</code>
          <span className="faint">{cr.anchored ? 'Anchored on chain.' : 'Not anchored on chain yet. Anyone can recompute it from the parts below.'}</span>
        </div>
        <dl className="vx-parts">
          {parts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>
                <code>{v}</code>
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="vx-block">
        <h4>Every step</h4>
        <div className="vx-table-wrap">
          <table className="vx-table">
            <thead>
              <tr>
                <th scope="col">Step</th>
                <th scope="col">Mo</th>
                <th scope="col">Zone</th>
                <th scope="col">State</th>
                <th scope="col">Cost</th>
                <th scope="col">Routes</th>
              </tr>
            </thead>
            <tbody>
              {receipt.steps.map((s) => (
                <tr key={s.key}>
                  <th scope="row">{stepTitle(s.key)}</th>
                  <td>{CREW[s.role]?.name ?? s.role}</td>
                  <td>
                    <ZoneBadge zone={s.zone} />
                  </td>
                  <td>{statusLabel(s.state)}</td>
                  <td className="vx-num">{usd(s.cost_usd, true)}</td>
                  <td className="vx-num">{s.receipts.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {receipt.candidates.length > 0 && (
        <div className="vx-block">
          <h4>Every candidate</h4>
          <div className="vx-table-wrap">
            <table className="vx-table">
              <thead>
                <tr>
                  <th scope="col">Family</th>
                  <th scope="col">Model</th>
                  <th scope="col">Tests</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Route receipt</th>
                </tr>
              </thead>
              <tbody>
                {receipt.candidates.map((c) => (
                  <tr key={`${c.step}:${c.family}`}>
                    <th scope="row">
                      {c.chosen && <Crown size={13} className="vx-crown" aria-label="Kept" />} {c.family}
                    </th>
                    <td>
                      <code>{c.model}</code>
                    </td>
                    <td className="vx-num">{c.refused ? 'Refused, rerouted' : c.pass_rate === null ? '—' : `${Math.round(c.pass_rate * 100)}%`}</td>
                    <td className="vx-num">{usd(c.cost_usd, true)}</td>
                    <td>
                      <code>{c.receipt_id ?? '—'}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="vx-block">
        <h4>What each zone saw</h4>
        <ul className="vx-arts">
          {arts.map((a) => (
            <li key={a.sha256} data-zone={a.zone}>
              {a.zone === 'SCOUT' ? <Lock size={13} aria-label="Hash only" /> : <Hash size={13} aria-hidden="true" />}
              <span>{a.name ?? a.kind}</span>
              <ZoneBadge zone={a.zone} />
              <code>{shortHash(a.sha256, 14)}</code>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function LicenceTab({ client, run, arts }: { client: AnonymoClient; run: VentureSnapshot; arts: ArtifactInfo[] }) {
  const { value: lic, error } = useArtifactJson(client, run.id, findArtifact(arts, 'licence') ?? findArtifact(arts, 'fork'), readLicence);
  if (!lic) return <Loading error={error} />;
  return (
    <div className="vx-licence">
      <p className="vx-verdict" data-verdict={lic.verdict}>
        <ShieldCheck size={18} aria-hidden="true" />
        <strong>{VERDICT_LABELS[lic.verdict] ?? lic.verdict}</strong>
        {lic.project && (
          <span className="faint">
            {' '}
            · upstream {lic.project.name} ({lic.project.spdx ?? 'no licence found'})
          </span>
        )}
      </p>
      <div className="vx-plan-grid">
        {lic.obligations.length > 0 && (
          <div className="vx-block">
            <h4>What to keep doing</h4>
            <ul className="vx-bullets">
              {lic.obligations.map((o) => (
                <li key={o}>{o}</li>
              ))}
            </ul>
          </div>
        )}
        {lic.reasons.length > 0 && (
          <div className="vx-block">
            <h4>Why</h4>
            <ul className="vx-bullets">
              {lic.reasons.map((o) => (
                <li key={o}>{o}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {lic.components.length > 0 && (
        <div className="vx-block">
          <h4>
            Components <span className="faint">· scanned with the {lic.tool} detector</span>
          </h4>
          <div className="vx-table-wrap">
            <table className="vx-table">
              <thead>
                <tr>
                  <th scope="col">Component</th>
                  <th scope="col">Licence</th>
                  <th scope="col">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {lic.components.map((c) => (
                  <tr key={c.name}>
                    <th scope="row">
                      <code>{c.name}</code>
                    </th>
                    <td>{c.spdx ?? '—'}</td>
                    <td>{VERDICT_LABELS[c.verdict] ?? c.verdict ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- follow-ons -----------------------------------------------------------------------------------------------------

const RUN_MODE_KEY = 'anonymo.ventures.run-mode.v1';
function rememberRunMode(parent: string, child: string | null) {
  try {
    const all = JSON.parse(localStorage.getItem(RUN_MODE_KEY) ?? '{}') as Record<string, string>;
    if (child) all[parent] = child;
    else delete all[parent];
    localStorage.setItem(RUN_MODE_KEY, JSON.stringify(all));
  } catch {
    // this device keeps no note; the run list still shows the Run Mode venture
  }
}
function runModeOf(parent: string): string | null {
  try {
    return (JSON.parse(localStorage.getItem(RUN_MODE_KEY) ?? '{}') as Record<string, string>)[parent] ?? null;
  } catch {
    return null;
  }
}

function RunModePanel({ client, run, tier }: { client: AnonymoClient; run: VentureSnapshot; tier: TierInfo | null }) {
  const id = useId();
  const [cap, setCap] = useState(25);
  const [tasks, setTasks] = useState<RunTask[]>(['improve', 'ads', 'brief']);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [child, setChild] = useState<string | null>(null);
  const [childRun, setChildRun] = useState<VentureSnapshot | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => setChild(runModeOf(run.id)), [run.id]);
  useEffect(() => {
    if (!child) return;
    const c = new AbortController();
    client.venture(child, c.signal).then(setChildRun, () => !c.signal.aborted && (rememberRunMode(run.id, null), setChild(null)));
    return () => c.abort();
  }, [client, child, run.id, round]);
  const hours = tier ? TIER_RULES[tier.tier].runModeHoursPerDay : null;
  const hasTarget = run.mode === 'BUILD_BETTER' || run.mode === 'TAKEOVER';
  const body = { daily_cap_usd: cap, tasks, ...(tasks.includes('watch') ? { target_url: target } : {}) };
  const problem = runModeProblem(body);
  async function start() {
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      const made = await client.startRunMode(run.id, body);
      rememberRunMode(run.id, made.id);
      setChild(made.id);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  if (childRun?.run_mode) return <RunModeStatus client={client} run={childRun} onChange={() => setRound((r) => r + 1)} parent />;
  return (
    <section className="vx-follow" aria-labelledby={`${id}-t`}>
      <header>
        <Repeat2 size={18} aria-hidden="true" />
        <h3 id={`${id}-t`}>Run Mode</h3>
        <span className="chip">From {usd(RUN_MODE.dailyFeeUsd)} a day</span>
      </header>
      <p className="muted">Keep the crew on this business every day, under a hard daily cap. It stops for the day when the cap is reached.</p>
      {hours === 0 ? (
        <p className="notice">Run Mode needs the Crew tier or above. Staking $NYMO raises the tier.</p>
      ) : (
        <>
          <label className="field" htmlFor={`${id}-cap`}>
            <span className="vx-cap-label">
              Daily cap <strong className="vx-num">{usd(cap)}</strong>
            </span>
            <input id={`${id}-cap`} className="vx-range" type="range" min={RUN_MODE.minDailyCapUsd} max={RUN_MODE.maxDailyCapUsd} step={1} value={cap} onChange={(e) => setCap(Number(e.target.value))} />
            <span className="faint">
              {usd(RUN_MODE.dailyFeeUsd)} daily fee + up to {usd(runModeUsage(cap))} of work{hours ? ` · up to ${hours} h a day on your tier` : ''}
            </span>
          </label>
          <fieldset className="vx-tasks">
            <legend>Tasks</legend>
            {RUN_TASKS.filter((t) => t !== 'watch' || hasTarget).map((t) => (
              <label key={t} className="vx-task">
                <input type="checkbox" checked={tasks.includes(t)} onChange={(e) => setTasks(e.target.checked ? [...tasks, t] : tasks.filter((x) => x !== t))} />
                <span>
                  <strong>{RUN_TASK_LABELS[t].title}</strong>
                  <span className="faint">{RUN_TASK_LABELS[t].body}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {tasks.includes('watch') && (
            <label className="field" htmlFor={`${id}-target`}>
              The rival’s public site, again
              <input id={`${id}-target`} className="input" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://rival.example" value={target} onChange={(e) => setTarget(e.target.value)} />
              <span className="faint">Only its hash was kept after the run. It is held encrypted while Run Mode is on, and dropped when you turn it off.</span>
            </label>
          )}
          <button type="button" className="btn btn-primary" onClick={() => void start()} disabled={busy || !!problem}>
            <Power size={16} aria-hidden="true" /> {busy ? 'Switching on…' : `Switch on · up to ${usd(cap)} a day`}
          </button>
          {(error || problem) && <p className="vx-problem">{error ?? problem}</p>}
        </>
      )}
    </section>
  );
}

function RunModeStatus({ client, run, onChange, parent = false }: { client: AnonymoClient; run: VentureSnapshot; onChange: () => void; parent?: boolean }) {
  const rm = run.run_mode!;
  const now = useNow(rm.enabled);
  const [busy, setBusy] = useState(false);
  const [off, setOff] = useState(!rm.enabled);
  const [error, setError] = useState<string | null>(null);
  const m = meter(rm.spent_today_usd, rm.daily_cap_usd);
  async function stop() {
    setBusy(true);
    try {
      await client.stopRunMode(run.id);
      setOff(true);
      onChange();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="vx-follow vx-follow-on" aria-label="Run Mode">
      <header>
        <Repeat2 size={18} aria-hidden="true" />
        <h3>Run Mode</h3>
        <span className={off ? 'chip' : 'chip chip-signal'}>{off ? 'Off' : 'On'}</span>
      </header>
      <dl className="vx-rm">
        <div>
          <dt>Spent today</dt>
          <dd>
            <span className="vx-num">{usd(rm.spent_today_usd, true)}</span>
            <span className="faint"> of {usd(rm.daily_cap_usd)} cap</span>
            <span className={`vx-meter tone-${m.tone}`} aria-hidden="true">
              <span style={{ inlineSize: `${m.fraction * 100}%` }} />
            </span>
          </dd>
        </div>
        <div>
          <dt>Next tick</dt>
          <dd className="vx-num">{off ? '—' : relTime(rm.next_tick_at, now)}</dd>
        </div>
        <div>
          <dt>Tasks</dt>
          <dd>{rm.tasks.map((t) => RUN_TASK_LABELS[t as RunTask]?.title ?? t).join(' · ')}</dd>
        </div>
      </dl>
      {rm.last_brief && (
        <blockquote className="vx-brief-note">
          <span className="vx-kicker">
            <Mo role="boss" size={22} /> Last Monday brief
          </span>
          <p>{rm.last_brief}</p>
        </blockquote>
      )}
      <div className="vx-follow-actions">
        {parent && (
          <Link className="btn btn-small" href={`/dashboard/ventures/${encodeURIComponent(run.id)}`}>
            <ExternalLink size={14} aria-hidden="true" /> Open the Run Mode board
          </Link>
        )}
        {!off && (
          <button type="button" className="btn btn-danger btn-small" onClick={() => void stop()} disabled={busy}>
            <Power size={14} aria-hidden="true" /> {busy ? 'Turning off…' : 'Turn off'}
          </button>
        )}
      </div>
      {error && <p className="vx-problem">{error}</p>}
    </section>
  );
}

function RecipePanel({ client, run, tier }: { client: AnonymoClient; run: VentureSnapshot; tier: TierInfo | null }) {
  const id = useId();
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [price, setPrice] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ id: string; recipeHash: string } | null>(null);
  const selling = tier ? TIER_RULES[tier.tier].recipeSelling : false;
  const body = { title, summary, price_usd: price };
  async function save() {
    const p = recipeProblem(body, tier?.tier ?? 'solo');
    if (p) return setError(p);
    setBusy(true);
    setError(null);
    try {
      setSaved(await client.saveRecipe(run.id, body));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="vx-follow" aria-labelledby={`${id}-t`}>
      <header>
        <BookOpen size={18} aria-hidden="true" />
        <h3 id={`${id}-t`}>Save as Recipe</h3>
      </header>
      <p className="muted">Save the pipeline that worked: its steps, fan-out and budget split. Never the brief, the rival or anything the crew made.</p>
      {saved ? (
        <p className="notice notice-signal">
          <Check size={15} aria-hidden="true" /> Saved. It is in the Recipes list now. <code>{shortHash(saved.recipeHash, 16)}</code>
        </p>
      ) : (
        <>
          <label className="field" htmlFor={`${id}-title`}>
            Title
            <input id={`${id}-title`} className="input" maxLength={80} autoComplete="off" placeholder="Studio booking, waitlists first" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field" htmlFor={`${id}-sum`}>
            What it is good for <span className="faint">(optional)</span>
            <textarea id={`${id}-sum`} className="textarea" rows={2} maxLength={400} value={summary} onChange={(e) => setSummary(e.target.value)} />
          </label>
          <label className="field" htmlFor={`${id}-price`}>
            Price per run
            <span className="vx-price-input">
              <span aria-hidden="true">$</span>
              <input id={`${id}-price`} className="input" type="number" inputMode="decimal" min={0} max={500} step={1} value={price} disabled={!selling} onChange={(e) => setPrice(Math.max(0, Number(e.target.value) || 0))} />
            </span>
            <span className="faint">{selling ? 'You receive 80% of the price each time someone runs it.' : 'Selling Recipes needs the Gang tier. Share it free for now.'}</span>
          </label>
          <button type="button" className="btn btn-outline" onClick={() => void save()} disabled={busy || !title.trim()}>
            <BookOpen size={15} aria-hidden="true" /> {busy ? 'Saving…' : 'Save Recipe'}
          </button>
          {error && <p className="vx-problem">{error}</p>}
        </>
      )}
    </section>
  );
}
