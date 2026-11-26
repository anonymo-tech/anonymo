'use client';

import { isAnonymoModel } from '@/lib/anonymo/chat-models';
import { autoClassOf, autoNote, autoTabLabel, isAutoModel } from '@/lib/anonymo/auto';
import { characterDestination, setupHref } from '@/lib/anonymo/setup-return';

// One answer in the thread, kept from Conclave's answer card: a model tab bar, the answer body, and a footer with what
// it cost and where it ran. For anonymo-council the Council view lays out every seat (proposers and the aggregator or
// judge) side by side with its route, status and cost. The gateway returns only the final reply's text.

import Link from 'next/link';
import { BookOpen, ChevronDown, Columns3, FileText, ReceiptText } from 'lucide-react';
import { Fragment, useId, useMemo, useState, type ReactNode } from 'react';
import { claimGaps, context, locate, parseCitations, statusLabel, type ProofSource, type ProofStatus } from '@/lib/anonymo/citations';
import { CopyButton } from '../copy-button';
import { formatUsdAmount } from '@/lib/anonymo/money';
import { VoiceReply } from './chat-voice';
import type { Turn } from './chat-types';
import { MemoryCost } from './memory-cost';
import { ModelLogo } from './model-picker';
import { WebSources } from './web-sources';

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

/** Update "auto": the model that answered an Auto turn, from the reply or else from its receipt. */
const answeredBy = (turn: Turn) => turn.answeredBy ?? turn.receipt?.routes.find((x) => x.status === 'ok')?.model ?? null;

function PrivacyChip({ turn }: { turn: Turn }) {
  // Update "auto": the model Auto picked answered, so the data policy of its provider applies.
  if (isAutoModel(turn.model)) return <span className="chip" title="The data policy of the provider that answered applies.">Auto</span>;
  if (!isAnonymoModel(turn.model)) return <span className="chip" title="The selected provider’s data policy applies.">Regular Chat</span>;
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

/** Feature 07: the local source behind a turn that sent a document or excerpt. `source` is null once it is gone. */
export type TurnProof = { source: ProofSource | null; onForget: () => void };

type Checked = { index: number; page: number; quote: string | null; claim: string; proof: ProofStatus; gaps: ('amount' | 'frequency')[] };

/** Answer text with each [p. N "quote"] as a numbered mark after its claim, checked against the local source. */
function CitedText({ text, streaming, checked, selected, onSelect }: { text: string; streaming: boolean; checked: Map<number, Checked>; selected: number | null; onSelect: (n: number | null) => void }) {
  const blocks = text.split(/(```[\s\S]*?(?:```|$))/g).filter((b) => b.length > 0);
  const cursor = streaming ? <span className="cursor" aria-hidden="true" /> : null;
  let n = 0;
  const paragraph = (p: string) => {
    const segments = parseCitations(p);
    return segments.map((seg, i) => {
      if (seg.kind === 'text') {
        const next = segments[i + 1];
        const claim = next?.kind === 'cite' ? next.claim : '';
        const at = claim ? seg.text.lastIndexOf(claim) : -1;
        if (at < 0 || !claim) return <Fragment key={i}>{seg.text}</Fragment>;
        return <Fragment key={i}>{seg.text.slice(0, at)}<span className={`claim${selected === n + 1 ? ' claim-on' : ''}`}>{claim}</span>{seg.text.slice(at + claim.length)}</Fragment>;
      }
      n += 1;
      const c = checked.get(n);
      const label = c ? statusLabel(c.proof, c.gaps) : 'Checking';
      const index = n;
      return (
        <sup key={i} className="cite">
          <button type="button" className={`cite-mark cite-${c?.proof.status ?? 'missing'}`} aria-expanded={selected === index} aria-label={`Source ${index}, page ${seg.page}: ${label}`} onClick={() => onSelect(selected === index ? null : index)}>
            {index}
          </button>
        </sup>
      );
    });
  };
  if (!blocks.length) return <div className="answer-body"><p>{cursor}</p></div>;
  return (
    <div className="answer-body">
      {blocks.map((block, i) => {
        const last = i === blocks.length - 1;
        if (block.startsWith('```'))
          return <pre key={i}><code>{block.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')}</code>{last && cursor}</pre>;
        const paragraphs = block.split(/\n{2,}/).filter((p) => p.trim());
        return <Fragment key={i}>{paragraphs.map((p, j) => <p key={j}>{paragraph(p)}{last && j === paragraphs.length - 1 && cursor}</p>)}</Fragment>;
      })}
    </div>
  );
}

const GAP_TEXT = { amount: 'The answer gives an amount this passage does not state.', frequency: 'The answer says how often, but this passage does not state a frequency.' };

function ProofPanel({ checked, source, onHide, onForget }: { checked: Checked; source: ProofSource | null; onHide: () => void; onForget: () => void }) {
  const { proof, page, gaps } = checked;
  const located = 'at' in proof ? proof.at : null;
  const passage = located && source ? context(source, located) : null;
  const explain: Record<ProofStatus['status'], string> = {
    found: 'Supporting passage from your attachment. A located quote shows these words are in your document; check that they support the whole claim.',
    ambiguous: `These exact words appear on ${'pages' in proof ? proof.pages.map((x) => `p. ${x}`).join(' and ') : 'several pages'}. The one shown is on the cited page, p. ${page}.`,
    'other-page': `These words are on p. ${located?.page ?? '?'}, not on p. ${page} as the answer cites.`,
    missing: 'These words are not in your document. Treat this part of the answer as unsupported.',
    expired: 'The document is no longer on this device, so this quote cannot be checked.',
    'page-only': `The answer cites p. ${page} without quoting it, so there is nothing to check.`,
  };
  return (
    <section className="proof-panel" aria-label="Selected claim">
      <h4 className="sheet-label">Selected claim</h4>
      <div className={`proof-card proof-${proof.status}`}>
        <div className="proof-card-head">
          <span><FileText size={14} aria-hidden="true" /> {source?.name ?? 'Your attachment'}</span>
          <span>p. {located?.page ?? page}</span>
        </div>
        <p className="proof-status" role="status">{statusLabel(proof, gaps)}</p>
        {passage ? (
          <p className="proof-context">{passage.before}<mark>{passage.quote}</mark>{passage.after}</p>
        ) : checked.quote ? (
          <p className="proof-context proof-unverified">“{checked.quote}”</p>
        ) : null}
      </div>
      <p className="faint proof-explain"><BookOpen size={14} aria-hidden="true" /> {explain[proof.status]}</p>
      {proof.status === 'found' && gaps.map((g) => <p key={g} className="notice notice-amber proof-gap">{GAP_TEXT[g]}</p>)}
      <div className="proof-actions">
        <button type="button" className="btn proof-hide" onClick={onHide}><BookOpen size={16} aria-hidden="true" /> Hide source</button>
        {source && <button type="button" className="btn btn-ghost btn-small" onClick={onForget}>Remove source from this device</button>}
      </div>
    </section>
  );
}

export function AnswerCard({ turn, characterId, proof, identity, keyAction }: {
  turn: Turn; characterId?: string; proof?: TurnProof | null; identity?: { name: string; logo: string | null } | null; keyAction?: ReactNode;
}) {
  const detailsId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const council = turn.council;
  const [comparing, setComparing] = useState(false);
  const streaming = turn.status === 'streaming';
  const lead = council?.aggregator ?? council?.judge ?? null;
  // Feature 07: only a turn that sent a document or excerpt gets citation marks; other answers render as before.
  const cited = !!proof && !!turn.attachment;
  const [selected, setSelected] = useState<number | null>(null);
  const checked = useMemo(() => {
    const out = new Map<number, Checked>();
    if (!cited) return out;
    for (const seg of parseCitations(turn.content)) {
      if (seg.kind !== 'cite') continue;
      const found = locate(proof?.source ?? null, seg.page, seg.quote);
      out.set(seg.index, { index: seg.index, page: seg.page, quote: seg.quote, claim: seg.claim, proof: found, gaps: 'at' in found && found.status === 'found' && seg.quote ? claimGaps(seg.claim, seg.quote) : [] });
    }
    return out;
  }, [cited, proof?.source, turn.content]);
  const selectedCheck = selected !== null ? checked.get(selected) ?? null : null;

  let body: ReactNode;
  if (turn.status === 'error')
    body = (
      <div className={`notice ${turn.needsFunds ? 'notice-amber' : 'notice-rose'} notice-action`} role="status">
        <p>{turn.needsFunds ? 'Add funds to continue this chat.' : turn.error}</p>
        {turn.needsFunds && (
          <Link className="btn btn-small btn-primary" href={setupHref('funds', characterDestination('chat', characterId))}>
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
        {isAutoModel(turn.model) && turn.status === 'done' && <p className="faint">{autoNote(answeredBy(turn), autoClassOf(turn.autoClass))}</p>}
        {turn.content || streaming ? (
          cited ? <CitedText text={turn.content} streaming={streaming} checked={checked} selected={selected} onSelect={setSelected} /> : <AnswerText text={turn.content} streaming={streaming} />
        ) : (
          <p className="muted">{turn.status === 'stopped' ? 'Stopped before any text arrived.' : ''}</p>
        )}
        <WebSources citations={turn.citations} />
      </div>
    );

  return (
    <div className="answer">
      {identity ? <p className="reply-byline" title={turn.model}>
        <ModelLogo src={identity.logo} /><span>{identity.name}</span>
      </p> : <div className="response-bar" role="tablist" aria-label="Answers">
        <button type="button" role="tab" className="tab" aria-selected={!comparing} onClick={() => setComparing(false)}>
          {council ? (council.mode === 'select' ? `Selected${council.selected ? ` · ${council.selected}` : ''}` : 'Merged') : isAutoModel(turn.model) ? autoTabLabel(answeredBy(turn)) : turn.model}
        </button>
        <span className="spacer" />
        {council && (
          <button type="button" className="btn btn-small btn-ghost compare" aria-pressed={comparing} onClick={() => setComparing((c) => !c)}>
            <Columns3 size={14} aria-hidden="true" />
            {comparing ? 'Answer' : 'Council'}
          </button>
        )}
      </div>}
      {body}
      {selectedCheck && proof && !comparing && (
        <ProofPanel checked={selectedCheck} source={proof.source} onHide={() => setSelected(null)} onForget={() => { proof.onForget(); }} />
      )}
      {turn.status === 'stopped' && <p className="faint">Stopped. You are charged only for the text that arrived.</p>}
      {turn.status !== 'streaming' && turn.status !== 'error' && (turn.welcomeReply ? (
        <>
          <div className="intro-reply-actions">
            <button type="button" className="reply-details-toggle" aria-expanded={detailsOpen} aria-controls={detailsId} onClick={() => setDetailsOpen(open => !open)}>
              Reply details <ChevronDown size={14} aria-hidden="true" />
            </button>
            {keyAction}
          </div>
          <div id={detailsId} className="intro-reply-details" hidden={!detailsOpen}><Footer turn={turn} /></div>
        </>
      ) : <><Footer turn={turn} />{keyAction}</>)}
    </div>
  );
}
