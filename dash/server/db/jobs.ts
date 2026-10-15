import type { Pool, PoolClient } from 'pg';
import { one, transaction } from './database.ts';
import { requireCondition } from '../core/errors.ts';
import { settleHoldInTransaction } from '../ledger/ledger.ts';
import { recordPendingHold } from '../ledger/reconciliation.ts';
import { PPQ_MODEL_ALLOWLIST } from '../ppq/catalog.ts';
import { featureOn } from '../../components/dashboard/feature-switches.ts';
import { releasedChatFamilies } from '../../lib/model-release.ts';

export type JobScope = 'all' | 'baseline-inference' | 'released-inference';

/** Exclude held-feature calls before acquiring a lease, including pre-existing jobs. */
function scopedJobs(scope: JobScope, parameter: number) {
  requireCondition(
    scope === 'all' || scope === 'baseline-inference' || scope === 'released-inference',
    500,
    'INVALID_WORKER_CONFIGURATION',
    'The worker configuration is invalid.',
  );
  return scope !== 'all'
    ? {
        sql: `AND kind='inference'
      AND EXISTS(SELECT 1 FROM calls c JOIN route_versions r ON r.id=c.route_version_id
        WHERE c.id::text=jobs.payload->>'callId' AND r.modality='chat' AND (r.family || ':' || r.model_id)=ANY($${parameter}::text[]))
      ${scope === 'released-inference' && featureOn('crosscheck') ? '' : "AND NOT EXISTS(SELECT 1 FROM crosscheck_review_calls x WHERE x.call_id::text=jobs.payload->>'callId')"}
      ${scope === 'released-inference' && featureOn('synthesis') ? '' : "AND NOT EXISTS(SELECT 1 FROM brief_synthesis_executions s WHERE s.call_id::text=jobs.payload->>'callId')"}`,
        values: [
          releasedChatFamilies().map(
            (family) =>
              `${family}:${PPQ_MODEL_ALLOWLIST[family as keyof typeof PPQ_MODEL_ALLOWLIST].id}`,
          ),
        ],
      }
    : { sql: '', values: [] };
}

export type Job = {
  id: string;
  kind: string;
  reference: string;
  payload: Record<string, unknown>;
  lease_token: string;
  attempts: number;
  max_attempts: number;
};

export async function enqueue(
  client: PoolClient,
  input: {
    kind: string;
    reference: string;
    payload: Record<string, unknown>;
    maxAttempts?: number;
  },
) {
  const result = await one<{ id: string }>(
    client,
    `INSERT INTO jobs(id,kind,reference,payload,max_attempts)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(reference) DO UPDATE SET reference=excluded.reference RETURNING id`,
    [
      crypto.randomUUID(),
      input.kind,
      input.reference,
      input.payload,
      input.maxAttempts ?? 5,
    ],
  );
  if (!result) throw new Error('Job could not be created.');
  return result.id;
}

export async function claimJob(
  pool: Pool,
  kinds: string[],
  leaseSeconds = 120,
  scope: JobScope = 'all',
): Promise<Job | null> {
  requireCondition(
    kinds.length > 0 &&
      kinds.length <= 16 &&
      leaseSeconds >= 10 &&
      leaseSeconds <= 900,
    500,
    'INVALID_WORKER_CONFIGURATION',
    'The worker configuration is invalid.',
  );
  const filter = scopedJobs(scope, 2);
  return transaction(pool, async (client) => {
    const job = await one<{ id: string }>(
      client,
      `SELECT id FROM jobs
      WHERE state='queued' AND kind=ANY($1::text[]) AND run_after<=now() AND attempts<max_attempts ${filter.sql}
      ORDER BY run_after,id FOR UPDATE SKIP LOCKED LIMIT 1`,
      [kinds, ...filter.values],
    );
    if (!job) return null;
    return one<Job>(
      client,
      `UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,
      lease_expires_at=now()+make_interval(secs=>$3),updated_at=now() WHERE id=$1 RETURNING *`,
      [job.id, crypto.randomUUID(), leaseSeconds],
    );
  });
}

export async function heartbeatJob(pool: Pool, job: Job, leaseSeconds = 120) {
  const result = await pool.query(
    `UPDATE jobs SET lease_expires_at=now()+make_interval(secs=>$3),updated_at=now()
    WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_expires_at>now()`,
    [job.id, job.lease_token, leaseSeconds],
  );
  return result.rowCount === 1;
}

export async function finishJob(pool: Pool, job: Job) {
  const result = await pool.query(
    `UPDATE jobs SET state='succeeded',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
    WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_expires_at>now()`,
    [job.id, job.lease_token],
  );
  requireCondition(
    result.rowCount === 1,
    409,
    'JOB_LEASE_LOST',
    'This job is no longer owned by this worker.',
  );
}

export async function failJob(
  pool: Pool,
  job: Job,
  errorCode: string,
  retrySafe: boolean,
) {
  requireCondition(
    /^[a-zA-Z0-9_]{1,80}$/.test(errorCode),
    500,
    'INVALID_ERROR_CODE',
    'A safe error code is required.',
  );
  // Paid generation must never be replayed automatically after an ambiguous outcome.
  const retry =
    retrySafe && job.kind !== 'inference' && job.attempts < job.max_attempts;
  const result = await pool.query(
    `UPDATE jobs SET state=$3,last_error_code=$4,lease_token=NULL,lease_expires_at=NULL,
    run_after=now()+make_interval(secs=>$5),updated_at=now()
    WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_expires_at>now()`,
    [
      job.id,
      job.lease_token,
      retry ? 'queued' : 'dead',
      errorCode,
      Math.min(3600, 2 ** job.attempts * 5),
    ],
  );
  requireCondition(
    result.rowCount === 1,
    409,
    'JOB_LEASE_LOST',
    'This job is no longer owned by this worker.',
  );
}

export async function recoverExpiredJobs(pool: Pool, scope: JobScope = 'all') {
  const filter = scopedJobs(scope, 1);
  let recovered = 0;
  // One job per transaction avoids acquiring unrelated account locks in competing orders.
  for (let index = 0; index < 100; index++) {
    const count = await transaction(pool, async (client) => {
      const expired = await client.query<Job>(
        `SELECT * FROM jobs WHERE state='running' AND lease_expires_at<=now() ${filter.sql} ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`,
        filter.values,
      );
      for (const job of expired.rows) {
        if (job.kind === 'inference') {
          const callId = job.payload.callId;
          if (typeof callId === 'string') {
            const call = await one<{
              account_id: string;
              hold_id: string;
              state: string;
              hold_state: string;
              cancel_requested: boolean;
            }>(
              client,
              'SELECT c.account_id,c.hold_id,c.state,h.state AS hold_state,h.cancel_requested_at IS NOT NULL AS cancel_requested FROM calls c JOIN holds h ON h.id=c.hold_id WHERE c.id=$1 FOR UPDATE OF c',
              [callId],
            );
            if (call?.state === 'queued' && call.hold_state === 'held') {
              // The worker must persist running before contacting a paid provider.
              await settleHoldInTransaction(client, {
                accountId: call.account_id,
                holdId: call.hold_id,
                actualUsd6: '0',
                providerReference: null,
              });
              await client.query(
                "UPDATE calls SET state='failed',error_code='WORKER_INTERRUPTED_BEFORE_DISPATCH',updated_at=now() WHERE id=$1",
                [callId],
              );
            } else if (call && ['queued', 'running'].includes(call.state)) {
              await client.query(
                `UPDATE holds SET state='reconciliation_pending',updated_at=now()
              WHERE id=$1 AND state IN ('held','running')`,
                [call.hold_id],
              );
              await recordPendingHold(client, call.hold_id, {
                reasonCode: 'WORKER_INTERRUPTED',
                observedUsd6: null,
                usage: null,
                stopped: call.cancel_requested,
              });
              await client.query(
                `UPDATE calls SET state='reconciliation_pending',error_code='WORKER_INTERRUPTED',updated_at=now() WHERE id=$1`,
                [callId],
              );
            }
          }
        }
        const retry =
          job.kind !== 'inference' && job.attempts < job.max_attempts;
        await client.query(
          `UPDATE jobs SET state=$2,last_error_code='LEASE_EXPIRED',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE id=$1`,
          [job.id, retry ? 'queued' : 'dead'],
        );
      }
      return expired.rowCount ?? 0;
    });
    recovered += count;
    if (!count) break;
  }
  return recovered;
}
