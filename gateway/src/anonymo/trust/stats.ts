import { sql } from "drizzle-orm";
import type { Ctx } from "../../context.ts";
import type { Candidate, ModelRow } from "../../catalog/catalog.ts";
import { attestationFresh } from "../../router/select.ts";
import { familyOf, weightsHashOf } from "./families.ts";

// Read-only views for /v1/models, /manifest and /leaderboard: route facts and refusal counts. Counts only, never text.
//
// Refusal counts come from WS03's `refusal_stats (route_id, day, total, refused)` table. Until that table exists every
// rate is null (unknown), never 0. WS03 writes route ids as `<model>@<provider>`; a model's rate sums every route serving it.

export type RouteCount = { route: string; model: string; total: number; refused: number };
export type RefusalStats = { available: boolean; routes: RouteCount[]; byModel: Map<string, { total: number; refused: number }> };

const rowsOf = (r: unknown) => ((r as { rows?: unknown[] }).rows ?? r) as Record<string, unknown>[];

/** Refusal counts over the last 30 days, per route, from refusal_stats when the table exists. */
export async function refusalStats30d(ctx: Pick<Ctx, "db">): Promise<RefusalStats> {
  const empty: RefusalStats = { available: false, routes: [], byModel: new Map() };
  if (!ctx.db) return empty;
  const exists = rowsOf(await ctx.db.execute(sql`SELECT to_regclass('public.refusal_stats') IS NOT NULL AS ok`))[0];
  if (!exists || (exists.ok !== true && exists.ok !== "t")) return empty;
  const rows = rowsOf(
    await ctx.db.execute(sql`SELECT route_id, coalesce(sum(total), 0) AS total, coalesce(sum(refused), 0) AS refused FROM refusal_stats WHERE day >= (current_date - 30) GROUP BY route_id ORDER BY route_id`),
  );
  const routes: RouteCount[] = rows.map((r) => {
    const route = String(r.route_id);
    return { route, model: routeModel(route), total: Number(r.total ?? 0), refused: Number(r.refused ?? 0) };
  });
  const byModel = new Map<string, { total: number; refused: number }>();
  for (const r of routes) {
    const m = byModel.get(r.model) ?? { total: 0, refused: 0 };
    m.total += r.total;
    m.refused += r.refused;
    byModel.set(r.model, m);
  }
  return { available: true, routes, byModel };
}

/** The model of a refusal_stats route id: WS03 writes `<model>@<provider>`; `<provider>:<model>` is read as well. */
export function routeModel(route: string): string {
  const at = route.lastIndexOf("@");
  if (at > 0) return route.slice(0, at);
  const colon = route.indexOf(":");
  return colon >= 0 ? route.slice(colon + 1) : route;
}

export const rate = (c: { total: number; refused: number } | undefined): number | null => (c && c.total > 0 ? Number((c.refused / c.total).toFixed(4)) : null);

/**
 * The weights hash of a route: the route record's own (WS04), else the digest an operator declared for the model's
 * weights (models_lane.weights_digest), else null. Never invented.
 */
export function weightsHashFor(ctx: Pick<Ctx, "catalog">, m: ModelRow, o: Candidate | null | undefined): string | null {
  return weightsHashOf(o as unknown as Record<string, unknown>, m as unknown as Record<string, unknown>) ?? ctx.catalog.lane.get(m.id)?.weightsDigest ?? null;
}

/** One route's public facts: where it runs, its family and quant, the weights hash and whether it is attested now. */
export function routeFacts(ctx: Ctx, m: ModelRow, o: Candidate) {
  const attested = attestationFresh(o, ctx.cfg.attestation.intervalMs * 3, ctx.cfg.production);
  return {
    route: `${o.providerId}:${m.id}`,
    upstream: o.providerId,
    family: familyOf(m, o as unknown as Record<string, unknown>),
    quant: o.quant ?? null,
    weights_hash: weightsHashFor(ctx, m, o),
    attested,
    tee: attested ? o.provider.teeKind : null,
    attestation_hash: attested ? (o.provider.attestationHash ?? null) : null,
    attested_at: attested ? (o.provider.attestedAt?.toISOString() ?? null) : null,
  };
}

const shared = <T>(xs: T[]): T | null => (xs.length && xs.every((x) => x === xs[0]) ? xs[0] : null);

/** The /v1/models additions (Backend §11): family, quant, weights_hash, attested, refusal_rate_30d. */
export function anonymoModelFields(ctx: Ctx, m: ModelRow, offers: Candidate[], stats: RefusalStats) {
  const facts = offers.map((o) => routeFacts(ctx, m, o));
  return {
    family: shared(facts.map((f) => f.family)) ?? familyOf(m, offers[0] as unknown as Record<string, unknown> | undefined),
    // One value when every route serves the same; null when they differ or none says (see the manifest for each route).
    quant: shared(facts.map((f) => f.quant)),
    weights_hash: shared(facts.map((f) => f.weights_hash)),
    attested: facts.some((f) => f.attested),
    refusal_rate_30d: stats.available ? rate(stats.byModel.get(m.id)) : null,
  };
}
