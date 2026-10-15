import { parseRoutingProfile } from '../../lib/model-routing.ts';

/**
 * Public metadata only. Never apply this projection to prompts, model output,
 * signed receipts, persisted route terms, pricing calculations, or audit records.
 */
function metadataText(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return value
    .replace(
      /(?:https?:\/\/)?(?:[a-z0-9-]+\.)*ppq\.ai(?:[^\s<>"')\]]*)?/gi,
      'the inference gateway',
    )
    .replace(/ppq/gi, 'inference gateway');
}

/** An unpublished reference is empty, never a fabricated or redirected source. */
function publicEvidenceUrl(value: unknown): string {
  if (typeof value !== 'string' || /ppq/i.test(value)) return '';
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) return '';
    return url.toString();
  } catch {
    return '';
  }
}

/** Do not spread the stored card: it also contains internal catalog evidence. */
export function publicRouteCard(value: unknown) {
  const card = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const routing = card.routing === undefined
    ? undefined
    : parseRoutingProfile(card.routing);
  return {
    level: metadataText(card.level, 'unverified'),
    reviewed: card.reviewed === true,
    provider: 'gateway' as const,
    upstreamProviders: Array.isArray(card.upstreamProviders)
      ? card.upstreamProviders.filter((name) => typeof name === 'string').map((name) => metadataText(name))
      : [],
    plaintextVisibility: metadataText(card.plaintextVisibility, 'unknown'),
    retentionDays: typeof card.retentionDays === 'number' ? card.retentionDays : null,
    trainingUse: metadataText(card.trainingUse, 'unknown'),
    jurisdiction: card.jurisdiction === null || card.jurisdiction === undefined
      ? null
      : metadataText(card.jurisdiction),
    legalHold: metadataText(card.legalHold, 'unknown'),
    retentionDisclosure: metadataText(card.retentionDisclosure),
    evidenceUrl: publicEvidenceUrl(card.evidenceUrl),
    upstreamEvidenceUrls: Array.isArray(card.upstreamEvidenceUrls)
      ? card.upstreamEvidenceUrls.map(publicEvidenceUrl).filter(Boolean)
      : [],
    evidenceDate: metadataText(card.evidenceDate),
    lastVerifiedAt: metadataText(card.lastVerifiedAt),
    ...(routing === undefined ? {} : {
      routing: {
        version: routing.version,
        tasks: [...routing.tasks],
        reviewedAt: routing.reviewedAt,
        evidenceUrl: publicEvidenceUrl(routing.evidenceUrl),
      },
    }),
  };
}

type ListedRoute = {
  versionId: string;
  version: number;
  modelId: string;
  family: string;
  modality: string;
  available: boolean;
  expiresAt: Date | string;
  card: unknown;
  pricing: {
    inputPerMillionUsd6: string;
    outputPerMillionUsd6: string;
    markupBps: number;
    maxOutputTokens: number;
    maxInputBytes: number;
    maxReasoningTokens?: number;
  };
};

/** Version UUIDs still select the exact reviewed route for every request. */
export function publicListedRoute(route: ListedRoute) {
  // Registry-controlled model identifiers are retained exactly, never aliased.
  if (/ppq/i.test(route.modelId) || !/^[a-z][a-z0-9-]{0,39}$/.test(route.family) || /ppq/i.test(route.family))
    throw new Error('INVALID_PUBLIC_ROUTE_IDENTITY');
  return {
    versionId: route.versionId,
    id: `${route.family}-standard-${route.versionId}`,
    version: route.version,
    modelId: route.modelId,
    family: route.family,
    modality: route.modality,
    available: route.available,
    expiresAt: route.expiresAt,
    card: publicRouteCard(route.card),
    pricing: {
      inputPerMillionUsd6: route.pricing.inputPerMillionUsd6,
      outputPerMillionUsd6: route.pricing.outputPerMillionUsd6,
      markupBps: route.pricing.markupBps,
      maxOutputTokens: route.pricing.maxOutputTokens,
      maxInputBytes: route.pricing.maxInputBytes,
      ...(route.pricing.maxReasoningTokens === undefined
        ? {}
        : { maxReasoningTokens: route.pricing.maxReasoningTokens }),
    },
  };
}

const gatewayErrors: Readonly<Record<string, string>> = Object.freeze({
  PPQ_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PPQ_INVALID_REQUEST: 'PROVIDER_INVALID_REQUEST',
  PPQ_PRIVACY_UNAVAILABLE: 'PROVIDER_PRIVACY_UNAVAILABLE',
  PPQ_AUTHENTICATION: 'PROVIDER_AUTHENTICATION',
  PPQ_INSUFFICIENT_CREDIT: 'PROVIDER_INSUFFICIENT_CREDIT',
  PPQ_CONFLICT: 'PROVIDER_CONFLICT',
  PPQ_NOT_FOUND: 'PROVIDER_NOT_FOUND',
  PPQ_PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PPQ_TIMEOUT: 'PROVIDER_TIMEOUT',
  PPQ_CANCELLED: 'PROVIDER_CANCELLED',
  PPQ_INVALID_RESPONSE: 'PROVIDER_INVALID_RESPONSE',
  PPQ_RESPONSE_TOO_LARGE: 'PROVIDER_RESPONSE_TOO_LARGE',
  PPQ_STREAM_INTERRUPTED: 'PROVIDER_STREAM_INTERRUPTED',
  PPQ_GENERATION_FAILED: 'PROVIDER_GENERATION_FAILED',
});

/** Translate persisted gateway error labels only; status and settlement do not change. */
export function publicInferenceErrorCode(value: string | null): string | null {
  if (value === null) return null;
  if (Object.hasOwn(gatewayErrors, value)) return gatewayErrors[value];
  return /^[A-Z][A-Z0-9_]{0,99}$/.test(value) && !/ppq/i.test(value)
    ? value
    : 'REQUEST_FAILED';
}
