import type {
  WalletPnl,
  WalletPosition,
} from '../../lib/second-look/wallet.ts';
import type { WalletTrade, TradeFee } from './trade-parser.ts';
import { SOL_MINT, USDC_MINT } from './trade-parser.ts';

export type WalletPrice = {
  mint: string;
  priceUsd: string;
  at: string;
  lastTradeAt: string | null;
  liquidityUsd: string | null;
  estimated: boolean;
  source: string;
};
export type WalletCoverage = {
  sourceId: string;
  snapshotId: string;
  wallet: string;
  genesisHash: string;
  asOf: string;
  asOfSlot: string;
  startsAtGenesis: true;
  includesClosedTokenAccounts: true;
  includesDelegatedTransfers: true;
  feePolicyId: string;
  transactionCount: number;
  holdings: { mint: string; decimals: number; amount: string }[];
};
export type PriceBook = {
  historical: Record<string, WalletPrice>;
  current: Record<string, WalletPrice>;
  opening: Record<string, WalletPrice>;
};
export const priceKey = (mint: string, at: string) => `${mint}:${at}`;
const decimalPattern = /^(0|[1-9][0-9]{0,17})(?:\.([0-9]{1,18}))?$/;
export function decimalRatio(value: string): [bigint, bigint] {
  if (typeof value !== 'string' || !decimalPattern.test(value))
    throw new Error('Invalid exact decimal.');
  const [whole, fraction = ''] = value.split('.');
  return [BigInt(whole + fraction), 10n ** BigInt(fraction.length)];
}
/** Round once toward zero at the USD micro-unit display boundary. */
export function valueUsd6(
  atoms: bigint,
  decimals: number,
  price: string,
): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)
    throw new Error('Invalid token precision.');
  const [numerator, denominator] = decimalRatio(price);
  return (
    (atoms * numerator * 1_000_000n) / (denominator * 10n ** BigInt(decimals))
  );
}
export function noMarket(price: WalletPrice, asOf: Date) {
  return (
    (price.lastTradeAt !== null &&
      asOf.getTime() - Date.parse(price.lastTradeAt) > 7 * 86_400_000) ||
    (price.liquidityUsd !== null &&
      valueUsd6(1n, 0, price.liquidityUsd) < 100_000_000n)
  );
}
type Lot = {
  amount: bigint;
  basis: bigint | null;
  airdrop: boolean;
  estimated: boolean;
};
type Position = { decimals: number; lots: Lot[] };
function totalAmount(p: Position) {
  return p.lots.reduce((sum, l) => sum + l.amount, 0n);
}
function totalBasis(p: Position): bigint | null {
  return p.lots.some((l) => l.basis === null)
    ? null
    : p.lots.reduce((sum, l) => sum + l.basis!, 0n);
}
function take(
  p: Position,
  quantity: bigint,
): { lots: Lot[]; basis: bigint | null } {
  let left = quantity,
    basis: bigint | null = 0n;
  const lots: Lot[] = [];
  while (left > 0n && p.lots.length) {
    const lot = p.lots[0],
      used = left < lot.amount ? left : lot.amount;
    const cost =
      lot.basis === null
        ? null
        : used === lot.amount
          ? lot.basis
          : (lot.basis * used) / lot.amount;
    lots.push({ ...lot, amount: used, basis: cost });
    basis = basis === null || cost === null ? null : basis + cost;
    left -= used;
    lot.amount -= used;
    if (lot.basis !== null && cost !== null) lot.basis -= cost;
    if (lot.amount === 0n) p.lots.shift();
  }
  if (left) {
    lots.push({ amount: left, basis: null, airdrop: false, estimated: false });
    basis = null;
  }
  return { lots, basis };
}
function unrealized(
  positions: Map<string, Position>,
  prices: Record<string, WalletPrice>,
  at: Date,
): bigint | null {
  let result = 0n;
  for (const [mint, position] of positions) {
    const quantity = totalAmount(position);
    if (!quantity) continue;
    const price = prices[mint],
      basis = totalBasis(position);
    if (!price || basis === null) return null;
    result +=
      (noMarket(price, at)
        ? 0n
        : valueUsd6(quantity, position.decimals, price.priceUsd)) - basis;
  }
  return result;
}
export type PnlInput = {
  walletId: string;
  wallet: string;
  trades: WalletTrade[];
  prices: PriceBook;
  coverage: WalletCoverage | null;
  linkedWallets?: string[];
  asOf?: Date;
  unresolvedTransactions?: number;
};

/** FIFO per address; internal transfers carry original lots without realizing a disposal. */
export function calculateWalletPnl(input: PnlInput): WalletPnl {
  const now = input.asOf ?? new Date(),
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const linked = new Set([input.wallet, ...(input.linkedWallets ?? [])]);
  const wallets = new Map<string, Map<string, Position>>();
  for (const wallet of linked) wallets.set(wallet, new Map());
  const positions = wallets.get(input.wallet)!;
  const getPosition = (wallet: string, mint: string, decimals: number) => {
    const map = wallets.get(wallet)!;
    const old = map.get(mint);
    if (old && old.decimals !== decimals)
      throw new Error('Inconsistent token precision.');
    const position = old ?? { decimals, lots: [] };
    map.set(mint, position);
    return position;
  };
  const exceptions = new Set<string>();
  const openingValue = () => {
    // Opening marks affect this month's result even after the holding is sold.
    for (const [mint, position] of positions) {
      if (!totalAmount(position)) continue;
      const price = input.prices.opening[mint];
      if (price?.estimated || position.lots.some((lot) => lot.estimated))
        exceptions.add('ESTIMATED_PRICE');
      if (price && (price.lastTradeAt === null || price.liquidityUsd === null))
        exceptions.add('MARKET_EVIDENCE_UNAVAILABLE');
    }
    return unrealized(positions, input.prices.opening, start);
  };
  let realized = 0n,
    realizedKnown = true,
    feesKnown = true,
    feeTotal = 0n,
    rent = 0n;
  let opening: bigint | null | undefined;
  let movedUnrealized = 0n;
  let movePricesKnown = true;
  const feeKinds: TradeFee['kind'][] = [
    'network',
    'priority',
    'network_and_priority',
    'jito_tip',
    'platform',
  ];
  const fees = new Map(
    feeKinds.map((kind) => [kind, { value: 0n, known: true }]),
  );
  const ordered = [...input.trades].sort((a, b) =>
    BigInt(a.slot) < BigInt(b.slot)
      ? -1
      : BigInt(a.slot) > BigInt(b.slot)
        ? 1
        : (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0) ||
          a.signature.localeCompare(b.signature) ||
          a.wallet.localeCompare(b.wallet),
  );
  const seen = new Set<string>(),
    moved = new Set<string>();
  // A reviewed archive may supply block transaction ordinals; plain RPC cannot.
  const slotOrders = new Map<string, Map<string, number | null>>();
  for (const trade of ordered) {
    const orders = slotOrders.get(trade.slot) ?? new Map();
    orders.set(trade.signature, trade.transactionIndex);
    slotOrders.set(trade.slot, orders);
  }
  if (
    [...slotOrders.values()].some(
      (orders) =>
        orders.size > 1 &&
        ([...orders.values()].some((n) => n === null) ||
          new Set(orders.values()).size !== orders.size),
    )
  )
    exceptions.add('INTRA_SLOT_ORDER_UNVERIFIED');
  for (const trade of ordered) {
    if (
      !linked.has(trade.wallet) ||
      seen.has(`${trade.wallet}:${trade.signature}`)
    )
      continue;
    seen.add(`${trade.wallet}:${trade.signature}`);
    if (!trade.timestamp) {
      exceptions.add('BLOCK_TIME_UNAVAILABLE');
      continue;
    }
    const at = new Date(trade.timestamp);
    if (at > now) continue;
    if (opening === undefined && at >= start) opening = openingValue();
    const month = at >= start && trade.wallet === input.wallet;
    if (trade.wallet === input.wallet)
      for (const warning of trade.warnings) exceptions.add(warning);
    if (month) {
      if (
        [...trade.deltas, ...trade.fees].some(
          (d) =>
            input.prices.historical[priceKey(d.mint, trade.timestamp!)]
              ?.estimated,
        )
      )
        exceptions.add('ESTIMATED_PRICE');
      rent += BigInt(trade.rentLamports);
      for (const [warning, kind] of [
        ['PLATFORM_FEE_COVERAGE_UNAVAILABLE', 'platform'],
        ['JITO_TIP_COVERAGE_UNAVAILABLE', 'jito_tip'],
      ] as const) {
        if (trade.warnings.includes(warning)) {
          fees.get(kind)!.known = false;
          feesKnown = false;
        }
      }
      if (trade.fees.some((f) => f.kind === 'network_and_priority')) {
        fees.get('network')!.known = false;
        fees.get('priority')!.known = false;
      }
    }
    const historical = (mint: string) =>
      input.prices.historical[priceKey(mint, trade.timestamp!)];
    for (const fee of trade.fees) {
      const count = BigInt(fee.amount),
        price = historical(fee.mint),
        usd =
          count === 0n
            ? 0n
            : price
              ? valueUsd6(count, fee.decimals, price.priceUsd)
              : null;
      // Fees dispose of the fee asset at its original FIFO basis; trading P&L shows fee expense separately.
      const used =
        count > 0n
          ? take(getPosition(trade.wallet, fee.mint, fee.decimals), count)
          : { basis: 0n, lots: [] };
      if (month && used.lots.some((lot) => lot.estimated))
        exceptions.add('ESTIMATED_PRICE');
      if (month && count > 0n) {
        if (usd === null || used.basis === null) {
          realizedKnown = false;
          exceptions.add('FEE_ASSET_BASIS_UNAVAILABLE');
        } else realized += usd - used.basis;
      }
      if (month) {
        const component = fees.get(fee.kind)!;
        if (usd === null) {
          component.known = false;
          feesKnown = false;
          exceptions.add('FEE_PRICE_UNAVAILABLE');
        } else {
          component.value += usd;
          feeTotal += usd;
        }
      }
    }
    const positive = trade.deltas.find(
      (d) => d.kind === 'swap' && BigInt(d.amount) > 0n,
    );
    const negative = trade.deltas.find(
      (d) => d.kind === 'swap' && BigInt(d.amount) < 0n,
    );
    let swapValue: bigint | null = null;
    let swapEstimated = false;
    if (positive && negative) {
      // Prefer the observed quote asset, then an independently timestamped historical price.
      const quote =
        [positive, negative].find((d) => d.mint === USDC_MINT) ??
        [positive, negative].find((d) => d.mint === SOL_MINT) ??
        negative;
      const price = historical(quote.mint);
      swapEstimated = Boolean(price?.estimated);
      if (price)
        swapValue = valueUsd6(
          BigInt(quote.amount) < 0n
            ? -BigInt(quote.amount)
            : BigInt(quote.amount),
          quote.decimals,
          price.priceUsd,
        );
    }
    // Process outgoing moves before incoming even if address lexicographic order is reversed.
    for (const delta of trade.deltas) {
      const quantity = BigInt(delta.amount),
        position = getPosition(trade.wallet, delta.mint, delta.decimals);
      if (
        delta.kind === 'transfer' &&
        delta.counterparty &&
        linked.has(delta.counterparty)
      ) {
        const from = quantity < 0n ? trade.wallet : delta.counterparty,
          to = quantity < 0n ? delta.counterparty : trade.wallet;
        const key = `${trade.signature}:${from}:${to}:${delta.mint}`;
        if (!moved.has(key)) {
          moved.add(key);
          const transferred = take(
            getPosition(from, delta.mint, delta.decimals),
            quantity < 0n ? -quantity : quantity,
          );
          getPosition(to, delta.mint, delta.decimals).lots.push(
            ...transferred.lots,
          );
          if (transferred.basis === null)
            exceptions.add('LINKED_TRANSFER_BASIS_UNAVAILABLE');
          if (at >= start && (from === input.wallet || to === input.wallet)) {
            if (transferred.lots.some((lot) => lot.estimated))
              exceptions.add('ESTIMATED_PRICE');
            const price = historical(delta.mint);
            if (!price || transferred.basis === null) {
              movePricesKnown = false;
              exceptions.add('LINKED_TRANSFER_VALUATION_UNAVAILABLE');
            } else {
              const gain =
                valueUsd6(
                  quantity < 0n ? -quantity : quantity,
                  delta.decimals,
                  price.priceUsd,
                ) - transferred.basis;
              movedUnrealized += to === input.wallet ? gain : -gain;
            }
          }
        }
        continue;
      }
      if (quantity > 0n) {
        const basis =
          delta.kind === 'airdrop'
            ? 0n
            : delta.kind === 'swap'
              ? swapValue
              : null;
        position.lots.push({
          amount: quantity,
          basis,
          airdrop: delta.kind === 'airdrop',
          estimated:
            delta.kind === 'swap'
              ? swapEstimated
              : Boolean(historical(delta.mint)?.estimated),
        });
        if (basis === null) exceptions.add('MISSING_COST_BASIS');
      } else if (quantity < 0n) {
        const used = take(position, -quantity);
        if (month && used.lots.some((lot) => lot.estimated))
          exceptions.add('ESTIMATED_PRICE');
        if (delta.kind === 'swap') {
          if (month) {
            if (used.basis === null || swapValue === null) {
              realizedKnown = false;
              exceptions.add('REALIZED_PNL_UNRESOLVED');
            } else realized += swapValue - used.basis;
          }
        } else if (delta.kind !== 'transfer') {
          if (month) realizedKnown = false;
          exceptions.add('UNCLASSIFIED_DISPOSAL');
        }
        // An external transfer is not automatically a sale, gift, or loss; review is required.
        else exceptions.add('EXTERNAL_TRANSFER_TREATMENT_UNRESOLVED');
      }
    }
  }
  if (opening === undefined) opening = openingValue();
  const closing = unrealized(positions, input.prices.current, now),
    change =
      opening === null || closing === null || !movePricesKnown
        ? null
        : closing - opening - movedUnrealized;
  const output: WalletPosition[] = [...positions]
    .filter(([, p]) => totalAmount(p) > 0n)
    .map(([mint, p]) => {
      const quantity = totalAmount(p),
        basis = totalBasis(p),
        price = input.prices.current[mint];
      const market = price
        ? noMarket(price, now)
          ? 'no_market'
          : 'priced'
        : 'unavailable';
      const value =
        market === 'no_market'
          ? 0n
          : price
            ? valueUsd6(quantity, p.decimals, price.priceUsd)
            : null;
      if (!price) exceptions.add('CURRENT_PRICE_UNAVAILABLE');
      if (
        price?.estimated ||
        input.prices.opening[mint]?.estimated ||
        p.lots.some((lot) => lot.estimated)
      )
        exceptions.add('ESTIMATED_PRICE');
      if (price && (price.lastTradeAt === null || price.liquidityUsd === null))
        exceptions.add('MARKET_EVIDENCE_UNAVAILABLE');
      if (market === 'no_market') exceptions.add('NO_MARKET');
      return {
        mint,
        decimals: p.decimals,
        amount: quantity.toString(),
        basisUsd6: basis?.toString() ?? null,
        valueUsd6: value?.toString() ?? null,
        unrealizedUsd6:
          value === null || basis === null ? null : (value - basis).toString(),
        market,
        missingBasis: basis === null,
        airdrop: p.lots.some((l) => l.airdrop),
        estimated: p.lots.some((l) => l.estimated) || Boolean(price?.estimated),
      };
    });
  let reconciled = Boolean(
    input.coverage &&
    input.coverage.wallet === input.wallet &&
    Date.parse(input.coverage.asOf) === now.getTime() &&
    ordered
      .filter((t) => t.wallet === input.wallet)
      .every(
        (t) =>
          BigInt(t.slot) <= BigInt(input.coverage!.asOfSlot) &&
          t.timestamp !== null &&
          Date.parse(t.timestamp) <= now.getTime(),
      ) &&
    input.coverage.startsAtGenesis === true &&
    input.coverage.includesClosedTokenAccounts === true &&
    input.coverage.includesDelegatedTransfers === true &&
    input.coverage.transactionCount ===
      ordered.filter((t) => t.wallet === input.wallet).length &&
    !input.unresolvedTransactions,
  );
  if (input.coverage) {
    const expected = new Map(input.coverage.holdings.map((h) => [h.mint, h]));
    for (const [mint, p] of positions) {
      const holding = expected.get(mint);
      const quantity = totalAmount(p);
      if (
        quantity !== BigInt(holding?.amount ?? '0') ||
        (holding && holding.decimals !== p.decimals)
      )
        reconciled = false;
      expected.delete(mint);
    }
    if ([...expected.values()].some((h) => BigInt(h.amount) !== 0n))
      reconciled = false;
    if (!reconciled) exceptions.add('HOLDINGS_NOT_RECONCILED');
  } else exceptions.add('HISTORY_PARTIAL');
  if (input.unresolvedTransactions) exceptions.add('TRANSACTIONS_UNAVAILABLE');
  if (change === null)
    exceptions.add('MONTH_OPENING_OR_CURRENT_PRICE_UNAVAILABLE');
  const blocking = [...exceptions].some(
    (e) =>
      ![
        'NO_MARKET',
        'BALANCE_DELTA_SWAP_INFERRED',
        'MINT_DISTRIBUTION_ZERO_BASIS',
      ].includes(e),
  );
  const complete =
    reconciled && !blocking && realizedKnown && feesKnown && change !== null;
  const net =
    realizedKnown && feesKnown && change !== null
      ? realized + change - feeTotal
      : null;
  const component = (kind: TradeFee['kind']) =>
    fees.get(kind)!.known ? fees.get(kind)!.value.toString() : null;
  const activities = ordered.filter((t) => t.wallet === input.wallet).reverse();
  return {
    walletId: input.walletId,
    accounting: 'fifo',
    periodStart: start.toISOString(),
    asOf: now.toISOString(),
    coverage: complete ? 'verified' : 'partial',
    complete,
    netUsd6: complete ? net!.toString() : null,
    realizedUsd6: complete ? realized.toString() : null,
    unrealizedChangeUsd6: complete ? change!.toString() : null,
    observed: {
      realizedUsd6: realizedKnown ? realized.toString() : null,
      unrealizedChangeUsd6: change?.toString() ?? null,
      netUsd6: net?.toString() ?? null,
      feesUsd6: feesKnown ? feeTotal.toString() : null,
    },
    fees: {
      networkUsd6: component('network'),
      priorityUsd6: component('priority'),
      networkAndPriorityUsd6: component('network_and_priority'),
      jitoTipUsd6: component('jito_tip'),
      platformUsd6: component('platform'),
    },
    rentExcludedLamports: rent.toString(),
    positions: output.sort((a, b) => a.mint.localeCompare(b.mint)),
    exceptions: [...exceptions].sort(),
    finalizedTransactions: activities.length,
    activity: activities.slice(0, 100).map((t) => ({
      signature: t.signature,
      slot: t.slot,
      timestamp: t.timestamp,
      kind: t.deltas.some((d) => d.kind === 'swap')
        ? 'swap'
        : t.deltas.some((d) => d.kind === 'airdrop')
          ? 'airdrop'
          : t.deltas.some((d) => d.kind === 'unknown')
            ? 'unknown'
            : t.deltas.length
              ? 'transfer'
              : 'fee',
      finalized: true,
      warnings: t.warnings,
    })),
    activityTruncated: activities.length > 100,
  };
}
