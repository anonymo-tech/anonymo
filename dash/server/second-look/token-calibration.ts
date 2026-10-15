import { createHash } from 'node:crypto';
import { requireCondition } from '../core/errors.ts';
import { object, canonicalAmount, safeText } from './providers.ts';
import { evaluateTokenFacts, type CalibrationArtifact } from './token-rules.ts';
import type { TokenFacts } from './token-facts.ts';
import { address } from '../solana/validation.ts';
export type BuyTimeObservation = {
  id: string;
  cohort: 'historical' | 'live';
  buyAt: string;
  outcomeThrough: string;
  outcomeCoverageComplete: true;
  buyPriceUsd12: string;
  minimumPrice24hUsd12: string;
  facts: TokenFacts;
};
export type CalibrationDataset = {
  version: 1;
  evidenceUrl: string;
  observations: BuyTimeObservation[];
};
type CohortBand = {
  all: number;
  crashed: number;
  green: number;
  greenCrashed: number;
};
type DerivedCalibration = CalibrationArtifact & {
  historicalExcludedSignals: string[];
  liveSummary: {
    observations: number;
    days: number;
    redRecall: number;
    bands: CalibrationArtifact['bands'];
  };
};
/** Recompute all acceptance statistics; callers cannot supply pass rates or verdict labels. */
export function deriveTokenCalibration(
  raw: unknown,
  now = Date.now(),
): {
  artifact: DerivedCalibration;
  accepted: boolean;
  failures: string[];
} {
  const d = object(raw);
  function valid(v: unknown): asserts v {
    requireCondition(
      v,
      400,
      'TOKEN_DATASET_INVALID',
      'The buy-time calibration dataset is invalid.',
    );
  }
  valid(
    d.version === 1 &&
      Array.isArray(d.observations) &&
      d.observations.length >= 1 &&
      d.observations.length <= 100000,
  );
  const url = new URL(safeText(d.evidenceUrl, 512));
  valid(
    url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
  );
  const unique = new Set<string>(),
    buys = new Set<string>();
  const bands = ['under-1h', '1h-24h', 'over-24h'] as const;
  const makeCounts = () =>
    new Map<(typeof bands)[number], CohortBand>(
      bands.map((b) => [b, { all: 0, crashed: 0, green: 0, greenCrashed: 0 }]),
    );
  const counts = makeCounts(),
    liveCounts = makeCounts();
  let crash = 0,
    redCrash = 0,
    liveCrash = 0,
    liveRedCrash = 0,
    historical = 0;
  const times = { historical: [] as number[], live: [] as number[] };
  const digest = createHash('sha256');
  for (const item of d.observations as unknown[]) {
    const r = object(item);
    const id = safeText(r.id, 128);
    valid(id.length > 0 && !unique.has(id));
    unique.add(id);
    valid(r.cohort === 'historical' || r.cohort === 'live');
    const buy = Date.parse(safeText(r.buyAt, 32)),
      end = Date.parse(safeText(r.outcomeThrough, 32));
    valid(
      Number.isFinite(buy) &&
        new Date(buy).toISOString() === r.buyAt &&
        Number.isFinite(end) &&
        end >= buy + 86400000 &&
        end <= now &&
        r.outcomeCoverageComplete === true,
    );
    const f = object(r.facts) as unknown as TokenFacts;
    address(f.mint);
    valid(!buys.has(`${f.mint}:${buy}`));
    buys.add(`${f.mint}:${buy}`);
    valid(
      Date.parse(f.observedAt) <= buy &&
        Date.parse(f.observedAt) >= buy - 5000 &&
        typeof f.ageSeconds === 'number' &&
        Number.isFinite(f.ageSeconds) &&
        f.ageSeconds >= 0 &&
        Array.isArray(f.checks) &&
        f.checks.length === 13 &&
        new Set(f.checks.map((c) => c.id)).size === 13,
    );
    for (let i = 0; i < 13; i++) {
      const c = f.checks[i];
      valid(
        c.id === i + 1 &&
          ['complete', 'partial', 'unavailable', 'pending'].includes(
            c.status,
          ) &&
          Array.isArray(c.facts) &&
          c.facts.length <= 32 &&
          Array.isArray(c.sources) &&
          c.sources.length <= 8,
      );
      for (const s of c.sources)
        valid(Date.parse(s.observedAt) <= buy && Date.parse(s.expiresAt) > buy);
    }
    const price = BigInt(canonicalAmount(r.buyPriceUsd12)),
      minimum = BigInt(canonicalAmount(r.minimumPrice24hUsd12));
    valid(price > 0n && minimum <= price);
    const crashed = minimum * 10n <= price;
    const historicalObservation = r.cohort === 'historical';
    // Historical reserves are replayable; live fork outcomes/depth probes are not.
    // They must never improve historical recall or make an historical card green.
    const evaluationFacts = historicalObservation
      ? {
          ...f,
          checks: f.checks.map((c) =>
            c.id === 4
              ? { ...c, facts: [], status: 'unavailable' as const }
              : c.id === 9
                ? {
                    ...c,
                    facts: c.facts.filter(
                      (v) =>
                        ![
                          'impact100Percent',
                          'impact1000Percent',
                          'impact10000Percent',
                        ].includes(v.key),
                    ),
                  }
                : c,
          ),
        }
      : f;
    const evaluated = evaluateTokenFacts(evaluationFacts, null, buy);
    const considered = evaluated.checks.filter(
      (c) => !historicalObservation || c.id !== 4,
    );
    const required = (historicalObservation ? [0, 1] : [0, 1, 3]).every(
      (i) =>
        evaluated.checks[i].status === 'complete' &&
        evaluated.checks[i].sources.length > 0,
    );
    const red = required && considered.some((c) => c.risk === 'red');
    const green =
      required &&
      considered.every((c) => c.status === 'complete' && c.risk === 'none');
    const band =
        f.ageSeconds < 3600
          ? bands[0]
          : f.ageSeconds < 86400
            ? bands[1]
            : bands[2],
      c = (historicalObservation ? counts : liveCounts).get(band)!;
    c.all++;
    if (crashed) {
      c.crashed++;
      if (historicalObservation) {
        crash++;
        if (red) redCrash++;
      } else {
        liveCrash++;
        if (red) liveRedCrash++;
      }
    }
    if (green) {
      c.green++;
      if (crashed) c.greenCrashed++;
    }
    if (historicalObservation) historical++;
    times[r.cohort].push(buy);
    digest.update(JSON.stringify(r));
    digest.update('\n');
  }
  const span = (values: number[]) =>
    values.length
      ? Math.floor(
          (values.reduce((a, b) => Math.max(a, b), -Infinity) -
            values.reduce((a, b) => Math.min(a, b), Infinity)) /
            86400000,
        )
      : 0;
  const summarize = (cohort: ReturnType<typeof makeCounts>) =>
    bands.map((band) => {
      const c = cohort.get(band)!;
      return {
        band,
        baseRate: c.all ? c.crashed / c.all : 0,
        greenCrashRate: c.green ? c.greenCrashed / c.green : 1,
        greenObservations: c.green,
      };
    });
  const artifact: DerivedCalibration = {
    version: 'bfb-1',
    evidenceUrl: url.href,
    reviewedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30 * 86400000).toISOString(),
    observations: historical,
    historicalDays: span(times.historical),
    liveDays: span(times.live),
    redRecall: crash ? redCrash / crash : 0,
    bands: summarize(counts),
    historicalExcludedSignals: ['sell-simulation', 'liquidity-depth'],
    liveSummary: {
      observations: times.live.length,
      days: span(times.live),
      redRecall: liveCrash ? liveRedCrash / liveCrash : 0,
      bands: summarize(liveCounts),
    },
    derivation: 'buy-time-v1',
    datasetHash: digest.digest('hex'),
  };
  const failures: string[] = [];
  if (historical < 20000)
    failures.push(
      'At least 20,000 timestamp-bound historical buy observations are required.',
    );
  if (artifact.historicalDays < 60)
    failures.push('Historical observations must span at least 60 days.');
  if (artifact.liveDays < 30 || [...liveCounts.values()].some((c) => !c.all))
    failures.push(
      'Live observations must span at least 30 days and include every age band.',
    );
  if (!crash || artifact.redRecall < 0.7)
    failures.push(
      'Red-flag recall must reach 70% on observed 24-hour crashes.',
    );
  if (
    artifact.bands.some(
      (b) =>
        !b.greenObservations ||
        b.greenCrashRate > 0.15 ||
        b.greenCrashRate > b.baseRate / 3,
    )
  )
    failures.push(
      'Every age band must meet the 15% and one-third-base-rate green crash limits.',
    );
  return { artifact, accepted: failures.length === 0, failures };
}
