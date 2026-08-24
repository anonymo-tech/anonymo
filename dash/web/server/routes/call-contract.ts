import { requireCondition, ServiceError } from '../core/errors.ts';
import { digestText } from '../core/digest.ts';
import { usd6, ceilRatio } from '../ledger/money.ts';
import { validateModel } from '../gateway/catalog.ts';

export type ChatInput = {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  maxOutputTokens: number;
  privacy: 'standard';
};
export type RouteVersion = {
  id: string;
  model_id: string;
  family: string;
  enabled: boolean;
  fresh: boolean;
  modality: 'chat' | 'image' | 'video';
  card: {
    level?: string;
    reviewed?: boolean;
    retentionDisclosure?: string;
    evidenceUrl?: string;
    evidenceDate?: string;
  };
  pricing: {
    inputPerMillionUsd6: string;
    outputPerMillionUsd6: string;
    markupBps: number;
    maxOutputTokens: number;
    maxInputBytes: number;
    /**
     * Reviewed per-request reasoning ("thinking") token cap for this model, billed at
     * the output rate. Absent on older route versions: the quote then reserves the
     * route's full output cap for reasoning, whatever the request asked for.
     */
    maxReasoningTokens?: number;
  };
};

/** Upper bound for a reviewed reasoning cap; matches the largest provider budgets. */
export const MAX_REASONING_TOKENS = 65536;

/**
 * Reasoning tokens the hold must cover. Providers bill reasoning at the output
 * rate and the request body cannot bound it, so the reservation must.
 */
export function reasoningAllowance(
  pricing: { maxReasoningTokens?: number; maxOutputTokens: number },
  maxOutputTokens: number,
) {
  // A route without a reviewed cap reserves its whole output cap: a request that
  // asks for one visible token must not shrink the reserve for reasoning.
  void maxOutputTokens;
  const allowance = pricing.maxReasoningTokens ?? pricing.maxOutputTokens;
  requireCondition(
    Number.isSafeInteger(allowance) &&
      allowance >= 0 &&
      allowance <= MAX_REASONING_TOKENS,
    409,
    'ROUTE_PRICING_UNAVAILABLE',
    'This route does not have valid pricing limits.',
  );
  return allowance;
}

export function parseChatInput(
  body: Record<string, unknown>,
  options: { trustedCrossCheck?: true; trustedBriefSynthesis?: true } = {},
): ChatInput {
  requireCondition(
    body.privacy === 'standard',
    409,
    'PRIVACY_ROUTE_UNAVAILABLE',
    'This request requires a privacy route that has not been verified.',
  );
  requireCondition(
    Array.isArray(body.messages) &&
      body.messages.length >= 1 &&
      body.messages.length <= 40,
    400,
    'INVALID_MESSAGES',
    'Send between one and forty messages.',
  );
  let bytes = 0;
  const messages: ChatInput['messages'] = body.messages.map(
    (value: unknown, index: number): ChatInput['messages'][number] => {
      requireCondition(
        value && typeof value === 'object',
        400,
        'INVALID_MESSAGES',
        'A message is invalid.',
      );
      const entry = value as Record<string, unknown>;
      requireCondition(
        (entry.role === 'user' ||
          entry.role === 'assistant' ||
          ((options.trustedCrossCheck === true ||
            options.trustedBriefSynthesis === true) &&
            index === 0 &&
            entry.role === 'system')) &&
          typeof entry.content === 'string' &&
          entry.content.trim().length > 0,
        400,
        'INVALID_MESSAGES',
        'Use text user and assistant messages.',
      );
      bytes += new TextEncoder().encode(entry.content).byteLength;
      requireCondition(
        bytes <= 32_768,
        413,
        'PROMPT_TOO_LARGE',
        'This conversation exceeds the current request limit.',
      );
      return { role: entry.role, content: entry.content };
    },
  );
  if (options.trustedCrossCheck || options.trustedBriefSynthesis)
    requireCondition(
      messages.length === 2 &&
        messages[0].role === 'system' &&
        messages[1].role === 'user',
      400,
      'INVALID_MESSAGES',
      'A review requires one server instruction and one source message.',
    );
  requireCondition(
    messages.at(-1)?.role === 'user',
    400,
    'INVALID_MESSAGES',
    'The last message must be from the user.',
  );
  requireCondition(
    Number.isSafeInteger(body.maxOutputTokens) &&
      Number(body.maxOutputTokens) >= 1 &&
      Number(body.maxOutputTokens) <= 8192,
    400,
    'INVALID_OUTPUT_LIMIT',
    'Choose an output limit between 1 and 8192 tokens.',
  );
  return {
    messages,
    maxOutputTokens: Number(body.maxOutputTokens),
    privacy: 'standard',
  };
}

export function assertUsableRoute(
  route: RouteVersion | null,
): asserts route is RouteVersion {
  requireCondition(
    route && route.enabled && route.fresh && route.modality === 'chat',
    409,
    'ROUTE_UNAVAILABLE',
    'This model route is unavailable.',
  );
  requireCondition(
    route.card.reviewed === true &&
      typeof route.card.retentionDisclosure === 'string' &&
      route.card.retentionDisclosure.length > 0 &&
      typeof route.card.evidenceUrl === 'string' &&
      route.card.evidenceUrl.startsWith('https://') &&
      typeof route.card.evidenceDate === 'string',
    409,
    'ROUTE_REVIEW_REQUIRED',
    'This route needs a current privacy and pricing review.',
  );
  try {
    validateModel(route.model_id, 'chat', 'standard');
  } catch {
    throw new ServiceError(
      409,
      'ROUTE_UNAVAILABLE',
      'This model route is unavailable.',
    );
  }
}

/** Per-request cap on a chat quote's maximum, including any platform fee. */
export const CHAT_REQUEST_BUDGET_USD6 = 10_000_000n;

export function quoteMaximum(route: RouteVersion, input: ChatInput): string {
  const pricing = route.pricing;
  requireCondition(
    Number.isSafeInteger(pricing.markupBps) &&
      pricing.markupBps >= 0 &&
      pricing.markupBps <= 10000 &&
      Number.isSafeInteger(pricing.maxInputBytes) &&
      pricing.maxInputBytes > 0 &&
      pricing.maxInputBytes <= 32768 &&
      Number.isSafeInteger(pricing.maxOutputTokens) &&
      input.maxOutputTokens <= pricing.maxOutputTokens,
    409,
    'ROUTE_PRICING_UNAVAILABLE',
    'This route does not have valid pricing limits.',
  );
  const bytes = input.messages.reduce(
    (sum, message) =>
      sum + new TextEncoder().encode(message.content).byteLength,
    0,
  );
  requireCondition(
    bytes <= pricing.maxInputBytes,
    413,
    'PROMPT_TOO_LARGE',
    'This conversation exceeds this route’s input limit.',
  );
  // Conservative text-only token allowance. Verified actual cost still governs settlement;
  // an unexpected excess is held for reconciliation, never an additional user debit.
  // Reasoning tokens are billed at the output rate on top of the visible output, so
  // the reservation covers the route's reviewed reasoning cap as well.
  const inputAllowance = BigInt(bytes + input.messages.length * 256 + 1024);
  const outputAllowance = BigInt(
    input.maxOutputTokens + reasoningAllowance(pricing, input.maxOutputTokens),
  );
  const providerMaximum = ceilRatio(
    inputAllowance * usd6(pricing.inputPerMillionUsd6) +
      outputAllowance * usd6(pricing.outputPerMillionUsd6),
    1_000_000n,
  );
  const maximum = ceilRatio(
    providerMaximum * BigInt(10000 + pricing.markupBps),
    10000n,
  );
  requireCondition(
    maximum <= CHAT_REQUEST_BUDGET_USD6,
    400,
    'REQUEST_BUDGET_EXCEEDED',
    'This request exceeds the current maximum budget.',
  );
  return (maximum > 0n ? maximum : 1n).toString();
}

export async function callRequestHash(
  projectId: string,
  routeVersionId: string,
  input: ChatInput,
) {
  return digestText(
    'call',
    JSON.stringify({ projectId, routeVersionId, ...input }),
  );
}
