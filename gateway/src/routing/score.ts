// WS04 · The Anonymo route score (Backend §4, "Picking a route"):
//
//   score = quality rank x canary quality  -  latency penalty  -  error penalty  -  cost weight  (+ T0 bonus while healthy)
//
// quality rank comes from the route config (the leaderboard), canary quality from services/canaries.ts (0.5-1), latency
// and error rate from the rolling 5-minute health window, cost from the route's blended price. A route is healthy while
// its windowed error rate stays under `healthy_max_error_rate`; only a healthy T0 route gets the bonus, and only a
// healthy route keeps sticky conversations. The order is deterministic: the same health gives the same order.

export type Scoring = {
  t0_bonus: number;
  latency_per_s: number;
  error_penalty: number;
  cost_per_usd_m: number;
  healthy_max_error_rate: number;
  sticky_ttl_s: number;
};

export const DEFAULT_SCORING: Readonly<Scoring> = Object.freeze({
  t0_bonus: 25,
  latency_per_s: 5,
  error_penalty: 100,
  cost_per_usd_m: 2,
  healthy_max_error_rate: 0.25,
  sticky_ttl_s: 1_800,
});

let current: Scoring = { ...DEFAULT_SCORING };
/** The weights in force (the config's `scoring`, loaded by the upstream jobs; defaults until then). */
export const anonymoScoring = (): Scoring => current;
export function setAnonymoScoring(s: Partial<Scoring> | null | undefined) {
  current = { ...DEFAULT_SCORING, ...(s ?? {}) };
}

export type ScoreInput = {
  tier: number | null;
  /** 0-100; a route without one counts as 50. */
  qualityRank: number | null;
  /** Canary quality, 0.5-1 (1 without canary data). */
  canaryQuality: number;
  ttftP50Ms: number | null;
  errorRate: number;
  /** Blended cost in USD per million tokens. */
  usdPerM: number;
};

export function routeScore(o: ScoreInput, s: Scoring = current): { score: number; healthy: boolean } {
  const healthy = o.errorRate < s.healthy_max_error_rate;
  const score =
    (o.qualityRank ?? 50) * Math.min(1, Math.max(0, o.canaryQuality)) -
    s.latency_per_s * ((o.ttftP50Ms ?? 0) / 1000) -
    s.error_penalty * o.errorRate -
    s.cost_per_usd_m * o.usdPerM +
    (o.tier === 0 && healthy ? s.t0_bonus : 0);
  return { score, healthy };
}
