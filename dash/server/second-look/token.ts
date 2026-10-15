import type { Pool } from 'pg';
import { jsonResponse, readJson, uuidField } from '../core/http.ts';
import { requireCondition } from '../core/errors.ts';
import {
  rateLimit,
  clientBucket,
  RPC_CLIENT_LIMIT,
  RPC_GLOBAL_BUCKET,
  RPC_GLOBAL_LIMIT,
} from '../core/rate-limit.ts';
import { ServiceError } from '../core/errors.ts';
import type { Queryable } from '../db/database.ts';
import { resolveTokenInput } from './input.ts';
import {
  quoteTokenCheck,
  approveTokenCheck,
  readTokenReport,
  listTokenReports,
} from './token-store.ts';
export { tokenCapability } from './providers.ts';
export {
  quoteTokenCheck,
  approveTokenCheck,
  readTokenReport,
  listTokenReports,
} from './token-store.ts';
// The same buckets as other RPC readers, on the existing approval transaction
// connection so concurrent approvals cannot exhaust a small connection pool.
async function tokenReadBudget(
  db: Queryable,
  request: Request,
  accountId: string,
) {
  const entries: [string, number][] = [
    [
      `solana-rpc:client:${await clientBucket(request, accountId)}`,
      RPC_CLIENT_LIMIT,
    ],
    [RPC_GLOBAL_BUCKET, RPC_GLOBAL_LIMIT],
  ];
  for (const [bucket, limit] of entries) {
    const result = await db.query<{ hits: number }>(
      'INSERT INTO rate_limits(bucket,window_start,hits) VALUES($1,to_timestamp(floor(extract(epoch FROM now())/60)*60),1) ON CONFLICT(bucket,window_start) DO UPDATE SET hits=rate_limits.hits+1 RETURNING hits',
      [bucket],
    );
    if (result.rows[0].hits > limit)
      throw new ServiceError(
        429,
        'RATE_LIMITED',
        'Too many requests. Try again shortly.',
        true,
      );
  }
}
export async function tokenRoutes(
  pool: Pool,
  request: Request,
  path: string[],
  accountId: string,
): Promise<Response | null> {
  if (path[0] !== 'second-look') return null;
  if (request.method === 'POST' && path.length === 2 && path[1] === 'resolve') {
    await rateLimit(pool, `token-resolve:${accountId}`, 20);
    const body = await readJson(request, 2048);
    requireCondition(
      Object.keys(body).length === 1 && Object.hasOwn(body, 'input'),
      400,
      'TOKEN_REQUEST_INVALID',
      'Only the token input is accepted.',
    );
    await tokenReadBudget(pool, request, accountId);
    return jsonResponse(await resolveTokenInput(body.input, request.signal));
  }
  if (
    request.method === 'POST' &&
    path.length === 3 &&
    path[1] === 'tokens' &&
    path[2] === 'check'
  ) {
    await rateLimit(pool, `token-check:${accountId}`, 20);
    const body = await readJson(request, 2048);
    if (Object.hasOwn(body, 'quoteId')) {
      requireCondition(
        Object.keys(body).length === 2 &&
          typeof body.approvedMaximumUsd6 === 'string',
        400,
        'TOKEN_REQUEST_INVALID',
        'Approve an exact token quote.',
      );
      return jsonResponse(
        await approveTokenCheck(
          pool,
          accountId,
          {
            quoteId: uuidField(body.quoteId),
            approvedMaximumUsd6: body.approvedMaximumUsd6,
          },
          {
            signal: request.signal,
            beforeRead: (db) => tokenReadBudget(db, request, accountId),
          },
        ),
      );
    }
    requireCondition(
      Object.keys(body).length === 3 &&
        typeof body.mint === 'string' &&
        typeof body.idempotencyKey === 'string' &&
        (body.mode === 'standard' || body.mode === 'deep'),
      400,
      'TOKEN_REQUEST_INVALID',
      'Provide mint, mode and a stable request key.',
    );
    return jsonResponse(
      await quoteTokenCheck(pool, accountId, {
        mint: body.mint,
        mode: body.mode,
        idempotencyKey: body.idempotencyKey,
      }),
    );
  }
  if (request.method === 'GET' && path.length === 2 && path[1] === 'reports') {
    await rateLimit(pool, `token-list:${accountId}`, 30);
    return jsonResponse(
      await listTokenReports(
        pool,
        accountId,
        new URL(request.url).searchParams.get('cursor'),
      ),
    );
  }
  if (request.method === 'GET' && path.length === 3 && path[1] === 'reports') {
    await rateLimit(pool, `token-read:${accountId}`, 60);
    return jsonResponse({
      report: await readTokenReport(pool, accountId, uuidField(path[2])),
    });
  }
  return null;
}
