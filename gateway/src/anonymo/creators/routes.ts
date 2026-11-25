import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { hexToString, pad, parseAbiItem, zeroAddress, type Hex } from "viem";
import { z } from "zod";
import { bearer, requireKey, requireRole, resolveKey, walletAuth } from "../../api/auth.ts";
import { readJson } from "../../api/common.ts";
import { BoostsAbi, VoteRegistryAbi } from "../../chain/abis.ts";
import { cardHash, normalizeCard } from "../../characters/card.ts";
import type { Ctx } from "../../context.ts";
import { fail, isApiError } from "../../lib/errors.ts";
import { picoToUsdString } from "../../lib/money.ts";
import { hmac, safeEqual, sha256 } from "../../lib/util.ts";
import { sexualPromptRule } from "../media/prompt-check.ts";
import { canSeeAdult, creatorId, profileShape } from "./card.ts";
import { creatorPayoutTick, walletClaims } from "./payouts.ts";
import { acceptReferral, creatorReferralTick, referralLink } from "./referrals.ts";
import { creatorAccruals, creatorCharacters, payoutRoots } from "./schema.ts";

const API = "/api/v1/creators";
const wallet = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase() as Hex)
  .refine((value) => value !== zeroAddress);
const publication = z.strictObject({
  ...profileShape,
  cardHash: z.string().regex(/^[a-f0-9]{64}$/),
  creatorWallet: wallet,
  shareBps: z.number().int().min(0).max(1500),
  adult: z.boolean(),
});
const search = z.object({ q: z.string().trim().max(80).optional(), tag: z.string().trim().max(32).optional(), adult: z.enum(["0", "1"]).optional() });
const optionRegistered = parseAbiItem("event OptionRegistered(uint256 indexed epoch, uint8 indexed ballot, bytes32 indexed option)");
const MAX_CARDS = 100;
const boostCreator = (address: Hex) => pad(address, { size: 32 });

function optionTitle(option: Hex) {
  const text = hexToString(option, { size: 32 }).replace(/\0+$/, "");
  return /^[\w .-]{1,32}$/.test(text) ? text : option;
}

async function limit(ctx: Ctx, keyHash: string, operation: string, max: number) {
  const digest = hmac(ctx.cfg.appSecret, `creator-write:${keyHash}`);
  const rate = await ctx.limiter.take(`creators:write:${operation}:${digest}`, 1, max, 60_000);
  if (!rate.ok) fail(429, "Try again in a minute.", "rate_limited");
}

async function signedWallet(ctx: Ctx, c: Context, expected: Hex) {
  const auth = c.req.header("x-wallet-auth");
  if (!auth) fail(401, "Connect your creator wallet and sign this request.", "wallet_required");
  const proof = await walletAuth(ctx, auth, sha256(await c.req.text()));
  if (proof.wallet !== expected) fail(403, "Use the creator wallet for this request.", "wallet_required");
}

function listCard(row: typeof creatorCharacters.$inferSelect) {
  return { id: row.id, name: row.name, description: row.description, tags: row.tags, adult: row.adult, wallet: row.creatorWallet, shareBps: row.shareBps, seed: row.cardHash.slice(0, 12) };
}

export function creatorRoutes(app: Hono, ctx: Ctx) {
  const { payouts, boosts, votes, startBlock } = ctx.cfg.creators;
  let voteCache: { expires: number; data: unknown } | undefined;
  const boostCache = new Map<string, { expires: number; amount: bigint }>();

  app.use(`${API}/*`, async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    try {
      await next();
    } catch (error) {
      if (isApiError(error) || error instanceof z.ZodError) throw error;
      fail(503, "Creator tools are temporarily unavailable.", "creators_unavailable");
    }
  });
  app.get(`${API}/contracts`, (c) => c.json({
    chainId: ctx.cfg.chain.id, rpc: ctx.cfg.chain.publicRpcUrl, usdg: ctx.cfg.chain.usdg,
    payouts: payouts ?? null, votes: votes ?? null, boosts: boosts ?? null,
  }));

  app.post(`${API}/publish`, async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    await requireRole(ctx, key, ["owner"]);
    await limit(ctx, key.keyHash, "publish", 4);
    const card = publication.parse(await readJson(c));
    await signedWallet(ctx, c, card.creatorWallet);
    const tags = [...new Set(card.tags.map((tag) => tag.toLowerCase()))];
    const hash = await cardHash(normalizeCard({ name: card.name, description: card.description, personality: card.personality, scenario: card.scenario, tags }));
    if (hash !== card.cardHash) fail(400, "The public profile does not match its card hash.", "card_hash_mismatch");
    const text = [card.name, card.description, card.personality, card.scenario, ...tags].join("\n\n");
    const verdict = await ctx.anonymo.floor.check({ text, modality: "text", hasUpload: false }, c.req.raw.signal).catch(() => null);
    if (!verdict) fail(503, "The card check is temporarily unavailable.", "floor_unavailable");
    if (!verdict.ok) fail(451, "This card did not pass the floor check.", "floor_blocked", { category: verdict.category });
    const adult = card.adult || sexualPromptRule(text) || tags.some((tag) => tag === "adult" || tag === "18+");
    const [prior] = await ctx.db.select().from(creatorCharacters).where(eq(creatorCharacters.cardHash, card.cardHash));
    if (prior && prior.creatorWallet === card.creatorWallet) {
      if (adult && !prior.adult) {
        await ctx.db.update(creatorCharacters).set({ adult: true }).where(eq(creatorCharacters.id, prior.id));
        return c.json({ data: listCard({ ...prior, adult: true }) });
      }
      return c.json({ data: listCard(prior) });
    }
    const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(creatorCharacters)
      .where(eq(creatorCharacters.creatorWallet, card.creatorWallet));
    if (n >= MAX_CARDS) fail(409, "This wallet has reached its published character limit.", "character_limit_reached");
    const [created] = await ctx.db.insert(creatorCharacters).values({ ...card, tags, adult, floorVerdict: { allowed: true } })
      .onConflictDoNothing().returning();
    if (!created) fail(409, "This card is already published.", "card_already_published");
    return c.json({ data: listCard(created) }, 201);
  });

  app.get(`${API}/discover`, async (c) => {
    const query = search.parse(c.req.query());
    const secret = bearer(c.req.header("authorization"));
    const key = query.adult === "1" && secret ? await resolveKey(ctx, secret) : null;
    const mature = await canSeeAdult(ctx, key, query.adult === "1");
    const where = [mature ? undefined : eq(creatorCharacters.adult, false)];
    if (query.tag) where.push(sql`${query.tag.toLowerCase()} = any(${creatorCharacters.tags})`);
    if (query.q) {
      const q = `%${query.q.replace(/[\\%_]/g, (char) => "\\" + char)}%`;
      where.push(or(ilike(creatorCharacters.name, q), ilike(creatorCharacters.description, q)));
    }
    const rows = await ctx.db.select().from(creatorCharacters).where(and(...where))
      .orderBy(desc(creatorCharacters.publishedAt), creatorCharacters.id).limit(100);
    const addresses = [...new Set(rows.map((row) => row.creatorWallet))];
    const weights = new Map<string, bigint>();
    if (boosts) {
      if (boostCache.size > 1000) boostCache.clear();
      await Promise.all(addresses.map(async (address) => {
        const cached = boostCache.get(address);
        const amount = cached && cached.expires > Date.now() ? cached.amount : await ctx.chain.client.readContract({
          address: boosts, abi: BoostsAbi, functionName: "totalBoosted", args: [boostCreator(address as Hex)],
        }).catch(() => 0n);
        if (!cached || cached.expires <= Date.now()) boostCache.set(address, { amount, expires: Date.now() + 60_000 });
        weights.set(address, amount);
      }));
    }
    rows.sort((a, b) => {
      const x = weights.get(a.creatorWallet) ?? 0n;
      const y = weights.get(b.creatorWallet) ?? 0n;
      return x === y ? 0 : x > y ? -1 : 1;
    });
    return c.json({ data: rows.map(listCard), mature });
  });

  app.post(`${API}/stats`, async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    await limit(ctx, key.keyHash, "stats", 10);
    const input = z.strictObject({ creatorWallet: wallet, nonce: creatorId }).parse(await readJson(c));
    await signedWallet(ctx, c, input.creatorWallet);
    const rows = await ctx.db.select({
      card: creatorCharacters,
      chats: sql<string>`coalesce(sum(${creatorAccruals.chats}), 0)`,
      spend: sql<string>`coalesce(sum(${creatorAccruals.spend}), 0)`,
      held: sql<string>`coalesce(sum(${creatorAccruals.amount} - ${creatorAccruals.allocated}) filter (where not ${creatorAccruals.frozen}), 0)`,
      frozen: sql<string>`coalesce(sum(${creatorAccruals.amount} - ${creatorAccruals.allocated}) filter (where ${creatorAccruals.frozen}), 0)`,
    }).from(creatorCharacters).leftJoin(creatorAccruals, eq(creatorAccruals.characterId, creatorCharacters.id))
      .where(eq(creatorCharacters.creatorWallet, input.creatorWallet)).groupBy(creatorCharacters.id)
      .orderBy(desc(creatorCharacters.publishedAt)).limit(MAX_CARDS);
    return c.json({ data: await Promise.all(rows.map(async (row) => ({
      ...listCard(row.card), chats: Number(row.chats), spend: picoToUsdString(BigInt(row.spend)),
      held: picoToUsdString(BigInt(row.held)), frozen: picoToUsdString(BigInt(row.frozen)),
      audience: await ctx.creatorCounters?.audience(Date.now(), row.card.id).catch(() => null) ?? null,
    }))) });
  });

  app.get(`${API}/claims`, async (c) => c.json({ data: await walletClaims(ctx, wallet.parse(c.req.query("wallet"))) }));
  app.get(`${API}/funding`, async (c) => {
    const token = bearer(c.req.header("authorization"));
    if (!ctx.cfg.adminToken || !token || !safeEqual(token, ctx.cfg.adminToken)) fail(401, "Operator token required.", "unauthorized");
    const rows = await ctx.db.select({ week: payoutRoots.week, root: payoutRoots.root, total: payoutRoots.total, tx: payoutRoots.tx }).from(payoutRoots);
    return c.json({ data: rows });
  });
  app.post(`${API}/review`, async (c) => {
    const token = bearer(c.req.header("authorization"));
    if (!ctx.cfg.adminToken || !token || !safeEqual(token, ctx.cfg.adminToken)) fail(401, "Operator token required.", "unauthorized");
    const { id, day, release } = z.strictObject({ id: creatorId, day: z.iso.date(), release: z.boolean() }).parse(await readJson(c));
    const [row] = await ctx.db.update(creatorAccruals).set({ reviewed: true, frozen: !release })
      .where(and(eq(creatorAccruals.characterId, id), eq(creatorAccruals.day, day), eq(creatorAccruals.frozen, true)))
      .returning({ id: creatorAccruals.characterId });
    if (!row) fail(404, "No frozen accrual for that character and day.", "not_found");
    return c.json({ released: release });
  });

  app.post(`${API}/referral-link`, async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    await requireRole(ctx, key, ["owner"]);
    await limit(ctx, key.keyHash, "referral", 10);
    if (!ctx.cfg.creators.referralBonus) fail(503, "Referral credits are unavailable.", "referrals_unavailable");
    return c.json({ code: await referralLink(ctx, key) });
  });

  app.post(`${API}/referral-accept`, async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    await requireRole(ctx, key, ["owner"]);
    await limit(ctx, key.keyHash, "accept", 10);
    const { code } = z.strictObject({ code: creatorId }).parse(await readJson(c));
    await acceptReferral(ctx, key, code);
    return c.json({ accepted: true });
  });

  app.get(`${API}/votes`, async (c) => {
    if (!votes || startBlock === undefined) fail(503, "Votes are unavailable.", "votes_unavailable");
    if (voteCache && voteCache.expires > Date.now()) return c.json(voteCache.data);
    const call = { address: votes, abi: VoteRegistryAbi };
    const epoch = await ctx.chain.client.readContract({ ...call, functionName: "currentEpoch" });
    const logs = await ctx.chain.client.getLogs({ address: votes, event: optionRegistered, args: { epoch }, fromBlock: startBlock, strict: true });
    const options = await Promise.all(logs.map(async ({ args: { ballot, option } }) => ({
      ballot, option, label: optionTitle(option), tally: String(await ctx.chain.client.readContract({ ...call, functionName: "tally", args: [epoch, ballot, option] })),
    })));
    const data = { epoch: Number(epoch), closesAt: new Date((Number(epoch) + 1) * 604_800_000).toISOString(), options };
    voteCache = { data, expires: Date.now() + 30_000 };
    return c.json(data);
  });

  ctx.jobs.register("creator-payouts", 15 * 60_000, () => creatorPayoutTick(ctx).catch(() => { throw new Error("Creator payout processing failed."); }));
  ctx.jobs.register("creator-referrals", 60_000, () => creatorReferralTick(ctx).catch(() => { throw new Error("Creator referral processing failed."); }));
}
