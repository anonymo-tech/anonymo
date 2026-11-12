import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { ADMIN, startRouter, type Harness } from "./helpers.ts";
import { providers as providersTable } from "../src/db/schema.ts";
import { assertSealedSeats, sealedEligible, sealedFilter, type SealedClock, type SealedRouteState } from "../src/anonymo/trust/sealed.ts";
import { sealedTargets } from "../src/anonymo/trust/hooks.ts";
import { parseReceiptHeader } from "../src/receipts/anonymo.ts";
import { runAttestor } from "../src/services/attestor.ts";

// Property: a sealed request NEVER touches a route that is not attested and fresh (AGENTS.md product rule; Backend §6).
//
// fast-check is not a gateway dependency (package.json belongs to WS01), so the generator here is a small seeded PRNG
// (mulberry32). Every run is reproducible: a failure prints the seed and the generated states. Set SEALED_SEED to
// replay one run, SEALED_RUNS to change how many.

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = Number(process.env.SEALED_SEED ?? 0x5ea1ed);
const RUNS = Number(process.env.SEALED_RUNS ?? 5000);

type Gen = ReturnType<typeof mulberry32>;
const pick = <T>(g: Gen, xs: readonly T[]) => xs[Math.floor(g() * xs.length)];
const MAX_AGE = 30 * 60_000;

/** A random route state, biased towards the edges: missing pieces, dev evidence, exactly-at-the-limit ages, the future. */
function randomState(g: Gen, now: number): SealedRouteState {
  const age = pick(g, [0, 1, MAX_AGE - 1, MAX_AGE, MAX_AGE + 1, -1, -60_000, Math.floor(g() * 2 * MAX_AGE), 10 * MAX_AGE, NaN]);
  return {
    attested: g() < 0.7,
    attestationHash: g() < 0.85 ? "0x" + Math.floor(g() * 1e12).toString(16).padStart(64, "0") : pick(g, [null, ""]),
    attestedAt: g() < 0.9 ? new Date(now - age) : null,
    teeKind: pick(g, ["tdx", "sev-snp", "nvidia-cc", "dev", null, ""]),
    live: g() < 0.85,
  };
}

/** Independent oracle for "attested and fresh", written out long-hand. */
function oracle(s: SealedRouteState, c: SealedClock): boolean {
  if (s.live !== true) return false;
  if (s.attested !== true) return false;
  if (typeof s.attestationHash !== "string" || s.attestationHash.length === 0) return false;
  if (typeof s.teeKind !== "string" || s.teeKind.length === 0) return false;
  if (c.production && s.teeKind === "dev") return false;
  if (!(s.attestedAt instanceof Date)) return false;
  const t = s.attestedAt.getTime();
  if (Number.isNaN(t)) return false;
  return t <= c.now && c.now - t <= c.maxAgeMs;
}

describe("sealed never touches a non-attested route (pure property)", () => {
  test(`sealedFilter keeps exactly the attested, fresh routes over ${RUNS} random provider states`, () => {
    const g = mulberry32(SEED);
    for (let run = 0; run < RUNS; run++) {
      const now = 1_800_000_000_000 + Math.floor(g() * 1e9);
      const clock: SealedClock = { now, maxAgeMs: MAX_AGE, production: g() < 0.5 };
      const routes = Array.from({ length: 1 + Math.floor(g() * 8) }, (_, i) => ({ i, s: randomState(g, now) }));
      const kept = sealedFilter(routes, (r) => r.s, clock);
      const ctxMsg = () => `seed=${SEED} run=${run} clock=${JSON.stringify(clock)} routes=${JSON.stringify(routes)}`;
      for (const r of kept) if (!oracle(r.s, clock)) throw new Error(`kept a non-attested route: ${JSON.stringify(r)} ${ctxMsg()}`);
      const expected = routes.filter((r) => oracle(r.s, clock)).map((r) => r.i);
      if (JSON.stringify(kept.map((r) => r.i)) !== JSON.stringify(expected)) throw new Error(`dropped an attested route or reordered: ${ctxMsg()}`);
      for (const r of routes) expect(sealedEligible(r.s, clock)).toBe(oracle(r.s, clock));
    }
  });

  test(`a seat set passes assertSealedSeats only when every seat has routes and every route is attested and fresh`, () => {
    const g = mulberry32(SEED ^ 0x9e3779b9);
    for (let run = 0; run < RUNS; run++) {
      const now = 1_800_000_000_000;
      const clock: SealedClock = { now, maxAgeMs: MAX_AGE, production: true };
      const seats = Array.from({ length: 1 + Math.floor(g() * 4) }, (_, i) => ({ seat: `seat ${i}`, routes: Array.from({ length: Math.floor(g() * 4) }, () => randomState(g, now)) }));
      const ok = seats.every((s) => s.routes.length > 0 && s.routes.every((r) => oracle(r, clock)));
      let threw: any = null;
      try {
        assertSealedSeats(seats, (r) => r, clock);
      } catch (e) {
        threw = e;
      }
      if (ok !== (threw === null)) throw new Error(`seed=${SEED} run=${run}: expected ${ok ? "pass" : "409"}, got ${threw ? threw.type : "pass"}; seats=${JSON.stringify(seats)}`);
      if (threw) expect([threw.status, threw.type]).toEqual([409, "sealed_unavailable"]);
    }
  });
});

// ---- The same property through the real request path: random provider states, sealed council requests --------------

const fam = [
  { id: "p-ds", up: "ds-up", slug: "deepseek/deepseek-v4-flash" },
  { id: "p-glm", up: "glm-up", slug: "zai/glm-5" },
  { id: "p-qw", up: "qwen-up", slug: "qwen/qwen3-32b" },
  { id: "p-gm", up: "gemma-up", slug: "google/gemma-4-26b" },
  { id: "p-km", up: "kimi-up", slug: "moonshot/kimi-k2" },
  { id: "p-ms", up: "mistral-up", slug: "mistral/dolphin-mistral-24b" },
];
const HTTP_RUNS = Number(process.env.SEALED_HTTP_RUNS ?? 40);

describe("sealed never touches a non-attested route (request path property)", () => {
  let h: Harness;
  let auth: Record<string, string>;
  const reply = (prompt: string, body: any) => (prompt.includes("Write the final answer now.") ? "MERGED" : `answer from ${body.model}`);
  const claim = { source: "https://provider.example/terms", as_of: "2025-01-15" };
  beforeAll(async () => {
    h = await startRouter({
      env: { ANONYMO_FEATURE_COUNCIL: "true" },
      providers: fam.map((f) => ({ id: f.id, name: f.id, models: [{ id: f.up, slug: f.slug, prompt: "0.000001", completion: "0.000002" }], tee: "dev" as const, reply })),
    });
    auth = (await h.fundedKey(100n)).auth;
    for (const f of fam) await h.request(`/api/v1/disclosure/${f.id}`, { method: "PUT", headers: { "x-admin-token": ADMIN }, json: { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } } });
    await runAttestor(h.ctx);
  });
  afterAll(async () => h.close());

  test(`${HTTP_RUNS} random states: a sealed council either runs on attested, fresh routes only or fails 409 having sent nothing`, async () => {
    const g = mulberry32(SEED ^ 0x1234567);
    const interval = h.ctx.cfg.attestation.intervalMs;
    const maxAge = interval * 3;
    let served = 0;
    let refused = 0;
    for (let run = 0; run < HTTP_RUNS; run++) {
      const now = Date.now();
      const states = new Map<string, SealedRouteState>();
      for (const f of fam) {
        const age = pick(g, [0, 1_000, maxAge - 5_000, maxAge + 5_000, 10 * maxAge, -120_000]);
        const s: SealedRouteState = {
          attested: g() < 0.75,
          attestationHash: g() < 0.9 ? "ab".repeat(32) : null,
          attestedAt: g() < 0.95 ? new Date(now - age) : null,
          teeKind: g() < 0.95 ? "dev" : null,
          live: true,
        };
        states.set(f.id, s);
        await h.ctx.db.update(providersTable).set({ attested: s.attested, attestationHash: s.attestationHash, attestedAt: s.attestedAt, teeKind: s.teeKind }).where(eq(providersTable.id, f.id));
      }
      await h.ctx.catalog.refresh();
      const clock: SealedClock = { now: Date.now(), maxAgeMs: maxAge, production: false };
      const before = Object.fromEntries(await Promise.all(fam.map(async (f) => [f.id, ((await (await fetch(h.mocks[f.id].url + "/_stats")).json()) as any).requests as number])));
      const aggregator = pick(g, fam).slug;
      const r = await h.request("/v1/chat/completions", {
        method: "POST",
        headers: { ...auth, "x-anonymo-sealed": "required" },
        json: { model: "anonymo-council", messages: [{ role: "user", content: `run ${run}` }], max_tokens: 50, council: { models: fam.map((f) => f.slug), aggregator } },
      });
      const after = Object.fromEntries(await Promise.all(fam.map(async (f) => [f.id, ((await (await fetch(h.mocks[f.id].url + "/_stats")).json()) as any).requests as number])));
      const touched = fam.filter((f) => after[f.id] > before[f.id]).map((f) => f.id);
      const dump = () => `seed=${SEED} run=${run} status=${r.status} touched=${touched} states=${JSON.stringify([...states])}`;
      // The property: nothing that is not attested and fresh was contacted, whatever the outcome.
      for (const id of touched) if (!oracle(states.get(id)!, clock)) throw new Error(`sealed request reached non-attested route ${id}: ${dump()}`);
      if (r.status === 200) {
        served++;
        const rc = parseReceiptHeader(r.headers.get("x-anonymo-receipt")!).payload;
        expect(rc.sealed).toBe(true);
        for (const route of rc.routes.filter((x) => x.status === "ok")) {
          if (!route.attested || !route.attestation_quote_hash) throw new Error(`receipt lists a used route without a quote: ${JSON.stringify(route)} ${dump()}`);
          if (!oracle(states.get(route.provider!)!, clock)) throw new Error(`receipt lists non-attested route ${route.provider}: ${dump()}`);
        }
      } else {
        refused++;
        const body = (await r.json()) as any;
        if (r.status !== 409 || body.error.type !== "sealed_unavailable") throw new Error(`unexpected ${r.status} ${JSON.stringify(body)} ${dump()}`);
        if (touched.length) throw new Error(`a refused sealed request still contacted ${touched}: ${dump()}`);
      }
    }
    // The generator must exercise both outcomes, or the property says little.
    expect(served).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  }, 120_000);

  test("the single-call hook keeps only attested, fresh routes, and refuses with 409 when none is left", async () => {
    const now = Date.now();
    for (const [i, f] of fam.entries())
      await h.ctx.db.update(providersTable).set({ attested: i % 2 === 0, attestationHash: "cd".repeat(32), attestedAt: new Date(now), teeKind: "dev" }).where(eq(providersTable.id, f.id));
    await h.ctx.catalog.refresh();
    const targets = fam.map((f) => {
      const model = h.ctx.catalog.resolve(f.slug)!.model;
      return { model, ordered: h.ctx.catalog.offers(model.id) };
    });
    const kept = sealedTargets(h.ctx, targets);
    expect(kept.flatMap((t) => t.ordered.map((o) => o.providerId)).sort()).toEqual(fam.filter((_, i) => i % 2 === 0).map((f) => f.id).sort());
    expect(() => sealedTargets(h.ctx, targets.filter((_, i) => i % 2 === 1))).toThrow(expect.objectContaining({ status: 409, type: "sealed_unavailable" }));
  });
});
