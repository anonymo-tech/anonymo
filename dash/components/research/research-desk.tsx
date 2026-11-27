'use client';

// Update "research": Deep Research. A question becomes a few private web searches, each read by a cheap model, then one
// report with numbered sources. Every step shows as it happens. Runs on the person's balance; reports stay in this
// browser.

import Link from 'next/link';
import { Check, Download, FileSearch, Loader2, Plus, Search, Square, Trash2, X } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { CopyButton } from '../copy-button';
import {
  DEPTH_SEARCHES,
  PARALLEL,
  PLAN_MAX_TOKENS,
  QUESTION_LIMIT,
  READ_MAX_TOKENS,
  REPORT_MAX_TOKENS,
  RESEARCH_IDEAS,
  RESEARCH_READER,
  RESEARCH_WRITERS,
  blocksOf,
  inlineOf,
  parsePlan,
  planMessages,
  readMessages,
  reportFile,
  reportMessages,
  researchCeilingUsd,
  type Finding,
  type ResearchDepth,
} from '@/lib/anonymo/research';
import { roughUsd } from '@/lib/anonymo/build';
import { DEMO_REPORT } from '@/lib/anonymo/demo-outputs';
import { reportsStore, removeReport, saveReport, type SavedReport } from '@/lib/anonymo/build-store';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { describeError, isOutOfCredit } from '@/lib/anonymo/client';
import { hostOf, onlineModel, type Citation } from '@/lib/anonymo/search';
import { setupHref } from '@/lib/anonymo/setup-return';
import '../build/build.css';
import './research.css';

type Step = { search: string; state: 'waiting' | 'searching' | 'done' | 'failed'; sources: number };
type Run = {
  question: string;
  phase: 'planning' | 'searching' | 'writing';
  steps: Step[];
  report: string;
  sources: Citation[];
  started: number;
};

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Stopped', 'AbortError')); }, { once: true });
  });

export function ResearchDesk() {
  const { ready, demo, key, client, catalog, liveModels, balance, refreshBalance, rememberReceipt } = useAnonymo();
  const reports = useDeviceStore(reportsStore);
  const [question, setQuestion] = useState('');
  const [depth, setDepth] = useState<ResearchDepth>('deep');
  const writers = useMemo(() => RESEARCH_WRITERS.filter((w) => !liveModels || liveModels.has(w.id) || demo), [liveModels, demo]);
  const [pickedWriter, setWriter] = useState(RESEARCH_WRITERS[0].id);
  const writer = writers.some((w) => w.id === pickedWriter) ? pickedWriter : writers[0]?.id ?? pickedWriter;
  const [run, setRun] = useState<Run | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<{ text: string; needsFunds?: boolean } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const priceOf = (id: string) => catalog?.find((m) => m.id === id)?.pricing;
  const ceiling = researchCeilingUsd(depth, priceOf(RESEARCH_READER), priceOf(writer));
  const canRun = !!key || demo;
  const broke = !demo && !!key && balance !== null && Number(balance.available_usd) <= 0;
  const open = reports.find((r) => r.id === openId) ?? null;

  const patch = (change: Partial<Run> | ((run: Run) => Partial<Run>)) =>
    setRun((r) => (r ? { ...r, ...(typeof change === 'function' ? change(r) : change) } : r));
  const step = (i: number, change: Partial<Step>) =>
    patch((r) => ({ steps: r.steps.map((s, j) => (j === i ? { ...s, ...change } : s)) }));

  async function start() {
    const q = question.trim();
    if (!q || run || !canRun) return;
    setError(null);
    setOpenId(null);
    const controller = new AbortController();
    abort.current = controller;
    const signal = controller.signal;
    setRun({ question: q, phase: 'planning', steps: [], report: '', sources: [], started: Date.now() });
    const n = DEPTH_SEARCHES[depth];
    try {
      let searches: string[];
      const findings: Finding[] = [];
      let report = '';
      let sources: Citation[] = [];

      if (demo && !key) {
        await wait(900, signal);
        searches = DEMO_REPORT.searches;
        patch({ phase: 'searching', steps: searches.map((search) => ({ search, state: 'waiting', sources: 0 })) });
        for (let i = 0; i < searches.length; i++) {
          step(i, { state: 'searching' });
          await wait(700, signal);
          step(i, { state: 'done', sources: 5 });
        }
        patch({ phase: 'writing' });
        for (let i = 0; i < DEMO_REPORT.report.length; i += 24) {
          report = DEMO_REPORT.report.slice(0, i + 24);
          patch({ report, sources: DEMO_REPORT.sources });
          await wait(16, signal);
        }
        sources = DEMO_REPORT.sources;
      } else {
        // 1. Plan.
        const plan = await client.chat({ model: RESEARCH_READER, messages: planMessages(q, n), max_tokens: PLAN_MAX_TOKENS, temperature: 0.3 }, { signal });
        if (plan.receiptId) rememberReceipt({ id: plan.receiptId, model: RESEARCH_READER, at: new Date().toISOString() });
        searches = parsePlan(plan.content, n, q);
        patch({ phase: 'searching', steps: searches.map((search) => ({ search, state: 'waiting', sources: 0 })) });

        // 2. Search and read, a few at a time.
        let next = 0;
        let fatal: unknown = null;
        const worker = async () => {
          while (next < searches.length && !fatal && !signal.aborted) {
            const i = next++;
            step(i, { state: 'searching' });
            try {
              const result = await client.chat(
                { model: onlineModel(RESEARCH_READER, true), messages: readMessages(q, searches[i]), max_tokens: READ_MAX_TOKENS, temperature: 0.2 },
                { signal },
              );
              if (result.receiptId) rememberReceipt({ id: result.receiptId, model: RESEARCH_READER, at: new Date().toISOString() });
              const cited = result.citations ?? [];
              findings[i] = { search: searches[i], notes: result.content, sources: cited };
              step(i, { state: 'done', sources: cited.length });
            } catch (cause) {
              if (isOutOfCredit(cause) || (cause instanceof DOMException && cause.name === 'AbortError')) fatal = cause;
              step(i, { state: 'failed' });
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(PARALLEL, searches.length) }, worker));
        if (fatal) throw fatal;
        signal.throwIfAborted();
        const found = findings.filter(Boolean);
        if (!found.length) throw new Error('None of the searches came back. Nothing more was spent. Try again in a moment.');

        // 3. Write.
        const ask = reportMessages(q, found);
        sources = ask.sources;
        patch({ phase: 'writing', sources });
        const written = await client.chat(
          { model: writer, messages: ask.messages, max_tokens: REPORT_MAX_TOKENS, temperature: 0.3 },
          {
            signal,
            headers: { refusalCatch: 'on' },
            onDelta: (delta) => {
              report += delta;
              patch({ report });
            },
          },
        );
        report = written.content || report;
        if (written.receiptId) rememberReceipt({ id: written.receiptId, model: writer, at: new Date().toISOString() });
      }

      if (!report.trim()) throw new Error('The writer returned an empty report. Try again or pick the other writer.');
      const saved: SavedReport = {
        id: crypto.randomUUID(),
        question: q,
        depth,
        writer,
        searches,
        report: report.trim(),
        sources,
        at: new Date().toISOString(),
      };
      saveReport(saved);
      setOpenId(saved.id);
      setQuestion('');
    } catch (cause) {
      if (!signal.aborted) setError({ text: describeError(cause), needsFunds: isOutOfCredit(cause) });
    } finally {
      if (abort.current === controller) abort.current = null;
      setRun(null);
      if (!demo) refreshBalance();
    }
  }

  if (!ready) return null;

  if (run) return <Progress run={run} onStop={() => abort.current?.abort()} />;
  if (open) return <Report report={open} onNew={() => { setOpenId(null); setTimeout(() => input.current?.focus()); }} />;

  return (
    <section className="research-start">
      <h2>What do you want to know?</h2>
      <p className="faint">Ask anything, the way you’d ask a friend who reads everything. Anonymo runs {DEPTH_SEARCHES[depth]} private web searches, reads the results and writes you a report with sources. It takes about two minutes.</p>
      <form
        className="build-ask"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <textarea
          ref={input}
          aria-label="Your question"
          placeholder="Is it cheaper to lease or buy a car if I drive a lot?"
          value={question}
          maxLength={QUESTION_LIMIT}
          rows={3}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void start();
            }
          }}
        />
        <div className="build-ask-row">
          <fieldset className="research-depth">
            <legend className="sr-only">How deep</legend>
            {(['quick', 'deep'] as const).map((d) => (
              <button key={d} type="button" aria-pressed={depth === d} onClick={() => setDepth(d)}>
                {d === 'quick' ? 'Quick' : 'Deep'} <small>{DEPTH_SEARCHES[d]} searches</small>
              </button>
            ))}
          </fieldset>
          <label className="build-model">
            <span className="sr-only">Writer</span>
            <select value={writer} onChange={(e) => setWriter(e.target.value)}>
              {writers.map((w) => (
                <option key={w.id} value={w.id}>{w.label}</option>
              ))}
            </select>
          </label>
          <span className="build-price">{demo && !key ? 'Demo: free' : `At most ${roughUsd(ceiling)}`}</span>
          <button type="submit" className="btn btn-primary btn-small" disabled={!question.trim() || !canRun}>
            <Search size={15} aria-hidden="true" /> Research
          </button>
        </div>
        <p className="build-model-note faint">{writers.find((w) => w.id === writer)?.note} Searches go out without your account or key attached.</p>
      </form>
      <div className="build-ideas" aria-label="Ideas">
        {RESEARCH_IDEAS.map((idea) => (
          <button key={idea} type="button" className="build-idea" onClick={() => { setQuestion(idea); input.current?.focus(); }}>
            {idea}
          </button>
        ))}
      </div>
      {!canRun && (
        <p className="notice">
          Research runs on your own key. <Link className="link" href={setupHref('key', '/dashboard/research')}>Get a key</Link>. It’s free and takes a few seconds.
        </p>
      )}
      {broke && (
        <p className="notice">
          Research uses your balance: at most {roughUsd(ceiling)} a report. <Link className="link" href={setupHref('funds', '/dashboard/research')}>Add balance</Link>
        </p>
      )}
      {error && (
        <p className="notice notice-rose" role="alert">
          {error.text} {error.needsFunds && <Link className="link" href={setupHref('funds', '/dashboard/research')}>Add balance</Link>}
        </p>
      )}
      {reports.length > 0 && (
        <div className="build-saved">
          <h3>Your reports</h3>
          <ul>
            {reports.map((r) => (
              <li key={r.id}>
                <button type="button" className="build-saved-open" onClick={() => setOpenId(r.id)}>
                  <strong>{r.question}</strong>
                  <span className="faint">{r.sources.length} sources · {new Date(r.at).toLocaleDateString()}</span>
                </button>
                <button type="button" className="btn btn-ghost btn-small" aria-label="Delete this report" onClick={() => removeReport(r.id)}>
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <p className="faint build-saved-note">Kept in this browser only. Anonymo doesn’t store your questions or reports.</p>
        </div>
      )}
    </section>
  );
}

function Progress({ run, onStop }: { run: Run; onStop: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const seconds = Math.max(0, Math.round((now - run.started) / 1000));
  const done = run.steps.filter((s) => s.state === 'done').length;
  return (
    <section className="research-run" aria-live="polite">
      <header className="research-run-head">
        <p className="faint">Researching · {seconds}s</p>
        <h2>{run.question}</h2>
        <button type="button" className="btn btn-small" onClick={onStop}>
          <Square size={14} aria-hidden="true" /> Stop
        </button>
      </header>
      <ol className="research-phases">
        <li data-state={run.phase === 'planning' ? 'active' : 'done'}>
          <Phase active={run.phase === 'planning'} /> Planning the searches
        </li>
        <li data-state={run.phase === 'searching' ? 'active' : run.phase === 'writing' ? 'done' : 'waiting'}>
          <Phase active={run.phase === 'searching'} done={run.phase === 'writing'} /> Searching the web
          {run.steps.length > 0 && <span className="faint"> · {done} of {run.steps.length}</span>}
          {run.steps.length > 0 && (
            <ul className="research-searches">
              {run.steps.map((s) => (
                <li key={s.search} data-state={s.state}>
                  {s.state === 'searching' ? <Loader2 size={13} className="spin" aria-hidden="true" /> : s.state === 'done' ? <Check size={13} aria-hidden="true" /> : s.state === 'failed' ? <X size={13} aria-hidden="true" /> : <Search size={13} aria-hidden="true" />}
                  <span>{s.search}</span>
                  {s.state === 'done' && <small className="faint">{s.sources} sources</small>}
                  {s.state === 'failed' && <small className="faint">skipped</small>}
                </li>
              ))}
            </ul>
          )}
        </li>
        <li data-state={run.phase === 'writing' ? 'active' : 'waiting'}>
          <Phase active={run.phase === 'writing'} /> Writing your report
        </li>
      </ol>
      {run.report && (
        <article className="research-report research-report-live">
          <ReportBody text={run.report} sources={run.sources} />
        </article>
      )}
    </section>
  );
}

function Phase({ active, done }: { active: boolean; done?: boolean }) {
  if (active) return <Loader2 size={15} className="spin" aria-hidden="true" />;
  return done ? <Check size={15} aria-hidden="true" /> : <span className="research-dot" aria-hidden="true" />;
}

function Report({ report, onNew }: { report: SavedReport; onNew: () => void }) {
  const file = reportFile(report.question, report.report, report.sources);
  function download() {
    const blob = new Blob([file], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${report.question.replace(/[^\w\- ]+/g, '').trim().slice(0, 60).replace(/\s+/g, '-').toLowerCase() || 'report'}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  return (
    <section className="research-done">
      <div className="build-bar">
        <button type="button" className="btn btn-ghost btn-small" onClick={onNew}>
          <Plus size={14} aria-hidden="true" /> New question
        </button>
        <span className="build-bar-gap" />
        <CopyButton text={file} label="Copy" />
        <button type="button" className="btn btn-small" onClick={download}>
          <Download size={14} aria-hidden="true" /> Download
        </button>
      </div>
      <article className="research-report">
        <p className="faint research-meta"><FileSearch size={14} aria-hidden="true" /> {report.searches.length} searches · {report.sources.length} sources · {new Date(report.at).toLocaleString()}</p>
        <h1>{report.question}</h1>
        <ReportBody text={report.report} sources={report.sources} />
        {report.sources.length > 0 && (
          <footer className="research-sources">
            <h2>Sources</h2>
            <ol>
              {report.sources.map((s, i) => (
                <li key={s.url} id={`source-${i + 1}`}>
                  <a href={s.url} target="_blank" rel="noreferrer noopener">{s.title}</a>{s.title !== hostOf(s.url) && <> <span className="faint">{hostOf(s.url)}</span></>}
                </li>
              ))}
            </ol>
          </footer>
        )}
      </article>
    </section>
  );
}

function ReportBody({ text, sources }: { text: string; sources: Citation[] }) {
  const blocks = useMemo(() => blocksOf(text), [text]);
  return (
    <>
      {blocks.map((b, i) =>
        b.kind === 'h' ? <h2 key={i}><Inline text={b.text} sources={sources} /></h2>
          : b.kind === 'p' ? <p key={i}><Inline text={b.text} sources={sources} /></p>
            : b.kind === 'ul' ? <ul key={i}>{b.items.map((item, j) => <li key={j}><Inline text={item} sources={sources} /></li>)}</ul>
              : (
                <div key={i} className="research-table">
                  <table>
                    <thead><tr>{b.head.map((h, j) => <th key={j}><Inline text={h} sources={sources} /></th>)}</tr></thead>
                    <tbody>{b.rows.map((row, j) => <tr key={j}>{row.map((c, k) => <td key={k}><Inline text={c} sources={sources} /></td>)}</tr>)}</tbody>
                  </table>
                </div>
              ),
      )}
    </>
  );
}

function Inline({ text, sources }: { text: string; sources: Citation[] }) {
  return (
    <>
      {inlineOf(text).map((part, i) => {
        if (part.kind === 'text') return <Fragment key={i}>{part.text}</Fragment>;
        if (part.kind === 'bold') return <strong key={i}>{part.text}</strong>;
        const source = sources[part.n - 1];
        if (!source) return null;
        return (
          <a key={i} className="research-cite" href={source.url} target="_blank" rel="noreferrer noopener" title={`${source.title} · ${hostOf(source.url)}`}>
            {part.n}
          </a>
        );
      })}
    </>
  );
}
