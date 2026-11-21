// WS11 · Spec Filter entry point (Ventures Backend spec, PART 4 "Spec Filter (the firewall)", Law 4).

export { filterSpec, secondPass, canonicalJson, specHashOf, brandTerms, LeakageError, type FilterOptions, type FilterResult, type LeakageReport } from "./filter.ts";
export { buildIndex, findSharedSpans, scoutIndex, scoutTexts, tokenize, SPAN_TOKENS, type NgramIndex, type SharedSpan } from "./leakage.ts";
export { cleanLabel, labelViolation, isGenericPlanName, MAX_LABEL_WORDS, type RuleHit } from "./rules.ts";
