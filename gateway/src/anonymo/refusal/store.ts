// WS03 · what the refusal catch writes: the refund lines on the ledger, the per-route refusal counts, and the
// per-key on/off setting. Counts only: no prompt or reply text is ever written (AGENTS.md, Backend §7).
// Tables: ./schema.ts (drizzle/0056_refusal.sql).

import { sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { post } from "../../ledger/ledger.ts";
import { fail } from "../../lib/errors.ts";
import type { Pico } from "../../lib/money.ts";
import { refusalKeySettings, refusalStats } from "./schema.ts";

export { refusalKeySettings, refusalStats };

/** Ledger kinds the refusal catch writes. A refused attempt is a charge line and an equal refund line: net 0. */
export const REFUSED_USAGE = "refused_usage";
export const REFUSAL_REFUND = "refusal_refund";

export const routeIdOf = (modelId: string, providerId: string) => `${modelId}@${providerId}`;

export type RefusedCharge = { modelId: string; providerId: string; cost: Pico };

/**
 * Record each refused attempt as its cost and a `refusal_refund` of the same amount, so the account sees what the
 * attempt would have cost and that it paid nothing for it. Idempotent per hold and attempt index (ledger.ref).
 */
export async function recordRefusedAttempts(db: Db, o: { accountId: string; keyHash: string | null; holdId: string; charges: RefusedCharge[] }) {
  const charges = o.charges.filter((c) => c.cost > 0n);
  if (!charges.length) return;
  await db.transaction(async (tx) => {
    for (const [i, c] of charges.entries()) {
      const what = `${c.modelId} via ${c.providerId}`;
      const base = { accountId: o.accountId, keyHash: o.keyHash, generationId: o.holdId };
      await post(tx, { ...base, amount: -c.cost, kind: REFUSED_USAGE, ref: `refused:${o.holdId}:${i}`, description: `Refused attempt: ${what}` });
      await post(tx, { ...base, amount: c.cost, kind: REFUSAL_REFUND, ref: `refusal_refund:${o.holdId}:${i}`, description: `Refusal refund: ${what}` });
    }
  });
}

/** Add one reading per route to today's counts. */
export async function bumpRefusalStats(db: Db, checked: { routeId: string; refused: boolean }[], at = new Date()) {
  const day = at.toISOString().slice(0, 10);
  for (const c of checked) {
    const refused = c.refused ? 1 : 0;
    await db
      .insert(refusalStats)
      .values({ routeId: c.routeId, day, total: 1, refused })
      .onConflictDoUpdate({ target: [refusalStats.routeId, refusalStats.day], set: { total: sql`${refusalStats.total} + 1`, refused: sql`${refusalStats.refused} + ${refused}` } });
  }
}

/** Refusal rate per route over the last `days` days (for WS09's GET /v1/models and /leaderboard). */
export async function refusalRates(db: Db, days = 30, now = new Date()) {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = await db
    .select({ routeId: refusalStats.routeId, total: sql<string>`sum(${refusalStats.total})`, refused: sql<string>`sum(${refusalStats.refused})` })
    .from(refusalStats)
    .where(sql`${refusalStats.day} >= ${since}`)
    .groupBy(refusalStats.routeId);
  return rows.map((r) => ({ routeId: r.routeId, total: Number(r.total), refused: Number(r.refused), rate: Number(r.total) ? Number(r.refused) / Number(r.total) : 0 }));
}

export const REFUSAL_CATCH_HEADER = "x-anonymo-refusal-catch";

/**
 * Whether the refusal catch runs for this request: the `x-anonymo-refusal-catch: on|off` header when present,
 * else the key's own setting, else on.
 */
export async function refusalCatchEnabled(db: Db, header: string | undefined, keyHash: string | null): Promise<boolean> {
  if (header != null && header.trim() !== "") {
    const v = header.trim().toLowerCase();
    if (v === "on" || v === "true" || v === "1") return true;
    if (v === "off" || v === "false" || v === "0") return false;
    fail(400, `\`${REFUSAL_CATCH_HEADER}\` must be "on" or "off".`, "invalid_request");
  }
  if (!keyHash) return true;
  const [row] = await db.select({ on: refusalKeySettings.catchEnabled }).from(refusalKeySettings).where(sql`${refusalKeySettings.keyHash} = ${keyHash}`);
  return row?.on ?? true;
}

export async function setKeyRefusalCatch(db: Db, keyHash: string, enabled: boolean) {
  await db
    .insert(refusalKeySettings)
    .values({ keyHash, catchEnabled: enabled })
    .onConflictDoUpdate({ target: refusalKeySettings.keyHash, set: { catchEnabled: enabled, updatedAt: new Date() } });
}
