import { publicRouteCard } from './public-inference.ts';
import type { Pool } from 'pg';
import { one, transaction } from '../db/database.ts';
import {
  jsonResponse,
  readJson,
  stringField,
  uuidField,
} from '../core/http.ts';
import { requireCondition } from '../core/errors.ts';
import { configuredKeyring } from '../core/encryption.ts';
import { rateLimit } from '../core/rate-limit.ts';
import {
  crossCheckCapability,
  crossCheckExecutionStatus,
  quoteCrossCheck,
  enqueueCrossCheck,
} from '../crosscheck/execution.ts';

function exact(body: Record<string, unknown>, keys: string[]) {
  requireCondition(
    Object.keys(body).length === keys.length &&
      keys.every((key) => Object.hasOwn(body, key)),
    400,
    'INVALID_REQUEST',
    'This request has missing or unsupported fields.',
  );
}

export async function crosscheckExecutionRoutes(
  pool: Pool,
  request: Request,
  path: string,
  accountId: string,
): Promise<Response | null> {
  if (path === 'crosscheck/capabilities' && request.method === 'GET') {
    await rateLimit(pool, `crosscheck:read:${accountId}`, 60);
    return jsonResponse(await crossCheckCapability(pool));
  }
  const match = /^crosscheck\/([^/]+)\/(quote|run|execution|cancel)$/.exec(
    path,
  );
  if (!match) return null;
  const runId = uuidField(match[1]).toLowerCase();
  if (match[2] === 'execution' && request.method === 'GET') {
    await rateLimit(pool, `crosscheck:read:${accountId}`, 60);
    requireCondition(
      await one(
        pool,
        `SELECT r.id FROM crosscheck_runs r JOIN projects p ON p.id=r.project_id JOIN accounts a ON a.id=r.account_id
      WHERE r.id=$1 AND r.account_id=$2 AND p.account_id=$2 AND p.archived_at IS NULL AND a.disabled_at IS NULL`,
        [runId, accountId],
      ),
      404,
      'CROSSCHECK_NOT_FOUND',
      'This Cross-Check is unavailable.',
    );
    return jsonResponse({
      execution: await crossCheckExecutionStatus(pool, accountId, runId),
    });
  }
  if (request.method !== 'POST') return null;
  await rateLimit(pool, `crosscheck:execution:${accountId}`, 10);
  const body = await readJson(request, 4096);
  if (match[2] === 'quote') {
    exact(body, ['maxOutputTokens']);
    requireCondition(
      Number.isSafeInteger(body.maxOutputTokens) &&
        Number(body.maxOutputTokens) >= 1 &&
        Number(body.maxOutputTokens) <= 8192,
      400,
      'INVALID_OUTPUT_LIMIT',
      'Choose an output limit between one and 8192 tokens.',
    );
    const quote = await quoteCrossCheck(
      pool,
      { accountId, runId, maxOutputTokens: Number(body.maxOutputTokens) },
      configuredKeyring(),
    );
    return jsonResponse({ quote: {...quote, terms: quote.terms.map(term=>({...term,card:publicRouteCard(term.card)}))} }, 201);
  }
  if (match[2] === 'run') {
    exact(body, ['quoteGroupId', 'idempotencyKey', 'approveMaximumUsd6']);
    const queued = await enqueueCrossCheck(
      pool,
      {
        accountId,
        runId,
        quoteGroupId: uuidField(body.quoteGroupId).toLowerCase(),
        idempotencyKey: stringField(body, 'idempotencyKey', 100),
        approveMaximumUsd6: stringField(body, 'approveMaximumUsd6', 8),
      },
      configuredKeyring(),
    );
    return jsonResponse(
      {
        ...queued,
        execution: await crossCheckExecutionStatus(pool, accountId, runId),
      },
      queued.replayed ? 200 : 202,
    );
  }
  if (match[2] === 'cancel') {
    exact(body, []);
    await transaction(pool, async (db) => {
      requireCondition(
        await one(
          db,
          `SELECT r.id FROM crosscheck_runs r JOIN projects p ON p.id=r.project_id JOIN accounts a ON a.id=r.account_id
        WHERE r.id=$1 AND r.account_id=$2 AND p.account_id=$2 AND p.archived_at IS NULL AND a.disabled_at IS NULL FOR SHARE OF a,p,r`,
          [runId, accountId],
        ),
        404,
        'CROSSCHECK_NOT_FOUND',
        'This Cross-Check is unavailable.',
      );
      await db.query(
        `UPDATE holds SET cancel_requested_at=COALESCE(cancel_requested_at,now()),updated_at=now()
        WHERE account_id=$2 AND state IN ('held','running','reconciliation_pending')
        AND id IN(SELECT c.hold_id FROM calls c JOIN crosscheck_review_calls rc ON rc.call_id=c.id WHERE rc.run_id=$1 AND c.account_id=$2)`,
        [runId, accountId],
      );
    });
    return jsonResponse(
      {
        cancellationRequested: true,
        message:
          'Stopping delivery does not guarantee provider cancellation or a refund.',
      },
      202,
    );
  }
  return null;
}
