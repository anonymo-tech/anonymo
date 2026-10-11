import type { Pool, PoolClient } from 'pg';
import { one, transaction } from '../db/database.ts';
import { claimJob, heartbeatJob, type Job } from '../db/jobs.ts';
import { GatewayError, type GatewayClient, type GatewayUsage } from '../gateway/index.ts';
import {
  encryptText,
  decryptText,
  type DataKeyring,
} from '../core/encryption.ts';
import { ServiceError, requireCondition } from '../core/errors.ts';
import { settleHoldInTransaction } from '../ledger/ledger.ts';
import { ceilRatio } from '../ledger/money.ts';
import {
  recordCappedSettlement,
  recordPendingHold,
} from '../ledger/reconciliation.ts';
import {
  assertUsableRoute,
  parseChatInput,
  callRequestHash,
  type RouteVersion,
} from './call-contract.ts';
import { scanPrompt } from '../../lib/guards/index.ts';
import { trustedCrossCheckInput } from '../crosscheck/execution.ts';
import {
  trustedBriefSynthesisInput,
  evaluateBriefSynthesisForCall,
} from '../briefs/execution.ts';

type CallRecord = {
  id: string;
  account_id: string;
  project_id: string;
  hold_id: string;
  route_version_id: string;
  input_ciphertext: string;
  request_hash: string;
  cancel_requested_at: Date | null;
};

async function ownLease(client: PoolClient, job: Job) {
  const current = await one(
    client,
    `SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_expires_at>now() FOR UPDATE`,
    [job.id, job.lease_token],
  );
  requireCondition(
    current,
    409,
    'JOB_LEASE_LOST',
    'This worker no longer owns the request.',
  );
}

/** Persists delivered output; reports whether a cancellation is now requested. */
async function persistOutput(
  pool: Pool,
  job: Job,
  call: CallRecord,
  output: string,
  keyring: DataKeyring,
) {
  const encrypted = await encryptText(
    output,
    `${call.account_id}:call-output:${call.id}`,
    keyring,
  );
  const result = await pool.query<{ cancel_requested: boolean }>(
    `UPDATE calls SET output_ciphertext=$3,updated_at=now() WHERE id=$1 AND account_id=$2
    AND EXISTS(SELECT 1 FROM jobs WHERE id=$4 AND lease_token=$5 AND state='running' AND lease_expires_at>now())
    RETURNING EXISTS(SELECT 1 FROM holds WHERE id=$6 AND cancel_requested_at IS NOT NULL) AS cancel_requested`,
    [
      call.id,
      call.account_id,
      encrypted,
      job.id,
      job.lease_token,
      call.hold_id,
    ],
  );
  requireCondition(
    result.rowCount === 1,
    409,
    'JOB_LEASE_LOST',
    'This worker no longer owns the request.',
  );
  return result.rows[0].cancel_requested;
}

type Observation = {
  costUsd6: string | null;
  usage: GatewayUsage | null;
  stopped: boolean;
};

async function complete(
  pool: Pool,
  job: Job,
  call: CallRecord,
  outcome: {
    state: 'succeeded' | 'failed' | 'cancelled' | 'reconciliation_pending';
    actualUsd6: string | null;
    providerReference: string | null;
    errorCode: string | null;
    /** What a pending hold's worker saw, kept for operator reconciliation. */
    observation?: Observation | null;
  },
) {
  await transaction(pool, async (client) => {
    // Recovery follows this same job → hold lock order.
    await ownLease(client, job);
    if (outcome.actualUsd6 !== null) {
      // The capture never exceeds the reservation; any excess is recorded.
      const settled = await settleHoldInTransaction(client, {
        accountId: call.account_id,
        holdId: call.hold_id,
        actualUsd6: outcome.actualUsd6,
        providerReference: outcome.providerReference,
        capAtReservation: true,
      });
      if (settled.overageUsd6 > 0n && !settled.replayed)
        await recordCappedSettlement(client, call.hold_id, {
          observedUsd6: outcome.actualUsd6,
          overageUsd6: settled.overageUsd6,
          capturedUsd6: settled.hold.captured_usd6 ?? '0',
        });
    } else {
      await client.query(
        `UPDATE holds SET state='reconciliation_pending',provider_reference=COALESCE($3,provider_reference),updated_at=now()
        WHERE id=$1 AND account_id=$2 AND state IN ('held','running')`,
        [call.hold_id, call.account_id, outcome.providerReference],
      );
      await recordPendingHold(client, call.hold_id, {
        reasonCode: outcome.errorCode ?? 'RECONCILIATION_REQUIRED',
        observedUsd6: outcome.observation?.costUsd6 ?? null,
        usage: outcome.observation?.usage ?? null,
        stopped: outcome.observation?.stopped ?? false,
      });
    }
    await client.query(
      'UPDATE calls SET state=$2,error_code=$3,updated_at=now() WHERE id=$1',
      [call.id, outcome.state, outcome.errorCode],
    );
    await client.query(
      `UPDATE jobs SET state=$3,last_error_code=$4,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
      WHERE id=$1 AND lease_token=$2`,
      [
        job.id,
        job.lease_token,
        outcome.actualUsd6 === null ? 'dead' : 'succeeded',
        outcome.errorCode,
      ],
    );
  });
}

export type CallWorkerOptions = {
  /** How often a running call checks for a cancellation request (ms). */
  cancelPollMs?: number;
  /**
   * Optional cap on how long a stopped call may drain (ms). By default the
   * drain runs to the request's own overall chat deadline, so stopping never
   * gives a worse billing outcome than letting the request finish.
   */
  drainTimeoutMs?: number;
  /** How often the job lease is renewed (ms). */
  heartbeatMs?: number;
};

const LEASE_SECONDS = 120;
// A failed renewal query is not a lost lease. Give up only well before the
// last successful renewal could expire and let recovery take over.
const LEASE_RENEWAL_LIMIT_MS = 90_000;
// The provider's own deadline fires first and keeps its outcome (GATEWAY_TIMEOUT);
// this backstop only bounds a provider that never ends its stream.
const DEADLINE_GRACE_MS = 5_000;
const DEFAULT_CHAT_TIMEOUT_MS = 240_000;

/** Milliseconds a stopped call may keep draining, measured from the stop. */
export function drainBoundMs(input: {
  dispatchedAt: number;
  stoppedAt: number;
  chatTimeoutMs?: number;
  drainTimeoutMs?: number;
}) {
  const deadline =
    input.dispatchedAt +
    (input.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS) +
    DEADLINE_GRACE_MS;
  return Math.max(
    0,
    Math.min(
      deadline - input.stoppedAt,
      input.drainTimeoutMs ?? Number.POSITIVE_INFINITY,
    ),
  );
}

function option(value: number | undefined, fallback: number) {
  if (value === undefined) return fallback;
  requireCondition(
    Number.isInteger(value) && value >= 5 && value <= 300_000,
    500,
    'INVALID_WORKER_CONFIGURATION',
    'The worker configuration is invalid.',
  );
  return value;
}

/** Applies the route markup to a canonical provider cost. */
function marked(costUsd6: number, markupBps: number) {
  return ceilRatio(
    BigInt(costUsd6) * BigInt(10000 + markupBps),
    10000n,
  ).toString();
}

export async function runNextCall(
  pool: Pool,
  provider: GatewayClient,
  keyring: DataKeyring,
  options: CallWorkerOptions = {},
): Promise<boolean> {
  const cancelPollMs = option(options.cancelPollMs, 500);
  const heartbeatMs = option(options.heartbeatMs, 2000);
  const drainTimeoutMs =
    options.drainTimeoutMs === undefined
      ? undefined
      : option(options.drainTimeoutMs, 0);
  const chatTimeoutMs =
    typeof provider.chatTimeoutMs === 'number'
      ? provider.chatTimeoutMs
      : DEFAULT_CHAT_TIMEOUT_MS;
  const job = await claimJob(pool, ['inference'], LEASE_SECONDS);
  if (!job) return false;
  const call = await one<CallRecord>(
    pool,
    `SELECT c.*,h.request_hash,h.cancel_requested_at FROM calls c JOIN holds h ON h.id=c.hold_id WHERE c.id=$1`,
    [job.payload.callId],
  );
  if (!call) {
    await transaction(pool, async (client) => {
      await ownLease(client, job);
      await client.query(
        "UPDATE jobs SET state='dead',last_error_code='CALL_NOT_FOUND',lease_token=NULL,lease_expires_at=NULL WHERE id=$1",
        [job.id],
      );
    });
    return true;
  }
  let dispatched = false,
    output = '',
    savedLength = 0,
    finalCost: number | null = null,
    markupBps = 0;
  let finished = false,
    providerReference: string | null = null;
  // A cancellation freezes delivered output; the stream keeps draining so the
  // final usage can settle the hold exactly.
  let stopping = false,
    drainTimedOut = false;
  let lastUsage: GatewayUsage | null = null,
    lastSettlement: number | null = null;
  let heartbeatBusy = false,
    pollBusy = false,
    lastRenewal = Date.now(),
    dispatchedAt = 0;
  const controller = new AbortController();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let cancelPoll: ReturnType<typeof setInterval> | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopping || controller.signal.aborted) return;
    stopping = true;
    drainTimer = setTimeout(
      () => {
        drainTimedOut = true;
        controller.abort();
      },
      drainBoundMs({
        dispatchedAt,
        stoppedAt: Date.now(),
        chatTimeoutMs,
        drainTimeoutMs,
      }),
    );
  };
  const observation = (): Observation => ({
    costUsd6:
      lastSettlement !== null && lastSettlement > 0
        ? marked(lastSettlement, markupBps)
        : null,
    usage: lastUsage,
    stopped: stopping,
  });
  try {
    if (call.cancel_requested_at) {
      await complete(pool, job, call, {
        state: 'cancelled',
        actualUsd6: '0',
        providerReference: null,
        errorCode: null,
      });
      return true;
    }
    const route = await one<RouteVersion>(
      pool,
      'SELECT *,expires_at>now() AS fresh FROM route_versions WHERE id=$1',
      [call.route_version_id],
    );
    assertUsableRoute(route);
    markupBps = route.pricing.markupBps;
    const raw = await decryptText(
      call.input_ciphertext,
      `${call.account_id}:call-input:${call.id}`,
      keyring,
    );
    const stored = JSON.parse(raw) as Record<string, unknown>;
    const input =
      (await trustedBriefSynthesisInput(pool, call, stored, keyring)) ??
      (await trustedCrossCheckInput(pool, call, stored, keyring)) ??
      parseChatInput(stored);
    requireCondition(
      (await callRequestHash(call.project_id, call.route_version_id, input)) ===
        call.request_hash,
      409,
      'REQUEST_INTEGRITY_FAILED',
      'The stored request no longer matches its reservation.',
    );
    for (const message of input.messages)
      requireCondition(
        !scanPrompt(message.content).findings.some(
          (finding) => finding.severity === 'block',
        ),
        422,
        'SENSITIVE_CONTENT',
        'Sensitive content must be redacted.',
      );
    await transaction(pool, async (client) => {
      await ownLease(client, job);
      const eligible = await one(
        client,
        `SELECT a.id FROM accounts a JOIN projects p ON p.account_id=a.id
        JOIN route_versions r ON r.id=$3 WHERE a.id=$1 AND p.id=$2 AND a.disabled_at IS NULL
        AND p.archived_at IS NULL AND r.enabled AND r.expires_at>now() FOR SHARE OF a,p,r`,
        [call.account_id, call.project_id, call.route_version_id],
      );
      requireCondition(
        eligible,
        409,
        'DISPATCH_NOT_AUTHORIZED',
        'This account, project or route is unavailable for dispatch.',
      );
      const hold = await one(
        client,
        `UPDATE holds SET state='running',updated_at=now()
        WHERE id=$1 AND state='held' AND cancel_requested_at IS NULL RETURNING id`,
        [call.hold_id],
      );
      requireCondition(
        hold,
        409,
        'HOLD_NOT_DISPATCHABLE',
        'This reservation is not available for dispatch.',
      );
      await client.query(
        "UPDATE calls SET state='running',updated_at=now() WHERE id=$1",
        [call.id],
      );
    });
    heartbeat = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void (async () => {
        try {
          if (await heartbeatJob(pool, job, LEASE_SECONDS))
            lastRenewal = Date.now();
          // The lease is definitely gone: recovery owns this request now.
          else controller.abort();
        } catch {
          if (Date.now() - lastRenewal > LEASE_RENEWAL_LIMIT_MS)
            controller.abort();
        } finally {
          heartbeatBusy = false;
        }
      })();
    }, heartbeatMs);
    // Cancellation is checked far more often than the lease is renewed.
    cancelPoll = setInterval(() => {
      if (pollBusy || stopping) return;
      pollBusy = true;
      void one<{ cancel_requested_at: Date | null }>(
        pool,
        'SELECT cancel_requested_at FROM holds WHERE id=$1',
        [call.hold_id],
      )
        .then((hold) => {
          if (hold?.cancel_requested_at) stop();
        })
        // The heartbeat owns database-loss handling.
        .catch(() => {})
        .finally(() => {
          pollBusy = false;
        });
    }, cancelPollMs);
    dispatched = true;
    dispatchedAt = Date.now();
    for await (const event of provider.chat({
      modelId: route.model_id,
      messages: input.messages,
      maxOutputTokens: input.maxOutputTokens,
      privacy: input.privacy,
      // Settle at GATEWAY's reported cost; reviewed prices price usage only when
      // no provider cost is reported.
      pricing: {
        inputPerMillionUsd6: route.pricing.inputPerMillionUsd6,
        outputPerMillionUsd6: route.pricing.outputPerMillionUsd6,
      },
      signal: controller.signal,
      requestId: call.id,
    })) {
      if (event.type === 'reference') {
        if (
          providerReference === null &&
          typeof event.providerId === 'string'
        ) {
          providerReference = event.providerId;
          // Persist at once so a pending or interrupted hold stays matchable.
          await pool.query(
            `UPDATE holds SET provider_reference=$2,updated_at=now()
            WHERE id=$1 AND state='running' AND provider_reference IS NULL`,
            [call.hold_id, providerReference],
          );
        }
        continue;
      }
      if (event.type === 'usage') {
        lastUsage = event.usage;
        lastSettlement = event.settlementUsd6 ?? null;
        continue;
      }
      if ((event.type === 'text' || event.type === 'refusal') && !stopping) {
        output += event.text;
        if (output.length > 500_000)
          throw new GatewayError('response_too_large', true);
        if (output.length - savedLength >= 256) {
          if (await persistOutput(pool, job, call, output, keyring)) stop();
          savedLength = output.length;
        }
      }
      if (event.type === 'done') {
        finished = true;
        finalCost = event.costUsd6;
        if (typeof event.providerId === 'string')
          providerReference ??= event.providerId;
      }
    }
    await persistOutput(pool, job, call, output, keyring);
    if (!finished || finalCost === null || finalCost <= 0) {
      await complete(pool, job, call, {
        state: 'reconciliation_pending',
        actualUsd6: null,
        providerReference,
        errorCode: finished ? 'USAGE_UNCONFIRMED' : 'STREAM_INTERRUPTED',
        observation: observation(),
      });
    } else {
      // A stopped run keeps the output delivered before the stop and is
      // charged exactly what the whole generation cost.
      await complete(pool, job, call, {
        state: stopping ? 'cancelled' : 'succeeded',
        actualUsd6: marked(finalCost, markupBps),
        providerReference,
        errorCode: null,
      });
    }
  } catch (error) {
    if (error instanceof ServiceError && error.code === 'JOB_LEASE_LOST')
      return true;
    const ambiguous =
      dispatched && (!(error instanceof GatewayError) || error.billingAmbiguous);
    const errorCode = drainTimedOut
      ? 'CANCEL_DRAIN_TIMEOUT'
      : error instanceof GatewayError
        ? `GATEWAY_${error.code.toUpperCase()}`
        : error instanceof ServiceError
          ? error.code
          : 'REQUEST_FAILED';
    try {
      if (output) await persistOutput(pool, job, call, output, keyring);
      const cancellation = !dispatched
        ? await one(pool, 'SELECT cancel_requested_at FROM holds WHERE id=$1', [
            call.hold_id,
          ])
        : null;
      await complete(pool, job, call, {
        state: ambiguous
          ? 'reconciliation_pending'
          : stopping || cancellation?.cancel_requested_at
            ? 'cancelled'
            : 'failed',
        actualUsd6: ambiguous ? null : '0',
        providerReference,
        errorCode,
        observation: observation(),
      });
    } catch (cleanupError) {
      if (
        !(
          cleanupError instanceof ServiceError &&
          cleanupError.code === 'JOB_LEASE_LOST'
        )
      )
        throw cleanupError;
      // Recovery now owns this request; stale workers must not overwrite its state.
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (cancelPoll) clearInterval(cancelPoll);
    if (drainTimer) clearTimeout(drainTimer);
    controller.abort();
  }
  // Deterministic evaluation runs after settlement. A parser/storage failure must
  // never reinterpret an already completed provider request or retry paid work.
  await evaluateBriefSynthesisForCall(pool, call.id, keyring);
  return true;
}
