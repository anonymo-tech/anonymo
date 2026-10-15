import { validatePlan, type CrossCheckPlan } from '../crosscheck/core.ts';
import {
  evaluateCrossCheck,
  type ReviewSubmission,
} from '../crosscheck/review.ts';
import { object, integer, finite, safeText } from './providers.ts';
import { address, signature } from '../solana/validation.ts';
import { requireCondition } from '../core/errors.ts';
import type {
  TokenCheck,
  TokenDeep,
  TokenSource,
} from '../../lib/second-look/token.ts';
import { TOKEN_CHECK_LABELS } from '../../lib/second-look/token.ts';
import type { TokenFacts } from './token-facts.ts';

const numeric: Record<number, Record<string, number>> = {
  3: {},
  4: { roundtripCostPercent: 100000 },
  5: { nonPoolTop10Percent: 100 },
  6: { linkedClusterPercent: 100 },
  7: { earlyBoughtPercent: 100, earlyStillHeldPercent: 100 },
  8: { deployerPriorTokens: 1000000, deployerCrashes24h: 1000000 },
  9: {
    liquidityUsd: 1e18,
    impact100Percent: 100,
    impact1000Percent: 100,
    impact10000Percent: 100,
  },
  10: {},
  11: {},
  12: { uniqueBuyers1h: 1e9, fomoBuyerSharePercent: 100 },
};
const bool: Record<number, string[]> = {
  3: ['metadataMutable'],
  4: ['roundtripSucceeded'],
  5: ['holderClassificationComplete'],
  6: ['fundingEvidenceComplete'],
  7: ['launchWindowComplete'],
  8: ['deployerHistoryComplete'],
  9: ['lpBurned', 'lpLocked'],
  10: ['reviewedTop1000Lookalike', 'top1000Compared'],
  11: ['paidPromotionActive'],
  12: ['activityCoverageComplete'],
};
const strings: Record<number, string[]> = {
  3: ['metadataAuthority', 'name', 'symbol', 'uriHost'],
  4: ['probeMethod', 'probeId'],
  5: ['exclusionPolicy'],
  6: ['clusterEvidence'],
  7: ['createSlot', 'windowThroughSlot'],
  8: ['deployerAddress'],
  9: ['poolType'],
  10: ['matchedMint', 'comparisonVersion'],
  11: ['promotionStartedAt'],
  12: ['coverageWindow'],
};
export type ReviewedTokenEvidence = {
  version: 1;
  mint: string;
  observedAt: string;
  expiresAt: string;
  reference: string;
  ageSeconds: number;
  checks: TokenCheck[];
  deep: TokenDeep | null;
};
function valid(ok: unknown): asserts ok {
  requireCondition(
    ok,
    503,
    'TOKEN_EVIDENCE_INVALID',
    'Reviewed token evidence is invalid or expired.',
  );
}
function publicUrl(value: unknown) {
  const u = new URL(safeText(value, 512));
  valid(
    u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.hash &&
      !u.search,
  );
  return u.href;
}
/** Called only by a trusted index/verification ingestion job, never with HTTP user data. */
export async function parseReviewedTokenEvidence(
  raw: unknown,
  mint: string,
  now = Date.now(),
): Promise<ReviewedTokenEvidence> {
  const data = object(raw);
  valid(data.version === 1 && address(data.mint) === mint);
  const observed = safeText(data.observedAt, 32),
    expires = safeText(data.expiresAt, 32);
  valid(
    new Date(observed).toISOString() === observed &&
      new Date(expires).toISOString() === expires &&
      Date.parse(observed) <= now &&
      Date.parse(expires) > now &&
      Date.parse(expires) - Date.parse(observed) <= 600000,
  );
  const ageSeconds = finite(data.ageSeconds, 100 * 365 * 86400),
    reference = publicUrl(data.reference);
  valid(Array.isArray(data.checks) && data.checks.length <= 10);
  const seen = new Set<number>();
  const checks: TokenCheck[] = data.checks.map((rawCheck) => {
    const c = object(rawCheck),
      id = integer(c.id, 13);
    valid(id >= 3 && id <= 12 && !seen.has(id));
    seen.add(id);
    valid(c.status === 'complete' || c.status === 'partial');
    const values = object(c.values),
      facts = [];
    for (const [k, v] of Object.entries(values)) {
      valid(facts.length < 16);
      if (Object.hasOwn(numeric[id] ?? {}, k))
        facts.push({
          key: k,
          label: k.replace(/([A-Z])/g, ' $1'),
          value: finite(v, numeric[id][k]),
        });
      else if ((bool[id] ?? []).includes(k)) {
        valid(typeof v === 'boolean');
        facts.push({ key: k, label: k.replace(/([A-Z])/g, ' $1'), value: v });
      } else {
        valid((strings[id] ?? []).includes(k));
        facts.push({
          key: k,
          label: k.replace(/([A-Z])/g, ' $1'),
          value: v === null ? null : safeText(v, 256),
        });
      }
    }
    if (c.status === 'complete') {
      const required: Record<number, string[]> = {
        3: ['metadataMutable'],
        4: [
          'roundtripSucceeded',
          'roundtripCostPercent',
          'probeMethod',
          'probeId',
        ],
        5: [
          'holderClassificationComplete',
          'nonPoolTop10Percent',
          'exclusionPolicy',
        ],
        6: [
          'fundingEvidenceComplete',
          'linkedClusterPercent',
          'clusterEvidence',
        ],
        7: [
          'launchWindowComplete',
          'earlyBoughtPercent',
          'earlyStillHeldPercent',
          'createSlot',
          'windowThroughSlot',
        ],
        8: [
          'deployerHistoryComplete',
          'deployerPriorTokens',
          'deployerCrashes24h',
          'deployerAddress',
        ],
        9: [
          'liquidityUsd',
          'impact100Percent',
          'impact1000Percent',
          'impact10000Percent',
          'lpBurned',
          'lpLocked',
        ],
        10: [
          'top1000Compared',
          'reviewedTop1000Lookalike',
          'comparisonVersion',
        ],
        11: ['paidPromotionActive'],
        12: [
          'activityCoverageComplete',
          'uniqueBuyers1h',
          'fomoBuyerSharePercent',
        ],
      };
      for (const key of required[id])
        valid(Object.hasOwn(values, key) && values[key] !== null);
      for (const key of [
        'holderClassificationComplete',
        'fundingEvidenceComplete',
        'launchWindowComplete',
        'deployerHistoryComplete',
        'top1000Compared',
        'activityCoverageComplete',
      ])
        if (Object.hasOwn(values, key)) valid(values[key] === true);
      if (id === 4)
        valid(
          ['atomic-never-broadcast-bundle', 'mainnet-fork'].includes(
            values.probeMethod as string,
          ) && Date.parse(expires) - Date.parse(observed) <= 60000,
        );
    }
    if (id === 7) {
      valid(
        BigInt(String(values.windowThroughSlot)) ===
          BigInt(String(values.createSlot)) + 4n,
      );
      valid(
        Number(values.earlyStillHeldPercent) <=
          Number(values.earlyBoughtPercent),
      );
    }
    if (id === 8)
      valid(
        Number(values.deployerCrashes24h) <= Number(values.deployerPriorTokens),
      );
    const provider: TokenSource['provider'] =
      id === 4 ? 'reviewed-simulation' : 'reviewed-index';
    return {
      id: id as TokenCheck['id'],
      label: TOKEN_CHECK_LABELS[id - 1],
      status: c.status,
      risk: null,
      facts,
      sources: [
        {
          provider,
          observedAt: observed,
          expiresAt: expires,
          slot: null,
          reference,
        },
      ],
      limitations:
        id === 6
          ? ['Possibly linked wallets are not proof of a common owner.']
          : [],
    };
  });
  let deep: TokenDeep | null = null;
  if (data.deep !== undefined && data.deep !== null) {
    const d = object(data.deep),
      launch = object(d.launch);
    const createSlot = String(integer(launch.createSlot)),
      throughSlot = String(integer(launch.throughSlot));
    valid(
      BigInt(throughSlot) === BigInt(createSlot) + 99n &&
        launch.coverageComplete === true &&
        Array.isArray(launch.events) &&
        launch.events.length <= 1000,
    );
    const unique = new Set<string>();
    const events = launch.events.map((rawEvent) => {
      const e = object(rawEvent),
        slot = integer(e.slot);
      valid(
        BigInt(slot) >= BigInt(createSlot) &&
          BigInt(slot) <= BigInt(throughSlot),
      );
      const sig = signature(e.signature),
        index = integer(e.instructionIndex, 1024);
      valid(!unique.has(`${sig}:${index}`));
      unique.add(`${sig}:${index}`);
      valid(
        [
          'buy',
          'sell',
          'transfer',
          'liquidity-add',
          'liquidity-remove',
        ].includes(e.kind as string),
      );
      const amount = e.amount === null ? null : safeText(e.amount, 40);
      valid(amount === null || /^(0|[1-9][0-9]{0,38})$/.test(amount));
      const held =
        e.stillHoldingRaw == null ? null : safeText(e.stillHoldingRaw, 40);
      valid(held === null || /^(0|[1-9][0-9]{0,38})$/.test(held));
      return {
        slot: String(slot),
        signature: sig,
        kind: e.kind as string,
        amount,
        wallet: e.wallet == null ? null : address(e.wallet),
        clusterId: e.clusterId == null ? null : safeText(e.clusterId, 80),
        stillHoldingRaw: held,
      };
    });
    events.sort(
      (a, b) =>
        Number(BigInt(a.slot) - BigInt(b.slot)) ||
        a.signature.localeCompare(b.signature),
    );
    let claims: TokenDeep['claims'] = [];
    if (d.claimReview !== undefined && d.claimReview !== null) {
      const review = object(d.claimReview),
        plan = await validatePlan(review.plan as CrossCheckPlan);
      valid(
        plan.sources.every((s) => s.visibility === 'public' && s.uri !== null),
      );
      valid(
        plan.claims.length >= 1 &&
          plan.claims.length <= 5 &&
          plan.cache.expiresAtMs > now,
      );
      valid(Array.isArray(review.submissions));
      const evaluated = await evaluateCrossCheck(
        plan,
        review.submissions as ReviewSubmission[],
        integer(review.finishedAtMs),
      );
      valid(
        evaluated.finishedAtMs <= now &&
          evaluated.finishedAtMs >= Date.parse(observed) - 86400000,
      );
      claims = evaluated.claims.map((c) => ({
        claim: c.claim.text,
        outcome: c.verdict,
        evidence: c.reviews
          .flatMap((r) =>
            r.quotes.map((q) => {
              const s = plan.sources.find((s) => s.id === q.sourceId);
              valid(s);
              return { url: publicUrl(s.uri), quote: safeText(q.quote, 2000) };
            }),
          )
          .slice(0, 8),
      }));
    }
    deep = {
      status: claims.length ? 'complete' : 'partial',
      launch: {
        createSlot,
        throughSlot,
        events: events.slice(0, 200),
        truncated: events.length > 200,
      },
      claims,
      limitations: [
        'Claims were reviewed against stored source snapshots. Agreement and quote presence do not establish external truth.',
        'Launch events cover only the declared indexed window.',
      ],
    };
  }
  return {
    version: 1,
    mint,
    observedAt: observed,
    expiresAt: expires,
    reference,
    ageSeconds,
    checks,
    deep,
  };
}
export function applyReviewedEvidence(
  facts: TokenFacts,
  evidence: ReviewedTokenEvidence,
  options: { index: boolean; simulation: boolean },
): TokenFacts {
  const result = structuredClone(facts);
  if (options.index) result.ageSeconds = evidence.ageSeconds;
  for (const check of evidence.checks)
    if (check.id === 4 ? options.simulation : options.index)
      result.checks[check.id - 1] = structuredClone(check);
  return result;
}
