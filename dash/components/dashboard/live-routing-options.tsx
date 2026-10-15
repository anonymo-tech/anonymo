'use client';

import { useT } from '@/lib/i18n';
import { ROUTING_TASKS, ROUTING_TASK_LABELS } from '../../lib/model-routing';
import {
  effectiveReservationCap,
  formatFriendlyUsd6,
  type WorkspaceRoutingPreferences,
} from '../../lib/client/workspace';

export const DEFAULT_ROUTING_PREFERENCES: WorkspaceRoutingPreferences = {
  mode: 'manual',
  task: 'general',
  budgetUsd: '',
};

export function LiveRoutingOptions({
  value,
  onChange,
  availableUsd6 = null,
}: {
  value: WorkspaceRoutingPreferences;
  onChange: (value: WorkspaceRoutingPreferences) => void;
  /** Available balance; an empty budget is capped by it as well as the service limit. */
  availableUsd6?: string | null;
}) {
  const t = useT();
  const cap = effectiveReservationCap('10000000', availableUsd6);
  return (
    <div>
      <label className="cw-strict">
        <input
          type="checkbox"
          checked={value.mode === 'auto'}
          onChange={(event) =>
            onChange({
              ...value,
              mode: event.target.checked ? 'auto' : 'manual',
            })
          }
        />
        <span>
          {t('Auto route this question')}
          <small>
            {t('Choose one reviewed route for your task and budget.')}
          </small>
        </span>
      </label>
      {value.mode === 'auto' && (
        <div className="cw-simple-form">
          <label>
            {t('Task')}{' '}
            <select
              value={value.task}
              onChange={(event) => {
                const task = ROUTING_TASKS.find(
                  (task) => task === event.target.value,
                );
                if (task) onChange({ ...value, task });
              }}
            >
              {ROUTING_TASKS.map((task) => (
                <option key={task} value={task}>
                  {t(ROUTING_TASK_LABELS[task])}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('Maximum reservation (USD)')}
            <input
              inputMode="decimal"
              aria-label={t(
                'Maximum automatic route reservation in US dollars',
              )}
              placeholder={
                cap.limitedByBalance
                  ? t('Up to {amount} · your balance', {
                      amount: formatFriendlyUsd6(cap.usd6).slice(1),
                    })
                  : t('10.00 service limit')
              }
              value={value.budgetUsd}
              maxLength={14}
              onChange={(event) =>
                onChange({ ...value, budgetUsd: event.target.value })
              }
            />
          </label>
          <p className="ct-note">
            {t(
              'Auto compares the reviewed routes supplied for this task. Review the exact model and cost before sending. Vision and attachments are not supported.',
            )}
          </p>
          {value.task === 'long_context' && (
            <p className="ct-note">
              {t(
                'Relevant saved conversation is loaded before review. Input limits depend on the selected model; the review explains any excluded exchanges.',
              )}
            </p>
          )}
        </div>
      )}
      <p className="ct-note">
        {t(
          'Mention a model with @claude or {mention} to choose it for one question. Mentions override Auto; choosing a model below returns to Manual.',
          { mention: '@{model-id}' },
        )}
      </p>
    </div>
  );
}
