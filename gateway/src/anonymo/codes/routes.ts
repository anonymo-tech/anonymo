import { createHmac } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { bearer, requireKey } from "../../api/auth.ts";
import { clientIp, readJson } from "../../api/common.ts";
import type { Ctx } from "../../context.ts";
import { fail } from "../../lib/errors.ts";
import { sha256 } from "../../lib/util.ts";
import { parseIp } from "../keys/ip.ts";
import { canonicalCode } from "./format.ts";
import { issueBatch, listBatches, redeemCode } from "./store.ts";

const batchBody = z.strictObject({ face_usd: z.literal([5, 10, 25, 50]), count: z.number().int().min(1) });
const redeemBody = z.strictObject({ code: z.string().max(64) });

function requireReseller(c: Context, ctx: Ctx) {
  const token = bearer(c.req.header("authorization"));
  const id = token && ctx.cfg.codeResellers.get(sha256(token));
  if (!id) fail(401, "Provide a valid reseller bearer token.", "invalid_reseller_token");
  return id;
}

async function limitAttempts(c: Context, ctx: Ctx, action: "redeem" | "list") {
  const address = parseIp(clientIp(c, ctx.cfg.trustProxy));
  const digest = createHmac("sha256", ctx.cfg.appSecret)
    .update(`codes:${action}:${address ? `${address.family}:${address.n}` : "unknown"}`).digest("hex");
  const limit = await ctx.limiter.take(`codes:${action}:${digest}`, 1, 15, 60_000);
  if (!limit.ok) fail(429, "Too many attempts. Try again shortly.", "rate_limited", undefined,
    { "Retry-After": String(Math.max(1, Math.ceil(limit.retryAfterMs / 1_000))) });
}

export function codesRoutes(app: Hono, ctx: Ctx) {
  app.post("/v1/codes/batches", async (c) => {
    c.header("cache-control", "no-store");
    const id = requireReseller(c, ctx);
    const body = batchBody.safeParse(await readJson(c));
    if (!body.success) fail(400, "Send a face_usd of 5, 10, 25 or 50 and a positive whole count.", "invalid_batch");
    return c.json(await issueBatch(ctx.db, id, body.data.face_usd, body.data.count), 201);
  });

  app.get("/v1/codes/batches", async (c) => {
    c.header("cache-control", "no-store");
    await limitAttempts(c, ctx, "list");
    const id = requireReseller(c, ctx);
    const cursor = z.uuid().optional().safeParse(c.req.query("after"));
    if (!cursor.success) fail(400, "Use the next_cursor UUID as after.", "invalid_cursor");
    return c.json(await listBatches(ctx.db, id, cursor.data));
  });

  app.post("/v1/codes/redeem", async (c) => {
    c.header("cache-control", "no-store");
    await limitAttempts(c, ctx, "redeem");
    const body = redeemBody.safeParse(await readJson(c));
    const code = body.success ? canonicalCode(body.data.code) : null;
    if (!code) fail(400, "Check the 16 characters on your Anonymo Code.", "invalid_code");
    const auth = c.req.header("authorization");
    const key = auth === undefined ? null : await requireKey(ctx, auth);
    const result = await redeemCode(ctx, code, key);
    return c.json(result, key ? 200 : 201);
  });
}
