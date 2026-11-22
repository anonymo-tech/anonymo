import { addSuggestions, availabilityFailure, selectWithSuggestions } from "../model-alternatives/suggest.ts"; // B121
import { refuseCreditExhaustion, refuseCreditOutage } from "../rush/errors.ts"; // ON3
import { guardInferenceModels } from "../provisioning/inference.ts"; // ZK6
import { explainedStream, rememberRoutePlan, routeReceiptFields, routeResponseHeaders } from "../router/explain.ts"; // V84
import { captureStructuredOutput } from "../structured-output/chat.ts"; // V83
import type { Context, Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { apps, byokKeys, generations, savedRoutes } from "../db/schema.ts";
import type { Candidate, ModelRow, Modifier } from "../catalog/catalog.ts";
import { ApiError, fail, isApiError } from "../lib/errors.ts";
import { floorInputOf } from "../anonymo/services.ts";
import { floorErrorReason } from "../anonymo/floor/guard-client.ts";
import { checksReplies, floorReplyCheck, replyFloorError, replyTextOf, StreamReplyGate } from "../anonymo/floor/reply.ts";
import { refuseConfidentialOutsideEnclave } from "../anonymo/floor/confidential.ts";
import { namesPrivateModel } from "../anonymo/trust/sealed.ts";
import { type Pico, maxPico, picoToUsd, picoToUsdString, usdToPico } from "../lib/money.ts";
import { canonical, canonicalJson, decrypt, genId, log, sha256 } from "../lib/util.ts";
import { reserve, release, settle } from "../ledger/ledger.ts";
import { selectProviders, type ProviderPrefs } from "../router/select.ts";
import { isAnonymoRoute } from "../anonymo/models.ts";
import { isRestricted } from "../router/lane.ts";
import { disclosureClass, disclosureRefusal, profileOf, type DisclosureClass, type DisclosureRequest } from "../router/disclosure.ts";
import { servedDisclosure, servedPolicyHash } from "./disclosure.ts";
import { batchHold, batchPrice, estimatePromptTokens, maxOutputTokens, priceUsage, readUsage, worstCase, type Mode, type Usage } from "../router/pricing.ts";
import { batchKey, batchLineOf } from "../router/batch-line.ts";
import { route, type Attempt, type RefusalCatch, type RouteSuccess, type RouteTarget } from "../router/execute.ts";
import { familyOf } from "../anonymo/refusal/family.ts";
import { phraseRefusalClassifier } from "../anonymo/refusal/classifier.ts";
import { bumpRefusalStats, recordRefusedAttempts, refusalCatchEnabled, routeIdOf, REFUSAL_CATCH_HEADER } from "../anonymo/refusal/store.ts";
import { providerKey } from "../providers/upstream.ts";
import { compactUpstream, recordGpuAttested, unverifiedUpstream, verifyAciExchange, type UpstreamAttestation } from "../providers/aci.ts";
import { receiptLeaf } from "../receipts/merkle.ts";
import { buildClaimsV2, chainComment, ChunkChain, COSE_CONTENT_TYPE } from "../receipts/v2.ts";
import { applyGuardrails, mergeGuardrails, redactOutput, type GuardrailConfig } from "../gateway/guardrails.ts";
import { middleOut } from "../gateway/transforms.ts";
import type { CacheMode } from "../gateway/cache.ts";
import { bearer, requireRole, resolveKey, walletAuth, type KeyRow } from "./auth.ts";
import { addressBucket, generationHeaders, readJson, sharedPolicyHash } from "./common.ts";
import { resolveSavedRoute } from "../routing/saved-routes.ts";
import { resolvePreset } from "../routing/presets.ts";
import { recordCharacterUse, resolveCharacter, type CharacterMeta } from "../characters/registry.ts";
import { payPerCall } from "../pay/percall.ts";
import { paymentHeaderOf, x402ResponseHeaders } from "../pay/x402.ts";
import { COUNCIL_MODEL, applyDualDecoding, runCouncil, runDual, validateMulti } from "./council.ts";
import { receiptForCall, sealedForRequest, sealedLane, sealedSelection } from "../anonymo/trust/hooks.ts"; // WS09
import { requestLane } from "../router/request-lane.ts";
import { blockReasonForStatus, isPrivateLaneRequest, noteLane, recordPrivateLane } from "../services/private-stats.ts";
import { parseTraceparent, shouldExportTrace } from "../services/tracing.ts";

export type Kind = "chat" | "completion";
export type Billing =
  | { mode: "prepaid"; accountId: string; key: KeyRow }
  | { mode: "per_call"; accountId: string; payer: string; paymentTx?: string; paymentResponse?: string; key?: undefined };

const ROLES = new Set(["system", "developer", "user", "assistant", "tool", "function"]);
// Parameters that change what a provider must be able to do; never silently dropped.
const SEMANTIC_PARAMS = ["tools", "tool_choice", "response_format", "structured_outputs", "reasoning", "include_reasoning", "logprobs", "top_logprobs", "seed", "max_tokens", "temperature", "top_p", "stop", "frequency_penalty", "presence_penalty", "top_k", "repetition_penalty", "min_p", "logit_bias", "parallel_tool_calls"];
const MUST_SUPPORT = ["tools", "response_format"];

function validate(kind: Kind, body: Record<string, unknown>) {
  if (kind === "chat") {
    if (!Array.isArray(body.messages) || body.messages.length === 0) fail(400, "`messages` must be a non-empty array.", "invalid_request");
    for (const m of body.messages as any[]) {
      if (!m || typeof m !== "object" || !ROLES.has(m.role)) fail(400, `Invalid message role: ${JSON.stringify(m?.role)}.`, "invalid_request");
      if (m.content != null && typeof m.content !== "string" && !Array.isArray(m.content)) fail(400, "Message content must be a string or an array of parts.", "invalid_request");
    }
  } else if (typeof body.prompt !== "string" && !Array.isArray(body.prompt)) fail(400, "`prompt` must be a string.", "invalid_request");
  if (body.model != null && typeof body.model !== "string") fail(400, "`model` must be a string.", "invalid_request");
  if (body.models != null && (!Array.isArray(body.models) || body.models.some((m) => typeof m !== "string"))) fail(400, "`models` must be an array of model ids.", "invalid_request");
  if (body.provider != null && (typeof body.provider !== "object" || Array.isArray(body.provider))) fail(400, "`provider` must be an object.", "invalid_request");
  for (const k of ["max_tokens", "max_completion_tokens"]) if (body[k] != null && (!Number.isInteger(body[k]) || (body[k] as number) < 1)) fail(400, `\`${k}\` must be a positive integer.`, "invalid_request");
  for (const k of ["n", "best_of"]) if (body[k] != null && (!Number.isInteger(body[k]) || (body[k] as number) < 1 || (body[k] as number) > 16)) fail(400, `\`${k}\` must be an integer from 1 to 16.`, "invalid_request");
}

function validateCacheTtl(body: Record<string, unknown>, maxTtlS: number) {
  if (body.cache == null) return;
  if (typeof body.cache !== "object" || Array.isArray(body.cache)) fail(400, "`cache` must be an object.", "invalid_request");
  const cache = body.cache as Record<string, unknown>;
  if (!Object.hasOwn(cache, "ttl")) return;
  const ttl = cache.ttl;
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || !Number.isInteger(ttl) || ttl < 1)
    fail(400, "`cache.ttl` must be a positive integer number of seconds.", "invalid_request");
  if (ttl > maxTtlS) fail(400, `\`cache.ttl\` cannot exceed the configured maximum of ${maxTtlS} seconds.`, "invalid_request");
}

function requestParams(body: Record<string, unknown>) {
  return SEMANTIC_PARAMS.filter((p) => body[p] !== undefined && body[p] !== null && !(Array.isArray(body[p]) && (body[p] as unknown[]).length === 0));
}

/** Body hash that binds a 402 quote to one request (stream flags excluded). */
export function requestHash(body: Record<string, unknown>) {
  const { stream: _s, stream_options: _so, ...rest } = body;
  return sha256(canonicalJson(rest));
}

async function limitOrThrow(ctx: Ctx, key: string, amount: number, limit: number, what: string) {
  const r = await ctx.limiter.take(key, amount, limit, 60_000);
  if (!r.ok)
    fail(429, `Rate limit exceeded (${limit} ${what}/min). Retry in ${Math.ceil(r.retryAfterMs / 1000)}s.`, "rate_limited", { retry_after_ms: r.retryAfterMs }, { "retry-after": String(Math.ceil(r.retryAfterMs / 1000)) });
}

async function byokFor(ctx: Ctx, accountId: string | undefined) {
  const map = new Map<string, string>();
  if (!accountId) return map;
  const rows = await ctx.db.select().from(byokKeys).where(eq(byokKeys.accountId, accountId));
  for (const r of rows) {
    try {
      map.set(r.providerId, decrypt(ctx.cfg.appSecret, r.keyEnc));
    } catch {
      log.warn("undecryptable BYOK key", { provider: r.providerId });
    }
  }
  return map;
}

/** Who pays: the key's prepaid balance, or (no key) a wallet / per-call payment. */
async function resolveBilling(_ctx: Ctx, _c: Context, key: KeyRow | null, wallet: { accountId: string; wallet: string } | null): Promise<{ billing: Billing | null; paywithNote?: string }> {
  if (key) return { billing: { mode: "prepaid", accountId: key.accountId, key } };
  if (wallet) return { billing: { mode: "per_call", accountId: wallet.accountId, payer: wallet.wallet } };
  return { billing: null };
}

/**
 * Providers able to serve each resolved model under the caller's routing preferences, in routing order.
 * Shared by single calls, council members and the judge, and dual-verification legs, so all of them honour a
 * disclosure ceiling or lane the same way: a request whose ceiling leaves no provider is refused (409, or 503
 * while compliant providers are down) and is never routed to one that does not meet it.
 */
/** Below this output budget a route that reasons before answering can spend all of it thinking and return nothing, so
 *  Anonymo routes marked `reasoning` in config/upstreams.yaml move behind the others (they stay as the last fallback). */
export const REASONING_MIN_OUTPUT = 1024;
export const outputBudgetOf = (body: Record<string, unknown>): number | null => {
  const v = body.max_tokens ?? body.max_completion_tokens;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

/** Anonymo routes that reason before answering, moved behind the others when the output budget is small. */
export function reasoningLast<T extends Pick<Candidate, "tier" | "supportedParameters">>(ordered: T[], maxOut: number | null): T[] {
  if (maxOut == null || maxOut >= REASONING_MIN_OUTPUT) return ordered;
  const thinks = (x: T) => isAnonymoRoute(x) && (x.supportedParameters ?? []).includes("reasoning");
  return [...ordered.filter((x) => !thinks(x)), ...ordered.filter(thinks)];
}

function selectTargets(
  ctx: Ctx,
  o: { resolved: { model: ModelRow; modifiers: Set<Modifier> }[]; prefs: ProviderPrefs; params: string[]; promptTokens: number; byok: Map<string, string>; disc: DisclosureRequest; maxOut?: number | null },
) {
  const { resolved, prefs, params, promptTokens, byok, disc } = o;
  const strict = disc.max !== "any";
  const targets: RouteTarget[] = [];
  const excluded: { model: string; provider: string; reason: string }[] = [];
  const plan = (r: (typeof resolved)[number], p: ProviderPrefs) => {
    const sel = selectProviders({
      modelId: r.model.id,
      offers: ctx.catalog.offers(r.model.id),
      prefs: p,
      modifiers: r.modifiers,
      requestParams: params,
      estimatedTokens: promptTokens,
      byokProviders: new Set(byok.keys()),
      health: ctx.health,
      production: ctx.cfg.production,
      attestationMaxAgeMs: ctx.cfg.attestation.intervalMs * 3,
      disclosure: (id) => profileOf(ctx.catalog.disclosure.get(id)),
      modelLane: ctx.catalog.laneOf(r.model),
      attestedBonus: ctx.cfg.routing.attestedBonus,
      rand: ctx.rand,
    });
    // Tools / structured output must be supported by whoever serves the request.
    const must = MUST_SUPPORT.filter((q) => params.includes(q));
    const notes: { model: string; provider: string; reason: string }[] = [];
    let ordered = sel.ordered.filter((cand) => {
      const sp = cand.supportedParameters ?? [];
      const ok = !must.length || !sp.length || must.every((q) => sp.includes(q));
      if (!ok) notes.push({ model: r.model.id, provider: cand.providerId, reason: `does not support ${must.join("/")}` });
      return ok;
    });
    // A small output budget: reasoning routes go last, unless the caller pinned an order.
    if (!p.order?.length) ordered = reasoningLast(ordered, o.maxOut ?? null);
    // BYOK providers go first unless the caller pinned an order.
    if (!p.order?.length && byok.size) ordered = [...ordered.filter((x) => byok.has(x.providerId)), ...ordered.filter((x) => !byok.has(x.providerId))];
    for (const e of sel.excluded) notes.push({ model: r.model.id, ...e });
    rememberRoutePlan(ctx.cfg.routeExplain, sel, ordered, notes, p, r.modifiers, params, byok); // V84
    return { ordered, notes };
  };
  for (const r of resolved) {
    const { ordered, notes } = plan(r, prefs);
    excluded.push(...notes);
    if (ordered.length) targets.push({ model: r.model, ordered });
  }
  if (!targets.length && strict) {
    // Would anything have matched without the disclosure ceiling? Then the ceiling is what blocked this request:
    // say so (409, or 503 when compliant providers exist but are down), and never fall back to one that does not meet it.
    const { disclosure: _d, lane: _l, ...relaxed } = prefs;
    const refusal = disclosureRefusal(disc, resolved.map((r) => r.model.id), excluded, () => resolved.some((r) => plan(r, relaxed).ordered.length > 0));
    if (refusal) throw refusal;
  }
  if (!targets.length) refuseCreditOutage(ctx.cfg.rush.enabled, excluded); // ON3
  return { targets, excluded };
}

/** Undo a hold whose request was not served. */
async function giveBack(ctx: Ctx, _billing: Billing, holdId: string) {
  await release(ctx.db, holdId);
}

/** x402: the settlement receipt rides on the served response. */
const paymentHeaders = (b: Billing): Record<string, string> => (b.mode === "per_call" && b.paymentResponse ? x402ResponseHeaders(b.paymentResponse) : {});

function chunkBase(id: string, created: number, model: ModelRow, provider: string, kind: Kind) {
  return { id, object: kind === "chat" ? "chat.completion.chunk" : "text_completion", created, model: model.id, provider };
}

/**
 * One chat or completion call. A refused private-lane request is counted (noisily, see services/private-stats.ts) under the
 * reason it was refused. `characterId` forces a character (POST /api/v1/characters/:id/chat, src/api/characters.ts).
 */
export async function runChat(ctx: Ctx, c: Context, kind: Kind, characterId?: string): Promise<Response> {
  const t0 = Date.now();
  try {
    return await handle(ctx, c, kind, characterId);
  } catch (e) {
    if (isPrivateLaneRequest(c.req.raw)) recordPrivateLane(ctx, c.req.raw, { blocked: isApiError(e) ? blockReasonForStatus(e.status, e.type) : "upstream_error", latencyMs: Date.now() - t0 });
    throw e;
  }
}

export function chatRoutes(app: Hono, ctx: Ctx) {
  const run = (c: Context, kind: Kind) => runChat(ctx, c, kind);
  app.post("/api/v1/chat/completions", (c) => run(c, "chat"));
  app.post("/api/v1/completions", (c) => run(c, "completion"));
  // OpenAI-SDK style base URLs (…/api/v1) already covered; also accept /v1/* for convenience.
  app.post("/v1/chat/completions", (c) => run(c, "chat"));
  app.post("/v1/completions", (c) => run(c, "completion"));
}

async function handle(ctx: Ctx, c: Context, kind: Kind, characterId?: string): Promise<Response> {
  const t0 = Date.now();
  const body = await readJson(c);
  validate(kind, body);
  validateCacheTtl(body, ctx.cfg.gateway.cacheTtlS);
  validateMulti(ctx, kind, body);
  const stream = body.stream === true;
  const bodySha = requestHash(body);

  // ---- 1. Who is calling -------------------------------------------------------------------
  const secret = bearer(c.req.header("authorization"));
  // A line of a batch (POST /api/v1/batches), dispatched in process by the batch runner as the key that submitted it.
  const batchLine = batchLineOf(c);
  let key: KeyRow | null = null;
  let wallet: { accountId: string; wallet: string; exists: boolean } | null = null;
  if (batchLine || secret) {
    key = batchLine ? await batchKey(ctx, batchLine, body.model) : await resolveKey(ctx, secret!);
    if (!key) fail(401, "Unknown API key. Create one (POST /api/v1/keys) or deposit USDG to its key hash first.", "invalid_key");
    await requireRole(ctx, key, ["owner", "admin", "member"]);
    await limitOrThrow(ctx, `k:${key.keyHash}`, 1, key.rpm ?? ctx.cfg.limits.defaultRpm, "requests");
  } else {
    const from = addressBucket(c, ctx.cfg);
    await limitOrThrow(ctx, `ip:${from.id}`, 1, from.scale(ctx.cfg.limits.unauthRpm), "requests");
    const wa = c.req.header("x-wallet-auth");
    if (wa) wallet = await walletAuth(ctx, wa, bodySha);
  }

  // ---- 2. Key presets, model resolution, guardrails, transforms --------------------------------
  const routing = (key?.routing ?? null) as { aliases?: Record<string, { model: string; provider?: ProviderPrefs; models?: string[] }>; provider?: ProviderPrefs } | null;
  const alias = typeof body.model === "string" ? routing?.aliases?.[body.model] : undefined;
  if (alias) {
    body.model = alias.model;
    if (alias.models && !body.models) body.models = alias.models;
    body.provider = { ...(alias.provider ?? {}), ...((body.provider as object) ?? {}) };
  }
  // Saved route (`model: "@route/<slug>"`, the caller's account only): fills in the fallback models,
  // provider prefs and default params the request leaves unset. Precedence: request > alias > route > key.
  guardInferenceModels(key, body); // ZK6: scope check before reading account settings.
  const savedRoute = await resolveSavedRoute(ctx.db, key?.accountId ?? wallet?.accountId ?? null, body);
  // Preset (`model: "@preset/<name>[@<version>]"`): a versioned saved route that can also carry a system prompt, tools and a
  // response_format (routing/presets.ts). Same precedence and the same stricter-wins privacy settings as a saved route.
  const preset = savedRoute ? null : await resolvePreset(ctx.db, key?.accountId ?? wallet?.accountId ?? null, body, kind);
  const presetMeta = preset ? { name: preset.name, version: preset.version, hash: preset.hash } : null;
  // Character (`model: "@character/<id>"`, or POST /api/v1/characters/:id/chat): the card becomes the system prompt, assembled
  // in memory for this call only; the lane defaults to attested when the model has an attested provider (characters/registry.ts).
  const character = savedRoute || preset ? null : await resolveCharacter(ctx, c, body, key?.accountId ?? wallet?.accountId ?? null, kind, characterId);
  if (routing?.provider) body.provider = { ...routing.provider, ...((body.provider as object) ?? {}) };
  captureStructuredOutput(ctx, c, kind, body); // V83: resolved defaults, opt-in only.
  // Disclosure ceiling and lane: `provider.disclosure` / `provider.lane` and the X-Anonymo-* headers, the
  // stricter of the two winning, after the key's default and the saved route filled in what the request left unset.
  // A request naming no lane is public. Defaults (any, public) add nothing to `prefs`, so such requests route as before.
  // Lane "unlinkable" is refused (501) before anything is priced or spent (router/request-lane.ts).
  const { disclosure: _wantDisclosure, lane: _wantLane, lane_downgrade: _wantDowngrade, ...basePrefs } = (body.provider ?? {}) as ProviderPrefs & { lane_downgrade?: unknown };
  // Sealed (WS09): `anonymo-sealed`, `x-anonymo-sealed: required` or a sealed_only key runs on the attested lane only.
  const sealed = await sealedForRequest(ctx, c, key, body);
  const disc = sealedLane(sealed, requestLane(c, (body.provider ?? {}) as Record<string, unknown>));
  // Private-lane traffic (and `:private`, stored as private) is published only through noisy hourly counters.
  noteLane(c.req.raw, disc.lane !== "public" ? disc.lane : (body.provider as ProviderPrefs | undefined)?.private === true || namesPrivateModel(body) ? "attested" : "public");
  const strict = disc.max !== "any";
  const prefs: ProviderPrefs = { ...basePrefs, ...(strict ? { disclosure: disc.max } : {}), ...(disc.lane !== "public" ? { lane: disc.lane } : {}) };

  // Anonymo floor gate (WS02): after auth and preset/character assembly (so it reads the whole prompt), and before
  // every dispatch: council, dual verification, the cache, billing, the hold and routing. A blocked prompt is never
  // served, charged, sent to any provider or rerouted. A gate that cannot answer fails closed.
  // Sealed, attested-lane and `:private` requests are never read by the hosted guards (GHSA-rch8-pxr3-p8gc).
  refuseConfidentialOutsideEnclave(ctx.anonymo.floor, disc.lane !== "public" || requiresAttestedUpstream(body, disc));
  await floorCheck(ctx, body);

  if (batchLine && (stream || body.verify != null || (ctx.cfg.features.council && body.model === COUNCIL_MODEL)))
    fail(400, "Batch lines cannot stream, use council mode or use dual verification.", "invalid_request");
  // Council mode (`model: "anonymo/council"`): several member calls plus a judge call, each billed and receipted.
  if (ctx.cfg.features.council && body.model === COUNCIL_MODEL) return runCouncil(toolkit, { ctx, c, kind, body, bodySha, t0, key, wallet, prefs, disc });

  const modelIds = [...new Set([...(typeof body.model === "string" ? [body.model] : []), ...((body.models as string[] | undefined) ?? [])])];
  if (!modelIds.length) fail(400, "`model` is required (e.g. \"meta-llama/llama-3.3-70b-instruct\").", "invalid_request");
  await ctx.catalog.ensureFresh();
  // A key allowed `@route/<slug>` (e.g. an agent session) may use exactly that route's own models.
  const allowed = new Set(key?.allowedModels ?? []);
  if (savedRoute && allowed.has(`@route/${savedRoute}`) && key) {
    const [row] = await ctx.db.select({ config: savedRoutes.config }).from(savedRoutes).where(and(eq(savedRoutes.accountId, key.accountId), eq(savedRoutes.slug, savedRoute)));
    for (const m of ((row?.config as { models?: string[] } | undefined)?.models ?? [])) {
      const r = ctx.catalog.resolve(m);
      if (r) allowed.add(r.model.id);
    }
  }
  // Likewise a key allowed `@preset/<name>` may use the models of the preset version it resolved.
  if (preset && allowed.has(`@preset/${preset.name}`) && key)
    for (const m of preset.models) {
      const r = ctx.catalog.resolve(m);
      if (r) allowed.add(r.model.id);
    }
  const resolved: { model: ModelRow; modifiers: Set<Modifier>; requested: string }[] = [];
  for (const id of modelIds) {
    const r = ctx.catalog.resolve(id);
    if (!r) continue;
    if (allowed.size && !allowed.has(r.model.id)) continue;
    resolved.push({ ...r, requested: id });
  }
  if (!resolved.length)
    fail(
      key?.allowedModels?.length ? 403 : 404,
      key?.allowedModels?.length ? `This key may only use: ${key.allowedModels.join(", ")}.` : `Model ${modelIds[0]} is not available. See GET /api/v1/models.`,
      key?.allowedModels?.length ? "model_not_allowed" : "model_not_found",
    );

  // Anonymo refusal catch (WS03): set up only once the floor gate passed, so a blocked prompt never reaches it.
  const refusal = await refusalCatchFor(ctx, c, key, body, kind, disc);

  // Request-level guardrails only for authenticated keys; a key's own guardrails always apply.
  const guardCfg = mergeGuardrails(key?.guardrails as GuardrailConfig | null, key ? body.guardrails as GuardrailConfig | undefined : undefined);
  const guard = applyGuardrails(body, guardCfg);
  if (stream && guardCfg?.redact_output) fail(400, "Output redaction requires a non-streaming response.", "invalid_guardrails");

  const transforms = Array.isArray(body.transforms) ? (body.transforms as string[]) : [];
  const primary = resolved[0].model;
  let middle: { removed: number; truncated: number } | null = null;
  if (transforms.includes("middle-out") && kind === "chat") {
    const reserveOut = Number(body.max_tokens ?? body.max_completion_tokens ?? Math.min(4096, Math.floor(primary.ctx / 4)));
    middle = middleOut(body, primary.ctx, reserveOut);
  }
  const promptTokens = estimatePromptTokens(body);

  // ---- 3. Accounts: key, wallet change, per-call payment -------------------------------------------
  const { billing: resolvedBilling, paywithNote } = await resolveBilling(ctx, c, key, wallet);
  let billing: Billing | null = resolvedBilling;

  // ---- 4. Cache (opt-in, never across accounts, keys, policies or end users) ----------------------
  const cacheSpec = (body.cache as { mode?: CacheMode; ttl?: number } | undefined) ?? (c.req.header("x-anonymo-cache") ? { mode: c.req.header("x-anonymo-cache") as CacheMode } : undefined);
  // The response cache keeps prompts and answers in the router, and a hit is served without any provider, so a
  // request with a disclosure ceiling never reads or writes it. Nor does a restricted variant (abliterated,
  // native_low_refusal): those are served only under attested retention, and the router must not keep their prompts.
  const cacheMode: CacheMode | null = !strict && !resolved.some((r) => isRestricted(ctx.catalog.laneOf(r.model).variant)) && (cacheSpec?.mode === "exact" || cacheSpec?.mode === "semantic") ? cacheSpec.mode : null;
  // `user` is forwarded to the provider as the end-user identity; a response made for one end user
  // must never be replayed to another behind the same key (exact or semantic).
  const cacheScope = billing ? `${billing.accountId}:policy-v3:${sha256(canonicalJson({ key: key?.keyHash ?? null, user: body.user ?? null, guardrails: guardCfg, provider: prefs, kind, models: resolved.map((r) => ({ id: r.model.id, modifiers: [...r.modifiers].sort() })), ...(savedRoute ? { route: savedRoute } : {}), ...(presetMeta ? { preset: presetMeta } : {}) }))}` : "";
  if (cacheMode && billing && !stream && body.verify == null) {
    const hit = await ctx.cache.get(cacheMode, cacheScope, body, ctx.cfg.gateway.semanticThreshold);
    if (hit) return cachedResponse(ctx, c, { body, hit, billing, model: primary, t0, bodySha, disc });
  }

  // ---- 5. Provider selection ------------------------------------------------------------------
  const byok = await byokFor(ctx, billing?.accountId);
  if (body.verify != null) applyDualDecoding(body); // temperature 0 and a fixed seed, before parameter support is checked
  const params = requestParams(body);
  const alternatives = { resolved, prefs, params, promptTokens, byok, body, allowed }; // B121
  // Sealed: only attested, fresh routes; otherwise 409 sealed_unavailable before any hold or provider call (WS09).
  const { targets, excluded } = sealed
    ? sealedSelection(ctx, true, () => selectTargets(ctx, { resolved, prefs, params, promptTokens, byok, disc, maxOut: outputBudgetOf(body) }))
    : selectWithSuggestions(() => selectTargets(ctx, { resolved, prefs, params, promptTokens, byok, disc, maxOut: outputBudgetOf(body) }), ctx, alternatives); // B121
  if (!targets.length)
    throw addSuggestions(new ApiError(404, "No providers match this request's model and routing preferences.", "no_providers", { excluded: excluded.slice(0, 50) }), ctx, alternatives); // B121

  // Dual verification (`verify: "dual"`): the same request to two providers, outputs compared.
  if (body.verify != null) return runDual(toolkit, { ctx, c, kind, body, bodySha, t0, key, wallet, billing, paywithNote, prefs, disc, resolved, targets, excluded, promptTokens, byok, guard, guardCfg, middle, savedRoute, preset: presetMeta });

  // ---- 6. Hold the worst case --------------------------------------------------------------------
  const fees = { royaltyBps: 0, perCallMarginBps: ctx.cfg.fees.perCallMarginBps, byokFeeBps: ctx.cfg.fees.byokFeeBps };
  const modeForPrice: Mode = billing?.mode ?? "per_call";
  const attemptable = targets.flatMap((t) => t.ordered.map((cand) => ({ cand, model: t.model }))).slice(0, ctx.cfg.routing.maxAttempts);
  const worst = maxPico(...attemptable.map(({ cand, model }) => worstCase(cand, model, body, promptTokens, modeForPrice, fees, byok.has(cand.providerId))));
  const hold = batchLine ? batchHold(worst, batchLine.discountBps) : worst; // a batch line is held at its discounted worst case

  if (!billing) {
    const r = await payPerCall(ctx, c, { pricePico: hold, bodySha, modelId: primary.id });
    billing = { mode: "per_call", accountId: r.accountId, payer: r.payer, paymentTx: r.txHash, paymentResponse: r.paymentResponse };
  }
  if (billing.key?.tpm) await limitOrThrow(ctx, `kt:${billing.key.keyHash}`, promptTokens, billing.key.tpm, "tokens");

  const holdId = batchLine?.generationId ?? genId(); // a batch line's id is chosen by the runner, so an interrupted line can be traced to its charge
  try {
    await reserve(ctx.db, {
      id: holdId,
      accountId: billing.accountId,
      keyHash: billing.key?.keyHash ?? null,
      amount: hold,
      kind: "usage",
      ttlMs: ctx.cfg.routing.providerTimeoutMs * (ctx.cfg.routing.maxAttempts + 1),
    });
  } catch (e) {
    if (isApiError(e) && e.type === "insufficient_credits" && paywithNote) e.metadata = { ...e.metadata, pay_with: paywithNote };
    throw e;
  }

  // ---- 7. Route ---------------------------------------------------------------------------------
  const abort = new AbortController();
  // A non-streamed call paid with x402 runs to its end even if the caller goes away, so a lost answer can be sent again
  // (src/pay/recovery.ts). Every other call stops when its caller disconnects.
  if (stream || !(billing.mode === "per_call" && billing.paymentResponse)) c.req.raw.signal?.addEventListener("abort", () => abort.abort(new DOMException("client disconnected", "AbortError")), { once: true });
  const keyFor = (cand: Candidate) => providerKey(cand, ctx.cfg.appSecret, byok.get(cand.providerId));
  const path = kind === "chat" ? ("/chat/completions" as const) : ("/completions" as const);
  const meta = { guard, middle, paywithNote, cacheMode, excluded, route: savedRoute, preset: presetMeta, character };
  // Streams send their headers before a provider is chosen, so the header is only set up front when every
  // provider this request can reach is served under the same class; the signed receipt always carries the truth.
  const classes = new Set(attemptable.map(({ cand }) => servedDisclosure(ctx, cand).class));
  const planned = classes.size === 1 ? [...classes][0] : null;
  // Likewise the policy hash: up front on a stream only when every reachable endpoint attested the same one.
  const plannedPolicy = sharedPolicyHash(attemptable.map(({ cand }) => servedPolicyHash(ctx, cand)));
  const common = { ctx, c, body, billing, holdId, t0, bodySha, stream, kind, byok, meta, guardCfg, promptTokens, disc, planned, plannedPolicy, sealed, unavailable: (attempts: Attempt[], last?: Parameters<typeof allFailed>[1]) => availabilityFailure(() => allFailed(attempts, last), ctx, alternatives, attempts) }; // B121

  if (stream) return explainedStream(ctx.cfg.routeExplain, () => route({ appSecret: ctx.cfg.appSecret, targets, path, body, stream: true, keyFor, signal: abort.signal, health: ctx.health, maxAttempts: ctx.cfg.routing.maxAttempts, timeoutMs: ctx.cfg.routing.providerTimeoutMs, firstTokenTimeoutMs: ctx.cfg.routing.firstTokenTimeoutMs, production: ctx.cfg.production, caller: sha256(billing.accountId).slice(0, 16), refusal }), (run, routeHeaders) => streamResponse({ ...common, run, routeHeaders, abort })); // V84

  let result: Awaited<ReturnType<typeof route>>;
  try {
    result = await route({ appSecret: ctx.cfg.appSecret, targets, path, body, stream: false, keyFor, signal: abort.signal, health: ctx.health, maxAttempts: ctx.cfg.routing.maxAttempts, timeoutMs: ctx.cfg.routing.providerTimeoutMs, firstTokenTimeoutMs: ctx.cfg.routing.firstTokenTimeoutMs, production: ctx.cfg.production, caller: sha256(billing.accountId).slice(0, 16), refusal });
  } catch (e) {
    await giveBack(ctx, billing, holdId);
    throw e;
  }
  if (!result.ok) {
    await giveBack(ctx, billing, holdId);
    throw common.unavailable(result.attempts, result.last); // B121
  }
  const r = result as Extract<RouteSuccess, { kind: "json" }>;
  if (r.refusal?.served === "refused") capRefusedJson(r.json);
  // The floor's reply check: what the model wrote is read before it is billed or returned (anonymo/floor/reply.ts).
  try {
    await floorReplyCheck(ctx.anonymo.floor, replyTextOf(r.json), abort.signal);
  } catch (e) {
    await giveBack(ctx, billing, holdId);
    throw e;
  }
  const json = r.json;
  const usage = readUsage(json.usage, { prompt: promptTokens, completion: Math.ceil(JSON.stringify(json.choices ?? []).length / 4) });
  const redactions = guardCfg?.redact_output ? redactOutput(json) : 0;
  const responseText = (json.choices ?? []).map((ch: any) => (typeof ch?.message?.content === "string" ? ch.message.content : ch?.text ?? "")).join("");
  // An attested gateway's receipt for this exchange: checked before anything is returned.
  const upstreamAttestation = await upstreamAttestationOf(ctx, r, byok);
  const fin = await finalize({ ...common, r, usage, responseText, finishReason: json.choices?.[0]?.finish_reason ?? null, nativeFinish: json.choices?.[0]?.native_finish_reason ?? json.choices?.[0]?.finish_reason ?? null, generationMs: Date.now() - t0, cancelled: false, upstreamAttestation });
  if (upstreamAttestation && requiresAttestedUpstream(body, disc) && !upstreamAttestation.attested) {
    const err = unattestedUpstream(upstreamAttestation);
    return c.json({ ...err.toJSON(), id: fin.id, usage: fin.usageJson, receipt: fin.receiptJson }, 502, { ...generationHeaders(fin.id, disc.lane, fin.policyHash), ...routeResponseHeaders(ctx.cfg.routeExplain, r), "x-anonymo-disclosure": fin.disclosure, ...paymentHeaders(billing) });
  }
  const anon = await receiptForCall(ctx, { r, fin, modelId: String(body.model ?? r.model.id), sealed }); // WS09
  const out = {
    ...json,
    id: fin.id,
    model: r.model.id,
    provider: r.candidate.provider.name,
    object: kind === "chat" ? "chat.completion" : "text_completion",
    usage: fin.usageJson,
    receipt: fin.receiptJson,
    anonymo_receipt: anon.body,
    ...(fin.extras(redactions) ?? {}),
  };
  if (cacheMode && !stream && r.refusal?.served !== "refused") await ctx.cache.put(cacheMode, cacheScope, body, out, fin.upstream, (body.cache as { ttl?: number } | undefined)?.ttl ?? ctx.cfg.gateway.cacheTtlS);
  return c.json(out, 200, { ...generationHeaders(fin.id, disc.lane, fin.policyHash), ...routeResponseHeaders(ctx.cfg.routeExplain, r), "x-anonymo-disclosure": fin.disclosure, ...paymentHeaders(billing), ...refusalHeaders(r), ...anon.header });
}

function allFailed(attempts: Attempt[], last?: { status?: number; errorKind: string; message: string }): ApiError {
  refuseCreditExhaustion(attempts); // ON3
  const allRejected = attempts.length > 0 && attempts.every((a) => a.error_kind === "rejected");
  const status = allRejected ? (last?.status && last.status >= 400 && last.status < 500 ? last.status : 400) : 502;
  return new ApiError(
    status,
    allRejected ? `Provider rejected the request: ${last?.message ?? "invalid request"}` : "All providers for this request failed. Nothing was charged.",
    allRejected ? "provider_rejected" : "providers_unavailable",
    { attempts: attempts.map(({ message, ...a }) => ({ ...a, message: message?.slice(0, 200) })) },
  );
}

/** A request that may only be answered by attested hardware: lane "attested" (or any disclosure "none"), or `:private`. */
export function requiresAttestedUpstream(body: Record<string, unknown>, disc: DisclosureRequest) {
  return disc.max === "none" || (body.provider as ProviderPrefs | undefined)?.private === true || namesPrivateModel(body);
}

/**
 * The receipt check for a call an attested aci/1 gateway served (providers/aci.ts); null for every other provider.
 * A gateway call the router kept no record of cannot be checked, so it counts as not attested.
 */
async function upstreamAttestationOf(ctx: Ctx, r: Pick<RouteSuccess, "candidate" | "exchange">, byok: Map<string, string>): Promise<UpstreamAttestation | null> {
  const g = r.candidate.provider.aci;
  if (!g) return null;
  if (!r.exchange) return unverifiedUpstream(g, null, "the router kept no record of the exchange to check");
  return verifyAciExchange({
    baseUrl: r.candidate.provider.baseUrl,
    gateway: g,
    exchange: r.exchange,
    apiKey: providerKey(r.candidate, ctx.cfg.appSecret, byok.get(r.candidate.providerId)),
    tlsPin: r.candidate.provider.tlsPin,
    production: ctx.cfg.production,
  });
}

/**
 * The class a call was served under, given its gateway receipt check: an answer whose receipt does not show an
 * attested upstream is served under the class the provider has without a fresh attestation.
 */
function servedWith(ctx: Ctx, cand: Candidate, ua: UpstreamAttestation | null | undefined, base = servedDisclosure(ctx, cand)): { class: DisclosureClass; simulated: boolean } {
  if (!ua || ua.attested || base.class !== "attested") return base;
  return { class: disclosureClass(profileOf(ctx.catalog.disclosure.get(cand.providerId)), false), simulated: false };
}

/**
 * The answer for a request that required attested hardware when the gateway's receipt does not show it: the
 * upstream already did (and billed) the work, so the call is settled like any finished call, but its output is
 * withheld and the signed receipt records why.
 */
export function unattestedUpstream(ua: UpstreamAttestation): ApiError {
  return new ApiError(
    502,
    `The provider's receipt does not show an attested upstream (${ua.reason ?? "not attested"}). The response was withheld. The upstream had already generated it, so the call is billed as usual; the signed receipt records the verification result.`,
    "upstream_not_attested",
    { upstream_attestation: compactUpstream(ua) },
  );
}

export type Common = {
  ctx: Ctx;
  /** WS09: the request is sealed (attested routes only); its Anonymo receipt carries the enclave quote hash. */
  sealed?: boolean;
  c: Context;
  body: Record<string, unknown>;
  billing: Billing;
  holdId: string;
  t0: number;
  bodySha: string;
  stream: boolean;
  kind: Kind;
  byok: Map<string, string>;
  meta: { guard: ReturnType<typeof applyGuardrails>; middle: { removed: number; truncated: number } | null; paywithNote?: string; cacheMode: CacheMode | null; excluded: unknown[]; route: string | null; preset?: { name: string; version: number; hash: string } | null; character?: CharacterMeta | null };
  guardCfg: GuardrailConfig | null;
  promptTokens: number;
  disc: DisclosureRequest;
  /** The disclosure class every reachable provider shares, or null when it depends on who serves the call. */
  planned: DisclosureClass | null;
  /** The attested policy hash every reachable endpoint shares, or null (see generationHeaders); used by streams. */
  plannedPolicy?: string | null;
};

/** Extra inputs for calls made on behalf of a larger request (council members, dual verification). */
export type FinalizeExtra = {
  /**
   * Extra signed receipt fields; never replaces a base field. `attestation_ref` is set only for calls made under an
   * attested council or attested dual verification (see router/council.ts `attestationRefOf`); other receipts omit it.
   */
  payload?: { council?: unknown; verification?: unknown; attestation_ref?: unknown };
  /** The most this call may charge: usage above it is not billed to the caller (reported as `over_budget`). */
  budget?: Pico;
  /**
   * For a receipt that stands for several calls (the top-level council receipt): the weakest disclosure class
   * among all of them, and whether any rests on a simulated attestation. Never stronger than this call's own.
   */
  served?: { class: DisclosureClass; simulated: boolean };
};

export type FinalizeInput = Common & {
  r: RouteSuccess;
  usage: Usage;
  responseText: string;
  finishReason: string | null;
  nativeFinish: string | null;
  generationMs: number;
  cancelled: boolean;
  extra?: FinalizeExtra;
  /**
   * The checked receipt of an attested aci/1 gateway for this call. When omitted and the call went to such a
   * gateway, finalize checks it itself (council and dual verification calls).
   */
  upstreamAttestation?: UpstreamAttestation | null;
  /** For a stream: the head of the chunk hash chain over every event sent before the receipt (receipt v2 resp.chain). */
  chainHead?: string | null;
  /** For a stream: output tokens delivered to the caller, estimated from the delivered text (V6 R make-good). */
  delivered?: { completion: number; reasoning: number } | null;
};

async function finalize(p: FinalizeInput) {
  const { ctx, billing, r } = p;
  const isByok = p.byok.has(r.candidate.providerId);
  const mode: Mode = isByok ? "byok" : billing.mode;
  const fees = { royaltyBps: r.model.royaltyBps, perCallMarginBps: ctx.cfg.fees.perCallMarginBps, byokFeeBps: ctx.cfg.fees.byokFeeBps };
  const listCost = priceUsage(r.candidate, r.model, p.usage, billing.mode === "per_call" ? "per_call" : mode, fees, isByok);
  // A batch line is charged the discounted price (BATCH_DISCOUNT_BPS); everything else the list price.
  const batchLine = batchLineOf(p.c);
  const cost = batchLine ? batchPrice(listCost, batchLine.discountBps) : { ...listCost, batchDiscount: 0n };
  const id = p.holdId;
  const budget = p.extra?.budget;
  const overBudget = budget != null && cost.total > budget;
  const payable = overBudget ? budget : cost.total;
  // Anonymo refusal catch: an answer that is itself a refusal is billed 0 (its cost goes on the ledger with an equal
  // refusal_refund, below), and so is every refused attempt before it.
  const servedRefused = r.refusal?.served === "refused";
  const settleAmount = servedRefused ? 0n : payable;
  const settled = await settle(ctx.db, p.holdId, settleAmount, {
    description: `${r.model.id} via ${r.candidate.providerId}`,
    generationId: id,
  });
  const charged = settled.charged;
  const refusalReceipt = r.refusal ? await recordRefusal(p, { fees, served: payable }) : null;

  const paidWith: Record<string, unknown> | null = null; // receipts keep the field; nothing pays with tokens any more

  const attestation = r.candidate.provider.attested && r.candidate.provider.attestationHash ? r.candidate.provider.attestationHash : null;
  const ua = p.upstreamAttestation !== undefined ? p.upstreamAttestation : await upstreamAttestationOf(ctx, r, p.byok);
  // A gateway answer whose receipt does not show an attested upstream is served under the class the provider has
  // without a fresh attestation, whatever the gateway's own attestation says.
  const served = servedWith(ctx, r.candidate, ua, p.extra?.served ?? servedDisclosure(ctx, r.candidate));
  if (ua) await recordGpuAttested(ctx.db, r.model.id, r.candidate.providerId, ua).catch((e) => log.error("recording gpu attestation failed", { error: (e as Error).message }));
  const privateRoute = (p.body.provider as ProviderPrefs | undefined)?.private === true || namesPrivateModel(p.body);
  const payer = billing.key ? billing.key.chainKeyHash : billing.mode === "per_call" ? billing.payer : null;
  const payload = {
    v: 1,
    id,
    issued: new Date().toISOString(),
    router: ctx.cfg.publicUrl,
    model: r.model.id,
    provider: r.candidate.providerId,
    tokens: { prompt: p.usage.prompt, completion: p.usage.completion, reasoning: p.usage.reasoning, cached: p.usage.cachedRead, estimated: p.usage.estimated },
    cost: picoToUsdString(charged),
    cost_details: { upstream: picoToUsdString(cost.upstream), royalty: picoToUsdString(cost.royalty), margin: picoToUsdString(cost.margin), ...(overBudget ? { over_budget: picoToUsdString(cost.total) } : {}), ...(batchLine ? { batch_discount: picoToUsdString(cost.batchDiscount) } : {}) },
    paid_with: paidWith,
    latency_ms: Math.round(r.latencyMs),
    generation_ms: p.generationMs,
    quant: r.candidate.quant,
    mode,
    private: privateRoute,
    attestation,
    disclosure: served.class,
    lane: p.disc.lane,
    ...(served.simulated ? { attestation_simulated: true } : {}),
    payer,
    payment_tx: billing.mode === "per_call" ? (billing.paymentTx ?? null) : null,
    request_sha256: p.bodySha,
    response_sha256: sha256(p.responseText),
    ...(ua ? { upstream_attestation: compactUpstream(ua) } : {}),
    ...(batchLine ? { batch: { id: batchLine.batchId, line: batchLine.idx } } : {}),
    ...routeReceiptFields(ctx.cfg.routeExplain, r), // V84: signed optional extension.
    ...(refusalReceipt ?? {}), // Anonymo WS03: `refused`, every route the call touched, and the refund
    ...(p.extra?.payload ?? {}),
  };
  const signed = ctx.signer.sign(payload);
  const leaf = receiptLeaf(signed.bytes, signed.sigBytes);
  // Receipt v2 alongside v1: the same facts minus payer and exact counts, as a COSE_Sign1 under the same key.
  const policyHash = servedPolicyHash(ctx, r.candidate);
  const claimsV2 = buildClaimsV2({
    ...routeReceiptFields(ctx.cfg.routeExplain, r), // V84
    rid: id,
    issuedAt: new Date(payload.issued),
    router: ctx.cfg.publicUrl,
    modelId: r.model.id,
    providerId: r.candidate.providerId,
    attestation,
    policyHash,
    requestSha256: p.bodySha,
    responseSha256: payload.response_sha256,
    chainHead: p.stream ? (p.chainHead ?? null) : null,
    tokensIn: p.usage.prompt,
    tokensOut: p.usage.completion,
    finish: p.finishReason,
    stream: p.stream,
    complete: !p.cancelled && p.finishReason !== "error",
    lane: p.disc.lane,
    disclosure: served.class,
    mode,
    chargedPico: charged,
    keyset: null,
  });
  const signedV2 = ctx.signer.signCose(claimsV2);

  const referer = p.c.req.header("http-referer") ?? p.c.req.header("referer");
  const title = p.c.req.header("x-title");
  let appId: string | null = null;
  // App attribution: where a call came from, cut to a bounded length.
  if (referer || title) {
    appId = sha256((referer ?? "") + "|" + (title ?? "")).slice(0, 24);
    await ctx.db.insert(apps).values({ id: appId, url: referer?.slice(0, 500) ?? null, title: title?.slice(0, 200) ?? null }).onConflictDoNothing();
  }

  const tps = p.usage.completion > 0 && p.generationMs > r.latencyMs ? p.usage.completion / ((p.generationMs - r.latencyMs) / 1000) : null;
  ctx.health.record({ modelId: r.candidate.modelId, providerId: r.candidate.providerId, ok: true, latencyMs: r.latencyMs, tps, source: "traffic" });

  await ctx.db.insert(generations).values({
    id,
    keyHash: billing.key?.keyHash ?? null,
    accountId: billing.accountId,
    modelId: r.model.id,
    providerId: r.candidate.providerId,
    tokensIn: p.usage.prompt,
    tokensOut: p.usage.completion,
    reasoningTokens: p.usage.reasoning,
    cachedTokens: p.usage.cachedRead,
    cacheWriteTokens: p.usage.cacheWrite,
    cost: charged,
    upstreamCost: cost.upstream,
    royalty: cost.royalty,
    margin: cost.margin,
    cacheDiscount: cost.cacheDiscount,
    mode,
    latencyMs: Math.round(r.latencyMs),
    generationTimeMs: p.generationMs,
    finishReason: p.finishReason,
    nativeFinishReason: p.nativeFinish,
    streamed: p.stream,
    cancelled: p.cancelled,
    quant: r.candidate.quant,
    dataRegion: r.candidate.provider.datacenter?.[0] ?? null,
    isByok,
    private: privateRoute,
    attestationHash: attestation,
    receiptId: id,
    receiptSig: signed.sig,
    receiptKeyId: signed.keyId,
    receipt: payload,
    receiptLeaf: leaf,
    receiptV2: claimsV2,
    receiptCose: signedV2.cose.toString("base64"),
    receiptLeafV2: signedV2.leaf,
    paidWith,
    paymentTx: billing.mode === "per_call" ? (billing.paymentTx ?? null) : null,
    appId,
    attempts: r.attempts,
    requestSha256: p.bodySha,
    responseSha256: payload.response_sha256,
  });
  // Creator attribution for a public character: a count and a cost per day.
  if (p.meta.character?.attribute) await recordCharacterUse(ctx, p.meta.character.id, charged);

  // A private-lane request is counted once in the noisy counters and sends no per-request trace span.
  const privateLane = isPrivateLaneRequest(p.c.req.raw);
  recordPrivateLane(ctx, p.c.req.raw, { latencyMs: p.generationMs, tokens: p.usage.prompt + p.usage.completion });
  if (!privateLane) ctx.telemetry.span("chat " + r.model.id, p.t0, Date.now(), {
    "gen_ai.system": r.candidate.providerId,
    "gen_ai.operation.name": p.kind === "chat" ? "chat" : "text_completion",
    "gen_ai.request.model": String(p.body.model ?? r.model.id),
    "gen_ai.response.model": r.model.id,
    "gen_ai.usage.input_tokens": p.usage.prompt,
    "gen_ai.usage.output_tokens": p.usage.completion,
    "anonymo.generation_id": id,
    "anonymo.provider": r.candidate.providerId,
    "anonymo.mode": mode,
    "anonymo.cost_usd": picoToUsd(charged),
    "anonymo.attempts": r.attempts.length,
    "anonymo.streamed": p.stream,
  }, undefined, p.c.req.header("traceparent")?.split("-")[1]);
  // The key owner's own trace export (services/tracing.ts): public-lane calls only. An attested call
  // never reaches the queue, whatever the key is configured to do. Queued without waiting; it cannot fail the call.
  if (billing.key?.tracing && shouldExportTrace({ lane: p.disc.lane, privateLaneRequest: privateLane, privateRoute })) {
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    ctx.tracing.enqueue(billing.key.keyHash, billing.key.tracing, {
      generationId: id,
      startMs: p.t0,
      endMs: Date.now(),
      ...parseTraceparent(p.c.req.header("traceparent")),
      operation: p.kind === "chat" ? "chat" : "text_completion",
      provider: r.candidate.providerId,
      requestModel: String(p.body.model ?? r.model.id),
      responseModel: r.model.id,
      inputTokens: p.usage.prompt,
      outputTokens: p.usage.completion,
      temperature: num(p.body.temperature),
      topP: num(p.body.top_p),
      maxTokens: num(p.body.max_tokens ?? p.body.max_completion_tokens),
      finishReasons: p.finishReason ? [p.finishReason] : [],
      costUsd: picoToUsd(charged),
      timeToFirstTokenMs: r.latencyMs,
      mode,
      streamed: p.stream,
      attempts: r.attempts.length,
      input: p.kind === "chat" ? p.body.messages : p.body.prompt,
      output: p.responseText,
    });
  }

  const usageJson = {
    prompt_tokens: p.usage.prompt,
    completion_tokens: p.usage.completion,
    total_tokens: p.usage.prompt + p.usage.completion,
    cost: picoToUsd(charged),
    is_byok: isByok,
    cost_details: { upstream_inference_cost: picoToUsd(cost.upstream), royalty: picoToUsd(cost.royalty), margin: picoToUsd(cost.margin), ...(batchLine ? { batch_discount: picoToUsd(cost.batchDiscount) } : {}) },
    prompt_tokens_details: { cached_tokens: p.usage.cachedRead, cache_write_tokens: p.usage.cacheWrite },
    completion_tokens_details: { reasoning_tokens: p.usage.reasoning },
  };
  const receiptJson = {
    id,
    sig: signed.sig,
    key_id: signed.keyId,
    alg: "Ed25519",
    payload,
    leaf,
    anchor_hint: `Rooted within the hour; GET /api/v1/receipts/${id}/proof returns the merkle path.`,
    ...(paidWith ? { paid_with: paidWith } : {}),
    v2: { alg: "EdDSA", kid: signedV2.keyId, content_type: COSE_CONTENT_TYPE, cose: signedV2.cose.toString("base64"), claims: claimsV2, leaf: signedV2.leaf },
  };
  return {
    id,
    disclosure: served.class,
    simulated: served.simulated,
    /** The classifier policy hash the serving endpoint's fresh attestation bound, or null (X-Anonymo-Policy-Hash). */
    policyHash,
    upstream: cost.upstream,
    charged,
    cost,
    overBudget,
    mode,
    isByok,
    payload,
    usageJson,
    receiptJson,
    extras: (redactions: number) => {
      const x: Record<string, unknown> = {};
      if (p.meta.route) x.route = p.meta.route; // the saved route (`@route/<slug>`) that resolved this call
      if (p.meta.preset) x.preset = p.meta.preset; // the preset version (`@preset/<name>@<version>`) that resolved this call
      if (p.meta.character) x.character = { id: p.meta.character.id, card_hash: p.meta.character.card_hash, lane: p.meta.character.lane, lorebook_entries: p.meta.character.lore.length, greeting: p.meta.character.greeting, ...(p.meta.character.note ? { note: p.meta.character.note } : {}) };
      if (p.meta.guard || redactions) x.guardrails = { ...(p.meta.guard ?? {}), output_redactions: redactions };
      if (p.meta.middle && (p.meta.middle.removed || p.meta.middle.truncated)) x.transforms = { "middle-out": p.meta.middle };
      if (p.meta.paywithNote) x.pay_with_fallback = p.meta.paywithNote;
      if (r.dropped.length) x.dropped_parameters = r.dropped;
      if (refusalReceipt && (refusalReceipt.routes.length > 1 || servedRefused)) x.refusal = refusalReceipt.refusal;
      return Object.keys(x).length ? x : null;
    },
  };
}

function streamResponse(p: Common & { unavailable: typeof allFailed; run: () => ReturnType<typeof route>; routeHeaders?: Record<string, string>; abort: AbortController }): Response {
  const { ctx, kind } = p;
  const enc = new TextEncoder();
  const created = Math.floor(Date.now() / 1000);
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => {
        if (!closed) controller.enqueue(enc.encode(s));
      };
      const event = (obj: unknown) => send(`data: ${JSON.stringify(obj)}\n\n`);
      send(": ANONYMO PROCESSING\n\n");
      const keepalive = setInterval(() => send(": ANONYMO PROCESSING\n\n"), 5_000);
      let result: Awaited<ReturnType<typeof route>> | null = null;
      try {
        result = await p.run();
      } catch (e) {
        clearInterval(keepalive);
        await giveBack(ctx, p.billing, p.holdId);
        if (!p.abort.signal.aborted) event({ error: { code: 502, message: (e as Error).message, type: "router_error" } });
        send("data: [DONE]\n\n");
        closed = true;
        controller.close();
        return;
      }
      clearInterval(keepalive);
      if (!result.ok) {
        await giveBack(ctx, p.billing, p.holdId);
        const err = p.unavailable(result.attempts, result.last); // B121
        event(err.toJSON());
        send("data: [DONE]\n\n");
        closed = true;
        controller.close();
        return;
      }
      const r = result as Extract<RouteSuccess, { kind: "stream" }>;
      const base = chunkBase(p.holdId, created, r.model, r.candidate.provider.name, kind);
      // Chunk hash chain (receipt v2 resp.chain): every event before the receipt is chained, and c_i follows the
      // i-th event as an SSE comment, which OpenAI-compatible parsers discard. Only what was enqueued is chained.
      const chain = new ChunkChain(p.holdId);
      const chained = (obj: unknown) => {
        if (closed) return;
        const data = JSON.stringify(obj);
        const hex = chain.push(data);
        send(`data: ${data}\n\n` + chainComment(chain.count, hex));
      };
      // What an attested gateway streams for a request that requires attested hardware is held back until its
      // receipt shows an attested upstream (providers/aci.ts); every other stream is relayed as it arrives.
      const hold = !!r.candidate.provider.aci && requiresAttestedUpstream(p.body, p.disc);
      const held: unknown[] = [];
      const sink = (obj: unknown) => (hold ? held.push(obj) : chained(obj));
      let text = "";
      let reasoningText = ""; // billed when usage never arrives (e.g. the client cancels mid-stream)
      let toolText = "";
      // The floor's reply check: events are released only once the guard has passed the text they carry
      // (anonymo/floor/reply.ts). Without a guard model (local development) they go straight out.
      const replyGate = checksReplies(ctx.anonymo.floor) ? new StreamReplyGate(ctx.anonymo.floor, sink, () => `${reasoningText}\n${text}\n${toolText}`, { signal: p.abort.signal }) : null;
      const relay = (obj: unknown) => (replyGate ? replyGate.push(obj) : sink(obj));
      const holdKeepalive = hold || replyGate ? setInterval(() => send(": ANONYMO PROCESSING\n\n"), 5_000) : undefined;
      let finish: string | null = null;
      let nativeFinish: string | null = null;
      let providerUsage: any = null;
      let cancelled = false;
      let midError: string | null = null;
      // A served refusal is billed 0: everything it streams, on every channel, shares one REFUSED_MAX_CHARS budget,
      // trimmed before it is counted or relayed (GHSA-j499-32cc-f5w4).
      const servedRefusal = r.refusal?.served === "refused";
      let refusedLeft = REFUSED_MAX_CHARS;
      let refusedCut = false;
      const emit = (ev: any) => {
        if (ev?.usage) providerUsage = ev.usage;
        const choices = Array.isArray(ev?.choices) ? ev.choices : [];
        for (const ch of choices) {
          if (servedRefusal) {
            const c = capRefusedChoice(ch, refusedLeft);
            refusedLeft = c.left;
            refusedCut ||= c.cut;
          }
          const d = ch?.delta ?? {};
          if (typeof d.content === "string") text += d.content;
          if (typeof ch?.text === "string") text += ch.text;
          if (typeof d.reasoning === "string") reasoningText += d.reasoning;
          if (typeof d.reasoning_content === "string") reasoningText += d.reasoning_content;
          if (Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) toolText += String(tc?.function?.arguments ?? "") + String(tc?.function?.name ?? "");
          if (ch?.finish_reason) {
            finish = ch.finish_reason;
            nativeFinish = ch.native_finish_reason ?? ch.finish_reason;
          }
        }
        if (!choices.length && ev?.usage) return; // usage-only chunk: we send our own at the end
        const { usage: _u, id: _i, model: _m, created: _c, object: _o, ...rest } = ev ?? {};
        relay({ ...base, ...rest, choices });
      };
      try {
        for (const ev of r.buffered) emit(ev);
        for await (const ev of r.rest) {
          // A served refusal is billed 0, so it is cut off where no real refusal goes on (see REFUSED_MAX_CHARS),
          // counting every channel, not just the text.
          if (servedRefusal && (refusedCut || refusedLeft <= 0)) {
            r.abort();
            finish = "length";
            break;
          }
          if (ev?.error) {
            midError = String(ev.error?.message ?? "provider error");
            relay({ ...base, error: { code: 502, message: midError, type: "provider_error" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] });
            break;
          }
          emit(ev);
          if (replyGate?.outcome) {
            r.abort(); // the reply crossed the floor (or could not be checked): stop the model, send nothing more
            break;
          }
        }
        if (servedRefusal && refusedCut) finish = "length";
      } catch (e) {
        if (p.abort.signal.aborted) cancelled = true;
        else {
          midError = (e as Error).message;
          relay({ ...base, error: { code: 502, message: "Provider stream was interrupted.", type: "provider_interrupted" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] });
        }
      }
      const stopped = replyGate && !cancelled ? await replyGate.finish() : replyGate?.outcome;
      if (stopped) {
        // Withheld: nothing past the last checked piece went out, the hold is released and nothing is charged.
        clearInterval(holdKeepalive);
        await giveBack(ctx, p.billing, p.holdId);
        event({ ...replyFloorError(stopped).toJSON(), id: p.holdId });
        send("data: [DONE]\n\n");
        closed = true;
        try {
          controller.close();
        } catch {
          /* client gone */
        }
        return;
      }
      try {
        const reasoningEst = Math.ceil(reasoningText.length / 4);
        const usage = readUsage(providerUsage, { prompt: p.promptTokens, completion: Math.ceil((text.length + toolText.length) / 4) + reasoningEst });
        if (!providerUsage) usage.reasoning = reasoningEst;
        const upstreamAttestation = await upstreamAttestationOf(ctx, r, p.byok);
        clearInterval(holdKeepalive);
        const refused = hold && !!upstreamAttestation && !upstreamAttestation.attested;
        if (hold && !refused) for (const e of held) chained(e);
        // The refusal goes out before the receipt is signed, so the chain covers it too.
        if (refused) chained({ ...unattestedUpstream(upstreamAttestation!).toJSON(), id: p.holdId });
        const fin = await finalize({ ...p, r, usage, responseText: text, finishReason: finish ?? (cancelled ? "cancelled" : midError ? "error" : null), nativeFinish, generationMs: Date.now() - p.t0, cancelled, upstreamAttestation, chainHead: chain.head, delivered: { completion: Math.ceil((text.length + toolText.length) / 4) + reasoningEst, reasoning: reasoningEst } /* V6 R */ });
        // WS09: a stream's headers are already sent, so its Anonymo receipt (and the header form) ride in the final event.
        const anon = await receiptForCall(ctx, { r, fin, modelId: String(p.body.model ?? r.model.id), sealed: p.sealed === true });
        event({ ...base, choices: [], usage: fin.usageJson, receipt: fin.receiptJson, anonymo_receipt: { ...anon.body, header: anon.header_value }, ...(fin.extras(0) ?? {}) });
      } catch (e) {
        clearInterval(holdKeepalive);
        log.error("stream finalize failed", { error: (e as Error).message, hold: p.holdId });
        await release(ctx.db, p.holdId).catch(() => undefined);
      }
      send("data: [DONE]\n\n");
      closed = true;
      try {
        controller.close();
      } catch {
        /* client gone */
      }
    },
    cancel() {
      closed = true;
      p.abort.abort(new DOMException("client disconnected", "AbortError"));
    },
  });
  return new Response(body, {
    status: 200,
    headers: { ...p.routeHeaders, /* V84 */ "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no", ...generationHeaders(p.holdId, p.disc.lane, p.plannedPolicy), ...(p.planned ? { "x-anonymo-disclosure": p.planned } : {}), ...paymentHeaders(p.billing) },
  });
}

async function cachedResponse(ctx: Ctx, c: Context, p: { body: Record<string, unknown>; hit: { response: any; upstream: bigint; similarity: number }; billing: Billing; model: ModelRow; t0: number; bodySha: string; disc: DisclosureRequest }) {
  const id = genId();
  const payload = {
    v: 1,
    id,
    issued: new Date().toISOString(),
    router: ctx.cfg.publicUrl,
    model: p.model.id,
    provider: "cache",
    tokens: { prompt: 0, completion: 0, reasoning: 0, cached: 0, estimated: false },
    cost: "0",
    cost_details: { upstream: "0", royalty: "0", margin: "0" },
    paid_with: null,
    latency_ms: Date.now() - p.t0,
    mode: "cache",
    // The answer was first produced by a provider under no disclosure ceiling (a request with one never uses the cache).
    disclosure: "vendor-forwarded" satisfies DisclosureClass,
    lane: p.disc.lane,
    cache: { similarity: Number(p.hit.similarity.toFixed(4)), original: p.hit.response?.id ?? null },
    payer: p.billing.key?.chainKeyHash ?? (p.billing.mode === "per_call" ? p.billing.payer : null),
    request_sha256: p.bodySha,
    response_sha256: sha256((p.hit.response?.choices ?? []).map((ch: any) => ch?.message?.content ?? "").join("")),
  };
  const signed = ctx.signer.sign(payload);
  const leaf = receiptLeaf(signed.bytes, signed.sigBytes);
  await ctx.db.insert(generations).values({
    id,
    keyHash: p.billing.key?.keyHash ?? null,
    accountId: p.billing.accountId,
    modelId: p.model.id,
    providerId: "cache",
    mode: "cache",
    cost: 0n,
    cacheDiscount: p.hit.upstream,
    latencyMs: Date.now() - p.t0,
    generationTimeMs: Date.now() - p.t0,
    receiptId: id,
    receiptSig: signed.sig,
    receiptKeyId: signed.keyId,
    receipt: payload,
    receiptLeaf: leaf,
    requestSha256: p.bodySha,
    responseSha256: payload.response_sha256,
    finishReason: p.hit.response?.choices?.[0]?.finish_reason ?? null,
  });
  return c.json(
    {
      ...p.hit.response,
      id,
      cached: true,
      usage: { ...(p.hit.response?.usage ?? {}), cost: 0, cost_details: { upstream_inference_cost: 0, royalty: 0, margin: 0, cache_savings: picoToUsd(p.hit.upstream) } },
      receipt: { id, sig: signed.sig, key_id: signed.keyId, alg: "Ed25519", payload, leaf },
    },
    200,
    // Served from the cache, not by an attested endpoint: no policy hash.
    { ...generationHeaders(id, p.disc.lane), "x-anonymo-cache": "hit", "x-anonymo-disclosure": "vendor-forwarded", ...paymentHeaders(p.billing) },
  );
}

/** What the multi-call modes (council, dual verification) reuse from the single-call path. */
export const toolkit = { finalize, selectTargets, outputBudgetOf, resolveBilling, allFailed, byokFor, limitOrThrow, requestHash, requestParams, paymentHeaders, upstreamAttestationOf, servedWith };

export { canonical };

/** Anonymo floor gate: 451 with the category and no text on a block, 503 when the gate cannot answer. Never rerouted. */
async function floorCheck(ctx: Ctx, body: Record<string, unknown>) {
  const input = floorInputOf(body);
  let verdict;
  try {
    verdict = await ctx.anonymo.floor.check(input);
  } catch (e) {
    log.warn("floor check unavailable", { reason: floorErrorReason(e) });
    throw new ApiError(503, "The safety check is unavailable. Nothing was sent or charged; try again shortly.", "floor_unavailable");
  }
  if (!verdict.ok) throw new ApiError(451, "This request crosses a line Anonymo blocks for everyone. Nothing was sent or charged.", "floor_blocked", { category: verdict.category });
}

// ---- Anonymo refusal catch (WS03, Backend §5) ---------------------------------------------------------------------

/**
 * A served refusal is billed 0, so it is cut off at this length (≈ 600 tokens): real refusals are far shorter, and a
 * reply that only opens like one ("I'm sorry, I can't… anyway, here are 3,000 words") must not be free.
 */
export const REFUSED_MAX_CHARS = 2400;

/** The refusal catch for this request, or undefined when it is off (header, then the key's setting; on by default). */
async function refusalCatchFor(ctx: Ctx, c: Context, key: KeyRow | null, body: Record<string, unknown>, kind: Kind, disc: DisclosureRequest): Promise<RefusalCatch | undefined> {
  if (!(await refusalCatchEnabled(ctx.db, c.req.header(REFUSAL_CATCH_HEADER), key?.keyHash ?? null))) return undefined;
  return { classifier: refusalClassifierFor(ctx, body, disc), prompt: refusalPromptOf(body, kind), familyOf: (m, cand) => familyOf(m, cand, ctx.catalog.lane.get(m.id)?.baseModel) };
}

/**
 * A request that may only be served on attested hardware, or on a private lane, never has its prompt sent to the
 * classifier service: it is read by the in-process phrase rules only.
 */
export function refusalClassifierFor(ctx: Pick<Ctx, "anonymo">, body: Record<string, unknown>, disc: Pick<DisclosureRequest, "lane" | "max">) {
  const local = disc.lane !== "public" || requiresAttestedUpstream(body, disc as DisclosureRequest);
  return local ? phraseRefusalClassifier : ctx.anonymo.refusal;
}

/** What the classifier reads as the request: the last user turn (or the completion prompt). Never stored. */
export function refusalPromptOf(body: Record<string, unknown>, kind: Kind): string {
  const textOf = (content: unknown): string =>
    typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (typeof (p as { text?: unknown })?.text === "string" ? (p as { text: string }).text : "")).join(" ") : "";
  if (kind === "completion") return textOf(Array.isArray(body.prompt) ? body.prompt.filter((x) => typeof x === "string").join("\n") : body.prompt).slice(-4000);
  const msgs = Array.isArray(body.messages) ? (body.messages as { role?: unknown; content?: unknown }[]) : [];
  const lastUser = [...msgs].reverse().find((m) => m?.role === "user");
  return textOf(lastUser?.content ?? msgs.at(-1)?.content).slice(-4000);
}

/**
 * The budget a served refusal may deliver, across every output channel of one choice (GHSA-j499-32cc-f5w4): the
 * text, then reasoning, then tool-call names and arguments, together at most REFUSED_MAX_CHARS. Channels a refusal
 * never needs (images, audio, annotations, function_call) are dropped. Mutates `holder` (a message or a stream
 * delta) and returns the budget left. Capping only `content` let a caller take a whole answer through `reasoning` or
 * `tool_calls` for $0.
 */
export function capRefusedChannels(holder: any, budget: number): { left: number; cut: boolean } {
  if (!holder || typeof holder !== "object") return { left: budget, cut: false };
  let left = Math.max(0, budget);
  let cut = false;
  const take = (s: string) => {
    if (s.length <= left) {
      left -= s.length;
      return s;
    }
    cut = true;
    const kept = s.slice(0, left);
    left = 0;
    return kept;
  };
  for (const field of ["content", "text", "refusal", "reasoning", "reasoning_content"] as const)
    if (typeof holder[field] === "string") holder[field] = take(holder[field]);
  if (Array.isArray(holder.reasoning_details)) {
    cut ||= holder.reasoning_details.length > 0;
    delete holder.reasoning_details;
  }
  if (Array.isArray(holder.tool_calls)) {
    const kept: any[] = [];
    for (const tc of holder.tool_calls) {
      if (left <= 0) {
        cut = true;
        break;
      }
      const fn = tc?.function ?? {};
      const name = typeof fn.name === "string" ? take(fn.name) : fn.name;
      const args = typeof fn.arguments === "string" ? take(fn.arguments) : fn.arguments;
      kept.push({
        ...(tc?.index !== undefined ? { index: tc.index } : {}),
        ...(typeof tc?.id === "string" ? { id: tc.id } : {}),
        ...(typeof tc?.type === "string" ? { type: tc.type } : {}),
        function: { ...(name !== undefined ? { name } : {}), ...(args !== undefined ? { arguments: args } : {}) },
      });
    }
    holder.tool_calls = kept;
    if (!kept.length) delete holder.tool_calls;
  }
  for (const field of ["images", "audio", "annotations", "function_call"] as const)
    if (holder[field] != null) {
      cut = true;
      delete holder[field];
    }
  // Anything else a provider adds rides along unbilled, so a served refusal keeps only the fields above.
  for (const k of Object.keys(holder)) if (!REFUSED_MESSAGE_KEYS.has(k)) delete holder[k];
  return { left, cut };
}

const REFUSED_MESSAGE_KEYS = new Set(["role", "content", "text", "refusal", "reasoning", "reasoning_content", "tool_calls"]);
const REFUSED_CHOICE_KEYS = new Set(["index", "message", "delta", "text", "finish_reason"]);

/**
 * One choice of a served refusal, rebuilt from an allowlist: choice-level extras such as `logprobs` (a token-by-token
 * copy of the answer) are dropped, and the message, delta and text share the REFUSED_MAX_CHARS budget.
 */
export function capRefusedChoice(ch: any, budget: number): { left: number; cut: boolean } {
  if (!ch || typeof ch !== "object") return { left: budget, cut: false };
  for (const k of Object.keys(ch)) if (!REFUSED_CHOICE_KEYS.has(k)) delete ch[k];
  let left = budget;
  let cut = false;
  for (const holder of [ch.message, ch.delta]) {
    if (!holder || typeof holder !== "object") continue;
    const r = capRefusedChannels(holder, left);
    left = r.left;
    cut ||= r.cut;
  }
  if (typeof ch.text === "string") {
    const box = { text: ch.text };
    const r = capRefusedChannels(box, left);
    ch.text = box.text;
    left = r.left;
    cut ||= r.cut;
  }
  return { left, cut };
}

function capRefusedJson(json: any) {
  for (const ch of json?.choices ?? []) {
    const { cut } = capRefusedChoice(ch, REFUSED_MAX_CHARS);
    if (cut) ch.finish_reason = "length";
  }
}

/** `x-anonymo-refusal`: rerouted (a refusal was replaced), refused (the answer is a refusal), double (both refused). */
function refusalHeaders(r: RouteSuccess): Record<string, string> {
  const o = r.refusal;
  if (!o) return {};
  return { "x-anonymo-refusal": o.double ? "double" : o.served === "refused" ? "refused" : o.refused.length ? "rerouted" : "none" };
}

/**
 * Record what the refusal catch did for a finished call: each refused attempt's cost with an equal
 * `refusal_refund` (net 0), one reading per route in refusal_stats, and the receipt fields (every route touched).
 */
async function recordRefusal(p: FinalizeInput, o: { fees: Parameters<typeof priceUsage>[4]; served: Pico }) {
  const { ctx, billing, r } = p;
  const out = r.refusal!;
  const servedRefused = out.served === "refused";
  const priceMode = (byok: boolean): Mode => (billing.mode === "per_call" ? "per_call" : byok ? "byok" : billing.mode);
  const charges = out.refused.map((a, i) => {
    if (servedRefused && i === out.refused.length - 1) return { modelId: a.model.id, providerId: a.candidate.providerId, cost: o.served };
    const byok = p.byok.has(a.candidate.providerId);
    const usage = readUsage(a.usage, { prompt: p.promptTokens, completion: Math.max(1, Math.ceil(a.outChars / 4)) });
    return { modelId: a.model.id, providerId: a.candidate.providerId, cost: priceUsage(a.candidate, a.model, usage, priceMode(byok), o.fees, byok).total };
  });
  await recordRefusedAttempts(ctx.db, { accountId: billing.accountId, keyHash: billing.key?.keyHash ?? null, holdId: p.holdId, charges });
  await bumpRefusalStats(ctx.db, out.checked.map((x) => ({ routeId: routeIdOf(x.model.id, x.candidate.providerId), refused: x.refused })));
  const refunded = charges.reduce((sum, ch) => sum + ch.cost, 0n);
  let n = 0;
  const routes = out.checked.map((x) => ({
    model: x.model.id,
    provider: x.candidate.providerId,
    family: familyOf(x.model, x.candidate, ctx.catalog.lane.get(x.model.id)?.baseModel),
    refused: x.refused,
    ...(x.refused ? { refund: picoToUsdString(charges[n++]?.cost ?? 0n) } : {}),
  }));
  return {
    refused: servedRefused,
    routes,
    refusal: { rerouted: out.refused.length > 0 && routes.length > 1, double: out.double, served: out.served, refunded: picoToUsdString(refunded) },
  };
}
