import {
  ROUTING_TASKS,
  parseRoutingProfile,
  type RoutingTask,
  type RoutingProfile,
  type RouteRecommendation,
} from '../model-routing.ts';
import type { AccountSession } from './service.ts';
import {
  parseBriefDocument,
  renderBriefMarkdown,
  type BriefDocument,
  type BriefAnalysis,
} from '../brief-document.ts';

export type ClientOptions = {
  signal?: AbortSignal;
  fetch?: typeof fetch;
  accountId?: string;
};
export type ServiceCapabilities = {
  mode: 'preview' | 'service';
  chat: { configured: boolean; reason: string };
};
export type ServiceProject = {
  id: string;
  title: string;
  revision: number;
  createdAt?: string;
  updatedAt?: string;
};
export type ServiceBrief = {
  document?: BriefDocument;
  id: string;
  projectId: string;
  title: string;
  revision: number;
  body?: string;
  createdAt?: string;
  updatedAt?: string;
};
export type WorkspaceRoutingPreferences = {
  mode: 'manual' | 'auto';
  task: RoutingTask;
  budgetUsd: string;
};
export type RouteCard = {
  level: string;
  reviewed: boolean;
  retentionDisclosure: string;
  evidenceUrl: string;
  evidenceDate: string;
  plaintextVisibility: string;
  trainingUse: string;
  upstreamProviders: string[];
  routing?: RoutingProfile;
};
export type ServiceRoute = {
  versionId: string;
  id: string;
  version: number;
  modelId: string;
  family: string;
  modality: string;
  available: boolean;
  expiresAt: string;
  card: RouteCard;
  pricing: {
    inputPerMillionUsd6: string;
    outputPerMillionUsd6: string;
    markupBps: number;
    maxOutputTokens: number;
    maxInputBytes: number;
  };
};
export type ServiceBalance = {
  availableUsd6: string;
  reservedUsd6: string;
  currency: 'USD6';
  /** Lifetime internal test credit granted to this account; never USDC. */
  internalTestCreditUsd6?: string;
};
export type CallState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'reconciliation_pending';
export type CallBilling = {
  state:
    | 'held'
    | 'running'
    | 'captured'
    | 'released'
    | 'reconciliation_pending';
  maximumUsd6: string | null;
  actualUsd6: string | null;
};
export type CallSnapshot = {
  id: string;
  state: CallState;
  errorCode: string | null;
  output: string;
  billing: CallBilling;
  /**
   * A stop was accepted. The call stays `running` with frozen output while the
   * service drains the upstream for exact billing, then becomes `cancelled`.
   * Older responses omit it; it then reads as false.
   */
  cancelRequested: boolean;
};
export type ComparisonCall = CallSnapshot & {
  label: string;
  position: number;
  routeVersionId: string | null;
  modelId: string | null;
  family: string | null;
  outputTruncated: boolean;
  outputLength: number;
};
export type ServiceComparison = {
  id: string;
  projectId: string;
  prompt: string;
  createdAt: string;
  blind: boolean;
  revealedAt: string | null;
  votedCallId: string | null;
  calls: ComparisonCall[];
  billing: { maximumUsd6: string; actualUsd6: string | null };
};
export type ComparisonItem = {
  routeVersionId: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxOutputTokens: number;
  privacy: 'standard';
};
export type ComparisonInput = {
  projectId: string;
  items: ComparisonItem[];
  blind: boolean;
};
export type QuotedComparisonInput = Omit<ComparisonInput, 'items'> & {
  items: (ComparisonItem & { quoteId: string })[];
  idempotencyKey: string;
};
/** Present only when the service applies a platform fee; the maximum already includes it. */
export type QuotePlatformFee = {
  baseMaximumUsd6: string;
  platformFeeBps: number;
  burnShareBps: number;
  platformFeeMaximumUsd6: string;
  burnReserveMaximumUsd6: string;
};
export type ComparisonQuote = {
  id: string;
  routeVersionId: string;
  maximumUsd6: string;
  expiresAt: string;
  requestHash: string;
  markupBps: number;
  modelId: string;
  family: string;
  card: RouteCard;
  platformFee?: QuotePlatformFee;
};
export type QuoteResponse = { quotes: ComparisonQuote[]; maximumUsd6: string };
export type AutoRouteInput = {
  projectId: string;
  task: RoutingTask;
  privacy: 'standard';
  budgetUsd6: string;
  candidates: ComparisonItem[];
};
export type AutoRouteQuote = QuoteResponse & {
  recommendation: RouteRecommendation;
};
export function routingBudgetUsd6(value: string): string {
  if (value === '') return '10000000';
  if (!/^(0|[1-9][0-9]?)(\.[0-9]{1,6})?$/.test(value))
    throw new WorkspaceError(
      'INVALID_ROUTING_BUDGET',
      'Enter a positive USD budget with up to six decimal places, no greater than 10.',
    );
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (amount < 1n || amount > 10000000n)
    throw new WorkspaceError(
      'INVALID_ROUTING_BUDGET',
      'Choose a reservation budget between 0.000001 and 10 USD.',
    );
  return amount.toString();
}
export type Page<T> = { items: T[]; nextCursor: string | null };

export function assertRoutingBudget(
  maximumUsd6: string,
  budgetUsd6: string | null,
) {
  if (
    budgetUsd6 !== null &&
    BigInt(money(maximumUsd6)) > BigInt(money(budgetUsd6))
  )
    throw new WorkspaceError(
      'ROUTING_BUDGET_EXCEEDED',
      'The selected models exceed this reservation budget. Increase it explicitly or choose fewer models.',
    );
}
export class WorkspaceError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    this.status = status;
  }
}
const messages: Record<string, string> = {
  ROUTING_CANDIDATES_STALE:
    'Reviewed route versions changed. Refresh the model list before requesting Auto again.',
  ROUTING_REVIEW_REQUIRED:
    'No supplied route has a current task review. Choose Manual or refresh the model list.',
  ROUTING_BUDGET_EXCEEDED:
    'No reviewed compatible route fits this reservation budget. Increase it explicitly or choose Manual.',
  ROUTING_NO_COMPATIBLE_ROUTE:
    'No reviewed route accepts the complete supplied context and output limit.',
  ROUTING_CANDIDATE_MISMATCH:
    'The candidates did not share the same question, output limit and privacy. Review the request again.',
  INVALID_ROUTING_BUDGET:
    'Choose a positive reservation budget no greater than 10 USD.',
  BRIEF_TOO_LARGE:
    'These questions and responses exceed the 24,000-character Brief limit. Select fewer or shorter responses.',
  BRIEF_RESPONSE_INCOMPLETE:
    'Wait for each selected response to finish before saving a Brief.',
  BRIEF_SELECTION_UNAVAILABLE:
    'A selected response is unavailable. Refresh the project and choose its completed responses.',
  INVALID_BRIEF_SELECTION:
    'Choose between one and four different completed responses.',
  BLIND_REVEAL_REQUIRED:
    'Reveal the model names before saving their provenance.',
  BRIEF_REMOVED:
    'This Brief was already removed. Start a new selection to save another.',
  INVALID_BRIEF_ANALYSIS:
    'Check your decision, notes and agreement topics before saving.',
  SENSITIVE_CONTENT:
    'Remove or redact the detected secret before requesting a quote.',
  INSUFFICIENT_BALANCE:
    'There is not enough available balance to reserve this request.',
  INSUFFICIENT_FUNDS:
    'There is not enough available balance to reserve this request.',
  QUOTE_EXPIRED: 'This quote has expired. Review a new quote before sending.',
  QUOTE_UNAVAILABLE:
    'This quote is no longer available. Review a new quote before sending.',
  REVISION_CONFLICT:
    'This item changed elsewhere. Refresh before saving again.',
  ROUTE_UNAVAILABLE:
    'A selected model route is unavailable. Refresh the model list.',
  PROVIDER_UNAVAILABLE:
    'Live model requests are not configured. Projects remain available.',
  ROUTE_REVIEW_REQUIRED:
    'This route needs a current privacy and pricing review.',
  PROMPT_TOO_LARGE: 'This request exceeds the selected route’s input limit.',
  PRIVACY_ROUTE_UNAVAILABLE: 'The requested privacy route is unavailable.',
  IDEMPOTENCY_CONFLICT:
    'This request key belongs to a different request. Refresh to inspect your history.',
};
function invalid(): never {
  throw new WorkspaceError(
    'INVALID_RESPONSE',
    'The service returned an invalid or unsupported response. Refresh to read the saved state.',
  );
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return invalid();
  return v as Record<string, unknown>;
}
function text(v: unknown, max = 512, empty = false): string {
  if (typeof v !== 'string' || v.length > max || (!empty && !v.trim()))
    return invalid();
  return v;
}
function integer(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max)
    return invalid();
  return v;
}
function bool(v: unknown): boolean {
  if (typeof v !== 'boolean') return invalid();
  return v;
}
function id(v: unknown): string {
  const result = text(v, 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      result,
    )
  )
    return invalid();
  return result;
}
function date(v: unknown): string {
  const result = text(v, 40);
  if (
    !/^\d{4}-\d\d-\d\dT.*Z$/.test(result) ||
    !Number.isFinite(Date.parse(result))
  )
    return invalid();
  return result;
}
function nullable<T>(v: unknown, parse: (v: unknown) => T): T | null {
  return v === null ? null : parse(v);
}
function money(v: unknown): string {
  const result = text(v, 19);
  if (!/^(0|[1-9]\d{0,18})$/.test(result)) return invalid();
  return result;
}
function list<T>(v: unknown, max: number, parse: (v: unknown) => T): T[] {
  if (!Array.isArray(v) || v.length > max) return invalid();
  return v.map(parse);
}
function unique<T>(entries: T[], key: (v: T) => string) {
  if (new Set(entries.map(key)).size !== entries.length) return invalid();
  return entries;
}
function cursor(v: unknown) {
  return nullable(v, (v) => text(v, 2048));
}
function oneOf<T extends string>(v: unknown, values: readonly T[]): T {
  if (!values.includes(v as T)) return invalid();
  return v as T;
}
function card(v: unknown): RouteCard {
  const r = object(v);
  return {
    level: text(r.level, 80),
    reviewed: bool(r.reviewed),
    retentionDisclosure: text(r.retentionDisclosure, 8000),
    evidenceUrl: text(r.evidenceUrl, 2048),
    evidenceDate: text(r.evidenceDate, 40),
    plaintextVisibility:
      typeof r.plaintextVisibility === 'string'
        ? text(r.plaintextVisibility, 100)
        : 'unknown',
    trainingUse:
      typeof r.trainingUse === 'string' ? text(r.trainingUse, 100) : 'unknown',
    upstreamProviders:
      r.upstreamProviders === undefined
        ? []
        : list(r.upstreamProviders, 32, (v) => text(v, 200)),
    ...(r.routing === undefined
      ? {}
      : { routing: parseRoutingProfile(r.routing) }),
  };
}
export function parseProject(v: unknown): ServiceProject {
  const r = object(v);
  return {
    id: id(r.id),
    title: text(r.title, 80),
    revision: integer(r.revision, 1),
    ...(r.createdAt === undefined ? {} : { createdAt: date(r.createdAt) }),
    ...(r.updatedAt === undefined ? {} : { updatedAt: date(r.updatedAt) }),
  };
}
export function parseBrief(v: unknown): ServiceBrief {
  const r = object(v);
  let document: BriefDocument | undefined;
  if (r.document != null) {
    try {
      document = parseBriefDocument(r.document);
    } catch {
      return invalid();
    }
  }
  return {
    id: id(r.id),
    projectId: id(r.projectId),
    title: text(r.title, 160),
    revision: integer(r.revision, 1),
    ...(r.body === undefined
      ? {}
      : {
          body: document
            ? renderBriefMarkdown(text(r.title, 160), document)
            : text(r.body, 24000),
        }),
    ...(document ? { document } : {}),
    ...(r.createdAt === undefined ? {} : { createdAt: date(r.createdAt) }),
    ...(r.updatedAt === undefined ? {} : { updatedAt: date(r.updatedAt) }),
  };
}
export function parseRoute(v: unknown): ServiceRoute {
  const r = object(v),
    p = object(r.pricing);
  return {
    versionId: id(r.versionId),
    id: text(r.id, 200),
    version: integer(r.version, 1),
    modelId: text(r.modelId, 300),
    family: text(r.family, 100),
    modality: oneOf(r.modality, ['chat', 'image', 'video']),
    available: bool(r.available),
    expiresAt: date(r.expiresAt),
    card: card(r.card),
    pricing: {
      inputPerMillionUsd6: money(p.inputPerMillionUsd6),
      outputPerMillionUsd6: money(p.outputPerMillionUsd6),
      markupBps: integer(p.markupBps, 0, 10000),
      maxOutputTokens: integer(p.maxOutputTokens, 1, 8192),
      maxInputBytes: integer(p.maxInputBytes, 1, 32768),
    },
  };
}
export function parseCallSnapshot(v: unknown): CallSnapshot {
  const r = object(v),
    b = object(r.billing);
  const billing: CallBilling = {
    state: oneOf(b.state, [
      'held',
      'running',
      'captured',
      'released',
      'reconciliation_pending',
    ]),
    maximumUsd6: nullable(b.maximumUsd6, money),
    actualUsd6: nullable(b.actualUsd6, money),
  };
  if (
    billing.actualUsd6 !== null &&
    (billing.maximumUsd6 === null ||
      BigInt(billing.actualUsd6) > BigInt(billing.maximumUsd6))
  )
    return invalid();
  return {
    id: id(r.id),
    state: oneOf(r.state, [
      'queued',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'reconciliation_pending',
    ]),
    errorCode: nullable(r.errorCode, (v) => text(v, 160)),
    output: text(r.output, 500000, true),
    billing,
    cancelRequested:
      r.cancelRequested === undefined ? false : bool(r.cancelRequested),
  };
}
export function parseComparison(v: unknown): ServiceComparison {
  const r = object(v);
  const calls = unique(
    list(r.calls, 4, (v) => {
      const c = object(v),
        snapshot = parseCallSnapshot(v);
      const outputTruncated =
          c.outputTruncated === undefined ? false : bool(c.outputTruncated),
        outputLength =
          c.outputLength === undefined
            ? snapshot.output.length
            : integer(c.outputLength, 0, 500000);
      if (
        outputLength < snapshot.output.length ||
        (!outputTruncated && outputLength !== snapshot.output.length) ||
        (outputTruncated && outputLength <= snapshot.output.length)
      )
        return invalid();
      return {
        ...snapshot,
        label: text(c.label, 80),
        position: integer(c.position, 0, 3),
        routeVersionId: nullable(c.routeVersionId, id),
        modelId: nullable(c.modelId, (v) => text(v, 300)),
        family: nullable(c.family, (v) => text(v, 100)),
        outputTruncated,
        outputLength,
      };
    }),
    (v) => v.id,
  );
  if (!calls.length || calls.some((c, i) => c.position !== i)) return invalid();
  const groupBilling = object(r.billing);
  const result = {
    id: id(r.id),
    projectId: id(r.projectId),
    prompt: text(r.prompt, 32768),
    createdAt: date(r.createdAt),
    blind: bool(r.blind),
    revealedAt: nullable(r.revealedAt, date),
    votedCallId: nullable(r.votedCallId, id),
    calls,
    billing: {
      maximumUsd6: money(groupBilling.maximumUsd6),
      actualUsd6: nullable(groupBilling.actualUsd6, money),
    },
  };
  if (
    result.billing.actualUsd6 !== null &&
    BigInt(result.billing.actualUsd6) > BigInt(result.billing.maximumUsd6)
  )
    return invalid();
  if (
    result.blind &&
    !result.revealedAt &&
    calls.some(
      (c) =>
        c.routeVersionId !== null ||
        c.modelId !== null ||
        c.family !== null ||
        c.billing.maximumUsd6 !== null ||
        c.billing.actualUsd6 !== null,
    )
  )
    return invalid();
  if (
    (!result.blind || result.revealedAt) &&
    calls.some((c) => c.billing.maximumUsd6 === null)
  )
    return invalid();
  if (result.votedCallId && !calls.some((c) => c.id === result.votedCallId))
    return invalid();
  return result;
}
// Recomputes the integer split: fee = floor(base x bps), burn = ceil(fee x share).
function quotePlatformFee(v: unknown, maximumUsd6: string): QuotePlatformFee {
  const f = object(v);
  const fee: QuotePlatformFee = {
    baseMaximumUsd6: money(f.baseMaximumUsd6),
    platformFeeBps: integer(f.platformFeeBps, 1, 2000),
    burnShareBps: integer(f.burnShareBps, 0, 10000),
    platformFeeMaximumUsd6: money(f.platformFeeMaximumUsd6),
    burnReserveMaximumUsd6: money(f.burnReserveMaximumUsd6),
  };
  const base = BigInt(fee.baseMaximumUsd6),
    platform = (base * BigInt(fee.platformFeeBps)) / 10000n;
  if (
    base < 1n ||
    BigInt(fee.platformFeeMaximumUsd6) !== platform ||
    base + platform !== BigInt(maximumUsd6) ||
    BigInt(fee.burnReserveMaximumUsd6) !==
      (platform * BigInt(fee.burnShareBps) + 9999n) / 10000n
  )
    return invalid();
  return fee;
}
/** Summed fee and burn-reserve maximums across quotes, or null when no fee applies. */
export function quotePlatformFeeTotals(quotes: ComparisonQuote[]) {
  const fees = quotes.flatMap((q) => (q.platformFee ? [q.platformFee] : []));
  if (!fees.length) return null;
  return {
    platformFeeMaximumUsd6: fees
      .reduce((sum, f) => sum + BigInt(f.platformFeeMaximumUsd6), 0n)
      .toString(),
    burnReserveMaximumUsd6: fees
      .reduce((sum, f) => sum + BigInt(f.burnReserveMaximumUsd6), 0n)
      .toString(),
  };
}
export function parseQuoteResponse(
  v: unknown,
  input: ComparisonInput,
): QuoteResponse {
  const r = object(v);
  const quotes = unique(
    list(r.quotes, 4, (v) => {
      const q = object(v);
      const maximumUsd6 = money(q.maximumUsd6);
      return {
        id: id(q.id),
        routeVersionId: id(q.routeVersionId),
        maximumUsd6,
        expiresAt: date(q.expiresAt),
        requestHash: text(q.requestHash, 256),
        markupBps: integer(q.markupBps, 0, 10000),
        modelId: text(q.modelId, 300),
        family: text(q.family, 100),
        card: card(q.card),
        ...(q.platformFee === undefined
          ? {}
          : { platformFee: quotePlatformFee(q.platformFee, maximumUsd6) }),
      };
    }),
    (q) => q.id,
  );
  if (
    quotes.length !== input.items.length ||
    quotes.some(
      (q, i) =>
        q.routeVersionId !== input.items[i].routeVersionId ||
        BigInt(q.maximumUsd6) > 10000000n,
    )
  )
    return invalid();
  const maximumUsd6 = money(r.maximumUsd6);
  if (
    quotes.reduce((sum, q) => sum + BigInt(q.maximumUsd6), 0n) !==
    BigInt(maximumUsd6)
  )
    return invalid();
  return { quotes, maximumUsd6 };
}
export function parseAutoRouteQuote(
  value: unknown,
  input: AutoRouteInput,
): AutoRouteQuote {
  const envelope = object(value),
    r = object(envelope.recommendation);
  const routeVersionId = id(r.routeVersionId);
  const item = input.candidates.find(
    (candidate) => candidate.routeVersionId === routeVersionId,
  );
  if (r.version !== 1 || r.task !== input.task || !item) return invalid();
  const result = parseQuoteResponse(envelope, {
    projectId: input.projectId,
    blind: false,
    items: [item],
  });
  const maximumUsd6 = money(r.maximumUsd6);
  if (
    maximumUsd6 !== result.maximumUsd6 ||
    BigInt(maximumUsd6) > BigInt(input.budgetUsd6)
  )
    return invalid();
  return {
    ...result,
    recommendation: {
      version: 1,
      task: input.task,
      routeVersionId,
      eligibleCount: integer(r.eligibleCount, 1, input.candidates.length),
      maximumUsd6,
      reason: text(r.reason, 500),
    },
  };
}
export function quotedInput(
  input: ComparisonInput,
  quote: QuoteResponse,
  idempotencyKey: string,
): QuotedComparisonInput {
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(idempotencyKey)) return invalid();
  parseQuoteResponse(quote, input);
  return {
    projectId: input.projectId,
    blind: input.blind,
    idempotencyKey,
    items: input.items.map((item, index) => ({
      ...item,
      messages: item.messages.map((message) => ({ ...message })),
      quoteId: quote.quotes[index].id,
    })),
  };
}
export function formatUsd6(value: string): string {
  const amount = BigInt(money(value));
  return `$${amount / 1000000n}.${(amount % 1000000n).toString().padStart(6, '0')}`;
}
/** Display-only USD: cents from $0.01 upward, otherwise every nonzero micro-dollar digit. */
export function formatFriendlyUsd6(value: string): string {
  const amount = BigInt(money(value));
  if (amount > 0n && amount < 10000n)
    return `$0.${amount.toString().padStart(6, '0').replace(/0+$/, '')}`;
  // Round down so a balance or cap is never overstated.
  const cents = amount / 10000n;
  return `$${(cents / 100n).toLocaleString('en-US')}.${(cents % 100n).toString().padStart(2, '0')}`;
}
/** The smaller of a reservation budget and the available balance, when the balance is known. */
export function effectiveReservationCap(
  budgetUsd6: string,
  availableUsd6: string | null | undefined,
) {
  const budget = BigInt(money(budgetUsd6));
  if (availableUsd6 == null) return { usd6: budgetUsd6, limitedByBalance: false };
  const available = BigInt(money(availableUsd6));
  return available < budget
    ? { usd6: available.toString(), limitedByBalance: true }
    : { usd6: budgetUsd6, limitedByBalance: false };
}
export const DEFAULT_PROJECT_TITLE = 'Untitled project';
/** A short project title from a sent question: whitespace collapsed, about 48 characters. */
export function projectTitleFromPrompt(prompt: string, limit = 48): string {
  const characters = Array.from(prompt.replace(/\s+/g, ' ').trim());
  if (characters.length <= limit) return characters.join('');
  const cut = characters.slice(0, limit - 1).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space >= limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
export function workspaceErrorMessage(error: unknown) {
  return error instanceof WorkspaceError
    ? error.message
    : 'The workspace request did not complete. Refresh to read the saved state.';
}
export function isPendingCall(state: string) {
  return state === 'queued' || state === 'running';
}
/** A stopped call whose upstream is still draining for exact billing. */
export function isStoppingCall(call: {
  state: string;
  cancelRequested?: boolean;
}) {
  return isPendingCall(call.state) && call.cancelRequested === true;
}
/** Shown when a stop could not drain in time; the call stays held for reconciliation. */
export const CANCEL_DRAIN_TIMEOUT = 'CANCEL_DRAIN_TIMEOUT';

async function boundedJson(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  if (
    !response.body ||
    Number(response.headers.get('content-length') ?? 0) > maximumBytes
  )
    return invalid();
  const reader = response.body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0,
    result = '';
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumBytes)
        throw new WorkspaceError(
          'RESPONSE_TOO_LARGE',
          'This saved result is too large to load in this view. No saved data was changed.',
        );
      result += decoder.decode(chunk.value, { stream: true });
    }
    signal?.throwIfAborted();
    return JSON.parse(result + decoder.decode());
  } catch (error) {
    if (
      error instanceof WorkspaceError ||
      (error instanceof Error && error.name === 'AbortError')
    )
      throw error;
    return invalid();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Fixed same-origin endpoints; never retries a mutation or persists credentials/content. */
export function createWorkspaceClient(options: ClientOptions = {}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const accountHeaders: Record<string, string> = options.accountId
    ? { 'X-Conclave-Account-Id': id(options.accountId) }
    : {};
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    maximumBytes = 1048576,
  ): Promise<Record<string, unknown>> {
    options.signal?.throwIfAborted();
    let response: Response;
    try {
      response = await fetcher(`/api/${path}`, {
        method,
        credentials: 'same-origin',
        mode: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: options.signal,
        headers: {
          Accept: 'application/json',
          ...accountHeaders,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new WorkspaceError(
        'NETWORK_ERROR',
        'The service could not be reached. An interrupted submission can be retried with its original request key.',
      );
    }
    if (!response.ok) {
      const value = await boundedJson(response, 65536, options.signal).catch(
        () => ({}),
      );
      options.signal?.throwIfAborted();
      const envelope =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      const inner =
        envelope.error &&
        typeof envelope.error === 'object' &&
        !Array.isArray(envelope.error)
          ? (envelope.error as Record<string, unknown>)
          : {};
      const rawCode = envelope.code ?? inner.code;
      const code =
        typeof rawCode === 'string' && /^[A-Z_]{1,80}$/.test(rawCode)
          ? rawCode
          : 'REQUEST_FAILED';
      throw new WorkspaceError(
        code,
        response.status === 401
          ? 'Sign in again to access your workspace.'
          : response.status === 429
            ? 'Too many requests. Wait a moment, then try again.'
            : (messages[code] ??
              'The request did not complete. Refresh to read the saved state before trying again.'),
        response.status,
      );
    }
    if (!response.headers.get('content-type')?.includes('application/json'))
      return invalid();
    return object(await boundedJson(response, maximumBytes, options.signal));
  }
  const page = <T>(
    r: Record<string, unknown>,
    field: string,
    limit: number,
    parse: (v: unknown) => T,
  ): Page<T> => ({
    items: list(r[field], limit, parse),
    nextCursor: cursor(r.nextCursor),
  });
  const query = (values: Record<string, string | null | undefined>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values))
      if (value) params.set(key, value);
    return `?${params}`;
  };
  return {
    async capabilities(): Promise<ServiceCapabilities> {
      const r = await request('capabilities'),
        chat = object(r.chat);
      return {
        mode: oneOf(r.mode, ['preview', 'service']),
        chat: {
          configured: bool(chat.configured),
          reason: typeof chat.reason === 'string' ? text(chat.reason, 160) : '',
        },
      };
    },
    async session(): Promise<AccountSession | null> {
      try {
        const r = await request('auth/session');
        return {
          accountId: id(r.accountId),
          identities: list(r.identities, 16, (v) => {
            const entry = object(v);
            return {
              kind: oneOf(entry.kind, ['solana', 'passkey']),
              subject: text(entry.subject, 1024),
            };
          }),
        };
      } catch (error) {
        if (error instanceof WorkspaceError && error.status === 401)
          return null;
        throw error;
      }
    },
    async routes() {
      const r = await request('routes');
      return unique(
        list(r.routes, 256, parseRoute),
        (route) => route.versionId,
      );
    },
    async balance(): Promise<ServiceBalance> {
      const r = await request('balance');
      if (r.currency !== 'USD6') return invalid();
      return {
        availableUsd6: money(r.availableUsd6),
        reservedUsd6: money(r.reservedUsd6),
        currency: 'USD6',
        ...(r.internalTestCredit === undefined
          ? {}
          : {
              internalTestCreditUsd6: money(
                object(r.internalTestCredit).grantedUsd6,
              ),
            }),
      };
    },
    async projects(after?: string | null) {
      return page(
        await request(`projects${query({ cursor: after })}`),
        'projects',
        50,
        parseProject,
      );
    },
    async createProject(title: string) {
      return parseProject(
        (await request('projects', 'POST', { title })).project,
      );
    },
    async renameProject(projectId: string, title: string, revision: number) {
      return parseProject(
        (
          await request(`projects/${id(projectId)}`, 'PATCH', {
            title,
            revision,
          })
        ).project,
      );
    },
    async archiveProject(projectId: string, revision: number) {
      const r = await request(`projects/${id(projectId)}`, 'DELETE', {
        revision,
      });
      if (r.archived !== true) return invalid();
    },
    async comparisons(projectId: string, after?: string | null) {
      const r = await request(
        `comparisons${query({ projectId: id(projectId), cursor: after })}`,
        'GET',
        undefined,
        64 * 1024 * 1024,
      );
      const result = page(r, 'comparisons', 20, parseComparison);
      unique(result.items, (c) => c.id);
      if (result.items.some((c) => c.projectId !== projectId)) return invalid();
      return result;
    },
    async comparison(comparisonId: string) {
      const result = parseComparison(
        (
          await request(
            `comparisons/${id(comparisonId)}`,
            'GET',
            undefined,
            16 * 1024 * 1024,
          )
        ).comparison,
      );
      if (result.id !== comparisonId) return invalid();
      return result;
    },
    async quote(input: ComparisonInput) {
      return parseQuoteResponse(
        await request('comparison-quotes', 'POST', input),
        input,
      );
    },
    async autoQuote(input: AutoRouteInput) {
      id(input.projectId);
      if (
        !ROUTING_TASKS.includes(input.task) ||
        input.privacy !== 'standard' ||
        BigInt(money(input.budgetUsd6)) < 1n ||
        BigInt(input.budgetUsd6) > 10000000n ||
        input.candidates.length < 1 ||
        input.candidates.length > 16 ||
        new Set(input.candidates.map((item) => item.routeVersionId)).size !==
          input.candidates.length
      )
        return invalid();
      const output = integer(input.candidates[0].maxOutputTokens, 1, 8192);
      const question = text(
        input.candidates[0].messages.at(-1)?.content,
        32768,
      );
      for (const candidate of input.candidates) {
        id(candidate.routeVersionId);
        if (
          candidate.privacy !== 'standard' ||
          candidate.maxOutputTokens !== output ||
          candidate.messages.at(-1)?.role !== 'user' ||
          candidate.messages.at(-1)?.content !== question
        )
          return invalid();
      }
      return parseAutoRouteQuote(
        await request('auto-route-quotes', 'POST', input),
        input,
      );
    },
    async submit(input: QuotedComparisonInput) {
      const r = await request('comparisons', 'POST', input, 16 * 1024 * 1024);
      const comparison = parseComparison(r.comparison);
      if (
        comparison.projectId !== input.projectId ||
        comparison.prompt !== input.items[0]?.messages.at(-1)?.content ||
        comparison.calls.length !== input.items.length ||
        comparison.blind !== input.blind
      )
        return invalid();
      return { comparison, replayed: bool(r.replayed) };
    },
    async comparisonAction(
      comparisonId: string,
      action: 'cancel' | 'reveal' | 'vote',
      callId?: string,
    ) {
      const r = await request(
        `comparisons/${id(comparisonId)}/${action}`,
        'POST',
        action === 'vote' ? { callId: id(callId) } : {},
        16 * 1024 * 1024,
      );
      const result = parseComparison(r.comparison);
      if (result.id !== comparisonId) return invalid();
      return result;
    },
    async briefs(projectId?: string, after?: string | null) {
      return page(
        await request(
          `briefs${query({ projectId: projectId ? id(projectId) : undefined, cursor: after })}`,
        ),
        'briefs',
        50,
        parseBrief,
      );
    },
    async brief(briefId: string) {
      const result = parseBrief((await request(`briefs/${id(briefId)}`)).brief);
      if (result.id !== briefId || result.body === undefined) return invalid();
      return result;
    },
    async saveBrief(brief: {
      id?: string;
      projectId: string;
      title: string;
      body: string;
      revision?: number;
    }) {
      return parseBrief(
        (
          await request(
            brief.id ? `briefs/${id(brief.id)}` : 'briefs',
            brief.id ? 'PATCH' : 'POST',
            brief.id
              ? {
                  title: brief.title,
                  body: brief.body,
                  revision: brief.revision,
                }
              : {
                  projectId: id(brief.projectId),
                  title: brief.title,
                  body: brief.body,
                },
          )
        ).brief,
      );
    },
    async briefFromCalls(input: {
      projectId: string;
      title: string;
      callIds: string[];
      idempotencyKey: string;
    }) {
      const result = parseBrief(
        (await request('briefs/from-calls', 'POST', input)).brief,
      );
      if (
        result.projectId !== input.projectId ||
        !result.document ||
        result.document.evidence.length !== input.callIds.length ||
        result.document.evidence.some((e, i) => e.callId !== input.callIds[i])
      )
        return invalid();
      return result;
    },
    async updateBriefDocument(
      briefId: string,
      title: string,
      revision: number,
      analysis: BriefAnalysis,
    ) {
      const result = parseBrief(
        (
          await request(`briefs/${id(briefId)}/document`, 'PATCH', {
            title,
            revision,
            analysis,
          })
        ).brief,
      );
      if (
        result.id !== briefId ||
        result.revision !== revision + 1 ||
        !result.document
      )
        return invalid();
      return result;
    },
    async deleteBrief(briefId: string, revision: number) {
      const r = await request(`briefs/${id(briefId)}`, 'DELETE', { revision });
      if (r.deleted !== true) return invalid();
    },
    async streamCall(
      callId: string,
      onSnapshot: (value: CallSnapshot) => void,
    ): Promise<void> {
      const ownedId = id(callId);
      options.signal?.throwIfAborted();
      const response = await fetcher(`/api/calls/${ownedId}/events`, {
        credentials: 'same-origin',
        mode: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: options.signal,
        headers: { Accept: 'text/event-stream', ...accountHeaders },
      });
      if (response.status === 401)
        throw new WorkspaceError(
          'SESSION_REQUIRED',
          'Sign in again to access your workspace.',
          401,
        );
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get('content-type')?.includes('text/event-stream')
      )
        throw new WorkspaceError(
          'STREAM_UNAVAILABLE',
          'The live connection was interrupted. Saved requests can be reloaded.',
          response.status,
        );
      const reader = response.body.getReader(),
        decoder = new TextDecoder('utf-8', { fatal: true });
      let buffer = '';
      try {
        while (true) {
          options.signal?.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer = (
            buffer + decoder.decode(chunk.value, { stream: true })
          ).replace(/\r\n/g, '\n');
          if (buffer.length > 4 * 1024 * 1024) return invalid();
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const lines = block.split('\n'),
              event = lines
                .find((line) => line.startsWith('event:'))
                ?.slice(6)
                .trim();
            if (event === 'unavailable')
              throw new WorkspaceError(
                'STREAM_UNAVAILABLE',
                'The live connection was interrupted. Saved requests can be reloaded.',
              );
            if (event === 'complete') return;
            if (event !== 'snapshot') continue;
            const data = lines
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            let value: unknown;
            try {
              value = JSON.parse(data);
            } catch {
              return invalid();
            }
            const snapshot = parseCallSnapshot(value);
            if (snapshot.id !== ownedId) return invalid();
            options.signal?.throwIfAborted();
            onSnapshot(snapshot);
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  };
}
