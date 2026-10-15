import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { one, transaction, type Queryable } from '../db/database.ts';
import { ServiceError, requireCondition } from '../core/errors.ts';
import { PPQ_MODEL_ALLOWLIST } from '../ppq/catalog.ts';
import {
  ROUTE_CATALOG_URL,
  validateRouteReview,
  type ReviewedRouteCard,
  type ReviewedRoutePricing,
} from '../routes/route-registry.ts';

const REVIEW_LIFETIME_MS = 86_400_000;
const distributions = Object.freeze({
  gpt: 'proprietary',
  claude: 'proprietary',
  gemini: 'proprietary',
  grok: 'proprietary',
  deepseek: 'open-weight',
  qwen: 'open-weight',
  llama: 'open-weight',
} as const);

export type ReviewedRosterMember = {
  routeVersionId: string;
  modelId: string;
  family: keyof typeof distributions;
  modelVersion: string;
  distribution: 'proprietary' | 'open-weight';
};
export type ReviewedRoster = {
  id: string;
  label: string;
  version: number;
  reviewedAt: string;
  expiresAt: string;
  enabled: boolean;
  reviewers: ReviewedRosterMember[];
};
type StoredMember = Pick<
  ReviewedRosterMember,
  'routeVersionId' | 'modelVersion' | 'distribution'
>;
type StoredRoster = {
  id: string;
  label: string;
  version: number;
  reviewed_at: Date;
  expires_at: Date;
  enabled: boolean;
  reviewers: StoredMember[];
};
type StoredRoute = {
  id: string;
  route_id: string;
  version: number;
  model_id: string;
  family: string;
  modality: string;
  enabled: boolean;
  expires_at: Date;
  card: ReviewedRouteCard & { catalogVerification?: unknown };
  pricing: ReviewedRoutePricing;
};

function invalid(code = 'CROSSCHECK_REVIEW_INVALID'): never {
  throw new ServiceError(
    400,
    code,
    'The roster review is incomplete, unsupported, or invalid.',
  );
}
function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== 'string' ||
        !('value' in descriptors[key]) ||
        (!required.includes(key) && !optional.includes(key)),
    ) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    return invalid();
  return value as Record<string, unknown>;
}
function array(value: unknown, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== 'string' ||
        !('value' in descriptors[key]) ||
        (key !== 'length' &&
          (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)),
    ) ||
    Array.from({ length: value.length }, (_, index) => index).some(
      (index) => !Object.hasOwn(value, index),
    )
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
function member(value: unknown): ReviewedRosterMember {
  const entry = object(value, [
    'routeVersionId',
    'modelId',
    'family',
    'modelVersion',
    'distribution',
  ]);
  if (
    typeof entry.family !== 'string' ||
    !Object.hasOwn(distributions, entry.family)
  )
    return invalid('CROSSCHECK_MODEL_UNAVAILABLE');
  const family = entry.family as keyof typeof distributions;
  if (entry.modelId !== PPQ_MODEL_ALLOWLIST[family].id)
    return invalid('CROSSCHECK_MODEL_UNAVAILABLE');
  if (entry.distribution !== distributions[family])
    return invalid('CROSSCHECK_DISTRIBUTION_MISMATCH');
  if (
    typeof entry.modelVersion !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(entry.modelVersion) ||
    ['latest', 'unknown', 'auto'].includes(entry.modelVersion.toLowerCase())
  )
    return invalid('CROSSCHECK_MODEL_VERSION_REQUIRED');
  return {
    routeVersionId: uuid(entry.routeVersionId),
    modelId: PPQ_MODEL_ALLOWLIST[family].id,
    family,
    modelVersion: entry.modelVersion,
    distribution: distributions[family],
  };
}

/** Local structural validation only. No database, provider request or environment mutation. */
export function validateCrossCheckReview(
  value: unknown,
  checkedAt = new Date().toISOString(),
): ReviewedRoster[] {
  const now = Date.parse(utc(checkedAt));
  const document = object(value, ['version', 'rosters']);
  if (document.version !== 1) return invalid();
  const ids = new Set<string>(),
    labels = new Set<string>();
  return array(document.rosters, 1, 8).map((raw) => {
    const entry = object(
      raw,
      [
        'id',
        'label',
        'version',
        'reviewed',
        'reviewedAt',
        'expiresAt',
        'reviewers',
      ],
      ['enabled'],
    );
    const id = uuid(entry.id);
    if (
      typeof entry.label !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,119}$/.test(entry.label) ||
      entry.label.trim() !== entry.label ||
      ids.has(id) ||
      labels.has(entry.label) ||
      entry.reviewed !== true ||
      !Number.isSafeInteger(entry.version) ||
      Number(entry.version) < 1 ||
      Number(entry.version) > 2147483647 ||
      (entry.enabled !== undefined && typeof entry.enabled !== 'boolean')
    )
      return invalid();
    ids.add(id);
    labels.add(entry.label);
    const reviewedAt = utc(entry.reviewedAt),
      expiresAt = utc(entry.expiresAt),
      reviewed = Date.parse(reviewedAt),
      expires = Date.parse(expiresAt);
    if (
      reviewed > now ||
      now - reviewed > REVIEW_LIFETIME_MS ||
      expires <= now ||
      expires > reviewed + REVIEW_LIFETIME_MS
    )
      return invalid('CROSSCHECK_REVIEW_STALE');
    const reviewers = array(entry.reviewers, 3, 8)
      .map(member)
      .sort((a, b) =>
        a.routeVersionId < b.routeVersionId
          ? -1
          : a.routeVersionId > b.routeVersionId
            ? 1
            : 0,
      );
    if (
      new Set(reviewers.map((reviewer) => reviewer.routeVersionId)).size !==
        reviewers.length ||
      new Set(reviewers.map((reviewer) => reviewer.family)).size !==
        reviewers.length ||
      new Set(reviewers.map((reviewer) => reviewer.modelId)).size !==
        reviewers.length ||
      new Set(reviewers.map((reviewer) => reviewer.distribution)).size !== 2
    )
      return invalid('CROSSCHECK_REVIEWER_DIVERSITY');
    return {
      id,
      label: entry.label,
      version: Number(entry.version),
      reviewedAt,
      expiresAt,
      enabled: entry.enabled === true,
      reviewers,
    };
  });
}

function storedMembers(roster: ReviewedRoster): StoredMember[] {
  return roster.reviewers.map(
    ({ routeVersionId, modelVersion, distribution }) => ({
      routeVersionId,
      modelVersion,
      distribution,
    }),
  );
}
function catalogEvidence(value: unknown, checkedAt: string): boolean {
  try {
    const entry = object(value, [
      'sourceUrl',
      'fetchedAt',
      'sha256',
      'priceCheck',
    ]);
    const checked = Date.parse(checkedAt),
      observed = Date.parse(utc(entry.fetchedAt));
    return (
      entry.sourceUrl === ROUTE_CATALOG_URL &&
      typeof entry.sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(entry.sha256) &&
      entry.priceCheck === 'matched' &&
      observed <= checked &&
      checked - observed <= REVIEW_LIFETIME_MS
    );
  } catch {
    return false;
  }
}

async function validateInstalledRoutes(
  db: Queryable,
  rosters: ReviewedRoster[],
  now: string,
  lock: boolean,
) {
  const ids = [
    ...new Set(
      rosters.flatMap((roster) =>
        roster.reviewers.map((reviewer) => reviewer.routeVersionId),
      ),
    ),
  ].sort();
  const rows = await db.query<StoredRoute>(
    `SELECT * FROM route_versions WHERE id=ANY($1::uuid[]) ORDER BY id ${lock ? 'FOR SHARE' : ''}`,
    [ids],
  );
  const routes = new Map(rows.rows.map((row) => [row.id, row]));
  let enableEligible = 0;
  for (const roster of rosters) {
    let eligible = true;
    for (const reviewer of roster.reviewers) {
      const route = routes.get(reviewer.routeVersionId);
      requireCondition(
        route &&
          route.family === reviewer.family &&
          route.model_id === reviewer.modelId &&
          route.modality === 'chat',
        409,
        'CROSSCHECK_ROUTE_MISMATCH',
        'A reviewed route is missing or does not match its declared model family.',
      );
      let catalogVerification: unknown;
      try {
        const { catalogVerification: recorded, ...card } = object(
          route.card,
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
          ['catalogVerification', 'routing'],
        );
        catalogVerification = recorded;
        validateRouteReview(
          {
            version: 1,
            routes: [
              {
                id: route.id,
                routeId: route.route_id,
                version: route.version,
                modelId: route.model_id,
                family: route.family,
                modality: route.modality,
                enabled: route.enabled,
                expiresAt: route.expires_at.toISOString(),
                card,
                pricing: route.pricing,
              },
            ],
          },
          now,
        );
      } catch {
        throw new ServiceError(
          409,
          'CROSSCHECK_ROUTE_REVIEW_REQUIRED',
          'Each route needs current reviewed privacy and pricing terms.',
        );
      }
      requireCondition(
        Date.parse(roster.expiresAt) <= route.expires_at.getTime(),
        409,
        'CROSSCHECK_ROUTE_EXPIRES_FIRST',
        'The roster must expire no later than any of its routes.',
      );
      const routeEligible =
        route.enabled && catalogEvidence(catalogVerification, now);
      if (!routeEligible) eligible = false;
      if (roster.enabled)
        requireCondition(
          routeEligible,
          409,
          'CROSSCHECK_ROUTE_NOT_ENABLED',
          'An enabled roster requires enabled routes with recorded current catalog evidence.',
        );
    }
    if (eligible) enableEligible++;
  }
  return { routeVersions: ids.length, enableEligible };
}

async function versionState(
  db: Queryable,
  roster: ReviewedRoster,
  lock: boolean,
) {
  const rows = await db.query<StoredRoster>(
    `SELECT * FROM crosscheck_rosters WHERE id=$1 OR (label=$2 AND version=$3) ${lock ? 'FOR UPDATE' : ''}`,
    [roster.id, roster.label, roster.version],
  );
  if (rows.rows.length) {
    const previous = rows.rows[0];
    requireCondition(
      rows.rows.length === 1 &&
        previous.id === roster.id &&
        previous.label === roster.label &&
        previous.version === roster.version &&
        previous.enabled === roster.enabled &&
        previous.reviewed_at.toISOString() === roster.reviewedAt &&
        previous.expires_at.toISOString() === roster.expiresAt &&
        isDeepStrictEqual(previous.reviewers, storedMembers(roster)),
      409,
      'CROSSCHECK_ROSTER_VERSION_CONFLICT',
      'Publish a new roster UUID and version instead of changing reviewed terms or enablement.',
    );
    return 'replayed' as const;
  }
  const latest = await one<{ version: number | null }>(
    db,
    'SELECT max(version) AS version FROM crosscheck_rosters WHERE label=$1',
    [roster.label],
  );
  requireCondition(
    roster.version === (latest!.version ?? 0) + 1,
    409,
    'CROSSCHECK_ROSTER_VERSION_SEQUENCE',
    'A new roster must use the next version for its exact label.',
  );
  return 'new' as const;
}

/** Read-only DB preflight; it cannot install or activate any configuration. */
export async function checkReviewedRosters(pool: Pool, document: unknown) {
  return transaction(pool, async (db) => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const clock = await one<{ at: Date }>(db, 'SELECT clock_timestamp() AS at');
    const now = clock!.at.toISOString(),
      rosters = validateCrossCheckReview(document, now);
    const eligibility = await validateInstalledRoutes(db, rosters, now, false);
    let newVersions = 0,
      replayed = 0;
    for (const roster of rosters) {
      if ((await versionState(db, roster, false)) === 'new') newVersions++;
      else replayed++;
    }
    return {
      rosters: rosters.length,
      newVersions,
      replayed,
      requestedEnabled: rosters.filter((roster) => roster.enabled).length,
      ...eligibility,
    };
  });
}

/** Explicit operator write. Never updates existing records or execution environment gates. */
export async function installReviewedRosters(
  pool: Pool,
  document: unknown,
  options: { enableReviewed?: boolean } = {},
) {
  return transaction(pool, async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('conclave_crosscheck_registry_v1'))",
    );
    const clock = await one<{ at: Date }>(db, 'SELECT clock_timestamp() AS at');
    const now = clock!.at.toISOString(),
      rosters = validateCrossCheckReview(document, now);
    requireCondition(
      !rosters.some((roster) => roster.enabled) ||
        options.enableReviewed === true,
      400,
      'CROSSCHECK_ENABLE_CONFIRMATION_REQUIRED',
      'Enabled roster insertion requires the explicit operator enable flag.',
    );
    const eligibility = await validateInstalledRoutes(db, rosters, now, true);
    const result = { installed: 0, replayed: 0, enabled: 0, ...eligibility };
    for (const roster of rosters) {
      if ((await versionState(db, roster, true)) === 'replayed')
        result.replayed++;
      else {
        await db.query(
          `INSERT INTO crosscheck_rosters(id,label,version,reviewers,reviewed_at,expires_at,enabled)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            roster.id,
            roster.label,
            roster.version,
            JSON.stringify(storedMembers(roster)),
            roster.reviewedAt,
            roster.expiresAt,
            roster.enabled,
          ],
        );
        result.installed++;
      }
      if (roster.enabled) result.enabled++;
    }
    return result;
  });
}
