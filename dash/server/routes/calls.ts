import { CHAT_LIMITS } from '../../lib/chat-limits.ts';
import { publicInferenceErrorCode } from './public-inference.ts';
import type { Pool } from 'pg';
import {
  jsonResponse,
  readJson,
  stringField,
  uuidField,
} from '../core/http.ts';
import { requireCondition } from '../core/errors.ts';
import {
  configuredKeyring,
  encryptText,
  decryptText,
} from '../core/encryption.ts';
import { one, transaction } from '../db/database.ts';
import { enqueue } from '../db/jobs.ts';
import { reserveQuote } from '../ledger/ledger.ts';
import {
  holdPlatformFees,
  platformFeeFields,
  priceQuoteMaximum,
  recordQuotePlatformFee,
  reservationFields,
} from '../ledger/platform-fee.ts';
import { requireProject } from './projects.ts';
import {
  assertUsableRoute,
  callRequestHash,
  parseChatInput,
  quoteMaximum,
  type RouteVersion,
} from './call-contract.ts';
import { scanPrompt } from '../../lib/guards/index.ts';

function guardMessages(messages: { content: string }[]) {
  for (const message of messages) {
    const result = scanPrompt(message.content);
    requireCondition(
      !result.findings.some((finding) => finding.severity === 'block'),
      422,
      'SENSITIVE_CONTENT',
      'Remove or redact the detected secret before sending this request.',
    );
  }
}

export async function callRoutes(
  pool: Pool,
  request: Request,
  path: string,
  accountId: string,
  providerConfigured: boolean,
): Promise<Response | null> {
  if ((path === 'quotes' || path === 'calls') && request.method === 'POST') {
    const body = await readJson(request, CHAT_LIMITS.requestBytes);
    const projectId = uuidField(body.projectId),
      routeVersionId = uuidField(body.routeVersionId);
    const input = parseChatInput(body);
    const requestHash = await callRequestHash(projectId, routeVersionId, input);
    const quoteId = path === 'calls' ? uuidField(body.quoteId) : null;
    const idempotencyKey =
      path === 'calls' ? stringField(body, 'idempotencyKey', 128) : null;
    if (path === 'calls') {
      const existing = await one<{
        id: string;
        state: string;
        request_hash: string;
        quote_id: string;
        blind: boolean;
      }>(
        pool,
        `SELECT c.id,c.state,h.request_hash,h.quote_id,EXISTS(SELECT 1 FROM comparison_calls cc JOIN comparisons co ON co.id=cc.comparison_id WHERE cc.call_id=c.id AND co.blind AND co.revealed_at IS NULL) AS blind FROM holds h JOIN calls c ON c.hold_id=h.id
         WHERE h.account_id=$1 AND c.account_id=$1 AND h.idempotency_key=$2`,
        [accountId, idempotencyKey],
      );
      if (existing) {
        requireCondition(
          existing.request_hash === requestHash &&
            existing.quote_id === quoteId,
          409,
          'IDEMPOTENCY_CONFLICT',
          'This key belongs to a different request.',
        );
        requireCondition(
          !existing.blind,
          409,
          'BLIND_COMPARISON',
          'Resume this request through its comparison.',
        );
        return jsonResponse({
          call: { id: existing.id, state: existing.state },
          replayed: true,
        });
      }
    }
    requireCondition(
      providerConfigured,
      503,
      'PROVIDER_UNAVAILABLE',
      'The model provider is not configured.',
    );
    const keyring = configuredKeyring();
    await requireProject(pool, accountId, projectId);
    guardMessages(input.messages);
    const route = await one<RouteVersion>(
      pool,
      'SELECT *,expires_at>now() AS fresh FROM route_versions WHERE id=$1',
      [routeVersionId],
    );
    assertUsableRoute(route);
    if (path === 'quotes') {
      const {
          maximumUsd6: maximum,
          platformFee,
          reservation,
        } = priceQuoteMaximum(quoteMaximum(route, input), {
          
        }),
        id = crypto.randomUUID();
      const result = await transaction(pool, async (client) => {
        const quote = await one(
          client,
          `INSERT INTO quotes(id,account_id,project_id,route_version_id,request_hash,max_usd6,max_output_tokens,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '2 minutes') RETURNING id,max_usd6 AS "maximumUsd6",expires_at AS "expiresAt"`,
          [
            id,
            accountId,
            projectId,
            routeVersionId,
            requestHash,
            maximum,
            input.maxOutputTokens,
          ],
        );
        await recordQuotePlatformFee(client, id, platformFee);
        return quote;
      });
      return jsonResponse(
        {
          quote: {
            ...result,
            routeVersionId,
            requestHash,
            markupBps: route.pricing.markupBps,
            ...platformFeeFields(platformFee),
            ...reservationFields(reservation),
          },
        },
        201,
      );
    }
    requireCondition(
      quoteId && idempotencyKey,
      400,
      'INVALID_REQUEST',
      'A quote and idempotency key are required.',
    );
    const callId = crypto.randomUUID();
    const encrypted = await encryptText(
      JSON.stringify(input),
      `${accountId}:call-input:${callId}`,
      keyring,
    );
    const reserved = await reserveQuote(
      pool,
      { accountId, quoteId, idempotencyKey, requestHash },
      async (client, hold) => {
        await client.query(
          `INSERT INTO calls(id,account_id,project_id,hold_id,route_version_id,input_ciphertext,state)
        VALUES($1,$2,$3,$4,$5,$6,'queued')`,
          [callId, accountId, projectId, hold.id, routeVersionId, encrypted],
        );
        await enqueue(client, {
          kind: 'inference',
          reference: `inference:${callId}`,
          payload: { callId },
          maxAttempts: 1,
        });
      },
    );
    const call = await one(
      pool,
      'SELECT id,state FROM calls WHERE hold_id=$1 AND account_id=$2',
      [reserved.hold.id, accountId],
    );
    requireCondition(
      call,
      409,
      'CALL_UNAVAILABLE',
      'This reservation has no associated request.',
    );
    return jsonResponse(
      { call, replayed: reserved.replayed },
      reserved.replayed ? 200 : 202,
    );
  }
  const match = /^calls\/([^/]+)(?:\/(cancel|events))?$/.exec(path);
  if (match) {
    const id = uuidField(match[1]);
    const call = await one<{
      id: string;
      hold_id: string;
      state: string;
      error_code: string | null;
      output_ciphertext: string | null;
      updated_at: Date;
      maximum_usd6: string;
      captured_usd6: string | null;
      billing_state: string;
      cancel_requested: boolean;
      blind: boolean;
    }>(
      pool,
      `SELECT c.*,h.maximum_usd6,h.captured_usd6,h.state AS billing_state,h.cancel_requested_at IS NOT NULL AS cancel_requested,EXISTS(SELECT 1 FROM comparison_calls cc JOIN comparisons co ON co.id=cc.comparison_id WHERE cc.call_id=c.id AND co.blind AND co.revealed_at IS NULL) AS blind FROM calls c JOIN holds h ON h.id=c.hold_id WHERE c.id=$1 AND c.account_id=$2`,
      [id, accountId],
    );
    requireCondition(
      call,
      404,
      'CALL_NOT_FOUND',
      'This request is unavailable.',
    );
    if (match[2] === 'cancel' && request.method === 'POST') {
      // Only a queued or running request can be stopped. A finished one keeps
      // its settled state, and the response says nothing was cancelled.
      const requested = await pool.query(
        `UPDATE holds SET cancel_requested_at=COALESCE(cancel_requested_at,now()),updated_at=now()
        WHERE id=$1 AND state IN ('held','running')
        AND EXISTS(SELECT 1 FROM calls WHERE hold_id=$1 AND state IN ('queued','running'))`,
        [call.hold_id],
      );
      if (!requested.rowCount)
        return jsonResponse({
          cancellationRequested: false,
          code: 'ALREADY_FINISHED',
          state: call.state,
          message: 'This request has already finished; nothing was cancelled.',
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
    if (request.method === 'GET' && !match[2]) {
      const platformFee = call.blind
        ? undefined
        : (await holdPlatformFees(pool, [call.hold_id])).get(call.hold_id);
      const output = call.output_ciphertext
        ? await decryptText(
            call.output_ciphertext,
            `${accountId}:call-output:${id}`,
            configuredKeyring(),
          )
        : '';
      return jsonResponse({
        call: {
          id,
          state: call.state,
          errorCode: publicInferenceErrorCode(call.error_code),
          output,
          cancelRequested: call.cancel_requested,
          updatedAt: call.updated_at,
          billing: {
            state: call.billing_state,
            maximumUsd6: call.blind ? null : call.maximum_usd6,
            actualUsd6: call.blind ? null : call.captured_usd6,
            ...(platformFee ? { platformFee } : {}),
          },
        },
      });
    }
  }
  return null;
}
