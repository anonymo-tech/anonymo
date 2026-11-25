import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AgeProofVerifier } from "../../src/anonymo/region/age-proof.ts";
import { createRegionPolicy } from "../../src/anonymo/region/policy.ts";
import { DEFAULT_AGE_VERIFICATION_REGIONS, DEFAULT_BLOCKED_REGIONS, DEFAULT_OFAC_REGIONS } from "../../src/anonymo/region/rules.ts";
import { ageProofs, regionPolicy } from "../../src/anonymo/region/schema.ts";
import { loadConfig } from "../../src/config.ts";
import { hmac } from "../../src/lib/util.ts";
import { MODELS, startRouter, type Harness } from "../helpers.ts";

const schedulePath = "/v1/compliance/region";
const proofPath = "/v1/compliance/age-proof";
const blockedHeaders = { "cf-ipcountry": "NL" };
const proofHeaders = { "cf-ipcountry": "GB" };
const fixture = (keyHash: string) => `over-18-fixture:${keyHash}`;
const nullifier = createHash("sha256").update("sample-age-claim").digest();
const fixtureVerifier: AgeProofVerifier = {
  async verify(proof, keyHash) {
    return proof === fixture(keyHash) ? nullifier : null;
  },
};

let h: Harness;
let key: Awaited<ReturnType<Harness["fundedKey"]>>;
let other: Awaited<ReturnType<Harness["fundedKey"]>>;
const provider = () => h.mocks.fixture;
const body = { model: MODELS.llama.slug, messages: [{ role: "user", content: "Hello" }] };
const chat = (headers: Record<string, string>, auth = key.auth) => h.request("/v1/chat/completions", {
  method: "POST", headers: { ...auth, ...headers }, json: body,
});
const proof = (value: string, auth = key.auth) => h.request(proofPath, { method: "POST", headers: { ...auth, ...proofHeaders }, json: { proof: value } });

beforeAll(async () => {
  h = await startRouter({
    env: { ANONYMO_FEATURE_COMPLIANCE: "true", TRUST_PROXY: "true" },
    providers: [{ id: "fixture", name: "Fixture", models: [MODELS.llama] }],
  });
  key = await h.fundedKey();
  other = await h.fundedKey();
  await h.ctx.db.insert(regionPolicy).values([
    { region: "NL", mode: "blocked" },
    { region: "US-NY", mode: "allowed", disclosureIntervalMin: 60 },
    { region: "US-WA", mode: "allowed", disclosureIntervalMin: 120 },
  ]);
});
afterAll(async () => h?.close());

test("migration seeds the existing lists", async () => {
  const rows = await h.ctx.db.select().from(regionPolicy);
  const modes = new Map(rows.map((row) => [row.region, row.mode]));
  const proofRegions = new Set<string>(DEFAULT_AGE_VERIFICATION_REGIONS);
  for (const code of DEFAULT_BLOCKED_REGIONS) expect(modes.get(code)).toBe(proofRegions.has(code) ? "proof_required" : "blocked");
  for (const code of DEFAULT_OFAC_REGIONS) expect(modes.get(code)).toBe("blocked");
});

test("a blocked region gets the region page before the floor or any provider", async () => {
  const floor = h.ctx.anonymo.floor;
  const reply = provider().cfg.reply;
  h.ctx.anonymo.floor = { check: async () => { throw new Error("floor must not run"); } };
  provider().cfg.reply = () => { throw new Error("provider must not run"); };
  const calls = provider().stats.requests;
  try {
    const res = await chat({ ...blockedHeaders, accept: "text/html", "x-anonymo-region": "NZ", "x-anonymo-declared-region": "NZ" });
    expect(res.status).toBe(451);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<h1>Anonymo is unavailable in this region</h1>");
    const declared = await chat({ "cf-ipcountry": "NZ", "x-anonymo-declared-region": "NL" });
    expect(declared.status).toBe(451);
    expect((await declared.json()).error.type).toBe("region_blocked");
    expect(provider().stats.requests).toBe(calls);
  } finally {
    h.ctx.anonymo.floor = floor;
    provider().cfg.reply = reply;
  }
});

test("proof-required access is bound to a key; raw proofs are discarded", async () => {
  const calls = provider().stats.requests;
  const denied = await chat(proofHeaders);
  expect(denied.status).toBe(451);
  expect((await denied.json()).error.type).toBe("age_proof_required");
  expect((await proof(fixture(key.hash))).status).toBe(503);
  expect(provider().stats.requests).toBe(calls);

  h.ctx.anonymo.ageProofVerifier = fixtureVerifier;
  expect((await proof(fixture(key.hash), other.auth)).status).toBe(422);
  expect(await h.ctx.db.select().from(ageProofs)).toEqual([]);

  const submissions = await Promise.all([proof(fixture(key.hash)), proof(fixture(other.hash), other.auth)]);
  expect(submissions.map((res) => res.status).sort()).toEqual([200, 409]);
  const [winner, loser] = submissions[0].ok ? [key, other] : [other, key];
  const [row] = await h.ctx.db.select().from(ageProofs);
  expect(row).toEqual({ nullifier, keyHash: Buffer.from(winner.hash, "hex"), verifiedAt: expect.any(Date) });
  expect((await proof(fixture(winner.hash), winner.auth)).status).toBe(200);
  expect(await h.ctx.db.select().from(ageProofs)).toEqual([row]);
  expect((await chat(proofHeaders, loser.auth)).status).toBe(451);
  expect((await chat(blockedHeaders, winner.auth)).status).toBe(451);
  expect(provider().stats.requests).toBe(calls);
  expect(await (await h.request(schedulePath, { headers: { ...proofHeaders, ...winner.auth } })).json()).toEqual({
    mode: "proof_required", access: true, disclosure_interval_min: null,
  });
  expect((await chat(proofHeaders, winner.auth)).status).toBe(200);
  expect(provider().stats.requests).toBe(calls + 1);
  const adapted = await h.request("/v1/responses", {
    method: "POST", headers: { ...proofHeaders, ...winner.auth }, json: { model: MODELS.llama.slug, input: "Hello" },
  });
  expect(adapted.status).toBe(200);
});

test("the schedule uses the shortest table interval across edge and declared regions", async () => {
  const res = await h.request(schedulePath, { headers: { "cf-ipcountry": "US", "cf-region-code": "WA", "x-anonymo-declared-region": "us-ny" } });
  expect(await res.json()).toEqual({ mode: "allowed", disclosure_interval_min: 60, access: true });
  expect(res.headers.get("cache-control")).toBe("no-store");
  await h.ctx.db.update(regionPolicy).set({ disclosureIntervalMin: 30 }).where(eq(regionPolicy.region, "US-WA"));
  expect((await (await h.request(schedulePath, { headers: { "cf-ipcountry": "US", "cf-region-code": "WA" } })).json()).disclosure_interval_min).toBe(30);
  expect((await (await h.request(schedulePath, { headers: { "cf-ipcountry": "US" } })).json()).mode).toBe("blocked");
});

test("explicit env lists override seeded and table decisions", async () => {
  const policyOf = createRegionPolicy(h.ctx.db, {
    ANONYMO_OFAC_REGIONS: "none", ANONYMO_REGION_BLOCKED: "NZ", ANONYMO_AGE_VERIFICATION_REGIONS: "NL",
  });
  expect((await policyOf("GB", null)).mode).toBe("allowed");
  expect((await policyOf("IR", null)).mode).toBe("allowed");
  expect((await policyOf("NL", null)).mode).toBe("proof_required");
  expect((await policyOf("NZ", "NL")).mode).toBe("blocked");
  const ofacWins = createRegionPolicy(h.ctx.db, { ANONYMO_AGE_VERIFICATION_REGIONS: "IR" });
  expect((await ofacWins("IR", null)).mode).toBe("blocked");
});

test("exit routes stay available and queued prompts cannot be submitted", async () => {
  const headers = { ...key.auth, ...blockedHeaders };
  expect((await h.request("/balance", { headers })).status).toBe(200);
  expect((await h.request("/withdrawals", { headers })).status).toBe(200);
  expect((await h.request("/withdraw", { method: "POST", headers, json: {} })).status).toBe(400);
  expect((await h.request("/api/v1/memory", { headers })).status).toBe(200);
  const batch = await h.request("/v1/batches", { method: "POST", headers: { ...key.auth, "cf-ipcountry": "NZ" }, json: {} });
  expect(batch.status).toBe(403);
  expect((await batch.json()).error.type).toBe("batches_unavailable");
});

test("compliance uses digests for ingress limits and skips response retention", async () => {
  const limiter = h.ctx.limiter;
  const observed: string[] = [];
  h.ctx.limiter = {
    take: (bucket, ...args) => { observed.push(bucket); return limiter.take(bucket, ...args); },
    close: () => limiter.close(),
  };
  try {
    const address = "192.0.2.7"; // gitleaks:allow
    const schedule = await h.request(schedulePath, { headers: { "cf-ipcountry": "NZ", "x-forwarded-for": address } });
    expect(schedule.status).toBe(200);
    expect(observed).toContain(`anon:${hmac(h.ctx.cfg.appSecret, `address-limit:${address}`)}`);
    expect(observed.every((bucket) => !bucket.includes(address))).toBe(true);
    const before = provider().stats.requests;
    for (let i = 0; i < 2; i++) {
      expect((await chat({ "cf-ipcountry": "NZ", "x-anonymo-cache": "exact" })).status).toBe(200);
    }
    expect(provider().stats.requests).toBe(before + 2);
    const recovering = await chat({ "cf-ipcountry": "NZ", "payment-recovery": "sample-signature" });
    expect((await recovering.json()).error.type).toBe("payment_recovery_unavailable");
    expect(provider().stats.requests).toBe(before + 2);
  } finally {
    h.ctx.limiter = limiter;
  }
});

test("production compliance requires an authenticated edge", () => {
  expect(() => loadConfig({ ANONYMO_ENV: "production", ANONYMO_FEATURE_COMPLIANCE: "true", ORIGIN_LOCK_ENABLED: "false" })).toThrow("needs ORIGIN_LOCK_ENABLED");
});

test("the flag defaults off and preserves the legacy region gate", async () => {
  const legacy = await startRouter();
  try {
    expect(legacy.ctx.cfg.features.compliance).toBe(false);
    expect((await legacy.request(schedulePath)).status).toBe(404);
    const res = await legacy.request("/v1/chat/completions", { method: "POST", headers: proofHeaders, json: body });
    expect(res.status).toBe(451);
    expect((await res.json()).error.type).toBe("region_blocked");
  } finally {
    await legacy.close();
  }
});
