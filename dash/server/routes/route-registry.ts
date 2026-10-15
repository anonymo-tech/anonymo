import { CHAT_LIMITS } from '../../lib/chat-limits.ts';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { ServiceError, requireCondition } from '../core/errors.ts';
import { one, transaction } from '../db/database.ts';
import { usd6 } from '../ledger/money.ts';
import {
  normalizeCatalog,
  PPQ_MODEL_ALLOWLIST,
  type PpqCatalogModel,
} from '../ppq/catalog.ts';
import { parseProviderJson } from '../ppq/codec.ts';
import {
  parseRoutingProfile,
  routingProfileFresh,
  type RoutingProfile,
} from '../../lib/model-routing.ts';

export const ROUTE_CATALOG_URL = 'https://api.ppq.ai/v1/models?type=all';
const MAX_REVIEW_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CATALOG_AGE_MS = 15 * 60 * 1000;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const evidenceOrigins = new Set([
  'https://ppq.ai',
  'https://www.ppq.ai',
  'https://openrouter.ai',
  'https://www.anthropic.com',
  'https://privacy.anthropic.com',
  'https://platform.claude.com',
  'https://docs.claude.com',
  'https://openai.com',
  'https://platform.openai.com',
  'https://cloud.google.com',
  'https://ai.google.dev',
  'https://policies.google.com',
  'https://x.ai',
  'https://docs.x.ai',
  'https://privacy.x.ai',
]);

export type ReviewedRouteCard = {
  level: 'unverified';
  reviewed: true;
  provider: 'ppq';
  upstreamProviders: string[];
  plaintextVisibility: 'gateway_and_upstream';
  retentionDays: number | null;
  trainingUse: 'unknown' | 'not_used' | 'may_be_used';
  jurisdiction: string | null;
  legalHold: 'unknown' | 'possible' | 'disclosed_exception';
  retentionDisclosure: string;
  evidenceUrl: string;
  upstreamEvidenceUrls: string[];
  evidenceDate: string;
  lastVerifiedAt: string;
  routing?: RoutingProfile;
};
export type ReviewedRoutePricing = {
  inputPerMillionUsd6: string;
  outputPerMillionUsd6: string;
  cacheReadPerMillionUsd6?: string;
  markupBps: number;
  maxOutputTokens: number;
  maxInputBytes: number;
  /** Reviewed per-request reasoning token cap (0 for non-reasoning models). */
  maxReasoningTokens?: number;
  contextTokens?: number;
};
export type ReviewedRoute = {
  id: string;
  routeId: string;
  version: number;
  modelId: string;
  family: string;
  modality: 'chat';
  enabled: boolean;
  expiresAt: string;
  card: ReviewedRouteCard;
  pricing: ReviewedRoutePricing;
};
export type RouteCatalogSnapshot = {
  sourceUrl: typeof ROUTE_CATALOG_URL;
  fetchedAt: string;
  sha256: string;
  models: PpqCatalogModel[];
};
type CatalogEvidence = Omit<RouteCatalogSnapshot, 'models'> & {
  priceCheck: 'matched';
};

function invalid(code = 'ROUTE_REVIEW_INVALID'): never {
  throw new ServiceError(
    400,
    code,
    'The route review is incomplete, unsupported, or invalid.',
  );
}
function object(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  const actual = Reflect.ownKeys(value);
  if (
    actual.some(
      (key) =>
        typeof key !== 'string' ||
        (!keys.includes(key) && !optional.includes(key)),
    ) ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (actual.some((key) => !('value' in descriptors[key as string])))
    return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, minimum: number, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    value.trim() !== value ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    })
  )
    return invalid();
  return value;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    return invalid();
  return value;
}
function utc(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return invalid();
  return value;
}
function reference(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    return invalid();
  return value;
}
function evidence(value: unknown, intermediary = false): string {
  try {
    const url = new URL(text(value, 8, 2048));
    if (
      !evidenceOrigins.has(url.origin) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      (intermediary && url.origin !== 'https://ppq.ai')
    )
      return invalid();
    return url.toString();
  } catch {
    return invalid();
  }
}
function amount(value: unknown): string {
  try {
    return usd6(value).toString();
  } catch {
    return invalid('ROUTE_PRICE_INVALID');
  }
}

/** Operator evidence establishes the reviewed task scope, never a quality guarantee. */
export function validateRouteRoutingProfile(
  value: unknown,
  checkedAt: string,
  expiresAt: string,
): RoutingProfile {
  let profile: RoutingProfile;
  try {
    object(value, ['version', 'tasks', 'evidenceUrl', 'reviewedAt']);
    profile = parseRoutingProfile(value);
  } catch {
    return invalid('ROUTE_ROUTING_REVIEW_INVALID');
  }
  evidence(profile.evidenceUrl);
  if (!routingProfileFresh(profile, Date.parse(checkedAt), expiresAt))
    return invalid('ROUTE_ROUTING_REVIEW_STALE');
  return profile;
}

/** A completed operator review is not a certified privacy tier. Strict routing stays unavailable. */
export function validateRouteReview(
  value: unknown,
  checkedAt = new Date().toISOString(),
): ReviewedRoute[] {
  const now = Date.parse(utc(checkedAt));
  const document = object(value, ['version', 'routes']);
  if (
    document.version !== 1 ||
    !Array.isArray(document.routes) ||
    document.routes.length < 1 ||
    document.routes.length > 256
  )
    return invalid();
  const ids = new Set<string>(),
    routes = new Set<string>();
  return document.routes.map((raw): ReviewedRoute => {
    const entry = object(
      raw,
      [
        'id',
        'routeId',
        'version',
        'modelId',
        'family',
        'modality',
        'expiresAt',
        'card',
        'pricing',
      ],
      ['enabled'],
    );
    const id = reference(entry.id);
    const routeId = text(entry.routeId, 1, 80);
    if (
      !/^[a-z][a-z0-9_-]*$/.test(routeId) ||
      ids.has(id) ||
      routes.has(routeId)
    )
      return invalid();
    ids.add(id);
    routes.add(routeId);
    const family = text(entry.family, 1, 40);
    if (!Object.hasOwn(PPQ_MODEL_ALLOWLIST, family))
      return invalid('ROUTE_MODEL_UNAVAILABLE');
    const allowed =
      PPQ_MODEL_ALLOWLIST[family as keyof typeof PPQ_MODEL_ALLOWLIST];
    if (entry.modality !== 'chat' || allowed.modality !== 'chat')
      return invalid('ROUTE_MODALITY_UNAVAILABLE');
    if (entry.modelId !== allowed.id) return invalid('ROUTE_MODEL_UNAVAILABLE');
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean')
      return invalid();
    const expiresAt = utc(entry.expiresAt);
    const rawCard = object(
      entry.card,
      [
        'level',
        'reviewed',
        'provider',
        'upstreamProviders',
        'plaintextVisibility',
        'retentionDays',
        'trainingUse',
        'jurisdiction',
        'legalHold',
        'retentionDisclosure',
        'evidenceUrl',
        'upstreamEvidenceUrls',
        'evidenceDate',
        'lastVerifiedAt',
      ],
      ['routing'],
    );
    if (
      rawCard.level !== 'unverified' ||
      rawCard.reviewed !== true ||
      rawCard.provider !== 'ppq' ||
      rawCard.plaintextVisibility !== 'gateway_and_upstream'
    )
      return invalid('ROUTE_PRIVACY_UNSUPPORTED');
    if (
      !Array.isArray(rawCard.upstreamProviders) ||
      rawCard.upstreamProviders.length < 1 ||
      rawCard.upstreamProviders.length > 8 ||
      !Array.isArray(rawCard.upstreamEvidenceUrls) ||
      rawCard.upstreamEvidenceUrls.length > 8
    )
      return invalid();
    const upstreamProviders = rawCard.upstreamProviders.map((provider) =>
      text(provider, 1, 100),
    );
    const upstreamEvidenceUrls = rawCard.upstreamEvidenceUrls.map((url) =>
      evidence(url),
    );
    if (
      new Set(upstreamProviders).size !== upstreamProviders.length ||
      new Set(upstreamEvidenceUrls).size !== upstreamEvidenceUrls.length
    )
      return invalid();
    if (
      !['unknown', 'not_used', 'may_be_used'].includes(
        rawCard.trainingUse as string,
      ) ||
      !['unknown', 'possible', 'disclosed_exception'].includes(
        rawCard.legalHold as string,
      )
    )
      return invalid();
    const evidenceDate = text(rawCard.evidenceDate, 10, 10);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(evidenceDate) ||
      !Number.isFinite(Date.parse(`${evidenceDate}T00:00:00.000Z`)) ||
      new Date(`${evidenceDate}T00:00:00.000Z`).toISOString().slice(0, 10) !==
        evidenceDate
    )
      return invalid();
    const lastVerifiedAt = utc(rawCard.lastVerifiedAt);
    const verified = Date.parse(lastVerifiedAt);
    if (
      verified > now ||
      now - verified > MAX_REVIEW_AGE_MS ||
      Date.parse(expiresAt) <= now ||
      Date.parse(expiresAt) > verified + MAX_REVIEW_AGE_MS ||
      evidenceDate > lastVerifiedAt.slice(0, 10)
    )
      return invalid('ROUTE_REVIEW_STALE');
    // A non-unknown assertion requires a separate upstream policy reference. The
    // operator still owns the semantic/contract review; URLs alone prove nothing.
    if (
      (rawCard.retentionDays !== null ||
        rawCard.trainingUse !== 'unknown' ||
        rawCard.jurisdiction !== null ||
        rawCard.legalHold !== 'unknown') &&
      !upstreamEvidenceUrls.length
    )
      return invalid('ROUTE_EVIDENCE_REQUIRED');
    const card: ReviewedRouteCard = {
      level: 'unverified',
      reviewed: true,
      provider: 'ppq',
      upstreamProviders,
      plaintextVisibility: 'gateway_and_upstream',
      retentionDays:
        rawCard.retentionDays === null
          ? null
          : integer(rawCard.retentionDays, 0, 36500),
      trainingUse: rawCard.trainingUse as ReviewedRouteCard['trainingUse'],
      jurisdiction:
        rawCard.jurisdiction === null
          ? null
          : text(rawCard.jurisdiction, 2, 200),
      legalHold: rawCard.legalHold as ReviewedRouteCard['legalHold'],
      retentionDisclosure: text(rawCard.retentionDisclosure, 20, 2000),
      evidenceUrl: evidence(rawCard.evidenceUrl, true),
      upstreamEvidenceUrls,
      evidenceDate,
      lastVerifiedAt,
      ...(rawCard.routing === undefined
        ? {}
        : {
            routing: validateRouteRoutingProfile(
              rawCard.routing,
              checkedAt,
              expiresAt,
            ),
          }),
    };
    const rawPricing = object(
      entry.pricing,
      [
        'inputPerMillionUsd6',
        'outputPerMillionUsd6',
        'markupBps',
        'maxOutputTokens',
        'maxInputBytes',
      ],
      ['maxReasoningTokens', 'contextTokens', 'cacheReadPerMillionUsd6'],
    );
    const pricing: ReviewedRoutePricing = {
      inputPerMillionUsd6: amount(rawPricing.inputPerMillionUsd6),
      outputPerMillionUsd6: amount(rawPricing.outputPerMillionUsd6),
      ...(rawPricing.cacheReadPerMillionUsd6 === undefined ? {} : {cacheReadPerMillionUsd6: amount(rawPricing.cacheReadPerMillionUsd6)}),
      markupBps: integer(rawPricing.markupBps, 0, 10000),
      maxOutputTokens: integer(rawPricing.maxOutputTokens, 1, CHAT_LIMITS.outputTokens),
      maxInputBytes: integer(rawPricing.maxInputBytes, 1, CHAT_LIMITS.inputBytes),
      ...(rawPricing.contextTokens === undefined ? {} : { contextTokens: integer(rawPricing.contextTokens, 1, 10000000) }),
      ...(rawPricing.maxReasoningTokens === undefined
        ? {}
        : {
            maxReasoningTokens: integer(rawPricing.maxReasoningTokens, 0, CHAT_LIMITS.outputTokens),
          }),
    };
    return {
      id,
      routeId,
      version: integer(entry.version, 1, 2147483647),
      modelId: allowed.id,
      family,
      modality: 'chat',
      enabled: entry.enabled === true,
      expiresAt,
      card,
      pricing,
    };
  });
}

async function interrupted<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Catalog request interrupted'));
    if (signal.aborted) {
      void promise.catch(() => {});
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** One unauthenticated, bounded public GET. No inference, credentials, redirects or retries. */
export async function fetchRouteCatalog(
  options: {
    fetch?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<RouteCatalogSnapshot> {
  const timeout = options.timeoutMs ?? 20000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000)
    return invalid();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (typeof window !== 'undefined' || signal.aborted) throw new Error();
    const response = await interrupted(
      (options.fetch ?? fetch)(ROUTE_CATALOG_URL, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal,
      }),
      signal,
    );
    if (
      !response.ok ||
      response.redirected ||
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers.get('content-type') ?? '',
      ) ||
      !response.body
    ) {
      void response.body?.cancel().catch(() => {});
      throw new Error();
    }
    reader = response.body.getReader();
    const declared = response.headers.get('content-length');
    if (
      declared &&
      (!/^\d+$/.test(declared) || Number(declared) > MAX_CATALOG_BYTES)
    )
      throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await interrupted(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_CATALOG_BYTES) throw new Error();
      chunks.push(next.value);
    }
    const bytes = Buffer.concat(chunks);
    const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const models = normalizeCatalog(parseProviderJson(body));
    return {
      sourceUrl: ROUTE_CATALOG_URL,
      fetchedAt: new Date().toISOString(),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      models,
    };
  } catch {
    throw new ServiceError(
      503,
      'ROUTE_CATALOG_UNAVAILABLE',
      'The current public model catalog could not be verified.',
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

export function validateRouteCatalog(
  routes: readonly ReviewedRoute[],
  snapshot: RouteCatalogSnapshot,
  checkedAt = new Date().toISOString(),
): CatalogEvidence {
  const now = Date.parse(utc(checkedAt));
  const observed = Date.parse(utc(snapshot.fetchedAt));
  if (
    snapshot.sourceUrl !== ROUTE_CATALOG_URL ||
    !/^[0-9a-f]{64}$/.test(snapshot.sha256) ||
    observed > now ||
    now - observed > MAX_CATALOG_AGE_MS
  )
    return invalid('ROUTE_CATALOG_STALE');
  for (const route of routes) {
    const models = snapshot.models.filter(
      (item) =>
        item.id === route.modelId &&
        item.family === route.family &&
        item.modality === 'chat',
    );
    if (models.length !== 1) return invalid('ROUTE_MODEL_UNAVAILABLE');
    const model = models[0];
    const input = model.pricing.inputPerMillionUsd6,
      output = model.pricing.outputPerMillionUsd6;
    if (
      input === null ||
      output === null ||
      !Number.isSafeInteger(input) ||
      !Number.isSafeInteger(output) ||
      String(input) !== route.pricing.inputPerMillionUsd6 ||
      String(output) !== route.pricing.outputPerMillionUsd6 ||
      (route.pricing.cacheReadPerMillionUsd6 !== undefined &&
        (!Number.isSafeInteger(model.pricing.cacheReadPerMillionUsd6) || model.pricing.cacheReadPerMillionUsd6! < 0 ||
         model.pricing.cacheReadPerMillionUsd6! > input ||
         String(model.pricing.cacheReadPerMillionUsd6) !== route.pricing.cacheReadPerMillionUsd6))
    )
      return invalid('ROUTE_CATALOG_PRICE_MISMATCH');
    // Native routes disclose context in tokens; legacy byte-bounded reviews remain valid.
    const allowance = route.pricing.contextTokens ??
      (route.pricing.maxInputBytes + 40 * 256 + 1024 + route.pricing.maxOutputTokens);
    if (
      model.contextLength === null ||
      !Number.isSafeInteger(model.contextLength) ||
      allowance > model.contextLength ||
      (route.pricing.contextTokens !== undefined && route.pricing.contextTokens !== model.contextLength) ||
      route.pricing.maxOutputTokens >= model.contextLength
    )
      return invalid('ROUTE_CONTEXT_UNAVAILABLE');
  }
  return {
    sourceUrl: snapshot.sourceUrl,
    fetchedAt: snapshot.fetchedAt,
    sha256: snapshot.sha256,
    priceCheck: 'matched',
  };
}

type StoredRoute = {
  id: string;
  route_id: string;
  version: number;
  model_id: string;
  family: string;
  modality: string;
  enabled: boolean;
  expires_at: Date;
  card: ReviewedRouteCard & { catalogVerification?: CatalogEvidence | null };
  pricing: ReviewedRoutePricing;
};
export type RouteInstallResult = {
  installed: number;
  replayed: number;
  enabled: number;
};

/** Explicit operator operation. Existing versions, including their enabled flag, are never changed. */
export async function installReviewedRoutes(
  pool: Pool,
  document: unknown,
  options: { enableReviewed?: boolean; catalog?: RouteCatalogSnapshot } = {},
): Promise<RouteInstallResult> {
  return transaction(pool, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('conclave_route_registry_v1'))",
    );
    const clock = await one<{ at: Date }>(
      client,
      'SELECT clock_timestamp() AS at',
    );
    const now = clock!.at.toISOString();
    const routes = validateRouteReview(document, now);
    if (
      routes.some((route) => route.enabled) &&
      options.enableReviewed !== true
    )
      return invalid('ROUTE_ENABLE_CONFIRMATION_REQUIRED');
    if (routes.some((route) => route.enabled) && !options.catalog)
      return invalid('ROUTE_CATALOG_REQUIRED');
    const catalogVerification = options.catalog
      ? validateRouteCatalog(routes, options.catalog, now)
      : null;
    const result = { installed: 0, replayed: 0, enabled: 0 };
    for (const route of routes) {
      const existing = await client.query<StoredRoute>(
        'SELECT * FROM route_versions WHERE id=$1 OR (route_id=$2 AND version=$3)',
        [route.id, route.routeId, route.version],
      );
      if (existing.rows.length) {
        const previous = existing.rows[0];
        const { catalogVerification: _evidence, ...card } = previous.card;
        requireCondition(
          existing.rows.length === 1 &&
            previous.id === route.id &&
            previous.route_id === route.routeId &&
            previous.version === route.version &&
            previous.model_id === route.modelId &&
            previous.family === route.family &&
            previous.modality === route.modality &&
            previous.enabled === route.enabled &&
            previous.expires_at.toISOString() === route.expiresAt &&
            isDeepStrictEqual(card, route.card) &&
            isDeepStrictEqual(previous.pricing, route.pricing),
          409,
          'ROUTE_VERSION_CONFLICT',
          'Publish a new route version instead of changing existing reviewed terms.',
        );
        result.replayed++;
      } else {
        const latest = await one<{ version: number | null }>(
          client,
          'SELECT max(version) AS version FROM route_versions WHERE route_id=$1',
          [route.routeId],
        );
        requireCondition(
          route.version === (latest!.version ?? 0) + 1,
          409,
          'ROUTE_VERSION_SEQUENCE',
          'A new route must use the next sequential version.',
        );
        await client.query(
          `INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,card,pricing,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            route.id,
            route.routeId,
            route.version,
            route.modelId,
            route.family,
            route.modality,
            route.enabled,
            { ...route.card, catalogVerification },
            route.pricing,
            route.expiresAt,
          ],
        );
        result.installed++;
      }
      if (route.enabled) result.enabled++;
    }
    return result;
  });
}
