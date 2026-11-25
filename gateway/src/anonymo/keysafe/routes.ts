import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { addressBucket, readJson } from "../../api/common.ts";
import type { Ctx } from "../../context.ts";
import { fail } from "../../lib/errors.ts";
import { keySafes } from "./schema.ts";
import { KEY_SAFE_PATH } from "./wire.ts";

const bytes = (min: number, max = min) => z.string().max(Math.ceil(max * 4 / 3))
  .regex(/^[A-Za-z0-9_-]+$/).transform((s, ctx) => {
    const value = Buffer.from(s, "base64url");
    if (value.length < min || value.length > max || value.toString("base64url") !== s) {
      ctx.addIssue({ code: "custom", message: "Invalid key safe field." });
      return z.NEVER;
    }
    return value;
  });

const safeId = bytes(16);
const credentialId = bytes(1, 1023);
const ids = z.object({ safeId, credentialId }).strict();
const backup = ids.extend({ ciphertext: bytes(17, 1024), nonce: bytes(12) });
const lookup = z.union([z.object({ credentialId }).strict(), z.object({ safeId }).strict()]);
const unavailable = () => fail(503, "Key safe is temporarily unavailable.", "key_safe_unavailable");

export function keySafeRoutes(app: Hono, ctx: Ctx) {
  async function limit(c: Context, operation: string, max: number) {
    c.header("cache-control", "no-store");
    const from = addressBucket(c, ctx.cfg);
    const bucket = createHmac("sha256", ctx.cfg.appSecret).update(`key-safe:${Math.floor(Date.now() / 60_000)}:${from.id}`).digest("hex");
    const rate = await ctx.limiter.take(`key-safe:${operation}:${bucket}`, 1, max, 60_000).catch(unavailable);
    if (!rate.ok) fail(429, "Too many key safe requests. Try again shortly.", "rate_limited", undefined, {
      "Retry-After": String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000))),
    });
  }

  app.post(KEY_SAFE_PATH, async (c) => {
    await limit(c, "save", 6);
    const parsed = backup.safeParse(await readJson(c));
    if (!parsed.success) return fail(400, "Invalid key safe backup.", "invalid_key_safe");
    const value = parsed.data;
    const [inserted] = await ctx.db.insert(keySafes).values(value).onConflictDoNothing()
      .returning({ safeId: keySafes.safeId }).catch(unavailable);
    if (!inserted) {
      const [existing] = await ctx.db.select().from(keySafes).where(eq(keySafes.safeId, value.safeId)).limit(1).catch(unavailable);
      // An identical upload can be retried. Replacement requires a new passkey backup.
      if (!existing || !existing.credentialId.equals(value.credentialId) || !existing.nonce.equals(value.nonce) || !existing.ciphertext.equals(value.ciphertext))
        return fail(409, "A key safe already uses this identifier.", "key_safe_conflict");
    }
    return c.body(null, 204);
  });

  app.post(`${KEY_SAFE_PATH}/lookup`, async (c) => {
    await limit(c, "lookup", 30);
    const parsed = lookup.safeParse(await readJson(c));
    if (!parsed.success) return fail(400, "Invalid key safe lookup.", "invalid_key_safe");
    const value = parsed.data;
    const match = "credentialId" in value ? eq(keySafes.credentialId, value.credentialId) : eq(keySafes.safeId, value.safeId);
    // The safe ID doubles as a deletion capability. Only the ciphertext carries it during discovery.
    const [row] = await ctx.db.select({ credentialId: keySafes.credentialId, ciphertext: keySafes.ciphertext, nonce: keySafes.nonce })
      .from(keySafes).where(match).limit(1).catch(unavailable);
    if (!row) return fail(404, "No key safe was found for that passkey.", "key_safe_not_found");
    return c.json({ credentialId: row.credentialId.toString("base64url"), ciphertext: row.ciphertext.toString("base64url"), nonce: row.nonce.toString("base64url") });
  });

  app.delete(KEY_SAFE_PATH, async (c) => {
    await limit(c, "delete", 12);
    const parsed = ids.safeParse(await readJson(c));
    if (!parsed.success) return fail(400, "Invalid key safe identifiers.", "invalid_key_safe");
    await ctx.db.delete(keySafes).where(and(eq(keySafes.safeId, parsed.data.safeId), eq(keySafes.credentialId, parsed.data.credentialId))).catch(unavailable);
    return c.body(null, 204);
  });
}
