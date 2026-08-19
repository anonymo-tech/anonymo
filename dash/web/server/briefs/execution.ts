import { gatewayConfigured } from '../gateway/origin.ts';
import type { Pool, PoolClient } from 'pg';
import { one, transaction } from '../db/database.ts';
import { enqueue } from '../db/jobs.ts';
import { requireCondition } from '../core/errors.ts';
import {
  configuredKeyring,
  encryptText,
  decryptText,
  type DataKeyring,
} from '../core/encryption.ts';
import { digestText } from '../core/digest.ts';
import { reserveQuoteInTransaction } from '../ledger/ledger.ts';
import { readBriefDocument } from '../routes/brief-documents.ts';
import {
  assertUsableRoute,
  quoteMaximum,
  callRequestHash,
  type RouteVersion,
  type ChatInput,
} from '../routes/call-contract.ts';
import { parseSynthesisOutput } from '../../lib/brief-synthesis.ts';
import { scanPrompt } from '../../lib/guards/index.ts';
import {
  SYNTHESIS_LIMITS,
  buildBriefSynthesisInput,
  hashSynthesisText,
} from './protocol.ts';
import {
  ownedSynthesisPlan,
  readSynthesisSnapshot,
  getBriefSynthesis,
  type SynthesisPlan,
  type SynthesisQuote,
} from './store.ts';

export function briefSynthesisConfigured(
  env: Record<string, string | undefined> = process.env,
) {
  if (
    env.CONCLAVE_MODE !== 'service' ||
    env.CONCLAVE_BRIEF_SYNTHESIS_ENABLED !== 'true' ||
    env.CONCLAVE_INFERENCE_ENABLED !== 'true' ||
    !gatewayConfigured(env) ||
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
    briefSynthesisConfigured(),
    503,
    'SYNTHESIS_EXECUTION_DISABLED',
    'Brief analysis is not enabled and configured. Saved runs remain available.',
  );
}
export async function briefSynthesisCapability(pool: Pool) {
  if (!briefSynthesisConfigured())
    return {
      configured: false,
      reason: 'EXECUTION_DISABLED_OR_UNCONFIGURED',
      limits: SYNTHESIS_LIMITS,
    };
  const routes = await pool.query<RouteVersion>(
    "SELECT *,expires_at>now() AS fresh FROM route_versions WHERE enabled AND modality='chat' AND expires_at>now() ORDER BY id LIMIT 100",
  );
  for (const route of routes.rows) {
    try {
      assertUsableRoute(route);
      return {
        configured: true,
        reason: 'REQUIRES_EXPLICIT_QUOTE_APPROVAL',
        limits: SYNTHESIS_LIMITS,
      };
    } catch {
      /* Unreviewed routes are not selectable. */
    }
  }
  return {
    configured: false,
    reason: 'REVIEWED_ROUTE_REQUIRED',
    limits: SYNTHESIS_LIMITS,
  };
}
async function lockAccount(db: PoolClient, accountId: string, active = true) {
  requireCondition(
    await one(
      db,
      'SELECT id FROM accounts WHERE id=$1 AND (NOT $2::boolean OR disabled_at IS NULL) FOR UPDATE',
      [accountId, active],
    ),
    401,
    'ACCOUNT_UNAVAILABLE',
    'This account is unavailable.',
  );
}
async function lockBrief(db: PoolClient, accountId: string, briefId: string) {
  const row = await one<{ project_id: string; revision: number }>(
    db,
    'SELECT project_id,revision FROM briefs WHERE id=$1 AND account_id=$2 FOR UPDATE',
    [briefId, accountId],
  );
  requireCondition(row, 404, 'BRIEF_NOT_FOUND', 'This Brief is unavailable.');
  requireCondition(
    await one(
      db,
      'SELECT id FROM projects WHERE id=$1 AND account_id=$2 AND archived_at IS NULL FOR SHARE',
      [row.project_id, accountId],
    ),
    404,
    'PROJECT_NOT_FOUND',
    'This project is unavailable.',
  );
  return row;
}

export async function quoteBriefSynthesis(
  pool: Pool,
  input: {
    accountId: string;
    briefId: string;
    evidenceHash: string;
    routeVersionId: string;
    maxOutputTokens: number;
  },
  keyring: DataKeyring,
) {
  requireExecution();
  return transaction(pool, async (db) => {
    await lockAccount(db, input.accountId);
    const route = await one<RouteVersion & { expires_at: Date }>(
      db,
      'SELECT *,expires_at>now() AS fresh FROM route_versions WHERE id=$1 FOR UPDATE',
      [input.routeVersionId],
    );
    assertUsableRoute(route);
    const brief = await lockBrief(db, input.accountId, input.briefId),
      document = await readBriefDocument(db, input.accountId, input.briefId);
    requireCondition(
      document,
      409,
      'STRUCTURED_BRIEF_REQUIRED',
      'Choose a Brief with immutable source responses.',
    );
    requireCondition(
      document.evidenceHash === input.evidenceHash,
      409,
      'EVIDENCE_CHANGED',
      'Reload this Brief before requesting analysis.',
    );
    const chat = buildBriefSynthesisInput(
        document.evidence,
        document.evidenceHash,
        input.maxOutputTokens,
      ),
      maximumUsd6 = quoteMaximum(route, chat),
      requestHash = await callRequestHash(brief.project_id, route.id, chat);
    const planId = crypto.randomUUID(),
      quoteId = crypto.randomUUID();
    const saved = await one<{ expires_at: Date }>(
      db,
      `INSERT INTO quotes(id,account_id,project_id,route_version_id,request_hash,max_usd6,max_output_tokens,expires_at) VALUES($1,$2,$3,$4,$5,$6,$8,LEAST(now()+interval '120 seconds',$7)) RETURNING expires_at`,
      [
        quoteId,
        input.accountId,
        brief.project_id,
        route.id,
        requestHash,
        maximumUsd6,
        route.expires_at,
        chat.maxOutputTokens,
      ],
    );
    const terms: SynthesisQuote = {
      id: quoteId,
      maximumUsd6,
      expiresAt: saved!.expires_at.toISOString(),
      maxOutputTokens: chat.maxOutputTokens,
      inputBytes: chat.messages.reduce(
        (n, m) => n + new TextEncoder().encode(m.content).byteLength,
        0,
      ),
      requestHash,
      routeVersionId: route.id,
      modelId: route.model_id,
      family: route.family,
      card: route.card,
      markupBps: route.pricing.markupBps,
    };
    await db.query(
      `INSERT INTO brief_synthesis_plans(id,account_id,project_id,brief_id,source_brief_id,quote_id,evidence_hash,prompt_version,output_version,snapshot_ciphertext,terms) VALUES($1,$2,$3,$4,$4,$5,$6,1,1,$7,$8)`,
      [
        planId,
        input.accountId,
        brief.project_id,
        input.briefId,
        quoteId,
        document.evidenceHash,
        await encryptText(
          JSON.stringify({
            savedAt: document.savedAt,
            evidence: document.evidence,
          }),
          `${input.accountId}:brief-synthesis-snapshot:${planId}`,
          keyring,
        ),
        JSON.stringify(terms),
      ],
    );
    return {
      plan: await getBriefSynthesis(db, input.accountId, planId, keyring),
      quote: terms,
    };
  });
}

export async function approveBriefSynthesis(
  pool: Pool,
  input: {
    accountId: string;
    runId: string;
    quoteId: string;
    idempotencyKey: string;
    approveMaximumUsd6: string;
  },
  keyring: DataKeyring,
) {
  return transaction(pool, async (db) => {
    await lockAccount(db, input.accountId);
    const plan = await ownedSynthesisPlan(db, input.accountId, input.runId);
    requireCondition(
      input.quoteId === plan.quote_id &&
        input.idempotencyKey === `bs_${plan.id}` &&
        input.approveMaximumUsd6 === plan.terms.maximumUsd6,
      409,
      'SYNTHESIS_APPROVAL_MISMATCH',
      'Review and approve the exact saved quote and maximum.',
    );
    const approvalHash = await digestText(
      'brief-synthesis-approval',
      JSON.stringify({
        planId: plan.id,
        quoteId: plan.quote_id,
        evidenceHash: plan.evidence_hash,
        maximumUsd6: plan.terms.maximumUsd6,
      }),
    );
    const previous = await one<{ approval_hash: string }>(
      db,
      'SELECT approval_hash FROM brief_synthesis_executions WHERE plan_id=$1',
      [plan.id],
    );
    if (previous) {
      requireCondition(
        previous.approval_hash === approvalHash,
        409,
        'IDEMPOTENCY_CONFLICT',
        'This approval belongs to different terms.',
      );
      return {
        run: await getBriefSynthesis(db, input.accountId, plan.id, keyring),
        replayed: true,
      };
    }
    requireExecution();
    requireCondition(
      plan.brief_id,
      410,
      'BRIEF_REMOVED',
      'This source Brief was removed.',
    );
    const route = await one<RouteVersion>(
      db,
      'SELECT *,expires_at>now() AS fresh FROM route_versions WHERE id=$1 FOR UPDATE',
      [plan.terms.routeVersionId],
    );
    assertUsableRoute(route);
    await lockBrief(db, input.accountId, plan.brief_id);
    const source = await readSynthesisSnapshot(plan, keyring),
      chat = buildBriefSynthesisInput(
        source.evidence,
        plan.evidence_hash,
        plan.terms.maxOutputTokens,
      );
    requireCondition(
      (await callRequestHash(plan.project_id, route.id, chat)) ===
        plan.terms.requestHash &&
        quoteMaximum(route, chat) === plan.terms.maximumUsd6,
      409,
      'QUOTE_MISMATCH',
      'The saved request no longer matches its quote.',
    );
    const evidence = await one<{ evidence_hash: string }>(
      db,
      'SELECT evidence_hash FROM brief_documents WHERE brief_id=$1',
      [plan.brief_id],
    );
    requireCondition(
      evidence?.evidence_hash === plan.evidence_hash,
      409,
      'EVIDENCE_CHANGED',
      'The saved source no longer matches this analysis.',
    );
    // A transaction can wait for the owner lock after it starts. PostgreSQL
    // now() remains that earlier start time, so use the actual acceptance time.
    const currentQuote = await one<{ usable: boolean }>(
      db,
      `SELECT q.expires_at>clock_timestamp() AND r.expires_at>clock_timestamp() AS usable
       FROM quotes q JOIN route_versions r ON r.id=q.route_version_id
       WHERE q.id=$1 AND q.account_id=$2 FOR UPDATE OF q`,
      [plan.quote_id, input.accountId],
    );
    requireCondition(
      currentQuote?.usable,
      409,
      'QUOTE_EXPIRED',
      'Request a new quote before continuing.',
    );
    const reservation = await reserveQuoteInTransaction(
      db,
      {
        accountId: input.accountId,
        quoteId: plan.quote_id,
        idempotencyKey: `bs_${plan.id}`,
        requestHash: plan.terms.requestHash,
      },
      async (client, hold) => {
        const callId = crypto.randomUUID();
        await client.query(
          `INSERT INTO calls(id,account_id,project_id,route_version_id,hold_id,input_ciphertext,state) VALUES($1,$2,$3,$4,$5,$6,'queued')`,
          [
            callId,
            input.accountId,
            plan.project_id,
            route.id,
            hold.id,
            await encryptText(
              JSON.stringify(chat),
              `${input.accountId}:call-input:${callId}`,
              keyring,
            ),
          ],
        );
        await client.query(
          'INSERT INTO brief_synthesis_executions(plan_id,account_id,call_id,approval_hash,approved_maximum_usd6) VALUES($1,$2,$3,$4,$5)',
          [
            plan.id,
            input.accountId,
            callId,
            approvalHash,
            plan.terms.maximumUsd6,
          ],
        );
        await client.query(
          'INSERT INTO brief_synthesis_evaluation_progress(plan_id) VALUES($1)',
          [plan.id],
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
      !reservation.replayed,
      409,
      'SYNTHESIS_LINKAGE_UNAVAILABLE',
      'The saved approval requires reconciliation.',
    );
    return {
      run: await getBriefSynthesis(db, input.accountId, plan.id, keyring),
      replayed: false,
    };
  });
}

export async function trustedBriefSynthesisInput(
  pool: Pool,
  call: {
    id: string;
    account_id: string;
    project_id: string;
    route_version_id: string;
  },
  stored: unknown,
  keyring: DataKeyring,
): Promise<ChatInput | null> {
  const plan = await one<SynthesisPlan>(
    pool,
    'SELECT p.* FROM brief_synthesis_plans p JOIN brief_synthesis_executions e ON e.plan_id=p.id WHERE e.call_id=$1',
    [call.id],
  );
  if (!plan) return null;
  requireExecution();
  requireCondition(
    plan.account_id === call.account_id &&
      plan.project_id === call.project_id &&
      plan.terms.routeVersionId === call.route_version_id &&
      plan.brief_id,
    409,
    'SYNTHESIS_LINKAGE_UNAVAILABLE',
    'The analysis source is unavailable.',
  );
  const source = await readSynthesisSnapshot(plan, keyring),
    input = buildBriefSynthesisInput(
      source.evidence,
      plan.evidence_hash,
      plan.terms.maxOutputTokens,
    );
  requireCondition(
    JSON.stringify(input) === JSON.stringify(stored) &&
      (await callRequestHash(plan.project_id, call.route_version_id, input)) ===
        plan.terms.requestHash,
    409,
    'SYNTHESIS_INPUT_MISMATCH',
    'The analysis request does not match its source.',
  );
  return input;
}

export async function evaluateBriefSynthesisForCall(
  pool: Pool,
  callId: string,
  keyring: DataKeyring,
) {
  const owner = await one<{ account_id: string; plan_id: string }>(
    pool,
    'SELECT account_id,plan_id FROM brief_synthesis_executions WHERE call_id=$1',
    [callId],
  );
  if (!owner) return null;
  return transaction(pool, async (db) => {
    await lockAccount(db, owner.account_id, false);
    const plan = await ownedSynthesisPlan(db, owner.account_id, owner.plan_id);
    if (
      await one(
        db,
        'SELECT plan_id FROM brief_synthesis_results WHERE plan_id=$1',
        [plan.id],
      )
    )
      return getBriefSynthesis(db, owner.account_id, plan.id, keyring);
    const call = await one<{
      state: string;
      output_ciphertext: string | null;
      billing_state: string;
    }>(
      db,
      'SELECT c.state,c.output_ciphertext,h.state AS billing_state FROM calls c JOIN holds h ON h.id=c.hold_id WHERE c.id=$1 AND c.account_id=$2 FOR SHARE OF c,h',
      [callId, owner.account_id],
    );
    requireCondition(
      call,
      503,
      'SYNTHESIS_LINKAGE_UNAVAILABLE',
      'The analysis call is unavailable.',
    );
    if (
      !['succeeded', 'failed', 'cancelled'].includes(call.state) ||
      !['captured', 'released'].includes(call.billing_state)
    )
      return getBriefSynthesis(db, owner.account_id, plan.id, keyring);
    let status: 'valid' | 'invalid' | 'failed' | 'cancelled',
      reason: string | null = null,
      outputHash: string | null = null,
      ciphertext: string | null = null;
    if (call.state === 'succeeded') {
      requireCondition(
        call.output_ciphertext,
        503,
        'CONTENT_UNAVAILABLE',
        'The completed response is unavailable.',
      );
      const output = await decryptText(
          call.output_ciphertext,
          `${owner.account_id}:call-output:${callId}`,
          keyring,
        ),
        snapshot = await readSynthesisSnapshot(plan, keyring);
      outputHash = await hashSynthesisText(output);
      let analysis: ReturnType<typeof parseSynthesisOutput> | null = null;
      try {
        analysis = parseSynthesisOutput(output, snapshot.evidence);
        if (scanPrompt(output).findings.some((f) => f.severity === 'block'))
          throw new Error();
        status = 'valid';
      } catch {
        status = 'invalid';
        reason = 'INVALID_SYNTHESIS_OUTPUT';
      }
      if (status === 'valid')
        ciphertext = await encryptText(
          JSON.stringify(analysis),
          `${owner.account_id}:brief-synthesis-result:${plan.id}`,
          keyring,
        );
    } else {
      status = call.state === 'cancelled' ? 'cancelled' : 'failed';
      reason = status === 'cancelled' ? 'CALL_CANCELLED' : 'CALL_FAILED';
    }
    await db.query(
      'INSERT INTO brief_synthesis_results(plan_id,status,output_hash,result_ciphertext,invalid_reason) VALUES($1,$2,$3,$4,$5)',
      [plan.id, status, outputHash, ciphertext, reason],
    );
    return getBriefSynthesis(db, owner.account_id, plan.id, keyring);
  });
}

/** Deterministic local evaluation only; never queues or retries a provider call. */
export async function runBriefSynthesisSweep(
  pool: Pool,
  keyring: DataKeyring,
  limit = 20,
) {
  requireCondition(
    Number.isInteger(limit) && limit >= 1 && limit <= 20,
    400,
    'INVALID_SWEEP_LIMIT',
    'Use a bounded analysis sweep.',
  );
  const rows = await pool.query<{ plan_id: string; call_id: string }>(
    `SELECT e.plan_id,e.call_id FROM brief_synthesis_executions e JOIN calls c ON c.id=e.call_id JOIN holds h ON h.id=c.hold_id JOIN brief_synthesis_evaluation_progress p ON p.plan_id=e.plan_id LEFT JOIN brief_synthesis_results r ON r.plan_id=e.plan_id WHERE r.plan_id IS NULL AND c.state IN ('succeeded','failed','cancelled') AND h.state IN ('captured','released') AND p.next_attempt_at<=now() ORDER BY p.next_attempt_at,e.plan_id LIMIT $1`,
    [limit],
  );
  let evaluated = 0,
    failed = 0;
  for (const row of rows.rows) {
    const claimed = await pool.query(
      `UPDATE brief_synthesis_evaluation_progress SET next_attempt_at=now()+interval '60 seconds' WHERE plan_id=$1 AND next_attempt_at<=now() RETURNING plan_id`,
      [row.plan_id],
    );
    if (!claimed.rowCount) continue;
    try {
      await evaluateBriefSynthesisForCall(pool, row.call_id, keyring);
      evaluated++;
    } catch {
      failed++;
      await pool.query(
        `UPDATE brief_synthesis_evaluation_progress SET attempts=LEAST(attempts+1,1000000),last_error_code='EVALUATION_UNAVAILABLE',next_attempt_at=now()+make_interval(secs=>LEAST(3600,30*power(2,LEAST(attempts,7)))::integer) WHERE plan_id=$1`,
        [row.plan_id],
      );
    }
  }
  return { evaluated, failed };
}
