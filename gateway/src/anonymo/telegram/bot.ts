import { z } from "zod";
import { KEY_RE } from "../../chain/keys.ts";
import type { Ctx } from "../../context.ts";
import { isApiError } from "../../lib/errors.ts";
import { picoToUsdString, usdToPico } from "../../lib/money.ts";
import { LINK_CODE, telegramDigest, telegramUserId } from "./identity.ts";
import { createHandoff, linkKey, linkedKey, takeTrial, unlinkKey } from "./store.ts";
import { crisisNotice } from "./safety.ts";
import { issueInvoice, readInvoice, recordStars } from "./stars.ts";
import { telegramLimit, trialFailure, trialProof, trialReply } from "./trial.ts";

export const DISCLOSURE = "Telegram keeps messages sent here. The full app is where nobody keeps the chat.";
const HELP = [
  "Start in Telegram. Open the app when you want more.",
  "Anonymo is an AI chat for adults. " + DISCLOSURE,
  "Open the Mini App to try free chat or unlock one reply in this bot.",
  "In the full app, open API key → Link Telegram and paste the one-time code here. Then use /topup for Stars.",
  "Use /open to open the full app, /unlink to remove the link, or /paysupport for payment help.",
].join("\n\n");
const payment = z.object({
  currency: z.literal("XTR"),
  total_amount: z.number().int().positive(),
  invoice_payload: z.string().max(128),
  telegram_payment_charge_id: z.string().regex(/^[!-~]{1,256}$/),
});
const checkout = payment.omit({ telegram_payment_charge_id: true }).extend({
  id: z.string().min(1).max(128), from: z.object({ id: z.number().refine(telegramUserId) }),
});
const message = z.object({
  chat: z.object({ id: z.number().refine(telegramUserId), type: z.literal("private") }),
  from: z.object({ id: z.number().refine(telegramUserId), is_bot: z.boolean().optional() }).optional(),
  text: z.string().max(4096).optional(),
  successful_payment: payment.optional(),
  refunded_payment: payment.optional(),
});

export type Bot = (method: string, payload: Record<string, unknown>) => Promise<void>;
export type TelegramSettings = NonNullable<ReturnType<typeof telegramSettings>>;

export function telegramSettings(cfg: Ctx["cfg"]) {
  const { botToken, webhookSecret, idSalt, topupStars, topupUsd, salesPaused } = cfg.telegram;
  if (!botToken || !/^\d+:[\w-]+$/.test(botToken) || !webhookSecret || !/^[\w-]{1,256}$/.test(webhookSecret) || !idSalt || idSalt.length < 32) return null;
  const site = new URL(cfg.siteUrl);
  if (site.protocol !== "https:" || site.username || site.password || site.search || site.hash) return null;
  const pack = topupStars && topupUsd && /^[1-9]\d{0,4}$/.test(topupStars) && /^(?:0|[1-9]\d{0,3})(?:\.\d{1,2})?$/.test(topupUsd)
    ? { stars: Number(topupStars), credit: usdToPico(topupUsd) } : null;
  return { botToken, webhookSecret, idSalt, site: site.origin, pack: pack && pack.credit > 0n ? pack : null, salesPaused };
}

export function telegramBot(token: string): Bot {
  return async (method, payload) => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(7_000),
      });
      const result = await res.json() as { ok?: boolean };
      if (res.ok && result.ok) return;
    } catch {
      // The provider error can contain the request target or body.
    }
    throw new Error("Telegram Bot API unavailable");
  };
}

export function handoffUrl(site: string, token: string | null) {
  return token ? `${site}/telegram/handoff#handoff=${token}` : `${site}/dashboard/chat`;
}

function botReply(text: string) {
  // Telegram clients auto-link plain text. Only our fixed buttons carry destinations.
  return text.normalize("NFKC").replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|bitcoin:|lightning:|ethereum:|solana:|ton:)[^\s]+|[\p{L}\p{N}_-]+(?:[.。｡．][\p{L}\p{N}_-]+)+[^\s]*/giu, "[link omitted]").slice(0, 3900);
}

export async function handleUpdate(ctx: Ctx, settings: TelegramSettings, bot: Bot, update: Record<string, unknown>, signal: AbortSignal) {
  const digest = (id: number) => telegramDigest(settings.idSalt, "user", String(id));
  if (update.pre_checkout_query) {
    const raw = update.pre_checkout_query as { id?: unknown };
    if (typeof raw.id !== "string" || !raw.id || raw.id.length > 128) return;
    const query = checkout.safeParse(raw);
    const hash = query.success ? digest(query.data.from.id) : "";
    const quote = query.success ? readInvoice(settings.idSalt, hash, query.data.invoice_payload) : null;
    let ok = false;
    if (!settings.salesPaused && quote && query.success && quote.stars === query.data.total_amount &&
        quote.expires > Date.now() / 1000) {
      try {
        const key = await Promise.race([linkedKey(ctx.db, hash), Bun.sleep(1500).then(() => null)]);
        ok = key?.keyHash === quote.keyHash;
      } catch {
        // Answer within Telegram’s deadline even if the database is unavailable.
      }
    }
    await bot("answerPreCheckoutQuery", { pre_checkout_query_id: raw.id, ok,
      ...(!ok ? { error_message: "This invoice is unavailable. Open /topup to try again." } : {}) });
    return;
  }

  const parsed = message.safeParse(update.message);
  if (!parsed.success) return;
  const { chat, from, text, successful_payment, refunded_payment } = parsed.data;
  const hash = digest(chat.id);
  const mini = { inline_keyboard: [[{ text: "Open Mini App", web_app: { url: `${settings.site}/telegram/mini` } }]] };
  const send = (text: string, reply_markup?: object) => bot("sendMessage", {
    chat_id: chat.id, text, link_preview_options: { is_disabled: true }, ...(reply_markup ? { reply_markup } : {}),
  });
  const event = refunded_payment ?? successful_payment;
  if (event) {
    const quote = readInvoice(settings.idSalt, hash, event.invoice_payload);
    if (!quote || quote.stars !== event.total_amount) return;
    const result = await recordStars(ctx.db, event.telegram_payment_charge_id, quote, !!refunded_payment);
    if (result !== "duplicate") await send(result === "credited"
      ? `$${picoToUsdString(quote.credit)} in chat credit added. Use /open to continue in the full app.`
      : "This Stars payment was refunded and its chat credit was reversed.").catch(() => {});
    return;
  }
  if (!text?.trim() || from?.id !== chat.id || from.is_bot) return;
  try {
    await telegramLimit(ctx, `bot:${hash}`, 20);
  } catch (error) {
    if (isApiError(error) && error.type === "rate_limited") return;
    throw error;
  }
  const input = text.trim();
  const [command, argument] = input.split(/\s+/, 2);
  switch (command.split("@")[0].toLowerCase()) {
    case "/start":
    case "/help":
      await send(HELP, mini);
      return;
    case "/paysupport":
      await send("For help with a Stars payment, report a problem from its Telegram receipt or contact Anonymo through the full app.");
      return;
    case "/unlink":
      await unlinkKey(ctx.db, hash);
      await send("Telegram link removed.");
      return;
    case "/open": {
      const token = await createHandoff(ctx.db, hash);
      await send(DISCLOSURE, { inline_keyboard: [[{ text: "Open the full app", url: handoffUrl(settings.site, token) }]] });
      return;
    }
    case "/topup": {
      const key = await linkedKey(ctx.db, hash);
      if (!key) { await send("Generate a one-time code in the full app under API key → Link Telegram and paste it here."); return; }
      const pack = settings.pack;
      if (!pack || settings.salesPaused) { await send("Stars top-ups are temporarily unavailable."); return; }
      await bot("sendInvoice", {
        chat_id: chat.id, title: "Anonymo chat credit",
        description: `$${picoToUsdString(pack.credit)} in chat credit for the linked Anonymo key.`,
        payload: issueInvoice(settings.idSalt, hash, key.keyHash, pack), provider_token: "", currency: "XTR",
        prices: [{ label: "Chat credit", amount: pack.stars }], start_parameter: "stars-topup",
      });
      return;
    }
    case "/link":
      if (argument && LINK_CODE.test(argument) && await linkKey(ctx.db, hash, argument)) {
        await send("Key linked. Use /topup to add chat credit with Stars.");
      } else {
        await send("Paste a fresh one-time code from the full app under API key → Link Telegram.");
      }
      return;
  }
  if (LINK_CODE.test(input)) {
    await send(await linkKey(ctx.db, hash, input) ? "Key linked. Use /topup to add chat credit with Stars."
      : "That code was used or expired. Generate a fresh code in the full app.");
    return;
  }
  if (input.startsWith("/")) { await send("Use /help for the available commands.", mini); return; }
  if (KEY_RE.test(input)) {
    await send("Keep your API key in the full app. Paste only the one-time link code here.");
    return;
  }
  const crisis = crisisNotice(input);
  const withCrisis = (text: string) => crisis ? `${crisis}\n\n${text}`.slice(0, 4096) : text;
  const work = await takeTrial(ctx, settings.idSalt, hash);
  if (!work) { await send(withCrisis("Open the Mini App and tap Enable a bot reply, then return here and send a message."), mini); return; }
  let answer: string;
  try {
    const proof = await trialProof(ctx, settings.idSalt, hash, work);
    const reply = await trialReply(ctx, proof, input, signal);
    answer = `Anonymo AI · ${reply.remaining} free today\n\n${botReply(reply.text) || "No text was returned."}`;
  } catch (error) {
    answer = trialFailure(error);
  }
  await send(withCrisis(answer), mini);
}
