import type { Pool } from 'pg';
import { one, transaction } from '../db/database.ts';
import { jsonResponse, readJson, uuidField } from '../core/http.ts';
import { configuredKeyring } from '../core/encryption.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';
import { scanPrompt } from '../../lib/guards/index.ts';
import {
  ROUTING_TASKS,
  ROUTING_TASK_LABELS,
  type RoutingTask,
  type RouteRecommendation,
} from '../../lib/model-routing.ts';
import { validateRouteRoutingProfile } from './route-registry.ts';
import {
  assertUsableRoute,
  parseChatInput,
  quoteMaximum,
  callRequestHash,
  CHAT_REQUEST_BUDGET_USD6,
  type ChatInput,
  type RouteVersion,
} from './call-contract.ts';
import {
  holdBufferConfig,
  platformFeeConfig,
  platformFeeFields,
  priceQuoteMaximum,
  recordQuotePlatformFee,
  reservationFields,
  type QuotePlatformFee,
  type QuoteReservation,
} from '../ledger/platform-fee.ts';

export const AUTO_ROUTING_LIMITS = Object.freeze({
  candidates: 16,
  inputBytesPerCandidate: 32768,
  bodyBytes: 3200000,
  maximumUsd6: '10000000',
  quoteSeconds: 120,
});
type Candidate = { routeVersionId: string; input: ChatInput };
type AutoRoute = RouteVersion & {
  route_id: string;
  version: number;
  expires_at: Date;
  card: RouteVersion['card'] & { routing?: unknown };
};
function exact(value: unknown, fields: string[]): Record<string, unknown> {
  requireCondition(
    value && typeof value === 'object' && !Array.isArray(value),
    400,
    'ROUTING_CANDIDATES_INVALID',
    'Check the routing request fields.',
  );
  const row = value as Record<string, unknown>;
  requireCondition(
    Object.keys(row).length === fields.length &&
      fields.every((field) => Object.hasOwn(row, field)),
    400,
    'ROUTING_CANDIDATES_INVALID',
    'Check the routing request fields.',
  );
  return row;
}
function parse(body: Record<string, unknown>) {
  exact(body, ['projectId', 'task', 'privacy', 'budgetUsd6', 'candidates']);
  const projectId = uuidField(body.projectId).toLowerCase();
  requireCondition(
    typeof body.task === 'string' &&
      (ROUTING_TASKS as readonly string[]).includes(body.task),
    400,
    'ROUTING_TASK_INVALID',
    'Choose a supported routing task.',
  );
  requireCondition(
    body.privacy === 'standard',
    409,
    'PRIVACY_ROUTE_UNAVAILABLE',
    'This request requires a privacy route that has not been verified.',
  );
  requireCondition(
    typeof body.budgetUsd6 === 'string' &&
      /^[1-9][0-9]{0,7}$/.test(body.budgetUsd6) &&
      BigInt(body.budgetUsd6) <= 10000000n,
    400,
    'INVALID_ROUTING_BUDGET',
    'Choose a maximum request budget between one micro-dollar and ten dollars.',
  );
  requireCondition(
    Array.isArray(body.candidates) &&
      body.candidates.length >= 1 &&
      body.candidates.length <= AUTO_ROUTING_LIMITS.candidates,
    400,
    'ROUTING_CANDIDATES_INVALID',
    'Provide between one and sixteen candidate routes.',
  );
  const candidates: Candidate[] = body.candidates.map((raw) => {
    const item = exact(raw, [
      'routeVersionId',
      'messages',
      'maxOutputTokens',
      'privacy',
    ]);
    return {
      routeVersionId: uuidField(item.routeVersionId).toLowerCase(),
      input: parseChatInput(item),
    };
  });
  requireCondition(
    new Set(candidates.map((c) => c.routeVersionId)).size === candidates.length,
    400,
    'DUPLICATE_MODEL',
    'Choose each model route once.',
  );
  const first = candidates[0].input;
  requireCondition(
    candidates.every(
      (c) =>
        c.input.messages.at(-1)!.content === first.messages.at(-1)!.content &&
        c.input.maxOutputTokens === first.maxOutputTokens &&
        c.input.privacy === body.privacy,
    ),
    400,
    'ROUTING_CANDIDATE_MISMATCH',
    'Every candidate must use the same current question, output limit and privacy requirement.',
  );
  const seen = new Set<string>();
  for (const candidate of candidates)
    for (const message of candidate.input.messages) {
      if (seen.has(message.content)) continue;
      seen.add(message.content);
      requireCondition(
        !scanPrompt(message.content).findings.some(
          (f) => f.severity === 'block',
        ),
        422,
        'SENSITIVE_CONTENT',
        'Remove or redact the detected secret before requesting a route.',
      );
    }
  return {
    projectId,
    task: body.task as RoutingTask,
    budgetUsd6: body.budgetUsd6,
    candidates,
  };
}

/** Prices complete supplied contexts locally. No provider invocation or balance reservation. */
export async function autoRoutingRoutes(
  pool: Pool,
  request: Request,
  path: string,
  accountId: string,
  providerConfigured: boolean,
): Promise<Response | null> {
  if (path !== 'auto-route-quotes' || request.method !== 'POST') return null;
  requireCondition(
    providerConfigured,
    503,
    'PROVIDER_UNAVAILABLE',
    'The model provider is not configured.',
  );
  configuredKeyring();
  const input = parse(await readJson(request, AUTO_ROUTING_LIMITS.bodyBytes));
  const response = await transaction(pool, async (db) => {
    requireCondition(
      await one(
        db,
        'SELECT id FROM accounts WHERE id=$1 AND disabled_at IS NULL FOR UPDATE',
        [accountId],
      ),
      401,
      'ACCOUNT_UNAVAILABLE',
      'This account is unavailable.',
    );
    // Installation takes the matching exclusive advisory lock. Never choose an
    // older enabled version because a newer version is disabled or unreviewed.
    await db.query(
      "SELECT pg_advisory_xact_lock_shared(hashtext('conclave_route_registry_v1'))",
    );
    const rows = await db.query<AutoRoute>(
      `SELECT r.*,r.expires_at>clock_timestamp() AS fresh FROM route_versions r
      WHERE r.id=ANY($1::uuid[]) AND r.modality='chat'
      AND NOT EXISTS(SELECT 1 FROM route_versions newer WHERE newer.route_id=r.route_id AND newer.version>r.version)
      ORDER BY r.id FOR SHARE OF r`,
      [input.candidates.map((c) => c.routeVersionId)],
    );
    requireCondition(
      rows.rows.length === input.candidates.length,
      409,
      'ROUTING_CANDIDATES_STALE',
      'The available route versions changed. Refresh the model list before routing.',
    );
    requireCondition(
      await one(
        db,
        'SELECT id FROM projects WHERE id=$1 AND account_id=$2 AND archived_at IS NULL FOR SHARE',
        [input.projectId, accountId],
      ),
      404,
      'PROJECT_NOT_FOUND',
      'This project is unavailable.',
    );
    const clock = (await one<{ at: Date }>(
      db,
      'SELECT clock_timestamp() AS at',
    ))!.at;
    const priced: {
      route: AutoRoute;
      candidate: Candidate;
      maximumUsd6: string;
      platformFee: QuotePlatformFee | null;
      reservation: QuoteReservation | null;
      reviewExpiry: number;
    }[] = [];
    let reviewed = 0,
      overMaximum = false;
    // Read once, outside the per-candidate handler, so a configuration error
    // fails the request instead of silently excluding every candidate.
    const feeConfig = platformFeeConfig(),
      bufferConfig = holdBufferConfig();
    for (const route of rows.rows) {
      try {
        route.fresh = route.expires_at.getTime() > clock.getTime();
        assertUsableRoute(route);
      } catch {
        continue;
      }
      let profile;
      try {
        profile = validateRouteRoutingProfile(
          route.card.routing,
          clock.toISOString(),
          route.expires_at.toISOString(),
        );
      } catch {
        continue;
      }
      if (!profile.tasks.includes(input.task)) continue;
      reviewed++;
      const candidate = input.candidates.find(
        (c) => c.routeVersionId === route.id,
      )!;
      try {
        priced.push({
          route,
          candidate,
          // The buffer and the fee are monotonic in the base, so ordering by
          // the buffered, fee-inclusive maximum keeps the same lowest-cost choice.
          ...priceQuoteMaximum(quoteMaximum(route, candidate.input), {
            limitUsd6: CHAT_REQUEST_BUDGET_USD6,
            config: feeConfig,
            buffer: bufferConfig,
          }),
          reviewExpiry: Date.parse(profile.reviewedAt) + 86400000,
        });
      } catch (error) {
        if (
          error instanceof ServiceError &&
          error.code === 'REQUEST_BUDGET_EXCEEDED'
        )
          overMaximum = true;
        else if (!(error instanceof ServiceError)) throw error;
      }
    }
    requireCondition(
      reviewed > 0,
      409,
      'ROUTING_REVIEW_REQUIRED',
      'No supplied route has a current operator-reviewed profile for this task.',
    );
    requireCondition(
      priced.length > 0,
      409,
      overMaximum ? 'ROUTING_BUDGET_EXCEEDED' : 'ROUTING_NO_COMPATIBLE_ROUTE',
      overMaximum
        ? 'No compatible route fits the request budget.'
        : 'No reviewed route can accept each complete candidate within its input and output limits.',
    );
    priced.sort((a, b) =>
      BigInt(a.maximumUsd6) < BigInt(b.maximumUsd6)
        ? -1
        : BigInt(a.maximumUsd6) > BigInt(b.maximumUsd6)
          ? 1
          : a.route.id < b.route.id
            ? -1
            : a.route.id > b.route.id
              ? 1
              : 0,
    );
    const selected = priced[0];
    requireCondition(
      BigInt(selected.maximumUsd6) <= BigInt(input.budgetUsd6),
      409,
      'ROUTING_BUDGET_EXCEEDED',
      'No compatible route fits the request budget.',
    );
    const requestHash = await callRequestHash(
      input.projectId,
      selected.route.id,
      selected.candidate.input,
    );
    const quote = await one<{
      id: string;
      maximumUsd6: string;
      expiresAt: Date;
    }>(
      db,
      `INSERT INTO quotes(id,account_id,project_id,route_version_id,request_hash,max_usd6,max_output_tokens,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,LEAST(clock_timestamp()+interval '120 seconds',$8,$9))
      RETURNING id,max_usd6 AS "maximumUsd6",expires_at AS "expiresAt"`,
      [
        crypto.randomUUID(),
        accountId,
        input.projectId,
        selected.route.id,
        requestHash,
        selected.maximumUsd6,
        selected.candidate.input.maxOutputTokens,
        selected.route.expires_at,
        new Date(selected.reviewExpiry),
      ],
    );
    await recordQuotePlatformFee(db, quote!.id, selected.platformFee);
    const recommendation: RouteRecommendation = {
      version: 1,
      task: input.task,
      routeVersionId: selected.route.id,
      eligibleCount: priced.length,
      maximumUsd6: selected.maximumUsd6,
      reason: `Lowest maximum quoted cost among ${priced.length} reviewed, compatible supplied candidates for ${ROUTING_TASK_LABELS[input.task].toLowerCase()}. Each price includes its full supplied conversation context; this is not a model quality ranking.`,
    };
    return {
      quotes: [
        {
          ...quote!,
          routeVersionId: selected.route.id,
          requestHash,
          markupBps: selected.route.pricing.markupBps,
          modelId: selected.route.model_id,
          family: selected.route.family,
          card: selected.route.card,
          ...platformFeeFields(selected.platformFee),
          ...reservationFields(selected.reservation),
        },
      ],
      maximumUsd6: selected.maximumUsd6,
      recommendation,
    };
  });
  return jsonResponse(response, 201);
}
