'use client';

import { useEffect, useState } from 'react';
import type {
  ContextOmission,
  LiveRequestReview as RequestReview,
} from './use-live-workspace';
import {
  effectiveReservationCap,
  formatFriendlyUsd6,
  formatUsd6,
  quotePlatformFeeTotals,
} from '../../lib/client/workspace';
import { MotionIcon } from './motion-icon';
import { ROUTING_TASK_LABELS } from '../../lib/model-routing';

const omissionLabels: Record<ContextOmission, [string, string]> = {
  otherModel: ['answered by a different model', 'answered by a different model'],
  inProgress: ['reply still generating', 'replies still generating'],
  stopping: ['stopped reply not yet settled', 'stopped replies not yet settled'],
  unsettled: ['reply whose cost is not yet settled', 'replies whose cost is not yet settled'],
  unfinished: ['reply that did not complete', 'replies that did not complete'],
  notLoaded: ['reply not fully loaded', 'replies not fully loaded'],
  blind: ['unrevealed blind comparison', 'unrevealed blind comparisons'],
  sizeLimit: ['beyond the context size limit', 'beyond the context size limit'],
};
const omissionOrder: ContextOmission[] = [
  'otherModel',
  'unsettled',
  'inProgress',
  'stopping',
  'unfinished',
  'notLoaded',
  'blind',
  'sizeLimit',
];

function omissionSummary(reasons: Partial<Record<ContextOmission, number>>) {
  const parts = omissionOrder.flatMap((reason) => {
    const count = reasons[reason] ?? 0;
    return count ? [`${count} ${omissionLabels[reason][count === 1 ? 0 : 1]}`] : [];
  });
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function ReservationCap({
  budgetUsd6,
  availableUsd6,
}: {
  budgetUsd6: string;
  availableUsd6: string | null;
}) {
  const cap = effectiveReservationCap(budgetUsd6, availableUsd6);
  return (
    <>
      {formatFriendlyUsd6(cap.usd6)}
      {cap.limitedByBalance && ' · your available balance'}
    </>
  );
}

export function LiveRequestReview({
  review,
  availableUsd6 = null,
  busy,
  error,
  onApprove,
  onDismiss,
}: {
  review: RequestReview;
  /** The account's available balance, which also caps any reservation budget. */
  availableUsd6?: string | null;
  busy: boolean;
  error: string | null;
  onApprove: () => void;
  onDismiss: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const uncertain = review.phase === 'uncertain';
  const expired = Date.parse(review.expiresAt) <= now;
  const fee = quotePlatformFeeTotals(review.quotes);
  const single = review.quotes.length === 1;
  return (
    <div className="ct-tools cw-simple-form cw-request-review">
      <p className="ct-intro">
        {uncertain
          ? 'The last submission was interrupted. Recover this same request using its original request key; this will not create a second comparison.'
          : `Review where this question goes and the maximum amount reserved before ${single ? 'the model runs' : 'any model runs'}.`}
      </p>
      <section className="ct-detail" aria-label="Request summary">
        <div className="ct-detail-heading">
          <h3>
            {review.blind
              ? 'Blind comparison'
              : single
                ? 'Your question'
                : 'Model comparison'}
          </h3>
          <span className="ct-status">
            {review.quotes.length} {single ? 'model' : 'models'}
          </span>
        </div>
        <p className="ct-note">
          {single
            ? 'The question below and the included prior exchanges are sent. Attached files are not included.'
            : 'The question below and each model’s included prior exchanges are sent. Attached files are not included. Context counts are listed per model.'}
        </p>
        <p className="ct-code">{review.prompt}</p>
        <dl className="ct-facts">
          <div>
            <dt>Maximum reservation</dt>
            <dd>{formatUsd6(review.maximumUsd6)}</dd>
          </div>
          {fee && (
            <div>
              <dt>Platform fee</dt>
              <dd>{`Includes up to ${formatUsd6(fee.platformFeeMaximumUsd6)} platform fee · ${formatUsd6(fee.burnReserveMaximumUsd6)} to the platform-token burn reserve`}</dd>
            </div>
          )}
          <div>
            <dt>Privacy route</dt>
            <dd>
              Standard · The inference gateway and the model provider receive the question in
              plaintext.
            </dd>
          </div>
          <div>
            <dt>Quote</dt>
            <dd>
              {uncertain
                ? 'Original request retained for recovery'
                : expired
                  ? 'Expired — request a new quote'
                  : `Expires ${new Date(review.expiresAt).toISOString().slice(11, 19)} UTC`}
            </dd>
          </div>
        </dl>
      </section>
      {review.routing?.mode === 'auto' && (
        <section className="ct-detail" aria-label="Automatic routing decision">
          <h3>Auto · {ROUTING_TASK_LABELS[review.routing.task]}</h3>
          <p className="ct-note">{review.routing.recommendation.reason}</p>
          <dl className="ct-facts">
            <div>
              <dt>Reservation budget</dt>
              <dd>
                <ReservationCap
                  budgetUsd6={review.routing.budgetUsd6}
                  availableUsd6={availableUsd6}
                />
              </dd>
            </div>
            <div>
              <dt>Output ceiling</dt>
              <dd>{review.routing.maxOutputTokens} tokens</dd>
            </div>
          </dl>
        </section>
      )}
      {review.routing?.mode === 'mentions' && (
        <p className="ct-note">
          Model mentions: {review.routing.mentions.join(', ')}.
          {review.routing.overridesAuto
            ? ' These choices override Auto’s route choice for this question; its reservation budget still applies.'
            : ' These choices override the picker for this question.'}{' '}
          Routing markers are removed from the question shown above.
          {review.routing.budgetUsd6 && (
            <>
              {' '}
              Reservation budget:{' '}
              <ReservationCap
                budgetUsd6={review.routing.budgetUsd6}
                availableUsd6={availableUsd6}
              />
              .
            </>
          )}
        </p>
      )}
      {review.contexts.map((context, index) => (
        <p className="ct-note" key={`${context.family}:${index}`}>
          {review.quotes[index]?.modelId ?? context.family}:{' '}
          {context.includedExchanges} previous{' '}
          {context.includedExchanges === 1 ? 'exchange' : 'exchanges'} included
          {context.omittedExchanges > 0 &&
            `; ${context.omittedExchanges} loaded project ${context.omittedExchanges === 1 ? 'turn' : 'turns'} left out${omissionSummary(context.omittedReasons ?? {})}`}
          .
          {context.olderHistoryNotLoaded &&
            ' Additional older history has not been loaded and is not included.'}
        </p>
      ))}
      {review.quotes.map((quote) => (
        <details className="ct-detail" key={quote.id}>
          <summary>
            {quote.modelId} · maximum {formatUsd6(quote.maximumUsd6)}
          </summary>
          <dl className="ct-facts">
            <div>
              <dt>Route level</dt>
              <dd>{quote.card.level}</dd>
            </div>
            <div>
              <dt>Retention</dt>
              <dd>{quote.card.retentionDisclosure}</dd>
            </div>
            <div>
              <dt>Training use</dt>
              <dd>{quote.card.trainingUse.replaceAll('_', ' ')}</dd>
            </div>
            <div>
              <dt>Pricing markup</dt>
              <dd>{quote.markupBps / 100}% included in the maximum</dd>
            </div>
            <div>
              <dt>Evidence checked</dt>
              <dd>{quote.card.evidenceDate}</dd>
            </div>
            {review.routing?.mode === 'auto' && quote.card.routing && (
              <div>
                <dt>Task review</dt>
                <dd>{quote.card.routing.reviewedAt}</dd>
              </div>
            )}
          </dl>
          {review.routing?.mode === 'auto' && quote.card.routing && (
            <a
              className="ct-source"
              href={quote.card.routing.evidenceUrl}
              target="_blank"
              rel="noreferrer"
            >
              Read task review evidence <MotionIcon name="open" size={18} />
              <span className="ct-sr-only"> (opens in a new tab)</span>
            </a>
          )}
          {quote.card.evidenceUrl.startsWith('https://') && (
            <a
              className="ct-source"
              href={quote.card.evidenceUrl}
              target="_blank"
              rel="noreferrer"
            >
              Read route evidence <MotionIcon name="open" size={18} />
              <span className="ct-sr-only"> (opens in a new tab)</span>
            </a>
          )}
        </details>
      ))}
      <p className="ct-note">
        The reserved maximum is a hold against your balance. Verified usage
        determines settlement. Cancellation may still incur usage already
        dispatched; an uncertain provider result can remain held for review.
      </p>
      {error && <output className="ct-note">{error}</output>}
      <div className="ct-footer">
        <button
          className="ct-button"
          type="button"
          onClick={onDismiss}
          disabled={busy || uncertain}
        >
          Dismiss
        </button>
        <button
          className="ct-button ct-button-primary"
          type="button"
          onClick={onApprove}
          disabled={busy || (!uncertain && expired)}
        >
          {busy
            ? 'Checking saved request…'
            : uncertain
              ? 'Recover this request'
              : `Reserve up to ${formatUsd6(review.maximumUsd6)} and send`}
        </button>
      </div>
    </div>
  );
}
