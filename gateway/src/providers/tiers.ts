// WS04 · Upstream tiers from YAML (config/upstreams.yaml), written into the catalogue as Anonymo routes (Backend §4).
//
//   upstreams   one per upstream account: kind (venice, selfhost, phala, chutes, nanogpt, featherless), tier, base URL and
//               API key (both from env), data policy, TEE, and for prepaid accounts a wallet-balance alarm
//   routes      one per upstream model we serve: family, quant, weights hash, context, our cost, quality rank, and the
//               Anonymo model IDs it serves (plus an optional direct model ID, never for Venice)
//
// Each route becomes one provider row (id = route id) and one offer per model ID it serves, with the route columns set
// (family, weights_hash, tier, upstream, upstream_id, quality_rank). The provider's static model list mirrors the offers,
// so the provider registry re-syncs them unchanged. The non-secret parts the jobs need at runtime (scoring, canary
// cadence, balance alarms) are kept in kv under ANONYMO_UPSTREAMS_KEY; keys are only ever stored encrypted.

import { and, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { parse } from "yaml";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { kv, models, offers, providers } from "../db/schema.ts";
import { encrypt } from "../lib/util.ts";
import { syncProvider } from "../services/registry.ts";
import { ADAPTERS } from "./adapters.ts";
import { validateProviderUrl } from "./application.ts";
import type { Scoring } from "../routing/score.ts";
import {
  ANONYMO_1,
  ANONYMO_MODEL_IDS,
  ANONYMO_MODEL_INFO,
  ANONYMO_RP,
  ANONYMO_SEALED,
  KIND_TIERS,
  UPSTREAM_KINDS,
  isAnonymoModelId,
  type Tier,
  type UpstreamKind,
} from "../anonymo/models.ts";

export const ANONYMO_UPSTREAMS_KEY = "anonymo:upstreams";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, "use 2-41 lowercase letters, digits and hyphens");
const usd = z.number().nonnegative().finite();
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "a lowercase hex sha256");

export const scoringSchema = z
  .strictObject({
    /** Points added to a healthy T0 route. */
    t0_bonus: z.number().min(0).max(100).default(25),
    /** Points taken per second of median time to first token (rolling 5-minute window). */
    latency_per_s: z.number().min(0).max(100).default(5),
    /** Points taken at a 100% error rate (rolling 5-minute window), pro rata below. */
    error_penalty: z.number().min(0).max(1000).default(100),
    /** Points taken per USD of blended cost per million tokens. */
    cost_per_usd_m: z.number().min(0).max(100).default(2),
    /** A route is healthy (keeps the T0 bonus and sticky conversations) below this error rate. */
    healthy_max_error_rate: z.number().min(0).max(1).default(0.25),
    /** How long a key + conversation prefix stays on its route while the route is healthy. */
    sticky_ttl_s: z.number().int().min(0).max(86_400).default(1_800),
  })
  .default({ t0_bonus: 25, latency_per_s: 5, error_penalty: 100, cost_per_usd_m: 2, healthy_max_error_rate: 0.25, sticky_ttl_s: 1_800 });
export type { Scoring };

export const canarySchema = z
  .strictObject({
    /** Seconds between canaries per upstream x model (Backend §4: every 30-60 s). */
    interval_s: z.number().int().min(5).max(3_600).default(45),
    timeout_s: z.number().int().min(1).max(120).default(15),
    /** Canaries run at most this many at once. */
    concurrency: z.number().int().min(1).max(64).default(8),
  })
  .default({ interval_s: 45, timeout_s: 15, concurrency: 8 });
export type CanaryConfig = z.infer<typeof canarySchema>;

const balanceSchema = z.strictObject({
  /** Raise an alarm at or below this balance. */
  warn_usd: usd,
  /** Drain every route of the upstream at or below this balance (and alarm). */
  drain_usd: usd,
  /** Override the adapter's balance endpoint (src/providers/balance.ts). https only in production. */
  url: z.string().url().optional(),
  method: z.enum(["GET", "POST"]).optional(),
  auth: z.enum(["bearer", "x-api-key", "none"]).optional(),
  /** Dotted path to the USD balance in the JSON reply (for example "data.balances.USD"). */
  path: z.string().regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/).optional(),
  /** A separate account credential for the balance endpoint (for example a GPU marketplace key), by env var name. */
  key_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
});

const upstreamSchema = z.strictObject({
  id: slug,
  name: z.string().min(1).max(80),
  kind: z.enum(UPSTREAM_KINDS),
  tier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  base_url: z.string().url(),
  /** When this env var is set it replaces base_url (for example VENICE_BASE_URL). */
  base_url_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  api_key_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  data_policy: z.strictObject({ training: z.boolean(), retains_prompts: z.boolean(), retention_days: z.number().optional(), zdr: z.boolean().optional() }),
  tee: z.strictObject({ kind: z.enum(["tdx", "snp", "nvidia-cc", "tinfoil", "dev"]), attestation_url: z.string().url() }).optional(),
  timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
  /** Prepaid upstreams must configure a balance alarm: an empty upstream wallet is a silent outage. */
  prepaid: z.boolean(),
  balance: balanceSchema.optional(),
});

const routeSchema = z.strictObject({
  id: slug,
  upstream: slug,
  /** The upstream's own model id. */
  model: z.string().min(1).max(200),
  family: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,40}$/),
  quant: z.string().regex(/^[a-z0-9]{2,8}$/),
  weights_hash: sha256Hex.optional(),
  ctx: z.number().int().positive(),
  max_out: z.number().int().positive().optional(),
  /** Our cost, USD per million tokens (Backend §4 priceIn / priceOut). */
  price: z.strictObject({ in: usd, out: usd }),
  /** Quality rank 0-100 (from the leaderboard). */
  quality: z.number().min(0).max(100),
  serves: z.array(z.enum(ANONYMO_MODEL_IDS)).default([]),
  /** A model ID of its own (for example glm-5.3-flash-uncensored). Never for a Venice route. */
  direct_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,80}$/).optional(),
  hf_repo: z.string().optional(),
  features: z.array(z.string()).default([]),
  params: z.array(z.string()).optional(),
  enabled: z.boolean().default(true),
});

export const upstreamsDocSchema = z
  .strictObject({
    version: z.literal(1),
    scoring: scoringSchema,
    canaries: canarySchema,
    upstreams: z.array(upstreamSchema).min(1),
    routes: z.array(routeSchema).min(1),
  })
  .superRefine((d, ctx) => {
    for (const issue of upstreamsDocIssues(d)) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  });
export type UpstreamsDoc = z.infer<typeof upstreamsDocSchema>;
export type UpstreamSpec = UpstreamsDoc["upstreams"][number];
export type RouteSpec = UpstreamsDoc["routes"][number];

type Issue = { path: (string | number)[]; message: string };

/** The product rules a config must keep (AGENTS.md, Overview §2 and §4, Backend §4). */
export function upstreamsDocIssues(d: Pick<UpstreamsDoc, "upstreams" | "routes">): Issue[] {
  const issues: Issue[] = [];
  const ups = new Map<string, UpstreamSpec>();
  d.upstreams.forEach((u, i) => {
    if (ups.has(u.id)) issues.push({ path: ["upstreams", i, "id"], message: `upstream ${u.id} is listed twice` });
    ups.set(u.id, u);
    if (!KIND_TIERS[u.kind].includes(u.tier as Tier)) issues.push({ path: ["upstreams", i, "tier"], message: `a ${u.kind} upstream sits in tier ${KIND_TIERS[u.kind].join("/")}, not ${u.tier}` });
    if (u.prepaid && !u.balance) issues.push({ path: ["upstreams", i, "balance"], message: `prepaid upstream ${u.id} needs a balance alarm (an empty wallet is a silent outage)` });
    if (u.prepaid && u.balance && !u.balance.url && !ADAPTERS[u.kind].balance) issues.push({ path: ["upstreams", i, "balance", "url"], message: `a ${u.kind} upstream has no default balance endpoint: set balance.url` });
    if (u.balance && u.balance.drain_usd > u.balance.warn_usd) issues.push({ path: ["upstreams", i, "balance"], message: "drain_usd must not be above warn_usd" });
  });
  const ids = new Set<string>();
  const directIds = new Set<string>();
  const enabled = d.routes.filter((r) => r.enabled);
  d.routes.forEach((r, i) => {
    if (ids.has(r.id)) issues.push({ path: ["routes", i, "id"], message: `route ${r.id} is listed twice` });
    ids.add(r.id);
    const u = ups.get(r.upstream);
    if (!u) {
      issues.push({ path: ["routes", i, "upstream"], message: `unknown upstream ${r.upstream}` });
      return;
    }
    if (r.direct_id) {
      if (u.kind === "venice") issues.push({ path: ["routes", i, "direct_id"], message: "Venice models are never relabelled one-for-one under our key: no direct ID for a Venice route" });
      if (isAnonymoModelId(r.direct_id)) issues.push({ path: ["routes", i, "direct_id"], message: `${r.direct_id} is an Anonymo model ID` });
      if (directIds.has(r.direct_id) && enabled.filter((x) => x.direct_id === r.direct_id).some((x) => x.family !== r.family))
        issues.push({ path: ["routes", i, "direct_id"], message: `direct ID ${r.direct_id} is served by routes of different families` });
      directIds.add(r.direct_id);
    }
    if (r.serves.includes(ANONYMO_SEALED) && !u.tee) issues.push({ path: ["routes", i, "serves"], message: `anonymo-sealed only uses attested routes; upstream ${u.id} has no TEE` });
    if (r.serves.includes(ANONYMO_RP) && u.kind !== "selfhost") issues.push({ path: ["routes", i, "serves"], message: "anonymo-rp runs on self-hosted routes only" });
  });
  // Every model ID a Venice route serves must also be served elsewhere, or it would be a Venice model under our name.
  for (const id of ANONYMO_MODEL_IDS) {
    const serving = enabled.filter((r) => r.serves.includes(id) && ups.has(r.upstream));
    if (serving.length && serving.every((r) => ups.get(r.upstream)!.kind === "venice"))
      issues.push({ path: ["routes"], message: `${id} would be served by Venice routes only (never relabel Venice one-for-one)` });
  }
  // anonymo-1: T0 first, warm backups of the same families behind it.
  const one = enabled.filter((r) => r.serves.includes(ANONYMO_1) && ups.has(r.upstream));
  for (const r of one.filter((x) => ups.get(x.upstream)!.tier === 0))
    if (!one.some((b) => b.family === r.family && ups.get(b.upstream)!.tier > 0))
      issues.push({ path: ["routes"], message: `anonymo-1 T0 route ${r.id} (${r.family}) has no warm backup of the same family on another tier` });
  return issues;
}

/** Parse and validate config/upstreams.yaml. Throws with every issue listed. */
export function parseUpstreamsYaml(text: string): UpstreamsDoc {
  const r = upstreamsDocSchema.safeParse(parse(text));
  if (!r.success) throw new Error("Invalid upstreams config: " + r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
  return r.data;
}

// ---- persisted runtime view (no secrets in clear) -----------------------------------------------------------------

export type UpstreamRuntime = {
  id: string;
  kind: UpstreamKind;
  tier: Tier;
  prepaid: boolean;
  balance: (Omit<z.infer<typeof balanceSchema>, "key_env"> & { keyEnc?: string }) | null;
};
export type UpstreamsRuntime = { v: 1; scoring: Scoring; canaries: CanaryConfig; upstreams: UpstreamRuntime[] };

export async function loadUpstreamsRuntime(db: Db): Promise<UpstreamsRuntime | null> {
  const [row] = await db.select({ value: kv.value }).from(kv).where(eq(kv.key, ANONYMO_UPSTREAMS_KEY));
  const v = row?.value as UpstreamsRuntime | undefined;
  return v && v.v === 1 && Array.isArray(v.upstreams) ? v : null;
}

// ---- seeding -----------------------------------------------------------------------------------------------------

const perToken = (usdPerMillion: number) => (usdPerMillion / 1_000_000).toFixed(12).replace(/0+$/, "").replace(/\.$/, "") || "0";

/** The provider-spec model entries a route publishes (one per model ID it serves), read back by the provider registry. */
export function staticModelsOf(r: RouteSpec): Record<string, unknown>[] {
  const ids = [...(r.enabled ? r.serves : []), ...(r.enabled && r.direct_id ? [r.direct_id] : [])];
  return ids.map((slug) => ({
    id: r.model,
    slug,
    anonymo: { slug },
    name: isAnonymoModelId(slug) ? ANONYMO_MODEL_INFO[slug].name : slug,
    ...(r.hf_repo ? { hugging_face_id: r.hf_repo } : {}),
    input_modalities: ["text"],
    output_modalities: ["text"],
    quantization: r.quant,
    context_length: r.ctx,
    ...(r.max_out ? { max_output_length: r.max_out } : {}),
    pricing: { prompt: perToken(r.price.in), completion: perToken(r.price.out) },
    supported_sampling_parameters: r.params ?? ["temperature", "top_p", "stop", "seed", "max_tokens", "frequency_penalty", "presence_penalty"],
    supported_features: r.features,
  }));
}

export type SeedOptions = {
  appSecret: string;
  production: boolean;
  env: Record<string, string | undefined>;
  /** Local and test use: seed routes whose key env var is unset, with no key. Never in production. */
  allowMissingKeys?: boolean;
};

/**
 * Write the config into the catalogue: providers (one per route), models (the Anonymo IDs and direct IDs), offers with
 * the route columns, and the runtime view in kv. Idempotent. Routes and upstreams that left the config are disabled,
 * never deleted (generations reference their offers).
 */
export async function seedUpstreams(db: Db, doc: UpstreamsDoc, opts: SeedOptions) {
  const ups = new Map(doc.upstreams.map((u) => [u.id, u]));
  const baseUrl = (u: UpstreamSpec) => {
    const url = (u.base_url_env && opts.env[u.base_url_env]) || u.base_url;
    validateProviderUrl(url, opts.production);
    return url;
  };
  const keyOf = (name: string | undefined, what: string) => {
    if (!name) return null;
    const key = opts.env[name];
    if (!key && (opts.production || !opts.allowMissingKeys)) throw new Error(`Required credential for ${what} is missing (set ${name}).`);
    return key ? encrypt(opts.appSecret, key) : null;
  };
  const upstreamKeys = new Map(doc.upstreams.map((u) => [u.id, keyOf(u.api_key_env, `upstream ${u.id}`)]));
  const now = new Date();

  // Models first: every Anonymo model ID some route serves, and every direct ID.
  const servedIds = new Set<string>();
  const ctxOf = new Map<string, number>();
  for (const r of doc.routes.filter((x) => x.enabled))
    for (const id of [...r.serves, ...(r.direct_id ? [r.direct_id] : [])]) {
      servedIds.add(id);
      ctxOf.set(id, Math.max(ctxOf.get(id) ?? 0, r.ctx));
    }
  for (const id of servedIds) {
    const info = isAnonymoModelId(id) ? ANONYMO_MODEL_INFO[id] : { name: id, description: "" };
    const row = { id, author: "anonymo", name: info.name, description: info.description, ctx: ctxOf.get(id)!, arch: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"], tokenizer: "Other" }, createdUnix: Math.floor(now.getTime() / 1000), hidden: false };
    await db.insert(models).values(row).onConflictDoUpdate({ target: models.id, set: { name: row.name, description: row.description, ctx: row.ctx, hidden: false } });
  }

  for (const r of doc.routes) {
    const u = ups.get(r.upstream)!;
    if (u.tee) validateProviderUrl(u.tee.attestation_url, opts.production);
    if (u.balance?.url) validateProviderUrl(u.balance.url, opts.production);
    const row = {
      id: r.id,
      name: `${u.name} · ${r.model}`.slice(0, 120),
      baseUrl: baseUrl(u),
      apiKeyEnc: upstreamKeys.get(u.id) ?? null,
      kind: u.tee ? "tee" : "openai",
      status: r.enabled ? "live" : "suspended",
      dataPolicy: u.data_policy,
      datacenter: [] as string[],
      teeKind: u.tee?.kind ?? null,
      attestationUrl: u.tee?.attestation_url ?? null,
      timeoutMs: u.timeout_ms ?? null,
      staticModels: staticModelsOf(r),
      shadowUntil: null,
    };
    await db.insert(providers).values(row).onConflictDoUpdate({ target: providers.id, set: { ...row, updatedAt: now } });
    if (r.enabled) {
      const [p] = await db.select().from(providers).where(eq(providers.id, r.id));
      await syncProvider({ cfg: { appSecret: opts.appSecret, production: opts.production }, db }, p);
      // A route back in the config serves again; a drained one stays drained until its balance alarm clears.
      const ids = staticModelsOf(r).map((m) => String(m.slug));
      await db.update(offers).set({ status: "live", updatedAt: now }).where(and(eq(offers.providerId, r.id), eq(offers.status, "disabled"), inArray(offers.modelId, ids)));
    } else await db.update(offers).set({ status: "disabled", updatedAt: now }).where(eq(offers.providerId, r.id));
    await db
      .update(offers)
      .set({ family: r.family, weightsHash: r.weights_hash ?? null, tier: u.tier, upstream: u.kind, upstreamId: u.id, qualityRank: r.quality })
      .where(eq(offers.providerId, r.id));
  }

  // Routes that left the config: their providers are suspended and their offers disabled.
  const routeIds = doc.routes.map((r) => r.id);
  const gone = await db.selectDistinct({ id: offers.providerId }).from(offers).where(and(isNotNull(offers.upstreamId), notInArray(offers.providerId, routeIds)));
  if (gone.length) {
    const ids = gone.map((g) => g.id);
    await db.update(offers).set({ status: "disabled", updatedAt: now }).where(inArray(offers.providerId, ids));
    await db.update(providers).set({ status: "suspended", updatedAt: now }).where(inArray(providers.id, ids));
  }

  const runtime: UpstreamsRuntime = {
    v: 1,
    scoring: doc.scoring,
    canaries: doc.canaries,
    upstreams: doc.upstreams.map((u) => {
      const { key_env, ...balance } = u.balance ?? ({} as NonNullable<UpstreamSpec["balance"]>);
      const keyEnc = key_env ? keyOf(key_env, `the balance endpoint of ${u.id}`) : null;
      return { id: u.id, kind: u.kind, tier: u.tier as Tier, prepaid: u.prepaid, balance: u.balance ? { ...balance, ...(keyEnc ? { keyEnc } : {}) } : null };
    }),
  };
  await db.insert(kv).values({ key: ANONYMO_UPSTREAMS_KEY, value: runtime }).onConflictDoUpdate({ target: kv.key, set: { value: runtime, updatedAt: now } });
  return { routes: doc.routes.filter((r) => r.enabled).length, models: [...servedIds].sort() };
}
