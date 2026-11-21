'use client';

// One answer in the thread, kept from Conclave's answer card: a model tab bar, the answer body, and a footer with what
// it cost and where it ran. For anonymo-council the Council view lays out every seat (proposers and the aggregator or
// judge) side by side with its route, status and cost. The gateway returns only the final reply's text.

import Link from 'next/link';
import { Columns3, ReceiptText } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import { CopyButton } from '../copy-button';
import { formatUsdAmount } from '@/lib/anonymo/money';
import { VoiceReply } from './chat-voice';
import type { Turn } from './chat-types';
import { MemoryCost } from './memory-cost';

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
  const refusedRoutes = r?.routes.filter((x) => x.status === 'refused') ?? [];
  return (
    <div className="answer-foot">
      {turn.status === 'done' && <CopyButton text={turn.content} />}
      <VoiceReply turn={turn} />
      <PrivacyChip turn={turn} />
      {r && refusedRoutes.length > 0 && !r.refused && (
        <span className="chip chip-amber" title={`Refused on ${refusedRoutes.map((x) => x.route).join(', ')}`}>
          Refusal rerouted · refused attempt billed $0
        </span>
      )}
      {r?.refused && <span className="chip chip-amber">Refused twice · billed $0</span>}
      {r && <span className="mono">{formatUsdAmount(r.cost)}</span>}
      {turn.memoryCharge && <MemoryCost charge={turn.memoryCharge} />}
      {r && (
        <span className="faint">
          {r.tokens.in.toLocaleString()} in · {r.tokens.out.toLocaleString()} out
        </span>
      )}
      {turn.receiptId && (
        <Link href={`/dashboard/receipts/${encodeURIComponent(turn.receiptId)}`}>
          <ReceiptText size={15} aria-hidden="true" style={{ verticalAlign: '-3px', marginRight: 5 }} />
          Signed receipt
        </Link>
      )}
    </div>
  );
}

const SEAT_STATUS: Record<string, string> = { ok: 'answered', refused: 'refused · billed $0', late: 'late · not used, billed $0', failed: 'failed · billed $0' };

function Seat({ title, seat }: { title: string; seat: { model: string; provider: string | null; status: string; cost: string; receipt_id: string | null; family?: string } }) {
  return (
    <section className="answer" aria-label={title}>
      <div className="answer-head">
        <span>{title}</span>
        <span className="mono">{formatUsdAmount(seat.cost)}</span>
      </div>
      <dl className="kv">
        {seat.family && (
          <div>
            <dt>Family</dt>
            <dd>{seat.family}</dd>
          </div>
        )}
        <div>
          <dt>Route</dt>
          <dd className="mono">{seat.provider ? `${seat.provider}:${seat.model}` : seat.model}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{seat.status === 'ok' ? <span className="chip chip-signal">answered</span> : <span className="chip chip-amber">{SEAT_STATUS[seat.status] ?? seat.status}</span>}</dd>
        </div>
      </dl>
    </section>
  );
}

export function AnswerCard({ turn }: { turn: Turn }) {
  const council = turn.council;
  const [comparing, setComparing] = useState(false);
  const streaming = turn.status === 'streaming';
  const lead = council?.aggregator ?? council?.judge ?? null;

  let body: ReactNode;
  if (turn.status === 'error')
    body = (
      <div className="notice notice-rose notice-action">
        <p>{turn.error}</p>
        {turn.needsFunds && (
          <Link className="btn btn-small btn-primary" href="/dashboard/funds">
            Add funds
          </Link>
        )}
      </div>
    );
  else if (council && comparing)
    body = (
      <div className="answer answer-compare">
        <p className="faint">
          {council.proposers.length} proposers from {new Set(council.proposers.map((p) => p.family)).size} model families answered;{' '}
          {council.mode === 'select'
            ? `a judge picked ${council.selected ?? 'one reply'}${council.outcome === 'invalid_verdict' ? ' (no valid verdict, so proposer A was used)' : ''}.`
            : council.outcome === 'aggregator_refused'
              ? 'the aggregator refused, so proposer A’s reply was used.'
              : 'an aggregator merged them.'}{' '}
          Proposer text is not kept or returned; each seat’s route, status and cost are below and on the receipt.
        </p>
        <div className="compare-grid">
          {council.proposers.map((p) => (
            <Seat key={p.label} title={`Proposer ${p.label}${council.selected === p.label ? ' · picked' : ''}`} seat={p} />
          ))}
        </div>
        {lead && <Seat title={council.mode === 'select' ? 'Judge' : 'Aggregator'} seat={lead} />}
        <p className="faint">
          Council premium {formatUsdAmount(council.premium)} · total {formatUsdAmount(council.total_cost)}
        </p>
      </div>
    );
  else
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
        <button type="button" role="tab" className="tab" aria-selected={!comparing} onClick={() => setComparing(false)}>
          {council ? (council.mode === 'select' ? `Selected${council.selected ? ` · ${council.selected}` : ''}` : 'Merged') : turn.model}
        </button>
        <span className="spacer" />
        {council && (
          <button type="button" className="btn btn-small btn-ghost compare" aria-pressed={comparing} onClick={() => setComparing((c) => !c)}>
            <Columns3 size={14} aria-hidden="true" />
            {comparing ? 'Answer' : 'Council'}
          </button>
        )}
      </div>
      {body}
      {turn.status === 'stopped' && <p className="faint">Stopped. You are charged only for the text that arrived.</p>}
      {turn.status !== 'streaming' && turn.status !== 'error' && <Footer turn={turn} />}
    </div>
  );
}
