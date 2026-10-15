import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { one, transaction } from '../db/database.ts';
import { ServiceError, requireCondition } from '../core/errors.ts';
import { PPQ_MODEL_ALLOWLIST } from '../ppq/catalog.ts';
import {
  fetchRouteCatalog,
  ROUTE_CATALOG_URL,
  type ReviewedRouteCard,
  type RouteCatalogSnapshot,
} from '../routes/route-registry.ts';
import { validateMediaPricing, type MediaOptions } from './contract.ts';

const REVIEW_MS = 86_400_000;
const CATALOG_MS = 900_000;
const upstreamOrigins: Record<string, readonly string[]> = {
  runway: [
    'https://runwayml.com',
    'https://help.runwayml.com',
    'https://docs.dev.runwayml.com',
  ],
  veo: [
    'https://policies.google.com',
    'https://cloud.google.com',
    'https://ai.google.dev',
  ],
  image: [
    'https://policies.google.com',
    'https://cloud.google.com',
    'https://ai.google.dev',
  ],
  kling: ['https://klingai.com', 'https://app.klingai.com'],
};
export type MediaTermsReview = {
  reviewed: true;
  commercialUse: 'allowed';
  evidenceUrls: string[];
  reviewedAt: string;
};
export type ReviewedMediaRoute = {
  id: string;
  routeId: string;
  version: number;
  modelId: string;
  family: string;
  modality: 'image' | 'video';
  enabled: boolean;
  expiresAt: string;
  card: ReviewedRouteCard & { mediaTerms: MediaTermsReview };
  pricing: ReturnType<typeof validateMediaPricing>;
};
export type MediaCatalogEvidence = Omit<RouteCatalogSnapshot, 'models'> & {
  priceCheck: 'matched';
};

function invalid(code = 'MEDIA_REVIEW_INVALID'): never {
  throw new ServiceError(
    400,
    code,
    'The media route review is incomplete, unsupported, or invalid.',
  );
}
function object(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== 'string' ||
        (!keys.includes(key) && !optional.includes(key)) ||
        !('value' in descriptors[key]),
    ) ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
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
function uuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    return invalid();
  return value;
}
function url(value: unknown, family: string, gatewayOnly = false): string {
  try {
    const parsed = new URL(text(value, 8, 2048));
    const allowed = [
      'https://ppq.ai',
      ...(gatewayOnly ? [] : (upstreamOrigins[family] ?? [])),
    ];
    if (
      !allowed.includes(parsed.origin) ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      parsed.search
    )
      return invalid();
    return parsed.href;
  } catch {
    return invalid('MEDIA_EVIDENCE_INVALID');
  }
}
function urls(value: unknown, family: string): string[] {
  if (!Array.isArray(value) || value.length > 8) return invalid();
  const result = value.map((item) => url(item, family));
  if (new Set(result).size !== result.length) return invalid();
  return result;
}
function fresh(value: unknown, now: number, expiresAt: number): string {
  const checked = utc(value),
    at = Date.parse(checked);
  if (
    at > now ||
    now - at > REVIEW_MS ||
    expiresAt > at + REVIEW_MS ||
    expiresAt <= now
  )
    return invalid('MEDIA_REVIEW_STALE');
  return checked;
}
function card(
  value: unknown,
  family: string,
  now: number,
  expiresAt: number,
): ReviewedMediaRoute['card'] {
  const r = object(value, [
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
    'mediaTerms',
  ]);
  if (
    r.level !== 'unverified' ||
    r.reviewed !== true ||
    r.provider !== 'ppq' ||
    r.plaintextVisibility !== 'gateway_and_upstream'
  )
    return invalid('MEDIA_PRIVACY_UNSUPPORTED');
  if (
    !Array.isArray(r.upstreamProviders) ||
    !r.upstreamProviders.length ||
    r.upstreamProviders.length > 8
  )
    return invalid();
  const upstreamProviders = r.upstreamProviders.map((value) =>
    text(value, 1, 100),
  );
  if (new Set(upstreamProviders).size !== upstreamProviders.length)
    return invalid();
  const upstreamEvidenceUrls = urls(r.upstreamEvidenceUrls, family);
  if (
    !['unknown', 'not_used', 'may_be_used'].includes(String(r.trainingUse)) ||
    !['unknown', 'possible', 'disclosed_exception'].includes(
      String(r.legalHold),
    )
  )
    return invalid();
  const evidenceDate = text(r.evidenceDate, 10, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(evidenceDate) ||
    !Number.isFinite(Date.parse(`${evidenceDate}T00:00:00.000Z`)) ||
    new Date(`${evidenceDate}T00:00:00.000Z`).toISOString().slice(0, 10) !==
      evidenceDate
  )
    return invalid();
  const lastVerifiedAt = fresh(r.lastVerifiedAt, now, expiresAt);
  if (evidenceDate > lastVerifiedAt.slice(0, 10)) return invalid();
  if (
    (r.retentionDays !== null ||
      r.trainingUse !== 'unknown' ||
      r.jurisdiction !== null ||
      r.legalHold !== 'unknown') &&
    !upstreamEvidenceUrls.some((value) =>
      upstreamOrigins[family].includes(new URL(value).origin),
    )
  )
    return invalid('MEDIA_EVIDENCE_REQUIRED');
  const terms = object(r.mediaTerms, [
    'reviewed',
    'commercialUse',
    'evidenceUrls',
    'reviewedAt',
  ]);
  if (terms.reviewed !== true || terms.commercialUse !== 'allowed')
    return invalid('MEDIA_TERMS_REQUIRED');
  const evidenceUrls = urls(terms.evidenceUrls, family);
  if (
    !evidenceUrls.some((value) => new URL(value).origin === 'https://ppq.ai') ||
    !evidenceUrls.some((value) =>
      upstreamOrigins[family].includes(new URL(value).origin),
    )
  )
    return invalid('MEDIA_TERMS_REQUIRED');
  return {
    level: 'unverified',
    reviewed: true,
    provider: 'ppq',
    upstreamProviders,
    plaintextVisibility: 'gateway_and_upstream',
    retentionDays:
      r.retentionDays === null ? null : integer(r.retentionDays, 0, 36500),
    trainingUse: r.trainingUse as ReviewedRouteCard['trainingUse'],
    jurisdiction: r.jurisdiction === null ? null : text(r.jurisdiction, 2, 200),
    legalHold: r.legalHold as ReviewedRouteCard['legalHold'],
    retentionDisclosure: text(r.retentionDisclosure, 20, 2000),
    evidenceUrl: url(r.evidenceUrl, family, true),
    upstreamEvidenceUrls,
    evidenceDate,
    lastVerifiedAt,
    mediaTerms: {
      reviewed: true,
      commercialUse: 'allowed',
      evidenceUrls,
      reviewedAt: fresh(terms.reviewedAt, now, expiresAt),
    },
  };
}

/** Exact option-to-catalog binding; no generic defaults, promotions or cheaper substitute variants. */
export function mediaCatalogVariant(
  modelId: string,
  options: MediaOptions,
): { quality: string; size: string } {
  if (modelId === 'nano-banana-2' && options.kind === 'image')
    return { quality: 'standard', size: options.resolution };
  if (
    ['runway-gen4', 'veo3-fast', 'kling-2.5-turbo'].includes(modelId) &&
    options.kind === 'video'
  )
    return {
      quality: options.quality,
      size: `${options.aspectRatio}_${options.duration}`,
    };
  return invalid('MEDIA_MODEL_UNAVAILABLE');
}

/** This records operator review, not an independent legal or privacy certification. */
export function validateMediaReview(
  value: unknown,
  checkedAt = new Date().toISOString(),
): ReviewedMediaRoute[] {
  const now = Date.parse(utc(checkedAt)),
    document = object(value, ['version', 'routes']);
  if (
    document.version !== 1 ||
    !Array.isArray(document.routes) ||
    !document.routes.length ||
    document.routes.length > 32
  )
    return invalid();
  const ids = new Set<string>(),
    names = new Set<string>();
  return document.routes.map((raw) => {
    const r = object(
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
    const id = uuid(r.id),
      routeId = text(r.routeId, 1, 80),
      family = text(r.family, 1, 40);
    if (
      !/^[a-z][a-z0-9_-]*$/.test(routeId) ||
      ids.has(id) ||
      names.has(routeId)
    )
      return invalid();
    ids.add(id);
    names.add(routeId);
    if (
      !Object.hasOwn(upstreamOrigins, family) ||
      !Object.hasOwn(PPQ_MODEL_ALLOWLIST, family)
    )
      return invalid('MEDIA_MODEL_UNAVAILABLE');
    const allowed =
      PPQ_MODEL_ALLOWLIST[family as keyof typeof PPQ_MODEL_ALLOWLIST];
    if (
      allowed.modality === 'chat' ||
      r.modality !== allowed.modality ||
      r.modelId !== allowed.id
    )
      return invalid('MEDIA_MODEL_UNAVAILABLE');
    if (r.enabled !== undefined && typeof r.enabled !== 'boolean')
      return invalid();
    const expiresAt = utc(r.expiresAt);
    let pricing: ReturnType<typeof validateMediaPricing>;
    try {
      pricing = validateMediaPricing(r.pricing, allowed.id);
    } catch {
      return invalid('MEDIA_PRICING_INVALID');
    }
    for (const variant of pricing.variants) {
      const expected = mediaCatalogVariant(allowed.id, variant.options);
      if (
        variant.catalogQuality !== expected.quality ||
        variant.catalogSize !== expected.size
      )
        return invalid('MEDIA_VARIANT_MISMATCH');
    }
    return {
      id,
      routeId,
      version: integer(r.version, 1, 2147483647),
      modelId: allowed.id,
      family,
      modality: allowed.modality,
      enabled: r.enabled === true,
      expiresAt,
      card: card(r.card, family, now, Date.parse(expiresAt)),
      pricing,
    };
  });
}

export async function fetchMediaCatalog(
  options: Parameters<typeof fetchRouteCatalog>[0] = {},
): Promise<RouteCatalogSnapshot> {
  try {
    return await fetchRouteCatalog(options);
  } catch {
    throw new ServiceError(
      503,
      'MEDIA_CATALOG_UNAVAILABLE',
      'The public media catalog could not be verified.',
    );
  }
}

export function validateMediaCatalog(
  routes: readonly ReviewedMediaRoute[],
  snapshot: RouteCatalogSnapshot,
  checkedAt = new Date().toISOString(),
): MediaCatalogEvidence {
  const now = Date.parse(utc(checkedAt)),
    fetched = Date.parse(utc(snapshot.fetchedAt));
  if (
    snapshot.sourceUrl !== ROUTE_CATALOG_URL ||
    !/^[a-f0-9]{64}$/.test(snapshot.sha256) ||
    fetched > now ||
    now - fetched > CATALOG_MS
  )
    return invalid('MEDIA_CATALOG_STALE');
  if (!Array.isArray(snapshot.models) || snapshot.models.length > 5000)
    return invalid('MEDIA_CATALOG_INVALID');
  for (const route of routes) {
    if (Date.parse(route.expiresAt) > fetched + REVIEW_MS)
      return invalid('MEDIA_REVIEW_STALE');
    const matches = snapshot.models.filter((m) => m.id === route.modelId);
    if (
      matches.length !== 1 ||
      matches[0].family !== route.family ||
      matches[0].modality !== route.modality
    )
      return invalid('MEDIA_MODEL_UNAVAILABLE');
    for (const variant of route.pricing.variants) {
      const expected = mediaCatalogVariant(route.modelId, variant.options);
      if (
        variant.catalogQuality !== expected.quality ||
        variant.catalogSize !== expected.size
      )
        return invalid('MEDIA_VARIANT_MISMATCH');
      const matchesPrice = matches[0].pricing.variants.filter(
        (p) => p.quality === expected.quality && p.size === expected.size,
      );
      if (
        matchesPrice.length !== 1 ||
        !Number.isSafeInteger(matchesPrice[0].usd6) ||
        matchesPrice[0].usd6 <= 0 ||
        String(matchesPrice[0].usd6) !== variant.providerUsd6
      )
        return invalid('MEDIA_CATALOG_PRICE_MISMATCH');
    }
  }
  return {
    sourceUrl: ROUTE_CATALOG_URL,
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
  card: ReviewedMediaRoute['card'] & {
    catalogVerification?: MediaCatalogEvidence | null;
  };
  pricing: ReviewedMediaRoute['pricing'];
};

/** Explicit installation only; no route updates or activation of an existing version. */
export async function installReviewedMediaRoutes(
  pool: Pool,
  document: unknown,
  options: { enableReviewed?: boolean; catalog?: RouteCatalogSnapshot } = {},
): Promise<{ installed: number; replayed: number; enabled: number }> {
  return transaction(pool, async (db) => {
    // Shared with the chat registry: both own rows in route_versions.
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('conclave_route_registry_v1'))",
    );
    const clock = await one<{ at: Date }>(db, 'SELECT clock_timestamp() AS at');
    const now = clock!.at.toISOString(),
      routes = validateMediaReview(document, now);
    if (routes.some((r) => r.enabled) && options.enableReviewed !== true)
      return invalid('MEDIA_ENABLE_CONFIRMATION_REQUIRED');
    if (!options.catalog) return invalid('MEDIA_CATALOG_REQUIRED');
    const catalogVerification = validateMediaCatalog(
      routes,
      options.catalog,
      now,
    );
    const result = { installed: 0, replayed: 0, enabled: 0 };
    for (const route of routes) {
      const existing = await db.query<StoredRoute>(
        'SELECT * FROM route_versions WHERE id=$1 OR (route_id=$2 AND version=$3) FOR UPDATE',
        [route.id, route.routeId, route.version],
      );
      if (existing.rows.length) {
        const previous = existing.rows[0];
        const { catalogVerification: _catalog, ...previousCard } =
          previous.card;
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
            isDeepStrictEqual(previousCard, route.card) &&
            isDeepStrictEqual(previous.pricing, route.pricing),
          409,
          'MEDIA_VERSION_CONFLICT',
          'Install a new media route version instead of changing existing reviewed terms.',
        );
        result.replayed++;
      } else {
        const latest = await one<{ version: number | null }>(
          db,
          'SELECT max(version) AS version FROM route_versions WHERE route_id=$1',
          [route.routeId],
        );
        requireCondition(
          route.version === (latest!.version ?? 0) + 1,
          409,
          'MEDIA_VERSION_SEQUENCE',
          'Use the next sequential media route version.',
        );
        await db.query(
          'INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,card,pricing,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
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
