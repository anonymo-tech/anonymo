// WS04 · Rules of the upstream config, the route score, families, stickiness keys and the sealed route set, without a
// router: config fixtures for every product rule, and property tests over random candidate sets.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { familyOf, nextOtherFamily, sealedRoutes, byFamily } from "../src/anonymo/models.ts";
import { upstreamsDocSchema, staticModelsOf } from "../src/providers/tiers.ts";
import { ADAPTERS, readUsd } from "../src/providers/adapters.ts";
import { balanceEndpointFor, balanceLevel } from "../src/providers/balance.ts";
import { DEFAULT_SCORING, routeScore } from "../src/routing/score.ts";
import { StickyRoutes, stickyKeyOf } from "../src/routing/sticky.ts";
import { anonymoOrder, selectProviders, type HealthView } from "../src/router/select.ts";
import { HealthTracker } from "../src/services/health.ts";
import type { Candidate } from "../src/catalog/catalog.ts";

const base = () => parse(readFileSync(new URL("../config/upstreams.yaml", import.meta.url), "utf8")) as { upstreams: any[]; routes: any[] };
const issuesOf = (doc: unknown) => {
  const r = upstreamsDocSchema.safeParse(doc);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("config rules", () => {
  test("the shipped config is valid", () => expect(issuesOf(base())).toEqual([]));

  test("a Venice route can never get a direct model ID", () => {
    const d = base();
    d.routes.find((r) => r.upstream === "venice").direct_id = "venice-uncensored";
    expect(issuesOf(d).join(" ")).toContain("never relabelled one-for-one");
  });

  test("a model ID served only by Venice routes is refused", () => {
    const d = base();
    for (const r of d.routes) if (r.upstream !== "venice") r.serves = r.serves.filter((s: string) => s !== "anonymo-council");
    expect(issuesOf(d).join(" ")).toContain("anonymo-council would be served by Venice routes only");
  });

  test("anonymo-1 needs a warm backup of every T0 family", () => {
    const d = base();
    for (const r of d.routes) if (r.family === "deepseek" && r.upstream !== "venice") r.serves = r.serves.filter((s: string) => s !== "anonymo-1");
    expect(issuesOf(d).join(" ")).toContain("venice-deepseek-flash (deepseek) has no warm backup");
  });

  test("anonymo-sealed only on TEE upstreams, anonymo-rp only self-hosted", () => {
    const d = base();
    d.routes.find((r) => r.id === "featherless-mistral").serves.push("anonymo-sealed", "anonymo-rp");
    const msg = issuesOf(d).join(" ");
    expect(msg).toContain("anonymo-sealed only uses attested routes");
    expect(msg).toContain("anonymo-rp runs on self-hosted routes only");
  });

  test("every prepaid upstream needs a balance alarm, with drain at or below warn and a known endpoint", () => {
    const d = base();
    delete d.upstreams.find((u) => u.id === "nanogpt").balance;
    d.upstreams.find((u) => u.id === "venice").balance = { warn_usd: 1, drain_usd: 5 };
    delete d.upstreams.find((u) => u.id === "phala").balance.url;
    const msg = issuesOf(d).join(" ");
    expect(msg).toContain("prepaid upstream nanogpt needs a balance alarm");
    expect(msg).toContain("drain_usd must not be above warn_usd");
    expect(msg).toContain("phala upstream has no default balance endpoint");
  });

  test("an upstream sits only in its kind's tier", () => {
    const d = base();
    d.upstreams.find((u) => u.id === "nanogpt").tier = 0;
    expect(issuesOf(d).join(" ")).toContain("a nanogpt upstream sits in tier 2");
  });

  test("a route publishes one registry entry per model ID it serves, priced per token", () => {
    const d = upstreamsDocSchema.parse(base());
    const r = d.routes.find((x) => x.id === "selfhost-gemma-26b")!;
    const entries = staticModelsOf(r);
    expect(entries.map((e) => e.slug)).toEqual(["anonymo-1", "anonymo-rp", "anonymo-council", "gemma-4-26b-uncensored"]);
    expect(entries[0]).toMatchObject({ id: "gemma-4-26b-uncensored", quantization: "bf16", pricing: { prompt: "0.0000001", completion: "0.0000003" } });
  });
});

describe("families", () => {
  test("the configured family wins; otherwise it is read from the model name; unknown names are their own family", () => {
    expect(familyOf({ family: "Qwen", providerModelId: "deepseek-x" })).toBe("qwen");
    expect(familyOf({ family: null, providerModelId: "cognitivecomputations/Dolphin-Mistral-24B-Venice-Edition" })).toBe("mistral");
    expect(familyOf({ family: null, providerModelId: "venice-uncensored" })).toBe("mistral");
    expect(familyOf({ family: null, providerModelId: "zai-org/GLM-5.2" })).toBe("glm");
    expect(familyOf({ family: null, providerModelId: "acme/thing-7b" })).toBe("model:acme/thing-7b");
    expect(familyOf({ family: null, providerModelId: "acme/other-7b" })).not.toBe(familyOf({ family: null, providerModelId: "acme/thing-7b" }));
  });

  test("nextOtherFamily skips every family already tried, in routing order", () => {
    const routes = [
      { family: "deepseek", providerModelId: "a" },
      { family: "deepseek", providerModelId: "b" },
      { family: "mistral", providerModelId: "c" },
      { family: "glm", providerModelId: "d" },
    ];
    expect(nextOtherFamily(routes, [routes[0]])?.providerModelId).toBe("c");
    expect(nextOtherFamily(routes, ["deepseek", "mistral"])?.providerModelId).toBe("d");
    expect(nextOtherFamily(routes, ["deepseek", "mistral", "glm"])).toBeNull();
    expect([...byFamily(routes).keys()]).toEqual(["deepseek", "mistral", "glm"]);
  });
});

// ---- candidates for selection ------------------------------------------------------------------------------------

let seq = 0;
function route(o: Partial<Candidate> & { attested?: boolean; teeKind?: string | null } = {}): Candidate {
  const id = o.providerId ?? `r${++seq}`;
  const attested = o.attested ?? false;
  return {
    modelId: o.modelId ?? "anonymo-1",
    providerId: id,
    providerModelId: o.providerModelId ?? `m-${id}`,
    pricePrompt: o.pricePrompt ?? 100_000n,
    priceCompletion: o.priceCompletion ?? 300_000n,
    priceRequest: 0n,
    priceImage: 0n,
    priceWebSearch: 0n,
    priceReasoning: 0n,
    priceCacheRead: null,
    priceCacheWrite: null,
    quant: "fp8",
    ctx: 131072,
    maxOut: null,
    supportedParameters: [],
    features: {},
    isModerated: false,
    status: o.status ?? "live",
    updatedAt: new Date(),
    family: o.family ?? "deepseek",
    weightsHash: null,
    tier: o.tier === undefined ? 1 : o.tier,
    upstream: o.upstream ?? "selfhost",
    upstreamId: o.upstreamId ?? id,
    qualityRank: o.qualityRank ?? 80,
    provider: {
      id,
      status: "live",
      dataPolicy: { training: false, retains_prompts: false, zdr: true },
      attested,
      attestationHash: attested ? "h" : null,
      attestedAt: attested ? new Date() : null,
      teeKind: o.teeKind === undefined ? (attested ? "tdx" : null) : o.teeKind,
      classifierEnabled: false,
      anmoStake: 0n,
    } as unknown as Candidate["provider"],
  } as Candidate;
}

const select = (offers: Candidate[], health: HealthView, extra: Record<string, unknown> = {}) =>
  selectProviders({
    modelId: offers[0]?.modelId ?? "anonymo-1",
    offers,
    prefs: {},
    modifiers: new Set(),
    requestParams: [],
    estimatedTokens: 10,
    health,
    production: true,
    attestationMaxAgeMs: 30 * 60_000,
    modelLane: { variant: "mainstream", servable: true } as never,
    ...extra,
  });

// Deterministic pseudo-random numbers for the property tests.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("route score and order", () => {
  test("a healthy T0 route outranks a better-ranked backup by its bonus; it loses the bonus when unhealthy", () => {
    const t0 = { tier: 0, qualityRank: 80, canaryQuality: 1, ttftP50Ms: 500, errorRate: 0, usdPerM: 0.5 };
    const t1 = { ...t0, tier: 1, qualityRank: 90 };
    expect(routeScore(t0).score).toBeGreaterThan(routeScore(t1).score);
    const sick = routeScore({ ...t0, errorRate: 0.3 });
    expect(sick.healthy).toBe(false);
    expect(sick.score).toBeLessThan(routeScore(t1).score);
    expect(routeScore({ ...t1, ttftP50Ms: 4_000 }).score).toBeCloseTo(routeScore(t1).score - DEFAULT_SCORING.latency_per_s * 3.5);
  });

  test("property: the order is deterministic, keeps every route, and puts a healthy T0 route first when quality ties", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const n = 2 + Math.floor(r() * 6);
      const routes = Array.from({ length: n }, (_, i) => route({ providerId: `p${seed}-${i}`, tier: Math.floor(r() * 4), qualityRank: 60 + Math.floor(r() * 3) * 10, family: ["deepseek", "glm", "mistral"][i % 3] }));
      const health = new HealthTracker();
      for (const c of routes) if (r() < 0.3) for (let k = 0; k < 4; k++) health.record({ modelId: c.modelId, providerId: c.providerId, ok: k % 2 === 0, errorKind: k % 2 ? "http_5xx" : null, latencyMs: 200 + r() * 2000 });
      const a = anonymoOrder(routes, health, null).map((c) => c.providerId);
      const b = anonymoOrder([...routes].reverse(), health, null).map((c) => c.providerId);
      expect(a).toEqual(b);
      expect([...a].sort()).toEqual(routes.map((c) => c.providerId).sort());
      const t0 = routes.filter((c) => c.tier === 0 && health.window(c.modelId, c.providerId).errorRate < DEFAULT_SCORING.healthy_max_error_rate);
      const top = Math.max(...routes.map((c) => c.qualityRank!));
      if (t0.some((c) => c.qualityRank === top && health.window(c.modelId, c.providerId).n === 0)) expect(routes.find((c) => c.providerId === a[0])!.tier).toBe(0);
    }
  });

  test("selection orders Anonymo routes by score instead of a weighted draw", () => {
    const health = new HealthTracker();
    const offers = [route({ providerId: "b", tier: 1, qualityRank: 84 }), route({ providerId: "a", tier: 0, upstream: "venice", qualityRank: 80 }), route({ providerId: "c", tier: 2, qualityRank: 83 })];
    for (let i = 0; i < 20; i++) expect(select(offers, health, { rand: Math.random }).ordered.map((c) => c.providerId)).toEqual(["a", "b", "c"]);
  });
});

describe("anonymo-sealed", () => {
  test("property: anonymo-sealed never selects a route without a fresh attestation, whatever the request asks", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const offers = Array.from({ length: 1 + Math.floor(r() * 6) }, (_, i) => {
        const c = route({ providerId: `s${seed}-${i}`, modelId: "anonymo-sealed", tier: 2, upstream: "phala", attested: r() < 0.5, teeKind: r() < 0.15 ? "dev" : undefined });
        if (c.provider.attested && r() < 0.2) c.provider.attestedAt = new Date(Date.now() - 2 * 60 * 60_000); // stale
        return c;
      });
      const prefs = [{}, { lane: "public" }, { disclosure: "any" }, { allow_fallbacks: true }, { order: offers.map((o) => o.providerId) }][Math.floor(r() * 5)];
      const sel = select(offers, new HealthTracker(), { prefs });
      const fresh = new Set(sealedRoutes(offers, { maxAgeMs: 30 * 60_000, production: true }).map((c) => c.providerId));
      for (const c of sel.ordered) expect(fresh.has(c.providerId)).toBe(true);
      for (const e of sel.excluded) if (!fresh.has(e.provider)) expect(e.reason).toBe("anonymo-sealed requires a fresh TEE attestation");
    }
  });

  test("with no attested route up, anonymo-sealed has nothing to route to (WS09 answers 409 sealed_unavailable)", () => {
    const sel = select([route({ modelId: "anonymo-sealed", tier: 2 })], new HealthTracker());
    expect(sel.ordered).toEqual([]);
  });
});

describe("stickiness keys", () => {
  const msgs = (turns: string[]) => ({ messages: [{ role: "system", content: "You are Mira." }, ...turns.map((t, i) => ({ role: i % 2 ? "assistant" : "user", content: t }))] });
  test("the same key and conversation prefix share a sticky key as the conversation grows; anything else does not", () => {
    const a = stickyKeyOf("key-a", "anonymo-1", msgs(["hi"]));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(stickyKeyOf("key-a", "anonymo-1", msgs(["hi", "hello!", "how are you?"]))).toBe(a!);
    expect(stickyKeyOf("key-b", "anonymo-1", msgs(["hi"]))).not.toBe(a!);
    expect(stickyKeyOf("key-a", "anonymo-rp", msgs(["hi"]))).not.toBe(a!);
    expect(stickyKeyOf("key-a", "anonymo-1", msgs(["a different opener"]))).not.toBe(a!);
    expect(stickyKeyOf(null, "anonymo-1", msgs(["hi"]))).toBeNull();
    expect(a).not.toContain("Mira");
  });

  test("entries expire and the table stays bounded", () => {
    const t = new StickyRoutes(3);
    t.set("a", "r1", 1_000, 0);
    expect(t.get("a", 500)).toBe("r1");
    expect(t.get("a", 1_000)).toBeNull();
    for (const k of ["b", "c", "d", "e"]) t.set(k, "r", 10_000, 0);
    expect(t.size).toBe(3);
    expect(t.get("b", 1)).toBeNull();
  });
});

describe("adapters and balances", () => {
  test("balance readings parse numbers and numeric strings only", () => {
    expect(readUsd({ data: { balances: { USD: 12.5 } } }, "data.balances.USD")).toBe(12.5);
    expect(readUsd({ usd_balance: "3.20" }, "usd_balance")).toBe(3.2);
    expect(readUsd({ usd_balance: "lots" }, "usd_balance")).toBeNull();
    expect(readUsd({ a: null }, "a.b")).toBeNull();
  });

  test("levels: drain at or below drain_usd, warn at or below warn_usd", () => {
    const b = { warn_usd: 50, drain_usd: 5 };
    expect([balanceLevel(null, b), balanceLevel(5, b), balanceLevel(5.01, b), balanceLevel(50, b), balanceLevel(50.01, b)]).toEqual(["unknown", "drain", "warn", "warn", "ok"]);
  });

  test("balance endpoints resolve against the upstream's origin unless the config gives a full URL", () => {
    expect(balanceEndpointFor({ kind: "venice", balance: { warn_usd: 1, drain_usd: 0 } }, "https://api.venice.ai/api/v1")).toEqual({ url: "https://api.venice.ai/api/v1/api_keys/rate_limits", method: "GET", auth: "bearer", path: "data.balances.USD" });
    expect(balanceEndpointFor({ kind: "nanogpt", balance: { warn_usd: 1, drain_usd: 0 } }, "https://nano-gpt.com/api/v1")?.url).toBe("https://nano-gpt.com/api/check-balance");
    expect(balanceEndpointFor({ kind: "phala", balance: { warn_usd: 1, drain_usd: 0 } }, "https://x.example/v1")).toBeNull();
    expect(balanceEndpointFor({ kind: "selfhost", balance: { warn_usd: 1, drain_usd: 0, url: "https://gpu.example/me", path: "credit" } }, "https://x.example/v1")).toMatchObject({ url: "https://gpu.example/me", path: "credit" });
  });

  test("the Venice adapter turns Venice's own system prompt off and keeps the caller's other Venice parameters", () => {
    const out: Record<string, unknown> = { venice_parameters: { enable_web_search: "off", include_venice_system_prompt: true } };
    ADAPTERS.venice.body!(out);
    expect(out.venice_parameters).toEqual({ enable_web_search: "off", include_venice_system_prompt: false });
  });
});
