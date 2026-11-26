import { and, eq, gt, inArray, isNotNull, notExists, sql } from "drizzle-orm";
import type { KeyRow } from "../../api/auth.ts";
import type { Candidate, ModelRow } from "../../catalog/catalog.ts";
import type { Ctx } from "../../context.ts";
import { ledger, starsOrders } from "../../db/schema.ts";
import { fail } from "../../lib/errors.ts";
import { inferredVariant, isRestricted } from "../../router/lane.ts";
import { offerLane } from "../../router/regular-ppq.ts";
import { ANONYMO_COUNCIL, ANONYMO_RP, ANONYMO_SEALED, routeIdOf } from "../models.ts";

export const FUNDING_KINDS = ["deposit", "credit", "code", "code_credit", "ticket_credit", "stars_credit"];

export async function hasFundedKey(ctx: Pick<Ctx, "db">, key: KeyRow | null) {
  if (!key) return false;
  // A ticket is a key funded by its giver. Use credited ledger entries, which survive spending and withdrawals.
  const reversedStars = ctx.db.select({ charge: starsOrders.chargeId }).from(starsOrders).where(and(
    eq(ledger.ref, sql`'stars:payment:' || ${starsOrders.chargeId}`), isNotNull(starsOrders.refundedAt),
  ));
  const [funding] = await ctx.db.select({ id: ledger.id }).from(ledger).where(and(
    eq(ledger.accountId, key.accountId), eq(ledger.keyHash, key.keyHash), gt(ledger.amount, 0n),
    inArray(ledger.kind, FUNDING_KINDS),
    notExists(reversedStars),
  )).limit(1);
  return !!funding;
}

export function moderatedRoute(ctx: Ctx, model: ModelRow, offer: Candidate) {
  if (offer.upstream !== "selfhost" || offer.tier !== 1) return false;
  const lane = offerLane(ctx.catalog.laneOf(model), offer.weightLane);
  if (isRestricted(lane.variant) || isRestricted(inferredVariant({ id: offer.providerModelId, hfRepo: model.hfRepo }))) return false;
  const ids = ctx.cfg.freeTier.routes;
  return ids.size
    ? ids.has(offer.providerId) || ids.has(routeIdOf(offer))
    : model.id === ANONYMO_RP && offer.isModerated;
}

export function freeChatModel(ctx: Ctx) {
  const eligible = (model: ModelRow) => !model.hidden && ctx.catalog.offers(model.id)
    .some((offer) => offer.status === "live" && offer.provider.status === "live" && moderatedRoute(ctx, model, offer));
  const rp = ctx.catalog.models.get(ANONYMO_RP);
  if (rp && eligible(rp)) return rp.id;
  return [...ctx.catalog.models.values()].find((model) =>
    model.id !== ANONYMO_COUNCIL && model.id !== ANONYMO_SEALED && eligible(model))?.id;
}

const FREE_FIELDS = new Set(["model", "messages", "stream", "stream_options", "max_tokens", "max_completion_tokens"]);
const FREE_ROLES = new Set(["system", "developer", "user", "assistant"]);

/** Free messages have ceilings on the newest message, the instructions and the recent context, so no single request runs away. */
export const FREE_LIMITS = {
  /** The message being answered (about 2,000 tokens): a long question or a pasted page. */
  messageChars: 8_000,
  /** System and developer instructions together, such as a full character card (about 3,000 tokens). */
  instructionChars: 12_000,
  /** Everything sent to the model, instructions included (about 12,000 tokens). Older turns are dropped to fit. */
  contextChars: 48_000,
  /** The reply (about 1,100 words). */
  replyTokens: 1_500,
} as const;

/**
 * Validates a free (or Telegram trial) chat body and shrinks it to the free limits in place. The newest message and the
 * instructions are never cut: if they are too long the request is refused with a plain reason. Older turns are dropped,
 * oldest first, until the rest fits, so a long free conversation keeps going with recent context only.
 */
export function boundFreeChat(body: Record<string, unknown>) {
  const messages = body.messages as { role: string; content: unknown }[];
  if (Object.keys(body).some((field) => !FREE_FIELDS.has(field)) || messages.length > 200 ||
      messages.some((m) => !FREE_ROLES.has(m.role) || typeof m.content !== "string" || Object.keys(m).length !== 2) ||
      !messages.some((m) => m.role === "user" && (m.content as string).trim()))
    fail(400, "Free chat accepts one text reply per request.", "free_text_only");

  const text = messages as { role: string; content: string }[];
  const last = text[text.length - 1];
  if (last.role !== "user") fail(400, "Free chat answers the last message, which must be yours.", "free_text_only");
  if (last.content.length > FREE_LIMITS.messageChars)
    fail(400, `Free messages can be up to ${FREE_LIMITS.messageChars.toLocaleString("en-US")} characters. Shorten it, or add funds for longer messages.`, "free_message_too_long");

  const instructions = text.filter((m) => m.role === "system" || m.role === "developer");
  const instructionChars = instructions.reduce((n, m) => n + m.content.length, 0);
  if (instructionChars > FREE_LIMITS.instructionChars)
    fail(400, `Free chat allows up to ${FREE_LIMITS.instructionChars.toLocaleString("en-US")} characters of instructions or character description. Add funds for longer ones.`, "free_context_too_long");

  // Keep the newest turns that fit, newest first, then restore their order behind the instructions.
  const turns = text.filter((m) => m.role === "user" || m.role === "assistant");
  const kept: typeof turns = [];
  let used = instructionChars;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (used + turns[i].content.length > FREE_LIMITS.contextChars && kept.length) break;
    kept.unshift(turns[i]);
    used += turns[i].content.length;
  }
  body.messages = [...instructions, ...kept];

  body.max_tokens = Math.min(Number(body.max_tokens ?? body.max_completion_tokens ?? FREE_LIMITS.replyTokens) || FREE_LIMITS.replyTokens, FREE_LIMITS.replyTokens);
  delete body.max_completion_tokens;
}

export function fundedKeyRequired() {
  fail(403, "Add funds to your key to unlock this route.", "funded_key_required");
}
