import { createHmac, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import type { Context, Hono } from "hono";
import { verifyMessage, zeroAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { requireKey } from "../../api/auth.ts";
import { readJson } from "../../api/common.ts";
import { CheckoutAbi } from "../../chain/abis.ts";
import type { Ctx } from "../../context.ts";
import { usageInBucket } from "../../ledger/ledger.ts";
import { ApiError, fail } from "../../lib/errors.ts";
import { picoToUsd } from "../../lib/money.ts";
import { creditBucket, entitlements, issueTodaysCredits } from "./entitlements.ts";
import { everydayClient, registerEverydayJobs } from "./indexer.ts";
import { CHAIN_ID, orderIdFor, PASS_CHAT_LIMIT, PRODUCTS } from "./policy.ts";
import { passes, passOrders, stakeLinks } from "./schema.ts";

const BASE = "/v1/everyday";
const walletBody = z.object({ wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((s) => s.toLowerCase() as Address) });
const orderBody = walletBody.extend({ sku: z.enum(["PASS30", "PASS30_PLUS"]) }).strict();
const linkBody = walletBody.extend({
  expires: z.number().int().positive().optional(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform((s) => s as Hex).optional(),
}).strict();

export function linkMessage(secret: string, keyHash: string, wallet: Address, contract: Address, expires: number) {
  const binding = createHmac("sha256", secret).update(`everyday-stake:${keyHash}:${wallet}:${contract}:${expires}`).digest("hex");
  return `Anonymo wallet link for daily credits\n\nWallet: ${wallet}\nRobinhood Chain: ${CHAIN_ID}\nStakeCredits: ${contract}\nKey binding: ${binding}\nExpires: ${new Date(expires * 1000).toISOString()}`;
}

export function everydayRoutes(app: Hono, ctx: Ctx) {
  const config = ctx.cfg.everyday;
  const client = config.rpc ? everydayClient(config.rpc) : null;
  if (client) registerEverydayJobs(ctx, client, config);
  if (client && config.stake && config.stakeStart != null) ctx.jobs.register("everyday-daily", 60_000, async () => {
    try { await issueTodaysCredits(ctx); }
    catch { throw new Error("Everyday daily credit issuance failed."); }
  }, { atStart: true });
  const checkout = client && config.checkoutStart != null ? config.checkout : undefined;
  const stake = config.stake;
  const routes = (method: "get" | "post", path: string, handle: (c: Context) => Promise<Response>) => {
    const endpoint = `${BASE}/${path}`;
    if (method === "post") app.use(endpoint, bodyLimit({ maxSize: 2048 }));
    app[method](endpoint, async (c) => {
      c.header("Cache-Control", "no-store");
      try {
        return await handle(c);
      } catch (error) {
        if (error instanceof ApiError) return c.json(error.toJSON(), error.status as never);
        if (error instanceof z.ZodError) return c.json(new ApiError(400, "Invalid Everyday request.").toJSON(), 400);
        return c.json(new ApiError(503, "This Everyday service is temporarily unavailable.", "everyday_unavailable").toJSON(), 503);
      }
    });
  };

  routes("get", "access", async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    const rights = await entitlements(ctx, key.keyHash);
    const used = rights.daily > 0n ? (await usageInBucket(ctx.db, key.keyHash, creditBucket(rights.day))).covered : 0n;
    return c.json({ ...rights.limits, hasPass: rights.active.length > 0, availableCreditsUsd: picoToUsd(rights.daily - used) });
  });

  if (ctx.cfg.features.passes) {
    routes("get", "passes", async (c) => {
      const key = await requireKey(ctx, c.req.header("authorization"));
      const records = await ctx.db.select({ orderId: passes.orderId, sku: passes.sku, starts: passes.starts, ends: passes.ends })
        .from(passes).where(eq(passes.keyHash, key.keyHash)).orderBy(passes.ends);
      const tokens = checkout && client ? await Promise.all([
        client.getChainId(),
        client.readContract({ address: checkout, abi: CheckoutAbi, functionName: "usdg" }),
        ctx.cfg.features.stake ? client.readContract({ address: checkout, abi: CheckoutAbi, functionName: "nymo" }) : null,
        client.readContract({ address: checkout, abi: CheckoutAbi, functionName: "paused" }),
      ]).catch(() => null) : null;
      return c.json({
        chainId: CHAIN_ID,
        checkout: checkout && tokens?.[0] === CHAIN_ID && tokens[1] !== zeroAddress ? { address: checkout, usdg: tokens[1], nymo: tokens[2], paused: tokens[3] } : null,
        passes: records,
        fairUse: PASS_CHAT_LIMIT,
        confirmations: config.confirmations,
        products: PRODUCTS,
      });
    });

    routes("post", "passes/order", async (c) => {
      const key = await requireKey(ctx, c.req.header("authorization"));
      if (!checkout || !client)
        fail(503, "Pass checkout is unavailable.", "checkout_unavailable");
      if (!(await ctx.limiter.take(`pass-order:${key.keyHash}`, 1, 12, 60_000)).ok)
        fail(429, "Too many checkout requests. Wait a minute and retry.", "rate_limited");
      const { sku, wallet } = orderBody.parse(await readJson(c));
      if (wallet === zeroAddress) fail(400, "Choose a valid wallet.");
      const [chain, paused] = await Promise.all([client.getChainId(), client.readContract({ address: checkout, abi: CheckoutAbi, functionName: "paused" })]);
      if (chain !== CHAIN_ID) fail(503, "Pass checkout is unavailable.", "checkout_unavailable");
      if (paused)
        fail(503, "New pass purchases are paused.", "checkout_paused");
      const ref = `0x${randomBytes(32).toString("hex")}` as Hex;
      const orderId = orderIdFor(checkout, wallet, ref);
      await ctx.db.insert(passOrders).values({ orderId, keyHash: key.keyHash, sku });
      return c.json({ ref, orderId, checkout, sku });
    });
  }

  if (ctx.cfg.features.stake) {
    routes("get", "stake/contract", async (c) => c.json({ chainId: CHAIN_ID, address: stake ?? null }));
    routes("get", "stake", async (c) => {
      const key = await requireKey(ctx, c.req.header("authorization"));
      const rights = await entitlements(ctx, key.keyHash);
      const used = rights.daily > 0n ? (await usageInBucket(ctx.db, key.keyHash, creditBucket(rights.day))).covered : 0n;
      return c.json({
        wallet: rights.wallet,
        tier: rights.tier,
        twab: String(rights.twab),
        day: rights.day,
        dailyCreditsUsd: picoToUsd(rights.daily),
        availableCreditsUsd: picoToUsd(rights.daily - used),
        tierTable: rights.table ?? null,
        limits: rights.limits,
      });
    });
    routes("post", "stake/link", async (c) => {
      const key = await requireKey(ctx, c.req.header("authorization"));
      if (!stake || !client || config.stakeStart == null) fail(503, "Wallet linking is unavailable.", "stake_unavailable");
      if (!(await ctx.limiter.take(`stake-link:${key.keyHash}`, 1, 12, 60_000)).ok)
        fail(429, "Too many wallet link requests. Wait a minute and retry.", "rate_limited");
      const { wallet, signature, expires } = linkBody.parse(await readJson(c));
      if (wallet === zeroAddress || (!!signature !== (expires != null))) fail(400, "Choose a valid wallet and signature.");
      const now = Math.floor(Date.now() / 1000);
      const until = expires ?? now + 300;
      if (until <= now || until > now + 300) fail(401, "This wallet link has expired.", "stake_link_expired");
      const message = linkMessage(ctx.cfg.appSecret, key.keyHash, wallet, stake, until);
      if (!signature) return c.json({ message, expires: until });
      if (!await verifyMessage({ address: wallet, message, signature }).catch(() => false))
        fail(401, "This signature does not match the wallet and key.", "invalid_stake_signature");
      await ctx.db.insert(stakeLinks).values({ wallet, keyHash: key.keyHash }).onConflictDoNothing();
      const [link] = await ctx.db.select().from(stakeLinks).where(eq(stakeLinks.wallet, wallet));
      if (link?.keyHash !== key.keyHash)
        fail(409, "This wallet or key already has a different link.", "stake_already_linked");
      return c.json({ wallet });
    });
  }
}
