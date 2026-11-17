import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { MODELS, startRouter, type Harness } from "./helpers.ts";

// WS01: the end-to-end-encrypted chat lane (Anonymo's e2ee/ and api/e2ee.ts) is gone. On that lane the router saw only
// ciphertext, so the Anonymo floor gate could not check the prompt. Nothing may bring it back by configuration, and the
// x-e2ee-* headers must not switch a request onto any other path: a chat call that carries them is an ordinary, readable
// chat call and goes through the floor gate like every other.

const E2EE_PATHS = ["/api/v1/e2ee/chat/completions", "/v1/e2ee/chat/completions", "/api/v1/e2ee/attestation", "/api/v1/e2ee/receipts/r1", "/api/v1/e2ee/sessions/s1"];
const E2EE_HEADERS = { "x-e2ee-version": "2", "x-client-pub-key": "ab".repeat(32), "x-model-pub-key": "cd".repeat(32), "x-e2ee-nonce": "ef".repeat(16), "x-e2ee-timestamp": "1" };

describe("the end-to-end-encrypted lane is unreachable", () => {
  let h: Harness;
  let floorCalls = 0;
  beforeAll(async () => {
    // Even with the switch the removed lane used to read, no route exists.
    h = await startRouter({ env: { E2EE_PASSTHROUGH_ENABLED: "true", E2EE_GATEWAY_BASE_URL: "https://gateway.example/v1" } });
    const floor = h.ctx.anonymo.floor;
    h.ctx.anonymo.floor = { ...floor, check: async (input) => { if (input.stage !== "reply") floorCalls++; return floor.check(input); } };
  });
  afterAll(async () => h?.close());

  test("its source is gone", () => {
    for (const f of ["src/e2ee", "src/api/e2ee.ts"]) expect(existsSync(resolve(import.meta.dir, "..", f)), f).toBe(false);
  });

  test("every e2ee route answers 404 and nothing is held or sent", async () => {
    const k = await h.fundedKey(1n);
    for (const path of E2EE_PATHS) {
      const post = path.endsWith("/chat/completions");
      const r = await h.request(path, { method: post ? "POST" : "GET", headers: { ...k.auth, ...E2EE_HEADERS }, ...(post ? { json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "sealed" }] } } : {}) });
      expect(r.status, path).toBe(404);
      expect((await r.json()).error.type).toBe("not_found");
    }
  });

  test("x-e2ee-* headers on a normal chat call change nothing: the prompt is plain text and the floor gate reads it", async () => {
    const k = await h.fundedKey(1n);
    const before = floorCalls;
    const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...k.auth, ...E2EE_HEADERS }, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "hello" }], max_tokens: 8 } });
    expect(r.status).toBe(200);
    expect(floorCalls).toBe(before + 1);
    for (const h2 of ["x-e2ee-applied", "x-e2ee-version", "x-e2ee-algo", "x-e2ee-receipt-id"]) expect(r.headers.get(h2)).toBeNull();
  });

  test("browsers are no longer told they may send or read the e2ee headers", async () => {
    const pre = await h.request("/api/v1/chat/completions", { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST", "access-control-request-headers": "x-e2ee-version" } });
    const allowed = (pre.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allowed).not.toContain("x-e2ee");
    const r = await h.request("/api/v1/models", { headers: { origin: "https://app.example" } });
    expect((r.headers.get("access-control-expose-headers") ?? "").toLowerCase()).not.toContain("x-e2ee");
  });
});
