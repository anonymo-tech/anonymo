import type { Pool } from 'pg';
import { one, transaction, type Queryable } from '../db/database.ts';
import { ServiceError, requireCondition } from '../core/errors.ts';
import { settleHoldInTransaction } from './ledger.ts';
import { splitPlatformFee } from './platform-fee.ts';

// Chat holds whose exact cost could not be confirmed stay reconciliation_pending
// with their full reservation until an operator resolves them here. Every
// resolution settles through settleHoldInTransaction, so captures, releases
// and the platform fee / burn split are exactly those of a normal settlement.

const safeCode = (value: string | null | undefined, fallback: string) =>
  typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value)
    ? value
    : fallback;

const count = (value: number | null | undefined) =>
  Number.isSafeInteger(value) && value! >= 0 && value! <= 2_147_483_647
    ? value!
    : null;

export type PendingObservation = {
  reasonCode: string;
  /** Canonical base charge (after route markup, before any platform fee). */
  observedUsd6: string | null;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  } | null;
  /** The run was being stopped (cancelled) when it became pending. */
  stopped: boolean;
};

/** Must run in the transaction that marks the hold reconciliation_pending. */
export async function recordPendingHold(
  db: Queryable,
  holdId: string,
  observation: PendingObservation,
) {
  await db.query(
    `INSERT INTO hold_reconciliations(hold_id,reason_code,observed_usd6,input_tokens,output_tokens,total_tokens,stopped)
    SELECT $1,$2,$3,$4,$5,$6,$7 WHERE EXISTS(SELECT 1 FROM holds WHERE id=$1 AND state='reconciliation_pending')
    ON CONFLICT (hold_id) DO NOTHING`,
    [
      holdId,
      safeCode(observation.reasonCode, 'RECONCILIATION_REQUIRED'),
      observation.observedUsd6,
      count(observation.usage?.inputTokens),
      count(observation.usage?.outputTokens),
      count(observation.usage?.totalTokens),
      observation.stopped,
    ],
  );
}

/** Must run in the transaction whose settlement capped the base at the reservation. */
export async function recordCappedSettlement(
  db: Queryable,
  holdId: string,
  input: { observedUsd6: string; overageUsd6: bigint; capturedUsd6: string },
) {
  await db.query(
    `INSERT INTO hold_reconciliations(hold_id,reason_code,observed_usd6,overage_usd6,resolution,resolved_usd6,resolved_at)
    VALUES($1,'COST_EXCEEDS_RESERVATION',$2,$3,'capped',$4,now())`,
    [
      holdId,
      input.observedUsd6,
      input.overageUsd6.toString(),
      input.capturedUsd6,
    ],
  );
}

export const RECONCILIATION_ACTIONS = [
  'settle-usage',
  'settle-max',
  'release',
] as const;
export type ReconciliationAction = (typeof RECONCILIATION_ACTIONS)[number];

export type PendingHold = {
  holdId: string;
  callId: string;
  accountId: string;
  family: string | null;
  modelId: string | null;
  callState: string;
  reasonCode: string;
  maximumUsd6: string;
  baseMaximumUsd6: string;
  platformFeeBps: number | null;
  burnShareBps: number | null;
  observedUsd6: string | null;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  } | null;
  stopped: boolean;
  providerReference: string | null;
  pendingSince: string;
};

type PendingRow = {
  hold_id: string;
  call_id: string;
  account_id: string;
  family: string | null;
  model_id: string | null;
  call_state: string;
  error_code: string | null;
  reason_code: string | null;
  maximum_usd6: string;
  base_maximum_usd6: string | null;
  platform_fee_bps: number | null;
  burn_share_bps: number | null;
  observed_usd6: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  stopped: boolean | null;
  provider_reference: string | null;
  updated_at: Date;
};

const pendingSelect = `SELECT h.id AS hold_id,c.id AS call_id,h.account_id,r.family,r.model_id,c.state AS call_state,
  c.error_code,x.reason_code,h.maximum_usd6::text,t.base_maximum_usd6::text,t.platform_fee_bps,t.burn_share_bps,
  x.observed_usd6::text,x.input_tokens,x.output_tokens,x.total_tokens,x.stopped,h.provider_reference,h.updated_at
  FROM holds h JOIN calls c ON c.hold_id=h.id JOIN route_versions r ON r.id=c.route_version_id
  LEFT JOIN quote_platform_fees t ON t.quote_id=h.quote_id
  LEFT JOIN hold_reconciliations x ON x.hold_id=h.id`;

function pendingHold(row: PendingRow): PendingHold {
  return {
    holdId: row.hold_id,
    callId: row.call_id,
    accountId: row.account_id,
    family: row.family,
    modelId: row.model_id,
    callState: row.call_state,
    reasonCode: safeCode(row.reason_code ?? row.error_code, 'UNRECORDED'),
    maximumUsd6: row.maximum_usd6,
    baseMaximumUsd6: row.base_maximum_usd6 ?? row.maximum_usd6,
    platformFeeBps: row.platform_fee_bps,
    burnShareBps: row.burn_share_bps,
    observedUsd6: row.observed_usd6,
    usage:
      row.input_tokens === null &&
      row.output_tokens === null &&
      row.total_tokens === null
        ? null
        : {
            inputTokens: row.input_tokens,
            outputTokens: row.output_tokens,
            totalTokens: row.total_tokens,
          },
    // Holds stopped before this record existed carry the legacy cancel code.
    stopped:
      row.stopped === true ||
      ['PPQ_CANCELLED', 'CANCEL_DRAIN_TIMEOUT'].includes(row.error_code ?? ''),
    providerReference: row.provider_reference,
    pendingSince: row.updated_at.toISOString(),
  };
}

/** Pending chat holds, oldest first. Media holds reconcile through their own jobs. */
export async function pendingHolds(db: Queryable, limit = 1000) {
  const rows = await db.query<PendingRow>(
    `${pendingSelect} WHERE h.state='reconciliation_pending' ORDER BY h.updated_at,h.id LIMIT $1`,
    [limit],
  );
  return rows.rows.map(pendingHold);
}

/** What an action would capture for a pending hold, or why it cannot apply. */
export function reconciliationPlan(
  hold: PendingHold,
  action: ReconciliationAction,
) {
  const baseMaximum = BigInt(hold.baseMaximumUsd6);
  let requested: bigint;
  if (action === 'release') requested = 0n;
  else if (action === 'settle-max') requested = baseMaximum;
  else {
    if (hold.observedUsd6 === null || BigInt(hold.observedUsd6) <= 0n)
      return { applicable: false as const, reason: 'NO_USAGE_RECORDED' };
    requested = BigInt(hold.observedUsd6);
  }
  const base = requested > baseMaximum ? baseMaximum : requested;
  const split =
    hold.platformFeeBps === null
      ? null
      : splitPlatformFee(base, hold.platformFeeBps, hold.burnShareBps ?? 0);
  const captured = split ? split.totalUsd6 : base;
  return {
    applicable: true as const,
    baseUsd6: base.toString(),
    platformFeeUsd6: (split?.platformFeeUsd6 ?? 0n).toString(),
    burnReserveUsd6: (split?.burnReserveUsd6 ?? 0n).toString(),
    capturedUsd6: captured.toString(),
    releasedUsd6: (BigInt(hold.maximumUsd6) - captured).toString(),
    overageUsd6: (requested - base).toString(),
  };
}

/**
 * Resolves one pending chat hold. Idempotent: a hold that is no longer pending
 * is reported unchanged and nothing is written.
 */
export async function resolvePendingHold(
  pool: Pool,
  holdId: string,
  action: ReconciliationAction,
) {
  requireCondition(
    RECONCILIATION_ACTIONS.includes(action),
    400,
    'INVALID_ACTION',
    'Choose settle-usage, settle-max or release.',
  );
  const owner = await one<{ account_id: string }>(
    pool,
    'SELECT h.account_id FROM holds h JOIN calls c ON c.hold_id=h.id WHERE h.id=$1',
    [holdId],
  );
  requireCondition(owner, 404, 'HOLD_NOT_FOUND', 'No chat hold has this id.');
  return transaction(pool, async (client) => {
    // Same account → hold lock order as settlement.
    await client.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [
      owner.account_id,
    ]);
    const locked = await one<{ state: string; captured_usd6: string | null }>(
      client,
      'SELECT state,captured_usd6::text FROM holds WHERE id=$1 FOR UPDATE',
      [holdId],
    );
    if (locked?.state !== 'reconciliation_pending')
      return {
        holdId,
        action,
        changed: false as const,
        holdState: locked?.state ?? null,
        capturedUsd6: locked?.captured_usd6 ?? null,
      };
    const row = await one<PendingRow>(
      client,
      `${pendingSelect} WHERE h.id=$1`,
      [holdId],
    );
    if (!row)
      throw new ServiceError(
        404,
        'HOLD_NOT_FOUND',
        'No chat hold has this id.',
      );
    const hold = pendingHold(row);
    const plan = reconciliationPlan(hold, action);
    if (!plan.applicable)
      return {
        holdId,
        action,
        changed: false as const,
        holdState: 'reconciliation_pending',
        skipped: plan.reason,
      };
    const settled = await settleHoldInTransaction(client, {
      accountId: hold.accountId,
      holdId,
      actualUsd6:
        action === 'settle-usage'
          ? hold.observedUsd6!
          : action === 'settle-max'
            ? hold.baseMaximumUsd6
            : '0',
      providerReference: null,
      capAtReservation: true,
    });
    const capturedUsd6 = settled.hold.captured_usd6 ?? '0';
    requireCondition(
      capturedUsd6 === plan.capturedUsd6,
      500,
      'LEDGER_INVARIANT',
      'The reconciliation did not settle as planned.',
    );
    const resolution =
      action === 'settle-usage'
        ? 'settled_usage'
        : action === 'settle-max'
          ? 'settled_max'
          : 'released';
    const overage =
      settled.overageUsd6 > 0n ? settled.overageUsd6.toString() : null;
    const updated = await client.query(
      `UPDATE hold_reconciliations SET resolution=$2,resolved_usd6=$3,resolved_at=now(),overage_usd6=$4
      WHERE hold_id=$1 AND resolution IS NULL`,
      [holdId, resolution, capturedUsd6, overage],
    );
    if (!updated.rowCount)
      await client.query(
        `INSERT INTO hold_reconciliations(hold_id,reason_code,stopped,resolution,resolved_usd6,resolved_at,overage_usd6)
        VALUES($1,$2,$3,$4,$5,now(),$6)`,
        [
          holdId,
          hold.reasonCode,
          hold.stopped,
          resolution,
          capturedUsd6,
          overage,
        ],
      );
    // The answer was delivered; once its cost is resolved it is no longer
    // "under review". A stopped run stays cancelled; a released run that was
    // never confirmed is failed. The original reason stays on the record.
    const callState = hold.stopped
      ? 'cancelled'
      : action === 'release'
        ? 'failed'
        : 'succeeded';
    await client.query(
      `UPDATE calls SET state=$2,error_code=CASE WHEN $2='succeeded' THEN NULL ELSE error_code END,updated_at=now()
      WHERE id=$1 AND state='reconciliation_pending'`,
      [hold.callId, callState],
    );
    return {
      holdId,
      callId: hold.callId,
      action,
      changed: true as const,
      reasonCode: hold.reasonCode,
      holdState: settled.hold.state,
      callState,
      ...plan,
    };
  });
}
