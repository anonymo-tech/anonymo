import { CHAT_LIMITS, CHAT_CAPACITY } from '../../lib/chat-limits.ts';
import { randomUUID } from 'node:crypto';
import {
  BASE_CHAT_MODELS,
  releasedChatFamilies,
} from '../../lib/model-release.ts';
import type { Pool } from 'pg';
import { PPQ_MODEL_ALLOWLIST } from '../ppq/catalog.ts';
import {
  fetchRouteCatalog,
  installReviewedRoutes,
  validateRouteCatalog,
  validateRouteReview,
  type RouteCatalogSnapshot,
} from './route-registry.ts';

export const BASELINE_FAMILIES = BASE_CHAT_MODELS;
const lifetime = 24 * 60 * 60 * 1000 - 60_000;
const refreshWindow = 8 * 60 * 60 * 1000;
const requiredFamilies = new Set<string>([...BASE_CHAT_MODELS, 'deepseek', 'qwen', 'llama']);
let lastCatalogRefreshAt = 0;

/** Prices and exact model availability only. No privacy or quality certification. */
export function baselineCatalogDocument(
  catalog: RouteCatalogSnapshot,
  versions: Map<string, number>,
) {
  const at = catalog.fetchedAt;
  const routes = releasedChatFamilies().map((family) => {
    const modelId =
      PPQ_MODEL_ALLOWLIST[family as keyof typeof PPQ_MODEL_ALLOWLIST].id;
    const model = catalog.models.find(
      (row) =>
        row.id === modelId && row.family === family && row.modality === 'chat',
    );
    const input = model?.pricing.inputPerMillionUsd6;
    const output = model?.pricing.outputPerMillionUsd6;
    if (
      !Number.isSafeInteger(input) ||
      !Number.isSafeInteger(output) ||
      input! < 0 ||
      output! < 0
    ) {
      if (requiredFamilies.has(family)) throw new Error('BASELINE_CATALOG_UNAVAILABLE');
      return null;
    }
    return {
      id: randomUUID(),
      routeId: `ppq-${family}`,
      version: (versions.get(family) ?? 0) + 1,
      modelId,
      family,
      modality: 'chat',
      enabled: true,
      expiresAt: new Date(Date.parse(at) + lifetime).toISOString(),
      card: {
        routing: { version: 1, tasks: ['general'], reviewedAt: at, evidenceUrl: 'https://ppq.ai/api-docs' },
        level: 'unverified',
        reviewed: true,
        provider: 'ppq',
        upstreamProviders: [
          'Model host (processor not independently verified)',
        ],
        plaintextVisibility: 'gateway_and_upstream',
        retentionDays: null,
        trainingUse: 'unknown',
        jurisdiction: null,
        legalHold: 'unknown',
        retentionDisclosure:
          'The inference gateway and model host receive your request in plaintext. Retention, training use, jurisdiction and legal holds are unknown. The catalog check verifies model availability and published prices only; it does not verify privacy policies.',
        evidenceUrl: 'https://ppq.ai/pricing',
        upstreamEvidenceUrls: [],
        evidenceDate: at.slice(0, 10),
        lastVerifiedAt: at,
      },
      pricing: {
        inputPerMillionUsd6: String(input),
        outputPerMillionUsd6: String(output),
        ...(model?.pricing.cacheReadPerMillionUsd6 == null ? {} : {cacheReadPerMillionUsd6: String(model.pricing.cacheReadPerMillionUsd6)}),
        markupBps: 0,
        maxOutputTokens: CHAT_CAPACITY[family].outputTokens,
        maxInputBytes: CHAT_LIMITS.inputBytes,
        maxReasoningTokens: CHAT_CAPACITY[family].reasoningTokens,
        contextTokens: model!.contextLength!,
      },
    };
  }).filter((route) => route !== null);
  const document = { version: 1, routes };
  validateRouteCatalog(validateRouteReview(document, at), catalog, at);
  return document;
}

export async function refreshBaselineRoutes(pool: Pool) {
  const families = releasedChatFamilies();
  const { rows } = await pool.query<{
    family: string;
    version: number;
    expires_at: Date;
    card: {routing?:unknown};
    pricing: {maxOutputTokens?:number;maxInputBytes?:number;maxReasoningTokens?:number;contextTokens?:number};
  }>(
    `SELECT DISTINCT ON(route_id) family,version,expires_at,card,pricing FROM route_versions
     WHERE route_id = ANY($1::text[]) ORDER BY route_id,version DESC`,
    [families.map((family) => `ppq-${family}`)],
  );
  if (
    families.every((family) =>
      rows.some(
        (row) =>
          row.family === family && row.card.routing &&
          row.pricing?.maxOutputTokens === CHAT_CAPACITY[family].outputTokens &&
          row.pricing?.maxInputBytes === CHAT_LIMITS.inputBytes &&
          row.pricing?.maxReasoningTokens === CHAT_CAPACITY[family].reasoningTokens &&
          Number.isSafeInteger(row.pricing?.contextTokens) &&
          row.expires_at.getTime() > Date.now() + refreshWindow,
      ),
    )
  )
    return { refreshed: false };
  // A withdrawn optional model must not cause continuous catalog fetches or
  // prevent the core models from refreshing. Retry optional additions in 15m.
  if (Date.now() - lastCatalogRefreshAt < 15 * 60 * 1000 &&
      families.filter(family => requiredFamilies.has(family)).every(family =>
        rows.some(row => row.family === family && row.expires_at.getTime() > Date.now() + refreshWindow)))
    return { refreshed: false };
  const catalog = await fetchRouteCatalog();
  const document = baselineCatalogDocument(
    catalog,
    new Map(rows.map((row) => [row.family, row.version])),
  );
  try {
    const result = await installReviewedRoutes(pool, document, {
      enableReviewed: true,
      catalog,
    });
    lastCatalogRefreshAt = Date.now();
    return { refreshed: true, installed: result.installed };
  } catch (error) {
    // An overlapping rolling-deploy worker may have won the advisory lock.
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ROUTE_VERSION_SEQUENCE'
    )
      return { refreshed: false };
    throw error;
  }
}
