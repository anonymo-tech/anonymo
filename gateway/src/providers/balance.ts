// WS04 · Wallet-balance alarms for every prepaid upstream (Backend §4: "an empty upstream wallet is a silent outage").
//
// Each minute, for every prepaid upstream in the runtime config (providers/tiers.ts), the balance is read from the
// adapter's endpoint (providers/adapters.ts, overridable in config) with the upstream's own key, and kept in kv:
//   balance <= warn_usd    an alarm (services/alerts.ts reads anonymoBalanceChecks)
//   balance <= drain_usd   an alarm, and every live route of that upstream is set to `drained`, so selection skips it
//                          (it shows as "offer drained" in the routing explanation) and traffic moves to the backups
//   balance back above     drained routes go live again
// A balance that cannot be read is an alarm of its own after a few minutes; it never drains a route by itself (the
// failover already moves traffic off an upstream whose calls fail with 402). Only the number and a status are kept:
// never the response body, headers or error text.

import { and, eq, inArray, like } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { kv, offers } from "../db/schema.ts";
import { decrypt } from "../lib/util.ts";
import { adapterFor, readUsd, type BalanceEndpoint } from "./adapters.ts";
import { providerFetch } from "./network.ts";
import { loadUpstreamsRuntime, type UpstreamRuntime } from "./tiers.ts";

export const BALANCE_INTERVAL_MS = 60_000;
export const BALANCE_KEY_PREFIX = "anonymo:balance:";
/** A reading older than this is stale: the alarm fires. */
export const BALANCE_STALE_MS = 5 * 60_000;

export type BalanceLevel = "ok" | "warn" | "drain" | "unknown";
export type BalanceReading = { usd: number | null; level: BalanceLevel; checked_at: number; read_at: number | null; status: "ok" | "unreadable" | "no_endpoint" | "no_key" };

export function balanceLevel(usd: number | null, b: { warn_usd: number; drain_usd: number }): BalanceLevel {
  if (usd == null) return "unknown";
  if (usd <= b.drain_usd) return "drain";
  if (usd <= b.warn_usd) return "warn";
  return "ok";
}

/** The endpoint to read for an upstream: the config's override over the adapter's default. */
export function balanceEndpointFor(u: Pick<UpstreamRuntime, "kind" | "balance">, baseUrl: string): BalanceEndpoint | null {
  const def = adapterFor(u.kind)?.balance ?? null;
  const url = u.balance?.url ?? def?.url;
  if (!url) return null;
  return {
    url: new URL(url, new URL(baseUrl).origin).toString(),
    method: u.balance?.method ?? def?.method ?? "GET",
    auth: u.balance?.auth ?? def?.auth ?? "bearer",
    path: u.balance?.path ?? def?.path ?? "balance",
  };
}

/** Method, headers and body of a balance request: where the credential goes depends on the endpoint's auth. */
export function balanceRequestInit(endpoint: Pick<BalanceEndpoint, "method" | "auth">, key: string | null): RequestInit {
  const headers: Record<string, string> = { accept: "application/json" };
  if (key && endpoint.auth === "bearer") headers.authorization = `Bearer ${key}`;
  if (key && endpoint.auth === "x-api-key") headers["x-api-key"] = key;
  if (endpoint.method !== "POST") return { method: endpoint.method, headers };
  headers["content-type"] = "application/json";
  return { method: "POST", headers, body: key && endpoint.auth === "credit_id" ? JSON.stringify({ credit_id: key }) : "{}" };
}

export type BalanceFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Read and record every prepaid upstream's balance, drain or restore its routes, and refresh the catalogue. */
export async function runBalanceAlarms(ctx: Ctx, opts: { fetch?: BalanceFetch; now?: () => number } = {}) {
  const now = (opts.now ?? Date.now)();
  const runtime = await loadUpstreamsRuntime(ctx.db);
  if (!runtime) return { skipped: "no upstreams config" };
  await ctx.catalog.ensureFresh(0);
  const routes = [...ctx.catalog.offersByModel.values()].flat().filter((o) => o.upstreamId);
  const doFetch: BalanceFetch =
    opts.fetch ?? ((url, init) => providerFetch(url, { ...init, redirect: "error" }, { production: ctx.cfg.production, allowDevelopmentMockLoopback: !ctx.cfg.production }));
  const out: Record<string, BalanceLevel> = {};
  let changed = false;
  for (const u of runtime.upstreams) {
    if (!u.prepaid || !u.balance) continue;
    const mine = routes.filter((o) => o.upstreamId === u.id);
    const sample = mine.find((o) => o.provider.apiKeyEnc) ?? mine[0];
    const [prevRow] = await ctx.db.select({ value: kv.value }).from(kv).where(eq(kv.key, BALANCE_KEY_PREFIX + u.id));
    const prev = prevRow?.value as BalanceReading | undefined;
    let reading: BalanceReading = { usd: null, level: "unknown", checked_at: now, read_at: prev?.read_at ?? null, status: "no_endpoint" };
    const found = sample ? balanceEndpointFor(u, sample.provider.baseUrl) : null;
    // The upstream's credential only ever travels over https in production.
    const endpoint = found && (!ctx.cfg.production || new URL(found.url).protocol === "https:") ? found : null;
    const keyEnc = u.balance.keyEnc ?? sample?.provider.apiKeyEnc ?? null;
    if (endpoint && (keyEnc || endpoint.auth === "none")) {
      const key = keyEnc ? decrypt(ctx.cfg.appSecret, keyEnc) : null;
      let usd: number | null = null;
      try {
        const res = await doFetch(endpoint.url, { ...balanceRequestInit(endpoint, key), signal: AbortSignal.timeout(10_000) });
        if (res.ok) usd = readUsd(await res.json(), endpoint.path);
        else await res.body?.cancel().catch(() => undefined);
      } catch {
        /* unreadable: no detail is kept */
      }
      reading = usd == null ? { ...reading, status: "unreadable" } : { usd, level: balanceLevel(usd, u.balance), checked_at: now, read_at: now, status: "ok" };
    } else if (endpoint) reading = { ...reading, status: "no_key" };
    // An unreadable balance keeps the last known level for draining decisions, but never drains on its own.
    const effective = reading.status === "ok" ? reading.level : prev?.level === "drain" ? "drain" : "unknown";
    const stored: BalanceReading = reading.status === "ok" ? reading : { ...reading, usd: prev?.usd ?? null, level: prev?.level ?? "unknown" };
    await ctx.db.insert(kv).values({ key: BALANCE_KEY_PREFIX + u.id, value: stored }).onConflictDoUpdate({ target: kv.key, set: { value: stored, updatedAt: new Date(now) } });
    out[u.id] = reading.level;
    const ids = mine.map((o) => o.providerId);
    if (!ids.length) continue;
    if (effective === "drain") {
      const r = await ctx.db.update(offers).set({ status: "drained", updatedAt: new Date(now) }).where(and(eq(offers.upstreamId, u.id), eq(offers.status, "live"))).returning({ id: offers.providerId });
      changed ||= r.length > 0;
    } else if (reading.status === "ok") {
      const r = await ctx.db.update(offers).set({ status: "live", updatedAt: new Date(now) }).where(and(eq(offers.upstreamId, u.id), eq(offers.status, "drained"), inArray(offers.providerId, ids))).returning({ id: offers.providerId });
      changed ||= r.length > 0;
    }
  }
  if (changed) await ctx.catalog.refresh();
  return { checked: Object.keys(out).length, levels: out };
}

/**
 * Alert checks for services/alerts.ts (true = fine). Per prepaid upstream: `upstream_<id>_balance_read` (a fresh
 * reading exists), `upstream_<id>_balance_low` (above warn_usd) and `upstream_<id>_drained` (above drain_usd).
 */
export async function anonymoBalanceChecks(ctx: Ctx, now = Date.now()): Promise<Record<string, boolean>> {
  const runtime = await loadUpstreamsRuntime(ctx.db);
  if (!runtime) return {};
  const rows = await ctx.db.select().from(kv).where(like(kv.key, BALANCE_KEY_PREFIX + "%"));
  const checks: Record<string, boolean> = {};
  for (const u of runtime.upstreams) {
    if (!u.prepaid || !u.balance) continue;
    const name = `upstream_${u.id.replace(/[^a-z0-9]/g, "_")}`.slice(0, 48);
    const r = rows.find((x) => x.key === BALANCE_KEY_PREFIX + u.id)?.value as BalanceReading | undefined;
    checks[`${name}_balance_read`] = !!r && r.read_at != null && now - r.read_at <= BALANCE_STALE_MS;
    checks[`${name}_balance_low`] = !r || (r.level !== "warn" && r.level !== "drain");
    checks[`${name}_drained`] = !r || r.level !== "drain";
  }
  return checks;
}
