import { createHmac } from "node:crypto";
import type { Hono } from "hono";
import { addressBucket } from "../../api/common.ts";
import type { Ctx } from "../../context.ts";
import { ApiError } from "../../lib/errors.ts";

const MAX_TEXT_CHARS = 200_000;
const MAX_CONCURRENT_CHECKS = 8;
const CHECKS_PER_MINUTE = 20;

export function lifeboatRoutes(app: Hono, ctx: Ctx) {
  let active = 0;
  app.post("/v1/lifeboat/check-card", async (c) => {
    c.header("Cache-Control", "no-store");
    const body = await c.req.json().catch(() => null);
    // The browser sends only the card's text fields. It never sends the file, images, archive or a key.
    const fields: unknown = body?.fields;
    if (!Array.isArray(fields) || fields.some((field) => typeof field !== "string"))
      throw new ApiError(400, "Send the card’s text as a fields array.", "invalid_request");
    const text = fields.join("\n\n");
    if (!text.trim()) throw new ApiError(400, "The card has no text to check.", "invalid_request");
    if (text.length > MAX_TEXT_CHARS) throw new ApiError(413, "The card has too much text to check.", "payload_too_large");
    if (active >= MAX_CONCURRENT_CHECKS) throw new ApiError(429, "Card checks are busy. Try again shortly.", "rate_limited");
    // Per caller, so the check can't be used as a free classifier oracle. The bucket is a minute-scoped HMAC of the
    // address, never the address itself.
    const from = addressBucket(c, ctx.cfg);
    const bucket = createHmac("sha256", ctx.cfg.appSecret).update(`lifeboat:${Math.floor(Date.now() / 60_000)}:${from.id}`).digest("hex");
    const rate = await ctx.limiter.take(`lifeboat:check:${bucket}`, 1, CHECKS_PER_MINUTE, 60_000).catch(() => null);
    if (!rate?.ok) throw new ApiError(429, "Too many card checks. Try again in a minute.", "rate_limited");

    active++;
    let verdict;
    try {
      verdict = await ctx.anonymo.floor.check({ text, modality: "text", hasUpload: false }, c.req.raw.signal);
    } catch {
      // The same floor as chat: a block leaves the same minimal hit record (hash, length, category). A classifier
      // error can contain input. Keep the error response and logs independent of it.
    } finally {
      active--;
    }
    if (!verdict) throw new ApiError(503, "The card check is temporarily unavailable.", "floor_unavailable");
    if (!verdict.ok) throw new ApiError(451, "This card did not pass the floor check.", "floor_blocked", { category: verdict.category });
    return c.json({ allowed: true });
  });
}
