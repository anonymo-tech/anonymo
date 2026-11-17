// WS02: the floor-hit log, the upload rule and region rules.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { FloorHitLog } from "../../src/anonymo/floor/hits.ts";
import { createUploadRule, sha256Hex, stubCsamHashClient, type HashBlocklist, type Upload } from "../../src/anonymo/floor/uploads.ts";
import { createRegionRules, DEFAULT_AGE_VERIFICATION_REGIONS, DEFAULT_BLOCKED_REGIONS, DEFAULT_OFAC_REGIONS, parseRegion, regionConfigFromEnv, regionRulesFromEnv } from "../../src/anonymo/region/rules.ts";
import { regionCodeOf, regionMiddleware } from "../../src/anonymo/region/middleware.ts";
import type { FloorCategory } from "../../src/anonymo/seams.ts";

describe("floor hit log", () => {
  const input = { text: "PROMPT-CANARY-hits", modality: "text" as const, hasUpload: false };

  test("keeps a minimal record with a hash, never the text, and hands it over once", () => {
    const log = new FloorHitLog();
    const s = log.record(input, "cbrn", "model");
    expect(JSON.stringify(log.list())).not.toContain("PROMPT-CANARY");
    const rec = log.take(s.id)!;
    expect(rec.textSha256).toBe(sha256Hex(new TextEncoder().encode(input.text)));
    expect(rec.textLength).toBe(input.text.length);
    expect(JSON.stringify(rec)).not.toContain("PROMPT-CANARY");
    expect(log.take(s.id)).toBeNull();
  });

  test("unreported hits expire after the TTL, and the log is bounded", () => {
    let t = 1_000_000;
    const log = new FloorHitLog(60_000, 3, () => t);
    const a = log.record(input, "minor", "prefilter");
    t += 59_000;
    expect(log.list().map((h) => h.id)).toEqual([a.id]);
    t += 2_000;
    expect(log.size).toBe(0);
    expect(log.take(a.id)).toBeNull();
    for (let i = 0; i < 5; i++) log.record(input, "minor", "model");
    expect(log.size).toBe(3);
  });
});

describe("upload rule", () => {
  const blocked = new Map<string, FloorCategory>();
  const blocklist: HashBlocklist = { lookup: async (h) => blocked.get(h) ?? null };
  const csamHits = new Set<string>();
  const rule = createUploadRule({ blocklist, csam: { match: async (u) => ({ matched: csamHits.has(sha256Hex(u.bytes)) }) } });
  const bytes = (s: string) => new TextEncoder().encode(s);
  const up = (over: Partial<Upload>): Upload => ({ workflow: "other", nsfw: false, kind: "image", mime: "image/png", bytes: bytes("img"), ...over });

  test("no photo uploads to NSFW image or video workflows", async () => {
    for (const workflow of ["image_generation", "image_edit", "video_generation"] as const)
      for (const kind of ["image", "video"] as const) expect(await rule.check(up({ workflow, kind, nsfw: true }))).toMatchObject({ ok: false, category: "real_person", reason: "photo_to_nsfw" });
    expect(await rule.check(up({ workflow: "image_edit", kind: "file", mime: "image/jpeg", nsfw: true }))).toMatchObject({ ok: false, reason: "photo_to_nsfw" }); // by MIME
    expect((await rule.check(up({ workflow: "image_edit", nsfw: false }))).ok).toBe(true); // a forced-SFW edit is hash-matched instead
  });

  test("no voice uploads for cloning or speech", async () => {
    for (const workflow of ["speech", "voice_clone", "video_generation"] as const)
      expect(await rule.check(up({ workflow, kind: "audio", mime: "audio/wav" }))).toMatchObject({ ok: false, category: "voice_clone", reason: "voice_upload" });
    expect((await rule.check(up({ workflow: "chat", kind: "audio", mime: "audio/wav" }))).ok).toBe(true);
  });

  test("other uploads are hash-matched against the block list and the CSAM hash service", async () => {
    blocked.set(sha256Hex(bytes("taken-down")), "real_person");
    csamHits.add(sha256Hex(bytes("known-hash")));
    expect(await rule.check(up({ workflow: "chat", bytes: bytes("taken-down") }))).toMatchObject({ ok: false, category: "real_person", reason: "blocked_hash" });
    expect(await rule.check(up({ workflow: "chat", kind: "file", mime: "application/pdf", bytes: bytes("taken-down") }))).toMatchObject({ ok: false, reason: "blocked_hash" });
    expect(await rule.check(up({ workflow: "chat", bytes: bytes("known-hash") }))).toMatchObject({ ok: false, category: "minor", reason: "csam_hash_match" });
    expect(await rule.check(up({ workflow: "chat", bytes: bytes("fine") }))).toEqual({ ok: true, sha256: sha256Hex(bytes("fine")) });
  });

  test("the CSAM hash stub fails closed when required, and a failing service refuses the upload", async () => {
    await expect(stubCsamHashClient(true).match({ bytes: bytes("x"), mime: "image/png" })).rejects.toThrow();
    expect(await stubCsamHashClient(false).match({ bytes: bytes("x"), mime: "image/png" })).toEqual({ matched: false });
    const failing = createUploadRule({ blocklist, csam: stubCsamHashClient(true) });
    await expect(failing.check(up({ workflow: "chat" }))).rejects.toThrow();
  });
});

describe("region rules", () => {
  const rules = createRegionRules(regionConfigFromEnv({}));

  test("blocks OFAC regions, including occupied subdivisions", () => {
    for (const c of ["IR", "KP", "CU", "UA-43", "ua-14", "UA-09"]) expect(rules.forCountry(c), c).toEqual({ blocked: true, explicitMediaAllowed: false });
    expect(rules.forCountry("UA").blocked).toBe(false);
    expect(rules.forCountry("UA-30").blocked).toBe(false);
    for (const c of DEFAULT_OFAC_REGIONS) expect(rules.forCountry(c).blocked).toBe(true);
  });

  test("by default, with no age verification, every region whose rules plausibly reach adult text is blocked outright", () => {
    for (const c of ["GB", "FR", "DE", "AU", "BR", "RU", "SA", "IN", "CN", "US-TX", "US-IA", "US-WV", "US-CA", "US-CO"]) expect(rules.forCountry(c), c).toEqual({ blocked: true, explicitMediaAllowed: false });
    expect(rules.forCountry("US")).toEqual({ blocked: true, explicitMediaAllowed: false }); // state unknown: fail closed
    for (const c of ["US-NY", "US-WA", "NL", "ES", "CA", "JP", "MX", "IT"]) expect(rules.forCountry(c).blocked, c).toBe(false);
    for (const c of DEFAULT_BLOCKED_REGIONS) expect(rules.forCountry(c).blocked, c).toBe(true);
    // Every age-verification region is also blocked: switching images off does nothing for text.
    for (const c of DEFAULT_AGE_VERIFICATION_REGIONS) expect(rules.forCountry(c), c).toEqual({ blocked: true, explicitMediaAllowed: false });
  });

  test("with the legal list turned off, age-verification regions keep text and lose explicit media", () => {
    const av = regionRulesFromEnv({ ANONYMO_REGION_BLOCKED: "none" });
    expect(av.forCountry("GB")).toEqual({ blocked: false, explicitMediaAllowed: false });
    expect(av.forCountry("US-TX")).toEqual({ blocked: false, explicitMediaAllowed: false });
    expect(av.forCountry("US-CA")).toEqual({ blocked: false, explicitMediaAllowed: true });
    expect(av.forCountry("US")).toEqual({ blocked: false, explicitMediaAllowed: false });
    expect(av.forCountry("IR").blocked).toBe(true); // sanctions stay
  });

  test("an unknown region restricts explicit media by default, and garbage never parses as a region", () => {
    for (const c of [null, "", "XX", "T1", "1.2.3.4", "USA", "u", "US-TEXAS"]) expect(rules.forCountry(c), String(c)).toEqual({ blocked: false, explicitMediaAllowed: false });
    expect(regionRulesFromEnv({ ANONYMO_REGION_UNKNOWN: "allow" }).forCountry(null).explicitMediaAllowed).toBe(true);
    // Production blocks an unknown region (no header, Tor) unless told otherwise.
    const prod = regionRulesFromEnv({ ANONYMO_ENV: "production" });
    for (const c of [null, "XX", "T1"]) expect(prod.forCountry(c), String(c)).toEqual({ blocked: true, explicitMediaAllowed: false });
    expect(regionRulesFromEnv({ ANONYMO_ENV: "production", ANONYMO_REGION_UNKNOWN_TEXT: "allow" }).forCountry("T1").blocked).toBe(false);
    expect(() => regionConfigFromEnv({ ANONYMO_REGION_UNKNOWN_TEXT: "maybe" })).toThrow();
    expect(parseRegion("203.0.113.9")).toBeNull();
  });

  test("lists are configurable and validated", () => {
    const custom = regionRulesFromEnv({ ANONYMO_OFAC_REGIONS: "ru", ANONYMO_REGION_BLOCKED: "none", ANONYMO_AGE_VERIFICATION_REGIONS: "FR, US-CA" });
    expect(custom.forCountry("RU").blocked).toBe(true);
    expect(custom.forCountry("IR").blocked).toBe(false);
    expect(custom.forCountry("FR").explicitMediaAllowed).toBe(false);
    expect(custom.forCountry("GB").explicitMediaAllowed).toBe(true);
    expect(custom.forCountry("US-TX").explicitMediaAllowed).toBe(true);
    expect(() => regionConfigFromEnv({ ANONYMO_OFAC_REGIONS: "Iran" })).toThrow();
    expect(() => regionConfigFromEnv({ ANONYMO_REGION_UNKNOWN: "maybe" })).toThrow();
  });

  test("the middleware reads only region headers and refuses blocked regions with 451", async () => {
    const app = new Hono();
    app.use("*", regionMiddleware(rules));
    app.get("/x", (c) => c.text("ok"));
    const get = (headers: Record<string, string>) => app.request("/x", { headers });
    const blockedRes = await get({ "cf-ipcountry": "IR", "x-forwarded-for": "203.0.113.9" });
    expect(blockedRes.status).toBe(451);
    expect(((await blockedRes.json()) as { error: { type: string } }).error.type).toBe("region_blocked");
    expect((await get({ "cf-ipcountry": "UA", "cf-region-code": "43" })).status).toBe(451);
    expect((await get({ "x-anonymo-region": "UA-43" })).status).toBe(451);
    expect((await get({ "cf-ipcountry": "GB" })).status).toBe(451);
    expect((await get({ "cf-ipcountry": "NL" })).status).toBe(200);
    expect((await get({})).status).toBe(200);
    expect(regionCodeOf(new Headers({ "cf-ipcountry": "US", "cf-region-code": "TX" }))).toBe("US-TX");
    expect(regionCodeOf(new Headers({ "cf-ipcountry": "US", "cf-region-code": "../x" }))).toBe("US");
  });
});
