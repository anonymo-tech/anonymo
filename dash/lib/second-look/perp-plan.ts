import {
  DAY_MS,
  PERP_FILL_LIMIT,
  dailyRisk,
  isPerpAddress,
  liquidationDistance,
  perpNumber,
  projectHourlyFunding,
  stockLike,
  type PerpMarket,
  type PerpCandle,
  type parsePerpAccount,
  type parsePerpFills,
} from './perp-check.ts';

export const PERP_PLAN_LIMITS =
  "An estimate from Hyperliquid's published formula. Fees, funding and price moves change it. Perps can lose your whole collateral fast. Nothing is placed or stored. Not investment advice.";
export const PERP_PLAN_INVALID =
  'Choose a main-universe coin, long or short, positive USD notional, whole-number leverage within the coin limit, cross or isolated margin, and an optional valid Hyperliquid address.';
export const PERP_PLAN_NETTING =
  'This estimate supports a new coin only. If this account already holds the coin, adding, reducing or reversing that position needs netting calculations.';
export type PerpPlanInput = {
  coin: string;
  side: 'long' | 'short';
  notional: string;
  leverage: number;
  marginMode: 'cross' | 'isolated';
  address?: string;
};
function check(v: unknown): asserts v {
  if (!v) throw Error(PERP_PLAN_INVALID);
}
function finite(v: number) {
  check(Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER);
  return v;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export function parsePerpPlanInput(v: unknown): PerpPlanInput {
  check(object(v));
  check(
    Object.keys(v).every((k) =>
      [
        'coin',
        'side',
        'notional',
        'leverage',
        'marginMode',
        'address',
      ].includes(k),
    ),
  );
  check(
    typeof v.coin === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(v.coin),
  );
  check(v.side === 'long' || v.side === 'short');
  check(perpNumber(v.notional) > 0);
  check(
    typeof v.leverage === 'number' &&
      Number.isInteger(v.leverage) &&
      v.leverage >= 1 &&
      v.leverage <= 1000,
  );
  check(v.marginMode === 'cross' || v.marginMode === 'isolated');
  check(v.address === undefined || isPerpAddress(v.address));
  return {
    coin: v.coin,
    side: v.side,
    notional: v.notional as string,
    leverage: v.leverage,
    marginMode: v.marginMode,
    ...(v.address === undefined ? {} : { address: v.address }),
  };
}
export function validatePlanMarket(
  input: PerpPlanInput,
  markets: PerpMarket[],
) {
  const market = markets.find(
    (m) => m.coin === input.coin && !m.coin.includes(':'),
  );
  check(market && input.leverage <= market.maxLeverage);
  return market;
}
/** Positive coin units; marginAvailable already subtracts maintenance across the chosen scope.
 * For a live-position comparison pass its current mark, abs(szi), side, and margin surplus.
 * A zero/negative result means this simplified model has no positive liquidation level.
 */
export function estimateLiquidationPrice(input: {
  price: number;
  side: 1 | -1;
  positionSize: number;
  marginAvailable: number;
  maxLeverage: number;
}) {
  const { price, side, positionSize, marginAvailable, maxLeverage } = input;
  [price, positionSize, marginAvailable, maxLeverage].forEach(finite);
  check(price > 0 && positionSize > 0 && (side === 1 || side === -1));
  check(
    Number.isInteger(maxLeverage) && maxLeverage >= 1 && maxLeverage <= 1000,
  );
  const l = 1 / (2 * maxLeverage);
  return finite(
    price - (side * marginAvailable) / positionSize / (1 - l * side),
  );
}
/** Consecutive losing closing orders, newest first. Fills of one order (same oid) count as one trade. */
export function losingCloseStreak(fills: ReturnType<typeof parsePerpFills>) {
  const orders = new Map<string, { time: number; pnl: number }>();
  for (const f of fills) {
    const closing =
      !f.spot &&
      (f.closedPnl !== 0 ||
        f.dir === 'Close Long' ||
        f.dir === 'Close Short' ||
        f.dir === 'Long > Short' ||
        f.dir === 'Short > Long');
    if (!closing) continue;
    const key = f.oid === null ? `${f.coin}:${f.time}` : `oid:${f.oid}`;
    const order = orders.get(key) ?? { time: 0, pnl: 0 };
    order.time = Math.max(order.time, f.time);
    order.pnl += f.closedPnl;
    orders.set(key, order);
  }
  let count = 0;
  for (const order of [...orders.values()].sort((x, y) => y.time - x.time)) {
    if (order.pnl >= 0) break;
    count++;
  }
  return count;
}
export function buildPerpPlan(input: {
  plan: PerpPlanInput;
  markets: PerpMarket[];
  candles: PerpCandle[];
  account?: ReturnType<typeof parsePerpAccount>;
  fills?: ReturnType<typeof parsePerpFills>;
  now: number;
}) {
  const plan = parsePerpPlanInput(input.plan);
  const market = validatePlanMarket(plan, input.markets);
  check(Number.isSafeInteger(input.now) && input.now > 30 * DAY_MS);
  check(Boolean(plan.address) === Boolean(input.account));
  check(!plan.address || input.fills !== undefined);
  const account = input.account;
  if (account?.positions.some((p) => p.coin === plan.coin))
    throw Error(PERP_PLAN_NETTING);
  const notional = perpNumber(plan.notional),
    side = plan.side === 'long' ? 1 : -1;
  const initialMargin = finite(notional / plan.leverage);
  const maintenance = finite(notional / (2 * market.maxLeverage));
  // The estimate always uses this trade's own margin. Checked against live positions, it matches
  // Hyperliquid for isolated margin at every size, but for cross margin an account's collateral and
  // positions elsewhere can move the real liquidation price far from any estimate made from public data.
  const existingMaintenance = 0;
  const collateral = initialMargin;
  const marginAvailable = finite(
    collateral - existingMaintenance - maintenance,
  );
  const positionSize = finite(notional / market.mark);
  const liquidation = estimateLiquidationPrice({
    price: market.mark,
    side,
    positionSize,
    marginAvailable,
    maxLeverage: market.maxLeverage,
  });
  const distance =
    liquidation > 0
      ? liquidationDistance(market.mark, liquidation, side)
      : null;
  const candleEnd = Math.floor(input.now / DAY_MS) * DAY_MS - 1;
  const candleStart = candleEnd + 1 - 30 * DAY_MS;
  const fills = (input.fills ?? []).filter(
    (f) => f.time >= input.now - 30 * DAY_MS && f.time <= input.now,
  );
  return {
    coin: plan.coin,
    side: plan.side,
    marginMode: plan.marginMode,
    basis: 'own-margin' as const,
    address: plan.address ?? null,
    checkedAt: input.now,
    candleStart,
    candleEnd,
    mark: market.mark,
    maxLeverage: market.maxLeverage,
    leverage: plan.leverage,
    notional,
    positionSize,
    initialMargin,
    maintenance,
    existingMaintenance,
    collateral,
    marginAvailable,
    liquidation,
    distance,
    ...dailyRisk(
      input.candles.filter((c) => c.time >= candleStart && c.time <= candleEnd),
      distance,
    ),
    stockLike: stockLike(plan.coin, input.markets),
    hourlyRate: market.funding,
    projected7: projectHourlyFunding(market.funding, notional, side),
    effectiveNow:
      account && account.accountValue > 0
        ? finite(account.totalNotional / account.accountValue)
        : null,
    effectiveAfter:
      account && account.accountValue > 0
        ? finite((account.totalNotional + notional) / account.accountValue)
        : null,
    // A capped 30-day history can miss the newest fills, so no streak is claimed then.
    losingStreak:
      plan.address && input.fills?.length !== PERP_FILL_LIMIT
        ? losingCloseStreak(fills)
        : null,
    fillsCount: input.fills?.length ?? 0,
    fillsCapped: input.fills?.length === PERP_FILL_LIMIT,
  };
}
export type PerpPlanReport = ReturnType<typeof buildPerpPlan>;
export type PlanMarket = Pick<PerpMarket, 'coin' | 'maxLeverage'>;
export function isPlanMarketsResponse(
  v: unknown,
): v is { markets: PlanMarket[] } {
  return (
    object(v) &&
    Array.isArray(v.markets) &&
    v.markets.length > 0 &&
    v.markets.length <= 2000 &&
    new Set(v.markets.map((m) => (object(m) ? m.coin : null))).size ===
      v.markets.length &&
    v.markets.every(
      (m) =>
        object(m) &&
        typeof m.coin === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(m.coin) &&
        typeof m.maxLeverage === 'number' &&
        Number.isInteger(m.maxLeverage) &&
        m.maxLeverage >= 1 &&
        m.maxLeverage <= 1000,
    )
  );
}
export function isPerpPlanResponse(
  v: unknown,
): v is { report: PerpPlanReport } {
  if (!object(v) || !object(v.report)) return false;
  const r = v.report;
  const nullable = [
    'distance',
    'sigma',
    'daysAtDistance',
    'distanceSigma',
    'effectiveNow',
    'effectiveAfter',
    'losingStreak',
  ];
  const numeric = [
    'checkedAt',
    'candleStart',
    'candleEnd',
    'mark',
    'maxLeverage',
    'leverage',
    'notional',
    'positionSize',
    'initialMargin',
    'maintenance',
    'existingMaintenance',
    'collateral',
    'marginAvailable',
    'liquidation',
    'returnCount',
    'candleDays',
    'hourlyRate',
    'projected7',
    'fillsCount',
    ...nullable,
  ];
  return (
    typeof r.coin === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(r.coin) &&
    (r.side === 'long' || r.side === 'short') &&
    (r.marginMode === 'cross' || r.marginMode === 'isolated') &&
    (r.address === null || isPerpAddress(r.address)) &&
    typeof r.stockLike === 'boolean' &&
    typeof r.fillsCapped === 'boolean' &&
    numeric.every(
      (k) =>
        (nullable.includes(k) && r[k] === null) ||
        (typeof r[k] === 'number' &&
          Number.isFinite(r[k]) &&
          Math.abs(r[k] as number) <= Number.MAX_SAFE_INTEGER),
    ) &&
    (r.mark as number) > 0 &&
    (r.positionSize as number) > 0 &&
    (r.candleDays as number) >= 0 &&
    (r.candleDays as number) <= 30
  );
}
