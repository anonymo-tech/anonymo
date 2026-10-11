import {
  gatewayCatalogUrl,
  gatewayConfigured,
  gatewayEvidenceUrl,
} from '../gateway/origin.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';
import { serviceConfig } from '../core/config.ts';
import { configuredKeyring } from '../core/encryption.ts';
import { digestText } from '../core/digest.ts';
import { usd6, ceilRatio } from '../ledger/money.ts';
import { GATEWAY_MODEL_ALLOWLIST, validateModel } from '../gateway/catalog.ts';
import { scanPrompt } from '../../lib/guards/index.ts';
import { uuidField } from '../core/http.ts';
import type { MediaStoragePolicy } from './assets.ts';

export type MediaOptions =
  | {
      kind: 'image';
      count: 1;
      resolution: '1K' | '2K' | '4K';
      aspectRatio: '1:1' | '16:9' | '9:16';
    }
  | {
      kind: 'video';
      duration: 5 | 8 | 10;
      quality: '720p' | '1080p' | 'standard';
      aspectRatio: '1:1' | '16:9' | '9:16';
    };
export type MediaInput = {
  prompt: string;
  privacy: 'standard';
  options: MediaOptions;
};
export type MediaPricing = {
  kind: 'media-fixed-v1';
  maxInputBytes: number;
  markupBps: number;
  variants: {
    options: MediaOptions;
    providerUsd6: string;
    catalogQuality: string;
    catalogSize: string;
  }[];
};
export type MediaRoute = {
  id: string;
  route_id: string;
  version: number;
  model_id: string;
  family: string;
  modality: 'image' | 'video';
  enabled: boolean;
  expires_at: Date;
  card: Record<string, unknown>;
  pricing: MediaPricing;
};
export type MediaRuntimeOptions = {
  env?: Record<string, string | undefined>;
  /** Trusted server integration only. Runtime stays false until a real storage importer is wired. */
  storageReady?: boolean;
  /** Trusted server capacity policy, never accepted from a request body. */
  storagePolicy?: MediaStoragePolicy;
};
const day = 86_400_000;

export function exactMediaObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  requireCondition(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    400,
    'INVALID_MEDIA_REQUEST',
    'A media request object is required.',
  );
  const object = value as Record<string, unknown>;
  requireCondition(
    Reflect.ownKeys(object).length === keys.length &&
      keys.every((key) => Object.hasOwn(object, key)) &&
      Object.values(Object.getOwnPropertyDescriptors(object)).every(
        (d) => 'value' in d,
      ),
    400,
    'INVALID_MEDIA_REQUEST',
    'Only the documented media fields are accepted.',
  );
  return object;
}

export function parseMediaOptions(
  value: unknown,
  modelId?: string,
): MediaOptions {
  const kind =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>).kind
      : null;
  const object = exactMediaObject(
    value,
    kind === 'image'
      ? ['kind', 'count', 'resolution', 'aspectRatio']
      : ['kind', 'duration', 'quality', 'aspectRatio'],
  );
  requireCondition(
    typeof object.aspectRatio === 'string' &&
      ['1:1', '16:9', '9:16'].includes(object.aspectRatio),
    400,
    'INVALID_MEDIA_OPTIONS',
    'This aspect ratio is unsupported.',
  );
  let options: MediaOptions;
  if (kind === 'image') {
    requireCondition(
      object.count === 1 &&
        typeof object.resolution === 'string' &&
        ['1K', '2K', '4K'].includes(object.resolution),
      400,
      'INVALID_MEDIA_OPTIONS',
      'Choose one image at a supported resolution.',
    );
    options = {
      kind,
      count: 1,
      resolution: object.resolution as '1K',
      aspectRatio: object.aspectRatio as '1:1',
    };
  } else {
    requireCondition(
      kind === 'video' &&
        [5, 8, 10].includes(Number(object.duration)) &&
        typeof object.duration === 'number' &&
        typeof object.quality === 'string' &&
        ['720p', '1080p', 'standard'].includes(object.quality),
      400,
      'INVALID_MEDIA_OPTIONS',
      'Choose supported video options.',
    );
    options = {
      kind: 'video',
      duration: object.duration as 5,
      quality: object.quality as 'standard',
      aspectRatio: object.aspectRatio as '1:1',
    };
  }
  if (modelId) {
    try {
      validateModel(modelId, options.kind, 'standard');
    } catch {
      throw new ServiceError(
        409,
        'MEDIA_ROUTE_UNAVAILABLE',
        'This media model is unavailable.',
      );
    }
    if (options.kind === 'video') {
      const valid =
        modelId === 'runway-gen4'
          ? options.aspectRatio !== '1:1' &&
            [5, 10].includes(options.duration) &&
            ['720p', '1080p'].includes(options.quality) &&
            (options.quality !== '1080p' || options.duration === 5)
          : modelId === 'veo3-fast'
            ? options.duration === 8 &&
              options.quality === 'standard' &&
              options.aspectRatio !== '1:1'
            : modelId === 'kling-2.5-turbo' &&
              [5, 10].includes(options.duration) &&
              options.quality === 'standard';
      requireCondition(
        valid,
        400,
        'INVALID_MEDIA_OPTIONS',
        'These options are not supported by the selected model.',
      );
    }
  }
  return options;
}

export function parseMediaInput(value: unknown): MediaInput {
  const input = exactMediaObject(value, ['prompt', 'privacy', 'options']);
  requireCondition(
    input.privacy === 'standard',
    409,
    'PRIVACY_ROUTE_UNAVAILABLE',
    'Verified private media generation is unavailable.',
  );
  requireCondition(
    typeof input.prompt === 'string' &&
      input.prompt.trim().length > 0 &&
      new TextEncoder().encode(input.prompt).byteLength <= 16000,
    413,
    'MEDIA_INPUT_TOO_LARGE',
    'Use a nonempty description of at most 16,000 UTF-8 bytes.',
  );
  requireCondition(
    !Array.from(input.prompt).some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    }),
    400,
    'INVALID_MEDIA_TEXT',
    'Descriptions may contain ordinary text, tabs and line breaks, without other control characters.',
  );
  requireCondition(
    !scanPrompt(input.prompt).findings.some(
      (finding) => finding.severity === 'block',
    ),
    422,
    'SENSITIVE_CONTENT',
    'Remove sensitive content before continuing.',
  );
  return {
    prompt: input.prompt,
    privacy: 'standard',
    options: parseMediaOptions(input.options),
  };
}

export function validateMediaPricing(
  value: unknown,
  modelId: string,
): MediaPricing {
  const p = exactMediaObject(value, [
    'kind',
    'maxInputBytes',
    'markupBps',
    'variants',
  ]);
  requireCondition(
    p.kind === 'media-fixed-v1' &&
      Number.isSafeInteger(p.maxInputBytes) &&
      Number(p.maxInputBytes) >= 1 &&
      Number(p.maxInputBytes) <= 16000 &&
      Number.isSafeInteger(p.markupBps) &&
      Number(p.markupBps) >= 0 &&
      Number(p.markupBps) <= 10000 &&
      Array.isArray(p.variants) &&
      p.variants.length >= 1 &&
      p.variants.length <= 32,
    409,
    'MEDIA_PRICING_UNAVAILABLE',
    'Reviewed media pricing is unavailable.',
  );
  const variants = (p.variants as unknown[]).map((raw) => {
    const v = exactMediaObject(raw, [
      'options',
      'providerUsd6',
      'catalogQuality',
      'catalogSize',
    ]);
    const options = parseMediaOptions(v.options, modelId);
    requireCondition(
      typeof v.catalogQuality === 'string' &&
        v.catalogQuality.length >= 1 &&
        v.catalogQuality.length <= 40 &&
        typeof v.catalogSize === 'string' &&
        v.catalogSize.length >= 1 &&
        v.catalogSize.length <= 80,
      409,
      'MEDIA_PRICING_UNAVAILABLE',
      'Each option requires exact reviewed catalog evidence.',
    );
    requireCondition(
      v.catalogQuality ===
        (options.kind === 'image' ? 'standard' : options.quality) &&
        v.catalogSize ===
          (options.kind === 'image'
            ? options.resolution
            : `${options.aspectRatio}_${options.duration}`),
      409,
      'MEDIA_PRICING_UNAVAILABLE',
      'The catalog variant does not match these media options.',
    );
    const providerUsd6 = usd6(v.providerUsd6).toString();
    requireCondition(
      ceilRatio(
        BigInt(providerUsd6) * BigInt(10000 + Number(p.markupBps)),
        10000n,
      ) <= 10_000_000n,
      409,
      'MEDIA_BUDGET_EXCEEDED',
      'This media option exceeds the supported budget.',
    );
    return {
      options,
      providerUsd6,
      catalogQuality: v.catalogQuality,
      catalogSize: v.catalogSize,
    };
  });
  requireCondition(
    new Set(variants.map((v) => JSON.stringify(v.options))).size ===
      variants.length,
    409,
    'MEDIA_PRICING_UNAVAILABLE',
    'Media option prices must be unique.',
  );
  return {
    kind: 'media-fixed-v1',
    maxInputBytes: Number(p.maxInputBytes),
    markupBps: Number(p.markupBps),
    variants,
  };
}

function freshDate(value: unknown, now: number): number | null {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  )
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) &&
    time <= now &&
    now - time <= day &&
    new Date(time).toISOString() === value
    ? time
    : null;
}
function evidenceUrl(value: unknown): boolean {
  try {
    const u = new URL(String(value));
    return (
      typeof value === 'string' &&
      value.length <= 2048 &&
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.hash
    );
  } catch {
    return false;
  }
}

export function assertUsableMediaRoute(
  route: MediaRoute | null,
  now = Date.now(),
): asserts route is MediaRoute {
  requireCondition(
    route &&
      route.enabled &&
      ['image', 'video'].includes(route.modality) &&
      route.expires_at instanceof Date &&
      route.expires_at.getTime() > now,
    409,
    'MEDIA_ROUTE_UNAVAILABLE',
    'This media route is unavailable or expired.',
  );
  const allowed = Object.entries(GATEWAY_MODEL_ALLOWLIST).find(
    ([family, model]) =>
      family === route.family &&
      model.id === route.model_id &&
      model.modality === route.modality,
  );
  requireCondition(
    allowed,
    409,
    'MEDIA_ROUTE_UNAVAILABLE',
    'This media route is unsupported.',
  );
  const card = route.card;
  requireCondition(
    card &&
      card.level === 'unverified' &&
      card.reviewed === true &&
      card.provider === 'gateway' &&
      card.plaintextVisibility === 'gateway_and_upstream' &&
      typeof card.retentionDisclosure === 'string' &&
      card.retentionDisclosure.length >= 20 &&
      gatewayEvidenceUrl(card.evidenceUrl),
    409,
    'MEDIA_REVIEW_REQUIRED',
    'This media route requires a current review.',
  );
  const reviewed = freshDate(card.lastVerifiedAt, now),
    catalog = card.catalogVerification as Record<string, unknown> | undefined,
    terms = card.mediaTerms as Record<string, unknown> | undefined;
  const catalogTime = freshDate(catalog?.fetchedAt, now),
    termsTime = freshDate(terms?.reviewedAt, now);
  requireCondition(
    reviewed !== null &&
      catalogTime !== null &&
      termsTime !== null &&
      route.expires_at.getTime() <=
        Math.min(reviewed, catalogTime, termsTime) + day &&
      gatewayCatalogUrl() !== null &&
      catalog?.sourceUrl === gatewayCatalogUrl() &&
      catalog.priceCheck === 'matched' &&
      typeof catalog.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(catalog.sha256) &&
      terms?.reviewed === true &&
      terms.commercialUse === 'allowed' &&
      Array.isArray(terms.evidenceUrls) &&
      terms.evidenceUrls.length >= 1 &&
      terms.evidenceUrls.length <= 8 &&
      terms.evidenceUrls.every(evidenceUrl) &&
      terms.evidenceUrls.some((value) => gatewayEvidenceUrl(value)),
    409,
    'MEDIA_REVIEW_REQUIRED',
    'Current terms and exact catalog pricing must be reviewed.',
  );
  validateMediaPricing(route.pricing, route.model_id);
}

export function mediaQuoteAmount(route: MediaRoute, input: MediaInput) {
  const pricing = validateMediaPricing(route.pricing, route.model_id),
    options = parseMediaOptions(input.options, route.model_id);
  requireCondition(
    new TextEncoder().encode(input.prompt).byteLength <= pricing.maxInputBytes,
    413,
    'MEDIA_INPUT_TOO_LARGE',
    'This description exceeds the reviewed route limit.',
  );
  const variant = pricing.variants.find(
    (v) => JSON.stringify(v.options) === JSON.stringify(options),
  );
  requireCondition(
    variant,
    409,
    'MEDIA_OPTION_UNAVAILABLE',
    'These exact options have no reviewed price.',
  );
  return {
    providerUsd6: variant.providerUsd6,
    maximumUsd6: ceilRatio(
      BigInt(variant.providerUsd6) * BigInt(10000 + pricing.markupBps),
      10000n,
    ).toString(),
  };
}
export function mediaRequestHash(
  projectId: string,
  routeVersionId: string,
  input: MediaInput,
) {
  projectId = uuidField(projectId).toLowerCase();
  routeVersionId = uuidField(routeVersionId).toLowerCase();
  return digestText(
    'media-request-v1',
    JSON.stringify({ projectId, routeVersionId, input }),
  );
}
/** Configuration for the integrated PostgreSQL store, sanitizer/import worker,
 * and authenticated content route. This is not a database or worker health check. */
export function mediaStorageConfigured(
  env: Record<string, string | undefined> = process.env,
) {
  try {
    const c = serviceConfig(env);
    configuredKeyring(env);
    return c.mode === 'service' && !!c.origin && !!c.databaseUrl;
  } catch {
    return false;
  }
}

export function mediaCapability(
  env: Record<string, string | undefined> = process.env,
  storageReady = false,
) {
  let configured = false,
    reason = 'MEDIA_STORAGE_REQUIRED';
  try {
    const c = serviceConfig(env);
    configuredKeyring(env);
    if (storageReady === true) {
      configured =
        c.mode === 'service' &&
        !!c.origin &&
        !!c.databaseUrl &&
        c.inferenceEnabled &&
        env.CONCLAVE_MEDIA_ENABLED === 'true' &&
        gatewayConfigured(env);
      reason = configured ? 'MEDIA_CONFIGURED' : 'MEDIA_CONFIGURATION_REQUIRED';
    }
  } catch {
    if (storageReady === true) reason = 'MEDIA_CONFIGURATION_REQUIRED';
  }
  return {
    configured,
    reason,
    storageReady: storageReady === true,
    supportedModalities: ['image', 'video'],
    referenceUploads: false,
    providerCancellation: false,
    deliveryReady: storageReady === true && mediaStorageConfigured(env),
  };
}
