import { strictJson } from '../../lib/strict-json.ts';
import {
  CROSSCHECK_LIMITS,
  freeze,
  normalizeQuote,
  requireCheck,
  sha256,
  text,
  time,
  validatePlan,
  type Claim,
  type CrossCheckPlan,
  type Reviewer,
} from './core.ts';

export type ReviewerVerdict =
  | 'supported'
  | 'contradicted'
  | 'insufficient_evidence';
export type ClaimVerdict = 'HOLDS' | 'DOES_NOT_HOLD' | 'NO_CONSENSUS';
export type AnswerVerdict = ClaimVerdict | 'PARTLY';
export type ReviewSubmission = Readonly<{
  reviewerId: string;
  claimId: string;
  content: string;
}>;
export type QuoteMatch = Readonly<{
  sourceId: string;
  sourceHash: string;
  quote: string;
  normalizedQuote: string;
  normalizedStart: number;
  normalizedEnd: number;
  offsetUnit: 'utf16-code-unit';
  normalization: 'whitespace-v1';
}>;
export type ReviewInvalidReason =
  | 'missing_review'
  | 'duplicate_review'
  | 'invalid_json'
  | 'invalid_shape'
  | 'missing_evidence'
  | 'unknown_source'
  | 'source_hash_mismatch'
  | 'quote_not_found';
export type ValidatedReview = Readonly<{
  reviewerId: string;
  family: string;
  modelId: string;
  version: string;
  valid: boolean;
  verdict: ReviewerVerdict | null;
  rationale: string | null;
  quotes: readonly QuoteMatch[];
  invalidReason: ReviewInvalidReason | null;
}>;

function object(
  value: unknown,
  expectedKeys: string[],
): Record<string, unknown> {
  requireCheck(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'invalid_review',
  );
  const result = value as Record<string, unknown>;
  requireCheck(
    Object.keys(result).length === expectedKeys.length &&
      expectedKeys.every((key) => Object.hasOwn(result, key)),
    'invalid_review',
  );
  return result;
}

function invalid(
  reviewer: Reviewer,
  reason: ReviewInvalidReason,
): ValidatedReview {
  return {
    reviewerId: reviewer.id,
    family: reviewer.family,
    modelId: reviewer.modelId,
    version: reviewer.version,
    valid: false,
    verdict: null,
    rationale: null,
    quotes: [],
    invalidReason: reason,
  };
}

function validateReview(
  plan: CrossCheckPlan,
  reviewer: Reviewer,
  submission: ReviewSubmission,
): ValidatedReview {
  let decoded: unknown;
  try {
    decoded = strictJson(submission.content, CROSSCHECK_LIMITS.reviewBytes);
  } catch {
    return invalid(reviewer, 'invalid_json');
  }
  let review: Record<string, unknown>;
  let rationale: string;
  let quotes: Record<string, unknown>[];
  try {
    review = object(decoded, ['verdict', 'rationale', 'quotes']);
    requireCheck(
      ['supported', 'contradicted', 'insufficient_evidence'].includes(
        review.verdict as string,
      ),
      'invalid_review',
    );
    rationale = text(review.rationale, 2000).trim();
    requireCheck(rationale.length > 0, 'invalid_review');
    requireCheck(
      Array.isArray(review.quotes) && review.quotes.length <= 8,
      'invalid_review',
    );
    quotes = review.quotes.map((quote) =>
      object(quote, ['sourceId', 'sourceHash', 'quote']),
    );
    for (const quote of quotes) {
      requireCheck(
        typeof quote.sourceId === 'string' &&
          typeof quote.sourceHash === 'string' &&
          /^[a-f0-9]{64}$/.test(quote.sourceHash),
        'invalid_review',
      );
      requireCheck(
        normalizeQuote(text(quote.quote, 4000)).length > 0,
        'invalid_review',
      );
    }
  } catch {
    return invalid(reviewer, 'invalid_shape');
  }
  if (review.verdict !== 'insufficient_evidence' && !quotes.length)
    return invalid(reviewer, 'missing_evidence');
  const matches: QuoteMatch[] = [];
  for (const quote of quotes) {
    const source = plan.sources.find((source) => source.id === quote.sourceId);
    if (!source) return invalid(reviewer, 'unknown_source');
    if (quote.sourceHash !== source.snapshotHash)
      return invalid(reviewer, 'source_hash_mismatch');
    const normalized = normalizeQuote(quote.quote as string);
    const start = source.normalizedText.indexOf(normalized);
    if (start === -1) return invalid(reviewer, 'quote_not_found');
    matches.push({
      sourceId: source.id,
      sourceHash: source.snapshotHash,
      quote: quote.quote as string,
      normalizedQuote: normalized,
      normalizedStart: start,
      normalizedEnd: start + normalized.length,
      offsetUnit: 'utf16-code-unit',
      normalization: 'whitespace-v1',
    });
  }
  return {
    reviewerId: reviewer.id,
    family: reviewer.family,
    modelId: reviewer.modelId,
    version: reviewer.version,
    valid: true,
    verdict: review.verdict as ReviewerVerdict,
    rationale,
    quotes: matches,
    invalidReason: null,
  };
}

export type ClaimResult = Readonly<{
  claim: Claim;
  verdict: ClaimVerdict;
  reviews: readonly ValidatedReview[];
  validFamilyCount: number;
  dissent: boolean;
  uncertainty: readonly (
    | 'missing_valid_review'
    | 'insufficient_evidence'
    | 'disagreement'
  )[];
}>;

/** No voting threshold: every planned family must provide valid, definite, unanimous evidence. */
export async function evaluateCrossCheck(
  plan: CrossCheckPlan,
  submissions: readonly ReviewSubmission[],
  now = Date.now(),
) {
  const validated = await validatePlan(plan);
  const finishedAtMs = time(now);
  requireCheck(finishedAtMs >= validated.createdAtMs);
  requireCheck(
    Array.isArray(submissions) &&
      submissions.length <=
        validated.claims.length * validated.reviewers.length * 2,
    'invalid_submission',
  );
  const pairs = new Map<string, ReviewSubmission[]>();
  for (const submission of submissions) {
    requireCheck(
      submission &&
        validated.claims.some((claim) => claim.id === submission.claimId) &&
        validated.reviewers.some(
          (reviewer) => reviewer.id === submission.reviewerId,
        ),
      'invalid_submission',
    );
    const pair = JSON.stringify([submission.claimId, submission.reviewerId]);
    const group = pairs.get(pair) ?? [];
    group.push(submission);
    pairs.set(pair, group);
  }
  const claims: ClaimResult[] = validated.claims.map((claim) => {
    const reviews = validated.reviewers.map((reviewer) => {
      const values = pairs.get(JSON.stringify([claim.id, reviewer.id])) ?? [];
      return !values.length
        ? invalid(reviewer, 'missing_review')
        : values.length > 1
          ? invalid(reviewer, 'duplicate_review')
          : validateReview(validated, reviewer, values[0]);
    });
    const valid = reviews.filter((review) => review.valid);
    const opinions = new Set(valid.map((review) => review.verdict));
    const complete = valid.length === validated.reviewers.length;
    const verdict: ClaimVerdict =
      complete && opinions.size === 1 && opinions.has('supported')
        ? 'HOLDS'
        : complete && opinions.size === 1 && opinions.has('contradicted')
          ? 'DOES_NOT_HOLD'
          : 'NO_CONSENSUS';
    const dissent = opinions.has('supported') && opinions.has('contradicted');
    const uncertainty: (
      | 'missing_valid_review'
      | 'insufficient_evidence'
      | 'disagreement'
    )[] = [];
    if (!complete) uncertainty.push('missing_valid_review');
    if (opinions.has('insufficient_evidence'))
      uncertainty.push('insufficient_evidence');
    if (dissent) uncertainty.push('disagreement');
    return {
      claim,
      verdict,
      reviews,
      validFamilyCount: valid.length,
      dissent,
      uncertainty,
    };
  });
  const verdict: AnswerVerdict = claims.every(
    (claim) => claim.verdict === 'HOLDS',
  )
    ? 'HOLDS'
    : claims.every((claim) => claim.verdict === 'DOES_NOT_HOLD')
      ? 'DOES_NOT_HOLD'
      : claims.every((claim) => claim.verdict !== 'NO_CONSENSUS')
        ? 'PARTLY'
        : 'NO_CONSENSUS';
  const result = {
    schema: 'crosscheck-result-v1' as const,
    requestHash: validated.requestHash,
    scopeHash: validated.scopeHash,
    claimSetHash: validated.claimSetHash,
    sourceSetHash: validated.sourceSetHash,
    reviewerSetHash: validated.reviewerSetHash,
    verdict,
    claims,
    finishedAtMs,
    cache: validated.cache,
    limitation:
      'Model agreement can be wrong. Quote checks establish text presence, not whether the passage proves a claim.',
  };
  return freeze({
    ...result,
    resultHash: await sha256(JSON.stringify(result)),
  });
}

export type CrossCheckResult = Awaited<ReturnType<typeof evaluateCrossCheck>>;
