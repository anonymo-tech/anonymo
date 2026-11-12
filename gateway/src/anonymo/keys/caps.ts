// Per-key controls (spec: Backend §3): daily, monthly and lifetime spend caps, a model allowlist, an IP allowlist,
// sealed_only and expiry. Where Anonymo keys already had the control we reuse it, so the existing request path enforces
// it today: the model allowlist is keys.allowed_models (api/chat.ts), expiry is keys.expires_at (api/auth.ts), and the
// shortest spend window is mirrored into keys.budget/budget_reset, which ledger.reserve() checks against in-flight holds.
// The rest (all three windows at once, ip_allow, sealed_only) is enforced by keyPolicyMiddleware below.

import { and, eq, lt, ne, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import type { Ctx } from "../../context.ts";
import type { Db } from "../../db/client.ts";
import { keys, ledger } from "../../db/schema.ts";
import { ApiError } from "../../lib/errors.ts";
import { type Pico, picoToUsd, usdToPico } from "../../lib/money.ts";
import { sha256 } from "../../lib/util.ts";
import { bearer } from "../../api/auth.ts";
import { clientIp } from "../../api/common.ts";
import { anonymoKeys } from "../deposits/schema.ts";
import { ipAllowed, parseCidr } from "./ip.ts";

const usd = z.union([z.number().nonnegative(), z.string().regex(/^\d{1,12}(\.\d{1,12})?$/)]).transform((v) => usdToPico(v, "floor"));

export const capsInput = z
  .object({
    daily_usd: usd.nullable().optional(),
    monthly_usd: usd.nullable().optional(),
    lifetime_usd: usd.nullable().optional(),
    models: z.array(z.string().min(1).max(200)).max(200).nullable().optional(),
    ip_allow: z
      .array(z.string().max(64).refine((s) => parseCidr(s) !== null, "must be an IP address or CIDR"))
      .max(100)
      .nullable()
      .optional(),
    sealed_only: z.boolean().optional(),
    expires_at: z.string().datetime().nullable().optional(),
  })
  .strict();
export type CapsInput = z.infer<typeof capsInput>;

export type KeyCaps = { dailyCap: Pico | null; monthlyCap: Pico | null; lifetimeCap: Pico | null; ipAllow: string[] | null; sealedOnly: boolean; models: string[] | null; expiresAt: Date | null };

export async function readCaps(db: Db, keyHash: string): Promise<KeyCaps & { wallet: string | null }> {
  const [a] = await db.select().from(anonymoKeys).where(eq(anonymoKeys.keyHash, keyHash));
  const [k] = await db.select({ models: keys.allowedModels, expiresAt: keys.expiresAt }).from(keys).where(eq(keys.keyHash, keyHash));
  return {
    dailyCap: a?.dailyCap ?? null,
    monthlyCap: a?.monthlyCap ?? null,
    lifetimeCap: a?.lifetimeCap ?? null,
    ipAllow: a?.ipAllow ?? null,
    sealedOnly: a?.sealedOnly ?? false,
    wallet: a?.wallet ?? null,
    models: k?.models?.length ? k.models : null,
    expiresAt: k?.expiresAt ?? null,
  };
}

export const capsJson = (c: KeyCaps & { wallet?: string | null }) => ({
  daily_usd: c.dailyCap === null ? null : picoToUsd(c.dailyCap),
  monthly_usd: c.monthlyCap === null ? null : picoToUsd(c.monthlyCap),
  lifetime_usd: c.lifetimeCap === null ? null : picoToUsd(c.lifetimeCap),
  models: c.models,
  ip_allow: c.ipAllow,
  sealed_only: c.sealedOnly,
  expires_at: c.expiresAt?.toISOString() ?? null,
  ...(c.wallet !== undefined ? { wallet: c.wallet } : {}),
});

/** Merge `input` into the key's caps (absent fields keep their value; null clears) and mirror what Anonymo enforces. */
export async function writeCaps(db: Db, keyHash: string, input: CapsInput, wallet?: string | null) {
  const cur = await readCaps(db, keyHash);
  const pick = <T>(v: T | undefined, old: T) => (v === undefined ? old : v);
  const next: KeyCaps = {
    dailyCap: pick(input.daily_usd, cur.dailyCap),
    monthlyCap: pick(input.monthly_usd, cur.monthlyCap),
    lifetimeCap: pick(input.lifetime_usd, cur.lifetimeCap),
    ipAllow: pick(input.ip_allow, cur.ipAllow),
    sealedOnly: pick(input.sealed_only, cur.sealedOnly),
    models: pick(input.models, cur.models),
    expiresAt: input.expires_at === undefined ? cur.expiresAt : input.expires_at === null ? null : new Date(input.expires_at),
  };
  // The shortest window becomes the Anonymo key budget, checked against in-flight holds in ledger.reserve().
  const budget = next.dailyCap !== null ? { budget: next.dailyCap, budgetReset: "daily" } : next.monthlyCap !== null ? { budget: next.monthlyCap, budgetReset: "monthly" } : next.lifetimeCap !== null ? { budget: next.lifetimeCap, budgetReset: null } : { budget: null, budgetReset: null };
  await db.transaction(async (tx) => {
    const row = { dailyCap: next.dailyCap, monthlyCap: next.monthlyCap, lifetimeCap: next.lifetimeCap, ipAllow: next.ipAllow?.length ? next.ipAllow : null, sealedOnly: next.sealedOnly };
    await tx
      .insert(anonymoKeys)
      .values({ keyHash, wallet: wallet ?? null, ...row })
      .onConflictDoUpdate({ target: anonymoKeys.keyHash, set: row });
    await tx.update(keys).set({ allowedModels: next.models?.length ? next.models : null, expiresAt: next.expiresAt, ...budget }).where(eq(keys.keyHash, keyHash));
  });
  return next;
}

export type Spent = { day: Pico; month: Pico; life: Pico };

/** What a key has spent (debits other than withdrawals) since UTC midnight, since the 1st of the month, and ever. */
export async function spentByKey(db: Db, keyHash: string, now = new Date()): Promise<Spent> {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [r] = await db
    .select({
      day: sql<string>`coalesce(sum(case when ${ledger.createdAt} >= ${day} then -${ledger.amount} else 0 end), 0)`,
      month: sql<string>`coalesce(sum(case when ${ledger.createdAt} >= ${month} then -${ledger.amount} else 0 end), 0)`,
      life: sql<string>`coalesce(sum(-${ledger.amount}), 0)`,
    })
    .from(ledger)
    .where(and(eq(ledger.keyHash, keyHash), lt(ledger.amount, 0n), ne(ledger.kind, "withdraw")));
  return { day: BigInt(r?.day ?? 0), month: BigInt(r?.month ?? 0), life: BigInt(r?.life ?? 0) };
}

export type CapRequest = { ip: string | null; model: string | null; sealed: boolean };
export type CapRefusal = { status: 402 | 403; code: string; message: string };

/** Pure decision: may a call with these properties go ahead under these caps and this spend? */
export function capsVerdict(caps: Pick<KeyCaps, "dailyCap" | "monthlyCap" | "lifetimeCap" | "ipAllow" | "sealedOnly">, spent: Spent, req: CapRequest): CapRefusal | null {
  if (caps.ipAllow?.length && !ipAllowed(req.ip, caps.ipAllow)) return { status: 403, code: "ip_not_allowed", message: "This key does not accept calls from this network address." };
  if (caps.sealedOnly && !req.sealed) return { status: 403, code: "sealed_only", message: "This key is sealed-only: use model anonymo-sealed (or send x-anonymo-sealed: required)." };
  const windows: [Pico | null, Pico, string][] = [
    [caps.dailyCap, spent.day, "daily"],
    [caps.monthlyCap, spent.month, "monthly"],
    [caps.lifetimeCap, spent.life, "lifetime"],
  ];
  for (const [cap, used, name] of windows)
    if (cap !== null && used >= cap) return { status: 402, code: "key_cap_reached", message: `This key reached its ${name} spend cap of $${picoToUsd(cap)}.` };
  return null;
}

const INFERENCE_PATH = /^\/(?:api\/)?v1\/(?:chat\/completions|completions|messages|responses|embeddings|images\/|audio\/|video\/)/;
export const isSealedRequest = (model: unknown, header: string | undefined) => model === "anonymo-sealed" || header?.trim().toLowerCase() === "required";

/**
 * Enforces ip_allow, sealed_only and every spend window for Anonymo keys on inference routes. A key without Anonymo caps
 * passes untouched. Must run before the route handlers (it needs a line in app.ts; see the WS05 PR).
 */
export function keyPolicyMiddleware(ctx: Ctx): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "POST" || !INFERENCE_PATH.test(c.req.path)) return next();
    const secret = bearer(c.req.header("authorization")) ?? c.req.header("x-api-key")?.trim();
    if (!secret) return next();
    const keyHash = sha256(secret);
    const [row] = await ctx.db.select().from(anonymoKeys).where(eq(anonymoKeys.keyHash, keyHash));
    if (!row) return next();
    let model: string | null = null;
    if (row.sealedOnly) {
      const body = (await c.req.json().catch(() => ({}))) as { model?: unknown };
      model = typeof body?.model === "string" ? body.model : null;
    }
    const spent = row.dailyCap !== null || row.monthlyCap !== null || row.lifetimeCap !== null ? await spentByKey(ctx.db, keyHash) : { day: 0n, month: 0n, life: 0n };
    const refusal = capsVerdict(row, spent, { ip: row.ipAllow?.length ? clientIp(c, ctx.cfg.trustProxy) : null, model, sealed: isSealedRequest(model, c.req.header("x-anonymo-sealed")) });
    if (refusal) throw new ApiError(refusal.status, refusal.message, refusal.code);
    return next();
  };
}
