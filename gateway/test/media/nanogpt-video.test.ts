import { expect, spyOn, test } from "bun:test";
import { log } from "../../src/lib/util.ts";
import { readFileSync } from "node:fs";
import { concatBytes, te, u32be } from "../../src/anonymo/media/bytes.ts";
import { MediaCatalog } from "../../src/anonymo/media/catalog.ts";
import { isSilentMp4 } from "../../src/anonymo/media/containers.ts";
import { VideoSubmissionDeclined } from "../../src/anonymo/media/upstreams.ts";
import { nanogptVideoAdapter } from "../../src/anonymo/media/nanogpt-video.ts";
import { buildMediaServices } from "../../src/anonymo/media/services.ts";

const key = "fixture-key";
const base = "https://provider.example/api/v1";
const signal = new AbortController().signal;
const ref = "vid_fixture_123";
const clipUrl = "https://storage.example/clip.mp4?signature=sample";
const box = (type: string, data: Uint8Array) => concatBytes([u32be(data.length + 8), te.encode(type), data]);
const track = (kind: string) => box("trak", box("mdia", box("hdlr", concatBytes([new Uint8Array(8), te.encode(kind), new Uint8Array(12)]))));
const videoBytes = (audio = false) => concatBytes([box("ftyp", te.encode("isom")), box("moov", audio ? concatBytes([track("vide"), track("soun")]) : track("vide")), box("mdat", new Uint8Array(8))]);
const completed = (url = clipUrl) => Response.json({ data: { status: "COMPLETED", output: { video: { url } }, cost: 123 } });
const req = { prompt: "An abstract ribbon of light", width: 720, height: 1280, seed: 19, safe: true };

test("NanoGPT video catalog is key-gated with five independently overridable 720p prices", () => {
  const baseEnv = { ANONYMO_NANOGPT_API_KEY: key };
  expect(MediaCatalog.fromEnv({}).models.filter((m) => m.upstream === "nanogpt")).toEqual([]);
  const s = buildMediaServices({ cfg: { appSecret: "fixture".repeat(8) } } as Parameters<typeof buildMediaServices>[0], baseEnv);
  expect(s.video.nanogpt).toBeDefined();
  const video = s.catalog.models.filter((m) => m.kind === "video" && m.upstream === "nanogpt");
  expect(video.map((m) => [m.id, m.usdPerSecond])).toEqual([
    ["alibaba/wan-3.0", "0.125"], ["kling/kling-3.0-turbo", "0.140"], ["bytedance/seedance-2.0-fast", "0.150"],
    ["google/veo-3.1-lite", "0.065"], ["lightricks/ltx-2.3-fast", "0.040"],
  ]);
  expect(video.every((m) => m.license === "provider-terms" && m.sizes.join() === "1280x720,720x1280")).toBe(true);
  const custom = MediaCatalog.fromEnv({ ...baseEnv, ANONYMO_NANOGPT_VIDEO_USD_LTX_2_3_FAST: "0.055" });
  expect(custom.get("video", "lightricks/ltx-2.3-fast")?.usdPerSecond).toBe("0.055");
  expect(() => MediaCatalog.fromEnv({ ...baseEnv, ANONYMO_NANOGPT_VIDEO_USD_WAN_3_0: "free" })).toThrow("must be a dollar amount");
});

test("NanoGPT submit maps the five text-only requests and disables the documented audio switches", async () => {
  const bodies: unknown[] = [];
  const fake = (async (url, init) => {
    expect(String(url)).toBe("https://provider.example/api/generate-video");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("x-api-key")).toBe(key);
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json(bodies.length === 2 ? { id: ref } : { runId: ref, status: "pending" }, { status: 202 });
  }) as typeof fetch;
  const adapter = nanogptVideoAdapter({ base, apiKey: key, fetch: fake });
  const cases = [
    ["alibaba/wan-3.0/text-to-video", 5, { duration: 5, seed: 19, enable_audio: false }],
    ["kling-v3-turbo-standard", 7, { duration: "7" }],
    ["bytedance-seedance-2-0-fast", 10, { duration: "10" }],
    ["veo3-1-lite-video", 4, { duration: "4" }],
    ["lightricks/ltx-2.3/fast", 12, { duration: "12", generateAudio: false }],
  ] as const;
  for (const [model, seconds] of cases) expect(await adapter.submit({ ...req, model, seconds }, signal)).toBe(ref);
  expect(bodies).toEqual(cases.map(([model, , params]) => ({
    model, prompt: req.prompt, mode: "text-to-video", aspect_ratio: "9:16", resolution: "720p", showExplicitContent: false, ...params,
  })));
});

test("NanoGPT polling maps queue, completion, cancellation and content blocks and fetches the MP4 without API credentials", async () => {
  const responses = [
    Response.json({ data: { status: "IN_QUEUE" } }),
    Response.json({ data: { status: "IN_PROGRESS" } }),
    completed(),
    Response.json({ data: { status: "CANCELED" } }),
    Response.json({ data: { status: "FAILED", isNSFWError: true } }),
  ];
  const bytes = videoBytes();
  const fake = (async (url, init) => {
    if (String(url) === clipUrl) {
      expect(new Headers(init?.headers).has("x-api-key")).toBe(false);
      expect(init?.redirect).toBe("error");
      return new Response(Buffer.from(bytes));
    }
    expect(String(url)).toBe(`https://provider.example/api/video/status?requestId=${ref}`);
    expect(new Headers(init?.headers).get("x-api-key")).toBe(key);
    return responses.shift()!;
  }) as typeof fetch;
  const adapter = nanogptVideoAdapter({ base, apiKey: key, fetch: fake });
  const poll = () => adapter.poll(ref, "veo3-1-lite-video", signal);
  expect(await poll()).toEqual({ state: "running" });
  expect(await poll()).toEqual({ state: "running" });
  expect(await poll()).toMatchObject({ state: "done", media: { mime: "video/mp4" } });
  expect(await poll()).toMatchObject({ state: "failed", reason: "upstream_cancelled" });
  expect(await poll()).toMatchObject({ state: "failed", blocked: true });
});

test("NanoGPT rejects insecure download URLs and non-MP4 bytes, and drops an audio track it was not asked for", async () => {
  const responses = [
    completed("http://storage.example/clip.mp4"),
    completed(), new Response("not a clip"),
    completed(), new Response(readFileSync(new URL("../fixtures/av-faststart.mp4", import.meta.url))),
  ];
  const fake = (async (url) => {
    expect(String(url)).toStartWith("https://");
    return responses.shift()!;
  }) as typeof fetch;
  const adapter = nanogptVideoAdapter({ base, apiKey: key, fetch: fake });
  for (let i = 0; i < 2; i++) expect(await adapter.poll(ref, "veo3-1-lite-video", signal)).toMatchObject({ state: "failed" });
  const done = await adapter.poll(ref, "veo3-1-lite-video", signal);
  expect(done.state).toBe("done");
  if (done.state !== "done") return;
  expect(isSilentMp4(done.media.bytes)).toBe(true);
  expect(Buffer.from(done.media.bytes).includes(Buffer.from("soun"))).toBe(false);
  expect(responses).toHaveLength(0);
});

test("submission diagnostics expose only a catalog model, fixed reason and HTTP status", async () => {
  const providerText = "private fixture output";
  const result = [
    Response.json({ error: { message: providerText } }, { status: 422 }),
    Response.json({ error: providerText }, { status: 200 }),
    Response.json({ runId: providerText }, { status: 202 }),
    Response.json({ error: { type: "CONTENT_POLICY_VIOLATION" } }, { status: 400 }),
  ];
  const fetch = (async () => result.shift()!) as typeof globalThis.fetch;
  const adapter = nanogptVideoAdapter({ base, apiKey: key, fetch });
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  try {
    for (const [reason, provider_status] of [["http_error", 422], ["missing_job_id", 200], ["invalid_job_id", 202], ["policy_block", 400]]) {
      await expect(adapter.submit({ ...req, model: "lightricks/ltx-2.3/fast", seconds: 6 }, signal)).rejects.toThrow();
      expect(warn).toHaveBeenLastCalledWith("video provider submission failed", {
        provider: "nanogpt", model: "lightricks/ltx-2.3-fast", reason, provider_status,
      });
    }
  } finally {
    warn.mockRestore();
  }
});

const canonical = "https://api.nano-gpt.com/api";
const alternate = "https://nano-gpt.com/api";
const videoOptions = { ...req, model: "lightricks/ltx-2.3/fast", seconds: 6 };
const connError = (code: string) => Object.assign(new Error("private network details"), { code });

test("pre-send certificate, DNS and refusal failures retry once at the supplier's verified alternate with normal TLS", async () => {
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  try {
    for (const code of ["UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", "ENOTFOUND", "ECONNREFUSED"]) {
      const calls: string[] = [];
      const fake = (async (url, init) => {
        calls.push(String(url));
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("x-api-key")).toBe(key);
        expect(init).not.toHaveProperty("tls");
        if (String(url).startsWith(canonical)) throw new TypeError("fetch failed", { cause: connError(code) });
        if (init?.method === "POST") return Response.json({ runId: ref }, { status: 202 });
        return Response.json({ data: { status: "IN_PROGRESS" } });
      }) as typeof fetch;
      const adapter = nanogptVideoAdapter({ apiKey: key, fetch: fake });
      expect(await adapter.submit(videoOptions, signal)).toBe(ref);
      expect(await adapter.poll(ref, videoOptions.model, signal)).toEqual({ state: "running" });
      const lookup = "/video/status?requestId=" + ref;
      expect(calls).toEqual([canonical + "/generate-video", alternate + "/generate-video", canonical + lookup, alternate + lookup]);
      expect(warn).toHaveBeenLastCalledWith("video provider connection failed", {
        provider: "nanogpt", model: "lightricks/ltx-2.3-fast", stage: "poll", endpoint: "canonical", reason: code,
      });
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private network details");
  } finally { warn.mockRestore(); }
});

test("a confirmed pre-send failure at both origins releases the reservation; an ambiguous final failure retains it", async () => {
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  try {
    for (const [lastError, declined] of [["ENOTFOUND", true], ["ECONNRESET", false]] as const) {
      let count = 0;
      const fake = (async () => { throw connError(++count === 1 ? "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR" : lastError); }) as typeof fetch;
      const adapter = nanogptVideoAdapter({ apiKey: key, fetch: fake });
      const error = await adapter.submit(videoOptions, signal).catch((e: unknown) => e);
      expect(error instanceof VideoSubmissionDeclined).toBe(declined);
      expect(count).toBe(2);
    }
  } finally { warn.mockRestore(); }
});

test("explicit bases, cancellation, ambiguous errors, HTTP responses and missing acknowledgements never replay submissions", async () => {
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  try {
    const aborted = new AbortController();
    aborted.abort();
    const cases = [
      { base, error: connError("ENOTFOUND") },
      { base: canonical, error: connError("ENOTFOUND") },
      { error: connError("ENOTFOUND"), signal: aborted.signal },
      { error: connError("ECONNRESET") },
      { error: connError("ETIMEDOUT") },
      { error: connError("private error code") },
      { error: Object.assign(connError("ECONNRESET"), { cause: connError("ENOTFOUND") }) },
      { response: Response.json({ error: { type: "CONTENT_POLICY_VIOLATION" } }, { status: 400 }) },
      { response: new Response(null, { status: 502 }) },
      { response: new Response(null, { status: 401 }) },
      { response: Response.json({}, { status: 202 }) },
    ];
    for (const variant of cases) {
      let count = 0;
      const fake = (async () => {
        count++;
        if (variant.error) throw variant.error;
        return variant.response!;
      }) as typeof fetch;
      const adapter = nanogptVideoAdapter({ base: variant.base, apiKey: key, fetch: fake });
      await expect(adapter.submit(videoOptions, variant.signal ?? signal)).rejects.toThrow();
      expect(count).toBe(1);
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private error code");
  } finally { warn.mockRestore(); }
});

test("a signed relative content link from the responding alternate resolves there and follows a credential-free storage redirect", async () => {
  const path = "/api/generate-video/content?runId=" + ref + "&model=veo&expires=1&sig=fixture";
  const calls: string[] = [];
  const fake = (async (url, init) => {
    const href = String(url);
    calls.push(href);
    expect(init?.redirect).toBe("error");
    if (href.startsWith(canonical + "/video/status?")) throw connError("UNKNOWN_CERTIFICATE_VERIFICATION_ERROR");
    if (href.startsWith(alternate + "/video/status?")) return completed(path);
    expect(new Headers(init?.headers).get("x-api-key")).toBe(null);
    expect(new Headers(init?.headers).get("authorization")).toBe(null);
    if (href === "https://nano-gpt.com" + path) return new Response(null, { status: 302, headers: { location: clipUrl } });
    expect(href).toBe(clipUrl);
    return new Response(Buffer.from(videoBytes()));
  }) as typeof fetch;
  const adapter = nanogptVideoAdapter({ apiKey: key, fetch: fake });
  expect((await adapter.poll(ref, "veo3-1-lite-video", signal)).state).toBe("done");
  expect(calls).toHaveLength(4);
});

test("relative proxy downloads reject other paths, mismatched runs, unsafe redirects and unbounded chains", async () => {
  for (const [first, redirect, expectedFileRequests] of [
    ["/api/account", "", 0], ["//other.example/file", "", 0],
    ["/api/generate-video/content?runId=vid_other", "", 0],
    [clipUrl, "http://storage.example/file", 1],
    [clipUrl, "https://name@storage.example/file", 1],
    [clipUrl, clipUrl, 4],
  ] as const) {
    let files = 0;
    const fake = (async url => {
      if (String(url).includes("/video/status?")) return completed(first);
      files++;
      return new Response(null, { status: 302, headers: { location: redirect } });
    }) as typeof fetch;
    const adapter = nanogptVideoAdapter({ base, apiKey: key, fetch: fake });
    expect(await adapter.poll(ref, "veo3-1-lite-video", signal)).toMatchObject({ state: "failed", reason: "upstream_output_invalid" });
    expect(files).toBe(expectedFileRequests);
  }
});
