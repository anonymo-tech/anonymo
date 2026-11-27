'use client';

// Update "build": describe an app or a game, watch it being written, play it right here, ask for changes, then download
// it or share it as a link. Runs on the person's balance; kept in this browser only.

import Link from 'next/link';
import { ArrowUp, Code2, Download, Expand, Hammer, Loader2, Plus, RotateCcw, Share2, Square, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { AppFrame, type AppFrameHandle } from './app-frame';
import {
  BUILD_IDEAS,
  BUILD_MAX_TOKENS,
  BUILD_MODELS,
  BUILD_PROMPT_LIMIT,
  DEMO_APP,
  buildCeilingUsd,
  buildMessages,
  buildTitle,
  buildTypicalUsd,
  encodeShare,
  extractHtml,
  isComplete,
  roughUsd,
  sandboxed,
} from '@/lib/anonymo/build';
import { buildsStore, removeBuild, saveBuild, type SavedBuild } from '@/lib/anonymo/build-store';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { describeError, isOutOfCredit } from '@/lib/anonymo/client';
import { setupHref } from '@/lib/anonymo/setup-return';
import './build.css';

type Writing = { ask: string; text: string; started: number };

export function BuildStudio() {
  const { ready, demo, key, client, catalog, liveModels, balance, refreshBalance, rememberReceipt } = useAnonymo();
  const builds = useDeviceStore(buildsStore);
  const [openId, setOpenId] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [ask, setAsk] = useState('');
  const offered = useMemo(() => BUILD_MODELS.filter((m) => !liveModels || liveModels.has(m.id) || demo), [liveModels, demo]);
  const [picked, setModel] = useState(BUILD_MODELS[0].id);
  const model = offered.some((m) => m.id === picked) ? picked : offered[0]?.id ?? picked;
  const [writing, setWriting] = useState<Writing | null>(null);
  const [error, setError] = useState<{ text: string; needsFunds?: boolean } | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [sharedFor, setShared] = useState<{ at: string; link: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const frame = useRef<AppFrameHandle>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const open = builds.find((b) => b.id === openId) ?? null;
  const shown = open ? open.versions[version ?? open.versions.length - 1] ?? open.versions.at(-1)! : null;
  const canBuild = !!key || demo;
  const pricing = catalog?.find((m) => m.id === model)?.pricing;
  const inputChars = (shown?.html.length ?? 0) + ask.length + 1_800;
  const typical = buildTypicalUsd(pricing, inputChars);
  const ceiling = buildCeilingUsd(pricing, inputChars);
  const broke = !demo && !!key && balance !== null && Number(balance.available_usd) <= 0;

  useEffect(() => () => abort.current?.abort(), []);
  const shared = sharedFor && shown && sharedFor.at === shown.at ? sharedFor.link : null;

  const liveHtml = writing ? extractHtml(writing.text) : null;

  async function start() {
    const idea = ask.trim();
    if (!idea || writing || !canBuild) return;
    setError(null);
    setShowCode(false);
    const base = shown && open ? shown.html : null;
    const controller = new AbortController();
    abort.current = controller;
    setWriting({ ask: idea, text: '', started: Date.now() });
    try {
      let text = '';
      if (demo && !key) {
        // Demo mode: stream the sample game so the page can be tried without a key.
        for (let i = 0; i < DEMO_APP.length; i += 90) {
          controller.signal.throwIfAborted();
          text = DEMO_APP.slice(0, i + 90);
          setWriting((w) => (w ? { ...w, text } : w));
          await new Promise((r) => setTimeout(r, 18));
        }
      } else {
        const result = await client.chat(
          { model, messages: buildMessages(idea, base), max_tokens: BUILD_MAX_TOKENS, temperature: 0.4 },
          {
            signal: controller.signal,
            headers: { refusalCatch: 'on' },
            onDelta: (delta) => {
              text += delta;
              setWriting((w) => (w ? { ...w, text } : w));
            },
          },
        );
        text = result.content || text;
        if (result.receiptId) rememberReceipt({ id: result.receiptId, model, at: new Date().toISOString() });
      }
      const html = extractHtml(text);
      if (!html) {
        setError({ text: "The model didn't write an app this time. Try again, or try another model." });
        return;
      }
      const v = { ask: idea, html, complete: isComplete(html), at: new Date().toISOString() };
      const next: SavedBuild = open
        ? { ...open, title: buildTitle(html, open.title), model, versions: [...open.versions.slice(0, (version ?? open.versions.length - 1) + 1), v], at: v.at }
        : { id: crypto.randomUUID(), title: buildTitle(html, idea), model, versions: [v], at: v.at };
      if (!saveBuild(next)) setError({ text: 'Built, but this browser had no room to keep it. Download it to keep a copy.' });
      setOpenId(next.id);
      setVersion(null);
      setAsk('');
      if (!v.complete) setError({ text: 'The app ran out of room before it finished, so parts may not work. Ask for a simpler version or "finish the app".' });
    } catch (cause) {
      if (!controller.signal.aborted) setError({ text: describeError(cause), needsFunds: isOutOfCredit(cause) });
    } finally {
      if (abort.current === controller) abort.current = null;
      setWriting(null);
      if (!demo) refreshBalance();
    }
  }

  function newApp() {
    abort.current?.abort();
    setOpenId(null);
    setVersion(null);
    setAsk('');
    setError(null);
    input.current?.focus();
  }

  function download() {
    if (!shown || !open) return;
    const blob = new Blob([sandboxed(shown.html)], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${open.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'app'}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function share() {
    if (!shown || !open) return;
    try {
      const link = `${location.origin}/play#${await encodeShare({ title: open.title, html: shown.html })}`;
      await navigator.clipboard?.writeText(link).catch(() => {});
      setShared({ at: shown.at, link });
    } catch (cause) {
      setError({ text: cause instanceof Error ? cause.message : 'Could not make a link.' });
    }
  }

  if (!ready) return null;

  const composer = (
    <form
      className="build-ask"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <textarea
        ref={input}
        aria-label={open ? 'What should change?' : 'What should we build?'}
        placeholder={open ? 'Make it faster, add a high score, change the colors…' : 'A snake game where the snake is a frog…'}
        value={ask}
        maxLength={BUILD_PROMPT_LIMIT}
        rows={open ? 2 : 3}
        disabled={!!writing}
        onChange={(e) => setAsk(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void start();
          }
        }}
      />
      <div className="build-ask-row">
        <label className="build-model">
          <span className="sr-only">Model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!!writing}>
            {offered.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <span className="build-price" title={ceiling !== null ? `At most ${roughUsd(ceiling)}` : undefined}>
          {demo && !key ? 'Demo: free' : `About ${roughUsd(typical)}`}
        </span>
        {writing ? (
          <button type="button" className="btn btn-small" onClick={() => abort.current?.abort()}>
            <Square size={14} aria-hidden="true" /> Stop
          </button>
        ) : (
          <button type="submit" className="btn btn-primary btn-small" disabled={!ask.trim() || !canBuild}>
            {open ? <ArrowUp size={15} aria-hidden="true" /> : <Hammer size={15} aria-hidden="true" />} {open ? 'Change it' : 'Build it'}
          </button>
        )}
      </div>
      <p className="build-model-note faint">{offered.find((m) => m.id === model)?.note}</p>
    </form>
  );

  return (
    <div className="build" data-open={!!open || !!writing}>
      {!open && !writing ? (
        <section className="build-start">
          <h2>What should we build?</h2>
          <p className="faint">One sentence is enough. It’s written for you in about a minute and runs right here, nothing to install.</p>
          {composer}
          <div className="build-ideas" aria-label="Ideas">
            {BUILD_IDEAS.map((idea) => (
              <button key={idea} type="button" className="build-idea" onClick={() => { setAsk(idea); input.current?.focus(); }}>
                {idea}
              </button>
            ))}
          </div>
          {!canBuild && (
            <p className="notice">
              Build runs on your own key. <Link className="link" href={setupHref('key', '/dashboard/build')}>Get a key</Link>. It’s free and takes a few seconds.
            </p>
          )}
          {broke && (
            <p className="notice">
              Build uses your balance: a typical app is about {roughUsd(typical)}. <Link className="link" href={setupHref('funds', '/dashboard/build')}>Add balance</Link>
            </p>
          )}
          {error && <BuildError error={error} />}
          {builds.length > 0 && (
            <div className="build-saved">
              <h3>Your apps</h3>
              <ul>
                {builds.map((b) => (
                  <li key={b.id}>
                    <button type="button" className="build-saved-open" onClick={() => { setOpenId(b.id); setVersion(null); }}>
                      <strong>{b.title}</strong>
                      <span className="faint">{b.versions.length} version{b.versions.length === 1 ? '' : 's'} · {new Date(b.at).toLocaleDateString()}</span>
                    </button>
                    <button type="button" className="btn btn-ghost btn-small" aria-label={`Delete ${b.title}`} onClick={() => removeBuild(b.id)}>
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
              <p className="faint build-saved-note">Kept in this browser only. Anonymo doesn’t store your apps.</p>
            </div>
          )}
        </section>
      ) : (
        <section className="build-work">
          <aside className="build-side">
            <button type="button" className="btn btn-ghost btn-small build-new" onClick={newApp} disabled={!!writing}>
              <Plus size={14} aria-hidden="true" /> New app
            </button>
            <h2 className="build-title">{writing && !open ? 'Building…' : open?.title}</h2>
            <ol className="build-steps">
              {open?.versions.map((v, i) => {
                const current = (version ?? open.versions.length - 1) === i;
                return (
                  <li key={v.at} data-current={current}>
                    <button type="button" onClick={() => setVersion(i)} disabled={!!writing}>
                      <span className="build-step-n">{i + 1}</span>
                      <span>{v.ask}</span>
                    </button>
                  </li>
                );
              })}
              {writing && (
                <li data-current="true" className="build-step-writing">
                  <span className="build-step-n"><Loader2 size={12} className="spin" aria-hidden="true" /></span>
                  <span>{writing.ask}</span>
                </li>
              )}
            </ol>
            {version !== null && open && version < open.versions.length - 1 && !writing && (
              <p className="faint build-branch-note"><Undo2 size={13} aria-hidden="true" /> Changing this version replaces the ones after it.</p>
            )}
            {composer}
            {error && <BuildError error={error} />}
          </aside>
          <div className="build-stage">
            {writing ? (
              <WritingView writing={writing} html={liveHtml} />
            ) : shown && open ? (
              <>
                <div className="build-bar">
                  <button type="button" className="btn btn-small" onClick={() => frame.current?.restart()}>
                    <RotateCcw size={14} aria-hidden="true" /> Restart
                  </button>
                  <button type="button" className="btn btn-small" onClick={() => frame.current?.fullscreen()}>
                    <Expand size={14} aria-hidden="true" /> Full screen
                  </button>
                  <button type="button" className="btn btn-small" aria-pressed={showCode} onClick={() => setShowCode((s) => !s)}>
                    <Code2 size={14} aria-hidden="true" /> Code
                  </button>
                  <span className="build-bar-gap" />
                  <button type="button" className="btn btn-small" onClick={download}>
                    <Download size={14} aria-hidden="true" /> Download
                  </button>
                  <button type="button" className="btn btn-primary btn-small" onClick={() => void share()}>
                    <Share2 size={14} aria-hidden="true" /> Share link
                  </button>
                </div>
                {shared && (
                  <output className="notice notice-signal build-shared">
                    Link copied. Anyone with it can play this app. The whole app is inside the link, so Anonymo never stores it.{' '}
                    <a className="link" href={shared} target="_blank" rel="noreferrer">Open it</a>
                  </output>
                )}
                {showCode ? (
                  <pre className="build-code"><code>{shown.html}</code></pre>
                ) : (
                  <AppFrame ref={frame} html={shown.html} title={open.title} className="build-frame" />
                )}
              </>
            ) : null}
          </div>
        </section>
      )}
    </div>
  );
}

function BuildError({ error }: { error: { text: string; needsFunds?: boolean } }) {
  return (
    <p className="notice notice-rose" role="alert">
      {error.text}{' '}
      {error.needsFunds && <Link className="link" href={setupHref('funds', '/dashboard/build')}>Add balance</Link>}
    </p>
  );
}

function WritingView({ writing, html }: { writing: Writing; html: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const code = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (code.current) code.current.scrollTop = code.current.scrollHeight;
  }, [writing.text]);
  const lines = (html ?? writing.text).split('\n').length;
  const seconds = Math.max(0, Math.round((now - writing.started) / 1000));
  return (
    <div className="build-writing" aria-live="polite">
      <div className="build-writing-head">
        <Loader2 size={16} className="spin" aria-hidden="true" />
        <strong>{writing.text ? 'Writing your app' : 'Thinking it through'}</strong>
        <span className="faint">{writing.text ? `${lines} lines` : ''} · {seconds}s</span>
      </div>
      <pre ref={code} className="build-code build-code-live"><code>{(html ?? writing.text).slice(-6000)}</code></pre>
    </div>
  );
}
