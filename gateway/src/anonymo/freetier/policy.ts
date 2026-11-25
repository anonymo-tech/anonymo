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

export function boundFreeChat(body: Record<string, unknown>) {
  const messages = body.messages as { role: string; content: unknown }[];
  if (Object.keys(body).some((field) => !FREE_FIELDS.has(field)) || messages.length > 32 ||
      messages.some((m) => !FREE_ROLES.has(m.role) || typeof m.content !== "string" || Object.keys(m).length !== 2) ||
      !messages.some((m) => m.role === "user" && (m.content as string).trim()) ||
      messages.reduce((bytes, m) => bytes + Buffer.byteLength(m.content as string), 0) > 32_768)
    fail(400, "Free chat accepts one text reply per request, with up to 32 messages and 32 KiB of context.", "free_text_only");

  body.max_tokens = Math.min(Number(body.max_tokens ?? body.max_completion_tokens ?? 512), 512);
  delete body.max_completion_tokens;
}

export function fundedKeyRequired() {
  fail(403, "Add funds to your key to unlock this route.", "funded_key_required");
}
