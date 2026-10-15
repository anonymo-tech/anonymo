import type { Pool, PoolClient } from 'pg';
import { one, transaction } from '../db/database.ts';
import { enqueue } from '../db/jobs.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';
import {
  configuredKeyring,
  encryptText,
  type DataKeyring,
} from '../core/encryption.ts';
import { digestText } from '../core/digest.ts';
import { publicInferenceErrorCode } from '../routes/public-inference.ts';
import { reserveQuoteInTransaction } from '../ledger/ledger.ts';
import { scanPrompt } from '../../lib/guards/index.ts';
import {
  assertUsableRoute,
  parseChatInput,
  quoteMaximum,
  callRequestHash,
  type ChatInput,
  type RouteVersion,
} from '../routes/call-contract.ts';
import {
  completeCrossCheckFromCalls,
  listReviewerRosters,
  readCrossCheckExecutionPlan,
} from './store.ts';

export const CROSSCHECK_EXECUTION_LIMITS = Object.freeze({
  calls: 24,
  maximumUsd6: '10000000',
  quoteSeconds: 120,
});
type Prepared = Awaited<ReturnType<typeof readCrossCheckExecutionPlan>>;
type PricedReview = {
  claimId: string;
  reviewerId: string;
  routeVersionId: string;
  input: ChatInput;
  requestHash: string;
  maximumUsd6: string;
  route: RouteVersion & { expires_at: Date };
};
type GroupQuote = {
  id: string;
  run_id: string;
  account_id: string;
  request_hash: string;
  maximum_usd6: string;
  max_output_tokens: number;
  review_count: number;
  terms: Record<string, unknown>[];
  expires_at: Date;
};

export function crossCheckExecutionConfigured(
  env: Record<string, string | undefined> = process.env,
) {
  if (
    env.CONCLAVE_MODE !== 'service' ||
    env.CONCLAVE_CROSSCHECK_ENABLED !== 'true' ||
    env.CONCLAVE_INFERENCE_ENABLED !== 'true' ||
    !env.PPQ_API_KEY ||
    !env.CONCLAVE_APP_ORIGIN ||
    !env.CONCLAVE_DATABASE_URL
  )
    return false;
  try {
    configuredKeyring(env);
    return true;
  } catch {
    return false;
  }
}
function requireExecution() {
  requireCondition(
    crossCheckExecutionConfigured(),
    503,
    'CROSSCHECK_EXECUTION_DISABLED',
    'Cross-Check execution is not enabled and configured. Prepared plans remain unreviewed.',
  );
}

async function lockReviewRoutes(
  db: PoolClient,
  accountId: string,
  runId: string,
) {
  // Lock before roster validation takes shared locks, avoiding upgrade deadlocks
  // when two accounts quote the same reviewer roster concurrently.
  await db.query(
    `SELECT r.id FROM route_versions r WHERE r.id::text IN
    (SELECT item->>'routeVersionId' FROM crosscheck_runs c JOIN crosscheck_rosters ro ON ro.id=c.roster_id
      CROSS JOIN LATERAL jsonb_array_elements(ro.reviewers) item WHERE c.id=$1 AND c.account_id=$2)
    ORDER BY r.id FOR UPDATE`,
    [runId, accountId],
  );
}

export async function crossCheckCapability(pool: Pool) {
  if (!crossCheckExecutionConfigured())
    return {
      configured: false,
      reason: 'EXECUTION_DISABLED_OR_UNCONFIGURED',
      limits: CROSSCHECK_EXECUTION_LIMITS,
    };
  const rosters = await listReviewerRosters(pool);
  for (const roster of rosters) {
    let usable = true;
    for (const reviewer of roster.reviewers) {
      const route = await one<RouteVersion>(
        pool,
        'SELECT *,expires_at>now() AS fresh FROM route_versions WHERE id=$1',
        [reviewer.id],
      );
      try {
        assertUsableRoute(route);
      } catch {
        usable = false;
        break;
      }
    }
    if (usable)
      return {
        configured: true,
        reason: 'REQUIRES_EXPLICIT_QUOTE_APPROVAL',
        limits: CROSSCHECK_EXECUTION_LIMITS,
      };
  }
  return {
    configured: false,
    reason: 'REVIEWED_ROSTER_REQUIRED',
    limits: CROSSCHECK_EXECUTION_LIMITS,
  };
}

async function priceReviews(
  db: PoolClient,
  prepared: Prepared,
  maxOutputTokens: number,
): Promise<PricedReview[]> {
  requireCondition(
    prepared.requests.length >= 3 &&
      prepared.requests.length <= CROSSCHECK_EXECUTION_LIMITS.calls,
    400,
    'CROSSCHECK_CALL_LIMIT',
    'Choose fewer claims or reviewers; one execution supports at most twenty-four reviews.',
  );
  // Acquire shared routes in one canonical order, before reservations upgrade them.
  const ids = [
    ...new Set(prepared.requests.map((request) => request.routeVersionId)),
  ].sort();
  await db.query(
    'SELECT id FROM route_versions WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [ids],
  );
  const priced: PricedReview[] = [];
  for (const request of prepared.requests) {
    const input = parseChatInput(
      { messages: request.messages, privacy: 'standard', maxOutputTokens },
      { trustedCrossCheck: true },
    );
    for (const message of input.messages)
      requireCondition(
        !scanPrompt(message.content).findings.some(
          (finding) => finding.severity === 'block',
        ),
        422,
        'SENSITIVE_CONTENT',
        'Sensitive content must be removed before review.',
      );
    const route = await one<RouteVersion & { expires_at: Date }>(
      db,
      'SELECT *,expires_at>now() AS fresh FROM route_versions WHERE id=$1',
      [request.routeVersionId],
    );
    assertUsableRoute(route);
    const maximumUsd6 = quoteMaximum(route, input);
    priced.push({
      ...request,
      input,
      route,
      maximumUsd6,
      requestHash: await callRequestHash(
        prepared.row.project_id,
        request.routeVersionId,
        input,
      ),
    });
  }
  const maximum = priced.reduce(
    (total, item) => total + BigInt(item.maximumUsd6),
    0n,
  );
  requireCondition(
    maximum > 0n && maximum <= BigInt(CROSSCHECK_EXECUTION_LIMITS.maximumUsd6),
    400,
    'CROSSCHECK_BUDGET_LIMIT',
    'This review exceeds the maximum group reservation.',
  );
  return priced;
}

function quoteResponse(row: GroupQuote) {
  return {
    quoteGroupId: row.id,
    runId: row.run_id,
    maximumUsd6: row.maximum_usd6,
    maxOutputTokens: row.max_output_tokens,
    reviewCount: row.review_count,
    terms: row.terms,
    expiresAt: row.expires_at,
    message:
      'Review every model route and the total maximum before approving. Agreement is not a guarantee of truth. No free recheck entitlement is implied.',
  };
}

export async function quoteCrossCheck(
  pool: Pool,
  input: { accountId: string; runId: string; maxOutputTokens: number },
  keyring: DataKeyring,
) {
  requireExecution();
  return transaction(pool, async (db) => {
    // Account first: use the same lock ordering as ledger reservations and settlement.
    requireCondition(
      await one(
        db,
        'SELECT id FROM accounts WHERE id=$1 AND disabled_at IS NULL FOR UPDATE',
        [input.accountId],
      ),
      401,
      'ACCOUNT_UNAVAILABLE',
      'This account is unavailable.',
    );
    await lockReviewRoutes(db, input.accountId, input.runId);
    const prepared = await readCrossCheckExecutionPlan(
      db,
      input.accountId,
      input.runId,
      keyring,
      Date.now(),
      true,
    );
    requireCondition(
      !(await one(db, 'SELECT id FROM crosscheck_executions WHERE run_id=$1', [
        input.runId,
      ])),
      409,
      'CROSSCHECK_ALREADY_STARTED',
      'This plan already has an execution.',
    );
    const reviews = await priceReviews(db, prepared, input.maxOutputTokens);
    // Only after all inputs/prices pass do we create any quotes.
    const id = crypto.randomUUID();
    const expiresAt = new Date(
      Math.min(
        Date.now() + CROSSCHECK_EXECUTION_LIMITS.quoteSeconds * 1000,
        prepared.plan.cache.expiresAtMs,
        Date.parse(prepared.roster.expiresAt),
        ...reviews.map((review) => review.route.expires_at.getTime()),
      ),
    );
    const terms = reviews.map((item) => ({
      claimId: item.claimId,
      reviewerId: item.reviewerId,
      routeVersionId: item.routeVersionId,
      modelId: item.route.model_id,
      family: item.route.family,
      distribution: prepared.plan.reviewers.find(
        (reviewer) => reviewer.id === item.reviewerId,
      )!.distribution,
      reviewerVersion: prepared.plan.reviewers.find(
        (reviewer) => reviewer.id === item.reviewerId,
      )!.version,
      card: item.route.card,
      maximumUsd6: item.maximumUsd6,
      markupBps: item.route.pricing.markupBps,
    }));
    const maximum = reviews
      .reduce((sum, item) => sum + BigInt(item.maximumUsd6), 0n)
      .toString();
    const requestHash = await digestText(
      'crosscheck-quote',
      JSON.stringify({
        runId: input.runId,
        planHash: prepared.plan.requestHash,
        maxOutputTokens: input.maxOutputTokens,
        reviews: reviews.map((item) => [
          item.claimId,
          item.reviewerId,
          item.requestHash,
          item.maximumUsd6,
        ]),
      }),
    );
    const group = await one<GroupQuote>(
      db,
      `INSERT INTO crosscheck_quotes(id,run_id,account_id,request_hash,maximum_usd6,max_output_tokens,review_count,terms,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        id,
        input.runId,
        input.accountId,
        requestHash,
        maximum,
        input.maxOutputTokens,
        reviews.length,
        JSON.stringify(terms),
        expiresAt,
      ],
    );
    for (const [position, item] of reviews.entries()) {
      const quoteId = crypto.randomUUID();
      await db.query(
        `INSERT INTO quotes(id,account_id,project_id,route_version_id,request_hash,max_usd6,max_output_tokens,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          quoteId,
          input.accountId,
          prepared.row.project_id,
          item.routeVersionId,
          item.requestHash,
          item.maximumUsd6,
          input.maxOutputTokens,
          expiresAt,
        ],
      );
      await db.query(
        `INSERT INTO crosscheck_quote_items(group_id,position,claim_id,reviewer_id,quote_id) VALUES($1,$2,$3,$4,$5)`,
        [id, position, item.claimId, item.reviewerId, quoteId],
      );
    }
    requireCondition(
      group,
      500,
      'CROSSCHECK_QUOTE_FAILED',
      'The review quote could not be saved.',
    );
    return quoteResponse(group);
  });
}

export async function enqueueCrossCheck(
  pool: Pool,
  input: {
    accountId: string;
    runId: string;
    quoteGroupId: string;
    idempotencyKey: string;
    approveMaximumUsd6: string;
  },
  keyring: DataKeyring,
) {
  requireCondition(
    /^[a-zA-Z0-9_-]{16,100}$/.test(input.idempotencyKey) &&
      /^[1-9][0-9]{0,7}$/.test(input.approveMaximumUsd6),
    400,
    'INVALID_APPROVAL',
    'Supply a random idempotency key and the exact quoted maximum.',
  );
  const requestHash = await digestText(
    'crosscheck-execution',
    JSON.stringify({
      runId: input.runId,
      quoteGroupId: input.quoteGroupId,
      approveMaximumUsd6: input.approveMaximumUsd6,
    }),
  );
  return transaction(pool, async (db) => {
    requireCondition(
      await one(
        db,
        'SELECT id FROM accounts WHERE id=$1 AND disabled_at IS NULL FOR UPDATE',
        [input.accountId],
      ),
      401,
      'ACCOUNT_UNAVAILABLE',
      'This account is unavailable.',
    );
    const previous = await one<{ id: string; request_hash: string }>(
      db,
      'SELECT id,request_hash FROM crosscheck_executions WHERE account_id=$1 AND idempotency_key=$2',
      [input.accountId, input.idempotencyKey],
    );
    if (previous) {
      requireCondition(
        previous.request_hash === requestHash,
        409,
        'IDEMPOTENCY_CONFLICT',
        'This key belongs to another review execution.',
      );
      return { id: previous.id, runId: input.runId, replayed: true };
    }
    requireExecution();
    await lockReviewRoutes(db, input.accountId, input.runId);
    const prepared = await readCrossCheckExecutionPlan(
      db,
      input.accountId,
      input.runId,
      keyring,
      Date.now(),
      true,
    );
    requireCondition(
      !(await one(db, 'SELECT id FROM crosscheck_executions WHERE run_id=$1', [
        input.runId,
      ])),
      409,
      'CROSSCHECK_ALREADY_STARTED',
      'This plan already has an execution.',
    );
    const group = await one<GroupQuote>(
      db,
      'SELECT * FROM crosscheck_quotes WHERE id=$1 AND run_id=$2 AND account_id=$3 AND expires_at>now() FOR UPDATE',
      [input.quoteGroupId, input.runId, input.accountId],
    );
    requireCondition(
      group,
      409,
      'CROSSCHECK_QUOTE_EXPIRED',
      'Request a new review quote.',
    );
    requireCondition(
      input.approveMaximumUsd6 === group.maximum_usd6,
      409,
      'CROSSCHECK_APPROVAL_MISMATCH',
      'Approve the exact total shown in the current quote.',
    );
    const reviews = await priceReviews(db, prepared, group.max_output_tokens);
    const quoteHash = await digestText(
      'crosscheck-quote',
      JSON.stringify({
        runId: input.runId,
        planHash: prepared.plan.requestHash,
        maxOutputTokens: group.max_output_tokens,
        reviews: reviews.map((item) => [
          item.claimId,
          item.reviewerId,
          item.requestHash,
          item.maximumUsd6,
        ]),
      }),
    );
    requireCondition(
      quoteHash === group.request_hash &&
        reviews.length === group.review_count &&
        reviews
          .reduce((sum, item) => sum + BigInt(item.maximumUsd6), 0n)
          .toString() === group.maximum_usd6,
      409,
      'CROSSCHECK_QUOTE_MISMATCH',
      'This plan no longer matches its quoted terms.',
    );
    const items = await db.query<{
      position: number;
      claim_id: string;
      reviewer_id: string;
      quote_id: string;
      request_hash: string;
      max_usd6: string;
    }>(
      `SELECT i.*,q.request_hash,q.max_usd6 FROM crosscheck_quote_items i JOIN quotes q ON q.id=i.quote_id
       WHERE i.group_id=$1 AND q.account_id=$2 AND q.project_id=$3 ORDER BY i.position`,
      [group.id, input.accountId, prepared.row.project_id],
    );
    requireCondition(
      items.rows.length === reviews.length,
      409,
      'CROSSCHECK_QUOTE_MISMATCH',
      'The review quote is incomplete.',
    );
    const executionId = crypto.randomUUID();
    await db.query(
      `INSERT INTO crosscheck_executions(id,run_id,account_id,quote_group_id,idempotency_key,request_hash,approved_maximum_usd6)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        executionId,
        input.runId,
        input.accountId,
        group.id,
        input.idempotencyKey,
        requestHash,
        group.maximum_usd6,
      ],
    );
    await db.query(
      'INSERT INTO crosscheck_evaluation_progress(run_id) VALUES($1)',
      [input.runId],
    );
    for (const [position, item] of reviews.entries()) {
      const saved = items.rows[position];
      requireCondition(
        saved.position === position &&
          saved.claim_id === item.claimId &&
          saved.reviewer_id === item.reviewerId &&
          saved.request_hash === item.requestHash &&
          saved.max_usd6 === item.maximumUsd6,
        409,
        'CROSSCHECK_QUOTE_MISMATCH',
        'A review no longer matches its quoted input.',
      );
      const callId = crypto.randomUUID();
      const encrypted = await encryptText(
        JSON.stringify(item.input),
        `${input.accountId}:call-input:${callId}`,
        keyring,
      );
      const reserved = await reserveQuoteInTransaction(
        db,
        {
          accountId: input.accountId,
          quoteId: saved.quote_id,
          idempotencyKey: `cc_${executionId}_${position}`,
          requestHash: item.requestHash,
        },
        async (client, hold) => {
          await client.query(
            `INSERT INTO calls(id,account_id,project_id,hold_id,route_version_id,input_ciphertext,state)
          VALUES($1,$2,$3,$4,$5,$6,'queued')`,
            [
              callId,
              input.accountId,
              prepared.row.project_id,
              hold.id,
              item.routeVersionId,
              encrypted,
            ],
          );
          await client.query(
            'INSERT INTO crosscheck_review_calls(run_id,claim_id,reviewer_id,call_id) VALUES($1,$2,$3,$4)',
            [input.runId, item.claimId, item.reviewerId, callId],
          );
          await enqueue(client, {
            kind: 'inference',
            reference: `inference:${callId}`,
            payload: { callId },
            maxAttempts: 1,
          });
        },
      );
      requireCondition(
        !reserved.replayed,
        409,
        'IDEMPOTENCY_CONFLICT',
        'A reviewer reservation already exists.',
      );
    }
    return { id: executionId, runId: input.runId, replayed: false };
  });
}

/** Only a durable, approved Cross-Check binding can enable a system-role call. */
export async function trustedCrossCheckInput(
  pool: Pool,
  call: {
    id: string;
    account_id: string;
    project_id: string;
    route_version_id: string;
  },
  raw: Record<string, unknown>,
  keyring: DataKeyring,
): Promise<ChatInput | null> {
  return transaction(pool, async (db) => {
    const bound = await one<{
      run_id: string;
      claim_id: string;
      reviewer_id: string;
    }>(
      db,
      `SELECT rc.run_id,rc.claim_id,rc.reviewer_id FROM crosscheck_review_calls rc
       JOIN crosscheck_executions e ON e.run_id=rc.run_id WHERE rc.call_id=$1 AND e.account_id=$2`,
      [call.id, call.account_id],
    );
    if (!bound) return null;
    requireExecution();
    const prepared = await readCrossCheckExecutionPlan(
      db,
      call.account_id,
      bound.run_id,
      keyring,
    );
    const request = prepared.requests.find(
      (item) =>
        item.claimId === bound.claim_id &&
        item.reviewerId === bound.reviewer_id,
    );
    requireCondition(
      request &&
        prepared.row.project_id === call.project_id &&
        request.routeVersionId === call.route_version_id,
      409,
      'CROSSCHECK_CALL_MISMATCH',
      'This call does not match its approved review.',
    );
    const input = parseChatInput(raw, { trustedCrossCheck: true });
    requireCondition(
      JSON.stringify(input.messages) === JSON.stringify(request.messages),
      409,
      'CROSSCHECK_CALL_MISMATCH',
      'This call changed its independent review instructions.',
    );
    return input;
  });
}

export async function crossCheckExecutionStatus(
  pool: Pool,
  accountId: string,
  runId: string,
) {
  const row = await one<{
    id: string;
    approved_maximum_usd6: string;
    has_result: boolean;
    last_error_code: string | null;
  }>(
    pool,
    `SELECT e.id,e.approved_maximum_usd6,ep.last_error_code,EXISTS(SELECT 1 FROM crosscheck_results v WHERE v.run_id=e.run_id) AS has_result
     FROM crosscheck_executions e JOIN crosscheck_runs r ON r.id=e.run_id JOIN projects p ON p.id=r.project_id JOIN accounts a ON a.id=e.account_id
     LEFT JOIN crosscheck_evaluation_progress ep ON ep.run_id=e.run_id
     WHERE e.run_id=$1 AND e.account_id=$2 AND p.account_id=$2 AND p.archived_at IS NULL AND a.disabled_at IS NULL`,
    [runId, accountId],
  );
  if (!row)
    return {
      state: 'not_started',
      calls: [],
      maximumUsd6: null,
      actualUsd6: null,
    };
  const calls = await pool.query<{
    id: string;
    claimId: string;
    reviewerId: string;
    state: string;
    errorCode: string | null;
    billingState: string;
    actualUsd6: string | null;
  }>(
    `SELECT c.id,rc.claim_id AS "claimId",rc.reviewer_id AS "reviewerId",c.state,c.error_code AS "errorCode",h.state AS "billingState",h.captured_usd6 AS "actualUsd6"
     FROM crosscheck_review_calls rc JOIN calls c ON c.id=rc.call_id JOIN holds h ON h.id=c.hold_id
     WHERE rc.run_id=$1 AND c.account_id=$2 ORDER BY rc.claim_id,rc.reviewer_id`,
    [runId, accountId],
  );
  const state = row.has_result
    ? 'reviewed'
    : row.last_error_code ||
        calls.rows.some((call) => call.state === 'reconciliation_pending')
      ? 'incomplete'
      : calls.rows.some((call) => call.state === 'running')
        ? 'running'
        : calls.rows.some((call) => call.state === 'queued')
          ? 'queued'
          : 'awaiting_evaluation';
  return {
    state,
    calls: calls.rows.map((call) => ({
      ...call,
      errorCode: publicInferenceErrorCode(call.errorCode),
    })),
    maximumUsd6: row.approved_maximum_usd6,
    evaluationNeedsAttention: !row.has_result && Boolean(row.last_error_code),
    actualUsd6: calls.rows.every((call) => call.actualUsd6 !== null)
      ? calls.rows
          .reduce((sum, call) => sum + BigInt(call.actualUsd6!), 0n)
          .toString()
      : null,
  };
}

/** Bounded, restart-safe evaluation; this sweep never invokes or retries an inference. */
export async function runCrossCheckSweep(
  pool: Pool,
  keyring: DataKeyring,
  limit = 10,
) {
  requireCondition(
    Number.isInteger(limit) && limit >= 1 && limit <= 20,
    500,
    'INVALID_WORKER_CONFIGURATION',
    'Invalid review sweep size.',
  );
  const rows = await pool.query<{ run_id: string; account_id: string }>(
    `SELECT e.run_id,e.account_id FROM crosscheck_executions e
    JOIN crosscheck_runs r ON r.id=e.run_id JOIN accounts a ON a.id=e.account_id JOIN projects p ON p.id=r.project_id
    JOIN crosscheck_evaluation_progress ep ON ep.run_id=e.run_id
    WHERE a.disabled_at IS NULL AND p.archived_at IS NULL AND p.account_id=e.account_id
      AND ep.next_attempt_at<=now()
      AND NOT EXISTS(SELECT 1 FROM crosscheck_results v WHERE v.run_id=e.run_id)
      AND NOT EXISTS(SELECT 1 FROM crosscheck_review_calls rc JOIN calls c ON c.id=rc.call_id JOIN holds h ON h.id=c.hold_id
        WHERE rc.run_id=e.run_id AND (c.state NOT IN ('succeeded','failed','cancelled') OR h.state NOT IN ('captured','released')))
    ORDER BY e.created_at,e.id LIMIT $1`,
    [limit],
  );
  let evaluated = 0,
    failed = 0;
  for (const row of rows.rows) {
    try {
      const bindings = await pool.query<{
        callId: string;
        claimId: string;
        reviewerId: string;
      }>(
        'SELECT call_id AS "callId",claim_id AS "claimId",reviewer_id AS "reviewerId" FROM crosscheck_review_calls WHERE run_id=$1',
        [row.run_id],
      );
      await completeCrossCheckFromCalls(
        pool,
        { accountId: row.account_id, runId: row.run_id, calls: bindings.rows },
        keyring,
      );
      await pool.query(
        'UPDATE crosscheck_evaluation_progress SET attempts=attempts+1,last_error_code=NULL,updated_at=now() WHERE run_id=$1',
        [row.run_id],
      );
      evaluated++;
    } catch (error) {
      const code =
        error instanceof ServiceError && /^[A-Z0-9_]{1,80}$/.test(error.code)
          ? error.code
          : 'EVALUATION_FAILED';
      await pool.query(
        `UPDATE crosscheck_evaluation_progress SET attempts=attempts+1,last_error_code=$2,updated_at=now(),
        next_attempt_at=now()+interval '1 second'*LEAST(3600,5*power(2,LEAST(attempts,10))) WHERE run_id=$1`,
        [row.run_id, code],
      );
      failed++;
    }
  }
  return { evaluated, failed };
}
