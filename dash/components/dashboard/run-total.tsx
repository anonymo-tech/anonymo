'use client';

import type { Turn } from './canvas-state';
import { chatBillingSummary } from '../../lib/chat-billing';
import { formatAccountUsd6 } from '../../lib/client/account-records';

export function RunTotal({ turn }: { turn: Turn }) {
  if (!turn.live || turn.answers.length < 2) return null;
  if (turn.live.blind && !turn.live.revealedAt) return <p className="cw-run-total">Reveal the models to see this comparison’s cost.</p>;
  const bills = turn.answers.flatMap(answer => answer.live ? [answer.live.billing] : []);
  if (!bills.length) return null;
  const summary = chatBillingSummary(bills);
  return <details className="cw-run-total">
    <summary>{turn.answers.length} models · {summary.pending ? 'Charged so far' : 'Total charged'} ${formatAccountUsd6(summary.chargedUsd6)}{summary.pending ? ` · ${summary.pending} pending` : ''}</summary>
    {summary.pending > 0 && <p>{summary.unknown ? 'Some reservations are still being checked.' : `$${formatAccountUsd6(summary.reservedUsd6)} is reserved for pending calls. This is not a final charge.`}</p>}
    <dl>{turn.answers.map(answer => answer.live && <div key={answer.id}><dt>{answer.live.modelName ?? answer.live.label ?? 'Model'}</dt><dd>{answer.live.billing.state === 'captured' && answer.live.billing.actualUsd6 !== null ? `$${formatAccountUsd6(answer.live.billing.actualUsd6)}` : answer.live.billing.state === 'released' ? 'Released · no charge' : 'Settlement pending'}</dd></div>)}</dl>
  </details>;
}
