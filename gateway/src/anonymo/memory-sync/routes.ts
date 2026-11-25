import { createHash, timingSafeEqual } from "node:crypto";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import type { Context, Handler, Hono } from "hono";
import { z } from "zod";
import { requireKey } from "../../api/auth.ts";
import { readJson } from "../../api/common.ts";
import type { Ctx } from "../../context.ts";
import type { RateLimiter } from "../../lib/ratelimit.ts";
import { kv, ledger } from "../../db/schema.ts";
import { decrypt, encrypt } from "../../lib/util.ts";
import { ApiError, fail } from "../../lib/errors.ts";
import { blindSign, memoryIssuer, verifyGrant } from "./grant.ts";
import { keyEntitlements } from "../everyday/entitlements.ts";
import { utcDay } from "../everyday/policy.ts";
import { memoryBlobs } from "./schema.ts";

const base = "/v1/memory-sync";
export const MEMORY_ITEM_CAP = 512;
export const MEMORY_BYTES_CAP = 8192;
const batchSize = 16;
const encoded = (max: number) => z.string().max(max).regex(/^[A-Za-z0-9_-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const grant = z.object({ prefix: encoded(43), signature: encoded(512) }).strict();
const cursor = z.string().uuid();
const capacity = grant.extend({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), level: z.enum(["large", "unlimited"]) }).strict();
const rowSpec = z.object({
  id: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
  version: z.number().int().min(1).max(2_147_483_647),
  ciphertext: encoded(Math.ceil(MEMORY_BYTES_CAP * 4 / 3)),
  deleted: z.boolean(),
}).strict();

type Row = z.infer<typeof rowSpec>;
type Stored = typeof memoryBlobs.$inferSelect;
const serialize = (r: Stored): Row => ({ id: r.itemId, version: r.version, ciphertext: r.ciphertext.toString("base64url"), deleted: r.deleted });
const authSlot = (id: string) => `memory-sync:verifier:${id}`;

export function memoryWins(incoming: Row, current?: Row) {
  if (!current) return true;
  // Item IDs are never reused after deletion, including by clients that edited while offline.
  if (incoming.deleted !== current.deleted) return incoming.deleted;
  if (incoming.version !== current.version) return incoming.version > current.version;
  return incoming.ciphertext > current.ciphertext;
}

export function memorySyncRoutes(app: Hono, ctx: Ctx) {
  const issuer = memoryIssuer(ctx.cfg.memorySyncIssuer);
  const everyday = ctx.cfg.features.passes || ctx.cfg.features.stake;
  const cached = new Map<string, { day: string; signer: ReturnType<typeof memoryIssuer> }>();
  async function capacitySigner(level: "large" | "unlimited", day: string, create: boolean) {
    const current = cached.get(level);
    if (current?.day === day) return current.signer;
    // A different key each day prevents blind-signing a future day's grant while eligible today.
    const slot = `memory-sync:capacity-signer:${level}`;
    const signer = await ctx.db.transaction(async (tx) => {
      if (create) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${slot}, 0))`);
      const [row] = await tx.select({ value: kv.value }).from(kv).where(eq(kv.key, slot));
      const stored = row?.value as { day: string; pem: string } | undefined;
      if (stored?.day === day) return memoryIssuer(decrypt(ctx.cfg.appSecret, stored.pem));
      if (!create || utcDay() !== day) return null;
      const fresh = memoryIssuer(undefined);
      const value = { day, pem: encrypt(ctx.cfg.appSecret, fresh.key.export({ type: "pkcs8", format: "pem" }).toString()) };
      await tx.insert(kv).values({ key: slot, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
      return fresh;
    });
    if (signer) cached.set(level, { day, signer });
    return signer;
  }
  app.use(`${base}/*`, bodyLimit({ maxSize: 192 * 1024 }));
  const route = (path: string, handler: (c: Context) => Response | Promise<Response>) => {
    const safe: Handler = async (c) => {
      c.header("cache-control", "no-store");
      try {
        return await handler(c);
      } catch (error) {
        if (error instanceof ApiError) return c.json(error.toJSON(), error.status as never);
        if (error instanceof z.ZodError) return c.json(new ApiError(400, "Invalid memory sync request.").toJSON(), 400);
        // Database errors can include SQL parameters. Keep vault credentials and bodies out of logs.
        return c.json(new ApiError(503, "Memory sync is temporarily unavailable.", "memory_sync_unavailable").toJSON(), 503);
      }
    };
    app.post(`${base}/${path}`, safe);
  };

  async function limit(attempt: ReturnType<RateLimiter["take"]>) {
    const result = await attempt;
    if (!result.ok) fail(429, "Memory sync rate limit reached.", "rate_limited");
  }

  function credential(c: Context) {
    const match = /^Vault ([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(c.req.header("authorization") ?? "");
    if (!match) fail(401, "A vault credential is required.", "invalid_vault");
    const id = match[1]!;
    const verifier = createHash("sha256").update(Buffer.from(match[2]!, "hex")).digest();
    return { id, vaultId: Buffer.from(id, "hex"), verifier };
  }

  async function authenticate(c: Context) {
    const proof = credential(c);
    const [row] = await ctx.db.select({ value: kv.value }).from(kv).where(eq(kv.key, authSlot(proof.id)));
    if (!row) fail(404, "Sync has not been enabled for this vault.", "vault_sync_not_enabled");
    if (typeof row.value !== "string" || !digest.safeParse(row.value).success ||
      !timingSafeEqual(Buffer.from(row.value, "hex"), proof.verifier))
      fail(401, "Invalid vault credential.", "invalid_vault");
    await limit(ctx.limiter.take(`memory-sync:vault:${proof.id}`, 1, 300, 60_000));
    return proof;
  }

  route("issuer", (c) => c.json(issuer.publicKey));

  route("grant", async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    const [funded] = await ctx.db.select({ ref: ledger.ref }).from(ledger)
      .where(and(eq(ledger.accountId, key.accountId), inArray(ledger.kind, ["deposit", "credit"]), gt(ledger.amount, 0n))).limit(1);
    const rights = await keyEntitlements(ctx, key.keyHash);
    if (!funded && (!rights || rights.limits.memoryItems === MEMORY_ITEM_CAP)) fail(402, "Top up an Anonymo key to enable memory sync.", "memory_sync_funding_required");
    const { blinded } = z.object({ blinded: encoded(512) }).strict().parse(await readJson(c));
    await limit(ctx.limiter.take(`memory-sync:grant:${key.accountId}`, 1, 10, 86_400_000));
    const signed = blindSign(issuer, Buffer.from(blinded, "base64url"));
    if (!signed) fail(400, "Invalid blinded grant request.");
    return c.json({ signed: signed.toString("base64url") });
  });

  if (everyday) route("capacity", async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    const rights = await keyEntitlements(ctx, key.keyHash);
    const level = rights?.limits.memoryItems === null ? "unlimited" : "large";
    if (!rights || rights.limits.memoryItems === MEMORY_ITEM_CAP)
      fail(403, "This key has standard Vault Memory capacity.", "vault_standard_capacity");
    const day = utcDay();
    const input = z.object({ blinded: encoded(512).optional(), level: z.enum(["large", "unlimited"]).optional(),
      day: z.string().optional() }).strict().parse(await readJson(c));
    await limit(ctx.limiter.take(`memory-sync:capacity:${key.accountId}`, 1, 30, 86_400_000));
    const signingKey = await capacitySigner(level, day, true);
    if (!signingKey || (input.blinded && (input.level !== level || input.day !== day)))
      fail(409, "Refresh the Vault Memory capacity grant.", "vault_capacity_changed");
    if (!input.blinded) return c.json({ ...signingKey.publicKey, level, day, limit: rights.limits.memoryItems });
    const signed = blindSign(signingKey, Buffer.from(input.blinded, "base64url"));
    if (!signed) fail(400, "Invalid blinded capacity request.");
    return c.json({ signed: signed.toString("base64url") });
  });

  route("enable", async (c) => {
    const { id, verifier } = credential(c);
    const { prefix, signature } = grant.parse(await readJson(c));
    const nonce = Buffer.from(prefix, "base64url");
    const signed = Buffer.from(signature, "base64url");
    const hash = verifier.toString("hex");
    if (nonce.length !== 32 || signed.length !== issuer.size || !verifyGrant(issuer.pub, id, hash, nonce, signed))
      fail(401, "Invalid sync grant.", "invalid_vault_grant");
    await ctx.db.insert(kv).values({ key: authSlot(id), value: hash }).onConflictDoNothing();
    await authenticate(c);
    return c.json({ enabled: true });
  });

  route("read", async (c) => {
    const { vaultId } = await authenticate(c);
    const items = await ctx.db.select().from(memoryBlobs).where(eq(memoryBlobs.vaultId, vaultId)).orderBy(asc(memoryBlobs.itemId));
    return c.json({ items: items.map(serialize) });
  });

  if (everyday) route("read-page", async (c) => {
    const { vaultId } = await authenticate(c);
    const { after } = z.object({ after: cursor.optional() }).strict().parse(await readJson(c));
    const items = await ctx.db.select().from(memoryBlobs)
      .where(and(eq(memoryBlobs.vaultId, vaultId), after ? gt(memoryBlobs.itemId, after) : undefined))
      .orderBy(asc(memoryBlobs.itemId)).limit(128);
    return c.json({ items: items.map(serialize), next: items.length === 128 ? items.at(-1)!.itemId : null });
  });

  route("write", async (c) => {
    const { id, vaultId, verifier } = await authenticate(c);
    const { items, proof } = z.object({ items: z.array(rowSpec).min(1).max(batchSize),
      ...(everyday ? { proof: capacity.optional() } : {}),
    }).strict().parse(await readJson(c));
    const token = proof as z.infer<typeof capacity> | undefined;
    let cap = MEMORY_ITEM_CAP;
    const signer = token && token.day === utcDay() && (token.level === "large" || ctx.cfg.features.stake)
      ? await capacitySigner(token.level, token.day, false) : null;
    if (token && signer && verifyGrant(signer.pub, id, verifier.toString("hex"),
      Buffer.from(token.prefix, "base64url"), Buffer.from(token.signature, "base64url"), `${token.level}:${token.day}`))
      cap = token.level === "unlimited" ? Infinity : 2048;
    const ids = items.map((row) => row.id);
    if (new Set(ids).size !== ids.length) fail(400, "A batch cannot repeat an item ID.");
    for (const row of items) {
      const bytes = Buffer.from(row.ciphertext, "base64url");
      if (bytes.toString("base64url") !== row.ciphertext || (row.deleted ? bytes.length !== 0 : bytes.length < 29 || bytes.length > MEMORY_BYTES_CAP))
        fail(400, "Invalid memory ciphertext size or encoding.");
    }

    const winners = await ctx.db.transaction(async (tx) => {
      // A single vault lock keeps the row cap and the conflict decision atomic across replicas.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`memory-sync:${id}`}, 0))`);
      const where = eq(memoryBlobs.vaultId, vaultId);
      const previous = await tx.select().from(memoryBlobs).where(and(where, inArray(memoryBlobs.itemId, ids)));
      const byId = new Map(previous.map((row) => [row.itemId, serialize(row)]));
      if (Number.isFinite(cap) && items.length !== byId.size) {
        const [count] = await tx.select({ count: sql<number>`count(*)::int` }).from(memoryBlobs).where(where);
        if (count!.count + items.length - byId.size > cap)
          fail(409, "This vault has reached its sync item limit.", "vault_sync_cap");
      }
      for (const row of items) {
        if (!memoryWins(row, byId.get(row.id))) continue;
        const update = { version: row.version, deleted: row.deleted, ciphertext: Buffer.from(row.ciphertext, "base64url"), updatedAt: new Date() };
        await tx.insert(memoryBlobs).values({ vaultId, itemId: row.id, ...update })
          .onConflictDoUpdate({ target: [memoryBlobs.vaultId, memoryBlobs.itemId], set: update });
        byId.set(row.id, row);
      }
      return [...byId.values()];
    });
    return c.json({ items: winners });
  });
}
