'use client';

// The landing story: the mascot leans over a receipt printer, and as you scroll the receipt prints line by line, each
// line one thing Anonymo does, while the copy on the left explains it in plain words. It moves like stop-motion: the
// printer feeds one line per tick at about eight ticks a second and the mascot swaps between a handful of photographed
// poses. On phones, and for anyone who asks for reduced motion, the whole receipt is printed and the story is a list.

import Link from 'next/link';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

type Row =
  | { kind: 'pair'; label: string; value: string; stamp?: string; tone?: 'amber' }
  | { kind: 'center'; text: string; big?: boolean }
  | { kind: 'rule' }
  | { kind: 'logo' };

/** Each stage is one beat of the story: the receipt lines it prints and the sentence that explains them. */
const STAGES: { rows: Row[]; title?: string; body?: string }[] = [
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
    title: 'Top up a few dollars.',
    body: 'Pay with stablecoins such as USDG, with Bitcoin or with Lightning. No card, no bank, no name. Unused stablecoin credit can go back to the wallet it came from.',
    rows: [
      { kind: 'pair', label: 'TOP-UP', value: 'USDG' },
      { kind: 'pair', label: 'ALSO TAKES', value: 'BTC · LIGHTNING' },
      { kind: 'pair', label: 'UNUSED USDG', value: 'withdrawable' },
    ],
  },
  {
    title: 'Say what’s on your mind.',
    body: 'Your messages and the replies are never stored. We keep the receipt, not the conversation.',
    rows: [
      { kind: 'pair', label: 'YOUR MESSAGE', value: 'NOT STORED' },
      { kind: 'pair', label: 'THE REPLY', value: 'NOT STORED' },
    ],
  },
  {
    title: 'If one model says no, we ask another.',
    body: 'When a model refuses a legal request, Anonymo quietly tries a different one. You only pay for the answer.',
    rows: [
      { kind: 'pair', label: 'MODEL A', value: 'said no', stamp: 'REFUNDED' },
      { kind: 'pair', label: 'MODEL B', value: 'answered' },
      { kind: 'pair', label: 'CHARGED FOR', value: 'the answer', tone: 'amber' },
    ],
  },
  {
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
    title: 'Bring the apps you already use.',
    body: 'Paste your key into SillyTavern, JanitorAI, Open WebUI or any app that works with OpenAI. Your character cards come with you.',
    rows: [
      { kind: 'pair', label: 'WORKS WITH', value: 'OpenAI apps' },
      { kind: 'center', text: 'SILLYTAVERN · JANITORAI · OPEN WEBUI' },
      { kind: 'pair', label: 'CHARACTER CARDS', value: 'import' },
    ],
  },
  {
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
/** Index of the first row after each stage: the receipt length once that stage has printed. */
const STAGE_END = STAGES.map((_, i) => STAGES.slice(0, i + 1).reduce((n, s) => n + s.rows.length, 0));
const FIRST = STAGE_END[0];
const TICK_MS = 120;

/** Mascot pose at rest in each stage (1 calm, 2 and 3 tilts, 4 tugging, 5 happy, 6 delighted). */
const REST_POSE = [1, 2, 3, 5, 1, 2, 6];

/** The hero holds for half a slice of scroll, then each later stage gets one slice. Keep in step with globals.css. */
const HERO_SLICE = 0.5;
const SLICES = STAGES.length - 1 + HERO_SLICE;

/** How many rows should be printed at scroll progress p (0..1): each stage prints its rows over the first two thirds
 *  of its slice and then holds. */
function targetRows(p: number) {
  const n = STAGES.length - 1;
  const at = p * SLICES - HERO_SLICE; // below 0 is the hero
  if (at < 0) return FIRST;
  const stage = Math.min(n, Math.floor(at) + 1);
  if (at >= n) return ROWS.length;
  const local = Math.min(1, (at - Math.floor(at)) / 0.66);
  const from = STAGE_END[stage - 1];
  return from + Math.round(local * (STAGE_END[stage] - from));
}

function stageOf(rows: number) {
  const i = STAGE_END.findIndex((end) => rows <= end);
  return i === -1 ? STAGES.length - 1 : i;
}

/** The story runs live only on wide screens that allow motion; this matches the media query in globals.css. */
const LIVE_QUERY = '(min-width: 900px) and (prefers-reduced-motion: no-preference)';
function subscribeLive(onChange: () => void) {
  const mq = window.matchMedia(LIVE_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
const isLive = () => window.matchMedia(LIVE_QUERY).matches;

export function ReceiptStory() {
  const section = useRef<HTMLElement>(null);
  const paper = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const live = useSyncExternalStore(subscribeLive, isLive, () => false);
  const [shown, setShown] = useState(FIRST);
  const [pose, setPose] = useState(1);
  const [feed, setFeed] = useState(0);

  // The stop-motion clock: on each tick, move the printed length one row toward where the scroll says it should be.
  useEffect(() => {
    // Off the live layout the CSS prints the whole receipt, so the clock has nothing to do.
    if (!live) return;
    let current = FIRST;
    let tug = false;
    let idle = 0;
    const progress = () => {
      const el = section.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const stage = el.querySelector<HTMLElement>('.story-stage');
      const range = rect.height - (stage?.offsetHeight ?? window.innerHeight);
      return range > 0 ? Math.min(1, Math.max(0, -rect.top / range)) : 0;
    };
    const tick = () => {
      const target = targetRows(progress());
      if (target !== current) {
        const gap = target - current;
        current += Math.sign(gap) * (Math.abs(gap) > 4 ? 2 : 1);
        tug = !tug;
        idle = 0;
        setShown(current);
        setPose(tug ? 4 : REST_POSE[stageOf(current)]);
      } else {
        idle += 1;
        const rest = REST_POSE[stageOf(current)];
        // At rest, a small sway every couple of seconds so it never looks frozen.
        const sway = idle % 18 === 9 ? (rest === 2 ? 3 : 2) : rest;
        setPose(sway);
      }
      // Feed the paper up behind the slot once it is longer than the space below the printer.
      const win = windowRef.current, pap = paper.current;
      if (win && pap) {
        const rowsEls = pap.querySelectorAll<HTMLElement>('.rx-row');
        const last = rowsEls[Math.max(0, current - 1)];
        // Once it is all printed, show the torn edge too.
        const bottom = current >= ROWS.length ? pap.offsetHeight + 8 : last ? last.offsetTop + last.offsetHeight + 28 : 0;
        setFeed(Math.max(0, bottom - win.clientHeight));
      }
    };
    const timer = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(timer);
  }, [live]);

  const stage = live ? stageOf(shown) : 0;

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
          <div className="story-beat story-hero" data-on={stage === 0 || !live}>
            <p className="story-kicker">
              <span>No. 000417</span>
              <span aria-hidden="true">·</span>
              <span>21:04</span>
            </p>
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
              <a className="story-link" href="#how">
                See how it works
              </a>
            </div>
            <p className="story-note">
              <span aria-hidden="true">*</span> 18+ only. A few things stay blocked for everyone.
            </p>
          </div>
          {STAGES.slice(1).map((s, i) => (
            <div className="story-beat" key={s.title} data-on={!live || stage === i + 1}>
              <p className="story-step">
                <span>{String(i + 1).padStart(2, '0')}</span> / {String(STAGES.length - 1).padStart(2, '0')}
              </p>
              <h2>{s.title}</h2>
              <p>{s.body}</p>
              {i === STAGES.length - 2 && (
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
            <div className="paper" ref={paper} style={live ? { transform: `translateY(${-feed}px)` } : undefined}>
              {ROWS.map(({ row }, i) => (
                <ReceiptRow key={i} row={row} on={i < shown} />
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

function ReceiptRow({ row, on }: { row: Row; on: boolean }) {
  const cls = `rx-row rx-${row.kind}${on ? ' on' : ''}`;
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
