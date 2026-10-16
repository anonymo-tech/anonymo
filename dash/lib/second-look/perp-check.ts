/** Read-only Hyperliquid research. All money is an approximate floating-point USD value. */
export const DAY_MS = 86_400_000;
export const PERP_CANDLE_LIMIT = 10;
export const PERP_FILL_LIMIT = 2000;
export const PERP_LIMITS =
  'Perps can lose your whole collateral fast. Liquidation prices come from Hyperliquid and move with funding, fees and margin changes. σ is historical and gaps can be larger. Nothing here is stored. Not investment advice.';
export const isPerpAddress = (v: unknown): v is string =>
  typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
function check(v: unknown): asserts v {
  if (!v) throw Error('Invalid Hyperliquid data');
}
function record(v: unknown) {
  check(object(v));
  return v;
}
function list(v: unknown, max: number) {
  check(Array.isArray(v) && v.length <= max);
  return v;
}
export function perpNumber(v: unknown): number {
  check(typeof v === 'string' && v.length <= 80 && /^-?\d+(?:\.\d+)?$/.test(v));
  const n = Number(v);
  check(
    Number.isFinite(n) &&
      Math.abs(n) <= Number.MAX_SAFE_INTEGER &&
      (n !== 0 || !/[1-9]/.test(v)),
  );
  return n;
}
function positive(v: unknown, zero = false) {
  const n = perpNumber(v);
  check(zero ? n >= 0 : n > 0);
  return n;
}
function timestamp(v: unknown) {
  check(typeof v === 'number' && Number.isSafeInteger(v) && v > 0);
  return v;
}
function coinName(v: unknown) {
  check(typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/.test(v));
  return v;
}
function finite(n: number) {
  check(Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER);
  return n;
}
function sum(values: number[]) {
  return values.reduce((a, b) => finite(a + b), 0);
}

export type PerpPosition = {
  coin: string;
  size: number;
  entry: number | null;
  notional: number;
  unrealized: number;
  returnOnEquity: number;
  liquidation: number | null;
  marginUsed: number;
  leverageType: 'cross' | 'isolated';
  leverage: number;
  fundingSinceOpen: number;
};
export function parsePerpAccount(v: unknown) {
  const a = record(v),
    m = record(a.marginSummary);
  const positions: PerpPosition[] = list(a.assetPositions, 1000)
    .map((item): PerpPosition => {
      const p = record(record(item).position),
        leverage = record(p.leverage),
        funding = record(p.cumFunding);
      check(leverage.type === 'cross' || leverage.type === 'isolated');
      perpNumber(funding.allTime);
      perpNumber(funding.sinceChange);
      return {
        coin: coinName(p.coin),
        size: perpNumber(p.szi),
        entry: p.entryPx === null ? null : positive(p.entryPx),
        notional: positive(p.positionValue, true),
        unrealized: perpNumber(p.unrealizedPnl),
        returnOnEquity: perpNumber(p.returnOnEquity),
        liquidation:
          p.liquidationPx === null ? null : positive(p.liquidationPx),
        marginUsed: positive(p.marginUsed, true),
        leverageType: leverage.type,
        leverage: positive(
          String(
            typeof leverage.value === 'number' ? leverage.value : 'invalid',
          ),
        ),
        // Hyperliquid cumulative funding is positive for a payment; cash flow has the opposite sign.
        fundingSinceOpen: -perpNumber(funding.sinceOpen),
      };
    })
    .filter((p) => p.size !== 0);
  check(new Set(positions.map((p) => p.coin)).size === positions.length);
  return {
    accountValue: perpNumber(m.accountValue),
    totalNotional: positive(m.totalNtlPos, true),
    totalMarginUsed: positive(m.totalMarginUsed, true),
    withdrawable: positive(a.withdrawable, true),
    positions,
  };
}
export type PerpMarket = {
  coin: string;
  maxLeverage: number;
  szDecimals: number;
  funding: number;
  mark: number;
  oracle: number;
  openInterest: number;
  dayVolume: number;
};
export function parsePerpMarkets(v: unknown): PerpMarket[] {
  const pair = list(v, 2);
  check(pair.length === 2);
  const universe = list(record(pair[0]).universe, 2000),
    contexts = list(pair[1], 2000);
  check(universe.length === contexts.length);
  const markets = universe.map((item, i) => {
    const u = record(item),
      c = record(contexts[i]);
    check(
      typeof u.maxLeverage === 'number' &&
        Number.isInteger(u.maxLeverage) &&
        u.maxLeverage > 0 &&
        u.maxLeverage <= 1000,
    );
    check(
      typeof u.szDecimals === 'number' &&
        Number.isInteger(u.szDecimals) &&
        u.szDecimals >= 0 &&
        u.szDecimals <= 18,
    );
    return {
      coin: coinName(u.name),
      maxLeverage: u.maxLeverage,
      szDecimals: u.szDecimals,
      funding: perpNumber(c.funding),
      mark: positive(c.markPx),
      oracle: positive(c.oraclePx),
      openInterest: positive(c.openInterest, true),
      dayVolume: positive(c.dayNtlVlm, true),
    };
  });
  check(new Set(markets.map((m) => m.coin)).size === markets.length);
  return markets;
}
export function parsePerpFunding(v: unknown) {
  return list(v, 10000).map((item) => {
    const f = record(item),
      d = record(f.delta);
    perpNumber(d.szi);
    perpNumber(d.fundingRate);
    return {
      time: timestamp(f.time),
      coin: coinName(d.coin),
      usdc: perpNumber(d.usdc),
    };
  });
}
export function parsePerpFills(v: unknown) {
  return list(v, PERP_FILL_LIMIT).map((item) => {
    const f = record(item);
    const spot =
      typeof f.coin === 'string' &&
      (/^@\d{1,12}$/.test(f.coin) || f.coin.includes('/'));
    check(f.side === 'B' || f.side === 'A');
    check(typeof f.dir === 'string' && f.dir.length > 0 && f.dir.length <= 80);
    // A non-USDC fee cannot be subtracted as USD without a conversion price.
    check(spot || f.feeToken === undefined || f.feeToken === 'USDC');
    positive(f.px);
    positive(f.sz);
    return {
      coin:
        spot && typeof f.coin === 'string' && /^@\d{1,12}$/.test(f.coin)
          ? f.coin
          : coinName(f.coin),
      spot,
      time: timestamp(f.time),
      dir: f.dir,
      closedPnl: perpNumber(f.closedPnl),
      fee: perpNumber(f.fee),
      // One order can fill many times; the order id groups those fills into one trade.
      oid:
        typeof f.oid === 'number' && Number.isSafeInteger(f.oid) && f.oid >= 0
          ? f.oid
          : null,
    };
  });
}
export type PerpCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};
export function parsePerpCandles(
  v: unknown,
  expectedCoin?: string,
): PerpCandle[] {
  const candles = list(v, 32).map((item) => {
    const c = record(item);
    check(
      (c.s === undefined ||
        (typeof c.s === 'string' && (!expectedCoin || c.s === expectedCoin))) &&
        (c.i === undefined || c.i === '1d'),
    );
    const result = {
      time: timestamp(c.t),
      open: positive(c.o),
      high: positive(c.h),
      low: positive(c.l),
      close: positive(c.c),
    };
    check(
      result.time % DAY_MS === 0 &&
        result.low <= Math.min(result.open, result.close) &&
        result.high >= Math.max(result.open, result.close),
    );
    return result;
  });
  check(new Set(candles.map((c) => c.time)).size === candles.length);
  return candles.sort((a, b) => a.time - b.time);
}

/** Sample SD of consecutive daily close-to-close log returns; never bridge a missing day. */
export function dailyRisk(candles: PerpCandle[], distance: number | null) {
  const returns = candles
    .slice(1)
    .flatMap((c, i) =>
      c.time - candles[i].time === DAY_MS
        ? [Math.log(c.close / candles[i].close)]
        : [],
    );
  const mean = returns.length ? sum(returns) / returns.length : 0;
  const sigma =
    returns.length >= 2
      ? Math.sqrt(
          sum(returns.map((r) => (r - mean) ** 2)) / (returns.length - 1),
        )
      : null;
  return {
    sigma,
    returnCount: returns.length,
    candleDays: candles.length,
    daysAtDistance:
      distance === null
        ? null
        : candles.filter((c) => (c.high - c.low) / c.open >= Math.abs(distance))
            .length,
    distanceSigma:
      distance !== null && sigma !== null && sigma > 0
        ? finite(Math.abs(distance) / sigma)
        : null,
  };
}
/** Positive cash flow is received; a positive hourly rate costs a long and credits a short. */
export function projectHourlyFunding(
  rate: number,
  notional: number,
  size: number,
  days = 7,
) {
  check(
    Number.isFinite(rate) &&
      Number.isFinite(notional) &&
      notional >= 0 &&
      Number.isFinite(size) &&
      size !== 0 &&
      Number.isFinite(days) &&
      days >= 0,
  );
  return finite(-Math.sign(size) * rate * 24 * days * notional);
}
export function liquidationDistance(
  mark: number,
  liquidation: number | null,
  size: number,
) {
  check(
    Number.isFinite(mark) && mark > 0 && Number.isFinite(size) && size !== 0,
  );
  if (liquidation === null) return null;
  check(Number.isFinite(liquidation) && liquidation > 0);
  return finite((Math.sign(size) * (mark - liquidation)) / mark);
}
export function stockLike(coin: string, markets: readonly PerpMarket[]) {
  return coin.includes(':') || !markets.some((m) => m.coin === coin);
}
export type PerpCard = PerpPosition &
  ReturnType<typeof dailyRisk> & {
    mark: number | null;
    stockLike: boolean;
    distance: number | null;
    funding7: number;
    funding30: number;
    hourlyRate: number | null;
    projected7: number | null;
    realized30: number;
    fees30: number;
    pnlAfter: number;
    candleStatus: 'available' | 'unavailable' | 'limit';
  };
export type PerpReport = {
  address: string;
  checkedAt: number;
  startTime: number;
  candleStart: number;
  candleEnd: number;
  accountValue: number;
  withdrawable: number;
  totalNotional: number;
  effectiveLeverage: number | null;
  funding30: number;
  realized30: number;
  fees30: number;
  fillsCount: number;
  fundingCount: number;
  fillsCapped: boolean;
  fundingPossiblyCapped: boolean;
  positions: PerpCard[];
};
export function buildPerpReport(input: {
  address: string;
  now: number;
  account: ReturnType<typeof parsePerpAccount>;
  markets: PerpMarket[];
  funding: ReturnType<typeof parsePerpFunding>;
  fills: ReturnType<typeof parsePerpFills>;
  candles: ReadonlyMap<string, PerpCandle[]>;
}): PerpReport {
  check(isPerpAddress(input.address));
  timestamp(input.now);
  const { account, now } = input,
    startTime = now - 30 * DAY_MS;
  const candleEnd = Math.floor(now / DAY_MS) * DAY_MS - 1,
    candleStart = candleEnd + 1 - 30 * DAY_MS;
  const funding = input.funding.filter(
    (f) => f.time >= startTime && f.time <= now,
  );
  const fills = input.fills.filter(
    (f) => !f.spot && f.time >= startTime && f.time <= now,
  );
  const positions = account.positions.map((p, i): PerpCard => {
    const market = input.markets.find((m) => m.coin === p.coin),
      mark = market?.mark ?? null;
    const distance =
      mark === null ? null : liquidationDistance(mark, p.liquidation, p.size);
    const candles = (input.candles.get(p.coin) ?? []).filter(
      (c) => c.time >= candleStart && c.time <= candleEnd,
    );
    const cf = funding.filter((f) => f.coin === p.coin),
      trades = fills.filter((f) => f.coin === p.coin);
    const realized30 = sum(trades.map((f) => f.closedPnl)),
      fees30 = sum(trades.map((f) => f.fee));
    return {
      ...p,
      mark,
      stockLike: stockLike(p.coin, input.markets),
      distance,
      ...dailyRisk(candles, distance),
      candleStatus:
        i >= PERP_CANDLE_LIMIT
          ? 'limit'
          : input.candles.has(p.coin)
            ? 'available'
            : 'unavailable',
      hourlyRate: market?.funding ?? null,
      projected7: market
        ? projectHourlyFunding(market.funding, p.notional, p.size)
        : null,
      funding7: sum(
        cf.filter((f) => f.time >= now - 7 * DAY_MS).map((f) => f.usdc),
      ),
      funding30: sum(cf.map((f) => f.usdc)),
      realized30,
      fees30,
      pnlAfter: sum([p.unrealized, realized30, -fees30, p.fundingSinceOpen]),
    };
  });
  return {
    address: input.address,
    checkedAt: now,
    startTime,
    candleStart,
    candleEnd,
    accountValue: account.accountValue,
    withdrawable: account.withdrawable,
    totalNotional: account.totalNotional,
    effectiveLeverage:
      account.accountValue > 0
        ? finite(account.totalNotional / account.accountValue)
        : null,
    funding30: sum(funding.map((f) => f.usdc)),
    realized30: sum(fills.map((f) => f.closedPnl)),
    fees30: sum(fills.map((f) => f.fee)),
    fillsCount: input.fills.length,
    fundingCount: input.funding.length,
    fillsCapped: input.fills.length === PERP_FILL_LIMIT,
    fundingPossiblyCapped: input.funding.length >= 500,
    positions,
  };
}

/** Validate the normalized API boundary before rendering any response values. */
export function isPerpResponse(v: unknown): v is { report: PerpReport } {
  if (!object(v) || !object(v.report)) return false;
  const r = v.report;
  const numeric = (
    o: Record<string, unknown>,
    keys: string[],
    nullable: string[] = [],
  ) =>
    keys.every(
      (k) =>
        (nullable.includes(k) && o[k] === null) ||
        (typeof o[k] === 'number' &&
          Number.isFinite(o[k]) &&
          Math.abs(o[k] as number) <= Number.MAX_SAFE_INTEGER),
    );
  return (
    isPerpAddress(r.address) &&
    numeric(
      r,
      [
        'checkedAt',
        'startTime',
        'candleStart',
        'candleEnd',
        'accountValue',
        'withdrawable',
        'totalNotional',
        'effectiveLeverage',
        'funding30',
        'realized30',
        'fees30',
        'fillsCount',
        'fundingCount',
      ],
      ['effectiveLeverage'],
    ) &&
    typeof r.fillsCapped === 'boolean' &&
    typeof r.fundingPossiblyCapped === 'boolean' &&
    Array.isArray(r.positions) &&
    r.positions.length <= 1000 &&
    r.positions.every(
      (p) =>
        object(p) &&
        typeof p.coin === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/.test(p.coin) &&
        numeric(
          p,
          [
            'size',
            'entry',
            'notional',
            'unrealized',
            'returnOnEquity',
            'liquidation',
            'marginUsed',
            'leverage',
            'fundingSinceOpen',
            'mark',
            'distance',
            'sigma',
            'returnCount',
            'candleDays',
            'daysAtDistance',
            'distanceSigma',
            'hourlyRate',
            'projected7',
            'funding7',
            'funding30',
            'realized30',
            'fees30',
            'pnlAfter',
          ],
          [
            'entry',
            'liquidation',
            'mark',
            'distance',
            'sigma',
            'daysAtDistance',
            'distanceSigma',
            'hourlyRate',
            'projected7',
          ],
        ) &&
        (p.leverageType === 'cross' || p.leverageType === 'isolated') &&
        typeof p.stockLike === 'boolean' &&
        ['available', 'unavailable', 'limit'].includes(String(p.candleStatus)),
    )
  );
}
