import { expect, test } from "bun:test";
import { concatBytes, te, u32be } from "../../src/anonymo/media/bytes.ts";
import { MediaCatalog } from "../../src/anonymo/media/catalog.ts";
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
  expect(await poll()).toMatchObject({ state: "failed" });
  expect(await poll()).toMatchObject({ state: "failed", blocked: true });
});

test("NanoGPT rejects insecure download URLs, non-MP4 bytes and clips with an audio track", async () => {
  const responses = [
    completed("http://storage.example/clip.mp4"),
    completed(), new Response("not a clip"),
    completed(), new Response(Buffer.from(videoBytes(true))),
  ];
  const fake = (async (url) => {
    expect(String(url)).toStartWith("https://");
    return responses.shift()!;
  }) as typeof fetch;
  const adapter = nanogptVideoAdapter({ base, apiKey: key, fetch: fake });
  for (let i = 0; i < 3; i++) expect(await adapter.poll(ref, "veo3-1-lite-video", signal)).toMatchObject({ state: "failed" });
  expect(responses).toHaveLength(0);
});
