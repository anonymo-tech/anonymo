import { CHAT_LIMITS } from '../../lib/chat-limits.ts';
import { publicInferenceErrorCode, publicRouteCard } from './public-inference.ts';
import type { Pool, PoolClient } from 'pg';
import { one, transaction } from '../db/database.ts';
import {
  jsonResponse,
  readJson,
  stringField,
  uuidField,
} from '../core/http.ts';
import { requireCondition } from '../core/errors.ts';
import { digestText } from '../core/digest.ts';
import {
  configuredKeyring,
  encryptText,
  decryptText,
} from '../core/encryption.ts';
import { nextCursor, readCursor } from '../core/pagination.ts';
import { reserveQuoteInTransaction } from '../ledger/ledger.ts';
import {
  holdPlatformFees,
  platformFeeFields,
  priceQuoteMaximum,
  recordQuotePlatformFee,
  reservationFields,
} from '../ledger/platform-fee.ts';
import { enqueue } from '../db/jobs.ts';
import { requireProject } from './projects.ts';
import {
  assertUsableRoute,
  callRequestHash,
  parseChatInput,
  quoteMaximum,
  type ChatInput,
  type RouteVersion,
} from './call-contract.ts';
import { scanPrompt } from '../../lib/guards/index.ts';

type Selection = {
  routeVersionId: string;
  quoteId: string | null;
  input: ChatInput;
  requestHash: string;
};
type ComparisonRow = {
  id: string;
  project_id: string;
  blind: boolean;
  revealed_at: Date | null;
  voted_call_id: string | null;
  created_at: Date;
};
type CallRow = {
  id: string;
  hold_id: string;
  state: string;
  error_code: string | null;
  route_version_id: string;
  model_id: string;
  family: string;
  input_ciphertext: string;
  output_ciphertext: string | null;
  maximum_usd6: string;
  captured_usd6: string | null;
  billing_state: string;
  cancel_requested: boolean;
  position: number;
};

async function selections(
  body: Record<string, unknown>,
  projectId: string,
  quoted: boolean,
): Promise<Selection[]> {
  requireCondition(
    Array.isArray(body.items) &&
      body.items.length >= 1 &&
      body.items.length <= 4,
    400,
    'INVALID_COMPARISON',
    'Choose between one and four models.',
  );
  const items = await Promise.all(
    body.items.map(async (value: unknown) => {
      requireCondition(
        value && typeof value === 'object' && !Array.isArray(value),
        400,
        'INVALID_COMPARISON',
        'A model selection is invalid.',
      );
      const entry = value as Record<string, unknown>,
        routeVersionId = uuidField(entry.routeVersionId);
      const input = parseChatInput(entry);
      return {
        routeVersionId,
        quoteId: quoted ? uuidField(entry.quoteId) : null,
        input,
        requestHash: await callRequestHash(projectId, routeVersionId, input),
      };
    }),
  );
  requireCondition(
    new Set(items.map((item) => item.routeVersionId)).size === items.length,
    400,
    'DUPLICATE_MODEL',
    'Choose each model route once.',
  );
  const question = items[0].input.messages.at(-1)?.content;
  requireCondition(
    items.every((item) => item.input.messages.at(-1)?.content === question),
    400,
    'QUESTION_MISMATCH',
    'Every comparison model must receive the same question.',
  );
  return items;
}

function guard(items: Selection[]) {
  const seen = new Set<string>();
  for (const item of items)
    for (const message of item.input.messages) {
      if (seen.has(message.content)) continue;
      seen.add(message.content);
      requireCondition(
        !scanPrompt(message.content).findings.some(
          (finding) => finding.severity === 'block',
        ),
        422,
        'SENSITIVE_CONTENT',
        'Remove or redact the detected secret before sending this request.',
      );
    }
}

export async function readComparison(
  pool: Pool | PoolClient,
  accountId: string,
  id: string,
  outputLimit?: number,
) {
  const row = await one<ComparisonRow>(
    pool,
    'SELECT * FROM comparisons WHERE id=$1 AND account_id=$2',
    [id, accountId],
  );
  requireCondition(
    row,
    404,
    'COMPARISON_NOT_FOUND',
    'This comparison is unavailable.',
  );
  const rows = await pool.query<CallRow>(
    `SELECT c.id,c.hold_id,c.state,c.error_code,c.route_version_id,c.input_ciphertext,c.output_ciphertext,
    r.model_id,r.family,h.maximum_usd6,h.captured_usd6,h.state AS billing_state,h.cancel_requested_at IS NOT NULL AS cancel_requested,cc.position
    FROM comparison_calls cc JOIN calls c ON c.id=cc.call_id JOIN holds h ON h.id=c.hold_id JOIN route_versions r ON r.id=c.route_version_id
    WHERE cc.comparison_id=$1 AND c.account_id=$2 ORDER BY cc.position`,
    [id, accountId],
  );
  requireCondition(
    rows.rows.length >= 1 && rows.rows.length <= 4,
    503,
    'COMPARISON_UNAVAILABLE',
    'This comparison could not be loaded.',
  );
  const keyring = configuredKeyring(),
    hideIdentity = row.blind && !row.revealed_at;
  const platformFees = hideIdentity
    ? new Map()
    : await holdPlatformFees(
        pool,
        rows.rows.map((call) => call.hold_id),
      );
  const first = rows.rows[0];
  const input = JSON.parse(
    await decryptText(
      first.input_ciphertext,
      `${accountId}:call-input:${first.id}`,
      keyring,
    ),
  ) as ChatInput;
  const calls = await Promise.all(
    rows.rows.map(async (call) => {
      const output = call.output_ciphertext
        ? await decryptText(
            call.output_ciphertext,
            `${accountId}:call-output:${call.id}`,
            keyring,
          )
        : '';
      const outputTruncated =
        outputLimit !== undefined && output.length > outputLimit;
      return {
        id: call.id,
        label: `Model ${String.fromCharCode(65 + call.position)}`,
        position: call.position,
        routeVersionId: hideIdentity ? null : call.route_version_id,
        modelId: hideIdentity ? null : call.model_id,
        family: hideIdentity ? null : call.family,
        state: call.state,
        errorCode: publicInferenceErrorCode(call.error_code),
        cancelRequested: call.cancel_requested,
        output: outputTruncated ? output.slice(0, outputLimit) : output,
        outputTruncated,
        outputLength: output.length,
        billing: {
          state: call.billing_state,
          maximumUsd6: hideIdentity ? null : call.maximum_usd6,
          actualUsd6: hideIdentity ? null : call.captured_usd6,
          ...(platformFees.has(call.hold_id)
            ? { platformFee: platformFees.get(call.hold_id) }
            : {}),
        },
      };
    }),
  );
  return {
    id: row.id,
    projectId: row.project_id,
    prompt: input.messages.at(-1)?.content ?? '',
    createdAt: row.created_at,
    blind: row.blind,
    revealedAt: row.revealed_at,
    votedCallId: row.voted_call_id,
    billing: {
      maximumUsd6: rows.rows
        .reduce((sum, call) => sum + BigInt(call.maximum_usd6), 0n)
        .toString(),
      actualUsd6: rows.rows.every((call) => call.captured_usd6 !== null)
        ? rows.rows
            .reduce((sum, call) => sum + BigInt(call.captured_usd6!), 0n)
            .toString()
        : null,
    },
    calls,
  };
}

export async function comparisonRoutes(
  pool: Pool,
  request: Request,
  path: string,
  accountId: string,
  providerConfigured: boolean,
): Promise<Response | null> {
  if (
    (path === 'comparison-quotes' || path === 'comparisons') &&
    request.method === 'POST'
  ) {
    const body = await readJson(request, 4 * CHAT_LIMITS.requestBytes),
      projectId = uuidField(body.projectId);
    const items = await selections(body, projectId, path === 'comparisons');
    requireCondition(
      body.blind === undefined || typeof body.blind === 'boolean',
      400,
      'INVALID_COMPARISON',
      'The comparison mode is invalid.',
    );
    const blind = body.blind === true;
    if (path === 'comparison-quotes') {
      requireCondition(
        providerConfigured,
        503,
        'PROVIDER_UNAVAILABLE',
        'The model provider is not configured.',
      );
      configuredKeyring();
      await requireProject(pool, accountId, projectId);
      guard(items);
      const quotes = await transaction(pool, async (client) => {
        const result = [];
        for (const item of items) {
          const route = await one<RouteVersion>(
            client,
            'SELECT *,expires_at>now() AS fresh FROM route_versions WHERE id=$1',
            [item.routeVersionId],
          );
          assertUsableRoute(route);
          const {
            maximumUsd6: maximum,
            platformFee,
            reservation,
          } = priceQuoteMaximum(quoteMaximum(route, item.input), {
            
          });
          const quoteId = crypto.randomUUID();
          const quote = await one(
            client,
            `INSERT INTO quotes(id,account_id,project_id,route_version_id,request_hash,max_usd6,max_output_tokens,expires_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '2 minutes') RETURNING id,max_usd6 AS "maximumUsd6",expires_at AS "expiresAt"`,
            [
              quoteId,
              accountId,
              projectId,
              item.routeVersionId,
              item.requestHash,
              maximum,
              item.input.maxOutputTokens,
            ],
          );
          await recordQuotePlatformFee(client, quoteId, platformFee);
          result.push({
            ...quote,
            routeVersionId: item.routeVersionId,
            requestHash: item.requestHash,
            markupBps: route.pricing.markupBps,
            modelId: route.model_id,
            family: route.family,
            card: publicRouteCard(route.card),
            maximumUsd6: maximum,
            ...platformFeeFields(platformFee),
            ...reservationFields(reservation),
          });
        }
        return result;
      });
      return jsonResponse(
        {
          quotes,
          maximumUsd6: quotes
            .reduce((sum, quote) => sum + BigInt(quote.maximumUsd6), 0n)
            .toString(),
        },
        201,
      );
    }
    const key = stringField(body, 'idempotencyKey', 100);
    requireCondition(
      /^[a-zA-Z0-9_-]{16,100}$/.test(key),
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'Use a random idempotency key.',
    );
    const requestHash = await digestText(
      'comparison',
      JSON.stringify({
        projectId,
        blind,
        items: items.map((item) => [
          item.routeVersionId,
          item.quoteId,
          item.requestHash,
        ]),
      }),
    );
    const created = await transaction(pool, async (client) => {
      // The common owner lock makes the group reservation and all its children atomic.
      const owner = await one(
        client,
        'SELECT id FROM accounts WHERE id=$1 AND disabled_at IS NULL FOR UPDATE',
        [accountId],
      );
      requireCondition(
        owner,
        401,
        'ACCOUNT_UNAVAILABLE',
        'This account is unavailable.',
      );
      const existing = await one<{ id: string; request_hash: string }>(
        client,
        'SELECT id,request_hash FROM comparisons WHERE account_id=$1 AND idempotency_key=$2',
        [accountId, key],
      );
      if (existing) {
        requireCondition(
          existing.request_hash === requestHash,
          409,
          'IDEMPOTENCY_CONFLICT',
          'This key belongs to a different comparison.',
        );
        return { id: existing.id, replayed: true };
      }
      requireCondition(
        providerConfigured,
        503,
        'PROVIDER_UNAVAILABLE',
        'The model provider is not configured.',
      );
      const keyring = configuredKeyring();
      await requireProject(client, accountId, projectId);
      guard(items);
      const id = crypto.randomUUID();
      await client.query(
        'INSERT INTO comparisons(id,account_id,project_id,idempotency_key,request_hash,blind) VALUES($1,$2,$3,$4,$5,$6)',
        [id, accountId, projectId, key, requestHash, blind],
      );
      // Random assignment happens once and is retained across retries and reloads.
      const order = items.map((item, index) => ({
        item,
        index,
        random: crypto.getRandomValues(new Uint32Array(1))[0],
      }));
      if (blind) order.sort((a, b) => a.random - b.random || a.index - b.index);
      // Lock shared routes in canonical order before per-item reservation to avoid cross-owner deadlocks.
      await client.query(
        'SELECT id FROM route_versions WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [items.map((item) => item.routeVersionId)],
      );
      for (let position = 0; position < order.length; position++) {
        const { item } = order[position],
          callId = crypto.randomUUID();
        const route = await one<RouteVersion>(
          client,
          'SELECT *,expires_at>now() AS fresh FROM route_versions WHERE id=$1',
          [item.routeVersionId],
        );
        assertUsableRoute(route);
        const ciphertext = await encryptText(
          JSON.stringify(item.input),
          `${accountId}:call-input:${callId}`,
          keyring,
        );
        const held = await reserveQuoteInTransaction(
          client,
          {
            accountId,
            quoteId: item.quoteId!,
            idempotencyKey: crypto.randomUUID(),
            requestHash: item.requestHash,
          },
          async (locked, hold) => {
            await locked.query(
              `INSERT INTO calls(id,account_id,project_id,hold_id,route_version_id,input_ciphertext,state) VALUES($1,$2,$3,$4,$5,$6,'queued')`,
              [
                callId,
                accountId,
                projectId,
                hold.id,
                item.routeVersionId,
                ciphertext,
              ],
            );
            await locked.query(
              'INSERT INTO comparison_calls(comparison_id,call_id,position) VALUES($1,$2,$3)',
              [id, callId, position],
            );
            await enqueue(locked, {
              kind: 'inference',
              reference: `inference:${callId}`,
              payload: { callId },
              maxAttempts: 1,
            });
          },
        );
        requireCondition(
          !held.replayed,
          409,
          'IDEMPOTENCY_CONFLICT',
          'A child request already uses this key.',
        );
      }
      await client.query(
        'UPDATE projects SET updated_at=now() WHERE id=$1 AND account_id=$2',
        [projectId, accountId],
      );
      return { id, replayed: false };
    });
    return jsonResponse(
      {
        comparison: await readComparison(pool, accountId, created.id),
        replayed: created.replayed,
      },
      created.replayed ? 200 : 202,
    );
  }
  if (path === 'comparisons' && request.method === 'GET') {
    const url = new URL(request.url),
      projectId = uuidField(url.searchParams.get('projectId'));
    await requireProject(pool, accountId, projectId);
    const scope = `${accountId}:comparisons:${projectId}`,
      cursor = readCursor(url.searchParams.get('cursor'), scope);
    const rows = await pool.query(
      `SELECT id,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime"
      FROM comparisons WHERE account_id=$1 AND project_id=$2 AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid))
      ORDER BY created_at DESC,id DESC LIMIT 21`,
      [accountId, projectId, cursor?.time ?? null, cursor?.id ?? null],
    );
    return jsonResponse({
      comparisons: await Promise.all(
        rows.rows
          .slice(0, 20)
          .map((row) => readComparison(pool, accountId, row.id, 16_000)),
      ),
      nextCursor: nextCursor(rows.rows, 20, scope),
    });
  }
  const match = /^comparisons\/([^/]+)(?:\/(vote|reveal|cancel))?$/.exec(path);
  if (match) {
    const id = uuidField(match[1]);
    if (request.method === 'GET' && !match[2])
      return jsonResponse({
        comparison: await readComparison(pool, accountId, id),
      });
    if (request.method === 'POST' && match[2]) {
      const body = await readJson(request, 2048);
      await transaction(pool, async (client) => {
        const owned = await one<ComparisonRow>(
          client,
          'SELECT * FROM comparisons WHERE id=$1 AND account_id=$2 FOR UPDATE',
          [id, accountId],
        );
        requireCondition(
          owned,
          404,
          'COMPARISON_NOT_FOUND',
          'This comparison is unavailable.',
        );
        if (match[2] === 'cancel') {
          await client.query(
            `UPDATE holds SET cancel_requested_at=COALESCE(cancel_requested_at,now()),updated_at=now() WHERE id IN
            (SELECT c.hold_id FROM calls c JOIN comparison_calls cc ON cc.call_id=c.id WHERE cc.comparison_id=$1 AND c.account_id=$2
            AND c.state IN ('queued','running'))
            AND state IN ('held','running')`,
            [id, accountId],
          );
          return;
        }
        requireCondition(
          owned.blind,
          409,
          'NOT_BLIND',
          'This comparison already shows its model names.',
        );
        if (match[2] === 'vote') {
          const callId = uuidField(body.callId);
          requireCondition(
            !owned.revealed_at,
            409,
            'ALREADY_REVEALED',
            'A vote cannot be changed after the model names are revealed.',
          );
          const answer = await one(
            client,
            `SELECT c.id FROM calls c JOIN comparison_calls cc ON cc.call_id=c.id
            WHERE cc.comparison_id=$1 AND c.id=$2 AND c.state='succeeded'`,
            [id, callId],
          );
          requireCondition(
            answer,
            409,
            'ANSWER_UNAVAILABLE',
            'Choose a completed answer from this comparison.',
          );
          await client.query(
            'UPDATE comparisons SET voted_call_id=$2,revealed_at=now() WHERE id=$1',
            [id, callId],
          );
        } else
          await client.query(
            'UPDATE comparisons SET revealed_at=COALESCE(revealed_at,now()) WHERE id=$1',
            [id],
          );
      });
      return jsonResponse({
        comparison: await readComparison(pool, accountId, id),
        ...(match[2] === 'cancel' ? { cancellationRequested: true } : {}),
      });
    }
  }
  return null;
}
