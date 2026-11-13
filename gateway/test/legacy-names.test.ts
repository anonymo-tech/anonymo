import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { generateApiKey, KEY_RE } from "../src/chain/keys.ts";
import { LEGACY_HEADER_WARNING, withLegacyEnv } from "../src/lib/legacy-names.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";

// WS01 rebrand: the new names are what the router reads and sends; the Anonymo names still work for one release
// (docs/rebrand.md).

describe("renamed settings", () => {
  test("ANONYMO_* settings are read as ANONYMO_*, and the new name wins when both are set", () => {
    expect(loadConfig({ ANONYMO_ENV: "test", ANONYMO_FEATURE_COUNCIL: "false" }).features.council).toBe(false);
    expect(loadConfig({ ANONYMO_ENV: "test", ANONYMO_FEATURE_COUNCIL: "false", ANONYMO_FEATURE_COUNCIL: "true" }).features.council).toBe(true);
    expect(withLegacyEnv({ ANONYMO_COUNCIL_MODE: "fuse" })).toEqual({ ANONYMO_COUNCIL_MODE: "fuse", ANONYMO_COUNCIL_MODE: "fuse" });
    const untouched = { ANONYMO_ENV: "test" };
    expect(withLegacyEnv(untouched)).toBe(untouched);
  });

  test("council mode is on by default (WS09)", () => {
    expect(loadConfig({ ANONYMO_ENV: "test" }).features.council).toBe(true);
  });
});

describe("API keys", () => {
  test("new keys start with anm_live_; keys minted before the rebrand are still valid", () => {
    const key = generateApiKey();
    expect(key).toMatch(/^anm_live_[0-9a-f]{64}$/);
    expect(KEY_RE.test(key)).toBe(true);
    expect(KEY_RE.test("sk-ar-v1-" + "ab".repeat(32))).toBe(true);
  });
});

describe("against a running router", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter();
  });
  afterAll(async () => h?.close());

  test("the key endpoint mints anm_live_ keys", async () => {
    const k = await h.newKey();
    expect(k.secret.startsWith("anm_live_")).toBe(true);
  });

  test("an x-anonymo-* request header is read as x-anonymo-* and the response says it is deprecated", async () => {
    const k = await h.fundedKey(1n);
    const chat = { model: MODELS.llama.slug, messages: [{ role: "user", content: "hi" }], max_tokens: 8 };
    const bad = await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...k.auth, "x-anonymo-lane": "not-a-lane" }, json: chat });
    expect(bad.status).toBe(400);
    const ok = await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...k.auth, "x-anonymo-lane": "public" }, json: chat });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-anonymo-lane")).toBe("public");
    expect(ok.headers.get("x-anonymo-lane")).toBeNull();
    expect(ok.headers.get("warning")).toBe(LEGACY_HEADER_WARNING);
    // The new name wins when a request sends both.
    const both = await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...k.auth, "x-anonymo-lane": "public", "x-anonymo-lane": "not-a-lane" }, json: chat });
    expect(both.status).toBe(200);
    const plain = await h.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: chat });
    expect(plain.headers.get("warning")).toBeNull();
  });

  test("chat answers on /v1 and /api/v1 alike", async () => {
    const k = await h.fundedKey(1n);
    for (const path of ["/v1/chat/completions", "/api/v1/chat/completions"]) {
      const r = await h.request(path, { method: "POST", headers: k.auth, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "hi" }], max_tokens: 8 } });
      expect(r.status, path).toBe(200);
    }
    for (const path of ["/v1/models", "/api/v1/models"]) expect((await h.request(path)).status, path).toBe(200);
  });

  test("the receipt keys are published under the new and the old well-known path", async () => {
    const a = await (await h.request("/.well-known/anonymo-receipt-keys.json")).json();
    const b = await (await h.request("/.well-known/anonymo-receipt-keys.json")).json();
    expect(a.keys.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });
});
