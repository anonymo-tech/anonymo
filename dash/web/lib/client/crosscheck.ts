import type {
  CrossCheckPlan,
  SourceSnapshot,
  Reviewer,
  Claim,
  CacheDescriptor,
} from '../../server/crosscheck/core.ts';
import type {
  CrossCheckResult,
  ValidatedReview,
  QuoteMatch,
  ClaimResult,
} from '../../server/crosscheck/review.ts';
import type { GuardScanResult } from '../guards/index.ts';

export type { CrossCheckPlan, SourceSnapshot, Reviewer, CrossCheckResult };
export type CrossCheckCapability = {
  configured: boolean;
  reason: string;
  limits: { calls: number; maximumUsd6: string; quoteSeconds: number };
};
export type ReviewerRoster = {
  id: string;
  label: string;
  version: number;
  reviewedAt: string;
  expiresAt: string;
  reviewers: Reviewer[];
};
export type SourceSummary = Pick<
  SourceSnapshot,
  | 'id'
  | 'title'
  | 'uri'
  | 'acquisition'
  | 'capturedAtMs'
  | 'contentHash'
  | 'snapshotHash'
> & { sourceBytes: number };
export type RunSummary = {
  id: string;
  rosterId: string;
  preparedAt: string;
  expiresAt: string;
  status: 'prepared' | 'reviewed';
};
export type CrossCheckExecution = {
  state:
    | 'not_started'
    | 'queued'
    | 'running'
    | 'awaiting_evaluation'
    | 'incomplete'
    | 'reviewed';
  calls: {
    id: string;
    claimId: string;
    reviewerId: string;
    state: string;
    errorCode: string | null;
    billingState: string;
    actualUsd6: string | null;
  }[];
  maximumUsd6: string | null;
  actualUsd6: string | null;
  evaluationNeedsAttention?: boolean;
};
export type CrossCheckView = {
  id: string;
  projectId: string;
  rosterId: string;
  status: 'prepared' | 'reviewed';
  label: string;
  plan: CrossCheckPlan;
  result: CrossCheckResult | null;
  cacheUsable: boolean;
  execution: CrossCheckExecution | null;
};
export type QuoteTerm = {
  claimId: string;
  reviewerId: string;
  routeVersionId: string;
  modelId: string;
  family: string;
  distribution: 'proprietary' | 'open-weight';
  reviewerVersion: string;
  maximumUsd6: string;
  markupBps: number;
  card: {
    level: string;
    retentionDisclosure: string;
    evidenceDate: string;
    evidenceUrl: string;
  };
};
export type CrossCheckQuote = {
  quoteGroupId: string;
  runId: string;
  maximumUsd6: string;
  maxOutputTokens: number;
  reviewCount: number;
  terms: QuoteTerm[];
  expiresAt: string;
};
export type CrossCheckApproval = {
  quoteGroupId: string;
  idempotencyKey: string;
  approveMaximumUsd6: string;
};
export class CrossCheckClientError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = 'CrossCheckClientError';
    this.code = code;
    this.status = status;
  }
}
const invalid = (): never => {
  throw new CrossCheckClientError(
    'INVALID_RESPONSE',
    'The Cross-Check response could not be checked. Read the saved request again before continuing.',
  );
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
};
const text = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    return invalid();
  return value;
};
const id = (value: unknown): string => {
  const result = text(value, 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      result,
    )
  )
    return invalid();
  return result;
};
const token = (value: unknown): string => {
  const result = text(value, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/.test(result)) return invalid();
  return result;
};
const hash = (value: unknown): string => {
  const result = text(value, 64);
  if (!/^[a-f0-9]{64}$/.test(result)) return invalid();
  return result;
};
const amount = (value: unknown): string => {
  const result = text(value, 19);
  if (!/^(0|[1-9][0-9]{0,18})$/.test(result)) return invalid();
  return result;
};
const integer = (
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number => {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    return invalid();
  return value;
};
const bool = (value: unknown): boolean => {
  if (typeof value !== 'boolean') return invalid();
  return value;
};
const nullable = <T>(value: unknown, parser: (v: unknown) => T): T | null =>
  value === null ? null : parser(value);
const date = (value: unknown): string => {
  const result = text(value, 40);
  if (!result.endsWith('Z') || !Number.isFinite(Date.parse(result)))
    return invalid();
  return result;
};
const list = <T>(
  value: unknown,
  max: number,
  parser: (v: unknown) => T,
): T[] => {
  if (!Array.isArray(value) || value.length > max) return invalid();
  return value.map(parser);
};
const oneOf = <T extends string>(value: unknown, choices: readonly T[]): T => {
  if (!choices.includes(value as T)) return invalid();
  return value as T;
};
const unique = <T>(values: T[], key: (item: T) => string): T[] => {
  if (new Set(values.map(key)).size !== values.length) return invalid();
  return values;
};
const normalize = (value: string) => value.replace(/\s+/gu, ' ').trim();
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const timestamp = (v: unknown) => integer(v, 0, 8640000000000000);
const uri = (v: unknown) =>
  nullable(v, (value) => {
    const result = text(value, 2048);
    try {
      const url = new URL(result);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        return invalid();
      return result;
    } catch {
      return invalid();
    }
  });
function reviewer(value: unknown): Reviewer {
  const r = object(value);
  return {
    id: id(r.id),
    family: token(r.family),
    modelId: token(r.modelId),
    version: text(r.version, 256),
    distribution: oneOf(r.distribution, ['proprietary', 'open-weight']),
  };
}
function reviewers(value: unknown) {
  const items = unique(list(value, 8, reviewer), (item) => item.id);
  unique(items, (item) => item.family);
  unique(items, (item) => item.modelId);
  if (
    items.length < 3 ||
    new Set(items.map((item) => item.distribution)).size !== 2
  )
    return invalid();
  return items;
}
function claim(value: unknown): Claim {
  const c = object(value);
  return { id: token(c.id), text: text(c.text, 2000), hash: hash(c.hash) };
}
function cache(value: unknown): CacheDescriptor {
  const c = object(value);
  const result = {
    key: hash(c.key),
    scopeHash: hash(c.scopeHash),
    createdAtMs: timestamp(c.createdAtMs),
    expiresAtMs: timestamp(c.expiresAtMs),
    ttlMs: integer(c.ttlMs, 1, 86400000),
  };
  if (result.expiresAtMs - result.createdAtMs !== result.ttlMs)
    return invalid();
  return result;
}
export function parseSource(
  value: unknown,
  accountId: string,
  projectId?: string,
): SourceSnapshot {
  const r = object(value),
    scope = object(r.scope);
  if (
    r.schema !== 'source-snapshot-v1' ||
    r.acquisition !== 'provided-text' ||
    r.visibility !== 'private' ||
    scope.accountId !== accountId ||
    (projectId && scope.scopeId !== projectId)
  )
    return invalid();
  const sourceText = text(r.text, 65536),
    normalizedText = text(r.normalizedText, 65536);
  if (bytes(sourceText) > 65536 || normalize(sourceText) !== normalizedText)
    return invalid();
  return {
    schema: 'source-snapshot-v1',
    id: id(r.id),
    title: text(r.title, 300),
    uri: uri(r.uri),
    acquisition: 'provided-text',
    visibility: 'private',
    scope: {
      accountId: id(scope.accountId),
      scopeId: id(scope.scopeId),
      revision: token(scope.revision),
    },
    capturedAtMs: timestamp(r.capturedAtMs),
    text: sourceText,
    normalizedText,
    contentHash: hash(r.contentHash),
    snapshotHash: hash(r.snapshotHash),
  };
}
function parsePlan(
  value: unknown,
  accountId: string,
  projectId: string,
): CrossCheckPlan {
  const p = object(value),
    scope = object(p.scope);
  if (
    p.schema !== 'crosscheck-v1' ||
    scope.accountId !== accountId ||
    scope.scopeId !== projectId
  )
    return invalid();
  const sources = unique(
      list(p.sources, 8, (source) => parseSource(source, accountId, projectId)),
      (source) => source.id,
    ),
    claims = unique(list(p.claims, 24, claim), (claim) => claim.id);
  if (
    !sources.length ||
    !claims.length ||
    sources.reduce((total, source) => total + bytes(source.text), 0) > 131072
  )
    return invalid();
  const result = {
    schema: 'crosscheck-v1' as const,
    scope: { accountId, scopeId: projectId, revision: token(scope.revision) },
    scopeHash: hash(p.scopeHash),
    claims,
    sources,
    reviewers: reviewers(p.reviewers),
    claimSetHash: hash(p.claimSetHash),
    sourceSetHash: hash(p.sourceSetHash),
    reviewerSetHash: hash(p.reviewerSetHash),
    requestHash: hash(p.requestHash),
    createdAtMs: timestamp(p.createdAtMs),
    cache: cache(p.cache),
  };
  if (
    result.cache.scopeHash !== result.scopeHash ||
    result.cache.createdAtMs !== result.createdAtMs
  )
    return invalid();
  return result;
}
function quoteMatch(value: unknown, plan: CrossCheckPlan): QuoteMatch {
  const q = object(value),
    sourceId = id(q.sourceId),
    source = plan.sources.find((source) => source.id === sourceId);
  const result = {
    sourceId,
    sourceHash: hash(q.sourceHash),
    quote: text(q.quote, 4000),
    normalizedQuote: text(q.normalizedQuote, 4000),
    normalizedStart: integer(q.normalizedStart),
    normalizedEnd: integer(q.normalizedEnd),
    offsetUnit: oneOf(q.offsetUnit, ['utf16-code-unit']),
    normalization: oneOf(q.normalization, ['whitespace-v1']),
  };
  if (
    !source ||
    result.sourceHash !== source.snapshotHash ||
    normalize(result.quote) !== result.normalizedQuote ||
    result.normalizedEnd - result.normalizedStart !==
      result.normalizedQuote.length ||
    source.normalizedText.slice(
      result.normalizedStart,
      result.normalizedEnd,
    ) !== result.normalizedQuote
  )
    return invalid();
  return result;
}
function parseResult(value: unknown, plan: CrossCheckPlan): CrossCheckResult {
  const r = object(value);
  if (r.schema !== 'crosscheck-result-v1') return invalid();
  for (const key of [
    'requestHash',
    'scopeHash',
    'claimSetHash',
    'sourceSetHash',
    'reviewerSetHash',
  ] as const)
    if (r[key] !== plan[key]) return invalid();
  const claims = unique(
    list(r.claims, 24, (value): ClaimResult => {
      const c = object(value),
        savedClaim = claim(c.claim),
        original = plan.claims.find((item) => item.id === savedClaim.id);
      if (
        !original ||
        original.hash !== savedClaim.hash ||
        original.text !== savedClaim.text
      )
        return invalid();
      const reviews = unique(
        list(c.reviews, 8, (value): ValidatedReview => {
          const v = object(value),
            reviewerId = id(v.reviewerId),
            original = plan.reviewers.find((item) => item.id === reviewerId);
          if (
            !original ||
            v.family !== original.family ||
            v.modelId !== original.modelId ||
            v.version !== original.version
          )
            return invalid();
          const result: ValidatedReview = {
            reviewerId,
            family: original.family,
            modelId: original.modelId,
            version: original.version,
            valid: bool(v.valid),
            verdict: nullable(v.verdict, (value) =>
              oneOf(value, [
                'supported',
                'contradicted',
                'insufficient_evidence',
              ]),
            ),
            rationale: nullable(v.rationale, (value) => text(value, 2000)),
            quotes: list(v.quotes, 8, (value) => quoteMatch(value, plan)),
            invalidReason: nullable(v.invalidReason, (value) =>
              oneOf(value, [
                'missing_review',
                'duplicate_review',
                'invalid_json',
                'invalid_shape',
                'missing_evidence',
                'unknown_source',
                'source_hash_mismatch',
                'quote_not_found',
              ]),
            ),
          };
          if (
            result.valid
              ? result.invalidReason !== null ||
                result.verdict === null ||
                result.rationale === null ||
                (result.verdict !== 'insufficient_evidence' &&
                  !result.quotes.length)
              : result.invalidReason === null ||
                result.verdict !== null ||
                result.rationale !== null ||
                result.quotes.length !== 0
          )
            return invalid();
          return result;
        }),
        (review) => review.reviewerId,
      );
      if (reviews.length !== plan.reviewers.length) return invalid();
      const valid = reviews.filter((review) => review.valid),
        opinions = new Set(valid.map((review) => review.verdict));
      const expected =
        valid.length === reviews.length &&
        opinions.size === 1 &&
        opinions.has('supported')
          ? 'HOLDS'
          : valid.length === reviews.length &&
              opinions.size === 1 &&
              opinions.has('contradicted')
            ? 'DOES_NOT_HOLD'
            : 'NO_CONSENSUS';
      const uncertainty: ClaimResult['uncertainty'] = list(
        c.uncertainty,
        3,
        (value) =>
          oneOf(value, [
            'missing_valid_review',
            'insufficient_evidence',
            'disagreement',
          ] as const),
      );
      if (new Set(uncertainty).size !== uncertainty.length) return invalid();
      const dissent = opinions.has('supported') && opinions.has('contradicted');
      if (
        c.verdict !== expected ||
        c.validFamilyCount !== valid.length ||
        c.dissent !== dissent ||
        uncertainty.includes('missing_valid_review') !==
          valid.length < reviews.length ||
        uncertainty.includes('insufficient_evidence') !==
          opinions.has('insufficient_evidence') ||
        uncertainty.includes('disagreement') !== dissent
      )
        return invalid();
      return {
        claim: savedClaim,
        verdict: expected,
        reviews,
        validFamilyCount: valid.length,
        dissent,
        uncertainty,
      };
    }),
    (result) => result.claim.id,
  );
  if (claims.length !== plan.claims.length) return invalid();
  const expected = claims.every((c) => c.verdict === 'HOLDS')
    ? 'HOLDS'
    : claims.every((c) => c.verdict === 'DOES_NOT_HOLD')
      ? 'DOES_NOT_HOLD'
      : claims.every((c) => c.verdict !== 'NO_CONSENSUS')
        ? 'PARTLY'
        : 'NO_CONSENSUS';
  if (r.verdict !== expected) return invalid();
  const resultCache = cache(r.cache);
  if (
    resultCache.key !== plan.cache.key ||
    resultCache.scopeHash !== plan.scopeHash ||
    resultCache.expiresAtMs !== plan.cache.expiresAtMs
  )
    return invalid();
  return {
    schema: 'crosscheck-result-v1',
    requestHash: plan.requestHash,
    scopeHash: plan.scopeHash,
    claimSetHash: plan.claimSetHash,
    sourceSetHash: plan.sourceSetHash,
    reviewerSetHash: plan.reviewerSetHash,
    verdict: expected,
    claims,
    finishedAtMs: timestamp(r.finishedAtMs),
    cache: resultCache,
    limitation: text(r.limitation, 2000),
    resultHash: hash(r.resultHash),
  };
}
export function parseExecution(value: unknown): CrossCheckExecution {
  const e = object(value),
    state = oneOf(e.state, [
      'not_started',
      'queued',
      'running',
      'awaiting_evaluation',
      'incomplete',
      'reviewed',
    ]);
  const calls = unique(
    list(e.calls, 24, (value) => {
      const c = object(value);
      return {
        id: id(c.id),
        claimId: token(c.claimId),
        reviewerId: id(c.reviewerId),
        state: oneOf(c.state, [
          'queued',
          'running',
          'succeeded',
          'failed',
          'cancelled',
          'reconciliation_pending',
        ]),
        errorCode: nullable(c.errorCode, (value) => text(value, 160)),
        billingState: oneOf(c.billingState, [
          'held',
          'running',
          'captured',
          'released',
          'reconciliation_pending',
        ]),
        actualUsd6: nullable(c.actualUsd6, amount),
      };
    }),
    (call) => call.id,
  );
  const maximumUsd6 = nullable(e.maximumUsd6, amount),
    actualUsd6 = nullable(e.actualUsd6, amount);
  if (
    state === 'not_started'
      ? calls.length !== 0 || maximumUsd6 !== null || actualUsd6 !== null
      : !calls.length || maximumUsd6 === null
  )
    return invalid();
  if (
    actualUsd6 !== null &&
    (maximumUsd6 === null || BigInt(actualUsd6) > BigInt(maximumUsd6))
  )
    return invalid();
  return {
    state,
    calls,
    maximumUsd6,
    actualUsd6,
    ...(e.evaluationNeedsAttention === undefined
      ? {}
      : { evaluationNeedsAttention: bool(e.evaluationNeedsAttention) }),
  };
}
export function parseCrossCheck(
  value: unknown,
  accountId: string,
  projectId?: string,
): CrossCheckView {
  const v = object(value),
    ownedProject = id(v.projectId);
  if (projectId && ownedProject !== projectId) return invalid();
  const plan = parsePlan(v.plan, accountId, ownedProject),
    result = v.result === null ? null : parseResult(v.result, plan),
    execution = object(v.execution);
  const view = {
    id: id(v.id),
    projectId: ownedProject,
    rosterId: id(v.rosterId),
    status: oneOf(v.status, ['prepared', 'reviewed']),
    label: text(v.label, 200),
    plan,
    result,
    cacheUsable: bool(v.cacheUsable),
    execution: 'state' in execution ? parseExecution(execution) : null,
  };
  if (
    (view.status === 'reviewed') !== !!result ||
    (view.cacheUsable && !result)
  )
    return invalid();
  if (view.execution)
    for (const call of view.execution.calls)
      if (
        !plan.claims.some((claim) => claim.id === call.claimId) ||
        !plan.reviewers.some((reviewer) => reviewer.id === call.reviewerId)
      )
        return invalid();
  return view;
}
export function parseCrossCheckQuote(
  value: unknown,
  run: CrossCheckView,
): CrossCheckQuote {
  const q = object(value);
  if (q.runId !== run.id) return invalid();
  const terms = unique(
    list(q.terms, 24, (value): QuoteTerm => {
      const t = object(value),
        card = object(t.card);
      return {
        claimId: token(t.claimId),
        reviewerId: id(t.reviewerId),
        routeVersionId: id(t.routeVersionId),
        modelId: token(t.modelId),
        family: token(t.family),
        distribution: oneOf(t.distribution, ['proprietary', 'open-weight']),
        reviewerVersion: text(t.reviewerVersion, 256),
        maximumUsd6: amount(t.maximumUsd6),
        markupBps: integer(t.markupBps, 0, 10000),
        card: {
          level: text(card.level, 80),
          retentionDisclosure: text(card.retentionDisclosure, 8000),
          evidenceDate: text(card.evidenceDate, 40),
          evidenceUrl: text(card.evidenceUrl, 2048),
        },
      };
    }),
    (term) => `${term.claimId}:${term.reviewerId}`,
  );
  const maximumUsd6 = amount(q.maximumUsd6),
    reviewCount = integer(q.reviewCount, 3, 24);
  if (
    terms.length !== reviewCount ||
    terms.length !== run.plan.claims.length * run.plan.reviewers.length ||
    BigInt(maximumUsd6) > 10000000n ||
    BigInt(maximumUsd6) < 1n ||
    terms.reduce((sum, term) => sum + BigInt(term.maximumUsd6), 0n) !==
      BigInt(maximumUsd6)
  )
    return invalid();
  for (const term of terms) {
    const reviewer = run.plan.reviewers.find(
      (item) => item.id === term.reviewerId,
    );
    if (
      !run.plan.claims.some((item) => item.id === term.claimId) ||
      !reviewer ||
      term.routeVersionId !== reviewer.id ||
      term.family !== reviewer.family ||
      term.modelId !== reviewer.modelId ||
      term.reviewerVersion !== reviewer.version ||
      term.distribution !== reviewer.distribution
    )
      return invalid();
  }
  return {
    quoteGroupId: id(q.quoteGroupId),
    runId: run.id,
    maximumUsd6,
    reviewCount,
    maxOutputTokens: integer(q.maxOutputTokens, 1, 8192),
    terms,
    expiresAt: date(q.expiresAt),
  };
}
export function makeCrossCheckApproval(
  quote: CrossCheckQuote,
  key: string,
): CrossCheckApproval {
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(key)) return invalid();
  return Object.freeze({
    quoteGroupId: quote.quoteGroupId,
    idempotencyKey: key,
    approveMaximumUsd6: quote.maximumUsd6,
  });
}
export async function guardCrossCheckText(
  check: (text: string) => Promise<GuardScanResult>,
  values: readonly string[],
): Promise<string[]> {
  const warnings = new Set<string>();
  for (const value of values) {
    const result = await check(value);
    if (result.findings.some((finding) => finding.severity === 'block'))
      throw new CrossCheckClientError(
        'SENSITIVE_CONTENT',
        'The content check blocked this text. Remove secrets or unsupported input before saving or sending. Nothing from this action was sent.',
      );
    for (const finding of result.findings)
      if (finding.severity === 'warning') warnings.add(finding.message);
  }
  return [...warnings];
}
const errors: Record<string, string> = {
  SENSITIVE_CONTENT:
    'Remove or redact secret-like content before saving or sending.',
  CROSSCHECK_EXECUTION_DISABLED:
    'Cross-Check execution is not enabled by the operator. Prepared plans are not model reviews.',
  CROSSCHECK_ROSTER_UNAVAILABLE:
    'A current reviewed roster of independent model families is required.',
  CROSSCHECK_ALREADY_STARTED:
    'This plan already has an execution. Read its saved status; do not start another request.',
  CROSSCHECK_QUOTE_EXPIRED:
    'The quote expired. Read the plan, then request a new quote if no execution exists.',
  CROSSCHECK_APPROVAL_MISMATCH:
    'The approved amount does not match the quote. No new approval was accepted.',
  CROSSCHECK_STORAGE_LIMIT:
    'This project reached its source or Cross-Check storage limit.',
  CROSSCHECK_CALL_LIMIT:
    'Choose fewer claims for this roster. One execution supports at most 24 reviews.',
  CROSSCHECK_BUDGET_LIMIT:
    'This review exceeds the current maximum group reservation.',
  INSUFFICIENT_BALANCE:
    'There is not enough available balance to reserve these reviews.',
  INSUFFICIENT_FUNDS:
    'There is not enough available balance to reserve these reviews.',
  PROMPT_TOO_LARGE:
    'These claims and source snapshots exceed a reviewer route’s input limit. Choose shorter source excerpts.',
  INVALID_CROSSCHECK:
    'Check the claim text, source sizes, and source reference fields.',
  CROSSCHECK_CONTENT_UNAVAILABLE:
    'The saved Cross-Check could not be verified. No result is shown.',
  IDEMPOTENCY_CONFLICT:
    'This request key belongs to another execution. Read the saved status before continuing.',
};
export function crossCheckErrorMessage(error: unknown): string {
  return error instanceof CrossCheckClientError
    ? error.message
    : 'The Cross-Check request did not complete. Read its saved status before trying again.';
}

export function createCrossCheckClient(
  accountId: string,
  options: {
    signal?: AbortSignal;
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {},
) {
  const owner = id(accountId),
    fetcher = options.fetch ?? globalThis.fetch;
  async function readResponse(
    signal: AbortSignal,
    path: string,
    method = 'GET',
    body?: unknown,
    max = 1048576,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetcher(`/api/${path}`, {
        method,
        credentials: 'same-origin',
        mode: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal,
        headers: {
          Accept: 'application/json',
          'X-Conclave-Account-Id': owner,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new CrossCheckClientError(
        'NETWORK_ERROR',
        'The service could not be reached. An interrupted approval must be recovered with the original request key.',
      );
    }
    signal.throwIfAborted();
    if (response.status === 401) {
      void response.body?.cancel().catch(() => {});
      throw new CrossCheckClientError(
        'ACCOUNT_CHANGED',
        'Your account session changed or expired. Sign in again.',
        401,
      );
    }
    const reader = response.body?.getReader(),
      limit = response.ok ? max : 65536;
    if (!reader) return invalid();
    let encoded = '',
      size = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let parsed: unknown;
    try {
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > limit)
          throw new CrossCheckClientError(
            'RESPONSE_TOO_LARGE',
            'The response exceeds this view’s read limit. Read saved status; recover an interrupted approval with its original request key.',
          );
        encoded += decoder.decode(part.value, { stream: true });
      }
      signal.throwIfAborted();
      try {
        parsed = JSON.parse(encoded + decoder.decode());
      } catch {
        if (response.ok) return invalid();
        parsed = {};
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!response.ok) {
      const envelope =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {},
        inner =
          envelope.error &&
          typeof envelope.error === 'object' &&
          !Array.isArray(envelope.error)
            ? (envelope.error as Record<string, unknown>)
            : {};
      const code =
        typeof inner.code === 'string' && /^[A-Z_]{1,80}$/.test(inner.code)
          ? inner.code
          : 'REQUEST_FAILED';
      throw new CrossCheckClientError(
        code,
        response.status === 429
          ? 'Too many requests. Wait a moment before trying again.'
          : (errors[code] ??
              'The Cross-Check request did not complete. Read the saved status before trying again.'),
        response.status,
      );
    }
    if (!response.headers.get('content-type')?.includes('application/json'))
      return invalid();
    return object(parsed);
  }
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    max = 1048576,
  ): Promise<Record<string, unknown>> {
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      Math.max(1, Math.min(options.timeoutMs ?? 30000, 60000)),
    );
    try {
      return await readResponse(controller.signal, path, method, body, max);
    } catch (failure) {
      if (timedOut && !options.signal?.aborted)
        throw new CrossCheckClientError(
          'REQUEST_TIMEOUT',
          'The request timed out. An interrupted approval must be recovered with the original request key.',
        );
      throw failure;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }
  const query = (projectId: string, cursor?: string | null) =>
    `?${new URLSearchParams({ projectId: id(projectId), ...(cursor ? { cursor } : {}) })}`;
  const sourceSummary = (value: unknown): SourceSummary => {
    const s = object(value);
    if (s.acquisition !== 'provided-text') return invalid();
    return {
      id: id(s.id),
      title: text(s.title, 300),
      uri: uri(s.uri),
      acquisition: 'provided-text',
      capturedAtMs: timestamp(s.capturedAtMs),
      contentHash: hash(s.contentHash),
      snapshotHash: hash(s.snapshotHash),
      sourceBytes: integer(s.sourceBytes, 1, 65536),
    };
  };
  return {
    async capability(): Promise<CrossCheckCapability> {
      const c = await request('crosscheck/capabilities'),
        limits = object(c.limits);
      return {
        configured: bool(c.configured),
        reason: text(c.reason, 100),
        limits: {
          calls: integer(limits.calls, 3, 24),
          maximumUsd6: amount(limits.maximumUsd6),
          quoteSeconds: integer(limits.quoteSeconds, 1, 300),
        },
      };
    },
    async rosters(): Promise<ReviewerRoster[]> {
      const r = await request('crosscheck/rosters');
      return unique(
        list(r.rosters, 50, (value) => {
          const r = object(value);
          return {
            id: id(r.id),
            label: text(r.label, 300),
            version: integer(r.version, 1),
            reviewedAt: date(r.reviewedAt),
            expiresAt: date(r.expiresAt),
            reviewers: reviewers(r.reviewers),
          };
        }),
        (roster) => roster.id,
      );
    },
    async sources(projectId: string, cursor?: string | null) {
      const r = await request(`crosscheck/sources${query(projectId, cursor)}`);
      return {
        sources: unique(
          list(r.sources, 20, sourceSummary),
          (source) => source.id,
        ),
        nextCursor: nullable(r.nextCursor, (value) => text(value, 2048)),
      };
    },
    async source(sourceId: string, projectId: string) {
      const r = await request(`crosscheck/sources/${id(sourceId)}`),
        source = parseSource(r.source, owner, projectId);
      if (source.id !== sourceId) return invalid();
      return source;
    },
    async saveSource(input: {
      projectId: string;
      title: string;
      text: string;
      uri?: string | null;
    }) {
      const r = await request('crosscheck/sources', 'POST', input);
      return parseSource(r.source, owner, input.projectId);
    },
    async runs(projectId: string, cursor?: string | null) {
      const r = await request(`crosscheck${query(projectId, cursor)}`);
      return {
        runs: unique(
          list(r.crosschecks, 20, (value) => {
            const c = object(value);
            return {
              id: id(c.id),
              rosterId: id(c.rosterId),
              preparedAt: date(c.preparedAt),
              expiresAt: date(c.expiresAt),
              status: oneOf(c.status, ['prepared', 'reviewed']),
            };
          }),
          (run) => run.id,
        ),
        nextCursor: nullable(r.nextCursor, (value) => text(value, 2048)),
      };
    },
    async prepare(input: {
      projectId: string;
      rosterId: string;
      sourceIds: string[];
      claims: { id: string; text: string }[];
    }) {
      const r = await request('crosscheck', 'POST', input, 12 * 1048576);
      const run = parseCrossCheck(r.crosscheck, owner, input.projectId);
      if (
        run.rosterId !== input.rosterId ||
        run.plan.sources.length !== input.sourceIds.length ||
        run.plan.sources.some(
          (source) => !input.sourceIds.includes(source.id),
        ) ||
        run.plan.claims.length !== input.claims.length ||
        run.plan.claims.some(
          (claim) =>
            !input.claims.some(
              (item) => item.id === claim.id && item.text === claim.text,
            ),
        )
      )
        return invalid();
      return { run, reused: bool(r.reused), cacheHit: bool(r.cacheHit) };
    },
    async read(runId: string, projectId: string) {
      const r = await request(
          `crosscheck/${id(runId)}`,
          'GET',
          undefined,
          12 * 1048576,
        ),
        run = parseCrossCheck(r.crosscheck, owner, projectId);
      if (run.id !== runId) return invalid();
      return run;
    },
    async quote(run: CrossCheckView, maxOutputTokens = 2048) {
      return parseCrossCheckQuote(
        (
          await request(`crosscheck/${id(run.id)}/quote`, 'POST', {
            maxOutputTokens,
          })
        ).quote,
        run,
      );
    },
    async approve(runId: string, approval: CrossCheckApproval) {
      const r = await request(`crosscheck/${id(runId)}/run`, 'POST', approval);
      if (r.runId !== runId) return invalid();
      return {
        id: id(r.id),
        runId,
        replayed: bool(r.replayed),
        execution: parseExecution(r.execution),
      };
    },
    async cancel(runId: string) {
      const r = await request(`crosscheck/${id(runId)}/cancel`, 'POST', {});
      if (r.cancellationRequested !== true) return invalid();
    },
  };
}
