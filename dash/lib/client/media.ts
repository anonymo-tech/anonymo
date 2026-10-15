import type { ClientOptions } from './workspace.ts';

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
export type MediaPrivacy = {
  level: 'unverified';
  provider: 'gateway';
  plaintextVisibility: 'gateway_and_upstream';
  retentionDisclosure: string;
};
export type MediaCapability = {
  configured: boolean;
  reason:
    | 'MEDIA_CONFIGURED'
    | 'MEDIA_CONFIGURATION_REQUIRED'
    | 'MEDIA_STORAGE_REQUIRED';
  storageReady: boolean;
  supportedModalities: ('image' | 'video')[];
  referenceUploads: false;
  providerCancellation: false;
  deliveryReady: boolean;
};
export type MediaRoute = {
  versionId: string;
  routeId: string;
  version: number;
  modelId: string;
  family: string;
  modality: 'image' | 'video';
  expiresAt: string;
  privacy: MediaPrivacy;
  pricing: {
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
};
export type MediaQuoteRequest = {
  projectId: string;
  routeVersionId: string;
  input: MediaInput;
};
export type MediaQuote = MediaQuoteRequest & {
  id: string;
  modelId: string;
  maximumUsd6: string;
  providerMaximumUsd6: string;
  expiresAt: string;
  privacy: MediaPrivacy;
  mediaAssetState: 'pending_storage';
  deliveryReady: false;
};
export type MediaApproval = Readonly<{
  quoteId: string;
  idempotencyKey: string;
  approvedMaximumUsd6: string;
}>;
export type MediaAsset = {
  id: string;
  contentType: 'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4';
  byteLength: number;
};
export type MediaJob = {
  id: string;
  projectId: string;
  routeVersionId: string;
  modelId: string;
  modality: 'image' | 'video';
  input: MediaInput;
  state:
    | 'queued'
    | 'dispatching'
    | 'polling'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'reconciliation_pending';
  cancelRequested: boolean;
  errorCode: string | null;
  mediaAssetState:
    | 'none'
    | 'pending_storage'
    | 'stored'
    | 'deleted'
    | 'unavailable';
  processingState:
    | 'queued'
    | 'processing'
    | 'retry'
    | 'completed'
    | 'failed'
    | null;
  processingErrorCode: string | null;
  deliveryReady: boolean;
  asset: MediaAsset | null;
  billing: {
    maximumUsd6: string;
    actualUsd6: string | null;
    state:
      | 'held'
      | 'running'
      | 'captured'
      | 'released'
      | 'reconciliation_pending';
  };
  createdAt: string;
  updatedAt: string;
  canRecover: boolean;
};

const uncertain =
  'Read the saved status or recover the approval with its original request key before starting another request.';
export class MediaClientError extends Error {
  readonly code: string;
  readonly status: number;
  /** A paid create may have committed; retain its exact approval and key. */
  readonly outcomeUnknown: boolean;
  constructor(
    code: string,
    message: string,
    status = 0,
    outcomeUnknown = false,
  ) {
    super(message);
    this.name = 'MediaClientError';
    this.code = code;
    this.status = status;
    this.outcomeUnknown = outcomeUnknown;
  }
}
const invalid = (): never => {
  throw new MediaClientError(
    'INVALID_RESPONSE',
    `The media response could not be verified. ${uncertain}`,
  );
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: string[]) {
  const v = object(value);
  if (
    Reflect.ownKeys(v).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(v, key)) ||
    Object.values(Object.getOwnPropertyDescriptors(v)).some(
      (d) => !('value' in d),
    )
  )
    return invalid();
  return v;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    return invalid();
  return value;
}
function id(value: unknown): string {
  const v = text(value, 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      v,
    )
  )
    return invalid();
  return v.toLowerCase();
}
function date(value: unknown): string {
  const v = text(value, 24),
    time = Date.parse(v);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) ||
    !Number.isFinite(time) ||
    new Date(time).toISOString() !== v
  )
    return invalid();
  return v;
}
function amount(
  value: unknown,
  zero = false,
  max = 9_000_000_000_000_000n,
): string {
  const v = text(value, 16);
  if (
    !/^(0|[1-9][0-9]{0,15})$/.test(v) ||
    BigInt(v) > max ||
    BigInt(v) < (zero ? 0n : 1n)
  )
    return invalid();
  return v;
}
function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    return invalid();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') return invalid();
  return value;
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) return invalid();
  return value as T;
}
function nullable<T>(value: unknown, parse: (v: unknown) => T): T | null {
  return value === null ? null : parse(value);
}
function list<T>(value: unknown, max: number, parse: (v: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) return invalid();
  return value.map(parse);
}
function unique<T>(values: T[], key: (v: T) => string): T[] {
  if (new Set(values.map(key)).size !== values.length) return invalid();
  return values;
}
function code(value: unknown) {
  const v = text(value, 80);
  if (!/^[A-Z_]{1,80}$/.test(v)) return invalid();
  return v;
}
function cursor(value: unknown) {
  const v = text(value, 512);
  if (!/^[A-Za-z0-9_-]+$/.test(v)) return invalid();
  return v;
}
const models = {
  'nano-banana-2': { family: 'image', modality: 'image' },
  'runway-gen4': { family: 'runway', modality: 'video' },
  'veo3-fast': { family: 'veo', modality: 'video' },
  'kling-2.5-turbo': { family: 'kling', modality: 'video' },
} as const;
function model(value: unknown): keyof typeof models {
  return oneOf(value, Object.keys(models) as (keyof typeof models)[]);
}

export function parseMediaOptions(
  value: unknown,
  modelId?: string,
): MediaOptions {
  const kind = object(value).kind;
  const v = exact(
    value,
    kind === 'image'
      ? ['kind', 'count', 'resolution', 'aspectRatio']
      : ['kind', 'duration', 'quality', 'aspectRatio'],
  );
  const aspectRatio = oneOf(v.aspectRatio, ['1:1', '16:9', '9:16']);
  let result: MediaOptions;
  if (kind === 'image') {
    if (v.count !== 1) return invalid();
    result = {
      kind,
      count: 1,
      resolution: oneOf(v.resolution, ['1K', '2K', '4K']),
      aspectRatio,
    };
  } else {
    if (
      kind !== 'video' ||
      typeof v.duration !== 'number' ||
      ![5, 8, 10].includes(v.duration)
    )
      return invalid();
    result = {
      kind,
      duration: v.duration as 5 | 8 | 10,
      quality: oneOf(v.quality, ['720p', '1080p', 'standard']),
      aspectRatio,
    };
  }
  if (modelId !== undefined) {
    const selected = model(modelId);
    if (models[selected].modality !== result.kind) return invalid();
    if (result.kind === 'video') {
      const valid =
        selected === 'runway-gen4'
          ? result.aspectRatio !== '1:1' &&
            [5, 10].includes(result.duration) &&
            ['720p', '1080p'].includes(result.quality) &&
            (result.quality !== '1080p' || result.duration === 5)
          : selected === 'veo3-fast'
            ? result.duration === 8 &&
              result.quality === 'standard' &&
              result.aspectRatio !== '1:1'
            : selected === 'kling-2.5-turbo' &&
              [5, 10].includes(result.duration) &&
              result.quality === 'standard';
      if (!valid) return invalid();
    }
  }
  return result;
}
export function parseMediaInput(value: unknown, modelId?: string): MediaInput {
  const v = exact(value, ['prompt', 'privacy', 'options']),
    prompt = text(v.prompt, 16000);
  if (
    v.privacy !== 'standard' ||
    new TextEncoder().encode(prompt).byteLength > 16000 ||
    Array.from(prompt).some(
      (c) =>
        (c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0))) ||
        c.charCodeAt(0) === 127,
    )
  )
    return invalid();
  return {
    prompt,
    privacy: 'standard',
    options: parseMediaOptions(v.options, modelId),
  };
}
function privacy(value: unknown): MediaPrivacy {
  const v = object(value);
  if (
    v.level !== 'unverified' ||
    v.provider !== 'gateway' ||
    v.plaintextVisibility !== 'gateway_and_upstream'
  )
    return invalid();
  return {
    level: 'unverified',
    provider: 'gateway',
    plaintextVisibility: 'gateway_and_upstream',
    retentionDisclosure: text(v.retentionDisclosure, 8000),
  };
}
export function parseMediaCapability(value: unknown): MediaCapability {
  const v = object(value);
  const result: MediaCapability = {
    configured: bool(v.configured),
    reason: oneOf(v.reason, [
      'MEDIA_CONFIGURED',
      'MEDIA_CONFIGURATION_REQUIRED',
      'MEDIA_STORAGE_REQUIRED',
    ]),
    storageReady: bool(v.storageReady),
    supportedModalities: unique(
      list(v.supportedModalities, 2, (m) => oneOf(m, ['image', 'video'])),
      (m) => m,
    ),
    referenceUploads: false,
    providerCancellation: false,
    deliveryReady: bool(v.deliveryReady),
  };
  if (
    v.referenceUploads !== false ||
    v.providerCancellation !== false ||
    result.supportedModalities.length !== 2 ||
    result.configured !== (result.reason === 'MEDIA_CONFIGURED') ||
    (result.configured && !result.storageReady)
  )
    return invalid();
  return result;
}
export function parseMediaRoute(value: unknown): MediaRoute {
  const v = object(value),
    modelId = model(v.modelId),
    p = exact(v.pricing, ['kind', 'maxInputBytes', 'markupBps', 'variants']);
  if (
    v.family !== models[modelId].family ||
    v.modality !== models[modelId].modality ||
    p.kind !== 'media-fixed-v1'
  )
    return invalid();
  const markupBps = integer(p.markupBps, 0, 10000);
  const variants = unique(
    list(p.variants, 32, (value) => {
      const item = exact(value, [
          'options',
          'providerUsd6',
          'catalogQuality',
          'catalogSize',
        ]),
        options = parseMediaOptions(item.options, modelId);
      const providerUsd6 = amount(item.providerUsd6, false);
      if (
        item.catalogQuality !==
          (options.kind === 'image' ? 'standard' : options.quality) ||
        item.catalogSize !==
          (options.kind === 'image'
            ? options.resolution
            : `${options.aspectRatio}_${options.duration}`) ||
        (BigInt(providerUsd6) * BigInt(10000 + markupBps) + 9999n) / 10000n >
          9_000_000_000_000_000n
      )
        return invalid();
      return {
        options,
        providerUsd6,
        catalogQuality: text(item.catalogQuality, 40),
        catalogSize: text(item.catalogSize, 80),
      };
    }),
    (v) => JSON.stringify(v.options),
  );
  if (!variants.length) return invalid();
  return {
    versionId: id(v.versionId),
    routeId: text(v.routeId, 160),
    version: integer(v.version, 1, 2147483647),
    modelId,
    family: models[modelId].family,
    modality: models[modelId].modality,
    expiresAt: date(v.expiresAt),
    privacy: privacy(v.privacy),
    pricing: {
      kind: 'media-fixed-v1',
      maxInputBytes: integer(p.maxInputBytes, 1, 16000),
      markupBps,
      variants,
    },
  };
}
export function parseMediaQuote(
  value: unknown,
  expected?: MediaQuoteRequest,
): MediaQuote {
  const v = object(value),
    modelId = model(v.modelId);
  const result: MediaQuote = {
    id: id(v.id),
    projectId: id(v.projectId),
    routeVersionId: id(v.routeVersionId),
    modelId,
    input: parseMediaInput(v.input, modelId),
    maximumUsd6: amount(v.maximumUsd6, false),
    providerMaximumUsd6: amount(v.providerMaximumUsd6, false),
    expiresAt: date(v.expiresAt),
    privacy: privacy(v.privacy),
    mediaAssetState: 'pending_storage',
    deliveryReady: false,
  };
  if (
    v.mediaAssetState !== 'pending_storage' ||
    v.deliveryReady !== false ||
    BigInt(result.maximumUsd6) < BigInt(result.providerMaximumUsd6) ||
    BigInt(result.maximumUsd6) > 2n * BigInt(result.providerMaximumUsd6)
  )
    return invalid();
  if (
    expected &&
    (result.projectId !== id(expected.projectId) ||
      result.routeVersionId !== id(expected.routeVersionId) ||
      JSON.stringify(result.input) !==
        JSON.stringify(parseMediaInput(expected.input, modelId)))
  )
    return invalid();
  return result;
}
export function makeMediaApproval(
  quote: MediaQuote,
  idempotencyKey: string,
  now = Date.now(),
): MediaApproval {
  const checked = parseMediaQuote(quote);
  if (!Number.isFinite(now) || Date.parse(checked.expiresAt) <= now)
    throw new MediaClientError(
      'QUOTE_EXPIRED',
      'This quote expired. Review a new quote before approving.',
    );
  return Object.freeze(
    parseApproval({
      quoteId: checked.id,
      idempotencyKey,
      approvedMaximumUsd6: checked.maximumUsd6,
    }),
  );
}
function parseApproval(value: unknown): MediaApproval {
  const v = exact(value, ['quoteId', 'idempotencyKey', 'approvedMaximumUsd6']),
    key = text(v.idempotencyKey, 128);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) return invalid();
  return {
    quoteId: id(v.quoteId),
    idempotencyKey: key,
    approvedMaximumUsd6: amount(v.approvedMaximumUsd6, false),
  };
}
export function parseMediaJob(
  value: unknown,
  expected: { id?: string; projectId?: string } = {},
): MediaJob {
  const v = object(value),
    modelId = model(v.modelId),
    billing = object(v.billing);
  const modality = oneOf(v.modality, ['image', 'video']),
    input = parseMediaInput(v.input, modelId);
  const asset = nullable(v.asset, (value): MediaAsset => {
    const a = exact(value, ['id', 'contentType', 'byteLength']);
    const contentType = oneOf(a.contentType, [
      'image/png',
      'image/jpeg',
      'image/webp',
      'video/mp4',
    ]);
    if ((modality === 'video') !== (contentType === 'video/mp4'))
      return invalid();
    return {
      id: id(a.id),
      contentType,
      byteLength: integer(
        a.byteLength,
        1,
        (modality === 'video' ? 100 : 20) * 1048576,
      ),
    };
  });
  const result: MediaJob = {
    id: id(v.id),
    projectId: id(v.projectId),
    routeVersionId: id(v.routeVersionId),
    modelId,
    modality,
    input,
    state: oneOf(v.state, [
      'queued',
      'dispatching',
      'polling',
      'completed',
      'failed',
      'cancelled',
      'reconciliation_pending',
    ]),
    cancelRequested: bool(v.cancelRequested),
    errorCode: nullable(v.errorCode, code),
    mediaAssetState: oneOf(v.mediaAssetState, [
      'none',
      'pending_storage',
      'stored',
      'deleted',
      'unavailable',
    ]),
    processingState: nullable(v.processingState, (s) =>
      oneOf(s, ['queued', 'processing', 'retry', 'completed', 'failed']),
    ),
    processingErrorCode: nullable(v.processingErrorCode, code),
    deliveryReady: bool(v.deliveryReady),
    asset,
    billing: {
      maximumUsd6: amount(billing.maximumUsd6, false),
      actualUsd6: nullable(billing.actualUsd6, (m) => amount(m, true)),
      state: oneOf(billing.state, [
        'held',
        'running',
        'captured',
        'released',
        'reconciliation_pending',
      ]),
    },
    createdAt: date(v.createdAt),
    updatedAt: date(v.updatedAt),
    canRecover: bool(v.canRecover),
  };
  if (
    modality !== input.options.kind ||
    Date.parse(result.updatedAt) < Date.parse(result.createdAt) ||
    (expected.id && result.id !== id(expected.id)) ||
    (expected.projectId && result.projectId !== id(expected.projectId)) ||
    (result.canRecover && result.state !== 'reconciliation_pending') ||
    (asset !== null && result.mediaAssetState !== 'stored') ||
    (result.deliveryReady && (!asset || result.mediaAssetState !== 'stored')) ||
    ['captured', 'released'].includes(result.billing.state) !==
      (result.billing.actualUsd6 !== null) ||
    (result.billing.state === 'released' &&
      result.billing.actualUsd6 !== '0') ||
    (result.billing.state === 'captured' &&
      result.billing.actualUsd6 === '0') ||
    (result.billing.actualUsd6 !== null &&
      BigInt(result.billing.actualUsd6) > BigInt(result.billing.maximumUsd6))
  )
    return invalid();
  return result;
}
/** Relative same-origin URL with an explicit account fence; never consumes a provider URL or token. */
export function mediaAssetUrl(
  assetId: string,
  accountId: string,
  options: { download?: boolean } = {},
): string {
  if (options.download !== undefined && typeof options.download !== 'boolean')
    return invalid();
  const query = new URLSearchParams({
    accountId: id(accountId),
    ...(options.download ? { download: '1' } : {}),
  });
  return `/api/media/assets/${id(assetId)}/content?${query}`;
}
const messages: Record<string, string> = {
  SESSION_REQUIRED: 'Sign in again to access your Studio.',
  ACCOUNT_CHANGED: 'The signed-in account changed. Refresh the Studio.',
  MEDIA_CONFIGURATION_REQUIRED:
    'Media generation is not configured. Existing saved work remains available.',
  MEDIA_STORAGE_REQUIRED: 'Media generation needs configured asset storage.',
  MEDIA_ROUTE_UNAVAILABLE:
    'This media route is unavailable or expired. Refresh the models.',
  MEDIA_REVIEW_REQUIRED:
    'This model requires a current terms and privacy review.',
  MEDIA_STORAGE_LIMIT: 'Media storage is full. No new job was reserved.',
  MEDIA_JOB_LIMIT: 'Finish or reconcile current jobs before starting more.',
  MEDIA_RECOVERY_UNAVAILABLE:
    'No safe lookup remains. Operator reconciliation is required; do not resubmit generation.',
  INSUFFICIENT_FUNDS:
    'There is not enough available balance to reserve this request.',
  INSUFFICIENT_BALANCE:
    'There is not enough available balance to reserve this request.',
  QUOTE_EXPIRED: 'This quote expired. Review a new quote before approving.',
  SENSITIVE_CONTENT:
    'Remove or redact detected secrets before requesting a quote.',
  IDEMPOTENCY_CONFLICT:
    'This key has different saved terms. Read the saved status before continuing.',
  MEDIA_APPROVAL_MISMATCH: 'The approved amount does not match the quote.',
};
export function mediaErrorMessage(error: unknown): string {
  return error instanceof MediaClientError
    ? error.message
    : `The media request did not complete. ${uncertain}`;
}

/** Account-bound, same-origin requests. No persistence, automatic retry or automatic paid submission. */
export function createMediaClient(
  accountId: string,
  options: Omit<ClientOptions, 'accountId'> & { timeoutMs?: number } = {},
) {
  const owner = id(accountId),
    fetcher = options.fetch ?? globalThis.fetch,
    signal = options.signal;
  const timeoutMs = integer(options.timeoutMs ?? 30000, 1, 60000);
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    maximumBytes = 1048576,
  ): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetcher(`/api/media/${path}`, {
        method,
        credentials: 'same-origin',
        mode: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'X-Conclave-Account-Id': owner,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      controller.signal.throwIfAborted();
      const max = response.ok ? maximumBytes : 65536;
      if (!response.body) return invalid();
      if (
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get('content-type') ?? '',
        )
      ) {
        await response.body.cancel().catch(() => {});
        return invalid();
      }
      if (Number(response.headers.get('content-length') ?? 0) > max) {
        await response.body.cancel();
        throw new MediaClientError(
          'RESPONSE_TOO_LARGE',
          `The media response exceeded this view's limit. ${uncertain}`,
        );
      }
      const reader = response.body.getReader(),
        decoder = new TextDecoder('utf-8', { fatal: true });
      let size = 0,
        data = '';
      const cancelRead = () => {
        void reader.cancel().catch(() => {});
      };
      controller.signal.addEventListener('abort', cancelRead, { once: true });
      try {
        while (true) {
          controller.signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > max)
            throw new MediaClientError(
              'RESPONSE_TOO_LARGE',
              `The media response exceeded this view's limit. ${uncertain}`,
            );
          data += decoder.decode(chunk.value, { stream: true });
        }
        controller.signal.throwIfAborted();
        let parsed: Record<string, unknown>;
        try {
          parsed = object(JSON.parse(data + decoder.decode()));
        } catch {
          return invalid();
        }
        if (!response.ok) {
          const inner =
            parsed.error &&
            typeof parsed.error === 'object' &&
            !Array.isArray(parsed.error)
              ? (parsed.error as Record<string, unknown>)
              : {};
          const raw = inner.code ?? parsed.code;
          const errorCode =
            typeof raw === 'string' && /^[A-Z_]{1,80}$/.test(raw)
              ? raw
              : 'REQUEST_FAILED';
          throw new MediaClientError(
            errorCode,
            response.status === 401
              ? 'Sign in again to access your Studio.'
              : response.status === 429
                ? 'Too many requests. Wait a moment before continuing.'
                : (messages[errorCode] ??
                  `The media request did not complete. ${uncertain}`),
            response.status,
          );
        }
        return parsed;
      } finally {
        controller.signal.removeEventListener('abort', cancelRead);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch (error) {
      if (timedOut && !signal?.aborted)
        throw new MediaClientError(
          'REQUEST_TIMEOUT',
          `The media request timed out. ${uncertain}`,
        );
      if (signal?.aborted)
        throw new DOMException(
          'The media request was cancelled.',
          'AbortError',
        );
      if (error instanceof MediaClientError) throw error;
      throw new MediaClientError(
        'NETWORK_ERROR',
        `The media service could not be reached. ${uncertain}`,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  return {
    async capabilities() {
      return parseMediaCapability(
        await request('capabilities', 'GET', undefined, 16384),
      );
    },
    async routes() {
      const r = await request('routes', 'GET', undefined, 4194304);
      return unique(list(r.routes, 256, parseMediaRoute), (r) => r.versionId);
    },
    async quote(value: MediaQuoteRequest): Promise<MediaQuote> {
      const v = exact(value, ['projectId', 'routeVersionId', 'input']);
      const input = {
        projectId: id(v.projectId),
        routeVersionId: id(v.routeVersionId),
        input: parseMediaInput(v.input),
      };
      return parseMediaQuote(
        (await request('quotes', 'POST', input, 131072)).quote,
        input,
      );
    },
    async create(
      value: MediaApproval,
    ): Promise<{ job: MediaJob; replayed: boolean }> {
      const approval = parseApproval(value);
      try {
        const r = await request('jobs', 'POST', approval, 131072),
          job = parseMediaJob(r.job),
          replayed = bool(r.replayed);
        if (job.billing.maximumUsd6 !== approval.approvedMaximumUsd6)
          return invalid();
        return { job, replayed };
      } catch (error) {
        const knownRejection =
          error instanceof MediaClientError &&
          error.status >= 400 &&
          error.status < 500;
        if (knownRejection) throw error;
        throw new MediaClientError(
          error instanceof MediaClientError
            ? error.code
            : 'REQUEST_INTERRUPTED',
          `The approval outcome is unknown. ${uncertain}`,
          error instanceof MediaClientError ? error.status : 0,
          true,
        );
      }
    },
    async list(projectId: string, after?: string | null) {
      const project = id(projectId),
        query = new URLSearchParams({
          projectId: project,
          ...(after == null ? {} : { cursor: cursor(after) }),
        });
      const r = await request(`jobs?${query}`, 'GET', undefined, 2097152);
      return {
        jobs: unique(
          list(r.jobs, 20, (job) => parseMediaJob(job, { projectId: project })),
          (job) => job.id,
        ),
        nextCursor: nullable(r.nextCursor, cursor),
      };
    },
    async get(jobId: string) {
      const target = id(jobId);
      return parseMediaJob(
        (await request(`jobs/${target}`, 'GET', undefined, 131072)).job,
        { id: target },
      );
    },
    async deleteAsset(assetId: string) {
      const target = id(assetId);
      const response = await request(
        `assets/${target}`,
        'DELETE',
        undefined,
        16384,
      );
      const asset = exact(response.asset, ['id', 'state']);
      if (id(asset.id) !== target || asset.state !== 'deleted')
        return invalid();
      return { asset: { id: target, state: 'deleted' as const } };
    },
    async cancel(jobId: string) {
      const target = id(jobId),
        r = await request(`jobs/${target}/cancel`, 'POST', {}, 131072);
      if (r.providerCancellation !== false) return invalid();
      return {
        job: parseMediaJob(r.job, { id: target }),
        providerCancellation: false as const,
      };
    },
    async recover(jobId: string) {
      const target = id(jobId),
        r = await request(`jobs/${target}/recover`, 'POST', {}, 131072);
      if (r.scheduled !== true || r.paidResubmission !== false)
        return invalid();
      return {
        job: parseMediaJob(r.job, { id: target }),
        scheduled: true as const,
        paidResubmission: false as const,
      };
    },
  };
}

export type MediaClient = ReturnType<typeof createMediaClient>;
