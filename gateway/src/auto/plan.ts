// Auto Model (`anonymo-auto`): one model id that picks a model for each request. Called once from api/chat.ts, after
// the floor gate has passed (a blocked prompt never gets here, and is never rerouted) and before model resolution.
//
// It classifies the request (auto/classify.ts), keeps the class's configured candidates that are live and can serve
// this request under the same filters any model gets (price limits, key allowlist and budget, lane, `:private`, sealed,
// tools, context), ranks them (auto/rank.ts) and rewrites `model` / `models` to the ranked list. From there the request
// is an ordinary single call: the first model is tried first, the others are the fallback list, and the refusal catch
// and reroute run unchanged. The response, its receipts and its billing are those of the model that answered; Auto
// adds no fee. The class is returned in `x-anonymo-auto`.

import type { Ctx } from "../context.ts";
import type { Candidate, ModelRow, Modifier } from "../catalog/catalog.ts";
import type { KeyRow } from "../api/auth.ts";
import { servable } from "../api/models.ts";
import { servedDisclosure } from "../api/disclosure.ts";
import { fundedOffers } from "../rush/availability.ts";
import { ApiError } from "../lib/errors.ts";
import { usdToPico, type Pico } from "../lib/money.ts";
import { attestationFresh, type ProviderPrefs } from "../router/select.ts";
import type { DisclosureRequest } from "../router/disclosure.ts";
import { estimatePromptTokens, worstCase } from "../router/pricing.ts";
import { refusalStats30d, type RefusalStats } from "../anonymo/trust/stats.ts";
import { candidateState, sealedEligible, sealedUnavailable } from "../anonymo/trust/sealed.ts";
import { classifyRequest, type AutoClass } from "./classify.ts";
import { rankCandidates, type RankInput, type Ranked } from "./rank.ts";

export const AUTO_MODEL = "anonymo-auto";
export const AUTO_HEADER = "x-anonymo-auto";
export const AUTO_NAME = "Anonymo Auto";
export const AUTO_DESCRIPTION =
  "Picks a model for each request. It reads the request to tell code, roleplay, reasoning, image and general requests apart, with no extra model call. " +
  "It keeps the live models set up for that kind of request. It ranks them by refusal rate over the last 30 days, then by price. " +
  "The others are the fallback list. The reply names the model that answered, and you pay that model's normal price.";

const SUFFIXES = new Set<Modifier>(["nitro", "floor", "free", "private"]);
const PER_MILLION = 1_000_000n;

/** `anonymo-auto` with optional routing suffixes (`anonymo-auto:private`), or null for any other id. */
export function parseAutoId(id: unknown): Modifier[] | null {
  if (typeof id !== "string") return null;
  const [base, ...rest] = id.split(":");
  if (base !== AUTO_MODEL) return null;
  if (!rest.every((s) => SUFFIXES.has(s as Modifier))) return null;
  return [...new Set(rest as Modifier[])];
}

export type AutoDecision = { class: AutoClass; model: string; ranked: Ranked[] };

/** The decision per request, for the response header (read in api/chat.ts runChat). Keyed by the raw request; never stored. */
const decisions = new WeakMap<Request, AutoDecision>();
export const autoDecisionOf = (req: Request) => decisions.get(req);

/** Adds `x-anonymo-auto: <class>` to a response for an Auto request. Leaves every other response as it is. */
export function withAutoHeader(req: Request, res: Response): Response {
  const d = decisions.get(req);
  if (!d) return res;
  try {
    res.headers.set(AUTO_HEADER, d.class);
    return res;
  } catch {
    // Immutable headers (a fetched response): copy them.
    const headers = new Headers(res.headers);
    headers.set(AUTO_HEADER, d.class);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

// ---- refusal counts (the source /leaderboard reads), reused for a short while ---------------------------------------

const statsCache = new WeakMap<object, { at: number; stats: RefusalStats }>();

async function refusalCounts(ctx: Ctx): Promise<RefusalStats> {
  const ttl = ctx.cfg.auto.statsTtlMs;
  const hit = statsCache.get(ctx.db);
  if (ttl > 0 && hit && Date.now() - hit.at < ttl) return hit.stats;
  const stats = await refusalStats30d(ctx);
  if (ttl > 0) statsCache.set(ctx.db, { at: Date.now(), stats });
  return stats;
}

// ---- eligibility -------------------------------------------------------------------------------------------------

export const inputModalities = (m: Pick<ModelRow, "arch">): string[] => {
  const v = (m.arch as { input_modalities?: unknown } | null)?.input_modalities;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : ["text"];
};
export const readsImages = (m: Pick<ModelRow, "arch">) => inputModalities(m).includes("image");

/** Live offers of a model that are funded and not in an outage: what "live" means for a candidate. */
export function liveOffers(ctx: Ctx, m: ModelRow): Candidate[] {
  return fundedOffers(ctx, servable(ctx, m)).filter((o) => !ctx.health.outage(m.id, o.providerId));
}

const blended = (o: Candidate): bigint => o.pricePrompt * 3n + o.priceCompletion;

/** The part of a key's spend cap still free, or null when the key has none. In-flight holds are left to the ledger. */
function keyRoom(key: KeyRow | null, now = new Date()): Pico | null {
  if (!key || key.budget == null) return null;
  let spent = key.spent;
  if (key.budgetReset) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (key.budgetReset === "weekly") d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    if (key.budgetReset === "monthly") d.setUTCDate(1);
    if (!key.periodStart || key.periodStart < d) spent = 0n;
  }
  const room = key.budget - spent;
  return room > 0n ? room : 0n;
}

export type AutoRequest = {
  body: Record<string, unknown>;
  kind: "chat" | "completion";
  key: KeyRow | null;
  prefs: ProviderPrefs;
  disc: DisclosureRequest;
  sealed: boolean;
  /** A character card was resolved for this request. */
  character: boolean;
};

export type AutoPlan = AutoDecision & {
  /** Model ids a key whose allowlist names `anonymo-auto` may use for this request. */
  allow: string[];
};

/**
 * Rewrite an Auto request into an ordinary one (`model` = the pick, `models` = pick then fallbacks). Returns null, and
 * changes nothing, when the request does not name `anonymo-auto` or the feature is off.
 * Throws 409 sealed_unavailable when the request is sealed and no candidate has an attested, fresh route.
 */
export async function planAuto(ctx: Ctx, req: Request, o: AutoRequest): Promise<AutoPlan | null> {
  if (!ctx.cfg.auto?.enabled) return null;
  const { body } = o;
  const named = [body.model, ...(Array.isArray(body.models) ? body.models : [])];
  const autoIdx = named.findIndex((m) => parseAutoId(m) !== null);
  if (autoIdx < 0) return null;
  const modifiers = parseAutoId(named[autoIdx])!;
  await ctx.catalog.ensureFresh();

  const cls = classifyRequest({ body, kind: o.kind, character: o.character });
  const stats = await refusalCounts(ctx);
  const clock = { now: Date.now(), maxAgeMs: ctx.cfg.attestation.intervalMs * 3, production: ctx.cfg.production };
  const wantPrivate = o.prefs.private === true || modifiers.includes("private");
  const allowlist = o.key?.allowedModels?.length ? new Set(o.key.allowedModels) : null;
  const allowAll = !allowlist || allowlist.has(AUTO_MODEL) || named.some((m) => typeof m === "string" && allowlist.has(m) && parseAutoId(m) !== null);
  const must = [...(Array.isArray(body.tools) && body.tools.length ? ["tools"] : []), ...(body.response_format != null ? ["response_format"] : [])];
  const maxPrompt = o.prefs.max_price?.prompt != null ? usdToPico(o.prefs.max_price.prompt) : null;
  const maxCompletion = o.prefs.max_price?.completion != null ? usdToPico(o.prefs.max_price.completion) : null;
  const maxRequest = o.prefs.max_price?.request != null ? usdToPico(o.prefs.max_price.request) : null;
  const promptTokens = estimatePromptTokens(body);
  const room = keyRoom(o.key);
  const fees = { royaltyBps: 0, perCallMarginBps: ctx.cfg.fees.perCallMarginBps, byokFeeBps: ctx.cfg.fees.byokFeeBps };
  const mode = o.key ? ("prepaid" as const) : ("per_call" as const);

  // The lane rules a route must meet, the same ones selection applies (router/select.ts, anonymo/trust/sealed.ts).
  const laneOk = (c: Candidate) => {
    const cls = o.sealed || o.disc.lane !== "public" || o.disc.max !== "any" ? servedDisclosure(ctx, c).class : null;
    if (o.sealed && !(sealedEligible(candidateState(c), clock) && cls === "attested")) return false;
    if ((o.disc.lane !== "public" || o.disc.max === "none") && cls !== "attested") return false;
    if (o.disc.max === "policy" && cls === "vendor-forwarded") return false;
    if (wantPrivate && !attestationFresh(c, clock.maxAgeMs, clock.production)) return false;
    return true;
  };
  const fits = (c: Candidate) =>
    (maxPrompt == null || c.pricePrompt * PER_MILLION <= maxPrompt) &&
    (maxCompletion == null || c.priceCompletion * PER_MILLION <= maxCompletion) &&
    (maxRequest == null || c.priceRequest <= maxRequest) &&
    (!must.length || !(c.supportedParameters ?? []).length || must.every((q) => (c.supportedParameters ?? []).includes(q))) &&
    (c.ctx ?? Number.MAX_SAFE_INTEGER) >= promptTokens;

  const seen = new Set<string>();
  const live: { input: RankInput; model: ModelRow; offers: Candidate[] }[] = [];
  const eligible: typeof live = [];
  ctx.cfg.auto.candidates[cls].forEach((id, configIndex) => {
    const r = ctx.catalog.resolve(id);
    if (!r || seen.has(r.model.id)) return;
    seen.add(r.model.id);
    if (cls === "vision" && !readsImages(r.model)) return;
    if (!allowAll && !allowlist!.has(r.model.id)) return;
    const offers = liveOffers(ctx, r.model);
    if (!offers.length) return;
    const entry = (os: Candidate[]) => ({
      model: r.model,
      offers: os,
      input: { id: r.model.id, configIndex, price: os.reduce((min, x) => (blended(x) < min ? blended(x) : min), blended(os[0])), refusals: stats.available ? (stats.byModel.get(r.model.id) ?? null) : null },
    });
    live.push(entry(offers));
    const ok = offers.filter((c) => laneOk(c) && fits(c));
    if (ok.length) eligible.push(entry(ok));
  });

  if (!eligible.length && o.sealed)
    throw sealedUnavailable("No Auto candidate has an attested route with a fresh verified attestation for this sealed request. Nothing was sent or charged.", { reason: "none_attested", auto_class: cls });
  if (!live.length)
    throw new ApiError(404, cls === "vision" ? "Auto has no live model that reads images right now. Nothing was sent or charged." : `Auto has no live ${cls} model right now. Nothing was sent or charged.`, "no_providers", { auto_class: cls });

  // A key spend cap: prefer candidates whose worst case still fits under it. When none does, the ledger refuses as usual.
  let pool = eligible.length ? eligible : live; // nothing fits the request's filters: selection reports why, as for any model
  if (room != null) {
    const affordable = pool.filter((x) => x.offers.some((c) => worstCase(c, x.model, body, promptTokens, mode, fees, false) <= room));
    if (affordable.length) pool = affordable;
  }

  const ranked = rankCandidates(pool.map((x) => x.input), { minSamples: ctx.cfg.auto.minSamples });
  const suffix = modifiers.length ? ":" + modifiers.join(":") : "";
  const order = ranked.map((x) => x.id + suffix);
  // Every auto id in the request expands, in place, to the ranked list.
  const expanded = [...new Set(named.flatMap((m) => (parseAutoId(m) !== null ? order : typeof m === "string" ? [m] : [])))];
  body.model = expanded[0];
  body.models = expanded;
  const decision: AutoDecision = { class: cls, model: ranked[0].id, ranked };
  decisions.set(req, decision);
  return { ...decision, allow: allowAll && allowlist ? ranked.map((x) => x.id) : [] };
}

// ---- GET /v1/models ----------------------------------------------------------------------------------------------

export const AUTO_CREATED = 1_795_000_000; // fixed, so the listing does not reorder from one deploy to the next

/** The `anonymo-auto` entry for /v1/models, or null when the feature is off or no candidate is live. Honours the same query filters. */
export function autoModelListing(ctx: Ctx, f: { need: string[]; lane: string | null | undefined; variants: ReadonlySet<string> | null; outputs: ReadonlySet<string> | null }) {
  // A partial context (a test fixture, a tool) without the catalogue's resolver lists nothing rather than failing the list.
  if (!ctx.cfg.auto?.enabled || typeof ctx.catalog?.resolve !== "function") return null;
  if (f.outputs && !f.outputs.has("text")) return null;
  if (f.variants && !f.variants.has("mainstream")) return null;
  const perClass = Object.entries(ctx.cfg.auto.candidates).map(([cls, ids]) => {
    const models = ids.map((id) => ctx.catalog.resolve(id)?.model).filter((m): m is ModelRow => !!m && (cls !== "vision" || readsImages(m)));
    return { cls, models: models.filter((m, i) => models.findIndex((x) => x.id === m.id) === i && liveOffers(ctx, m).length > 0) };
  });
  const all = [...new Map(perClass.flatMap((p) => p.models).map((m) => [m.id, m])).values()];
  if (!all.length) return null;
  const offers = all.flatMap((m) => liveOffers(ctx, m));
  const supported = [...new Set(offers.flatMap((o) => o.supportedParameters ?? []))].sort();
  if (!f.need.every((p) => supported.includes(p))) return null;
  const attested = offers.some((o) => servedDisclosure(ctx, o).class === "attested");
  const lanes = attested ? ["public", "attested"] : ["public"];
  if (f.lane && !lanes.includes(f.lane)) return null;
  const inputs = [...new Set(["text", ...all.flatMap(inputModalities)])];
  const top = Math.max(...all.map((m) => m.ctx));
  return {
    id: AUTO_MODEL,
    canonical_slug: AUTO_MODEL,
    hugging_face_id: "",
    name: AUTO_NAME,
    created: AUTO_CREATED,
    description: AUTO_DESCRIPTION,
    context_length: top,
    architecture: { modality: inputs.includes("image") ? "text+image->text" : "text->text", input_modalities: inputs, output_modalities: ["text"], tokenizer: "Other", instruct_type: null },
    // Varies with the model picked; each call is billed at that model's own price (OpenRouter's convention for a router).
    pricing: { prompt: "-1", completion: "-1", request: "0", image: "0", web_search: "0", internal_reasoning: "0" },
    top_provider: { context_length: top, max_completion_tokens: null, is_moderated: false },
    per_request_limits: null,
    supported_parameters: supported,
    lanes,
    variant: "mainstream",
    routing_variants: ["nitro", "floor", ...(attested ? ["private"] : [])],
    auto: {
      classes: Object.fromEntries(perClass.map((p) => [p.cls, p.models.map((m) => m.id)])),
      ranking: "refusal rate over the last 30 days (whole percentage points; models with too few readings last), then price, then the configured order",
      header: AUTO_HEADER,
    },
  };
}
