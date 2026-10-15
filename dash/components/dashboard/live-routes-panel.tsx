'use client';

import { useT } from '@/lib/i18n';

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
  const t = useT();
  const [selection, setSelection] = useState(modelId);
  const route = routes.find((item) => item.family === selection) ?? routes[0];
  if (!route)
    return (
      <p className="ct-intro">
        {t(
          'No reviewed model routes have been configured. Your saved projects remain available.',
        )}
      </p>
    );
  return (
    <>
      <p className="ct-intro">
        {t(
          'Published terms for each connected model. A reviewed route card documents its limits; it does not establish private or attested execution.',
        )}
      </p>
      <div className="ct-models" aria-label={t('Connected model routes')}>
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
              <small>
                {item.available ? t('Available') : t('Unavailable')}
              </small>
            </span>
          </button>
        ))}
      </div>
      <section className="ct-detail">
        <div className="ct-detail-heading">
          <h3>{route.modelId}</h3>
          <span className="ct-status ct-status-neutral">
            {t(route.card.level.replaceAll('_', ' ').toUpperCase())}
          </span>
        </div>
        <dl className="ct-facts">
          <div>
            <dt>{t('Processing')}</dt>
            <dd>
              {t(
                'The inference gateway and the model host receive your request in plaintext.',
              )}
            </dd>
          </div>
          <div>
            <dt>{t('Upstream providers')}</dt>
            <dd>
              {route.card.upstreamProviders.join(', ') || t('Not disclosed')}
            </dd>
          </div>
          <div>
            <dt>{t('Retention')}</dt>
            <dd>{t(route.card.retentionDisclosure)}</dd>
          </div>
          <div>
            <dt>{t('Training use')}</dt>
            <dd>{t(route.card.trainingUse.replaceAll('_', ' '))}</dd>
          </div>
          <div>
            <dt>{t('Input / output per million tokens')}</dt>
            <dd>
              ${formatAccountUsd6(route.pricing.inputPerMillionUsd6)} / $
              {formatAccountUsd6(route.pricing.outputPerMillionUsd6)} ·{' '}
              {t('{percent}% service markup', {
                percent: route.pricing.markupBps / 100,
              })}
            </dd>
          </div>
          <div>
            <dt>{t('Terms version')}</dt>
            <dd>
              {t('{version} · expires {date} UTC', {
                version: route.version,
                date: new Date(route.expiresAt).toISOString(),
              })}
            </dd>
          </div>
        </dl>
        <p className="ct-note">
          {t(
            'A request-specific reservation appears before approval. Actual usage is settled afterward; uncertain charges remain visibly pending.',
          )}
        </p>
      </section>
    </>
  );
}
