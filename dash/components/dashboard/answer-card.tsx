'use client';

// One answer in the thread, kept from Conclave's answer card: a model tab bar with Compare, the answer body, and a
// footer with what it cost and where it ran. For anonymo-council the tabs are the merged reply plus each proposer,
// and Compare lays the proposers side by side with the merged reply.

import Link from 'next/link';
import { Columns3 } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import { CopyButton } from '../copy-button';
import { formatUsd } from '@/lib/anonymo/money';
import type { Turn } from './chat-types';

/** Paragraphs and fenced code only; everything renders as text, never as HTML. */
export function AnswerText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks = text.split(/(```[\s\S]*?(?:```|$))/g).filter((b) => b.length > 0);
  const cursor = streaming ? <span className="cursor" aria-hidden="true" /> : null;
  if (blocks.length === 0) return <div className="answer-body"><p>{cursor}</p></div>;
  return (
    <div className="answer-body">
      {blocks.map((block, i) => {
        const last = i === blocks.length - 1;
        if (block.startsWith('```'))
          return (
            <pre key={i}>
              <code>{block.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')}</code>
              {last && cursor}
            </pre>
          );
        const paragraphs = block.split(/\n{2,}/).filter((p) => p.trim());
        return (
          <Fragment key={i}>
            {paragraphs.map((p, j) => (
              <p key={j}>
                {p}
                {last && j === paragraphs.length - 1 && cursor}
              </p>
            ))}
          </Fragment>
        );
      })}
    </div>
  );
}

function PrivacyChip({ turn }: { turn: Turn }) {
  // "Fully private" only for anonymo-sealed with its attestation; every other route is "zero retention" (§10).
  if (turn.model === 'anonymo-sealed' && turn.receipt?.attestation_quote_hash)
    return <span className="chip chip-signal">Fully private · attested enclave</span>;
  if (turn.model === 'anonymo-sealed') return <span className="chip">Sealed · waiting for attestation</span>;
  return <span className="chip" title="A policy, not a proof. Only anonymo-sealed is provable.">Zero retention</span>;
}

function Footer({ turn }: { turn: Turn }) {
  const r = turn.receipt;
  return (
    <div className="answer-foot">
      {turn.status === 'done' && <CopyButton text={turn.content} />}
      <PrivacyChip turn={turn} />
      {r?.refused && (
        <span className="chip chip-amber" title={`Refused on ${r.refused_routes.join(', ')}`}>
          Refusal rerouted · {formatUsd(r.refund_musd)} refunded
        </span>
      )}
      {r && <span className="mono">{formatUsd(r.cost_musd)}</span>}
      {r && (
        <span className="faint">
          {r.tokens.in.toLocaleString()} in · {r.tokens.out.toLocaleString()} out
        </span>
      )}
      {turn.receiptId && <Link href={`/dashboard/receipts/${encodeURIComponent(turn.receiptId)}`}>Receipt</Link>}
    </div>
  );
}

export function AnswerCard({ turn }: { turn: Turn }) {
  const council = turn.council;
  const [tab, setTab] = useState<number>(-1); // -1 = merged / main answer, n = proposer n
  const [comparing, setComparing] = useState(false);
  const streaming = turn.status === 'streaming';
  const label = (i: number) => `${String.fromCharCode(65 + i)} · ${council?.proposers[i]?.family ?? ''}`;

  let body: ReactNode;
  if (turn.status === 'error') body = <p className="notice notice-rose">{turn.error}</p>;
  else if (council && comparing)
    body = (
      <div className="answer answer-compare">
        <div className="compare-grid">
          {council.proposers.map((p, i) => (
            <section key={p.route_id} className="answer" aria-label={`Proposer ${label(i)}`}>
              <div className="answer-head">
                <span>{label(i)}</span>
                <span>{p.route_id}</span>
                {!p.used && <span className="chip">late, not used</span>}
                <span className="mono">{formatUsd(p.cost_musd)}</span>
              </div>
              <AnswerText text={p.content} />
            </section>
          ))}
        </div>
        <section className="merged answer" aria-label="Merged reply">
          <div className="answer-head">
            <span>{council.mode === 'select' ? 'Judge picked' : 'Merged reply'}</span>
            {council.aggregator && <span>{council.aggregator.route_id}</span>}
          </div>
          <AnswerText text={turn.content} />
        </section>
      </div>
    );
  else if (council && tab >= 0) {
    const p = council.proposers[tab];
    body = (
      <div className="answer">
        <div className="answer-head">
          <span>{p.route_id}</span>
          <span className="mono">{formatUsd(p.cost_musd)}</span>
        </div>
        <AnswerText text={p.content} />
      </div>
    );
  } else
    body = (
      <div className="answer">
        {turn.character && <div className="answer-head">{turn.character}</div>}
        {turn.content || streaming ? (
          <AnswerText text={turn.content} streaming={streaming} />
        ) : (
          <p className="muted">{turn.status === 'stopped' ? 'Stopped before any text arrived.' : ''}</p>
        )}
      </div>
    );

  return (
    <div className="answer">
      <div className="response-bar" role="tablist" aria-label="Answers">
        <button type="button" role="tab" className="tab" aria-selected={!comparing && tab === -1} onClick={() => { setTab(-1); setComparing(false); }}>
          {council ? (council.mode === 'select' ? 'Selected' : 'Merged') : turn.model}
        </button>
        {council?.proposers.map((p, i) => (
          <button key={p.route_id} type="button" role="tab" className="tab" aria-selected={!comparing && tab === i} onClick={() => { setTab(i); setComparing(false); }}>
            {label(i)}
          </button>
        ))}
        <span className="spacer" />
        {council && (
          <button type="button" className="btn btn-small btn-ghost compare" aria-pressed={comparing} onClick={() => setComparing((c) => !c)}>
            <Columns3 size={14} aria-hidden="true" />
            {comparing ? 'Focus' : 'Compare'}
          </button>
        )}
      </div>
      {body}
      {turn.status === 'stopped' && <p className="faint">Stopped. You are charged only for the text that arrived.</p>}
      {turn.status !== 'streaming' && turn.status !== 'error' && <Footer turn={turn} />}
    </div>
  );
}
