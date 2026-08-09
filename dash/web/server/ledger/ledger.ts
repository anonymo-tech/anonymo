import type { Pool, PoolClient } from 'pg';
import { one, transaction } from '../db/database.ts';
import { ServiceError, requireCondition } from '../core/errors.ts';
import { usd6 } from './money.ts';
import {
  recordHoldPlatformFee,
  settlementPlatformFee,
} from './platform-fee.ts';

type LedgerKind =
  | 'available'
  | 'reserved'
  | 'clearing'
  | 'revenue'
  | 'burn_reserve';
export type Hold = {
  id: string;
  account_id: string;
  quote_id: string;
  idempotency_key: string;
  request_hash: string;
  maximum_usd6: string;
  captured_usd6: string | null;
  state:
    | 'held'
    | 'running'
    | 'captured'
    | 'released'
    | 'reconciliation_pending';
};

async function lockOwner(
  client: PoolClient,
  accountId: string,
  requireActive = true,
) {
  const account = await one(
    client,
    'SELECT id FROM accounts WHERE id=$1 AND (NOT $2::boolean OR disabled_at IS NULL) FOR UPDATE',
    [accountId, requireActive],
  );
  requireCondition(
    account,
    401,
    'ACCOUNT_UNAVAILABLE',
    'This account is unavailable.',
  );
}

export async function ledgerAccount(
  client: PoolClient,
  ownerId: string | null,
  kind: LedgerKind,
) {
  await client.query(
    'INSERT INTO ledger_accounts(id,owner_id,kind) VALUES($1,$2,$3) ON CONFLICT(owner_id,kind) DO NOTHING',
    [crypto.randomUUID(), ownerId, kind],
  );
  const account = await one<{ id: string; balance_usd6: string }>(
    client,
    'SELECT id,balance_usd6 FROM ledger_accounts WHERE owner_id IS NOT DISTINCT FROM $1 AND kind=$2',
    [ownerId, kind],
  );
  if (!account) throw new Error('Ledger account unavailable.');
  return account;
}

export async function post(
  client: PoolClient,
  reference: string,
  kind: string,
  movements: { id: string; amount: bigint }[],
) {
  const entries = movements.filter((entry) => entry.amount !== 0n);
  requireCondition(
    entries.length >= 2 &&
      entries.reduce((sum, entry) => sum + entry.amount, 0n) === 0n,
    500,
    'LEDGER_INVARIANT',
    'A ledger invariant failed.',
  );
  const ids = entries.map((entry) => entry.id).sort();
  await client.query(
    'SELECT id FROM ledger_accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [ids],
  );
  const id = crypto.randomUUID();
  await client.query(
    'INSERT INTO ledger_transactions(id,reference,kind) VALUES($1,$2,$3)',
    [id, reference, kind],
  );
  for (const entry of entries) {
    await client.query(
      'INSERT INTO ledger_entries(transaction_id,ledger_account_id,amount_usd6) VALUES($1,$2,$3)',
      [id, entry.id, entry.amount.toString()],
    );
  }
  return id;
}

export async function getBalance(pool: Pool, accountId: string) {
  const result = await pool.query<{ kind: string; balance_usd6: string }>(
    'SELECT kind,balance_usd6 FROM ledger_accounts WHERE owner_id=$1',
    [accountId],
  );
  return {
    availableUsd6:
      result.rows.find((entry) => entry.kind === 'available')?.balance_usd6 ??
      '0',
    reservedUsd6:
      result.rows.find((entry) => entry.kind === 'reserved')?.balance_usd6 ??
      '0',
    currency: 'USD6' as const,
  };
}

// Internal settlement seam. Only independently verified deposit reconciliation may call this.
// There is intentionally no HTTP endpoint accepting arbitrary credit amounts.
export async function creditVerifiedDeposit(
  pool: Pool,
  input: { accountId: string; reference: string; amountUsd6: string },
) {
  return transaction(pool, (client) =>
    creditVerifiedDepositInTransaction(client, input),
  );
}

export async function creditVerifiedDepositInTransaction(
  client: PoolClient,
  input: { accountId: string; reference: string; amountUsd6: string },
) {
  const amount = usd6(input.amountUsd6);
  requireCondition(
    /^[a-zA-Z0-9:_-]{10,240}$/.test(input.reference),
    400,
    'INVALID_REFERENCE',
    'The deposit reference is invalid.',
  );
  await lockOwner(client, input.accountId, false);
  const reference = `deposit:${input.reference}`;
  const previous = await one<{
    id: string;
    owner_id: string;
    amount_usd6: string;
  }>(
    client,
    `SELECT t.id,a.owner_id,e.amount_usd6 FROM ledger_transactions t
       JOIN ledger_entries e ON e.transaction_id=t.id JOIN ledger_accounts a ON a.id=e.ledger_account_id
       WHERE t.reference=$1 AND a.kind='available'`,
    [reference],
  );
  if (previous) {
    requireCondition(
      previous.owner_id === input.accountId &&
        previous.amount_usd6 === amount.toString(),
      409,
      'REFERENCE_CONFLICT',
      'This deposit was already recorded with different details.',
    );
    return { transactionId: previous.id, replayed: true };
  }
  const available = await ledgerAccount(client, input.accountId, 'available');
  const clearing = await ledgerAccount(client, null, 'clearing');
  const transactionId = await post(client, reference, 'deposit', [
    { id: clearing.id, amount: -amount },
    { id: available.id, amount },
  ]);
  return { transactionId, replayed: false };
}

/**
 * Operator circuit breaker: the uncaptured overage an account may accumulate in
 * a rolling 24 hours before new reservations are refused. Unset means no limit
 * (existing behaviour); a malformed value fails closed.
 */
export function accountOverageLimitUsd6(
  env: Record<string, string | undefined> = process.env,
): bigint | null {
  const value = env.CONCLAVE_MAX_ACCOUNT_OVERAGE_USD6;
  if (value === undefined || value === '') return null;
  if (!/^(0|[1-9][0-9]{0,11})$/.test(value))
    throw new ServiceError(
      503,
      'CONFIGURATION_REQUIRED',
      'The account overage limit configuration is invalid.',
    );
  return BigInt(value);
}

async function assertAccountOverageWithinLimit(
  client: PoolClient,
  accountId: string,
) {
  const limit = accountOverageLimitUsd6();
  if (limit === null) return;
  const row = await one<{ total: string }>(
    client,
    `SELECT COALESCE(sum(r.overage_usd6),0)::text AS total
       FROM hold_reconciliations r JOIN holds h ON h.id=r.hold_id
       WHERE h.account_id=$1 AND r.overage_usd6 IS NOT NULL
         AND r.created_at > now() - interval '24 hours'`,
    [accountId],
  );
  requireCondition(
    BigInt(row?.total ?? '0') <= limit,
    429,
    'OVERAGE_LIMIT_REACHED',
    'Recent requests cost more than their reservations too often. Try again later.',
  );
}

export async function reserveQuote(
  pool: Pool,
  input: {
    accountId: string;
    quoteId: string;
    idempotencyKey: string;
    requestHash: string;
  },
  onReserved?: (client: PoolClient, hold: Hold) => Promise<void>,
) {
  return transaction(pool, (client) =>
    reserveQuoteInTransaction(client, input, onReserved),
  );
}

export async function reserveQuoteInTransaction(
  client: PoolClient,
  input: {
    accountId: string;
    quoteId: string;
    idempotencyKey: string;
    requestHash: string;
  },
  onReserved?: (client: PoolClient, hold: Hold) => Promise<void>,
) {
  requireCondition(
    /^[a-zA-Z0-9_-]{16,128}$/.test(input.idempotencyKey),
    400,
    'INVALID_IDEMPOTENCY_KEY',
    'Use a random idempotency key between 16 and 128 characters.',
  );
  await lockOwner(client, input.accountId);
  const previous = await one<Hold>(
    client,
    'SELECT * FROM holds WHERE account_id=$1 AND idempotency_key=$2',
    [input.accountId, input.idempotencyKey],
  );
  if (previous) {
    requireCondition(
      previous.quote_id === input.quoteId &&
        previous.request_hash === input.requestHash,
      409,
      'IDEMPOTENCY_CONFLICT',
      'This key belongs to a different request.',
    );
    return { hold: previous, replayed: true };
  }
  const quote = await one<{
    max_usd6: string;
    request_hash: string;
    expires_at: Date;
    route_expires_at: Date;
    enabled: boolean;
    archived_at: Date | null;
  }>(
    client,
    `SELECT q.max_usd6,q.request_hash,q.expires_at,r.expires_at AS route_expires_at,r.enabled,p.archived_at
       FROM quotes q JOIN route_versions r ON r.id=q.route_version_id JOIN projects p ON p.id=q.project_id
       WHERE q.id=$1 AND q.account_id=$2 AND p.account_id=$2 FOR UPDATE OF q,r,p`,
    [input.quoteId, input.accountId],
  );
  requireCondition(quote, 404, 'QUOTE_NOT_FOUND', 'This quote is unavailable.');
  // Read the actual clock after all row locks have been acquired. Transaction
  // start time, or an expression evaluated before a lock wait, can be stale.
  const clock = await one<{ at: Date }>(
    client,
    'SELECT clock_timestamp() AS at',
  );
  requireCondition(
    quote.enabled &&
      quote.archived_at === null &&
      quote.expires_at.getTime() > clock!.at.getTime() &&
      quote.route_expires_at.getTime() > clock!.at.getTime(),
    409,
    'QUOTE_EXPIRED',
    'Request a new quote before continuing.',
  );
  requireCondition(
    quote.request_hash === input.requestHash,
    409,
    'QUOTE_MISMATCH',
    'The request no longer matches the quote.',
  );
  requireCondition(
    !(await one(client, 'SELECT id FROM holds WHERE quote_id=$1', [
      input.quoteId,
    ])),
    409,
    'QUOTE_ALREADY_USED',
    'This quote has already been used.',
  );
  const amount = usd6(quote.max_usd6);
  await assertAccountOverageWithinLimit(client, input.accountId);
  const available = await ledgerAccount(client, input.accountId, 'available');
  const reserved = await ledgerAccount(client, input.accountId, 'reserved');
  requireCondition(
    BigInt(available.balance_usd6) >= amount,
    402,
    'INSUFFICIENT_BALANCE',
    'The available balance cannot cover this request.',
  );
  const holdId = crypto.randomUUID();
  await post(client, `hold:${holdId}`, 'hold', [
    { id: available.id, amount: -amount },
    { id: reserved.id, amount },
  ]);
  const hold = await one<Hold>(
    client,
    `INSERT INTO holds(id,account_id,quote_id,idempotency_key,request_hash,maximum_usd6,state)
       VALUES($1,$2,$3,$4,$5,$6,'held') RETURNING *`,
    [
      holdId,
      input.accountId,
      input.quoteId,
      input.idempotencyKey,
      input.requestHash,
      amount.toString(),
    ],
  );
  if (!hold) throw new Error('Reservation failed.');
  if (onReserved) await onReserved(client, hold);
  return { hold, replayed: false };
}

export async function markHoldRunning(
  pool: Pool,
  accountId: string,
  holdId: string,
) {
  const result = await pool.query<Hold>(
    `UPDATE holds SET state='running',updated_at=now() WHERE id=$1 AND account_id=$2 AND state='held' RETURNING *`,
    [holdId, accountId],
  );
  requireCondition(
    result.rowCount === 1,
    409,
    'HOLD_NOT_DISPATCHABLE',
    'This request has already been dispatched or settled.',
  );
  return result.rows[0];
}

export async function markReconciliationPending(
  pool: Pool,
  accountId: string,
  holdId: string,
) {
  await pool.query(
    `UPDATE holds SET state='reconciliation_pending',updated_at=now()
    WHERE id=$1 AND account_id=$2 AND state IN ('held','running')`,
    [holdId, accountId],
  );
}

type Settlement = {
  accountId: string;
  holdId: string;
  actualUsd6: string;
  providerReference: string | null;
  /**
   * Settle a base above the reservation at the reserved base maximum instead
   * of refusing it. The capture never exceeds the hold; the result reports the
   * uncaptured excess so the caller can record it.
   */
  capAtReservation?: boolean;
};

export async function settleHold(pool: Pool, input: Settlement) {
  return transaction(pool, (client) => settleHoldInTransaction(client, input));
}

export async function settleHoldInTransaction(
  client: PoolClient,
  input: Settlement,
) {
  const requested = usd6(input.actualUsd6, true);
  await lockOwner(client, input.accountId, false);
  const hold = await one<Hold>(
    client,
    'SELECT * FROM holds WHERE id=$1 AND account_id=$2 FOR UPDATE',
    [input.holdId, input.accountId],
  );
  requireCondition(
    hold,
    404,
    'HOLD_NOT_FOUND',
    'This reservation is unavailable.',
  );
  // A quote with platform-fee terms charges the reported base plus the fee
  // fixed on that quote; any other quote charges the reported amount as before.
  let reported = requested;
  let fee = await settlementPlatformFee(client, hold.quote_id, reported);
  const baseMaximum = fee ? fee.baseMaximumUsd6 : BigInt(hold.maximum_usd6);
  if (input.capAtReservation && reported > baseMaximum) {
    // The fee on the base maximum is the fee reserved on the quote, so the
    // capped total is exactly the hold.
    reported = baseMaximum;
    fee = await settlementPlatformFee(client, hold.quote_id, reported);
  }
  const overageUsd6 = requested - reported;
  const actual = fee ? fee.totalUsd6 : reported;
  if (hold.state === 'captured' || hold.state === 'released') {
    requireCondition(
      hold.captured_usd6 === actual.toString(),
      409,
      'SETTLEMENT_CONFLICT',
      'This reservation has already been settled with a different amount.',
    );
    return { hold, replayed: true, overageUsd6 };
  }
  const maximum = BigInt(hold.maximum_usd6);
  requireCondition(
    actual <= maximum && (!fee || reported <= fee.baseMaximumUsd6),
    409,
    'COST_EXCEEDS_RESERVATION',
    'The reported cost requires reconciliation.',
  );
  const reserved = await ledgerAccount(client, input.accountId, 'reserved');
  const available = await ledgerAccount(client, input.accountId, 'available');
  const revenue = await ledgerAccount(client, null, 'revenue');
  if (actual > 0n)
    await post(client, `capture:${hold.id}`, 'capture', [
      { id: reserved.id, amount: -actual },
      { id: revenue.id, amount: actual },
    ]);
  const unused = maximum - actual;
  if (unused > 0n)
    await post(client, `release:${hold.id}`, 'release', [
      { id: reserved.id, amount: -unused },
      { id: available.id, amount: unused },
    ]);
  // The capture above keeps its two-entry shape (receipts verify it); the burn
  // share of the fee then moves from revenue into the burn reserve.
  const accrual =
    fee && fee.burnReserveUsd6 > 0n
      ? await post(client, `burn-accrual:${hold.id}`, 'burn_accrual', [
          { id: revenue.id, amount: -fee.burnReserveUsd6 },
          {
            id: (await ledgerAccount(client, null, 'burn_reserve')).id,
            amount: fee.burnReserveUsd6,
          },
        ])
      : null;
  const settled = await one<Hold>(
    client,
    `UPDATE holds SET state=$2,captured_usd6=$3,provider_reference=COALESCE($4,provider_reference),updated_at=now() WHERE id=$1 RETURNING *`,
    [
      hold.id,
      actual === 0n ? 'released' : 'captured',
      actual.toString(),
      input.providerReference,
    ],
  );
  if (!settled)
    throw new ServiceError(
      500,
      'SETTLEMENT_FAILED',
      'Settlement could not be recorded.',
    );
  if (fee && reported > 0n)
    await recordHoldPlatformFee(client, hold.id, fee, accrual);
  return { hold: settled, replayed: false, overageUsd6 };
}
