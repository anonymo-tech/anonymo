'use client';

import { useEffect, useState } from 'react';
import { formatUsd6 } from '../../lib/client/workspace';
import {
  hasUncertainStudioApproval,
  studioPendingMaximum,
  studioVariantKey,
  studioVariantLabel,
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
          ? 'A submission was interrupted. Recover its original approval before starting anything else. Accepted jobs are never sent again, and recovery does not start the unsubmitted models.'
          : accepted === review.entries.length
            ? 'These jobs are saved. Generation, processing and final billing remain visible in Studio.'
            : 'Review the exact video options and maximum reservation for each model before generation starts.'}
      </p>
      <section className="ct-detail" aria-label="Studio request summary">
        <div className="ct-detail-heading">
          <h3>Video comparison</h3>
          <span className="ct-status">
            {review.entries.length}{' '}
            {review.entries.length === 1 ? 'model' : 'models'}
          </span>
        </div>
        <p className="ct-code">{review.prompt}</p>
        <dl className="ct-facts">
          <div>
            <dt>Draft preference</dt>
            <dd>
              {review.requestedRatio} · {review.requestedDuration} seconds
            </dd>
          </div>
          <div>
            <dt>Exact generation options</dt>
            <dd>
              Shown per model below. A draft duration may differ from supported
              model durations.
            </dd>
          </div>
          <div>
            <dt>Maximum still to reserve</dt>
            <dd>
              {maximum === null
                ? 'Quotes required for all remaining models'
                : formatUsd6(maximum)}
            </dd>
          </div>
          {accepted > 0 && (
            <div>
              <dt>Already submitted</dt>
              <dd>
                {accepted} {accepted === 1 ? 'job' : 'jobs'} · excluded from new
                submissions
              </dd>
            </div>
          )}
          <div>
            <dt>Privacy route</dt>
            <dd>
              Standard · The inference gateway and the upstream model provider receive the
              description in plaintext.
            </dd>
          </div>
        </dl>
      </section>
      {review.entries.map((entry) => (
        <section
          className="ct-detail"
          key={entry.family}
          aria-label={`${entry.name} generation terms`}
        >
          <div className="ct-detail-heading">
            <h3>{entry.name}</h3>
            <span className="ct-status">
              {entry.phase === 'accepted'
                ? 'Submitted'
                : entry.phase === 'uncertain'
                  ? 'Outcome unknown'
                  : entry.phase === 'submitting'
                    ? 'Submitting…'
                    : entry.phase === 'rejected'
                      ? 'Not accepted'
                      : entry.phase === 'quoted'
                        ? 'Quoted'
                        : 'Quote needed'}
            </span>
          </div>
          <label>
            Exact {entry.name} variant
            <select
              aria-label={`${entry.name} generation variant`}
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
                    {studioVariantLabel(variant.options)}
                  </option>
                ))}
            </select>
          </label>
          <dl className="ct-facts">
            <div>
              <dt>Model</dt>
              <dd>{entry.route.modelId}</dd>
            </div>
            <div>
              <dt>Maximum reservation</dt>
              <dd>
                {entry.quote
                  ? formatUsd6(entry.quote.maximumUsd6)
                  : 'Not quoted'}
              </dd>
            </div>
            {entry.quote && (
              <div>
                <dt>Quote</dt>
                <dd>
                  {entry.phase === 'accepted'
                    ? 'Accepted terms retained'
                    : ['uncertain', 'submitting'].includes(entry.phase)
                      ? 'Original key retained for recovery'
                      : Date.parse(entry.quote.expiresAt) <= now
                        ? 'Expired — refresh quotes'
                        : `Expires ${entry.quote.expiresAt.slice(11, 19)} UTC`}
                </dd>
              </div>
            )}
            <div>
              <dt>Retention</dt>
              <dd>{entry.route.privacy.retentionDisclosure}</dd>
            </div>
          </dl>
          {entry.error && <output className="ct-note">{entry.error}</output>}
        </section>
      ))}
      <p className="ct-note">
        Each model creates a separate job and balance hold. A hold is a maximum
        reservation; confirmed provider cost determines settlement. Cancellation
        after dispatch may still incur a charge. Provider cancellation is
        unavailable. Saved media is served only after processing succeeds.
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
          {accepted ? 'Close review' : 'Keep editing'}
        </button>
        {remaining.length > 0 && !uncertain && (
          <button
            className="ct-button"
            type="button"
            onClick={onRefreshQuotes}
            disabled={busy}
          >
            {busy
              ? 'Checking…'
              : needsQuotes
                ? 'Get current quotes'
                : 'Refresh quotes'}
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
              ? 'Checking saved requests…'
              : uncertain
                ? 'Recover interrupted approvals'
                : `Reserve up to ${formatUsd6(maximum ?? '0')} and generate`}
          </button>
        )}
      </div>
    </div>
  );
}
