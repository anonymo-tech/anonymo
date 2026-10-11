import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Queryable } from '../db/database.ts';
import { one } from '../db/database.ts';
import { ServiceError, requireCondition } from '../core/errors.ts';
import { post } from '../ledger/ledger.ts';
import type { TokenCluster, TokenProgramKind } from './config.ts';
import type { TokenPriceQuote } from './price.ts';

// Ledger side of a platform token burn. The reserve (migration 019) matures per
// closed UTC hour; an execution releases a matured amount from `burn_reserve`
// into `burn_executed` and writes one immutable `token_burns` row in the same
// database transaction (migration 021 makes both halves mandatory). Nothing
// here talks to a chain: the executor hands over signatures it already saw
// finalized.

export type BurnFundingSource = 'buyback-simulation' | 'token-deposits' | 'jupiter';

export type TokenBurnRecordInput = {
  periodStart: Date;
  periodEnd: Date;
  maturedUsd6: bigint;
  spentUsd6: bigint;
  funding: BurnFundingSource;
  cluster: TokenCluster;
  tokenMint: string;
  tokenProgram: TokenProgramKind;
  tokenDecimals: number;
  priceUsd6PerToken: bigint;
  priceSource: TokenPriceQuote['source'];
  tokensBoughtRaw: bigint;
  tokensBurnedRaw: bigint;
  swapSignature: string | null;
  burnSignature: string;
  finalizedSlot: number;
};

export type TokenBurnRecord = {
  id: string;
  ledgerTransactionId: string;
  periodStart: string;
  periodEnd: string;
  maturedUsd6: string;
  spentUsd6: string;
  fundingSource: BurnFundingSource;
  cluster: TokenCluster;
  tokenMint: string;
  tokenProgram: TokenProgramKind;
  tokenDecimals: number;
  priceUsd6PerToken: string;
  priceSource: TokenPriceQuote['source'];
  tokensBoughtRaw: string;
  tokensBurnedRaw: string;
  swapSignature: string | null;
  burnSignature: string;
  finalizedSlot: number;
  recordHash: string;
  createdAt: string;
};

const HOUR_MS = 3_600_000;

/** A whole UTC hour, strictly in the past relative to `nowMs`. */
export function requireClosedHour(periodEnd: Date, nowMs = Date.now()): Date {
  requireCondition(
    periodEnd instanceof Date &&
      Number.isFinite(periodEnd.getTime()) &&
      periodEnd.getTime() % HOUR_MS === 0 &&
      periodEnd.getTime() <= nowMs,
    400,
    'TOKEN_BURN_PERIOD_INVALID',
    'A burn period must end on a whole UTC hour that has passed.',
  );
  return periodEnd;
}

/**
 * Reserve credits posted before `periodEnd` minus everything executions have
 * already spent. Never negative. Executions are counted regardless of when
 * they were posted, so the figure is "what is still available for a period
 * ending here", not a historical snapshot.
 */
export async function maturedBurnReserveUsd6(
  db: Queryable,
  periodEnd: Date,
  nowMs = Date.now(),
): Promise<bigint> {
  requireClosedHour(periodEnd, nowMs);
  const row = await one<{ accrued: string; spent: string }>(
    db,
    `SELECT COALESCE(sum(e.amount_usd6) FILTER (WHERE e.amount_usd6>0),0)::text AS accrued,
      COALESCE((SELECT sum(spent_usd6) FROM token_burns),0)::text AS spent
    FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.ledger_account_id
    WHERE a.owner_id IS NULL AND a.kind='burn_reserve' AND e.created_at<$1`,
    [periodEnd],
  );
  const matured = BigInt(row!.accrued) - BigInt(row!.spent);
  return matured > 0n ? matured : 0n;
}

/**
 * Where the next period starts: the end of the latest recorded burn, or the
 * hour of the first reserve credit when nothing has been burned yet. Null when
 * the reserve has never accrued.
 */
export async function nextBurnPeriodStart(db: Queryable): Promise<Date | null> {
  const row = await one<{ start: Date | null }>(
    db,
    `SELECT COALESCE(
      (SELECT max(period_end) FROM token_burns),
      (SELECT date_trunc('hour',min(e.created_at) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.ledger_account_id
        WHERE a.owner_id IS NULL AND a.kind='burn_reserve' AND e.amount_usd6>0)) AS start`,
  );
  return row?.start ?? null;
}

/** True when a recorded burn already covers any part of [periodStart, periodEnd). */
export async function burnPeriodOverlaps(
  db: Queryable,
  periodStart: Date,
  periodEnd: Date,
): Promise<boolean> {
  const row = await one<{ overlapping: boolean }>(
    db,
    `SELECT EXISTS (SELECT 1 FROM token_burns
      WHERE tstzrange(period_start,period_end,'[)') && tstzrange($1,$2,'[)')) AS overlapping`,
    [periodStart, periodEnd],
  );
  return row!.overlapping;
}

/**
 * Canonical JSON for the record hash: fixed key order, integer amounts as
 * decimal strings, timestamps as ISO-8601 UTC. The hash commits to the ledger
 * transaction id, so the same on-chain facts recorded twice would differ.
 */
export function canonicalTokenBurnRecord(
  record: TokenBurnRecordInput & { id: string; ledgerTransactionId: string },
): string {
  return JSON.stringify({
    v: 1,
    id: record.id,
    ledgerTransactionId: record.ledgerTransactionId,
    periodStart: record.periodStart.toISOString(),
    periodEnd: record.periodEnd.toISOString(),
    maturedUsd6: record.maturedUsd6.toString(),
    spentUsd6: record.spentUsd6.toString(),
    fundingSource: record.funding,
    cluster: record.cluster,
    tokenMint: record.tokenMint,
    tokenProgram: record.tokenProgram,
    tokenDecimals: record.tokenDecimals,
    priceUsd6PerToken: record.priceUsd6PerToken.toString(),
    priceSource: record.priceSource,
    tokensBoughtRaw: record.tokensBoughtRaw.toString(),
    tokensBurnedRaw: record.tokensBurnedRaw.toString(),
    swapSignature: record.swapSignature,
    burnSignature: record.burnSignature,
    finalizedSlot: record.finalizedSlot,
  });
}

export function tokenBurnRecordHash(
  record: TokenBurnRecordInput & { id: string; ledgerTransactionId: string },
): string {
  return createHash('sha256')
    .update(canonicalTokenBurnRecord(record), 'utf8')
    .digest('hex');
}

/** Recomputes the hash of a stored row; false means the row was not produced by this code. */
export function verifyTokenBurnRecord(record: TokenBurnRecord): boolean {
  return (
    tokenBurnRecordHash({
      id: record.id,
      ledgerTransactionId: record.ledgerTransactionId,
      periodStart: new Date(record.periodStart),
      periodEnd: new Date(record.periodEnd),
      maturedUsd6: BigInt(record.maturedUsd6),
      spentUsd6: BigInt(record.spentUsd6),
      funding: record.fundingSource,
      cluster: record.cluster,
      tokenMint: record.tokenMint,
      tokenProgram: record.tokenProgram,
      tokenDecimals: record.tokenDecimals,
      priceUsd6PerToken: BigInt(record.priceUsd6PerToken),
      priceSource: record.priceSource,
      tokensBoughtRaw: BigInt(record.tokensBoughtRaw),
      tokensBurnedRaw: BigInt(record.tokensBurnedRaw),
      swapSignature: record.swapSignature,
      burnSignature: record.burnSignature,
      finalizedSlot: record.finalizedSlot,
    }) === record.recordHash
  );
}

function requireRecord(record: TokenBurnRecordInput) {
  requireClosedHour(record.periodEnd);
  requireCondition(
    record.periodStart instanceof Date &&
      record.periodStart.getTime() % HOUR_MS === 0 &&
      record.periodStart.getTime() < record.periodEnd.getTime(),
    400,
    'TOKEN_BURN_PERIOD_INVALID',
    'A burn period must start on a whole UTC hour before its end.',
  );
  requireCondition(
    typeof record.spentUsd6 === 'bigint' &&
      typeof record.maturedUsd6 === 'bigint' &&
      record.spentUsd6 > 0n &&
      record.spentUsd6 <= record.maturedUsd6,
    400,
    'TOKEN_BURN_AMOUNT_INVALID',
    'A burn may not spend more than the matured reserve.',
  );
  requireCondition(
    typeof record.tokensBurnedRaw === 'bigint' &&
      record.tokensBurnedRaw > 0n &&
      typeof record.tokensBoughtRaw === 'bigint' &&
      record.tokensBoughtRaw >= 0n &&
      typeof record.priceUsd6PerToken === 'bigint' &&
      record.priceUsd6PerToken > 0n &&
      Number.isSafeInteger(record.finalizedSlot) &&
      record.finalizedSlot > 0,
    400,
    'TOKEN_BURN_AMOUNT_INVALID',
    'The burn record amounts are invalid.',
  );
}

/** Both platform accounts are seeded by migrations 019 and 021; missing means an unmigrated database. */
async function platformAccount(
  db: Queryable,
  kind: 'burn_reserve' | 'burn_executed',
): Promise<{ id: string }> {
  const account = await one<{ id: string }>(
    db,
    'SELECT id FROM ledger_accounts WHERE owner_id IS NULL AND kind=$1',
    [kind],
  );
  requireCondition(
    account,
    503,
    'BURN_RESERVE_UNAVAILABLE',
    'The burn ledger accounts are unavailable.',
  );
  return account;
}

/**
 * Posts the burn_execution and inserts the token_burns row. Must run inside a
 * caller-owned transaction so both halves commit or neither does; the database
 * also refuses either half without the other.
 */
export async function recordBurnExecution(
  client: PoolClient,
  record: TokenBurnRecordInput,
): Promise<{ id: string; ledgerTransactionId: string; recordHash: string }> {
  requireRecord(record);
  const reserve = await platformAccount(client, 'burn_reserve');
  const executed = await platformAccount(client, 'burn_executed');
  const ledgerTransactionId = await post(
    client,
    `burn-execution:${record.burnSignature}`,
    'burn_execution',
    [
      { id: reserve.id, amount: -record.spentUsd6 },
      { id: executed.id, amount: record.spentUsd6 },
    ],
  );
  const id = crypto.randomUUID();
  const recordHash = tokenBurnRecordHash({ ...record, id, ledgerTransactionId });
  try {
    await client.query(
      `INSERT INTO token_burns(id,ledger_transaction_id,period_start,period_end,matured_usd6,spent_usd6,
        funding_source,cluster,token_mint,token_program,token_decimals,price_usd6_per_token,price_source,
        tokens_bought_raw,tokens_burned_raw,swap_signature,burn_signature,finalized_slot,record_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        id,
        ledgerTransactionId,
        record.periodStart,
        record.periodEnd,
        record.maturedUsd6.toString(),
        record.spentUsd6.toString(),
        record.funding,
        record.cluster,
        record.tokenMint,
        record.tokenProgram,
        record.tokenDecimals,
        record.priceUsd6PerToken.toString(),
        record.priceSource,
        record.tokensBoughtRaw.toString(),
        record.tokensBurnedRaw.toString(),
        record.swapSignature,
        record.burnSignature,
        record.finalizedSlot,
        recordHash,
      ],
    );
  } catch (error) {
    // Overlapping periods and consistency failures are database-enforced.
    const code = (error as { code?: string }).code;
    if (code === '23P01')
      throw new ServiceError(
        409,
        'TOKEN_BURN_PERIOD_COVERED',
        'A recorded burn already covers part of this period.',
      );
    if (code === '23514' || code === '23505')
      throw new ServiceError(
        409,
        'TOKEN_BURN_RECORD_REJECTED',
        'The burn record does not match the ledger.',
      );
    throw error;
  }
  return { id, ledgerTransactionId, recordHash };
}

const RECORD_COLUMNS = `b.id,b.ledger_transaction_id AS "ledgerTransactionId",
  b.period_start AS "periodStart",b.period_end AS "periodEnd",
  b.matured_usd6::text AS "maturedUsd6",b.spent_usd6::text AS "spentUsd6",
  b.funding_source AS "fundingSource",b.cluster,b.token_mint AS "tokenMint",
  b.token_program AS "tokenProgram",b.token_decimals AS "tokenDecimals",
  b.price_usd6_per_token::text AS "priceUsd6PerToken",b.price_source AS "priceSource",
  b.tokens_bought_raw::text AS "tokensBoughtRaw",b.tokens_burned_raw::text AS "tokensBurnedRaw",
  b.swap_signature AS "swapSignature",b.burn_signature AS "burnSignature",
  b.finalized_slot::int AS "finalizedSlot",b.record_hash AS "recordHash",b.created_at AS "createdAt"`;

type RecordRow = Omit<TokenBurnRecord, 'periodStart' | 'periodEnd' | 'createdAt'> & {
  periodStart: Date;
  periodEnd: Date;
  createdAt: Date;
};

function publicRecord(row: RecordRow): TokenBurnRecord {
  return {
    ...row,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Newest first. Contains no account data; every field is a public burn fact. */
export async function listTokenBurns(
  db: Queryable,
  options: { limit?: number } = {},
): Promise<TokenBurnRecord[]> {
  const limit = options.limit ?? 20;
  requireCondition(
    Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
    400,
    'INVALID_LIMIT',
    'Choose a limit between 1 and 100.',
  );
  const rows = await db.query<RecordRow>(
    `SELECT ${RECORD_COLUMNS} FROM token_burns b ORDER BY b.created_at DESC,b.id DESC LIMIT $1`,
    [limit],
  );
  return rows.rows.map(publicRecord);
}

export type TokenBurnSummary = {
  status: 'localnet-rehearsal' | 'not_launched';
  burnsExecuted: number;
  tokensBurnedRaw: string;
  lastBurnSignature: string | null;
};

/**
 * On-chain summary for the stats endpoint. Rehearsal records (localnet or
 * devnet) never make the status anything but a rehearsal; "not_launched" is
 * reported while no burn has been recorded at all.
 */
export async function tokenBurnSummary(db: Queryable): Promise<TokenBurnSummary> {
  const row = await one<{
    burns: number;
    tokens: string;
    last_signature: string | null;
  }>(
    db,
    `SELECT count(*)::int AS burns,COALESCE(sum(tokens_burned_raw),0)::text AS tokens,
      (SELECT burn_signature FROM token_burns ORDER BY created_at DESC,id DESC LIMIT 1) AS last_signature
    FROM token_burns`,
  );
  return {
    status: row!.burns > 0 ? 'localnet-rehearsal' : 'not_launched',
    burnsExecuted: row!.burns,
    tokensBurnedRaw: row!.tokens,
    lastBurnSignature: row!.last_signature,
  };
}
