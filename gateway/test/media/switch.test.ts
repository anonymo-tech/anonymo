// Media (images, voice, video) is off unless ANONYMO_FEATURE_MEDIA turns it on, and production never serves it without
// the classifier that checks every output (src/config.ts, src/anonymo/routes.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config.ts";
import { startRouter, type Harness } from "../helpers.ts";

describe("media switch", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter();
  });
  afterAll(async () => h?.close());

  test("by default no media route exists: image, speech and video requests and the model list are 404", async () => {
    const k = await h.fundedKey(1n);
    for (const path of ["/v1/images/generations", "/v1/images/edits", "/v1/audio/speech", "/v1/video/generations", "/api/v1/images/generations"]) {
      const r = await h.request(path, { method: "POST", headers: k.auth, json: { model: "chroma", prompt: "a lighthouse", input: "hi" } });
      expect(r.status, path).toBe(404);
    }
    expect((await h.request("/v1/media/models")).status).toBe(404);
    expect(h.ctx.cfg.features.media).toBe(false);
  });

  test("production refuses to start with media on and no media classifier", () => {
    const prod = { ANONYMO_ENV: "production", APP_SECRET: "x".repeat(40), ADMIN_TOKEN: "y".repeat(30), ANONYMO_FEATURE_MEDIA: "true" };
    expect(() => loadConfig({ ...prod })).toThrow(/ANONYMO_MEDIA_CLASSIFIER_URL/);
    let err: unknown = null;
    try {
      loadConfig({ ...prod, ANONYMO_MEDIA_CLASSIFIER_URL: "https://media-gate.example.invalid" });
    } catch (e) {
      err = e;
    }
    // Other production requirements may still fail, but never this one.
    expect(String(err ?? "")).not.toContain("ANONYMO_MEDIA_CLASSIFIER_URL");
  });
});
