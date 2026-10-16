'use client';
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
  type ReactNode,
} from 'react';
import { useT } from '../../lib/i18n';
import {
  isPerpAddress,
  isPerpResponse,
  PERP_LIMITS,
  type PerpCard,
  type PerpReport,
} from '../../lib/second-look/perp-check';
import {
  Busy,
  CopyButton,
  ErrorNotice,
  EvidenceLink,
  useSecondLookApi,
  type PanelProps,
} from './shared';

import { secondLookToolOn } from '../../lib/second-look/releases';
import {
  PERP_PLAN_LIMITS,
  PERP_PLAN_INVALID,
  PERP_PLAN_NETTING,
  parsePerpPlanInput,
  isPerpPlanResponse,
  isPlanMarketsResponse,
  type PerpPlanReport,
  type PlanMarket,
} from '../../lib/second-look/perp-plan';

const number = (n: number | null, digits = 8) =>
  n === null
    ? '—'
    : new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(
        n,
      );
const usd = (n: number | null) =>
  n === null
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(n);
const price = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  }).format(n);
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
function Limits() {
  const t = useT();
  return <p className="sl-perp-limits">{t(PERP_LIMITS)}</p>;
}
function PositionCard({
  p,
  effectiveLeverage,
}: {
  p: PerpCard;
  effectiveLeverage: number | null;
}) {
  const t = useT();
  const cash = (value: number | null) =>
    value === null
      ? t('Unavailable')
      : value < 0
        ? t('Paid {amount}', { amount: usd(-value) })
        : value > 0
          ? t('Received {amount}', { amount: usd(value) })
          : t('No net payment');
  return (
    <article className="sl-perp-card">
      <header>
        <h3>{p.coin}</h3>
        <span className="sl-perp-tag">
          {p.size > 0 ? t('Long') : t('Short')}
        </span>
      </header>
      <dl className="sl-perp-grid">
        <Fact label={t('Size')}>
          {number(Math.abs(p.size))} {p.coin}
        </Fact>
        <Fact label={t('Position notional · USD')}>{usd(p.notional)}</Fact>
        <Fact label={t('Entry price · USD')}>
          {p.entry === null ? t('None reported') : price(p.entry)}
        </Fact>
        <Fact label={t('Mark price · USD')}>
          {p.mark === null ? t('Unavailable') : price(p.mark)}
        </Fact>
        <Fact label={t('Liquidation price · Hyperliquid')}>
          {p.liquidation === null ? t('None reported') : price(p.liquidation)}
        </Fact>
        <Fact label={t('Move from mark to liquidation')}>
          {p.distance === null
            ? t('Unavailable')
            : t('{percent}%', { percent: number(p.distance * 100, 2) })}
        </Fact>
        <Fact label={t('Liquidation distance in daily σ')}>
          {p.distanceSigma === null
            ? t('Unavailable')
            : t('{value} σ', { value: number(p.distanceSigma, 2) })}
        </Fact>
        <Fact label={t('Daily σ · log returns')}>
          {p.sigma === null
            ? t('Unavailable')
            : t('{percent}%', { percent: number(p.sigma * 100, 2) })}
        </Fact>
      </dl>
      {p.distance !== null && p.distance <= 0 && (
        <p className="sl-notice">
          {t(
            'The reported mark is at or beyond the reported liquidation level. These reads are not atomic; recheck Hyperliquid.',
          )}
        </p>
      )}
      {p.daysAtDistance !== null && p.candleDays === 30 ? (
        <p>
          {t('Price moved this far within a day on {n} of the last 30 days.', {
            n: p.daysAtDistance,
          })}
        </p>
      ) : p.daysAtDistance !== null && p.candleDays > 0 ? (
        <p>
          {t(
            'Price moved this far within a day on {n} of {days} available days in the last 30 days.',
            { n: p.daysAtDistance, days: p.candleDays },
          )}
        </p>
      ) : null}
      <p className="sl-muted">
        {t(
          'Last 30 completed UTC days: {days} candles, {returns} consecutive daily log returns. Sample σ uses close-to-close returns; the day count uses (high − low) / open.',
          { days: p.candleDays, returns: p.returnCount },
        )}
      </p>
      <p className="sl-muted">
        {t(
          'The σ multiple divides the absolute percentage distance by daily log-return σ; this comparison is approximate. Zero or insufficient σ is shown as unavailable.',
        )}
      </p>
      {p.candleStatus === 'limit' && (
        <p className="sl-notice">
          {t(
            'Candle call limit reached: only the first 10 open positions get candles.',
          )}
        </p>
      )}
      {(p.candleStatus === 'unavailable' || p.candleDays === 0) && (
        <p className="sl-notice">
          {t('Daily candle evidence is unavailable for this position.')}
        </p>
      )}
      {p.stockLike && (
        <p className="sl-notice">
          {t('Overnight and weekend gaps can be larger than σ suggests.')}
        </p>
      )}
      <h4>{t('Funding · USD cash flow')}</h4>
      <dl className="sl-perp-grid">
        <Fact label={t('Last 7 days')}>{cash(p.funding7)}</Fact>
        <Fact label={t('Last 30 days')}>{cash(p.funding30)}</Fact>
        <Fact label={t('Current hourly funding rate')}>
          {p.hourlyRate === null
            ? t('Unavailable')
            : t('{percent}%', { percent: number(p.hourlyRate * 100, 6) })}
        </Fact>
        <Fact label={t('Projected funding over 7 more days')}>
          {cash(p.projected7)}
        </Fact>
      </dl>
      <p className="sl-muted">
        {t(
          'Projection = hourly rate × 24 × 7 × reported position notional, with the position side applied. Rates and notional change; this is not a forecast.',
        )}
      </p>
      <h4>{t('P&L after fees and funding · mixed windows')}</h4>
      <dl className="sl-perp-grid">
        <Fact label={t('Unrealized P&L · current')}>{usd(p.unrealized)}</Fact>
        <Fact label={t('Realized closed P&L · last 30 days')}>
          {usd(p.realized30)}
        </Fact>
        <Fact label={t('Fill fees · last 30 days')}>{usd(p.fees30)}</Fact>
        <Fact label={t('Funding cash flow · since open')}>
          {usd(p.fundingSinceOpen)}
        </Fact>
        <Fact label={t('Combined P&L · included items only')}>
          {usd(p.pnlAfter)}
        </Fact>
        <Fact label={t('Position leverage setting')}>
          {t('{value}× · {mode}', {
            value: number(p.leverage),
            mode: p.leverageType === 'cross' ? t('Cross') : t('Isolated'),
          })}
        </Fact>
        <Fact label={t('Account effective leverage')}>
          {effectiveLeverage === null
            ? t('Unavailable')
            : t('{value}×', { value: number(effectiveLeverage, 2) })}
        </Fact>
      </dl>
      <p className="sl-muted">
        {t(
          'Combined = current unrealized P&L + last-30-day fill closedPnl − those fill fees − Hyperliquid cumFunding.sinceOpen. Funding since open can extend beyond 30 days; this is not a complete account return.',
        )}
      </p>
      <p className="sl-muted">
        {t(
          'Source: Hyperliquid clearinghouseState, metaAndAssetCtxs, userFunding, userFillsByTime and candleSnapshot. Prices and P&L are approximate USD values; payments use reported USDC amounts.',
        )}
      </p>
      <Limits />
    </article>
  );
}

function PerpPlanCard({ r }: { r: PerpPlanReport }) {
  const t = useT();
  return (
    <article className="sl-perp-card" aria-label={t('Pre-trade estimate')}>
      <header>
        <h3>{t('Pre-trade estimate')}</h3>
        <span className="sl-perp-tag">
          {r.coin} · {r.side === 'long' ? t('Long') : t('Short')}
        </span>
      </header>
      <p className="sl-muted">
        {t(
          'Snapshot checked {time}. Estimates use the current mark, not an execution price.',
          { time: new Date(r.checkedAt).toISOString() },
        )}
      </p>
      {r.address && (
        <div className="sl-perp-address">
          <code>{r.address}</code>
        </div>
      )}
      <dl className="sl-perp-grid">
        <Fact label={t('Position notional · USD')}>{usd(r.notional)}</Fact>
        <Fact label={t('Mark price · USD')}>{price(r.mark)}</Fact>
        <Fact label={t('Estimated size · coin units')}>
          {number(r.positionSize)} {r.coin}
        </Fact>
        <Fact label={t('Chosen leverage and margin mode')}>
          {t('{value}× · {mode}', {
            value: r.leverage,
            mode: r.marginMode === 'cross' ? t('Cross') : t('Isolated'),
          })}
        </Fact>
        <Fact label={t('Initial margin · USD')}>{usd(r.initialMargin)}</Fact>
        <Fact label={t('New position maintenance margin · USD')}>
          {usd(r.maintenance)}
        </Fact>
        <Fact label={t('Collateral used in estimate · USD')}>
          {usd(r.collateral)}
        </Fact>
        <Fact label={t('Margin available after maintenance · USD')}>
          {usd(r.marginAvailable)}
        </Fact>
        <Fact label={t('Estimated liquidation price · USD')}>
          {r.liquidation > 0
            ? price(r.liquidation)
            : t('No positive liquidation level in this model')}
        </Fact>
        <Fact label={t('Move from mark to liquidation')}>
          {r.distance === null
            ? t('Unavailable')
            : t('{percent}%', { percent: number(r.distance * 100, 2) })}
        </Fact>
        <Fact label={t('Liquidation distance in daily σ')}>
          {r.distanceSigma === null
            ? t('Unavailable')
            : t('{value} σ', { value: number(r.distanceSigma, 2) })}
        </Fact>
        <Fact label={t('Daily σ · log returns')}>
          {r.sigma === null
            ? t('Unavailable')
            : t('{percent}%', { percent: number(r.sigma * 100, 2) })}
        </Fact>
        <Fact label={t('Current hourly funding rate')}>
          {t('{percent}%', { percent: number(r.hourlyRate * 100, 6) })}
        </Fact>
        <Fact label={t('Funding over 7 days at the current rate')}>
          {r.projected7 < 0
            ? t('Paid {amount}', { amount: usd(-r.projected7) })
            : r.projected7 > 0
              ? t('Received {amount}', { amount: usd(r.projected7) })
              : t('No net payment')}
        </Fact>
        {r.address && (
          <>
            <Fact label={t('Account effective leverage · now')}>
              {r.effectiveNow === null
                ? t('Unavailable')
                : t('{value}×', { value: number(r.effectiveNow, 2) })}
            </Fact>
            <Fact label={t('Account effective leverage · after this trade')}>
              {r.effectiveAfter === null
                ? t('Unavailable')
                : t('{value}×', { value: number(r.effectiveAfter, 2) })}
            </Fact>
          </>
        )}
      </dl>
      {r.marginAvailable <= 0 && (
        <p className="sl-notice">
          {t(
            'Collateral does not exceed the estimated maintenance requirement. The estimated liquidation level is at or beyond the mark.',
          )}
        </p>
      )}
      {r.liquidation <= 0 && (
        <p className="sl-notice">
          {t(
            'A nonpositive model result does not remove liquidation risk or collateral loss.',
          )}
        </p>
      )}
      {r.daysAtDistance !== null && r.candleDays === 30 ? (
        <p>
          {t('Price moved this far within a day on {n} of the last 30 days.', {
            n: r.daysAtDistance,
          })}
        </p>
      ) : r.daysAtDistance !== null && r.candleDays > 0 ? (
        <p>
          {t(
            'Price moved this far within a day on {n} of {days} available days in the last 30 days.',
            { n: r.daysAtDistance, days: r.candleDays },
          )}
        </p>
      ) : null}
      <p className="sl-muted">
        {t(
          'Last 30 completed UTC days: {days} candles, {returns} consecutive daily log returns. Sample σ uses close-to-close returns; the day count uses (high − low) / open.',
          { days: r.candleDays, returns: r.returnCount },
        )}
      </p>
      <p className="sl-muted">
        {t(
          'The σ multiple divides the absolute percentage distance by daily log-return σ; this comparison is approximate. Zero or insufficient σ is shown as unavailable.',
        )}
      </p>
      {r.stockLike && (
        <p className="sl-notice">
          {t('Overnight and weekend gaps can be larger than σ suggests.')}
        </p>
      )}
      <p className="sl-muted">
        {t(
          'Funding projection = current hourly rate × 168 hours × USD notional, with the side applied. Rates and notional change; this is not a forecast.',
        )}
      </p>
      <p className="sl-muted">
        {t(
          'Maintenance = notional / (2 × maxLeverage). This simplified formula uses the main universe maximum, without position-size margin tiers, fees or slippage.',
        )}
      </p>
      <p className="sl-muted">
        {r.marginMode === 'isolated'
          ? t(
              'Isolated estimate uses only this trade’s initial margin, without additional margin.',
            )
          : t(
              'Cross margin: this estimate uses only this trade’s own margin. Your whole account backs a cross position, so the real liquidation price can be far from this one. Hyperliquid shows the exact price once the trade is open.',
            )}
      </p>
      {r.address && (
        <>
          <p className="sl-muted">
            {t(
              'Effective leverage after = (current total notional + new notional) / current account value. Account value is held fixed; zero or negative value is unavailable. Default perp account only; reads are not atomic.',
            )}
          </p>
          <h4>{t('Cool Head')}</h4>
          {r.losingStreak !== null && r.losingStreak >= 5 ? (
            <output className="sl-notice">
              {t(
                "You've closed {n} losing trades in a row. A pause might help.",
                { n: r.losingStreak },
              )}
            </output>
          ) : r.losingStreak === null ? (
            <p>
              {t('Too many fills in 30 days to count a recent streak reliably.')}
            </p>
          ) : (
            <p>
              {t('Losing trades in a row, most recent first: {n}.', {
                n: r.losingStreak,
              })}
            </p>
          )}
          <p className="sl-muted">
            {t(
              'Cool Head counts closing orders newest first across coins; fills of one order count as one trade. Opening and spot fills are skipped, and a break-even or winning close ends the streak. One 30-day response, {count} fills; older history may be missing. This reminder never blocks.',
              { count: r.fillsCount },
            )}
          </p>
          {r.fillsCapped && (
            <p className="sl-notice">
              {t(
                'Fill response reached 2,000 records. Recent closes may be missing, so the streak may be incomplete.',
              )}
            </p>
          )}
        </>
      )}
      <p className="sl-muted">
        {t(
          'Source: Hyperliquid metaAndAssetCtxs and candleSnapshot; clearinghouseState and userFillsByTime when an address is supplied. USD amounts are approximate.',
        )}
      </p>
      <EvidenceLink href="https://api.hyperliquid.xyz/info">
        {t('Source: Hyperliquid /info')}
      </EvidenceLink>
      <p className="sl-perp-limits">{t(PERP_PLAN_LIMITS)}</p>
    </article>
  );
}

function PerpPlanForm({
  accountId,
  onSignIn,
}: Pick<PanelProps, 'accountId' | 'onSignIn'>) {
  const t = useT();
  const api = useSecondLookApi(accountId),
    run = api.run;
  const [markets, setMarkets] = useState<PlanMarket[]>([]);
  const [coin, setCoin] = useState('');
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [notional, setNotional] = useState('');
  const [leverage, setLeverage] = useState('1');
  const [marginMode, setMarginMode] = useState<'cross' | 'isolated'>(
    'isolated',
  );
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [report, setReport] = useState<PerpPlanReport | null>(null);
  const loadMarkets = useCallback(
    () =>
      run(async (request) => {
        const response = await request('second-look/perp-plan/markets', {
          method: 'POST',
          body: {},
          validate: isPlanMarketsResponse,
        });
        setMarkets(response.markets);
        setCoin(response.markets[0].coin);
      }),
    [run],
  );
  useEffect(() => {
    if (accountId) void loadMarkets();
  }, [accountId, loadMarkets]);
  const selected = markets.find((m) => m.coin === coin);
  // An edited form invalidates the previous estimate immediately.
  const invalidate = () => {
    setReport(null);
    setError('');
  };
  return (
    <section aria-label={t('Before you trade')}>
      <h3>{t('Before you trade')}</h3>
      <p className="sl-muted">
        {t(
          'Read-only estimate for a new position. Nothing to sign and no order is placed.',
        )}
      </p>
      <p className="sl-muted">{t(PERP_PLAN_NETTING)}</p>
      {!accountId ? (
        <button type="button" className="sl-button" onClick={onSignIn}>
          {t('Sign in to estimate')}
        </button>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setError('');
            setReport(null);
            let plan;
            try {
              plan = parsePerpPlanInput({
                coin,
                side,
                notional: notional.trim(),
                leverage: Number(leverage),
                marginMode,
                ...(address.trim() ? { address: address.trim() } : {}),
              });
              if (!selected || plan.leverage > selected.maxLeverage)
                throw Error();
            } catch {
              setError(PERP_PLAN_INVALID);
              return;
            }
            void run(async (request) => {
              const response = await request('second-look/perp-plan/check', {
                method: 'POST',
                body: plan,
                validate: isPerpPlanResponse,
              });
              setReport(response.report);
            });
          }}
        >
          <fieldset disabled={api.busy} className="sl-perp-plan-fields">
            <div className="sl-perp-grid">
              <label>
                {t('Coin')}
                <select
                  required
                  value={coin}
                  onChange={(e) => {
                    invalidate();
                    setCoin(e.target.value);
                    setLeverage('1');
                  }}
                >
                  <option value="" disabled>
                    {t('Choose a coin')}
                  </option>
                  {markets.map((m) => (
                    <option key={m.coin} value={m.coin}>
                      {m.coin}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('Side')}
                <select
                  value={side}
                  onChange={(e) => {
                    invalidate();
                    setSide(e.target.value as 'long' | 'short');
                  }}
                >
                  <option value="long">{t('Long')}</option>
                  <option value="short">{t('Short')}</option>
                </select>
              </label>
              <label>
                {t('Size in USD notional')}
                <input
                  required
                  inputMode="decimal"
                  maxLength={80}
                  value={notional}
                  onChange={(e) => {
                    invalidate();
                    setNotional(e.target.value);
                  }}
                />
              </label>
              <label>
                {t('Leverage · 1 to {max}×', {
                  max: selected?.maxLeverage ?? 1,
                })}
                <input
                  required
                  type="number"
                  min={1}
                  max={selected?.maxLeverage ?? 1}
                  step={1}
                  value={leverage}
                  onChange={(e) => {
                    invalidate();
                    setLeverage(e.target.value);
                  }}
                />
              </label>
              <label>
                {t('Margin mode')}
                <select
                  value={marginMode}
                  onChange={(e) => {
                    invalidate();
                    setMarginMode(e.target.value as 'cross' | 'isolated');
                  }}
                >
                  <option value="isolated">{t('Isolated')}</option>
                  <option value="cross">{t('Cross')}</option>
                </select>
              </label>
              <label>
                {t('Account address · optional')}
                <input
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={42}
                  placeholder={t('0x followed by 40 hex characters')}
                  value={address}
                  onChange={(e) => {
                    invalidate();
                    setAddress(e.target.value);
                  }}
                />
              </label>
            </div>
            <button
              className="sl-button"
              type="submit"
              disabled={!markets.length}
            >
              {t('Estimate this trade')}
            </button>
            {!markets.length && (
              <button
                type="button"
                className="sl-button"
                onClick={() => void loadMarkets()}
              >
                {t('Load main perp universe')}
              </button>
            )}
          </fieldset>
        </form>
      )}
      <ErrorNotice
        message={
          error
            ? t(error)
            : api.error
              ? t(
                  'The estimate could not be verified. Check your inputs, use a coin without an existing position in this account, or try again shortly.',
                )
              : ''
        }
      />
      {api.busy && <Busy label={t('Reading estimate inputs…')} />}
      {report ? (
        <PerpPlanCard r={report} />
      ) : (
        <p className="sl-perp-limits">{t(PERP_PLAN_LIMITS)}</p>
      )}
    </section>
  );
}

/** Mounted only behind the held perp switch. Uses the workspace's single composer. */
function PerpPanelContent({
  accountId,
  controlRef,
  onComposer,
  onDraft,
  onSignIn,
  onToast,
}: PanelProps) {
  const t = useT();
  const api = useSecondLookApi(accountId),
    run = api.run;
  const [report, setReport] = useState<PerpReport | null>(null);
  const [error, setError] = useState('');
  const inspect = useCallback(
    async (value: string) => {
      const address = value.trim();
      setError('');
      setReport(null);
      if (!isPerpAddress(address)) {
        setError(
          'Enter a Hyperliquid address: 0x followed by 40 hex characters.',
        );
        return;
      }
      if (!accountId) {
        onSignIn();
        return;
      }
      await run(async (request) => {
        const response = await request('second-look/perp/check', {
          method: 'POST',
          body: { address },
          validate: isPerpResponse,
        });
        setReport(response.report);
        onDraft('');
      });
    },
    [accountId, onDraft, onSignIn, run],
  );
  useImperativeHandle(controlRef, () => ({ submit: inspect }), [inspect]);
  useEffect(
    () =>
      onComposer({
        placeholder: t('Paste a Hyperliquid account address…'),
        label: t('Check perps'),
        busy: api.busy,
      }),
    [onComposer, api.busy, t],
  );
  return (
    <section className="sl-perp" aria-label={t('Perp Check')}>
      <style>{`
      .sl-perp { min-width:0; --sl-accent:#EA2A22; }
      .sl-perp h2 { font-size:26px; } .sl-perp h4 { margin:20px 0 8px; font-weight:500; }
      .sl-perp-card { border:1px solid var(--sl-line); border-radius:10px; padding:20px; margin:18px 0; background:#fff; min-width:0; }
      .sl-perp-card header { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
      .sl-perp-card h3 { font-size:19px; overflow-wrap:anywhere; }
      .sl-perp-tag { color:#EA2A22; font-size:11px; border:1px solid #f2d6d4; border-radius:4px; padding:2px 7px; }
      .sl-perp-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr)); gap:18px; margin:20px 0; }
      .sl-perp-grid dt { color:#707070; font-size:11px; } .sl-perp-grid dd { margin:5px 0 0; font:13px/1.6 'JetBrains Mono',monospace; overflow-wrap:anywhere; }
      .sl-perp output.sl-notice { display:block; }
      .sl-perp p { font-size:12px; overflow-wrap:anywhere; } .sl-perp-limits { border-top:1px solid var(--sl-line); padding-top:14px; color:#707070; font-size:11px!important; }
      .sl-perp-address { display:flex; gap:8px; align-items:center; min-width:0; } .sl-perp-address code { min-width:0; overflow-wrap:anywhere; font:11px/1.6 'JetBrains Mono',monospace; }
      .sl-perp-plan-fields { border:0; padding:0; margin:0; min-width:0; }
      .sl-perp-plan-fields label { display:flex; flex-direction:column; gap:6px; min-width:0; font-size:12px; }
      .sl-perp-plan-fields input,.sl-perp-plan-fields select { width:100%; min-width:0; box-sizing:border-box; border:1px solid var(--sl-line); border-radius:6px; background:#fff; padding:10px; font:inherit; }
      .sl-perp-plan-fields input { font-family:'JetBrains Mono',monospace; }
      .sl-perp-plan-fields :focus-visible { outline:2px solid #EA2A22; outline-offset:2px; }
      @media(max-width:400px) { .sl-perp-card { padding:14px; } }
    `}</style>
      <h2>{t('Perp Check')}</h2>
      <p className="sl-muted">
        {t(
          'Paste a public Hyperliquid account address in the composer. Read-only research. No signature or API key needed.',
        )}
      </p>
      <ErrorNotice
        message={
          error
            ? t(error)
            : api.error
              ? t(
                  'Perp Check could not verify the data. Check your sign-in and address, then try again shortly.',
                )
              : ''
        }
      />
      {api.busy && <Busy label={t('Reading Hyperliquid account data…')} />}
      {report && (
        <>
          <article className="sl-perp-card">
            <header>
              <h3>{t('Account summary')}</h3>
              <EvidenceLink href="https://api.hyperliquid.xyz/info">
                {t('Source: Hyperliquid /info')}
              </EvidenceLink>
            </header>
            <div className="sl-perp-address">
              <code>{report.address}</code>
              <CopyButton
                value={report.address}
                label={t('Copy address')}
                onToast={(message) => onToast(t(message))}
              />
            </div>
            <p className="sl-muted">
              {t('Checked {time}. History window: {start} to {end}.', {
                time: new Date(report.checkedAt).toISOString(),
                start: new Date(report.startTime).toISOString(),
                end: new Date(report.checkedAt).toISOString(),
              })}
            </p>
            <dl className="sl-perp-grid">
              <Fact label={t('Account value · USD')}>
                {usd(report.accountValue)}
              </Fact>
              <Fact label={t('Withdrawable · USD')}>
                {usd(report.withdrawable)}
              </Fact>
              <Fact label={t('Total position notional · USD')}>
                {usd(report.totalNotional)}
              </Fact>
              <Fact label={t('Account effective leverage')}>
                {report.effectiveLeverage === null
                  ? t('Unavailable')
                  : t('{value}×', {
                      value: number(report.effectiveLeverage, 2),
                    })}
              </Fact>
              <Fact label={t('Funding cash flow · last 30 days')}>
                {usd(report.funding30)}
              </Fact>
              <Fact label={t('Realized closed P&L · last 30 days')}>
                {usd(report.realized30)}
              </Fact>
              <Fact label={t('Fill fees · last 30 days')}>
                {usd(report.fees30)}
              </Fact>
            </dl>
            <p className="sl-muted">
              {t(
                'Effective leverage = marginSummary.totalNtlPos / marginSummary.accountValue. Unavailable when account value is zero or negative. This is a current snapshot, not a historical median.',
              )}
            </p>
            <p className="sl-muted">
              {t(
                'Default perp account scope only. Separate builder DEX accounts, spot balances and other subaccounts are not enumerated. Reads are not atomic; missing market context is shown as unavailable.',
              )}
            </p>
            <p className="sl-muted">
              {t(
                'One response per history request; no pagination. {fills} fills and {payments} funding records returned. The 30-day history may be incomplete. Positive funding cash flow is received; negative is paid.',
                { fills: report.fillsCount, payments: report.fundingCount },
              )}
            </p>
            <p className="sl-muted">
              {t(
                'Spot fills are excluded from P&L totals. Unsupported fee currencies on perp fills make the check unavailable.',
              )}
            </p>
            {report.fillsCapped && (
              <p className="sl-notice">
                {t(
                  'Fill response reached 2,000 records. The 30-day fill totals are capped and may omit later activity.',
                )}
              </p>
            )}
            {report.fundingPossiblyCapped && (
              <p className="sl-notice">
                {t(
                  'Funding response contains at least 500 records and may be capped. Funding totals may be incomplete.',
                )}
              </p>
            )}
            {!report.positions.length && <p>{t('No open perp positions.')}</p>}
            <Limits />
          </article>
          {report.positions.map((p) => (
            <PositionCard
              key={p.coin}
              p={p}
              effectiveLeverage={report.effectiveLeverage}
            />
          ))}
        </>
      )}
      {!report && !api.busy && <Limits />}
      {secondLookToolOn('perpPlan') && (
        <PerpPlanForm accountId={accountId} onSignIn={onSignIn} />
      )}
    </section>
  );
}

export function PerpPanel(props: PanelProps) {
  return <PerpPanelContent key={props.accountId ?? 'signed-out'} {...props} />;
}
