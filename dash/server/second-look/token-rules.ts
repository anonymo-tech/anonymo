import type {
  TokenCalibration,
  TokenCheck,
  TokenReport,
} from '../../lib/second-look/token.ts';
import { object, finite, integer, safeText } from './providers.ts';
import { requireCondition } from '../core/errors.ts';
import type { TokenFacts } from './token-facts.ts';
export type CalibrationArtifact = {
  version: 'bfb-1';
  derivation: 'buy-time-v1';
  datasetHash: string;
  evidenceUrl: string;
  reviewedAt: string;
  expiresAt: string;
  observations: number;
  historicalDays: number;
  liveDays: number;
  redRecall: number;
  bands: {
    band: 'under-1h' | '1h-24h' | 'over-24h';
    baseRate: number;
    greenCrashRate: number;
    greenObservations: number;
  }[];
};
export function parseCalibration(
  value: unknown,
  now = Date.now(),
): CalibrationArtifact {
  const o = object(value);
  const evidence = new URL(safeText(o.evidenceUrl, 512));
  requireCondition(
    evidence.protocol === 'https:' &&
      !evidence.username &&
      !evidence.password &&
      !evidence.hash &&
      !evidence.search,
    503,
    'TOKEN_CALIBRATION_INVALID',
    'Calibration evidence is invalid.',
  );
  const reviewed = safeText(o.reviewedAt, 32),
    expires = safeText(o.expiresAt, 32);
  requireCondition(
    o.version === 'bfb-1' &&
      o.derivation === 'buy-time-v1' &&
      typeof o.datasetHash === 'string' &&
      /^[a-f0-9]{64}$/.test(o.datasetHash) &&
      new Date(reviewed).toISOString() === reviewed &&
      new Date(expires).toISOString() === expires &&
      Date.parse(reviewed) <= now &&
      Date.parse(expires) > now &&
      Date.parse(expires) - Date.parse(reviewed) <= 90 * 86400000,
    503,
    'TOKEN_CALIBRATION_INVALID',
    'Calibration evidence is invalid.',
  );
  requireCondition(
    Array.isArray(o.bands) && o.bands.length === 3,
    503,
    'TOKEN_CALIBRATION_INVALID',
    'Calibration evidence is invalid.',
  );
  const seen = new Set<string>();
  const bands = o.bands.map((raw) => {
    const b = object(raw);
    requireCondition(
      ['under-1h', '1h-24h', 'over-24h'].includes(b.band as string) &&
        !seen.has(b.band as string),
      503,
      'TOKEN_CALIBRATION_INVALID',
      'Calibration evidence is invalid.',
    );
    seen.add(b.band as string);
    return {
      band: b.band as CalibrationArtifact['bands'][number]['band'],
      baseRate: finite(b.baseRate, 1),
      greenCrashRate: finite(b.greenCrashRate, 1),
      greenObservations: integer(b.greenObservations, 100000000),
    };
  });
  return {
    version: 'bfb-1',
    derivation: 'buy-time-v1',
    datasetHash: o.datasetHash as string,
    evidenceUrl: evidence.href,
    reviewedAt: reviewed,
    expiresAt: expires,
    observations: integer(o.observations, 100000000),
    historicalDays: integer(o.historicalDays, 3650),
    liveDays: integer(o.liveDays, 3650),
    redRecall: finite(o.redRecall, 1),
    bands,
  };
}
export function calibrationState(
  value: unknown,
  ageSeconds: number | null,
  now = Date.now(),
): TokenCalibration {
  const band: TokenCalibration['ageBand'] =
    ageSeconds === null
      ? 'unknown'
      : ageSeconds < 3600
        ? 'under-1h'
        : ageSeconds < 86400
          ? '1h-24h'
          : 'over-24h';
  const missing: TokenCalibration = {
    status: 'missing',
    version: null,
    evidenceUrl: null,
    ageBand: band,
    baseRate: null,
  };
  if (!value) return missing;
  let artifact: CalibrationArtifact;
  try {
    artifact = parseCalibration(value, now);
  } catch {
    return { ...missing, status: 'failed' };
  }
  const cohort = artifact.bands.find((b) => b.band === band);
  const valid =
    artifact.observations >= 20000 &&
    artifact.historicalDays >= 60 &&
    artifact.liveDays >= 30 &&
    artifact.redRecall >= 0.7 &&
    artifact.bands.every(
      (b) =>
        b.greenObservations > 0 &&
        b.greenCrashRate <= 0.15 &&
        b.greenCrashRate <= b.baseRate / 3,
    );
  return {
    status: valid ? 'valid' : 'failed',
    version: artifact.version,
    evidenceUrl: artifact.evidenceUrl,
    ageBand: band,
    baseRate: cohort?.baseRate ?? null,
  };
}
export function cacheSeconds(ageSeconds: number | null) {
  return ageSeconds === null || ageSeconds < 3600
    ? 30
    : ageSeconds < 86400
      ? 120
      : 600;
}
/** bfb-1 is deliberately fixed: reviewed source values cannot supply their own verdict. */
export function evaluateTokenFacts(
  facts: TokenFacts,
  calibration: unknown = null,
  now = Date.now(),
): Pick<
  TokenReport,
  'checks' | 'verdict' | 'reasons' | 'calibration' | 'limitations'
> {
  const checks = structuredClone(facts.checks),
    reasons: string[] = [];
  for (const c of checks) {
    c.risk = null;
    if (
      c.sources.some(
        (s) =>
          !Number.isFinite(Date.parse(s.expiresAt)) ||
          Date.parse(s.expiresAt) <= now ||
          Date.parse(s.observedAt) > now + 1000,
      )
    ) {
      c.status = 'partial';
      c.limitations.push('Evidence expired; refresh is required.');
    }
  }
  const fresh = (c: TokenCheck) =>
    c.sources.length > 0 &&
    c.sources.every(
      (s) =>
        Date.parse(s.expiresAt) > now && Date.parse(s.observedAt) <= now + 1000,
    );
  const value = (id: number, key: string) =>
    fresh(checks[id - 1])
      ? checks[id - 1].facts.find((f) => f.key === key)?.value
      : undefined;
  const n = (id: number, key: string) => {
    const x = value(id, key);
    return typeof x === 'number' && Number.isFinite(x) ? x : null;
  };
  const has = (id: number, key: string) => {
    const x = value(id, key);
    return typeof x === 'string' && x.length > 0;
  };
  const flag = (id: number, risk: 'red' | 'caution', reason: string) => {
    const c = checks[id - 1];
    if (c.risk !== 'red') c.risk = risk;
    reasons.push(reason);
  };
  if (
    has(1, 'mintAuthority') &&
    value(1, 'reviewedMintAuthorityException') !== true
  )
    flag(1, 'red', 'A mint authority can increase supply.');
  if (has(1, 'freezeAuthority'))
    flag(1, 'red', 'A freeze authority can freeze token accounts.');
  if (has(2, 'permanentDelegate'))
    flag(2, 'red', 'A permanent delegate is configured.');
  if (
    has(2, 'hookProgram') &&
    (has(2, 'hookAuthority') ||
      value(2, 'hookUpgradeable') !== false ||
      value(2, 'hookReviewed') !== true)
  )
    flag(2, 'red', 'A transfer hook has unreviewed or changeable behavior.');
  if (has(2, 'feeAuthority'))
    flag(2, 'red', 'The transfer fee can be changed by an authority.');
  if (
    value(2, 'defaultFrozen') === true ||
    has(2, 'pauseAuthority') ||
    value(2, 'paused') === true
  )
    flag(2, 'red', 'Token transfer availability can be restricted.');
  if (value(2, 'nonTransferable') === true)
    flag(2, 'red', 'The token is non-transferable.');
  if ((n(2, 'feeBps') ?? 0) > 500)
    flag(
      2,
      'red',
      'The configured current or scheduled transfer fee exceeds 5%.',
    );
  if (
    value(4, 'roundtripSucceeded') === false ||
    (n(4, 'roundtripCostPercent') ?? 0) > 30
  )
    flag(
      4,
      'red',
      'The sourced buy/sell simulation failed or exceeded 30% roundtrip cost.',
    );
  const top = n(5, 'nonPoolTop10Percent');
  if (top !== null && value(5, 'holderClassificationComplete') === true) {
    if (top > 50)
      flag(5, 'red', 'Classified non-pool top-ten holders exceed 50%.');
    else if (top >= 30)
      flag(5, 'caution', 'Classified non-pool top-ten holders hold 30–50%.');
  }
  const early = n(7, 'earlyStillHeldPercent');
  if (early !== null) {
    if (early > 20)
      flag(7, 'red', 'Launch-window allocations still held exceed 20%.');
    else if (early >= 10)
      flag(7, 'caution', 'Launch-window allocations still held are 10–20%.');
  }
  if ((n(8, 'deployerCrashes24h') ?? 0) >= 3)
    flag(
      8,
      'red',
      'The sourced deployer history includes at least three 90% drops within 24 hours.',
    );
  if (value(10, 'reviewedTop1000Lookalike') === true)
    flag(
      10,
      'red',
      'A reviewed top-1000 comparison identifies a different mint with a matching identity.',
    );
  const liquidity = n(9, 'liquidityUsd');
  if (
    (liquidity !== null && liquidity < 10000) ||
    (n(9, 'impact1000Percent') ?? 0) > 10
  )
    flag(
      9,
      'caution',
      'Reported liquidity is under $10,000 or measured $1,000 price impact exceeds 10%.',
    );
  const unique = n(12, 'uniqueBuyers1h');
  if (
    value(11, 'paidPromotionActive') === true &&
    unique !== null &&
    unique < 50
  )
    flag(
      11,
      'caution',
      'Active paid promotion accompanies fewer than 50 sourced unique hourly buyers.',
    );
  if (value(3, 'metadataMutable') === true)
    flag(3, 'caution', 'Token metadata remains mutable.');
  if ((n(13, 'externalRiskCount') ?? 0) > 0)
    flag(13, 'caution', 'The external risk source reports additional flags.');
  for (const c of checks)
    if (c.risk === null && c.status === 'complete' && fresh(c)) c.risk = 'none';
  const cal = calibrationState(calibration, facts.ageSeconds, now);
  const requiredMissing = [1, 2, 4].some(
    (id) => checks[id - 1].status !== 'complete' || !fresh(checks[id - 1]),
  );
  const allComplete = checks.every((c) => c.status === 'complete' && fresh(c));
  const verdict: TokenReport['verdict'] = requiredMissing
    ? 'checking'
    : cal.status !== 'valid' || cal.baseRate === null
      ? 'withheld'
      : checks.some((c) => c.risk === 'red')
        ? 'red_flags'
        : checks.some((c) => c.risk === 'caution')
          ? 'caution'
          : !allComplete
            ? 'withheld'
            : 'no_red_flags';
  return {
    checks,
    verdict,
    reasons: [...new Set(reasons)].slice(0, 3),
    calibration: cal,
    limitations: [
      ...(requiredMissing
        ? [
            'Required authority, extension or buy/sell simulation evidence is missing or expired.',
          ]
        : []),
      ...(cal.status !== 'valid'
        ? [
            'Verdict words are withheld until the published historical and live calibration gates pass.',
          ]
        : []),
      ...(!allComplete
        ? [
            'Some checks are incomplete. Missing evidence is not an absence of risk.',
          ]
        : []),
      'Information, not advice. You decide.',
    ],
  };
}
