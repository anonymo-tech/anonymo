'use client';

import { useT, type Translator } from '@/lib/i18n';
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
  otherModel: [
    '{count} answered by a different model',
    '{count} answered by a different model',
  ],
  inProgress: [
    '{count} reply still generating',
    '{count} replies still generating',
  ],
  stopping: [
    '{count} stopped reply not yet settled',
    '{count} stopped replies not yet settled',
  ],
  unsettled: [
    '{count} reply whose cost is not yet settled',
    '{count} replies whose cost is not yet settled',
  ],
  unfinished: [
    '{count} reply that did not complete',
    '{count} replies that did not complete',
  ],
  notLoaded: [
    '{count} reply not fully loaded',
    '{count} replies not fully loaded',
  ],
  blind: [
    '{count} unrevealed blind comparison',
    '{count} unrevealed blind comparisons',
  ],
  sizeLimit: [
    '{count} beyond the context size limit',
    '{count} beyond the context size limit',
  ],
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

function omissionSummary(
  reasons: Partial<Record<ContextOmission, number>>,
  t: Translator,
) {
  const parts = omissionOrder.flatMap((reason) => {
    const count = reasons[reason] ?? 0;
    return count
      ? [t(omissionLabels[reason][count === 1 ? 0 : 1], { count })]
      : [];
  });
  return parts.length
    ? t(' ({reasons})', { reasons: parts.join(t(', ')) })
    : '';
}

function ReservationCap({
  budgetUsd6,
  availableUsd6,
}: {
  budgetUsd6: string;
  availableUsd6: string | null;
}) {
  const t = useT();
  const cap = effectiveReservationCap(budgetUsd6, availableUsd6);
  return (
    <>
      {formatFriendlyUsd6(cap.usd6)}
      {cap.limitedByBalance && t(' · your available balance')}
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
  const t = useT();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const uncertain = review.phase === 'uncertain';
  const expired = Date.parse(review.expiresAt) <= now;
  const fee = quotePlatformFeeTotals(review.quotes);
  const single = review.quotes.length === 1;
  const routingReason =
    review.routing?.mode === 'auto' ? review.routing.recommendation.reason : '';
  const suppliedReason =
    /^Lowest maximum quoted cost among (\d+) reviewed, compatible supplied candidates for (general questions|code|reasoning|writing|long context)\. Each price includes its full supplied conversation context; this is not a model quality ranking\.$/.exec(
      routingReason,
    );
  return (
    <div className="ct-tools cw-simple-form cw-request-review">
      <p className="ct-intro">
        {uncertain
          ? t(
              'The last submission was interrupted. Recover this same request using its original request key; this will not create a second comparison.',
            )
          : single
            ? t(
                'Review where this question goes and the maximum amount reserved before the model runs.',
              )
            : t(
                'Review where this question goes and the maximum amount reserved before any model runs.',
              )}
      </p>
      <section className="ct-detail" aria-label={t('Request summary')}>
        <div className="ct-detail-heading">
          <h3>
            {review.blind
              ? t('Blind comparison')
              : single
                ? t('Your question')
                : t('Model comparison')}
          </h3>
          <span className="ct-status">
            {single
              ? t('{count} model', { count: review.quotes.length })
              : t('{count} models', { count: review.quotes.length })}
          </span>
        </div>
        <p className="ct-note">
          {single
            ? t(
                'The question below and the included prior exchanges are sent. Attached files are not included.',
              )
            : t(
                'The question below and each model’s included prior exchanges are sent. Attached files are not included. Context counts are listed per model.',
              )}
        </p>
        <p className="ct-code">{review.prompt}</p>
        <dl className="ct-facts">
          <div>
            <dt>{t('Maximum reservation')}</dt>
            <dd>{formatUsd6(review.maximumUsd6)}</dd>
          </div>
          {fee && (
            <div>
              <dt>{t('Platform fee')}</dt>
              <dd>
                {t(
                  'Includes up to {fee} platform fee · {reserve} to the platform-token burn reserve',
                  {
                    fee: formatUsd6(fee.platformFeeMaximumUsd6),
                    reserve: formatUsd6(fee.burnReserveMaximumUsd6),
                  },
                )}
              </dd>
            </div>
          )}
          <div>
            <dt>{t('Privacy route')}</dt>
            <dd>
              {t(
                'Standard · The inference gateway and the model provider receive the question in plaintext.',
              )}
            </dd>
          </div>
          <div>
            <dt>{t('Quote')}</dt>
            <dd>
              {uncertain
                ? t('Original request retained for recovery')
                : expired
                  ? t('Expired — request a new quote')
                  : t('Expires {time} UTC', {
                      time: new Date(review.expiresAt)
                        .toISOString()
                        .slice(11, 19),
                    })}
            </dd>
          </div>
        </dl>
      </section>
      {review.routing?.mode === 'auto' && (
        <section
          className="ct-detail"
          aria-label={t('Automatic routing decision')}
        >
          <h3>
            {t('Auto · {task}', {
              task: t(ROUTING_TASK_LABELS[review.routing.task]),
            })}
          </h3>
          <p className="ct-note">
            {suppliedReason
              ? t(
                  'Lowest maximum quoted cost among {count} reviewed, compatible supplied candidates for {task}. Each price includes its full supplied conversation context; this is not a model quality ranking.',
                  { count: suppliedReason[1], task: t(suppliedReason[2]) },
                )
              : t(routingReason)}
          </p>
          <dl className="ct-facts">
            <div>
              <dt>{t('Reservation budget')}</dt>
              <dd>
                <ReservationCap
                  budgetUsd6={review.routing.budgetUsd6}
                  availableUsd6={availableUsd6}
                />
              </dd>
            </div>
            <div>
              <dt>{t('Output ceiling')}</dt>
              <dd>
                {t('{count} tokens', { count: review.routing.maxOutputTokens })}
              </dd>
            </div>
          </dl>
        </section>
      )}
      {review.routing?.mode === 'mentions' && (
        <p className="ct-note">
          {t('Model mentions: {mentions}.', {
            mentions: review.routing.mentions.join(', '),
          })}
          {review.routing.overridesAuto
            ? t(
                ' These choices override Auto’s route choice for this question; its reservation budget still applies.',
              )
            : t(' These choices override the picker for this question.')}{' '}
          {t('Routing markers are removed from the question shown above.')}
          {review.routing.budgetUsd6 &&
            t.rich(' Reservation budget: {budget}.', {
              budget: (
                <ReservationCap
                  budgetUsd6={review.routing.budgetUsd6}
                  availableUsd6={availableUsd6}
                />
              ),
            })}
        </p>
      )}
      {review.contexts.map((context, index) => (
        <p className="ct-note" key={`${context.family}:${index}`}>
          {context.includedExchanges === 1
            ? t('{model}: {count} previous exchange included', {
                model: review.quotes[index]?.modelId ?? context.family,
                count: context.includedExchanges,
              })
            : t('{model}: {count} previous exchanges included', {
                model: review.quotes[index]?.modelId ?? context.family,
                count: context.includedExchanges,
              })}
          {context.omittedExchanges > 0 &&
            (context.omittedExchanges === 1
              ? t('; {count} loaded project turn left out{reasons}', {
                  count: context.omittedExchanges,
                  reasons: omissionSummary(context.omittedReasons ?? {}, t),
                })
              : t('; {count} loaded project turns left out{reasons}', {
                  count: context.omittedExchanges,
                  reasons: omissionSummary(context.omittedReasons ?? {}, t),
                }))}
          {t('.')}
          {context.olderHistoryNotLoaded &&
            t(
              ' Additional older history has not been loaded and is not included.',
            )}
        </p>
      ))}
      {review.quotes.map((quote) => (
        <details className="ct-detail" key={quote.id}>
          <summary>
            {t('{model} · maximum {amount}', {
              model: quote.modelId,
              amount: formatUsd6(quote.maximumUsd6),
            })}
          </summary>
          <dl className="ct-facts">
            <div>
              <dt>{t('Route level')}</dt>
              <dd>{t(quote.card.level)}</dd>
            </div>
            <div>
              <dt>{t('Retention')}</dt>
              <dd>{t(quote.card.retentionDisclosure)}</dd>
            </div>
            <div>
              <dt>{t('Training use')}</dt>
              <dd>{t(quote.card.trainingUse.replaceAll('_', ' '))}</dd>
            </div>
            <div>
              <dt>{t('Pricing markup')}</dt>
              <dd>
                {t('{percent}% included in the maximum', {
                  percent: quote.markupBps / 100,
                })}
              </dd>
            </div>
            <div>
              <dt>{t('Evidence checked')}</dt>
              <dd>{quote.card.evidenceDate}</dd>
            </div>
            {review.routing?.mode === 'auto' && quote.card.routing && (
              <div>
                <dt>{t('Task review')}</dt>
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
              {t('Read task review evidence')}{' '}
              <MotionIcon name="open" size={18} />
              <span className="ct-sr-only">{t(' (opens in a new tab)')}</span>
            </a>
          )}
          {quote.card.evidenceUrl.startsWith('https://') && (
            <a
              className="ct-source"
              href={quote.card.evidenceUrl}
              target="_blank"
              rel="noreferrer"
            >
              {t('Read route evidence')} <MotionIcon name="open" size={18} />
              <span className="ct-sr-only">{t(' (opens in a new tab)')}</span>
            </a>
          )}
        </details>
      ))}
      <p className="ct-note">
        {t(
          'The reserved maximum is a hold against your balance. Verified usage determines settlement. Cancellation may still incur usage already dispatched; an uncertain provider result can remain held for review.',
        )}
      </p>
      {error && <output className="ct-note">{t(error)}</output>}
      <div className="ct-footer">
        <button
          className="ct-button"
          type="button"
          onClick={onDismiss}
          disabled={busy || uncertain}
        >
          {t('Dismiss')}
        </button>
        <button
          className="ct-button ct-button-primary"
          type="button"
          onClick={onApprove}
          disabled={busy || (!uncertain && expired)}
        >
          {busy
            ? t('Checking saved request…')
            : uncertain
              ? t('Recover this request')
              : t('Reserve up to {amount} and send', {
                  amount: formatUsd6(review.maximumUsd6),
                })}
        </button>
      </div>
    </div>
  );
}
