// Auto Model ranking: pure and deterministic, so the same candidates with the same counts always come out in the same
// order. Nothing here reads the clock, the network or a random source.
//
// Order, first key first:
//   1. Refusal rate over the last 30 days, in whole percentage points (lower first). The rate is the one the public
//      refusal leaderboard shows (anonymo/trust/stats.ts, summed over every route of the model). A model with fewer than
//      `minSamples` checked replies has no measured rate yet and sorts after every model that has one.
//   2. Price: the blended per-token price (3 parts prompt, 1 part completion) of its cheapest eligible route.
//   3. The operator's order in the candidate list, then the model id.

export type RefusalCount = { total: number; refused: number };

export type RankInput = {
  /** The model id as the request will name it. */
  id: string;
  /** Position in the configured candidate list. */
  configIndex: number;
  /** Blended pico-USD per token of the cheapest eligible route: prompt * 3 + completion (only compared, never billed). */
  price: bigint;
  /** Refusal counts over the last 30 days, or null when none are recorded. */
  refusals: RefusalCount | null;
};

export type Ranked = RankInput & { refusalRate: number | null };

/** Whole percentage points, or null when there are too few readings to count. */
export function refusalBucket(c: RefusalCount | null, minSamples: number): number | null {
  if (!c || c.total < Math.max(1, minSamples)) return null;
  return Math.round((c.refused / c.total) * 100);
}

export function rankCandidates(candidates: readonly RankInput[], o: { minSamples: number }): Ranked[] {
  const keyed = candidates.map((c) => ({ c, bucket: refusalBucket(c.refusals, o.minSamples) }));
  keyed.sort((a, b) => {
    if (a.bucket !== b.bucket) {
      if (a.bucket === null) return 1;
      if (b.bucket === null) return -1;
      return a.bucket - b.bucket;
    }
    if (a.c.price !== b.c.price) return a.c.price < b.c.price ? -1 : 1;
    if (a.c.configIndex !== b.c.configIndex) return a.c.configIndex - b.c.configIndex;
    return a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0;
  });
  return keyed.map(({ c }) => ({
    ...c,
    refusalRate: c.refusals && c.refusals.total >= Math.max(1, o.minSamples) ? Number((c.refusals.refused / c.refusals.total).toFixed(4)) : null,
  }));
}
