import type { Queryable } from '../db/database.ts';
import { one } from '../db/database.ts';
import { ServiceError, requireCondition } from '../core/errors.ts';
import { ceilRatio, usd6 } from './money.ts';

// Platform fee and platform-token buyback-and-burn reserve accrual. Off-chain
// accounting only: no token, swap or chain call exists here. Unset configuration
// means no fee and no accrual, so every quote prices and settles exactly as
// before.

export const PLATFORM_FEE_LIMITS = Object.freeze({
  maximumPlatformFeeBps: 2000,
  maximumBurnShareBps: 10000,
});

/** Reservation buffer over the list-price base maximum, applied once at quote time. */
export const HOLD_BUFFER_LIMITS = Object.freeze({
  maximumHoldBufferBps: 2000,
});

export type HoldBufferConfig = {
  holdBufferBps: number;
};

/** Present on a quote only when a buffer applies; the base maximum stored with any fee terms is the buffered one. */
export type QuoteReservation = {
  bufferBps: number;
  baseMaximumUsd6: string;
  bufferedBaseMaximumUsd6: string;
};

export type PlatformFeeConfig = {
  platformFeeBps: number;
  burnShareBps: number;
};

export type QuotePlatformFee = {
  baseMaximumUsd6: string;
  platformFeeBps: number;
  burnShareBps: number;
  platformFeeMaximumUsd6: string;
  burnReserveMaximumUsd6: string;
};

export type PlatformFeeSplit = {
  baseUsd6: bigint;
  platformFeeUsd6: bigint;
  burnReserveUsd6: bigint;
  retainedFeeUsd6: bigint;
  totalUsd6: bigint;
};

export type SettlementPlatformFee = PlatformFeeSplit & {
  quoteId: string;
  baseMaximumUsd6: bigint;
};

function basisPoints(
  value: string | undefined,
  maximum: number,
  subject = 'platform fee',
) {
  if (value === undefined || value === '') return 0;
  if (!/^(0|[1-9][0-9]{0,4})$/.test(value) || Number(value) > maximum)
    throw new ServiceError(
      503,
      'CONFIGURATION_REQUIRED',
      `The ${subject} configuration is invalid.`,
    );
  return Number(value);
}

/** Read per quote; settlement uses the terms fixed on the quote, never the current environment. */
export function platformFeeConfig(
  env: Record<string, string | undefined> = process.env,
): PlatformFeeConfig {
  return {
    platformFeeBps: basisPoints(
      env.CONCLAVE_PLATFORM_FEE_BPS,
      PLATFORM_FEE_LIMITS.maximumPlatformFeeBps,
    ),
    burnShareBps: basisPoints(
      env.CONCLAVE_BURN_SHARE_BPS,
      PLATFORM_FEE_LIMITS.maximumBurnShareBps,
    ),
  };
}

/**
 * Read per quote. The buffer covers the gateway routing a request to a pricier
 * upstream than its listed price: the hold reserves it, settlement still
 * charges actual usage, and whatever is unused is released. Invalid values fail
 * closed rather than reserving at the unbuffered price.
 */
export function holdBufferConfig(
  env: Record<string, string | undefined> = process.env,
): HoldBufferConfig {
  return {
    holdBufferBps: basisPoints(
      env.CONCLAVE_HOLD_BUFFER_BPS,
      HOLD_BUFFER_LIMITS.maximumHoldBufferBps,
      'hold buffer',
    ),
  };
}

/**
 * Widens a base maximum by the configured buffer: buffered = base + ceil(base x
 * bps / 10000). The buffer lives inside the base, so a platform fee computed on
 * the buffered base keeps the quote's base + fee = maximum invariant. With no
 * configured buffer the base is returned unchanged and nothing is reported.
 */
export function applyHoldBuffer(
  baseMaximumUsd6: string,
  config: HoldBufferConfig = holdBufferConfig(),
): { bufferedBaseMaximumUsd6: string; reservation: QuoteReservation | null } {
  const base = usd6(baseMaximumUsd6);
  if (config.holdBufferBps === 0)
    return { bufferedBaseMaximumUsd6: base.toString(), reservation: null };
  const buffered =
    base +
    ceilRatio(
      base *
        checkedBps(
          config.holdBufferBps,
          HOLD_BUFFER_LIMITS.maximumHoldBufferBps,
        ),
      10000n,
    );
  return {
    bufferedBaseMaximumUsd6: buffered.toString(),
    reservation: {
      bufferBps: config.holdBufferBps,
      baseMaximumUsd6: base.toString(),
      bufferedBaseMaximumUsd6: buffered.toString(),
    },
  };
}

function checkedBps(value: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new RangeError('Invalid basis points.');
  return BigInt(value);
}

/**
 * Integer micro-USD split. The fee rounds down, so it never exceeds the stated
 * rate; the burn share rounds up, so it is never below its stated share of the
 * fee. Both are monotonic in the base, so a fee computed on a settled base never
 * exceeds the fee reserved on the quoted maximum.
 */
export function splitPlatformFee(
  baseUsd6: bigint,
  platformFeeBps: number,
  burnShareBps: number,
): PlatformFeeSplit {
  if (typeof baseUsd6 !== 'bigint' || baseUsd6 < 0n)
    throw new RangeError('Invalid base amount.');
  const fee = checkedBps(platformFeeBps, 10000),
    share = checkedBps(burnShareBps, 10000);
  const platformFeeUsd6 = (baseUsd6 * fee) / 10000n;
  const burnReserveUsd6 = (platformFeeUsd6 * share + 9999n) / 10000n;
  return {
    baseUsd6,
    platformFeeUsd6,
    burnReserveUsd6,
    retainedFeeUsd6: platformFeeUsd6 - burnReserveUsd6,
    totalUsd6: baseUsd6 + platformFeeUsd6,
  };
}

/**
 * Adds the platform fee to a service's base maximum. The returned maximum is
 * what the quote stores and the hold reserves. With no configured fee the base
 * is returned unchanged and no terms are recorded.
 */
export function priceWithPlatformFee(
  baseMaximumUsd6: string,
  options: { limitUsd6?: bigint; config?: PlatformFeeConfig } = {},
): { maximumUsd6: string; platformFee: QuotePlatformFee | null } {
  const base = usd6(baseMaximumUsd6);
  const config = options.config ?? platformFeeConfig();
  if (config.platformFeeBps === 0)
    return { maximumUsd6: base.toString(), platformFee: null };
  const split = splitPlatformFee(
    base,
    config.platformFeeBps,
    config.burnShareBps,
  );
  requireCondition(
    options.limitUsd6 === undefined || split.totalUsd6 <= options.limitUsd6,
    400,
    'REQUEST_BUDGET_EXCEEDED',
    'This request exceeds the current maximum budget.',
  );
  return {
    maximumUsd6: split.totalUsd6.toString(),
    platformFee: {
      baseMaximumUsd6: base.toString(),
      platformFeeBps: config.platformFeeBps,
      burnShareBps: config.burnShareBps,
      platformFeeMaximumUsd6: split.platformFeeUsd6.toString(),
      burnReserveMaximumUsd6: split.burnReserveUsd6.toString(),
    },
  };
}

/**
 * Prices a quote that reserves a hold for provider usage: the base maximum is
 * buffered first, then the platform fee is added on the buffered base, and the
 * per-request limit applies to the resulting total whether or not a fee is
 * configured. With both settings unset this is priceWithPlatformFee exactly.
 */
export function priceQuoteMaximum(
  baseMaximumUsd6: string,
  options: {
    limitUsd6?: bigint;
    config?: PlatformFeeConfig;
    buffer?: HoldBufferConfig;
  } = {},
): {
  maximumUsd6: string;
  platformFee: QuotePlatformFee | null;
  reservation: QuoteReservation | null;
} {
  const { bufferedBaseMaximumUsd6, reservation } = applyHoldBuffer(
    baseMaximumUsd6,
    options.buffer ?? holdBufferConfig(),
  );
  const priced = priceWithPlatformFee(bufferedBaseMaximumUsd6, {
    limitUsd6: options.limitUsd6,
    config: options.config,
  });
  requireCondition(
    options.limitUsd6 === undefined ||
      BigInt(priced.maximumUsd6) <= options.limitUsd6,
    400,
    'REQUEST_BUDGET_EXCEEDED',
    'This request exceeds the current maximum budget.',
  );
  return { ...priced, reservation };
}

/** Must run in the transaction that inserted the quote (the database enforces this). */
export async function recordQuotePlatformFee(
  db: Queryable,
  quoteId: string,
  platformFee: QuotePlatformFee | null,
) {
  if (!platformFee) return;
  await db.query(
    `INSERT INTO quote_platform_fees(quote_id,base_maximum_usd6,platform_fee_bps,burn_share_bps,platform_fee_maximum_usd6)
    VALUES($1,$2,$3,$4,$5)`,
    [
      quoteId,
      platformFee.baseMaximumUsd6,
      platformFee.platformFeeBps,
      platformFee.burnShareBps,
      platformFee.platformFeeMaximumUsd6,
    ],
  );
}

/** Response fields are added only when a fee applies, so fee-free responses are unchanged. */
export function platformFeeFields(platformFee: QuotePlatformFee | null) {
  return platformFee ? { platformFee } : {};
}

/** Response fields are added only when a buffer applies, so unbuffered responses are unchanged. */
export function reservationFields(reservation: QuoteReservation | null) {
  return reservation ? { reservation } : {};
}

/** The fee owed on a settled base under the quote's fixed terms, or null for fee-free quotes. */
export async function settlementPlatformFee(
  db: Queryable,
  quoteId: string,
  baseUsd6: bigint,
): Promise<SettlementPlatformFee | null> {
  const terms = await one<{
    base_maximum_usd6: string;
    platform_fee_bps: number;
    burn_share_bps: number;
  }>(
    db,
    'SELECT base_maximum_usd6::text,platform_fee_bps,burn_share_bps FROM quote_platform_fees WHERE quote_id=$1',
    [quoteId],
  );
  if (!terms) return null;
  return {
    ...splitPlatformFee(baseUsd6, terms.platform_fee_bps, terms.burn_share_bps),
    quoteId,
    baseMaximumUsd6: BigInt(terms.base_maximum_usd6),
  };
}

export async function recordHoldPlatformFee(
  db: Queryable,
  holdId: string,
  fee: SettlementPlatformFee,
  ledgerTransactionId: string | null,
) {
  await db.query(
    `INSERT INTO hold_platform_fees(hold_id,quote_id,base_usd6,platform_fee_usd6,burn_reserve_usd6,ledger_transaction_id)
    VALUES($1,$2,$3,$4,$5,$6)`,
    [
      holdId,
      fee.quoteId,
      fee.baseUsd6.toString(),
      fee.platformFeeUsd6.toString(),
      fee.burnReserveUsd6.toString(),
      ledgerTransactionId,
    ],
  );
}

export type HoldPlatformFee = QuotePlatformFee & {
  baseUsd6: string | null;
  platformFeeUsd6: string | null;
  burnReserveUsd6: string | null;
};

/**
 * Cost breakdown for holds whose quotes carry fee terms. Settled amounts are
 * null until settlement and zero for a fully released hold. Holds without terms
 * are absent from the map.
 */
export async function holdPlatformFees(
  db: Queryable,
  holdIds: string[],
): Promise<Map<string, HoldPlatformFee>> {
  const result = new Map<string, HoldPlatformFee>();
  if (!holdIds.length) return result;
  const rows = await db.query<{
    hold_id: string;
    state: string;
    base_maximum_usd6: string;
    platform_fee_bps: number;
    burn_share_bps: number;
    platform_fee_maximum_usd6: string;
    base_usd6: string | null;
    platform_fee_usd6: string | null;
    burn_reserve_usd6: string | null;
  }>(
    `SELECT h.id AS hold_id,h.state,t.base_maximum_usd6::text,t.platform_fee_bps,t.burn_share_bps,
    t.platform_fee_maximum_usd6::text,f.base_usd6::text,f.platform_fee_usd6::text,f.burn_reserve_usd6::text
    FROM holds h JOIN quote_platform_fees t ON t.quote_id=h.quote_id
    LEFT JOIN hold_platform_fees f ON f.hold_id=h.id WHERE h.id=ANY($1::uuid[])`,
    [holdIds],
  );
  for (const row of rows.rows) {
    const released = row.state === 'released' && row.base_usd6 === null;
    result.set(row.hold_id, {
      baseMaximumUsd6: row.base_maximum_usd6,
      platformFeeBps: row.platform_fee_bps,
      burnShareBps: row.burn_share_bps,
      platformFeeMaximumUsd6: row.platform_fee_maximum_usd6,
      burnReserveMaximumUsd6: splitPlatformFee(
        BigInt(row.base_maximum_usd6),
        row.platform_fee_bps,
        row.burn_share_bps,
      ).burnReserveUsd6.toString(),
      baseUsd6: released ? '0' : row.base_usd6,
      platformFeeUsd6: released ? '0' : row.platform_fee_usd6,
      burnReserveUsd6: released ? '0' : row.burn_reserve_usd6,
    });
  }
  return result;
}

/**
 * Burn reserve totals derived from the immutable ledger, through the last
 * completed UTC hour so the figure cannot be polled to observe individual
 * requests. Executed burns are debits of the reserve, which no code path can
 * post until an on-chain burn path is implemented and reviewed.
 */
export async function burnReserveStats(
  db: Queryable,
  config: PlatformFeeConfig = platformFeeConfig(),
  /** Internal and test use only; the HTTP route always uses the last completed hour. */
  through: Date | null = null,
) {
  const totals = await one<{
    as_of: Date;
    accrued: string;
    executed: string;
    pending: string;
    burns: number;
    settlements: number;
    base: string;
    fees: string;
    allocated: string;
  }>(
    db,
    `WITH cutoff AS (SELECT COALESCE($1::timestamptz,date_trunc('hour',clock_timestamp())) AS at),
    reserve AS (
      SELECT COALESCE(sum(e.amount_usd6) FILTER (WHERE e.amount_usd6>0),0)::text AS accrued,
        COALESCE(-sum(e.amount_usd6) FILTER (WHERE e.amount_usd6<0),0)::text AS executed,
        COALESCE(sum(e.amount_usd6),0)::text AS pending,
        (count(DISTINCT e.transaction_id) FILTER (WHERE e.amount_usd6<0))::int AS burns
      FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.ledger_account_id, cutoff c
      WHERE a.owner_id IS NULL AND a.kind='burn_reserve' AND e.created_at<c.at),
    settled AS (
      SELECT count(*)::int AS settlements,COALESCE(sum(f.base_usd6),0)::text AS base,
        COALESCE(sum(f.platform_fee_usd6),0)::text AS fees,COALESCE(sum(f.burn_reserve_usd6),0)::text AS allocated
      FROM hold_platform_fees f, cutoff c WHERE f.created_at<c.at)
    SELECT c.at AS as_of,r.*,s.* FROM cutoff c, reserve r, settled s`,
    [through],
  );
  if (!totals || totals.accrued !== totals.allocated)
    throw new ServiceError(
      503,
      'BURN_RESERVE_UNAVAILABLE',
      'Burn reserve totals could not be reconciled.',
    );
  return {
    currency: 'USD6' as const,
    asOf: totals.as_of.toISOString(),
    accruedUsd6: totals.accrued,
    executedUsd6: totals.executed,
    pendingUsd6: totals.pending,
    burnsExecuted: totals.burns,
    settlements: {
      count: totals.settlements,
      baseUsd6: totals.base,
      platformFeeUsd6: totals.fees,
      burnReserveUsd6: totals.allocated,
    },
    terms: config,
    onChain: { status: 'not_launched' as const },
  };
}
