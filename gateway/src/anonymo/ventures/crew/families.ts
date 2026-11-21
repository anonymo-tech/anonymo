// WS11 · which model families sit in the crew (Ventures Backend PART 2).
//
// A fan-out step picks `n` distinct families from the route manifest (no two candidates from one family), cheapest
// first under a per-call price ceiling. A refused candidate is replaced by the next family not yet used. The Tester
// always comes from a family that built nothing in that round, so no candidate grades itself. Holders' votes
// (VoteRegistry) can narrow the families allowed in the crew; see allowFamilies().

import type { Ctx } from "../../../context.ts";
import { outputModalities } from "../../../catalog/catalog.ts";
import { servable } from "../../../api/models.ts";
import { fundedOffers } from "../../../rush/availability.ts";
import { familyOf } from "../../trust/families.ts";
import { isAnonymoModelId } from "../../models.ts";

export type CrewModel = { model: string; family: string; pricePerMTokUsd: number };

let votedFamilies: ReadonlySet<string> | null = null;

/** Families the latest VoteRegistry epoch allows in the crew; null lifts the restriction. */
export function allowFamilies(families: Iterable<string> | null) {
  votedFamilies = families ? new Set([...families].map((f) => f.toLowerCase())) : null;
}
export const allowedFamilies = () => votedFamilies;

/**
 * Whether a catalogue model may be a crew member. Only direct model IDs: the routed presets (anonymo-1, anonymo-rp,
 * anonymo-council, anonymo-sealed) choose a route per request, possibly of another family, so a builder on one could
 * share a family with another builder; and Venice routes are reachable only through those presets (they never get a
 * direct ID, models.ts), so the crew never names or calls a Venice model one-for-one.
 */
export const isCrewModel = (m: { id: string; hidden?: boolean | null; arch?: unknown }) => !m.hidden && !isAnonymoModelId(m.id) && outputModalities(m as never).includes("text");

/** One cheapest model per family among chat models that can be served right now. */
export function crewPool(ctx: Ctx): CrewModel[] {
  const best = new Map<string, CrewModel>();
  for (const m of ctx.catalog.models.values()) {
    if (!isCrewModel(m)) continue;
    const offers = fundedOffers(ctx, servable(ctx, m));
    if (!offers.length) continue;
    for (const o of offers) {
      const family = familyOf(m, o);
      if (votedFamilies && !votedFamilies.has(family)) continue;
      const price = Number(o.pricePrompt + o.priceCompletion * 3n) / 4 / 1e6; // pico/token → USD per 1M tokens, 1:3 in:out
      const cur = best.get(family);
      if (!cur || price < cur.pricePerMTokUsd || (price === cur.pricePerMTokUsd && m.id < cur.model)) best.set(family, { model: m.id, family, pricePerMTokUsd: price });
    }
  }
  return [...best.values()].sort((a, b) => a.pricePerMTokUsd - b.pricePerMTokUsd || a.family.localeCompare(b.family));
}

/** `n` distinct families, skipping any in `exclude`, under the price ceiling. Fewer come back when fewer exist. */
export function pickFamilies(pool: readonly CrewModel[], n: number, o: { exclude?: Iterable<string>; maxPricePerMTokUsd?: number } = {}): CrewModel[] {
  const skip = new Set(o.exclude ?? []);
  const out: CrewModel[] = [];
  for (const m of pool) {
    if (out.length >= n) break;
    if (skip.has(m.family)) continue;
    if (o.maxPricePerMTokUsd !== undefined && m.pricePerMTokUsd > o.maxPricePerMTokUsd) continue;
    skip.add(m.family);
    out.push(m);
  }
  return out;
}

/** The next family to replace a refused candidate, never one already used in this round. */
export function nextFamily(pool: readonly CrewModel[], used: Iterable<string>, maxPricePerMTokUsd?: number): CrewModel | null {
  return pickFamilies(pool, 1, { exclude: used, maxPricePerMTokUsd })[0] ?? null;
}
