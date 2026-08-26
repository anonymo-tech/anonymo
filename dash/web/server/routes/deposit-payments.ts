import type { Pool } from 'pg';
import {
  jsonResponse,
  readJson,
  stringField,
  uuidField,
} from '../core/http.ts';
import { requireCondition } from '../core/errors.ts';
import { rateLimit } from '../core/rate-limit.ts';
import { rpcBuckets } from './solana.ts';
import { getOwnedDeposit } from '../solana/deposit-store.ts';
import {
  getOwnedPayment,
  prepareOwnedPayment,
} from '../solana/deposit-payment.ts';
import { submitOwnedPayment } from '../solana/deposit-submit.ts';
import { searchOwnedDeposit } from '../solana/deposit-search.ts';

function exact(body: Record<string, unknown>, fields: string[]) {
  requireCondition(
    Object.keys(body).length === fields.length &&
      fields.every((field) => Object.hasOwn(body, field)),
    400,
    'INVALID_REQUEST',
    'Only the required payment fields are accepted.',
  );
}

/** Called only after session/account binding and the dispatch origin check. */
export async function depositPaymentRoutes(
  pool: Pool,
  request: Request,
  path: string,
  accountId: string,
): Promise<Response | null> {
  const match =
    /^deposits\/([^/]+)\/(payment(?:\/(?:submit|retry))?|recover)$/.exec(path);
  if (!match || !['GET', 'POST'].includes(request.method)) return null;
  if (request.method === 'GET' && match[2] !== 'payment') return null;
  const intentId = uuidField(match[1]).toLowerCase();
  requireCondition(
    !new URL(request.url).search,
    400,
    'INVALID_REQUEST',
    'Payment endpoints do not accept URL parameters.',
  );
  await rateLimit(
    pool,
    `deposit-payment-${request.method === 'GET' ? 'read' : match[2]}:${accountId}`,
    request.method === 'GET' ? 30 : match[2] === 'recover' ? 5 : 10,
  );
  if (request.method !== 'GET') await rpcBuckets(pool, request, accountId);
  if (request.method === 'GET') {
    const [payment, deposit] = await Promise.all([
      getOwnedPayment(pool, accountId, intentId),
      getOwnedDeposit(pool, accountId, intentId),
    ]);
    return jsonResponse({ payment, deposit });
  }
  const body = await readJson(request, 4096);
  if (match[2] === 'payment') {
    exact(body, []);
    const result = await prepareOwnedPayment(pool, accountId, intentId, {
      signal: request.signal,
    });
    return jsonResponse({
      ...result,
      deposit: await getOwnedDeposit(pool, accountId, intentId),
    });
  }
  if (match[2] === 'recover') {
    requireCondition(
      Object.keys(body).every((key) => key === 'cursor') &&
        (body.cursor === undefined ||
          body.cursor === null ||
          (typeof body.cursor === 'string' && body.cursor.length <= 2048)),
      400,
      'INVALID_REQUEST',
      'Provide only an optional recovery cursor.',
    );
    return jsonResponse(
      await searchOwnedDeposit(
        pool,
        {
          accountId,
          intentId,
          cursor: body.cursor as string | null | undefined,
        },
        { signal: request.signal },
      ),
    );
  }
  const retry = match[2] === 'payment/retry';
  exact(body, retry ? ['paymentId'] : ['paymentId', 'signedTransaction']);
  return jsonResponse(
    await submitOwnedPayment(
      pool,
      {
        accountId,
        intentId,
        paymentId: uuidField(body.paymentId).toLowerCase(),
        ...(retry
          ? {}
          : {
              signedTransaction: stringField(body, 'signedTransaction', 1644),
            }),
      },
      { signal: request.signal },
    ),
  );
}
