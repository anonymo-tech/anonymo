import { createHmac } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { addressBucket } from "../../api/common.ts";
import type { Ctx } from "../../context.ts";
import { fail } from "../../lib/errors.ts";
import { freeChatModel } from "./policy.ts";
import { FREE_PROOF_HEADER, FREE_TOKEN_HEADER, hashDevice, issueChallenge, MAX_BATCH, nextDay, utcDay, verifyProof, workDifficulty, type FreeProof } from "./pow.ts";
import { freeTokens } from "./schema.ts";

const CHALLENGES_PER_MINUTE = 1200;
const PROOFS_PER_MINUTE = 600;
const WINDOW = 60_000;

function addressOf(ctx: Ctx, c: Context, now: number) {
  const address = addressBucket(c, ctx.cfg).id;
  return createHmac("sha256", ctx.cfg.appSecret).update(`free-address:${utcDay(now)}:${address}`).digest("hex");
}

async function limit(ctx: Ctx, bucket: string, max: number, amount = 1) {
  const state = await ctx.limiter.take(`free:${bucket}`, amount, max, WINDOW);
  if (!state.ok)
    fail(429, "Free chat is busy. Try again shortly.", "rate_limited", undefined, { "retry-after": String(Math.ceil(state.retryAfterMs / 1000)) });
  return max - state.remaining;
}

function deviceOf(c: Context) {
  const device = hashDevice(c.req.header(FREE_TOKEN_HEADER));
  if (!device) fail(400, "Send a valid free device token.", "invalid_free_device");
  return device;
}

async function usedToday(ctx: Ctx, device: Buffer, day: string) {
  const [row] = await ctx.db.select({ used: freeTokens.used }).from(freeTokens)
    .where(and(eq(freeTokens.deviceToken, device), eq(freeTokens.day, day)));
  return row?.used ?? 0;
}

function exhausted(reset: number): never {
  fail(429, "You’ve used your free messages today. Add funds to keep chatting.", "free_daily_limit", { remaining: 0, resets_at: reset });
}

function stale(): never {
  fail(409, "Get a fresh free chat challenge and try again.", "free_proof_stale");
}

export async function verifyFreeChat(ctx: Ctx, c: Context) {
  const now = Date.now();
  const address = addressOf(ctx, c, now);
  await limit(ctx, `proofs:${address}`, 40);
  await limit(ctx, "proofs", PROOFS_PER_MINUTE);
  const device = deviceOf(c);
  const proof = verifyProof(ctx.cfg.appSecret, device, c.req.header(FREE_PROOF_HEADER), now);
  if (!proof) {
    await limit(ctx, `invalid:${address}`, 100);
    fail(403, "Solve a current free chat challenge first.", "invalid_free_proof");
  }
  const used = await usedToday(ctx, device, proof.day);
  if (used >= ctx.cfg.freeTier.daily) exhausted(nextDay(now));
  if (used !== proof.expected) stale();
  return proof;
}

export async function consumeFreeChat(ctx: Ctx, proof: FreeProof) {
  const now = Date.now();
  if (proof.expires <= now || proof.day !== utcDay(now)) stale();
  const { daily } = ctx.cfg.freeTier;
  if (proof.expected >= daily) exhausted(nextDay(now));

  // The UTC day and the expected counter are the replay guard, including across replicas and simultaneous sends.
  const set = { day: proof.day, used: proof.expected + 1, powDifficulty: proof.difficulty };
  const [row] = proof.expected === 0
    ? await ctx.db.insert(freeTokens).values({ deviceToken: proof.device, ...set })
      .onConflictDoUpdate({ target: freeTokens.deviceToken, set, setWhere: lt(freeTokens.day, proof.day) })
      .returning({ used: freeTokens.used })
    : await ctx.db.update(freeTokens).set(set).where(and(
      eq(freeTokens.deviceToken, proof.device), eq(freeTokens.day, proof.day), eq(freeTokens.used, proof.expected),
    )).returning({ used: freeTokens.used });
  if (!row) {
    if (await usedToday(ctx, proof.device, proof.day) >= daily) exhausted(nextDay(now));
    stale();
  }
  return daily - row.used;
}

export function freeTierRoutes(app: Hono, ctx: Ctx) {
  app.get("/v1/free/challenge", async (c) => {
    c.header("cache-control", "no-store");
    const now = Date.now();
    const device = deviceOf(c);
    const address = addressOf(ctx, c, now);
    await limit(ctx, `challenges:${address}`, 40);
    const load = await limit(ctx, "challenges", CHALLENGES_PER_MINUTE);
    const requested = Number(c.req.query("batch") ?? "1");
    if (!Number.isInteger(requested) || requested < 1 || requested > MAX_BATCH)
      fail(400, `Batch size must be between 1 and ${MAX_BATCH}.`, "invalid_free_batch");
    const used = await usedToday(ctx, device, utcDay(now));
    const remaining = Math.max(0, ctx.cfg.freeTier.daily - used);
    const resets_at = nextDay(now);
    if (!remaining) return c.json({ challenge: null, difficulty: 0, expires: resets_at, batch: 0, remaining, resets_at, model: null });

    await ctx.catalog.ensureFresh();
    const model = freeChatModel(ctx);
    if (!model) fail(503, "Free chat is temporarily unavailable.", "free_unavailable");
    const failures = await limit(ctx, `invalid:${address}`, 100, 0);
    const batch = Math.min(requested, remaining);
    const difficulty = workDifficulty(ctx.cfg.freeTier.difficulty, load, failures, batch);
    return c.json({ ...issueChallenge(ctx.cfg.appSecret, device, used, batch, difficulty, now), remaining, resets_at, model });
  });
}
