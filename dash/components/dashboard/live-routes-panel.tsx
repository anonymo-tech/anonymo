'use client';

import { useState } from 'react';
import type { ServiceRoute } from '../../lib/client/workspace';
import { formatAccountUsd6 } from '../../lib/client/account-records';
import { ProviderIcon } from './answer-card';

export function LiveRoutesPanel({
  routes,
  modelId,
}: {
  routes: ServiceRoute[];
  modelId?: string;
}) {
  const [selection, setSelection] = useState(modelId);
  const route = routes.find((item) => item.family === selection) ?? routes[0];
  if (!route)
    return (
      <p className="ct-intro">
        No reviewed model routes have been configured. Your saved projects
        remain available.
      </p>
    );
  return (
    <>
      <p className="ct-intro">
        Published terms for each connected model. A reviewed route card
        documents its limits; it does not establish private or attested
        execution.
      </p>
      <div className="ct-models" aria-label="Connected model routes">
        {routes.map((item) => (
          <button
            className="ct-model"
            type="button"
            key={item.versionId}
            aria-pressed={route.versionId === item.versionId}
            onClick={() => setSelection(item.family)}
          >
            <ProviderIcon id={item.family} size={24} />
            <span className="ct-model-name">
              <strong>{item.modelId}</strong>
              <small>{item.available ? 'Available' : 'Unavailable'}</small>
            </span>
          </button>
        ))}
      </div>
      <section className="ct-detail">
        <div className="ct-detail-heading">
          <h3>{route.modelId}</h3>
          <span className="ct-status ct-status-neutral">
            {route.card.level.replaceAll('_', ' ').toUpperCase()}
          </span>
        </div>
        <dl className="ct-facts">
          <div>
            <dt>Processing</dt>
            <dd>
              The inference gateway and the upstream model provider receive your request in
              plaintext.
            </dd>
          </div>
          <div>
            <dt>Upstream providers</dt>
            <dd>
              {route.card.upstreamProviders.join(', ') || 'Not disclosed'}
            </dd>
          </div>
          <div>
            <dt>Retention</dt>
            <dd>{route.card.retentionDisclosure}</dd>
          </div>
          <div>
            <dt>Training use</dt>
            <dd>{route.card.trainingUse.replaceAll('_', ' ')}</dd>
          </div>
          <div>
            <dt>Input / output per million tokens</dt>
            <dd>
              ${formatAccountUsd6(route.pricing.inputPerMillionUsd6)} / $
              {formatAccountUsd6(route.pricing.outputPerMillionUsd6)} ·{' '}
              {route.pricing.markupBps / 100}% service markup
            </dd>
          </div>
          <div>
            <dt>Terms version</dt>
            <dd>
              {route.version} · expires{' '}
              {new Date(route.expiresAt).toISOString()} UTC
            </dd>
          </div>
        </dl>
        <p className="ct-note">
          A request-specific reservation appears before approval. Actual usage
          is settled afterward; uncertain charges remain visibly pending.
        </p>
      </section>
    </>
  );
}
