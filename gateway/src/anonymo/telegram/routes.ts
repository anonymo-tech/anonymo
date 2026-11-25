import type { Hono } from "hono";
import { z } from "zod";
import { requireKey } from "../../api/auth.ts";
import { readJson } from "../../api/common.ts";
import type { Ctx } from "../../context.ts";
import { fail, isApiError } from "../../lib/errors.ts";
import { regionRulesFromEnv, parseRegion } from "../region/rules.ts";
import { handleUpdate, handoffUrl, telegramBot, telegramSettings, type Bot } from "./bot.ts";
import { HANDOFF_TOKEN, TELEGRAM_WEBHOOK, telegramDigest, validWebhookSecret, verifiedInitUser } from "./identity.ts";
import { armTrial, createHandoff, createLinkCode, exchangeHandoff, linkedKey, purgeTelegramTokens } from "./store.ts";
import { telegramLimit, trialChallenge, trialProof, trialReply } from "./trial.ts";


const session = { init_data: z.string().min(1).max(16_384) };
const proof = { ...session, adult: z.literal(true), work: z.string().min(1).max(160) };
const miniRequest = z.discriminatedUnion("action", [
  z.strictObject({ ...session, action: z.literal("verify") }),
  z.strictObject({ ...session, action: z.literal("handoff") }),
  z.strictObject({ ...session, adult: z.literal(true), action: z.literal("challenge") }),
  z.strictObject({ ...proof, action: z.literal("arm") }),
  z.strictObject({ ...proof, action: z.literal("chat"), text: z.string().trim().min(1).max(4096) }),
]);

export function telegramRoutes(app: Hono, ctx: Ctx, env: Record<string, unknown>, sendBot?: Bot) {
  const settings = telegramSettings(ctx.cfg);
  const bot = settings && (sendBot ?? telegramBot(settings.botToken));
  const region = regionRulesFromEnv(env);
  ctx.jobs.register("telegram-token-expiry", 60_000, () => purgeTelegramTokens(ctx.db).then(() => {}), { atStart: true });

  app.use("/v1/telegram/*", async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
  });

  app.post(TELEGRAM_WEBHOOK, async (c) => {
    if (!settings || !bot) fail(503, "Telegram is temporarily unavailable.", "telegram_unavailable");
    if (!validWebhookSecret(settings.webhookSecret, c.req.header("x-telegram-bot-api-secret-token")))
      fail(401, "Invalid webhook secret.", "invalid_telegram_webhook");
    const update = z.record(z.string(), z.unknown()).safeParse(await readJson(c));
    if (!update.success) fail(400, "Invalid Telegram update.", "invalid_telegram_update");
    try {
      await handleUpdate(ctx, settings, bot, update.data, c.req.raw.signal);
    } catch {
      fail(503, "Telegram update could not be processed.", "telegram_update_unavailable");
    }
    return c.json({ ok: true });
  });

  app.post("/v1/telegram/link-code", async (c) => {
    if (!settings) fail(503, "Telegram is temporarily unavailable.", "telegram_unavailable");
    const key = await requireKey(ctx, c.req.header("authorization"));
    if (!key.management) fail(403, "Use the primary key to link Telegram.", "telegram_link_forbidden");
    await telegramLimit(ctx, `link:${key.keyHash}`, 5);
    return c.json({ code: await createLinkCode(ctx.db, key.keyHash), expires_in: 300 }, 201);
  });

  app.post("/v1/telegram/handoff", async (c) => {
    if (!settings) fail(503, "Telegram is temporarily unavailable.", "telegram_unavailable");
    await telegramLimit(ctx, "handoff", 600);
    const body = z.strictObject({ token: z.string().regex(HANDOFF_TOKEN) }).safeParse(await readJson(c));
    if (!body.success) fail(400, "Invalid handoff link.", "invalid_telegram_handoff");
    const session = await exchangeHandoff(ctx.db, body.data.token);
    if (!session) fail(410, "This handoff link was used or expired. Open a fresh one in Telegram.", "telegram_handoff_expired");
    return c.json(session);
  });

  app.post("/v1/telegram/mini", async (c) => {
    if (!settings) fail(503, "Telegram is temporarily unavailable.", "telegram_unavailable");
    await telegramLimit(ctx, "mini", 2400);
    const body = miniRequest.safeParse(await readJson(c));
    if (!body.success) fail(400, "Invalid Mini App request.", "invalid_telegram_request");
    const id = verifiedInitUser(body.data.init_data, settings.botToken);
    if (!id) fail(401, "Open Anonymo again from Telegram.", "invalid_telegram_init_data");
    const hash = telegramDigest(settings.idSalt, "user", String(id));
    const data = body.data;
    try {
      switch (data.action) {
        case "verify":
          return c.json({ linked: !!await linkedKey(ctx.db, hash) });
        case "handoff": {
          await telegramLimit(ctx, `open:${hash}`, 10);
          return c.json({ url: handoffUrl(settings.site, await createHandoff(ctx.db, hash)) });
        }
        default: {
          const declared = c.req.header("x-anonymo-declared-region");
          if (declared && !parseRegion(declared)) fail(400, "Use an ISO country or subdivision code.", "invalid_region");
          if (!ctx.cfg.features.compliance && declared && region.forCountry(declared).blocked)
            fail(451, "Anonymo is unavailable in this region.", "region_blocked");
          if (data.action === "challenge") return c.json(await trialChallenge(ctx, settings.idSalt, hash));
          const verified = await trialProof(ctx, settings.idSalt, hash, data.work);
          if (data.action === "arm") {
            // The edge and age check happen here. Telegram webhooks carry Telegram’s location, not the user’s.
            await armTrial(ctx, settings.idSalt, hash, data.work, new Date(verified.expires));
            return c.json({ expires_at: verified.expires });
          }
          return c.json(await trialReply(ctx, verified, data.text, c.req.raw.signal));
        }
      }
    } catch (error) {
      if (isApiError(error) && ["floor_blocked", "floor_unavailable", "region_blocked", "invalid_region",
        "free_daily_limit", "free_proof_stale", "invalid_free_proof", "free_unavailable", "rate_limited"].includes(error.type)) throw error;
      fail(503, "Telegram is temporarily unavailable.", "telegram_unavailable");
    }
  });
}
