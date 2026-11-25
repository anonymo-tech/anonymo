import { Hono } from "hono";
import { runChat } from "../../api/chat.ts";
import type { Ctx } from "../../context.ts";
import { fail, isApiError } from "../../lib/errors.ts";
import { freeChatModel } from "../freetier/policy.ts";
import { FREE_REMAINING_HEADER, verifyProof, type FreeProof } from "../freetier/pow.ts";
import { admitFreeProof, freeChallengeFor } from "../freetier/routes.ts";
import { telegramDigest } from "./identity.ts";

const WINDOW = 60_000;
const bucketFor = (salt: string, hash: string) =>
  Buffer.from(telegramDigest(salt, "free", hash), "hex");

export async function telegramLimit(ctx: Ctx, bucket: string, max: number, amount = 1) {
  const state = await ctx.limiter.take(`telegram:${bucket}`, amount, max, WINDOW);
  if (!state.ok) fail(429, "Telegram chat is busy. Try again shortly.", "rate_limited");
  return max - state.remaining;
}

export async function trialChallenge(ctx: Ctx, salt: string, hash: string) {
  await telegramLimit(ctx, `challenge:${hash}`, 20);
  const load = await telegramLimit(ctx, "challenge", 1200);
  return freeChallengeFor(ctx, bucketFor(salt, hash), 1, load, () => telegramLimit(ctx, `invalid:${hash}`, 30, 0));
}

export async function trialProof(ctx: Ctx, salt: string, hash: string, work: string) {
  await telegramLimit(ctx, `proof:${hash}`, 30);
  await telegramLimit(ctx, "proof", 600);
  const proof = verifyProof(ctx.cfg.appSecret, bucketFor(salt, hash), work, Date.now());
  if (!proof) {
    await telegramLimit(ctx, `invalid:${hash}`, 30);
    fail(403, "Solve a current free chat challenge first.", "invalid_free_proof");
  }
  return admitFreeProof(ctx, proof);
}

export async function trialReply(ctx: Ctx, proof: FreeProof, text: string, signal: AbortSignal) {
  await ctx.catalog.ensureFresh();
  const model = freeChatModel(ctx);
  if (!model) fail(503, "Free chat is temporarily unavailable.", "free_unavailable");
  const local = new Hono();
  local.onError((error) => { throw error; });
  local.post("/", (c) => runChat(ctx, c, "chat", undefined, undefined, proof));
  const res = await local.request("/", {
    method: "POST", signal, headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: text }] }),
  });
  if (!res.ok) fail(503, "Free chat is temporarily unavailable.", "free_unavailable");
  const answer = (await res.json() as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  return { text: typeof answer === "string" ? answer : "", remaining: Number(res.headers.get(FREE_REMAINING_HEADER)) };
}

export function trialFailure(error: unknown) {
  if (isApiError(error)) {
    switch (error.type) {
      case "floor_blocked": return "Anonymo blocks this request for everyone. Nothing was charged.";
      case "free_daily_limit": return "You’ve used today’s free messages. Come back after midnight UTC or use /topup to add Stars credit for the full app.";
      case "invalid_free_proof":
      case "free_proof_stale": return "Open the Mini App to get a fresh free reply.";
    }
  }
  return "Free chat is temporarily unavailable. Try again shortly.";
}
