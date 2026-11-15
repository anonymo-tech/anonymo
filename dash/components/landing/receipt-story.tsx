'use client';

// The landing story, told in six steps. The mascot leans over a receipt printer. Scrolling moves you to the next step;
// each step prints its own few lines onto the receipt, one after another, highlights them, and the copy on the left
// says in plain words what they mean and names them. A step bar shows where you are and lets you jump. The mascot
// holds one photographed pose per step and pulls the paper while it prints. On phones, and for anyone who asks for
// reduced motion, the whole receipt is printed and the steps read as a list.

import Link from 'next/link';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

type Row =
  | { kind: 'pair'; label: string; value: string; stamp?: string; tone?: 'amber' }
  | { kind: 'center'; text: string; big?: boolean }
  | { kind: 'rule' }
  | { kind: 'logo' };

/** Each stage is one beat of the story: the receipt lines it prints and the sentence that explains them. */
const STAGES: { rows: Row[]; short?: string; title?: string; body?: string; printed?: string }[] = [
  {
    rows: [
      { kind: 'logo' },
      { kind: 'center', text: 'ANONYMO', big: true },
      { kind: 'center', text: 'RECEIPT NO. 000417' },
      { kind: 'center', text: '21:04:17' },
      { kind: 'rule' },
      { kind: 'pair', label: 'KEY ISSUED', value: 'no email' },
      { kind: 'pair', label: 'NAME ON FILE', value: 'none' },
    ],
  },
  {
    short: 'Pay',
    printed: 'Top-up · Also takes · Unused USDG',
    title: 'Top up a few dollars.',
    body: 'Pay with stablecoins such as USDG, with Bitcoin or with Lightning. No card, no bank, no name. Unused stablecoin credit can go back to the wallet it came from.',
    rows: [
      { kind: 'pair', label: 'TOP-UP', value: 'USDG' },
      { kind: 'pair', label: 'ALSO TAKES', value: 'BTC · LIGHTNING' },
      { kind: 'pair', label: 'UNUSED USDG', value: 'withdrawable' },
    ],
  },
  {
    short: 'Privacy',
    printed: 'Your message · The reply',
    title: 'Say what’s on your mind.',
    body: 'Your messages and the replies are never stored. We keep the receipt, not the conversation.',
    rows: [
      { kind: 'pair', label: 'YOUR MESSAGE', value: 'NOT STORED' },
      { kind: 'pair', label: 'THE REPLY', value: 'NOT STORED' },
    ],
  },
  {
    short: 'Refusals',
    printed: 'Model A · Model B · Charged for',
    title: 'If one model says no, we ask another.',
    body: 'When a model refuses a legal request, Anonymo quietly tries a different one. You only pay for the answer.',
    rows: [
      { kind: 'pair', label: 'MODEL A', value: 'said no', stamp: 'REFUNDED' },
      { kind: 'pair', label: 'MODEL B', value: 'answered' },
      { kind: 'pair', label: 'CHARGED FOR', value: 'the answer', tone: 'amber' },
    ],
  },
  {
    short: 'Models',
    printed: 'anonymo-1 · anonymo-rp · anonymo-council · anonymo-sealed',
    title: 'Four ways to ask.',
    body: 'Everyday answers. Long roleplay with your own characters. A council of AIs that check each other. And a sealed option that runs on locked hardware and proves it.',
    rows: [
      { kind: 'center', text: '— THE MENU —' },
      { kind: 'pair', label: 'ANONYMO-1', value: 'everyday' },
      { kind: 'pair', label: 'ANONYMO-RP', value: 'roleplay' },
      { kind: 'pair', label: 'ANONYMO-COUNCIL', value: 'cross-checked' },
      { kind: 'pair', label: 'ANONYMO-SEALED', value: 'locked chips' },
    ],
  },
  {
    short: 'Apps',
    printed: 'Works with · Character cards',
    title: 'Bring the apps you already use.',
    body: 'Paste your key into SillyTavern, JanitorAI, Open WebUI or any app that works with OpenAI. Your character cards come with you.',
    rows: [
      { kind: 'pair', label: 'WORKS WITH', value: 'OpenAI apps' },
      { kind: 'center', text: 'SILLYTAVERN · JANITORAI · OPEN WEBUI' },
      { kind: 'pair', label: 'CHARACTER CARDS', value: 'import' },
    ],
  },
  {
    short: 'Proof',
    printed: 'Signed · Posted',
    title: 'Proof, not promises.',
    body: 'Every receipt is signed. Each hour, the receipts are rolled into one fingerprint and posted on-chain, so anyone can check them.',
    rows: [
      { kind: 'rule' },
      { kind: 'pair', label: 'SIGNED', value: '7e4b9c2a…' },
      { kind: 'pair', label: 'POSTED', value: 'hourly, on-chain' },
      { kind: 'rule' },
      { kind: 'center', text: 'THANK YOU. SLEEP WELL.' },
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

/** Mascot pose at rest in each stage (1 calm, 2 and 3 tilts, 4 pulling the paper, 5 happy, 6 delighted). */
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
  const live = useSyncExternalStore(subscribeLive, isLive, () => false);
  const [stage, setStage] = useState(0);
  const [shown, setShown] = useState(FIRST);

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

  // Feed the paper up behind the slot so the newest line is always in view (and the torn edge once it is finished).
  useEffect(() => {
    const win = windowRef.current;
    const pap = paper.current;
    if (!win || !pap) return;
    if (!live) {
      pap.style.transform = '';
      return;
    }
    const rows = pap.querySelectorAll<HTMLElement>('.rx-row');
    const last = rows[Math.max(0, shown - 1)];
    const bottom = shown >= ROWS.length ? pap.offsetHeight + 8 : last ? last.offsetTop + last.offsetHeight + 36 : 0;
    pap.style.transform = `translateY(${-Math.max(0, bottom - win.clientHeight)}px)`;
  }, [live, shown]);

  const printing = live && shown < target;
  const pose = printing ? 4 : REST_POSE[live ? stage : 0];
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
                <span aria-hidden="true">→</span> Just printed: {s.printed}
              </p>
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

        <div className="printer" aria-hidden="true">
          <div className="printer-mascot">
            {[1, 2, 3, 4, 5, 6].map((n) => (
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
              {ROWS.map(({ row, stage: rowStage }, i) => (
                <ReceiptRow
                  key={i}
                  row={row}
                  on={i < shown}
                  state={rowStage === stage && stage > 0 ? 'now' : rowStage < stage ? 'old' : undefined}
                />
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

function ReceiptRow({ row, on, state }: { row: Row; on: boolean; state?: 'now' | 'old' }) {
  const cls = `rx-row rx-${row.kind}${on ? ' on' : ''}${state ? ` rx-${state}` : ''}`;
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
