// Keys (spec: Backend §3, §11). No account and nothing personal:
//   POST /keys              → a new anm_live_… key, shown exactly once; only its sha256 is stored.
//   GET  /keys/siwe/nonce   → a one-time nonce for Sign-In with Ethereum.
//   POST /keys/siwe         → a new key bound to the signing wallet; withdrawals may then go to that wallet.
//   GET  /keys/me           → the calling key's caps, wallet and deposit instructions (never the secret).
//   PATCH /keys/caps        → change the calling key's caps.

import type { Context, Hono } from "hono";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Ctx } from "../../context.ts";
import { ANONYMO_KEY_PREFIX } from "../../chain/keys.ts";
import { registerRootKey, requireKey } from "../../api/auth.ts";
import { addressBucket, clientIp, readJson } from "../../api/common.ts";
import { fail } from "../../lib/errors.ts";
import { sha256 } from "../../lib/util.ts";
import { firstChatAvailable, issueFirstChat } from "./first-chat.ts";
import type { MoneyDeps } from "../deposits/services.ts";
import { depositInstructions } from "../deposits/instructions.ts";
import { assertIpAllowed, capsInput, capsJson, readCaps, readKeyPolicy, writeCaps } from "./caps.ts";
import { issueSiweNonce, verifySiwe } from "./siwe.ts";

export const generateAnonymoKey = () => ANONYMO_KEY_PREFIX + randomBytes(32).toString("hex");

const createBody = z.object({ caps: capsInput.optional(), dashboard_signup: z.uuidv4().optional() }).strict();
const siweBody = z.object({ message: z.string().max(4096), signature: z.string().max(200), caps: capsInput.optional() }).strict();

async function mint(ctx: Ctx, deps: MoneyDeps, o: { caps?: z.infer<typeof capsInput>; wallet?: string; signup?: string }) {
  const secret = generateAnonymoKey();
  const row = await registerRootKey(ctx, secret);
  const caps = await writeCaps(ctx.db, row.keyHash, o.caps ?? {}, { wallet: o.wallet ?? null });
  const deposit = await depositInstructions(ctx, deps, row.keyHash);
  const eligible = o.signup && await issueFirstChat(ctx.db, row.accountId, o.signup);
  return {
    key: secret, // shown once; the router keeps only sha256(key)
    key_hash: row.keyHash,
    wallet: o.wallet ?? null,
    caps: capsJson(caps),
    deposit,
    first_chat_available: !!eligible && await firstChatAvailable(ctx.db, row.accountId),
  };
}

const noStore = (c: Context) => c.header("cache-control", "no-store");

// Origin selects the first-party browser flow. The signup throttle and the shared dispatch quota
// also apply to scripted clients, which can supply an Origin header themselves.
function dashboardOrigin(origin: string | undefined, siteUrl: string) {
  if (!origin) return false;
  const site = new URL(siteUrl);
  if (origin === site.origin || origin === "https://anonymo.tech" || origin === "https://www.anonymo.tech") return true;
  const local = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (!local.has(site.hostname)) return false;
  try {
    const candidate = new URL(origin);
    return candidate.origin === origin && /^https?:$/.test(candidate.protocol) && local.has(candidate.hostname);
  } catch { return false; }
}

export function keysRoutes(app: Hono, ctx: Ctx, deps: MoneyDeps) {
  const siweDomain = () => deps.config.siweDomain ?? new URL(ctx.cfg.publicUrl).host;

  app.post("/keys", async (c) => {
    const body = createBody.parse(await readJson(c));
    noStore(c);
    const signup = dashboardOrigin(c.req.header("origin"), ctx.cfg.siteUrl) ? body.dashboard_signup : undefined;
    if (signup) {
      const from = addressBucket(c, ctx.cfg);
      const hour = Math.floor(Date.now() / 3_600_000);
      const bucket = sha256(`anonymo:first-chat:signup:${hour}:${from.id}`);
      const limit = await ctx.limiter.take(`dashboard-signup:${bucket}`, 1, from.scale(ctx.cfg.limits.newKeysPerHour), 3_600_000);
      if (!limit.ok) fail(429, "Too many new keys from this address. Try again later.", "rate_limited");
    }
    return c.json(await mint(ctx, deps, { caps: body.caps, signup }), 201);
  });

  app.get("/keys/siwe/nonce", async (c) => {
    noStore(c);
    return c.json({ ...(await issueSiweNonce(ctx.db)), domain: siweDomain(), uri: ctx.cfg.publicUrl, statement: "Mint an Anonymo API key bound to this wallet." });
  });

  app.post("/keys/siwe", async (c) => {
    const body = siweBody.parse(await readJson(c));
    const wallet = await verifySiwe(ctx.db, { domain: siweDomain(), message: body.message, signature: body.signature });
    noStore(c);
    return c.json(await mint(ctx, deps, { caps: body.caps, wallet }), 201);
  });

  app.get("/keys/me", async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    const caps = await readCaps(ctx.db, key.keyHash);
    return c.json({ key_hash: key.keyHash, label: key.label, first_chat_available: await firstChatAvailable(ctx.db, key.accountId), caps: capsJson(caps), deposit: await depositInstructions(ctx, deps, key.keyHash) });
  });

  app.patch("/keys/caps", async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    if (key.scope === "inference") fail(403, "An inference-only key cannot change caps.", "inference_only");
    // A cap change must come from an address allowed by the current policy, including when it clears the allowlist.
    const callerIp = clientIp(c, ctx.cfg.trustProxy);
    assertIpAllowed((await readKeyPolicy(ctx.db, key.keyHash))?.ipAllow ?? null, callerIp);
    const caps = capsInput.parse(await readJson(c));
    const next = await writeCaps(ctx.db, key.keyHash, caps, { callerIp });
    return c.json({ key_hash: key.keyHash, caps: capsJson(next) });
  });
}
