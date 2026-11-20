'use client';

// The landing story, told in six steps. The mascot leans over a receipt printer. Scrolling moves you to the next step;
// each step prints its own section of the receipt, one line after another, and highlights it; the paper is pushed
// down out of the slot, so the newest section sits under it and older ones run off the bottom. On the left, the copy
// explains every line of that section in plain words, and a guide line runs from the notes to the receipt (from one
// note to its own line when you point at it). A step bar shows where you are and lets you jump. The mascot
// holds one photographed pose per step and nods along while it prints. On phones, and for anyone who asks for
// reduced motion, the whole receipt is printed and the steps read as a list.

import Link from 'next/link';
import { ContractAddressChip } from '../contract-address';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

type Row =
  | { kind: 'pair'; label: string; value: string; stamp?: string; tone?: 'amber' }
  | { kind: 'section'; text: string }
  | { kind: 'center'; text: string; big?: boolean }
  | { kind: 'rule' }
  | { kind: 'logo' };

/** Each stage is one beat of the story: a numbered section of the receipt and the sentence that explains it. The
 *  section heading on the paper matches the step's name in the step bar ("1 · Pay"). */
const STAGES: { rows: Row[]; short?: string; title?: string; body?: string; notes?: [string, string][] }[] = [
  {
    rows: [
      { kind: 'logo' },
      { kind: 'center', text: 'ANONYMO', big: true },
      { kind: 'center', text: 'Receipt no. 000417 · 21:04' },
      { kind: 'section', text: 'Your account' },
      { kind: 'pair', label: 'Email', value: 'none' },
      { kind: 'pair', label: 'Name', value: 'none' },
      { kind: 'pair', label: 'Login', value: 'just a key' },
    ],
  },
  {
    short: 'Pay',
    title: 'Top up a few dollars.',
    body: 'No card, no bank, no name. Add credit with crypto and spend it a message at a time.',
    notes: [
      ['Paid with', 'Stablecoins like USDG, on Base, Arbitrum, Robinhood Chain, Solana or Tron.'],
      ['Also accepted', 'Bitcoin and Lightning. Or the Anonymo coin, as credit you can spend but not withdraw.'],
      ['Leftover USDG', 'Unused stablecoin credit can go back to the wallet it came from.'],
    ],
    rows: [
      { kind: 'section', text: '1 · Pay' },
      { kind: 'pair', label: 'Paid with', value: 'USDG' },
      { kind: 'pair', label: 'Also accepted', value: 'Bitcoin, Lightning' },
      { kind: 'pair', label: 'Leftover USDG', value: 'yours to withdraw' },
    ],
  },
  {
    short: 'Privacy',
    title: 'Say what’s on your mind.',
    body: 'Nothing you type is kept. The receipt records what happened, never what was said.',
    notes: [
      ['Your message', 'Sent to the model, then gone. We don’t store it.'],
      ['The reply', 'Streamed back to you, and not stored either.'],
      ['We keep', 'Only this receipt: which model answered, what it cost, and a fingerprint of the exchange.'],
    ],
    rows: [
      { kind: 'section', text: '2 · Privacy' },
      { kind: 'pair', label: 'Your message', value: 'not stored' },
      { kind: 'pair', label: 'The reply', value: 'not stored' },
      { kind: 'pair', label: 'We keep', value: 'this receipt' },
    ],
  },
  {
    short: 'Refusals',
    title: 'If one model says no, we ask another.',
    body: 'Some models refuse ordinary adult requests. Anonymo notices, and quietly tries again somewhere else.',
    notes: [
      ['Model A', 'Refused a legal request. That attempt is refunded automatically.'],
      ['Model B', 'A model from a different family answers instead.'],
      ['You paid for', 'Only the answer you got. Never the refusal.'],
    ],
    rows: [
      { kind: 'section', text: '3 · Refusals' },
      { kind: 'pair', label: 'Model A', value: 'said no', stamp: 'REFUNDED' },
      { kind: 'pair', label: 'Model B', value: 'answered' },
      { kind: 'pair', label: 'You paid for', value: 'the answer', tone: 'amber' },
    ],
  },
  {
    short: 'Models',
    title: 'Pick a model by name.',
    body: 'In the chat or in any app. Two are live now, two more are on the way.',
    notes: [
      ['anonymo-1', 'The everyday choice. The best low-refusal model for each request, roleplay included.'],
      ['anonymo-council', 'Two or three AIs answer and check each other, then merge one reply. Slower, costs more.'],
      ['anonymo-rp', 'Coming soon: cheaper long stories, on hardware we run ourselves.'],
      ['anonymo-sealed', 'Coming soon: runs only on locked, verified hardware, and proves it on the receipt.'],
    ],
    rows: [
      { kind: 'section', text: '4 · Models' },
      { kind: 'pair', label: 'anonymo-1', value: 'everyday chat' },
      { kind: 'pair', label: 'anonymo-council', value: 'AIs double-check' },
      { kind: 'pair', label: 'anonymo-rp', value: 'coming soon' },
      { kind: 'pair', label: 'anonymo-sealed', value: 'coming soon' },
    ],
  },
  {
    short: 'Apps',
    title: 'Bring the apps you already use.',
    body: 'Anonymo speaks the same language as OpenAI, so most chat apps just work.',
    notes: [
      ['SillyTavern, JanitorAI, Open WebUI', 'Paste the Anonymo address and your key into the app’s API settings. Ready-made settings are on the Presets page.'],
      ['Character cards', 'Import the character cards you already have.'],
    ],
    rows: [
      { kind: 'section', text: '5 · Apps' },
      { kind: 'pair', label: 'SillyTavern', value: 'works' },
      { kind: 'pair', label: 'JanitorAI', value: 'works' },
      { kind: 'pair', label: 'Open WebUI', value: 'works' },
      { kind: 'pair', label: 'Character cards', value: 'import' },
    ],
  },
  {
    short: 'Proof',
    title: 'Proof, not promises.',
    body: 'You don’t have to take our word for any of this.',
    notes: [
      ['Signature', 'Every receipt is signed, so it can’t be changed after the fact.'],
      ['Checked on-chain', 'Each hour, all receipts are rolled into one fingerprint and posted on-chain. Anyone can check theirs is in it.'],
    ],
    rows: [
      { kind: 'section', text: '6 · Proof' },
      { kind: 'pair', label: 'Signature', value: '7e4b9c2a…' },
      { kind: 'pair', label: 'Checked on-chain', value: 'every hour' },
      { kind: 'rule' },
      { kind: 'center', text: 'Thank you. Sleep well.' },
    ],
  },
];

const ROWS = STAGES.flatMap((s, stage) => s.rows.map((row) => ({ row, stage })));
/** The receipt length once each stage has printed. */
const STAGE_END = STAGES.map((_, i) => STAGES.slice(0, i + 1).reduce((n, s) => n + s.rows.length, 0));
const FIRST = STAGE_END[0];
const STEPS = STAGES.length - 1;
/** One line prints every PRINT_MS while a step is printing. */
const PRINT_MS = 260;

/** Mascot pose at rest in each stage (1 calm, 2 and 3 tilts, 5 happy, 6 delighted). */
const REST_POSE = [1, 2, 3, 5, 1, 2, 6];

/** The hero holds for half a slice of scroll, then each step gets one slice. */
const HERO_SLICE = 0.6;
const SLICES = STEPS + HERO_SLICE;

/** The story runs live only on wide screens that allow motion; this matches the media query in globals.css. */
const LIVE_QUERY = '(min-width: 900px) and (prefers-reduced-motion: no-preference)';
function subscribeLive(onChange: () => void) {
  const mq = window.matchMedia(LIVE_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
const isLive = () => window.matchMedia(LIVE_QUERY).matches;

/** Scroll range of the pinned story, and the page offset where it starts. */
function measure(section: HTMLElement) {
  const stage = section.querySelector<HTMLElement>('.story-stage');
  const top = section.getBoundingClientRect().top + window.scrollY;
  return { top, range: Math.max(1, section.offsetHeight - (stage?.offsetHeight ?? window.innerHeight)) };
}

export function ReceiptStory() {
  const section = useRef<HTMLElement>(null);
  const paper = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const printer = useRef<HTMLDivElement>(null);
  const live = useSyncExternalStore(subscribeLive, isLive, () => false);
  const [stage, setStage] = useState(0);
  const [shown, setShown] = useState(FIRST);
  const [hot, setHot] = useState<string | null>(null);
  const wire = useRef<SVGSVGElement>(null);

  // The receipt feeds out of the slot on first view (CSS). When the slot starts below the fold (phones), hold the paper
  // inside it until the slot scrolls into view, so the feed is seen rather than played off-screen.
  useEffect(() => {
    const el = printer.current;
    const slot = el?.querySelector('.printer-slot');
    if (!el || !slot || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // The observer's first report says where the slot is now: in view, the CSS feed is already playing; out of view,
    // the paper goes back into the slot (off-screen, so nothing visibly jumps) until the slot is scrolled to.
    let first = true;
    const io = new IntersectionObserver(
      ([e]) => {
        if (first) {
          first = false;
          if (e.isIntersecting) return io.disconnect();
          el.dataset.feed = 'wait';
          return;
        }
        if (!e.isIntersecting) return;
        el.dataset.feed = 'go';
        io.disconnect();
      },
      { rootMargin: '0px 0px -12% 0px' },
    );
    io.observe(slot);
    return () => io.disconnect();
  }, []);

  // Which step the scroll is on.
  useEffect(() => {
    if (!live) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const el = section.current;
      if (!el) return;
      const { top, range } = measure(el);
      const at = ((window.scrollY - top) / range) * SLICES - HERO_SLICE;
      setStage(at < 0 ? 0 : Math.min(STEPS, Math.floor(at) + 1));
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(read);
    };
    read();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [live]);

  // Print the step's lines one at a time; going back a step takes its lines off at once.
  const target = STAGE_END[stage];
  useEffect(() => {
    if (!live || shown === target) return;
    const timer = window.setTimeout(() => setShown((n) => (n < target ? n + 1 : target)), shown < target ? PRINT_MS : 0);
    return () => window.clearTimeout(timer);
  }, [live, shown, target]);

  // New lines push the paper down out of the slot, as a printer feeds it: the newest step sits right under the slot and
  // older steps move down and run off the bottom. The layout jumps at once, so each feed is played back from where the
  // paper was (the paper rides down while the step being printed holds still). Animations add up, so a line that
  // prints before the last feed has finished carries on smoothly.
  const fed = useRef({ shown: 0, height: 0 });
  useLayoutEffect(() => {
    const pap = paper.current;
    if (!pap) return;
    const height = pap.offsetHeight;
    const before = fed.current;
    fed.current = { shown, height };
    const delta = height - before.height;
    if (!live || shown <= before.shown || !before.height || delta <= 0) return;
    const block = pap.querySelectorAll('.rx-row')[shown - 1]?.closest('.rx-block');
    if (!block) return;
    const timing = { duration: 460, easing: 'cubic-bezier(0.3, 0.7, 0.3, 1)', composite: 'add' as const };
    pap.animate([{ transform: `translateY(${-delta}px)` }, { transform: 'translateY(0)' }], timing);
    block.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], timing);
  }, [live, shown]);

  // Pointing at a note marks its line on the receipt and moves the guide line to it.
  useEffect(() => {
    const el = section.current;
    if (!live || !el) return;
    const over = (e: PointerEvent) => {
      const note = (e.target as Element | null)?.closest<HTMLElement>('.story-beat[data-on="true"] [data-note]');
      setHot(note?.dataset.note ?? null);
    };
    const leave = () => setHot(null);
    el.addEventListener('pointerover', over);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointerover', over);
      el.removeEventListener('pointerleave', leave);
    };
  }, [live]);

  // The guide line: from the note you are reading (or the step's notes) to its lines on the receipt. Drawn once the
  // paper has settled, and redrawn on resize.
  useEffect(() => {
    const svg = wire.current;
    const stageEl = section.current?.querySelector<HTMLElement>('.story-stage');
    if (!svg || !stageEl) return;
    const hide = () => svg.setAttribute('data-on', 'false');
    if (!live || stage === 0 || shown < target) {
      hide();
      return;
    }
    const draw = () => {
      const box = stageEl.getBoundingClientRect();
      const beat = stageEl.querySelector<HTMLElement>('.story-beat[data-on="true"]');
      const hotRows = [...stageEl.querySelectorAll<HTMLElement>('.rx-hot')];
      const note = hot && hotRows.length ? beat?.querySelector<HTMLElement>(`[data-note="${CSS.escape(hot)}"]`) : null;
      const from = note ?? beat?.querySelector<HTMLElement>('.story-notes');
      const to = note ? hotRows : [...stageEl.querySelectorAll<HTMLElement>('.rx-now')];
      const win = windowRef.current?.getBoundingClientRect();
      if (!from || !to.length || !win) return hide();
      const a = from.getBoundingClientRect();
      const top = Math.max(win.top, to[0].getBoundingClientRect().top);
      const bottom = Math.min(win.bottom, to[to.length - 1].getBoundingClientRect().bottom);
      const ax = a.right + 14 - box.left;
      const ay = (note ? a.top + 22 : a.top + a.height / 2) - box.top;
      const bx = win.left - 4 - box.left;
      const by = (top + bottom) / 2 - box.top;
      const mid = (ax + bx) / 2;
      svg.querySelector('path')?.setAttribute('d', `M${ax} ${ay}C${mid} ${ay} ${mid} ${by} ${bx} ${by}`);
      const [c1, c2] = svg.querySelectorAll('circle');
      c1?.setAttribute('cx', `${ax}`);
      c1?.setAttribute('cy', `${ay}`);
      c2?.setAttribute('cx', `${bx}`);
      c2?.setAttribute('cy', `${by}`);
      svg.setAttribute('data-on', 'true');
    };
    const timer = window.setTimeout(draw, 560);
    window.addEventListener('resize', draw);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', draw);
    };
  }, [live, stage, shown, target, hot]);

  const printing = live && shown < target;
  // While a step prints, the mascot nods along to its headphones, one tilt per line.
  const pose = printing ? (shown % 2 ? 2 : 3) : REST_POSE[live ? stage : 0];
  const goTo = (step: number) => {
    const el = section.current;
    if (!el) return;
    const { top, range } = measure(el);
    window.scrollTo({ top: top + (range * (step === 0 ? 0 : HERO_SLICE + step - 0.6)) / SLICES, behavior: 'smooth' });
  };

  return (
    <section ref={section} className={live ? 'story story-live' : 'story'} aria-label="How Anonymo works">
      <span
        id="how"
        className="story-anchor"
        aria-hidden="true"
        style={{ top: `calc((100% - var(--stage-h)) * ${(HERO_SLICE + 0.4) / SLICES})` }}
      />
      <div className="story-stage">
        <div className="story-copy">
          <div className="story-beat story-hero" data-on={stage === 0}>
            <h1>
              Ask anything.
              <br />
              Keep the receipt.
            </h1>
            <p className="story-lede">
              Private AI chat for adults. No account, no email. Just a key, and a receipt for every answer that shows what
              happened, never what you said.
            </p>
            <div className="story-ca">
              <ContractAddressChip className="ca-chip-hero" full />
            </div>
            <div className="story-actions">
              <Link className="btn btn-primary btn-lg btn-square" href="/dashboard/chat">
                Start chatting
              </Link>
              <button type="button" className="story-link" onClick={() => goTo(1)}>
                See how it works
              </button>
            </div>
            <p className="story-cue">
              <span className="story-cue-arrow" aria-hidden="true">
                ↓
              </span>
              Scroll, and the receipt prints how it works, one step at a time.
            </p>
          </div>
          {STAGES.slice(1).map((s, i) => (
            <div className="story-beat" key={s.title} data-on={stage === i + 1}>
              <p className="story-step">
                Step {i + 1} of {STEPS}
              </p>
              <h2>{s.title}</h2>
              <p>{s.body}</p>
              <p className="story-printed">
                Line by line: “{i + 1} · {s.short}” on the receipt <span aria-hidden="true">→</span>
              </p>
              <dl className="story-notes">
                {s.notes?.map(([label, text]) => (
                  <div key={label} data-note={label} data-hot={hot === label}>
                    <dt>{label}</dt>
                    <dd>{text}</dd>
                  </div>
                ))}
              </dl>
              {i === STEPS - 1 && (
                <div className="story-actions">
                  <Link className="btn btn-primary btn-lg btn-square" href="/dashboard/key">
                    Get a key
                  </Link>
                  <Link className="story-link" href="/docs">
                    Read the docs
                  </Link>
                </div>
              )}
            </div>
          ))}
          <ol className="story-steps" aria-label="Steps">
            {STAGES.slice(1).map((s, i) => (
              <li key={s.short} data-state={stage === i + 1 ? 'now' : stage > i + 1 ? 'done' : 'next'}>
                <button type="button" onClick={() => goTo(i + 1)} aria-current={stage === i + 1 ? 'step' : undefined}>
                  <span>{i + 1}</span>
                  {s.short}
                </button>
              </li>
            ))}
          </ol>
        </div>

        <svg ref={wire} className="story-wire" aria-hidden="true" data-on="false">
          <path d="" />
          <circle r="4" />
          <circle r="4" />
        </svg>

        <div className="printer" ref={printer} aria-hidden="true">
          <div className="printer-mascot">
            {[1, 2, 3, 5, 6].map((n) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={n}
                src={`/mascot/peek-${n}.jpg`}
                alt=""
                width={520}
                height={470}
                decoding="async"
                fetchPriority={n === 1 ? 'high' : 'low'}
                data-on={pose === n}
              />
            ))}
          </div>
          <div className="printer-slot" />
          <div className="paper-window" ref={windowRef}>
            <div className="paper" ref={paper}>
              {/* One block per step. On the live story the blocks stack newest first (globals.css), so each step comes
                  out of the slot above the ones before it; elsewhere the receipt reads top to bottom. */}
              {STAGES.map((s, si) => (
                <div className="rx-block" key={si}>
                  {s.rows.map((row, j) => {
                    const i = STAGE_END[si] - s.rows.length + j;
                    return (
                      <ReceiptRow
                        key={i}
                        row={row}
                        on={i < shown}
                        state={si === stage && stage > 0 ? 'now' : si < stage ? 'old' : undefined}
                        hot={!!hot && row.kind === 'pair' && si === stage && hot.split(', ').includes(row.label)}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      {/* A screen-reader copy of the receipt, since the printed one is decorative. */}
      <ul className="sr-only">
        {ROWS.map(({ row }, i) =>
          row.kind === 'pair' ? <li key={i}>{`${row.label}: ${row.value}${row.stamp ? ` (${row.stamp})` : ''}`}</li> : null,
        )}
      </ul>
    </section>
  );
}

function ReceiptRow({ row, on, state, hot }: { row: Row; on: boolean; state?: 'now' | 'old'; hot?: boolean }) {
  const cls = `rx-row rx-${row.kind}${on ? ' on' : ''}${state ? ` rx-${state}` : ''}${hot ? ' rx-hot' : ''}`;
  if (row.kind === 'logo')
    return (
      <div className={cls}>
        <svg viewBox="0 0 48 24" width="64" height="32">
          <path
            d="M4 12C4 5.5 11 3.5 24 6.5 37 3.5 44 5.5 44 12s-7 8.5-20 5.5C11 20.5 4 18.5 4 12Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeDasharray="1.6 1.4"
          />
          <path d="M10.5 11.5q4.5 3.6 9 0M28.5 11.5q4.5 3.6 9 0" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </div>
    );
  if (row.kind === 'rule') return <div className={cls} />;
  if (row.kind === 'section') return <div className={cls}>{row.text}</div>;
  if (row.kind === 'center') return <div className={`${cls}${row.big ? ' rx-big' : ''}`}>{row.text}</div>;
  return (
    <div className={`${cls}${row.tone === 'amber' ? ' rx-amber' : ''}`}>
      <span>{row.label}</span>
      <i />
      <span>{row.value}</span>
      {row.stamp && <b className="rx-stamp">{row.stamp}</b>}
    </div>
  );
}
