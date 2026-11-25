import type { Context } from "hono";
import type { Ctx } from "../../context.ts";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TELEGRAM_WEBHOOK = "/v1/telegram/webhook";
export const isTelegramWebhook = (ctx: Ctx, c: Context) =>
  ctx.cfg.features.telegram && c.req.method === "POST" && c.req.path === TELEGRAM_WEBHOOK;

const MAX_INIT_AGE = 15 * 60;
export const LINK_CODE = /^tgl_[a-f0-9]{32}$/;
export const HANDOFF_TOKEN = /^[a-f0-9]{64}$/;
export const SESSION_KEY = /^anm_tg_[a-f0-9]{64}$/;
export const tokenHex = (bytes = 32) => randomBytes(bytes).toString("hex");
export const telegramDigest = (salt: string, purpose: string, value: string) =>
  createHmac("sha256", salt).update(`telegram:${purpose}:v1:${value}`).digest("hex");

export function validWebhookSecret(expected: string, received: string | undefined) {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return !!received && timingSafeEqual(digest(expected), digest(received));
}

export function telegramUserId(id: unknown): id is number {
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0;
}

export function verifiedInitUser(initData: string, botToken: string, now = Date.now()): number | null {
  const fields = new URLSearchParams(initData);
  if (new Set(fields.keys()).size !== [...fields.keys()].length) return null;
  const hash = fields.get("hash");
  const authDate = fields.get("auth_date");
  if (!hash || !/^[a-f0-9]{64}$/.test(hash) || !authDate || !/^\d{1,12}$/.test(authDate)) return null;
  const age = Math.floor(now / 1000) - Number(authDate);
  if (age < -30 || age >= MAX_INIT_AGE) return null;

  fields.delete("hash");
  fields.sort();
  const data = [...fields].map(([name, value]) => `${name}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(data).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) return null;
  try {
    const id = (JSON.parse(fields.get("user") ?? "null") as { id?: unknown } | null)?.id;
    return telegramUserId(id) ? id : null;
  } catch {
    return null;
  }
}
