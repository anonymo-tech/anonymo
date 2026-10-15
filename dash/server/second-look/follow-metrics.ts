/**
 * Follow Check's deterministic accounting boundary. Input is a reviewed token
 * ledger, not raw wallet balance deltas. USD amounts are integer micro-dollars;
 * quotes exclude the separately allocated transaction fees and ATA rent.
 *
 * A producer must allocate shared transaction fees exactly once across events,
 * supply opening average-cost positions, and prove complete window coverage.
 * Linked-wallet movements must be reconciled upstream after explicit selection.
 * This module neither infers a follower graph nor treats RPC pagination as proof
 * that transaction parsing, historical pricing, or fee coverage is complete.
 */
export const FOLLOW_WINDOW_DAYS = 90;
export const FOLLOW_MIN_ROUND_TRIPS = 20;
const DAY_MS = 86_400_000;
const MAX_EVENTS = 100_000;
const MAX_MARK_AGE_MS = 300_000;

export type FollowMetric<T> =
  | { status: 'available'; value: T }
  | { status: 'unavailable'; value: null; reasons: string[] };

export type FollowCoverage = {
  sourceId: string;
  snapshotId: string;
  from: string;
  through: string;
  transactionsComplete: boolean;
  normalizationReviewed: boolean;
  feePolicyReviewed: boolean;
  openingPositionsComplete: boolean;
  unresolvedEvents: number;
};

type EventBase = {
  id: string;
  signature: string;
  slot: string;
  transactionIndex: number | null;
  eventIndex: number;
  at: string | null;
  /** Includes network, priority, tips and platform fees, never account rent. */
  feesUsd6: string | null;
};
type TokenEvent = EventBase & {
  mint: string;
  decimals: number;
  amountAtoms: string;
};
export type FollowEvent =
  | (TokenEvent & {
      kind: 'buy' | 'sell' | 'transfer-out';
      /** Historical consideration, or verified transfer-time market value. */
      quoteUsd6: string | null;
      valuation: 'verified' | 'estimated' | 'unavailable';
    })
  | (TokenEvent & {
      kind: 'transfer-in';
      /** Proven inherited basis; a missing basis is never replaced with zero. */
      basisUsd6: string | null;
      firstBuyAt: string | null;
      priorRealizedUsd6: string | null;
    })
  | (EventBase & { kind: 'fee' });

export type FollowOpeningPosition = {
  mint: string;
  decimals: number;
  amountAtoms: string;
  basisUsd6: string | null;
  firstBuyAt: string | null;
  /** Earlier partial exits in this same round trip, before the 90-day window. */
  priorRealizedUsd6: string | null;
};

export type FollowPositionMark = {
  mint: string;
  sourceId: string;
  observedAt: string;
  verified: boolean;
  /** The mark must value the actual ending quantity, not an earlier balance. */
  amountAtoms: string;
  marketValueUsd6: string | null;
  lastTradeAt: string | null;
  liquidityUsd6: string | null;
};

export type FollowMintCreation = {
  mint: string;
  slot: string;
  /** Indexed creation transaction, not first observed trade or pool creation. */
  signature: string;
  sourceId: string;
  indexedMintCreation: boolean;
};

export type FollowInput = {
  wallet: string;
  asOf: string;
  coverage: FollowCoverage | null;
  openingPositions: FollowOpeningPosition[];
  events: FollowEvent[];
  marks?: FollowPositionMark[];
  mintCreations?: FollowMintCreation[];
};

export type FollowRoundTrip = {
  mint: string;
  openedAt: string | null;
  closedAt: string;
  pnlUsd6: string | null;
  closeReason: 'sell' | 'transfer-out' | 'dead';
};

export type FollowMetrics = {
  wallet: string;
  window: {
    from: string;
    through: string;
    days: 90;
    coveredDays: number | null;
  };
  sample: {
    trades: number;
    buys: number;
    roundTrips: number;
    complete: boolean;
    tooSmall: boolean;
  };
  realizedPnlUsd6: FollowMetric<string>;
  unrealizedPnlUsd6: FollowMetric<string>;
  winRateBps: FollowMetric<number>;
  medianHoldSeconds: FollowMetric<number>;
  maxDrawdownUsd6: FollowMetric<string>;
  top3ProfitShareBps: FollowMetric<number>;
  firstBlockBuyRateBps: FollowMetric<number>;
  exitIntoFollowersRateBps: FollowMetric<number>;
  possiblyLinkedWallets: FollowMetric<string[]>;
  walletAgeDays: FollowMetric<number>;
  roundTrips: FollowRoundTrip[];
  limitations: string[];
};

type Position = {
  mint: string;
  decimals: number;
  quantity: bigint;
  basis: bigint | null;
  openedAt: string | null;
  tripPnl: bigint | null;
};

function instant(value: string): number {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    throw new Error('Follow Check requires UTC timestamps.');
  const ms = Date.parse(value);
  if (
    !Number.isFinite(ms) ||
    new Date(ms).toISOString() !== value.replace(/(?<=:\d{2})Z$/, '.000Z')
  )
    throw new Error('Invalid Follow Check timestamp.');
  return ms;
}

function integer(value: string, signed = false): bigint {
  if (
    typeof value !== 'string' ||
    !(signed ? /^-?(0|[1-9][0-9]{0,37})$/ : /^(0|[1-9][0-9]{0,37})$/).test(
      value,
    )
  )
    throw new Error('Invalid Follow Check integer.');
  return BigInt(value);
}

function identity(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    throw new Error('Invalid Follow Check evidence identifier.');
}

function precision(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 18)
    throw new Error('Invalid Follow Check token precision.');
}

function available<T>(value: T): FollowMetric<T> {
  return { status: 'available', value };
}

function unavailable<T>(reasons: Iterable<string>): FollowMetric<T> {
  return {
    status: 'unavailable',
    value: null,
    reasons: [...new Set(reasons)].sort(),
  };
}

function measured<T>(value: T, reasons: Set<string>): FollowMetric<T> {
  return reasons.size ? unavailable(reasons) : available(value);
}

function ratio(part: bigint, total: bigint): number {
  return Number((part * 10_000n) / total);
}

function indexedByMint<T extends { mint: string }>(
  values: T[],
): Map<string, T> {
  if (values.length > MAX_EVENTS)
    throw new Error('Follow Check input is too large.');
  const index = new Map<string, T>();
  for (const value of values) {
    identity(value.mint);
    if (index.has(value.mint))
      throw new Error('Duplicate Follow Check mint evidence.');
    index.set(value.mint, value);
  }
  return index;
}

/** All division of cost/ratios truncates once toward zero; final exits retain remainder. */
export function calculateFollowMetrics(input: FollowInput): FollowMetrics {
  identity(input.wallet);
  const end = instant(input.asOf);
  const start = end - FOLLOW_WINDOW_DAYS * DAY_MS;
  const from = new Date(start).toISOString();
  if (input.events.length > MAX_EVENTS)
    throw new Error('Follow Check input is too large.');
  const history = new Set<string>();
  const accounting = new Set<string>();
  const unrealizedIssues = new Set<string>();
  const tripIssues = new Set<string>();
  const holdIssues = new Set<string>();
  const creationIssues = new Set<string>();
  const coverage = input.coverage;
  let coveredDays: number | null = null;
  if (!coverage) {
    history.add('HISTORY_COVERAGE_UNAVAILABLE');
    accounting.add('OPENING_POSITIONS_UNVERIFIED');
    accounting.add('FEE_COVERAGE_UNVERIFIED');
  } else {
    identity(coverage.sourceId);
    identity(coverage.snapshotId);
    const begins = instant(coverage.from);
    const ends = instant(coverage.through);
    if (
      ends < begins ||
      !Number.isSafeInteger(coverage.unresolvedEvents) ||
      coverage.unresolvedEvents < 0
    )
      throw new Error('Invalid Follow Check coverage.');
    coveredDays =
      Math.max(0, Math.min(end, ends) - Math.max(start, begins)) / DAY_MS;
    if (begins > start || ends < end || coverage.transactionsComplete !== true)
      history.add('INCOMPLETE_90_DAY_HISTORY');
    if (coverage.normalizationReviewed !== true)
      history.add('NORMALIZATION_UNREVIEWED');
    if (coverage.unresolvedEvents > 0) history.add('UNRESOLVED_EVENTS');
    if (coverage.openingPositionsComplete !== true)
      accounting.add('OPENING_POSITIONS_UNVERIFIED');
    if (coverage.feePolicyReviewed !== true)
      accounting.add('FEE_COVERAGE_UNVERIFIED');
  }

  const positions = new Map<string, Position>();
  for (const opening of indexedByMint(input.openingPositions).values()) {
    precision(opening.decimals);
    const quantity = integer(opening.amountAtoms);
    if (quantity === 0n)
      throw new Error('Opening Follow Check positions must be positive.');
    const basis =
      opening.basisUsd6 === null ? null : integer(opening.basisUsd6);
    if (basis === null) accounting.add('OPENING_BASIS_UNAVAILABLE');
    if (opening.firstBuyAt !== null && instant(opening.firstBuyAt) > start)
      throw new Error('Opening Follow Check position starts after the window.');
    positions.set(opening.mint, {
      mint: opening.mint,
      decimals: opening.decimals,
      quantity,
      basis,
      openedAt: opening.firstBuyAt,
      tripPnl:
        opening.priorRealizedUsd6 === null
          ? null
          : integer(opening.priorRealizedUsd6, true),
    });
  }

  const seen = new Map<string, string>();
  const orders = new Map<string, Map<string, number | null>>();
  const eventKeys = new Set<string>();
  const transactionEvidence = new Map<string, string>();
  const events: FollowEvent[] = [];
  for (const event of input.events) {
    if (
      !['buy', 'sell', 'transfer-in', 'transfer-out', 'fee'].includes(
        event.kind,
      )
    )
      throw new Error('Unsupported Follow Check event kind.');
    identity(event.id);
    identity(event.signature);
    integer(event.slot);
    if (
      (event.transactionIndex !== null &&
        (!Number.isSafeInteger(event.transactionIndex) ||
          event.transactionIndex < 0)) ||
      !Number.isSafeInteger(event.eventIndex) ||
      event.eventIndex < 0
    )
      throw new Error('Invalid Follow Check event order.');
    // Exact replay is idempotent; conflicting replays are rejected rather than summed.
    const fingerprint = JSON.stringify(
      Object.entries(event).sort(([a], [b]) => a.localeCompare(b)),
    );
    const previous = seen.get(event.id);
    if (previous !== undefined) {
      if (previous !== fingerprint)
        throw new Error('Conflicting Follow Check event.');
      continue;
    }
    seen.set(event.id, fingerprint);
    if (event.at === null) {
      history.add('EVENT_TIME_UNAVAILABLE');
      continue;
    }
    const at = instant(event.at);
    if (at < start || at > end) continue;
    const location = `${event.slot}:${event.transactionIndex}:${event.at}`;
    if (
      transactionEvidence.has(event.signature) &&
      transactionEvidence.get(event.signature) !== location
    )
      throw new Error('Conflicting Follow Check transaction evidence.');
    transactionEvidence.set(event.signature, location);
    const eventKey = `${event.signature}:${event.eventIndex}`;
    if (eventKeys.has(eventKey))
      throw new Error('Duplicate Follow Check transaction event.');
    eventKeys.add(eventKey);
    const slotOrders =
      orders.get(event.slot) ?? new Map<string, number | null>();
    if (
      slotOrders.has(event.signature) &&
      slotOrders.get(event.signature) !== event.transactionIndex
    )
      throw new Error('Conflicting Follow Check transaction order.');
    slotOrders.set(event.signature, event.transactionIndex);
    orders.set(event.slot, slotOrders);
    if (event.feesUsd6 !== null) integer(event.feesUsd6);
    if (event.kind !== 'fee') {
      identity(event.mint);
      precision(event.decimals);
      if (integer(event.amountAtoms) === 0n)
        throw new Error('Follow Check token amounts must be positive.');
    }
    events.push(event);
  }
  for (const slotOrders of orders.values()) {
    if (
      slotOrders.size > 1 &&
      ([...slotOrders.values()].some((order) => order === null) ||
        new Set(slotOrders.values()).size !== slotOrders.size)
    )
      history.add('INTRA_SLOT_ORDER_UNVERIFIED');
  }
  events.sort((a, b) =>
    BigInt(a.slot) < BigInt(b.slot)
      ? -1
      : BigInt(a.slot) > BigInt(b.slot)
        ? 1
        : (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0) ||
          a.eventIndex - b.eventIndex ||
          a.id.localeCompare(b.id),
  );

  let realized = 0n;
  let peak = 0n;
  let drawdown = 0n;
  let unrealized = 0n;
  let buys = 0;
  let trades = 0;
  let earlyBuys = 0;
  const roundTrips: FollowRoundTrip[] = [];
  const creations = indexedByMint(input.mintCreations ?? []);
  const recordRealized = (pnl: bigint | null) => {
    if (pnl === null) {
      accounting.add('DISPOSAL_BASIS_OR_PRICE_UNAVAILABLE');
      return;
    }
    realized += pnl;
    if (realized > peak) peak = realized;
    if (peak - realized > drawdown) drawdown = peak - realized;
  };
  const close = (
    p: Position,
    at: string,
    reason: FollowRoundTrip['closeReason'],
  ) => {
    if (p.tripPnl === null) tripIssues.add('ROUND_TRIP_BASIS_UNAVAILABLE');
    if (p.openedAt === null) holdIssues.add('FIRST_BUY_TIME_UNAVAILABLE');
    else if (instant(p.openedAt) > instant(at))
      throw new Error('Follow Check position closes before it opens.');
    roundTrips.push({
      mint: p.mint,
      openedAt: p.openedAt,
      closedAt: at,
      pnlUsd6: p.tripPnl?.toString() ?? null,
      closeReason: reason,
    });
    p.openedAt = null;
    p.tripPnl = 0n;
  };

  for (const event of events) {
    const fee = event.feesUsd6 === null ? null : integer(event.feesUsd6);
    if (fee === null) accounting.add('FEE_PRICE_UNAVAILABLE');
    if (event.kind === 'fee') {
      recordRealized(fee === null ? null : -fee);
      continue;
    }
    const quantity = integer(event.amountAtoms);
    const p = positions.get(event.mint) ?? {
      mint: event.mint,
      decimals: event.decimals,
      quantity: 0n,
      basis: 0n,
      openedAt: null,
      tripPnl: 0n,
    };
    if (p.decimals !== event.decimals)
      throw new Error('Inconsistent Follow Check token precision.');
    positions.set(event.mint, p);
    if (event.kind === 'transfer-in') {
      const basis = event.basisUsd6 === null ? null : integer(event.basisUsd6);
      const prior =
        event.priorRealizedUsd6 === null
          ? null
          : integer(event.priorRealizedUsd6, true);
      if (
        event.firstBuyAt !== null &&
        instant(event.firstBuyAt) > instant(event.at!)
      )
        throw new Error('Follow Check transfer predates its acquisition.');
      if (basis === null) accounting.add('TRANSFER_BASIS_UNAVAILABLE');
      if (p.quantity === 0n) p.openedAt = event.firstBuyAt;
      else if (p.openedAt === null || event.firstBuyAt === null)
        p.openedAt = null;
      else if (instant(event.firstBuyAt) < instant(p.openedAt))
        p.openedAt = event.firstBuyAt;
      p.basis =
        p.basis === null || basis === null || fee === null
          ? null
          : p.basis + basis + fee;
      p.tripPnl =
        p.tripPnl === null || prior === null ? null : p.tripPnl + prior;
      p.quantity += quantity;
      continue;
    }
    const quote = event.quoteUsd6 === null ? null : integer(event.quoteUsd6);
    const priced =
      event.valuation === 'verified' && quote !== null ? quote : null;
    if (priced === null)
      accounting.add(
        event.valuation === 'estimated'
          ? 'ESTIMATED_TRADE_PRICE'
          : 'TRADE_PRICE_UNAVAILABLE',
      );
    if (event.kind === 'buy') {
      trades++;
      buys++;
      const creation = creations.get(event.mint);
      if (
        creation?.indexedMintCreation !== true ||
        !creation.signature?.trim() ||
        !creation.sourceId?.trim()
      ) {
        creationIssues.add('INDEXED_MINT_CREATION_UNAVAILABLE');
      } else {
        const elapsed = integer(event.slot) - integer(creation.slot);
        if (elapsed < 0n) creationIssues.add('MINT_CREATION_CONFLICT');
        else if (elapsed <= 4n) earlyBuys++;
      }
      if (p.quantity === 0n) {
        p.openedAt = event.at;
        p.tripPnl = 0n;
      }
      p.basis =
        p.basis === null || priced === null || fee === null
          ? null
          : p.basis + priced + fee;
      p.quantity += quantity;
      continue;
    }
    if (event.kind === 'sell') trades++;
    const sufficient = p.quantity >= quantity;
    if (!sufficient) accounting.add('POSITION_HISTORY_INCOMPLETE');
    const cost =
      !sufficient || p.basis === null
        ? null
        : quantity === p.quantity
          ? p.basis
          : (p.basis * quantity) / p.quantity;
    const pnl =
      cost === null || priced === null || fee === null
        ? null
        : priced - fee - cost;
    recordRealized(pnl);
    p.tripPnl = p.tripPnl === null || pnl === null ? null : p.tripPnl + pnl;
    p.quantity = sufficient ? p.quantity - quantity : 0n;
    p.basis =
      p.quantity === 0n
        ? 0n
        : p.basis === null || cost === null
          ? null
          : p.basis - cost;
    if (p.quantity === 0n) close(p, event.at!, event.kind);
  }

  const marks = indexedByMint(input.marks ?? []);
  for (const p of positions.values()) {
    if (p.quantity === 0n) continue;
    const mark = marks.get(p.mint);
    if (!mark || mark.verified !== true || !mark.sourceId?.trim()) {
      accounting.add('ENDING_MARKET_EVIDENCE_UNAVAILABLE');
      unrealizedIssues.add('ENDING_MARKET_EVIDENCE_UNAVAILABLE');
      continue;
    }
    const observed = instant(mark.observedAt);
    if (
      observed > end ||
      end - observed > MAX_MARK_AGE_MS ||
      integer(mark.amountAtoms) !== p.quantity
    ) {
      accounting.add('ENDING_MARK_STALE_OR_MISMATCHED');
      unrealizedIssues.add('ENDING_MARK_STALE_OR_MISMATCHED');
      continue;
    }
    const lastTrade =
      mark.lastTradeAt === null ? null : instant(mark.lastTradeAt);
    if (lastTrade !== null && lastTrade > observed)
      throw new Error('Follow Check market evidence looks into the future.');
    const liquidity =
      mark.liquidityUsd6 === null ? null : integer(mark.liquidityUsd6);
    const dead =
      (liquidity !== null && liquidity < 100_000_000n) ||
      (lastTrade !== null && observed - lastTrade > 7 * DAY_MS);
    if (dead) {
      recordRealized(p.basis === null ? null : -p.basis);
      p.tripPnl =
        p.basis === null || p.tripPnl === null ? null : p.tripPnl - p.basis;
      p.quantity = 0n;
      p.basis = 0n;
      close(p, input.asOf, 'dead');
    } else if (liquidity === null || lastTrade === null) {
      accounting.add('ENDING_MARKET_EVIDENCE_UNAVAILABLE');
      unrealizedIssues.add('ENDING_MARKET_EVIDENCE_UNAVAILABLE');
    } else if (mark.marketValueUsd6 === null || p.basis === null) {
      unrealizedIssues.add('ENDING_VALUATION_OR_BASIS_UNAVAILABLE');
    } else {
      unrealized += integer(mark.marketValueUsd6) - p.basis;
    }
  }

  const moneyReasons = new Set([...history, ...accounting]);
  const completedReasons = new Set([
    ...moneyReasons,
    ...tripIssues,
    ...holdIssues,
  ]);
  if (!roundTrips.length) completedReasons.add('NO_COMPLETED_ROUND_TRIPS');
  const holds = roundTrips
    .filter((trip) => trip.openedAt !== null)
    .map(
      (trip) =>
        BigInt(instant(trip.closedAt)) - BigInt(instant(trip.openedAt!)),
    )
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const middle = Math.floor(holds.length / 2);
  const median =
    holds.length === 0
      ? 0
      : holds.length % 2
        ? Number(holds[middle]) / 1000
        : Number(holds[middle - 1] + holds[middle]) / 2000;
  const gains = roundTrips
    .filter((trip) => trip.pnlUsd6 !== null && BigInt(trip.pnlUsd6) > 0n)
    .map((trip) => BigInt(trip.pnlUsd6!))
    .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const grossGains = gains.reduce((sum, gain) => sum + gain, 0n);
  const gainReasons = new Set(completedReasons);
  if (grossGains === 0n) gainReasons.add('NO_POSITIVE_ROUND_TRIPS');
  const firstBlockReasons = new Set([...history, ...creationIssues]);
  if (buys === 0) firstBlockReasons.add('NO_BUYS_IN_WINDOW');
  const graphReasons = [
    'WHOLE_CHAIN_FOLLOWER_GRAPH_UNAVAILABLE',
    'AGE_MATCHED_BURST_BASELINES_UNAVAILABLE',
  ];
  const qualifiedTrips = roundTrips.filter(
    (trip) => trip.openedAt !== null,
  ).length;
  const tooSmall = qualifiedTrips < FOLLOW_MIN_ROUND_TRIPS;
  const limitations = new Set([
    ...moneyReasons,
    ...unrealizedIssues,
    ...tripIssues,
    ...holdIssues,
    ...creationIssues,
    ...graphReasons,
    'FUNDING_GRAPH_UNAVAILABLE',
    ...(tooSmall ? ['SAMPLE_TOO_SMALL'] : []),
  ]);
  return {
    wallet: input.wallet,
    window: {
      from,
      through: input.asOf,
      days: FOLLOW_WINDOW_DAYS,
      coveredDays,
    },
    sample: {
      trades,
      buys,
      roundTrips: qualifiedTrips,
      complete:
        history.size === 0 &&
        accounting.size === 0 &&
        tripIssues.size === 0 &&
        holdIssues.size === 0,
      tooSmall,
    },
    realizedPnlUsd6: measured(realized.toString(), moneyReasons),
    unrealizedPnlUsd6: measured(
      unrealized.toString(),
      new Set([...moneyReasons, ...unrealizedIssues]),
    ),
    winRateBps: measured(
      roundTrips.length
        ? ratio(BigInt(gains.length), BigInt(roundTrips.length))
        : 0,
      completedReasons,
    ),
    medianHoldSeconds: measured(
      median,
      new Set([...completedReasons, ...holdIssues]),
    ),
    maxDrawdownUsd6: measured(drawdown.toString(), moneyReasons),
    top3ProfitShareBps: measured(
      grossGains
        ? ratio(
            gains.slice(0, 3).reduce((sum, gain) => sum + gain, 0n),
            grossGains,
          )
        : 0,
      gainReasons,
    ),
    firstBlockBuyRateBps: measured(
      buys ? ratio(BigInt(earlyBuys), BigInt(buys)) : 0,
      firstBlockReasons,
    ),
    exitIntoFollowersRateBps: unavailable(graphReasons),
    possiblyLinkedWallets: unavailable(['FUNDING_GRAPH_UNAVAILABLE']),
    walletAgeDays: unavailable(['FUNDING_GRAPH_UNAVAILABLE']),
    roundTrips: roundTrips.map((trip) => ({
      ...trip,
      pnlUsd6: moneyReasons.size ? null : trip.pnlUsd6,
    })),
    limitations: [...limitations].sort(),
  };
}
