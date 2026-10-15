import { CHAT_LIMITS, CHAT_CAPACITY } from '../../lib/chat-limits.ts';
import {
  cost,
  integer,
  parseProviderJson,
  record,
  usage,
  type PpqUsage,
  type Usd6,
} from './codec.ts';
import { normalizeCatalog, validateModel, PPQ_MODEL_ALLOWLIST, type PpqPrivacy } from './catalog.ts';
import { PpqError } from './errors.ts';
import {
  PPQ_LIMITS,
  readJson,
  readSse,
  transport,
  type Fetcher,
} from './transport.ts';

export {
  PPQ_MODEL_ALLOWLIST,
  modelForFamily,
  normalizeCatalog,
} from './catalog.ts';
export type {
  PpqCatalogModel,
  PpqFamily,
  PpqModality,
  PpqPrivacy,
} from './catalog.ts';
export { PpqError, publicPpqError } from './errors.ts';
export { parseUsd6 } from './codec.ts';
export type { Usd6, PpqUsage } from './codec.ts';

export type PpqOptions = {
  apiKey?: string;
  fetch?: Fetcher;
  /** Approved HTTPS origins of Conclave-owned signed uploads; empty disables references. */
  referenceOrigins?: readonly string[];
  timeouts?: { requestMs?: number; chatMs?: number; imageMs?: number };
};

type RequestContext = {
  privacy?: PpqPrivacy;
  signal?: AbortSignal;
  requestId?: string;
};
export type PpqChatRequest = RequestContext & {
  modelId: string;
  messages: readonly {
    role: 'system' | 'user' | 'assistant';
    content: string;
  }[];
  maxOutputTokens?: number;
  /**
   * Reviewed exact per-token catalog prices (integer USD6 per million tokens).
   * Settlement is provider-cost first, because PPQ's reported cost is what
   * PPQ bills (cache discounts and upstream routing included): (1) a
   * positive `cost`; else (2) a positive `cost_details.upstream_inference_cost`
   * (BYOK routes report `cost` 0); else (3) the reported usage at these
   * prices, with every reasoning token billed at the output rate whether PPQ
   * reports it inside or outside the completion count; else unknown
   * (reconciliation). Amounts round up to the next micro-dollar and a zero is
   * never a confirmed charge. Without pricing, only a provider cost settles.
   */
  pricing?: {
    inputPerMillionUsd6: Usd6 | string;
    outputPerMillionUsd6: Usd6 | string;
    cacheReadPerMillionUsd6?: Usd6 | string;
  };
};
export type PpqChatEvent =
  | { type: 'text'; text: string }
  | { type: 'refusal'; text: string }
  /** The upstream completion ID, emitted once, as soon as a chunk carries it. */
  | { type: 'reference'; providerId: string }
  | {
      type: 'usage';
      usage: PpqUsage | null;
      /** The provider-reported cost so far (a zero is reported as zero). */
      costUsd6: Usd6 | null;
      /** What the stream would settle at if it completed now, or null. */
      settlementUsd6?: Usd6 | null;
    }
  | {
      type: 'done';
      finishReason: 'stop' | 'length' | 'content_filter' | 'other';
      usage: PpqUsage | null;
      /** The canonical charge: the provider cost, else the usage-derived cost. */
      costUsd6: Usd6 | null;
      /** 'provider': PPQ's reported (or BYOK upstream) cost. 'usage': no provider cost; reported usage × reviewed pricing. */
      costSource?: 'provider' | 'usage' | null;
      providerId?: string | null;
      /** Both settlement inputs, kept for audit. */
      usageCostUsd6?: Usd6 | null;
      providerCostUsd6?: Usd6 | null;
    };

export type PpqImageRequest = RequestContext & {
  modelId: string;
  prompt: string;
  clientRequestId: string;
  count?: number;
  resolution?: '1K' | '2K' | '4K';
  aspectRatio?: '1:1' | '16:9' | '9:16';
  imageUrl?: string;
};
export type PpqMedia = {
  url: string;
  contentType: 'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4';
};
export type PpqImageResult = {
  clientRequestId: string;
  modelId: string | null;
  status: 'pending' | 'completed' | 'failed';
  media: PpqMedia[];
  costUsd6: Usd6 | null;
};
export type PpqVideoRequest = RequestContext & {
  modelId: string;
  prompt: string;
  duration: number;
  aspectRatio: '16:9' | '9:16' | '1:1';
  quality: '720p' | '1080p' | 'standard';
  imageUrl?: string;
};
export type PpqVideoJob = {
  id: string;
  modelId: string | null;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  media: PpqMedia | null;
  estimatedCostUsd6: Usd6 | null;
  costUsd6: Usd6 | null;
};

function identifier(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new PpqError('invalid_request');
  return value;
}

function prompt(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 16_000)
    throw new PpqError('invalid_request');
  return value;
}

function priceUsd6(value: unknown): bigint {
  if (
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === 'string' && /^(0|[1-9]\d{0,15})$/.test(value))
  ) {
    const amount = BigInt(value);
    if (amount <= BigInt(Number.MAX_SAFE_INTEGER)) return amount;
  }
  throw new PpqError('invalid_request');
}

const tokenCounts = new Set([
  'prompt_tokens',
  'completion_tokens',
  'input_tokens',
  'output_tokens',
  'total_tokens',
]);
// Monetary members are read separately as provider costs, never as tokens.
const monetary = new Set(['cost', 'cost_details']);

/**
 * True for members that cannot carry a billable count: absent, flags, labels
 * and zeros. parseProviderJson keeps numbers as their lexemes, so any string
 * that is a complete JSON number is treated as a number.
 */
function inert(value: unknown, depth = 0): boolean {
  if (value === null || value === undefined || typeof value === 'boolean')
    return true;
  if (typeof value === 'string')
    return (
      !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) ||
      /^-?0(?:\.0+)?(?:[eE][+-]?\d+)?$/.test(value)
    );
  if (typeof value === 'number') return value === 0;
  if (depth >= 4) return false;
  const items = Array.isArray(value)
    ? value
    : record(value)
      ? Object.values(value as Record<string, unknown>)
      : null;
  return items !== null && items.every((item) => inert(item, depth + 1));
}

export type PpqBillableTokens = {
  inputTokens: number;
  /** Output tokens billed at the output rate, including every reasoning token. */
  outputTokens: number;
  reasoningTokens: number;
  reasoningIncluded: boolean;
};

/**
 * Billable token counts, or null when the usage cannot be priced at reviewed
 * input/output rates. Reasoning is billed as output under both conventions
 * PPQ reports: inside the completion count (OpenAI-compatible: total = prompt
 * + completion) or beside it (Google: total = prompt + completion +
 * reasoning). Any nonzero count the reviewed rates cannot price (cached
 * prompt tokens, cache writes, Anthropic cache reads/creation, audio, image,
 * tool use), an unparseable count or an inconsistent total leaves usage
 * underivable (fail closed): only a provider cost can settle it.
 */
export function billableTokens(
  raw: Record<string, unknown>,
  counted: PpqUsage,
): PpqBillableTokens | null {
  const {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
  } = counted;
  if (input === null || output === null) return null;
  let reasoning: number | null = null;
  for (const [key, value] of Object.entries(raw)) {
    if (tokenCounts.has(key) || monetary.has(key)) continue;
    const details = record(value);
    if (details && /^(completion|output)_tokens_details$/.test(key)) {
      for (const [name, item] of Object.entries(details)) {
        if (name === 'reasoning_tokens' && item !== null) {
          const count = integer(item);
          if (count === null || (reasoning !== null && reasoning !== count))
            return null;
          reasoning = count;
        } else if (!inert(item)) return null;
      }
    } else if (!inert(value)) return null;
  }
  const thinking = reasoning ?? 0;
  const included = { reasoningTokens: thinking, reasoningIncluded: true };
  const separate = {
    outputTokens: output + thinking,
    reasoningTokens: thinking,
    reasoningIncluded: false,
  };
  if (total !== null) {
    if (total === input + output)
      return thinking <= output
        ? { inputTokens: input, outputTokens: output, ...included }
        : null;
    return thinking > 0 && total === input + output + thinking
      ? { inputTokens: input, ...separate }
      : null;
  }
  // Without a total, only reasoning beyond the completion count is unambiguous.
  if (thinking === 0)
    return { inputTokens: input, outputTokens: output, ...included };
  return thinking > output ? { inputTokens: input, ...separate } : null;
}

function upstreamCost(data: Record<string, unknown>) {
  const value = record(
    record(data.usage)?.cost_details,
  )?.upstream_inference_cost;
  return value === undefined || value === null ? null : value;
}

/**
 * The canonical charge for a stream's latest report, or null when nothing
 * can confirm a nonzero cost: the provider cost first, else the usage-derived
 * cost. Usage for delivered text must be backed by output tokens.
 */
function settlement(input: {
  usage: PpqUsage | null;
  raw: Record<string, unknown> | null;
  providerCost: Usd6 | null;
  upstream: unknown;
  pricing: { input: bigint; output: bigint; cacheRead?: bigint } | null;
  delivered: boolean;
}) {
  // A reported zero never confirms free work (BYOK routes report cost 0 and
  // the real upstream charge in cost_details).
  const provider =
    input.providerCost !== null && input.providerCost > 0
      ? input.providerCost
      : cost(input.upstream, true) || null;
  let derived: Usd6 | null = null;
  let pricedRaw = input.raw;
  let cachedInput = 0;
  if (pricedRaw && input.pricing?.cacheRead !== undefined) {
    let observed: number | null = null;
    const copy = { ...pricedRaw };
    for (const key of ['prompt_tokens_details', 'input_tokens_details']) {
      const details = record(pricedRaw[key]);
      if (details?.cached_tokens != null) {
        const count = integer(details.cached_tokens);
        if (count === null || (observed !== null && observed !== count) ||
            input.usage?.inputTokens == null || count > input.usage.inputTokens) {
          pricedRaw = null;
          break;
        }
        observed = count;
        copy[key] = { ...details, cached_tokens: 0 };
      }
    }
    cachedInput = observed ?? 0;
    if (pricedRaw) pricedRaw = copy;
  }
  const tokens =
    input.pricing && input.usage && pricedRaw
      ? billableTokens(pricedRaw, input.usage)
      : null;
  if (
    input.pricing &&
    tokens &&
    tokens.inputTokens > 0 &&
    (!input.delivered || input.usage!.outputTokens! > 0)
  ) {
    const micros =
      BigInt(tokens.inputTokens - cachedInput) * input.pricing.input +
      BigInt(cachedInput) * (input.pricing.cacheRead ?? 0n) +
      BigInt(tokens.outputTokens) * input.pricing.output;
    const amount = (micros + 999_999n) / 1_000_000n;
    if (amount > 0n && amount <= BigInt(Number.MAX_SAFE_INTEGER))
      derived = Number(amount);
  }
  return {
    costUsd6: provider ?? derived,
    costSource:
      provider !== null
        ? ('provider' as const)
        : derived !== null
          ? ('usage' as const)
          : null,
    usageCostUsd6: derived,
    providerCostUsd6: provider,
  };
}

function checkedCost(data: Record<string, unknown>, ambiguous: boolean) {
  const values = [data.cost, record(data.usage)?.cost].filter(
    (value) => value !== undefined && value !== null,
  );
  const amounts = values.map((value) => cost(value, ambiguous));
  if (amounts.some((value) => value !== amounts[0]))
    throw new PpqError('invalid_response', ambiguous);
  return amounts[0] ?? null;
}

function media(value: unknown, modality: 'image' | 'video'): PpqMedia {
  const item = record(value);
  if (typeof item?.url !== 'string' || item.url.length > 4096)
    throw new PpqError('invalid_response', true);
  let url: URL;
  try {
    url = new URL(item.url);
  } catch {
    throw new PpqError('invalid_response', true);
  }
  if (
    url.origin !== 'https://api.ppq.ai' ||
    url.username ||
    url.password ||
    url.hash ||
    !/^\/v1\/media\/[A-Za-z0-9_-]+\/\d+$/.test(url.pathname)
  )
    throw new PpqError('invalid_response', true);
  const contentType = item.content_type;
  if (
    modality === 'video'
      ? contentType !== 'video/mp4'
      : contentType !== 'image/png' &&
        contentType !== 'image/jpeg' &&
        contentType !== 'image/webp'
  )
    throw new PpqError('invalid_response', true);
  return { url: url.href, contentType: contentType as PpqMedia['contentType'] };
}

function imageResult(
  value: unknown,
  clientRequestId: string,
  expectedModel?: string,
): PpqImageResult {
  const data = record(value);
  if (!data) throw new PpqError('invalid_response', true);
  const modelId =
    typeof data.model === 'string' ? data.model : (expectedModel ?? null);
  if (modelId !== null) {
    try {
      validateModel(modelId, 'image');
    } catch {
      throw new PpqError('invalid_response', true);
    }
    if (expectedModel && expectedModel !== modelId)
      throw new PpqError('invalid_response', true);
  }
  if (data.status === 'pending' || data.status === 'processing')
    return {
      status: 'pending',
      clientRequestId,
      modelId,
      media: [],
      costUsd6: checkedCost(data, true),
    };
  if (data.status === 'failed')
    return {
      status: 'failed',
      clientRequestId,
      modelId,
      media: [],
      costUsd6: checkedCost(data, true),
    };
  if (data.status !== undefined && data.status !== 'completed')
    throw new PpqError('invalid_response', true);
  if (!Array.isArray(data.data) || !data.data.length || data.data.length > 4)
    throw new PpqError('invalid_response', true);
  return {
    status: 'completed',
    clientRequestId,
    modelId,
    media: data.data.map((item) => media(item, 'image')),
    costUsd6: checkedCost(data, true),
  };
}

function videoResult(
  value: unknown,
  expectedId?: string,
  expectedModel?: string,
): PpqVideoJob {
  const data = record(value);
  if (
    !data ||
    typeof data.id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(data.id) ||
    (expectedId && data.id !== expectedId)
  )
    throw new PpqError('invalid_response', true);
  const modelId =
    typeof data.model === 'string' ? data.model : (expectedModel ?? null);
  if (modelId !== null) {
    try {
      validateModel(modelId, 'video');
    } catch {
      throw new PpqError('invalid_response', true);
    }
    if (expectedModel && expectedModel !== modelId)
      throw new PpqError('invalid_response', true);
  }
  const status = data.status;
  if (
    status !== 'pending' &&
    status !== 'processing' &&
    status !== 'completed' &&
    status !== 'failed'
  )
    throw new PpqError('invalid_response', true);
  return {
    id: data.id,
    modelId,
    status,
    media: status === 'completed' ? media(data.data, 'video') : null,
    estimatedCostUsd6: cost(data.estimated_cost, true),
    costUsd6: checkedCost(data, true),
  };
}

export function createPpqClient(options: PpqOptions = {}) {
  if (typeof window !== 'undefined') throw new PpqError('unavailable');
  const request = transport(
    options.apiKey,
    options.fetch ?? globalThis.fetch.bind(globalThis),
  );
  const timeout = (value: number | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < 1 || value > CHAT_LIMITS.generationMs)
      throw new PpqError('invalid_request');
    return value;
  };
  const requestMs = timeout(options.timeouts?.requestMs, 30_000);
  const chatMs = timeout(options.timeouts?.chatMs, CHAT_LIMITS.generationMs);
  const imageMs = timeout(options.timeouts?.imageMs, 180_000);
  const referenceOrigins = new Set<string>();
  for (const origin of options.referenceOrigins ?? []) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new PpqError('invalid_request');
    }
    if (
      url.protocol !== 'https:' ||
      url.origin !== origin ||
      url.username ||
      url.password ||
      !/^[a-z\d.-]+\.[a-z]{2,}$/i.test(url.hostname)
    )
      throw new PpqError('invalid_request');
    referenceOrigins.add(origin);
  }
  function reference(value: string | undefined) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > 4096)
      throw new PpqError('invalid_request');
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new PpqError('invalid_request');
    }
    if (
      !referenceOrigins.has(url.origin) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new PpqError('invalid_request');
    return url.href;
  }

  return {
    configured: Boolean(
      options.apiKey && /^[\x21-\x7e]{1,512}$/.test(options.apiKey),
    ),
    /** Inactivity timeout. Progressing chat streams have no overall deadline. */
    chatTimeoutMs: chatMs,
    chatTimeoutMode: 'idle' as const,

    async catalog(signal?: AbortSignal) {
      const session = await request('/v1/models?type=all', {
        signal,
        timeoutMs: requestMs,
      });
      return normalizeCatalog(await readJson(session, PPQ_LIMITS.catalogBytes));
    },

    async *chat(input: PpqChatRequest): AsyncGenerator<PpqChatEvent> {
      validateModel(input.modelId, 'chat', input.privacy);
      if (
        !Array.isArray(input.messages) ||
        !input.messages.length ||
        input.messages.length > CHAT_LIMITS.messages
      )
        throw new PpqError('invalid_request');
      const messages = input.messages.map((message) => {
        if (
          !message ||
          !['system', 'user', 'assistant'].includes(message.role) ||
          typeof message.content !== 'string' ||
          message.content.length > CHAT_LIMITS.inputBytes
        )
          throw new PpqError('invalid_request');
        return { role: message.role, content: message.content };
      });
      if (
        !messages.some(
          (message) => message.role === 'user' && message.content.trim(),
        )
      )
        throw new PpqError('invalid_request');
      const family = Object.entries(PPQ_MODEL_ALLOWLIST).find(([, model]) => model.id === input.modelId)?.[0];
      const nativeMaximum = family ? CHAT_CAPACITY[family]?.outputTokens : undefined;
      const maxTokens = input.maxOutputTokens ?? nativeMaximum;
      if (maxTokens === undefined || nativeMaximum === undefined || maxTokens > nativeMaximum)
        throw new PpqError('invalid_request');
      if (messages.reduce((sum, message) => sum + new TextEncoder().encode(message.content).byteLength, 0) > CHAT_LIMITS.inputBytes)
        throw new PpqError('invalid_request');
      if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > CHAT_LIMITS.outputTokens)
        throw new PpqError('invalid_request');
      const pricing =
        input.pricing === undefined
          ? null
          : {
              input: priceUsd6(input.pricing?.inputPerMillionUsd6),
              output: priceUsd6(input.pricing?.outputPerMillionUsd6),
              ...(input.pricing.cacheReadPerMillionUsd6 === undefined ? {} : {cacheRead: priceUsd6(input.pricing.cacheReadPerMillionUsd6)}),
            };
      if (pricing?.cacheRead !== undefined && pricing.cacheRead > pricing.input) throw new PpqError('invalid_request');
      const session = await request('/v1/chat/completions', {
        method: 'POST',
        signal: input.signal,
        timeoutMs: chatMs,
        idleTimeout: true,
        requestId: input.requestId,
        chargeable: true,
        stream: true,
        body: {
          model: input.modelId,
          messages,
          max_tokens: maxTokens,
          stream: true,
          stream_options: { include_usage: true },
        },
      });
      let finalUsage: PpqUsage | null = null;
      let finalUsageRaw: Record<string, unknown> | null = null;
      let finalCost: Usd6 | null = null;
      let finalUpstream: unknown = null;
      let providerId: string | null = null;
      let finishReason: 'stop' | 'length' | 'content_filter' | 'other' | null =
        null;
      let delivered = false;
      const settle = () =>
        settlement({
          usage: finalUsage,
          raw: finalUsageRaw,
          providerCost: finalCost,
          upstream: finalUpstream,
          pricing,
          delivered,
        });
      try {
        for await (const frame of readSse(session)) {
          if (frame === '[DONE]') {
            if (!finishReason) throw new PpqError('stream_interrupted', true);
            session.close();
            yield {
              type: 'done',
              finishReason,
              usage: finalUsage,
              ...settle(),
              providerId,
            };
            return;
          }
          let parsed: unknown;
          try {
            parsed = parseProviderJson(frame);
          } catch {
            throw new PpqError('invalid_response', true);
          }
          const data = record(parsed);
          if (!data) throw new PpqError('invalid_response', true);
          if (data.error || data.type === 'error')
            throw new PpqError('provider_unavailable', true);
          if (data.id !== undefined && data.id !== null) {
            if (
              typeof data.id !== 'string' ||
              !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(data.id) ||
              (providerId !== null && providerId !== data.id)
            )
              throw new PpqError('invalid_response', true);
            if (providerId === null) {
              providerId = data.id;
              yield { type: 'reference', providerId };
            }
          }
          const reportedUsage = usage(data.usage);
          const reportedCost = checkedCost(data, true);
          const reportedUpstream = upstreamCost(data);
          if (reportedUsage) {
            finalUsage = reportedUsage;
            finalUsageRaw = record(data.usage);
          }
          if (reportedCost !== null) finalCost = reportedCost;
          if (reportedUpstream !== null) {
            // Validate now; it is only used when no positive cost is reported.
            cost(reportedUpstream, true);
            finalUpstream = reportedUpstream;
          }
          if (reportedUsage || reportedCost !== null)
            yield {
              type: 'usage',
              usage: finalUsage,
              costUsd6: finalCost,
              settlementUsd6: settle().costUsd6,
            };
          if (!Array.isArray(data.choices) || data.choices.length > 1)
            throw new PpqError('invalid_response', true);
          for (const item of data.choices) {
            const choice = record(item);
            const delta = record(choice?.delta);
            if (!choice || (choice.delta != null && !delta))
              throw new PpqError('invalid_response', true);
            if (delta?.tool_calls || delta?.function_call)
              throw new PpqError('invalid_response', true);
            if (delta?.content !== undefined && delta.content !== null) {
              if (typeof delta.content !== 'string')
                throw new PpqError('invalid_response', true);
              if (delta.content) {
                delivered = true;
                yield { type: 'text', text: delta.content };
              }
            }
            if (delta?.refusal !== undefined && delta.refusal !== null) {
              if (typeof delta.refusal !== 'string')
                throw new PpqError('invalid_response', true);
              if (delta.refusal) {
                delivered = true;
                yield { type: 'refusal', text: delta.refusal };
              }
            }
            if (
              choice.finish_reason !== undefined &&
              choice.finish_reason !== null
            ) {
              if (typeof choice.finish_reason !== 'string')
                throw new PpqError('invalid_response', true);
              finishReason =
                choice.finish_reason === 'stop' ||
                choice.finish_reason === 'length' ||
                choice.finish_reason === 'content_filter'
                  ? choice.finish_reason
                  : 'other';
            }
          }
        }
        throw new PpqError('stream_interrupted', true);
      } catch (error) {
        throw session.fail(error);
      } finally {
        session.close();
      }
    },

    async generateImage(input: PpqImageRequest): Promise<PpqImageResult> {
      validateModel(input.modelId, 'image', input.privacy);
      const clientRequestId = identifier(input.clientRequestId);
      const count = input.count ?? 1;
      const resolution = input.resolution ?? '1K';
      const aspectRatio = input.aspectRatio ?? '1:1';
      if (
        !Number.isInteger(count) ||
        count < 1 ||
        count > 4 ||
        !['1K', '2K', '4K'].includes(resolution) ||
        !['1:1', '16:9', '9:16'].includes(aspectRatio)
      )
        throw new PpqError('invalid_request');
      const session = await request('/v1/images/generations', {
        method: 'POST',
        signal: input.signal,
        timeoutMs: imageMs,
        requestId: input.requestId,
        chargeable: true,
        body: {
          model: input.modelId,
          prompt: prompt(input.prompt),
          client_request_id: clientRequestId,
          n: count,
          resolution,
          size: aspectRatio,
          image_url: reference(input.imageUrl),
          response_format: 'url',
        },
      });
      return imageResult(
        await readJson(session),
        clientRequestId,
        input.modelId,
      );
    },

    async recoverImage(
      clientRequestId: string,
      signal?: AbortSignal,
    ): Promise<PpqImageResult> {
      identifier(clientRequestId);
      try {
        const session = await request(
          `/v1/images/generations/by-key/${clientRequestId}`,
          { signal, timeoutMs: requestMs },
        );
        return imageResult(await readJson(session), clientRequestId);
      } catch (error) {
        // A lookup failure cannot establish what the original generation cost.
        throw new PpqError(
          error instanceof PpqError ? error.code : 'provider_unavailable',
          true,
        );
      }
    },

    async submitVideo(input: PpqVideoRequest): Promise<PpqVideoJob> {
      validateModel(input.modelId, 'video', input.privacy);
      const ratio = input.aspectRatio;
      const quality = input.quality;
      const seconds = input.duration;
      if (!['16:9', '9:16', '1:1'].includes(ratio))
        throw new PpqError('invalid_request');
      if (input.modelId === 'runway-gen4') {
        if (
          ratio === '1:1' ||
          ![5, 10].includes(seconds) ||
          !['720p', '1080p'].includes(quality) ||
          (quality === '1080p' && seconds !== 5)
        )
          throw new PpqError('invalid_request');
      } else if (input.modelId === 'veo3-fast') {
        if (
          seconds !== 8 ||
          ratio === '1:1' ||
          quality !== 'standard' ||
          input.imageUrl !== undefined
        )
          throw new PpqError('invalid_request');
      } else if (![5, 10].includes(seconds) || quality !== 'standard')
        throw new PpqError('invalid_request');
      const session = await request('/v1/videos', {
        method: 'POST',
        signal: input.signal,
        timeoutMs: requestMs,
        requestId: input.requestId,
        chargeable: true,
        body: {
          model: input.modelId,
          prompt: prompt(input.prompt),
          aspect_ratio: ratio,
          duration: String(seconds),
          quality,
          image_url: reference(input.imageUrl),
        },
      });
      return videoResult(await readJson(session), undefined, input.modelId);
    },

    async videoStatus(
      jobId: string,
      signal?: AbortSignal,
    ): Promise<PpqVideoJob> {
      identifier(jobId);
      try {
        const session = await request(`/v1/videos/${jobId}`, {
          signal,
          timeoutMs: requestMs,
        });
        return videoResult(await readJson(session), jobId);
      } catch (error) {
        throw new PpqError(
          error instanceof PpqError ? error.code : 'provider_unavailable',
          true,
        );
      }
    },
  };
}

export type PpqClient = ReturnType<typeof createPpqClient>;
