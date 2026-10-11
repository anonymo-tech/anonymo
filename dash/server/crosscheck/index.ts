export {
  CROSSCHECK_TTL_MS,
  CROSSCHECK_LIMITS,
  CrossCheckError,
  createSourceSnapshot,
  prepareCrossCheck,
  validatePlan,
  buildReviewRequests,
  isCacheUsable,
  normalizeQuote,
} from './core.ts';
export type {
  CrossCheckErrorCode,
  AccessScope,
  SourceSnapshot,
  SourceSnapshotInput,
  Reviewer,
  Claim,
  CrossCheckPlan,
  CacheDescriptor,
} from './core.ts';
export { evaluateCrossCheck } from './review.ts';
export type {
  ReviewerVerdict,
  ClaimVerdict,
  AnswerVerdict,
  ReviewSubmission,
  QuoteMatch,
  ReviewInvalidReason,
  ValidatedReview,
  ClaimResult,
  CrossCheckResult,
} from './review.ts';
