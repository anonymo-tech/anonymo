'use client';
import { useCallback, useEffect, useImperativeHandle, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  Check,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type {
  ExitPlanInput,
  PlanningResponse,
  SavedExitPlan,
} from '../../lib/second-look/planning';
import type { LinkedWallet } from '../../lib/second-look/wallet';
import { planningResponse } from '../../lib/client/planning-contracts';
import { walletsResponse } from '../../lib/client/second-look-contracts';
import { shortAddress } from '../../lib/client/second-look';
import { tokenIdentity, utcTime } from './presentation';
import {
  ErrorNotice,
  TokenAvatar,
  useSecondLookApi,
  type PanelProps,
} from './shared';
import '@/app/dashboard/second-look-planning.css';

type View = 'cool-head' | 'exit-plans';
type Draft = {
  walletId: string;
  mint: string;
  target: string;
  targetSize: string;
  stop: string;
  stopSize: string;
  trailing: string;
};
const emptyDraft: Draft = {
  walletId: '',
  mint: '',
  target: '',
  targetSize: '100',
  stop: '',
  stopSize: '100',
  trailing: '',
};
const addressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function scaledDecimal(
  value: string,
  precision: number,
  wholeDigits = 18,
): bigint | null {
  if (value.length > 55) return null;
  const match = new RegExp(
    `^(0|[1-9][0-9]{0,${wholeDigits - 1}})(?:\\.([0-9]{1,${precision}}))?$`,
  ).exec(value.trim());
  if (!match) return null;
  return BigInt(match[1] + (match[2] ?? '').padEnd(precision, '0'));
}

function budgetText(value: string | null): string {
  if (value === null) return '';
  const digits = value.padStart(7, '0');
  return `${digits.slice(0, -6)}.${digits.slice(-6)}`.replace(/\.?0+$/, '');
}

function percentage(bps: number): string {
  return `${Math.trunc(bps / 100)}.${String(bps % 100).padStart(2, '0')}`.replace(
    /\.?0+$/,
    '',
  );
}

function timezones(): string[] {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return Array.from(
    new Set(['UTC', local, ...Intl.supportedValuesOf('timeZone')]),
  );
}

export function PlanningPanel({
  accountId,
  controlRef,
  onComposer,
  onDraft,
  onSignIn,
  onToast,
}: PanelProps) {
  const api = useSecondLookApi(accountId);
  const { run } = api;
  const [view, setView] = useState<View>('cool-head');
  const [record, setRecord] = useState<PlanningResponse | null>(null);
  const [wallets, setWallets] = useState<LinkedWallet[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [budget, setBudget] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [zones] = useState(timezones);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [formOpen, setFormOpen] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const applySettings = useCallback((next: PlanningResponse) => {
    setRecord(next);
    setEnabled(next.coolHead.enabled);
    setBudget(budgetText(next.coolHead.dailyBudgetUsd6));
    setTimezone(next.coolHead.timezone);
  }, []);

  const reload = useCallback(async () => {
    await run(async (request) => {
      const [next, linked] = await Promise.all([
        request('second-look/planning', { validate: planningResponse }),
        request('second-look/wallets', { validate: walletsResponse }),
      ]);
      applySettings(next);
      setWallets(linked.wallets);
      setDraft((current) => ({
        ...current,
        walletId: linked.wallets.some(
          (wallet) => wallet.id === current.walletId,
        )
          ? current.walletId
          : (linked.wallets[0]?.id ?? ''),
      }));
    });
  }, [run, applySettings]);

  useEffect(() => {
    if (accountId) void reload();
  }, [accountId, reload]);
  useEffect(() => {
    onComposer({
      placeholder: 'Paste a token mint to plan an exit…',
      label: 'Add to exit plan',
      busy: api.busy,
    });
  }, [onComposer, api.busy]);
  useImperativeHandle(controlRef, () => ({
    async submit(value) {
      if (!accountId) {
        onSignIn();
        return;
      }
      const mint = value.trim();
      if (!addressPattern.test(mint)) {
        api.setError('Enter the token’s public Solana mint address.');
        return;
      }
      api.setError('');
      setDraft((current) => ({ ...current, mint }));
      setView('exit-plans');
      setFormOpen(true);
      onDraft('');
      onToast('Token added. Set a target or stop below.');
    },
  }));

  async function saveBudget() {
    if (!record || api.busy) return;
    const amount = budget.trim() ? scaledDecimal(budget, 6, 9) : null;
    if (
      budget.trim() &&
      (amount === null || amount < 1n || amount > 999999999999999n)
    ) {
      api.setError(
        'Enter a positive USD budget below $1 billion, with up to six decimal places.',
      );
      return;
    }
    await run(async (request) => {
      const next = await request('second-look/planning/cool-head', {
        method: 'PATCH',
        body: {
          revision: record.revision,
          enabled,
          timezone,
          dailyBudgetUsd6: amount?.toString() ?? null,
        },
        validate: planningResponse,
      });
      applySettings(next);
      onToast('Cool Head preferences saved.');
    });
  }

  async function saveExit() {
    if (!record || api.busy) return;
    if (!wallets.some((wallet) => wallet.id === draft.walletId)) {
      api.setError('Choose a linked wallet. Add one in My Wallet if needed.');
      return;
    }
    const mint = draft.mint.trim();
    if (!addressPattern.test(mint)) {
      api.setError('Enter the token’s public Solana mint address.');
      return;
    }
    if (!draft.target.trim() && !draft.stop.trim()) {
      api.setError('Add a target price or a stop price.');
      return;
    }
    const leg = (price: string, size: string): ExitPlanInput['takeProfit'] => {
      if (!price.trim()) return null;
      const priceUnits = scaledDecimal(price, 18);
      const sizeBps = scaledDecimal(size, 2, 3);
      if (
        priceUnits === null ||
        priceUnits <= 0n ||
        sizeBps === null ||
        sizeBps < 1n ||
        sizeBps > 10000n
      )
        throw new Error(
          'Use a positive USD price and a position size from 0.01% to 100%.',
        );
      return { priceUsd: price.trim(), sizeBps: Number(sizeBps) };
    };
    let input: ExitPlanInput;
    try {
      const takeProfit = leg(draft.target, draft.targetSize);
      const stopLoss = leg(draft.stop, draft.stopSize);
      if (
        takeProfit &&
        stopLoss &&
        scaledDecimal(takeProfit.priceUsd, 18)! <=
          scaledDecimal(stopLoss.priceUsd, 18)!
      )
        throw new Error('The target price must be higher than the stop price.');
      const trailing = draft.trailing.trim()
        ? scaledDecimal(draft.trailing, 2, 2)
        : null;
      if (
        draft.trailing.trim() &&
        (!stopLoss || trailing === null || trailing < 1n || trailing > 9999n)
      )
        throw new Error(
          'A trailing stop needs a stop price and a distance from 0.01% to 99.99%.',
        );
      input = {
        walletId: draft.walletId,
        mint,
        takeProfit,
        stopLoss,
        trailingBps: trailing === null ? null : Number(trailing),
      };
    } catch (error) {
      api.setError(
        error instanceof Error ? error.message : 'Review your plan values.',
      );
      return;
    }
    await run(async (request) => {
      const next = await request('second-look/planning/exit-plans', {
        body: { revision: record.revision, ...input },
        validate: planningResponse,
      });
      setRecord(next);
      setDraft({ ...emptyDraft, walletId: draft.walletId });
      setFormOpen(false);
      onToast('Exit plan saved. Price monitoring is not connected.');
    });
  }

  async function removePlan(id: string) {
    if (!record || api.busy) return;
    await run(async (request) => {
      const next = await request(`second-look/planning/exit-plans/${id}`, {
        method: 'DELETE',
        body: { revision: record.revision },
        validate: planningResponse,
      });
      setRecord(next);
      setRemoving(null);
      onToast('Exit plan removed.');
    });
  }

  function updateDraft(field: keyof Draft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }
  const changed =
    record &&
    (enabled !== record.coolHead.enabled ||
      budget !== budgetText(record.coolHead.dailyBudgetUsd6) ||
      timezone !== record.coolHead.timezone);
  const ready = !!record && !api.busy;

  return (
    <section className="sl-planning" aria-label="Planning">
      <div className="sl-plan-toolbar">
        <nav className="sl-plan-switcher" aria-label="Planning tools">
          <button
            type="button"
            aria-pressed={view === 'cool-head'}
            onClick={() => setView('cool-head')}
          >
            Cool Head
          </button>
          <button
            type="button"
            aria-pressed={view === 'exit-plans'}
            onClick={() => setView('exit-plans')}
          >
            Exit plans
          </button>
        </nav>
        {accountId && (
          <button
            type="button"
            className="sl-text-button"
            disabled={api.busy}
            onClick={() => void reload()}
          >
            <RefreshCw size={13} />
            {api.busy ? 'Updating…' : 'Refresh saved'}
          </button>
        )}
      </div>
      <ErrorNotice message={api.error} />
      {!accountId ? (
        <div className="sl-plan-signin">
          <span className="sl-eyebrow">YOUR PLAN, BEFORE THE TRADE</span>
          <h2>
            {view === 'cool-head'
              ? 'Make room for a clear head.'
              : 'Decide where you would exit.'}
          </h2>
          <p>
            {view === 'cool-head'
              ? 'Set a daily budget and keep your preferences together.'
              : 'Save target and stop levels for a token in a linked wallet.'}
          </p>
          <button
            type="button"
            className="sl-button sl-primary"
            onClick={onSignIn}
          >
            Sign in to plan
          </button>
          <small>
            Plans are saved privately. Price monitoring and alerts are not
            connected.
          </small>
        </div>
      ) : !record ? (
        <output
          className="sl-plan-loading"
          aria-label={
            api.busy ? 'Loading your plans' : 'Plans could not be loaded'
          }
        >
          {api.busy ? (
            <>
              <span />
              <span />
              <span />
            </>
          ) : (
            <p>Refresh to load your saved preferences.</p>
          )}
        </output>
      ) : view === 'cool-head' ? (
        <div className="sl-plan-layout">
          <form
            className="sl-plan-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveBudget();
            }}
          >
            <div className="sl-plan-title">
              <h2>Give your day a limit.</h2>
              <p>A daily budget you decide before you trade.</p>
            </div>
            <label
              className="sl-plan-toggle"
              htmlFor="sl-plan-enabled"
              aria-label="Enable Cool Head"
            >
              <span>
                <strong>Cool Head</strong>
                <small>Save your daily budget preference</small>
              </span>
              <input
                id="sl-plan-enabled"
                type="checkbox"
                role="switch"
                aria-checked={enabled}
                checked={enabled}
                disabled={!ready}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              <span className="sl-plan-toggle-track" aria-hidden="true" />
            </label>
            <label className="sl-plan-field" htmlFor="sl-plan-budget">
              Daily budget · optional{' '}
              <span className="sl-plan-input-wrap">
                <span aria-hidden="true">$</span>
                <input
                  id="sl-plan-budget"
                  inputMode="decimal"
                  placeholder="Set an amount"
                  maxLength={16}
                  value={budget}
                  disabled={!ready}
                  onChange={(event) => setBudget(event.target.value)}
                />
                <span>USD</span>
              </span>
            </label>
            <label className="sl-plan-field" htmlFor="sl-plan-timezone">
              Day starts at midnight in
              <select
                id="sl-plan-timezone"
                value={timezone}
                disabled={!ready}
                onChange={(event) => setTimezone(event.target.value)}
              >
                {Array.from(new Set([timezone, ...zones])).map((zone) => (
                  <option key={zone} value={zone}>
                    {zone.replaceAll('_', ' ')}
                  </option>
                ))}
              </select>
            </label>
            <div className="sl-plan-form-footer">
              <button
                type="submit"
                className="sl-button sl-primary"
                disabled={!ready || !changed}
              >
                {api.busy ? 'Saving…' : 'Save preferences'}
              </button>
              {!changed && (
                <span>
                  <Check size={12} /> Up to date
                </span>
              )}
            </div>
          </form>
          <aside
            className="sl-plan-context"
            aria-label="Cool Head availability"
          >
            <span className="sl-plan-context-label">Your saved preference</span>
            <div className="sl-plan-budget-value">
              {record.coolHead.dailyBudgetUsd6 ? (
                <>
                  <span>$</span>
                  {budgetText(record.coolHead.dailyBudgetUsd6)}
                </>
              ) : (
                'Not set'
              )}
              <small>per day · USD</small>
            </div>
            <dl>
              <div>
                <dt>Preference</dt>
                <dd>{record.coolHead.enabled ? 'On' : 'Off'}</dd>
              </div>
              <div>
                <dt>Spending data</dt>
                <dd>Not connected</dd>
              </div>
              <div>
                <dt>Behavior reminders</dt>
                <dd>Not connected</dd>
              </div>
            </dl>
            <p>
              This saves your preference. Spending is not being tracked, and
              trades are never blocked or placed.
            </p>
          </aside>
        </div>
      ) : (
        <div className="sl-plan-exits">
          <div className="sl-plan-exit-heading">
            <div>
              <h2>Decide your exit.</h2>
              <p>Save the levels you want to revisit.</p>
            </div>
            <button
              type="button"
              className="sl-button sl-primary"
              disabled={!ready || formOpen || record.exitPlans.length >= 25}
              onClick={() => {
                setFormOpen(true);
                api.setError('');
              }}
            >
              <Plus size={14} />
              New plan
            </button>
          </div>
          <p className="sl-plan-status">
            <span aria-hidden="true" />
            Saved plans only · Price monitoring and alerts are not connected.
          </p>
          {formOpen && (
            <form
              className="sl-plan-exit-form"
              onSubmit={(event) => {
                event.preventDefault();
                void saveExit();
              }}
            >
              <div className="sl-plan-form-top">
                <h3>New exit plan</h3>
                <button
                  type="button"
                  className="sl-text-button"
                  disabled={api.busy}
                  onClick={() => setFormOpen(false)}
                >
                  Cancel
                </button>
              </div>
              <div className="sl-plan-identifiers">
                <label className="sl-plan-field" htmlFor="sl-plan-wallet">
                  Linked wallet
                  <select
                    id="sl-plan-wallet"
                    value={draft.walletId}
                    disabled={!ready}
                    onChange={(event) =>
                      updateDraft('walletId', event.target.value)
                    }
                  >
                    <option value="">Choose a wallet</option>
                    {wallets.map((wallet) => (
                      <option key={wallet.id} value={wallet.id}>
                        {wallet.label || shortAddress(wallet.address)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="sl-plan-field" htmlFor="sl-plan-mint">
                  Token mint
                  <input
                    id="sl-plan-mint"
                    placeholder="Solana mint address"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={draft.mint}
                    maxLength={44}
                    disabled={!ready}
                    onChange={(event) =>
                      updateDraft('mint', event.target.value)
                    }
                  />
                </label>
              </div>
              {!wallets.length && (
                <p className="sl-plan-inline-note">
                  Link a public address in My Wallet first. No wallet signature
                  is needed.
                </p>
              )}
              <div className="sl-plan-legs">
                <fieldset disabled={!ready}>
                  <legend>
                    <ArrowUpRight size={15} />
                    Target
                  </legend>
                  <label className="sl-plan-field" htmlFor="sl-plan-target">
                    Price · USD
                    <input
                      id="sl-plan-target"
                      placeholder="Optional"
                      inputMode="decimal"
                      maxLength={37}
                      value={draft.target}
                      onChange={(event) =>
                        updateDraft('target', event.target.value)
                      }
                    />
                  </label>
                  <label
                    className="sl-plan-field"
                    htmlFor="sl-plan-target-size"
                  >
                    Position · %
                    <input
                      id="sl-plan-target-size"
                      inputMode="decimal"
                      maxLength={6}
                      value={draft.targetSize}
                      onChange={(event) =>
                        updateDraft('targetSize', event.target.value)
                      }
                    />
                  </label>
                </fieldset>
                <fieldset disabled={!ready}>
                  <legend>
                    <ArrowDownRight size={15} />
                    Stop
                  </legend>
                  <label className="sl-plan-field" htmlFor="sl-plan-stop">
                    Price · USD
                    <input
                      id="sl-plan-stop"
                      placeholder="Optional"
                      inputMode="decimal"
                      maxLength={37}
                      value={draft.stop}
                      onChange={(event) =>
                        updateDraft('stop', event.target.value)
                      }
                    />
                  </label>
                  <label className="sl-plan-field" htmlFor="sl-plan-stop-size">
                    Position · %
                    <input
                      id="sl-plan-stop-size"
                      inputMode="decimal"
                      maxLength={6}
                      value={draft.stopSize}
                      onChange={(event) =>
                        updateDraft('stopSize', event.target.value)
                      }
                    />
                  </label>
                </fieldset>
              </div>
              <details className="sl-plan-advanced">
                <summary>Trailing stop</summary>
                <label className="sl-plan-field" htmlFor="sl-plan-trailing">
                  Distance from peak · %
                  <input
                    id="sl-plan-trailing"
                    inputMode="decimal"
                    maxLength={5}
                    placeholder="Optional"
                    value={draft.trailing}
                    disabled={!ready}
                    onChange={(event) =>
                      updateDraft('trailing', event.target.value)
                    }
                  />
                </label>
                <p>
                  This stores your intended trailing distance. A price feed is
                  needed to track a peak.
                </p>
              </details>
              <div className="sl-plan-form-footer">
                <button
                  type="submit"
                  className="sl-button sl-primary"
                  disabled={!ready || !wallets.length}
                >
                  {api.busy ? 'Saving…' : 'Save plan'}
                </button>
                <span>No trades are placed.</span>
              </div>
            </form>
          )}
          {record.exitPlans.length ? (
            <ul className="sl-plan-list">
              {record.exitPlans.map((plan) => (
                <PlanRow
                  key={plan.id}
                  plan={plan}
                  wallet={wallets.find((wallet) => wallet.id === plan.walletId)}
                  busy={api.busy}
                  confirming={removing === plan.id}
                  onConfirm={() => void removePlan(plan.id)}
                  onCancel={() => setRemoving(null)}
                  onRemove={() => setRemoving(plan.id)}
                />
              ))}
            </ul>
          ) : (
            !formOpen && (
              <div className="sl-plan-empty">
                <span className="sl-plan-empty-mark" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <h3>No exit plans yet.</h3>
                <p>Add a target, a stop, or both for a token you follow.</p>
                <button
                  type="button"
                  className="sl-text-button"
                  disabled={!ready}
                  onClick={() => setFormOpen(true)}
                >
                  Create your first plan <ArrowUpRight size={14} />
                </button>
              </div>
            )
          )}
          {!!record.exitPlans.length && (
            <p className="sl-plan-list-foot">
              {record.exitPlans.length} of 25 plans · One per token and wallet.
              To change a plan, remove it and save a new one.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function PlanRow({
  plan,
  wallet,
  busy,
  confirming,
  onRemove,
  onConfirm,
  onCancel,
}: {
  plan: SavedExitPlan;
  wallet?: LinkedWallet;
  busy: boolean;
  confirming: boolean;
  onRemove: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const token = tokenIdentity(plan.mint);
  return (
    <li className="sl-plan-row">
      <div className="sl-plan-row-identity">
        <TokenAvatar mint={plan.mint} size={32} />
        <div>
          <strong>
            {token.name === 'Solana token'
              ? shortAddress(plan.mint)
              : token.name}
          </strong>
          <small>
            {wallet?.label ||
              (wallet ? shortAddress(wallet.address) : 'Wallet unavailable')}
          </small>
        </div>
      </div>
      <dl className="sl-plan-row-levels">
        <div>
          <dt>Target</dt>
          <dd>
            {plan.takeProfit ? (
              <>
                ${plan.takeProfit.priceUsd}
                <small>
                  {percentage(plan.takeProfit.sizeBps)}% of position
                </small>
              </>
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div>
          <dt>Stop</dt>
          <dd>
            {plan.stopLoss ? (
              <>
                ${plan.stopLoss.priceUsd}
                <small>
                  {percentage(plan.stopLoss.sizeBps)}% of position
                  {plan.trailingBps !== null
                    ? ` · ${percentage(plan.trailingBps)}% trailing`
                    : ''}
                </small>
              </>
            ) : (
              '—'
            )}
          </dd>
        </div>
      </dl>
      <div className="sl-plan-row-action">
        {confirming ? (
          <div className="sl-plan-remove-confirm">
            <span>Remove this plan?</span>
            <button
              type="button"
              className="sl-text-button"
              disabled={busy}
              onClick={onCancel}
            >
              Keep
            </button>
            <button
              type="button"
              className="sl-text-button sl-plan-remove"
              disabled={busy}
              onClick={onConfirm}
            >
              Remove
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="sl-icon-button"
            title="Remove plan"
            aria-label={`Remove plan for ${shortAddress(plan.mint)}`}
            disabled={busy}
            onClick={onRemove}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
      <div className="sl-plan-row-status">
        <span>Saved · price monitoring not connected</span>
        <span>{utcTime(plan.updatedAt)} UTC</span>
      </div>
    </li>
  );
}
