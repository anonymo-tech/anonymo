// WS09 settings: council timing and pricing. Read from the process environment once per router, and replaceable per
// router (tests, or a deploy that wires them through its own config) with configureTrust(ctx, ...).
//
//   ANONYMO_COUNCIL_PRICE_MULTIPLIER  what a council answer costs relative to one default call, clamped to 4-5 (default 4.5)
//   ANONYMO_COUNCIL_MAX_TOKENS        output cap for each proposer (default 900)
//   ANONYMO_COUNCIL_GRACE_MS          how long the third proposer may trail the first two (default 2000)

import type { Ctx } from "../../context.ts";

export type TrustConfig = {
  /** Council price as a multiple of one default call (the dearest proposer's charge). Always within [4, 5]. */
  councilMultiplier: number;
  /** Output cap for each proposer. */
  proposerMaxTokens: number;
  /** Once two proposers are done, how long the third may still take before it is cancelled. */
  graceMs: number;
};

export const COUNCIL_MULTIPLIER_MIN = 4;
export const COUNCIL_MULTIPLIER_MAX = 5;

const num = (v: string | undefined, fallback: number) => {
  const n = v == null || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const clampMultiplier = (m: number) => Math.min(COUNCIL_MULTIPLIER_MAX, Math.max(COUNCIL_MULTIPLIER_MIN, Number.isFinite(m) ? m : 4.5));

export function trustConfigFromEnv(env: Record<string, string | undefined> = process.env): TrustConfig {
  return {
    councilMultiplier: clampMultiplier(num(env.ANONYMO_COUNCIL_PRICE_MULTIPLIER, 4.5)),
    proposerMaxTokens: Math.max(1, Math.floor(num(env.ANONYMO_COUNCIL_MAX_TOKENS, 900))),
    graceMs: Math.max(0, Math.floor(num(env.ANONYMO_COUNCIL_GRACE_MS, 2000))),
  };
}

const perRouter = new WeakMap<Ctx, TrustConfig>();

export function trustConfig(ctx: Ctx): TrustConfig {
  let cfg = perRouter.get(ctx);
  if (!cfg) {
    cfg = trustConfigFromEnv();
    perRouter.set(ctx, cfg);
  }
  return cfg;
}

/** Override some settings for one router. The multiplier is clamped to 4-5 whatever is passed. */
export function configureTrust(ctx: Ctx, patch: Partial<TrustConfig>): TrustConfig {
  const next = { ...trustConfig(ctx), ...patch };
  next.councilMultiplier = clampMultiplier(next.councilMultiplier);
  perRouter.set(ctx, next);
  return next;
}
