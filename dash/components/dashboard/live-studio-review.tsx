'use client';

import { useT } from '@/lib/i18n';

import { useEffect, useState } from 'react';
import { studioMessage } from './use-live-studio';
import { formatUsd6 } from '../../lib/client/workspace';
import {
  hasUncertainStudioApproval,
  studioPendingMaximum,
  studioVariantKey,
  type StudioReview,
} from '../../lib/client/studio-review';

export function LiveStudioReview({
  review,
  busy,
  error,
  onVariantChange,
  onRefreshQuotes,
  onApprove,
  onDismiss,
}: {
  review: StudioReview;
  busy: boolean;
  error: string | null;
  onVariantChange: (family: string, variantKey: string) => void;
  onRefreshQuotes: () => void;
  onApprove: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const [now, setNow] = useState(Date.now);
  const timed = review.entries.some((entry) => entry.phase === 'quoted');
  useEffect(() => {
    if (!timed) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [timed]);
  const uncertain = hasUncertainStudioApproval(review);
  const remaining = review.entries.filter(
    (entry) => entry.phase !== 'accepted',
  );
  const accepted = review.entries.length - remaining.length;
  const maximum = studioPendingMaximum(review);
  const expired = remaining.some(
    (entry) =>
      entry.phase === 'quoted' &&
      entry.quote &&
      Date.parse(entry.quote.expiresAt) <= now,
  );
  const selectionLocked =
    busy ||
    review.entries.some((entry) =>
      ['submitting', 'uncertain', 'accepted', 'rejected'].includes(entry.phase),
    );
  const needsQuotes =
    remaining.some(
      (entry) => !entry.quote || !entry.approval || entry.phase === 'rejected',
    ) || expired;
  return (
    <div className="cw-simple-form">
      <p className="ct-intro">
        {uncertain
          ? t(
              'A submission was interrupted. Recover its original approval before starting anything else. Accepted jobs are never sent again, and recovery does not start the unsubmitted models.',
            )
          : accepted === review.entries.length
            ? t(
                'These jobs are saved. Generation, processing and final billing remain visible in Studio.',
              )
            : t(
                'Review the exact video options and maximum reservation for each model before generation starts.',
              )}
      </p>
      <section className="ct-detail" aria-label={t('Studio request summary')}>
        <div className="ct-detail-heading">
          <h3>{t('Video comparison')}</h3>
          <span className="ct-status">
            {review.entries.length === 1
              ? t('{count} model', { count: review.entries.length })
              : t('{count} models', { count: review.entries.length })}
          </span>
        </div>
        <p className="ct-code">{review.prompt}</p>
        <dl className="ct-facts">
          <div>
            <dt>{t('Draft preference')}</dt>
            <dd>
              {t('{ratio} · {duration} seconds', {
                ratio: review.requestedRatio,
                duration: review.requestedDuration,
              })}
            </dd>
          </div>
          <div>
            <dt>{t('Exact generation options')}</dt>
            <dd>
              {t(
                'Shown per model below. A draft duration may differ from supported model durations.',
              )}
            </dd>
          </div>
          <div>
            <dt>{t('Maximum still to reserve')}</dt>
            <dd>
              {maximum === null
                ? t('Quotes required for all remaining models')
                : formatUsd6(maximum)}
            </dd>
          </div>
          {accepted > 0 && (
            <div>
              <dt>{t('Already submitted')}</dt>
              <dd>
                {accepted === 1
                  ? t('{count} job · excluded from new submissions', {
                      count: accepted,
                    })
                  : t('{count} jobs · excluded from new submissions', {
                      count: accepted,
                    })}
              </dd>
            </div>
          )}
          <div>
            <dt>{t('Privacy route')}</dt>
            <dd>
              {t(
                'Standard · The inference gateway and the upstream model provider receive the description in plaintext.',
              )}
            </dd>
          </div>
        </dl>
      </section>
      {review.entries.map((entry) => (
        <section
          className="ct-detail"
          key={entry.family}
          aria-label={t('{name} generation terms', { name: entry.name })}
        >
          <div className="ct-detail-heading">
            <h3>{entry.name}</h3>
            <span className="ct-status">
              {entry.phase === 'accepted'
                ? t('Submitted')
                : entry.phase === 'uncertain'
                  ? t('Outcome unknown')
                  : entry.phase === 'submitting'
                    ? t('Submitting…')
                    : entry.phase === 'rejected'
                      ? t('Not accepted')
                      : entry.phase === 'quoted'
                        ? t('Quoted')
                        : t('Quote needed')}
            </span>
          </div>
          <label>
            {t('Exact {name} variant', { name: entry.name })}
            <select
              aria-label={t('{name} generation variant', { name: entry.name })}
              value={studioVariantKey(entry.options)}
              disabled={selectionLocked}
              onChange={(event) =>
                onVariantChange(entry.family, event.target.value)
              }
            >
              {entry.route.pricing.variants
                .filter((variant) => variant.options.kind === 'video')
                .map((variant) => (
                  <option
                    key={studioVariantKey(variant.options)}
                    value={studioVariantKey(variant.options)}
                  >
                    {variant.options.kind === 'video'
                      ? t('{duration}s · {ratio} · {quality}', {
                          duration: variant.options.duration,
                          ratio: variant.options.aspectRatio,
                          quality:
                            variant.options.quality === 'standard'
                              ? t('standard')
                              : variant.options.quality,
                        })
                      : `${variant.options.resolution} · ${variant.options.aspectRatio}`}
                  </option>
                ))}
            </select>
          </label>
          <dl className="ct-facts">
            <div>
              <dt>{t('Model')}</dt>
              <dd>{entry.route.modelId}</dd>
            </div>
            <div>
              <dt>{t('Maximum reservation')}</dt>
              <dd>
                {entry.quote
                  ? formatUsd6(entry.quote.maximumUsd6)
                  : t('Not quoted')}
              </dd>
            </div>
            {entry.quote && (
              <div>
                <dt>{t('Quote')}</dt>
                <dd>
                  {entry.phase === 'accepted'
                    ? t('Accepted terms retained')
                    : ['uncertain', 'submitting'].includes(entry.phase)
                      ? t('Original key retained for recovery')
                      : Date.parse(entry.quote.expiresAt) <= now
                        ? t('Expired — refresh quotes')
                        : t('Expires {time} UTC', {
                            time: entry.quote.expiresAt.slice(11, 19),
                          })}
                </dd>
              </div>
            )}
            <div>
              <dt>{t('Retention')}</dt>
              <dd>{t(entry.route.privacy.retentionDisclosure)}</dd>
            </div>
          </dl>
          {entry.error && (
            <output className="ct-note">{studioMessage(entry.error, t)}</output>
          )}
        </section>
      ))}
      <p className="ct-note">
        {t(
          'Each model creates a separate job and balance hold. A hold is a maximum reservation; confirmed provider cost determines settlement. Cancellation after dispatch may still incur a charge. Provider cancellation is unavailable. Saved media is served only after processing succeeds.',
        )}
      </p>
      {error && (
        <output className="ct-note" role="alert">
          {error}
        </output>
      )}
      <div className="ct-actions">
        <button
          className="ct-button"
          type="button"
          onClick={onDismiss}
          disabled={busy || uncertain}
        >
          {accepted ? t('Close review') : t('Keep editing')}
        </button>
        {remaining.length > 0 && !uncertain && (
          <button
            className="ct-button"
            type="button"
            onClick={onRefreshQuotes}
            disabled={busy}
          >
            {busy
              ? t('Checking…')
              : needsQuotes
                ? t('Get current quotes')
                : t('Refresh quotes')}
          </button>
        )}
        {remaining.length > 0 && (
          <button
            className="ct-button ct-button-primary"
            type="button"
            onClick={onApprove}
            disabled={busy || (!uncertain && (needsQuotes || maximum === null))}
          >
            {busy
              ? t('Checking saved requests…')
              : uncertain
                ? t('Recover interrupted approvals')
                : t('Reserve up to {amount} and generate', {
                    amount: formatUsd6(maximum ?? '0'),
                  })}
          </button>
        )}
      </div>
    </div>
  );
}
