'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { AnswerCard, AnswerText } from './answer-card';
import { chargeOf, spentLabel, type Atto, type ChargedTurn } from '@/lib/anonymo/pricetag';
import { rerouteOf, type Answer } from '@/lib/anonymo/sidebyside';
import { shapeOf, type ModeResult } from '@/lib/anonymo/chat-modes';
import type { SpeechReceipt } from '@/lib/anonymo/types';
import type { Turn } from './chat-types';
import type { ProofSource } from '@/lib/anonymo/citations';

export function modeCharges(turn: Turn): ChargedTurn[] {
  const result = turn.modeResult;
  switch (result?.mode) {
    case 'picture':
      return [{ ...turn, ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}) }];
    case 'three': {
      const { columns, merge } = result.round;
      return merge ? [...columns, merge] : columns;
    }
    case 'talk':
      return [turn, ...result.audioCosts.map((costUsd): ChargedTurn => ({
        status: 'done', content: '', receipt: null, receiptId: null, costUsd,
      }))];
    default:
      return [turn];
  }
}

function costText(turn: Turn) {
  let total: Atto = 0n;
  let unknown = false;
  let pending = false;
  for (const item of modeCharges(turn)) {
    const charge = chargeOf(item);
    if (charge.kind === 'charged') total += charge.atto;
    if (charge.kind === 'unknown') unknown = true;
    if (charge.kind === 'pending') pending = true;
  }
  if (turn.modeResult?.mode === 'talk' && turn.modeResult.audioPending) return total ? `${spentLabel(total)} so far` : 'Checking the price…';
  if (pending) return total ? `${spentLabel(total)} confirmed · see receipts` : 'See receipt for price';
  if (unknown) return total ? `${spentLabel(total)} confirmed` : 'Price unavailable';
  return spentLabel(total);
}

function ComparisonAnswer({ answer, label }: { answer: Answer; label?: string }) {
  const reroute = rerouteOf(answer.receipt);
  return (
    <section className="mode-column">
      <strong>{label ?? answer.model}</strong>
      {label && <small>{answer.model}</small>}
      {answer.error && <p className="error-text">{answer.error}</p>}
      {answer.content ? <AnswerText text={answer.content} /> : answer.status === 'streaming' && <p className="faint">Writing…</p>}
      {answer.status === 'stopped' && <p className="faint">Stopped</p>}
      {answer.cutOff && <p className="faint">Reply reached its length limit.</p>}
      {reroute && <p className="faint">{reroute.servedRefusal ? 'Refused · billed $0' : `Refused attempt refunded${reroute.steppedIn ? ` · ${reroute.steppedIn.model} answered` : ''}`}</p>}
      {answer.receiptId && <Link href={`/dashboard/receipts/${encodeURIComponent(answer.receiptId)}`}>Signed receipt</Link>}
    </section>
  );
}

function MediaReceipt({ receipt, name = 'Signed receipt' }: { receipt: SpeechReceipt; name?: string }) {
  const download = useMemo(() => `data:application/json,${encodeURIComponent(JSON.stringify(receipt))}`, [receipt]);
  return <a download="media-receipt.json" href={download}>{name}</a>;
}

export function ChatModeTurn({ turn, redo, characterId, proof }: {
  turn: Turn & { modeResult: ModeResult };
  redo?: () => void;
  characterId?: string;
  proof: { source: ProofSource | null; onForget: () => void } | null;
}) {
  const result = turn.modeResult;
  let settings: string;
  if (result.mode === 'picture') {
    const { size, n } = result.settings;
    settings = `${result.name} · ${shapeOf(size)} (${size}) · ${n} ${n === 1 ? 'image' : 'images'}`;
  } else if (result.mode === 'three') {
    settings = [...result.settings.models, result.settings.merged ? 'Merged' : 'Side by side'].join(' · ');
  } else {
    settings = [turn.model, result.settings.voice, result.settings.aloud ? 'Read aloud' : 'Text only'].filter(Boolean).join(' · ');
  }
  return (
    <div className="mode-result">
      {result.mode === 'picture' && (
        <>
          {turn.status === 'streaming' && <p className="faint">Making {result.settings.n === 1 ? 'your picture' : 'your pictures'}…</p>}
          {turn.status === 'stopped' && <p className="faint">Stopped</p>}
          {turn.error && <p className="error-text">{turn.error}</p>}
          {result.images?.length ? <div className="mode-pictures">{result.images.map((src, i) => (
            // eslint-disable-next-line @next/next/no-img-element -- a PNG returned by the gateway
            <img key={i} src={src} alt={`Generated result ${i + 1}`} />
          ))}</div> : turn.status === 'done' && <p className="faint">{result.images ? 'No pictures came back.' : 'Pictures are kept in this tab.'}</p>}
        </>
      )}
      {result.mode === 'three' && (
        <>
          <div className="mode-columns">{result.round.columns.map((answer) => <ComparisonAnswer key={answer.model} answer={answer} />)}</div>
          {result.round.merge && <ComparisonAnswer label="Merged" answer={result.round.merge} />}
          {result.mergeNote && <p className="faint">{result.mergeNote}</p>}
        </>
      )}
      {result.mode === 'talk' && <AnswerCard turn={turn} characterId={characterId} proof={proof} />}
      {turn.status !== 'streaming' && <div className="mode-result-meta">
        {settings} · {costText(turn)}
        {result.mode === 'picture' && result.receipt && <> · <MediaReceipt receipt={result.receipt} /></>}
        {result.mode === 'talk' && result.audioReceipts?.map((receipt, index) => (
          <span key={receipt.payload.request_id}> · <MediaReceipt receipt={receipt} name={`Voice receipt ${index + 1}`} /></span>
        ))}
        {redo && <> · <button type="button" className="link-button" onClick={redo}>Change and redo</button></>}
      </div>}
    </div>
  );
}
