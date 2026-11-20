// Hosted images: NanoGPT's image endpoint, and the hosted classifier pair (NanoGPT's NSFW check plus Llama Guard 4)
// that gates every image when no classifier service of our own is configured. Upstreams are doubles; no image is
// generated or classified for real here.
import { describe, expect, test } from "bun:test";
import { assertLicensed, MediaCatalog } from "../../src/anonymo/media/catalog.ts";
import { createMediaGate } from "../../src/anonymo/media/gate.ts";
import { hostedClassifier, hostedFrame, parseGuardVerdict } from "../../src/anonymo/media/hosted-classifier.ts";
import { decodePng } from "../../src/anonymo/media/png.ts";
import { classifierFromEnv } from "../../src/anonymo/media/services.ts";
import { nanogptAdapter, UpstreamError } from "../../src/anonymo/media/upstreams.ts";
import { loadConfig } from "../../src/config.ts";
import { solidPng, tinyMp4 } from "./fixtures.ts";

type Call = { url: string; init: RequestInit; body: any };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
function fakeFetch(answer: (url: string, body: any) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), init, body });
    return answer(String(url), body);
  }) as typeof fetch;
  return { f, calls };
}

const png = solidPng(4, 4, [10, 120, 200]);
const GUARD = { url: "https://guard.example/v1", model: "meta-llama/llama-guard-4-12b", apiKey: "guard-test-key" };
const NANO = { base: "https://nano.example/api/v1", apiKey: "nano-test-key" };
const guardSays = (content: string) => json({ choices: [{ message: { content } }] });
/** A classifier double over both hosted checks: `nsfw` is NanoGPT's answer, `guard` is Llama Guard's text. */
function classifierWith(nsfw: unknown, guard: string | Response) {
  return fakeFetch((url) => (url.includes("/api/nsfw/image") ? json({ has_nsfw_concepts: [nsfw], is_nsfw: nsfw === true }) : typeof guard === "string" ? guardSays(guard) : guard));
}

describe("Llama Guard answers", () => {
  test("safe, unsafe with categories, and anything else throws", () => {
    expect(parseGuardVerdict("\n\nsafe")).toEqual({ unsafe: false, categories: [] });
    expect(parseGuardVerdict("unsafe\nS12")).toEqual({ unsafe: true, categories: ["S12"] });
    expect(parseGuardVerdict("unsafe\nS1,S4")).toEqual({ unsafe: true, categories: ["S1", "S4"] });
    for (const bad of ["", "maybe", "unsafe", "unsafe\nsexual", "Safe", "safe-ish"]) expect(() => parseGuardVerdict(bad)).toThrow();
    expect(() => parseGuardVerdict(undefined)).toThrow();
    expect(() => parseGuardVerdict({ text: "safe" })).toThrow();
  });

  test("S4 is a minor, S3 and S12 or NanoGPT's yes are explicit, other categories pass", () => {
    const safe = { unsafe: false, categories: [] };
    expect(hostedFrame(false, safe)).toEqual({ nsfw: 0, apparentAge: null, realPerson: null });
    expect(hostedFrame(true, safe).nsfw).toBe(1);
    expect(hostedFrame(false, { unsafe: true, categories: ["S12"] }).nsfw).toBe(1);
    expect(hostedFrame(false, { unsafe: true, categories: ["S3"] }).nsfw).toBe(1);
    expect(hostedFrame(false, { unsafe: true, categories: ["S4"] })).toEqual({ nsfw: 1, apparentAge: 0, realPerson: null });
    expect(hostedFrame(false, { unsafe: true, categories: ["S1", "S9"] }).nsfw).toBe(0); // violence is allowed in images
  });
});

describe("hosted classifier", () => {
  test("sends the image as a data URL to both checks with their own keys", async () => {
    const { f, calls } = classifierWith(false, "safe");
    const r = await hostedClassifier({ nanogpt: NANO, guard: GUARD, fetch: f }).score(png, "image/png", { frames: 1 });
    expect(r.frames).toEqual([{ nsfw: 0, apparentAge: null, realPerson: null }]);
    const nsfw = calls.find((c) => c.url === "https://nano.example/api/nsfw/image")!;
    const guard = calls.find((c) => c.url === "https://guard.example/v1/chat/completions")!;
    const dataUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
    expect(nsfw.body).toEqual({ imageDataUrl: dataUrl });
    expect((nsfw.init.headers as Record<string, string>)["x-api-key"]).toBe("nano-test-key");
    expect(guard.body.model).toBe("meta-llama/llama-guard-4-12b");
    expect(guard.body.messages[0].content[1]).toEqual({ type: "image_url", image_url: { url: dataUrl } });
    expect((guard.init.headers as Record<string, string>).authorization).toBe("Bearer guard-test-key");
  });

  test("the gate blocks what either check flags, and fails closed on any error or odd answer", async () => {
    const gate = (nsfw: unknown, guard: string | Response) => createMediaGate(hostedClassifier({ nanogpt: NANO, guard: GUARD, fetch: classifierWith(nsfw, guard).f }));
    const opts = { explicitAllowed: false };
    expect(await gate(false, "safe").assess(png, "image/png", opts)).toEqual({ ok: true, explicit: false });
    expect(await gate(true, "safe").assess(png, "image/png", opts)).toEqual({ ok: false, reason: "explicit" });
    expect(await gate(false, "unsafe\nS12").assess(png, "image/png", opts)).toEqual({ ok: false, reason: "explicit" });
    expect(await gate(false, "unsafe\nS4").assess(png, "image/png", opts)).toEqual({ ok: false, reason: "nsfw_minor" });
    expect(await gate(true, "unsafe\nS4,S12").assess(png, "image/png", opts)).toEqual({ ok: false, reason: "nsfw_minor" });
    expect(await gate(false, "unsafe\nS1").assess(png, "image/png", opts)).toEqual({ ok: true, explicit: false });
    for (const [nsfw, guard] of [
      ["no", "safe"],
      [null, "safe"],
      [false, "I cannot help with that"],
      [false, json({ error: "down" }, 500)],
      [false, json({ choices: [] })],
    ] as const)
      expect(await gate(nsfw, guard).assess(png, "image/png", opts)).toEqual({ ok: false, reason: "unscored" });
    const nsfwDown = fakeFetch((url) => (url.includes("/api/nsfw/image") ? json({ error: "x" }, 503) : guardSays("safe")));
    expect(await createMediaGate(hostedClassifier({ nanogpt: NANO, guard: GUARD, fetch: nsfwDown.f })).assess(png, "image/png", opts)).toEqual({ ok: false, reason: "unscored" });
  });

  test("checks images only: a video is never scored, so never served", async () => {
    const { f, calls } = classifierWith(false, "safe");
    const gate = createMediaGate(hostedClassifier({ nanogpt: NANO, guard: GUARD, fetch: f }));
    expect(await gate.assess(tinyMp4(), "video/mp4", { explicitAllowed: false })).toEqual({ ok: false, reason: "unscored" });
    expect(calls).toHaveLength(0);
  });

  test("from the environment: our own service first, the hosted pair only with both keys, else nothing passes", async () => {
    await expect(classifierFromEnv({}).score(png, "image/png", { frames: 1 })).rejects.toThrow(/not configured/);
    await expect(classifierFromEnv({ ANONYMO_NANOGPT_API_KEY: "k" }).score(png, "image/png", { frames: 1 })).rejects.toThrow(/not configured/);
    await expect(classifierFromEnv({ ANONYMO_MEDIA_GUARD_KEY: "k" }).score(png, "image/png", { frames: 1 })).rejects.toThrow(/not configured/);
    await expect(classifierFromEnv({ ANONYMO_NANOGPT_API_KEY: "k", ANONYMO_MEDIA_GUARD_KEY: "k" }).score(tinyMp4(), "video/mp4", { frames: 8 })).rejects.toThrow(/images only/);
  });
});

describe("NanoGPT images", () => {
  const b64 = Buffer.from(png).toString("base64");
  const adapter = (answer: (url: string, body: any) => Response) => {
    const ff = fakeFetch(answer);
    return { up: nanogptAdapter({ ...NANO, fetch: ff.f }), calls: ff.calls };
  };
  const req = (model: string, width = 1024, height = 1024, n = 1) => ({ model, prompt: "a lighthouse", n, width, height, seed: 1, safe: true });
  const signal = new AbortController().signal;

  test("maps caller dimensions to each model's request format", async () => {
    const cases = [
      [req("nano-banana", 1344, 768), { aspect_ratio: "16:9" }],
      [req("gpt-image-2", 1536, 1024), { size: "1536x1024" }],
      [req("flux-2-max"), { size: "1024*1024" }],
      [req("flux-2-flash", 720, 1280), { size: "720*1280" }],
      [req("ideogram/v4.5", 1280, 720, 8), { size: "1280x720" }],
      [req("recraft-ai/recraft-v4.1/text-to-image", 576, 1024, 8), { size: "576x1024", enable_safety_checker: true }],
      [req("krea/v2/medium/text-to-image", 1280, 720), { aspect_ratio: "16:9" }],
      [req("xai/grok-imagine-image/v2.0/text-to-image", 720, 1280), { aspect_ratio: "9:16", resolution: "1k", output_format: "png" }],
    ] as const;
    for (const [request, sizing] of cases) {
      const { up, calls } = adapter(() => json({ data: Array.from({ length: request.n }, () => ({ b64_json: b64 })) }));
      const output = await up.generate(request, signal);
      expect(output).toHaveLength(request.n);
      expect(output[0]).toEqual({ mime: "image/png", bytes: png });
      expect(calls[0].url).toBe("https://nano.example/api/v1/images/generations");
      expect(calls[0].body).toEqual({ model: request.model, prompt: request.prompt, n: request.n, response_format: "b64_json", ...sizing });
      expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer nano-test-key");
    }
  });

  test("rejects an unsupported size and an oversized batch before calling NanoGPT", async () => {
    const { up, calls } = adapter(() => json({}));
    await expect(up.generate(req("flux-2-max", 1024, 1024, 5), signal)).rejects.toMatchObject({ status: 400, rejected: true });
    await expect(up.generate(req("ideogram/v4.5", 1024, 1024, 9), signal)).rejects.toMatchObject({ status: 400, rejected: true });
    await expect(up.generate(req("krea/v2/medium/text-to-image", 1111, 2222), signal)).rejects.toMatchObject({ status: 400, rejected: true });
    expect(calls).toHaveLength(0);
  });

  test("normalizes inline JPEG and WebP to a PNG the provenance code can decode", async () => {
    for (const encoded of [new Bun.Image(png).jpeg(), new Bun.Image(png).webp()]) {
      const inline = Buffer.from(await encoded.bytes()).toString("base64");
      const { up } = adapter(() => json({ data: [{ b64_json: inline }] }));
      const [img] = await up.generate(req("flux-2-max"), signal);
      expect(img.mime).toBe("image/png");
      expect(decodePng(img.bytes)).toMatchObject({ width: 4, height: 4 });
    }
  });

  test("never fetches a URL from the answer, and a short batch is an error", async () => {
    const { up, calls } = adapter(() => json({ data: [{ url: "https://elsewhere.example/x.png" }] }));
    await expect(up.generate(req("gpt-image-2"), signal)).rejects.toThrow(UpstreamError);
    expect(calls).toHaveLength(1);
    const short = adapter(() => json({ data: [{ b64_json: b64 }] }));
    await expect(short.up.generate(req("gpt-image-2", 1024, 1024, 2), signal)).rejects.toThrow(/wrong number of images/);
  });

  test("errors: a refused prompt is a rejection, auth or credit problems mean unavailable, edits are not wired", async () => {
    const at = async (status: number) => adapter(() => json({ error: { code: "x" } }, status)).up.generate(req("gpt-image-2"), signal).catch((e) => e as UpstreamError);
    expect(await at(400)).toMatchObject({ status: 502, rejected: true });
    expect(await at(401)).toMatchObject({ status: 503, rejected: false });
    expect(await at(402)).toMatchObject({ status: 503 });
    expect(await at(500)).toMatchObject({ status: 503 });
    const { up, calls } = adapter(() => json({}));
    await expect(up.generate({ ...req("nano-banana"), image: { bytes: png, mime: "image/png" } }, signal)).rejects.toMatchObject({ rejected: true });
    expect(calls).toHaveLength(0);
  });
});

describe("NanoGPT models in the catalog", () => {
  const models = [
    ["google/nano-banana", "nano-banana", "0.050", "NANO_BANANA", 4],
    ["openai/gpt-image-2", "gpt-image-2", "0.080", "GPT_IMAGE_2", 4],
    ["bfl/flux.2-max", "flux-2-max", "0.090", "FLUX_2_MAX", 4],
    ["bfl/flux.2-flash", "flux-2-flash", "0.032", "FLUX_2_FLASH", 4],
    ["ideogram/v4.5", "ideogram/v4.5", "0.076", "IDEOGRAM_V4_5", 8],
    ["recraft/v4.1", "recraft-ai/recraft-v4.1/text-to-image", "0.050", "RECRAFT_V4_1", 8],
    ["krea/krea-2-medium", "krea/v2/medium/text-to-image", "0.038", "KREA_2_MEDIUM", 4],
    ["xai/grok-imagine-2", "xai/grok-imagine-image/v2.0/text-to-image", "0.076", "GROK_IMAGINE_2", 4],
  ] as const;
  const env = { ANONYMO_NANOGPT_API_KEY: "test-key" };

  test("all eight appear with a key and none appear without one", () => {
    for (const missing of [{}, { ANONYMO_NANOGPT_API_KEY: " " }]) {
      expect(MediaCatalog.fromEnv(missing).models.filter((m) => m.upstream === "nanogpt")).toEqual([]);
    }
    const c = MediaCatalog.fromEnv(env);
    expect(c.models.filter((m) => m.upstream === "nanogpt" && m.kind === "image").map((m) => m.id)).toEqual(models.map(([id]) => id));
    for (const [id, upstreamModel, usdPerImage, , maxImages] of models) {
      expect(c.get("image", id)).toMatchObject({ upstream: "nanogpt", upstreamModel, usdPerImage, maxImages, edit: false, defaultSize: "1024x1024" });
      expect(c.get("image", id)?.sizes.every((size) => /^\d+x\d+$/.test(size))).toBe(true);
    }
    const relabelled = { ...c.get("image", "google/nano-banana")!, id: "anonymo-image" };
    expect(() => assertLicensed(relabelled)).toThrow(/maker's prefix/);
    expect(() => assertLicensed({ ...c.get("image", "bfl/flux.2-max")!, upstreamModel: "flux-2-dev" })).toThrow(/FLUX/);
  });

  test("each price override is validated and affects only its own model", () => {
    for (const [id, , , suffix] of models) {
      const key = "ANONYMO_NANOGPT_IMAGE_USD_" + suffix;
      const c = MediaCatalog.fromEnv({ ...env, [key]: " 0.123456 " });
      for (const [otherId, , defaultUsd] of models) {
        expect(c.get("image", otherId)?.usdPerImage).toBe(otherId === id ? "0.123456" : defaultUsd);
      }
      expect(() => MediaCatalog.fromEnv({ ...env, [key]: "free" })).toThrow(/dollar amount/);
    }
  });
});

describe("production needs a classifier before media can be switched on", () => {
  const prod = { ANONYMO_ENV: "production", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", ANONYMO_FEATURE_MEDIA: "true" };
  const mediaError = (extra: Record<string, string>) => {
    try {
      loadConfig({ ...prod, ...extra });
      return null;
    } catch (e) {
      return /ANONYMO_FEATURE_MEDIA needs/.test(String(e)) ? "media" : "other";
    }
  };
  test("no classifier, or only one of the hosted keys, refuses to start", () => {
    expect(mediaError({})).toBe("media");
    expect(mediaError({ ANONYMO_NANOGPT_API_KEY: "k" })).toBe("media");
    expect(mediaError({ ANONYMO_MEDIA_GUARD_KEY: "k" })).toBe("media");
  });
  test("our own classifier service, or both hosted keys, pass this check", () => {
    expect(mediaError({ ANONYMO_MEDIA_CLASSIFIER_URL: "https://classifier.example" })).not.toBe("media");
    expect(mediaError({ ANONYMO_NANOGPT_API_KEY: "k", ANONYMO_MEDIA_GUARD_KEY: "k" })).not.toBe("media");
  });
});
