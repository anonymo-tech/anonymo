// WS06 · Upstream adapters against local fake servers on 127.0.0.1 (ComfyUI, Venice, an OpenAI-compatible TTS worker
// and the watermark sidecar). These pin the request shapes the adapters send; the real hosts are unverified (U).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sniffMime } from "../../src/anonymo/media/containers.ts";
import { comfyAdapter, ttsAdapter, UpstreamError, veniceAdapter } from "../../src/anonymo/media/upstreams.ts";
import { httpWatermarker } from "../../src/anonymo/media/watermark.ts";
import { workflowSet } from "../../src/anonymo/media/workflows.ts";
import { solidPng, tinyMp4, toneWav } from "./fixtures.ts";

type Seen = { method: string; path: string; body: unknown; auth: string | null };
const seen: Seen[] = [];
let comfyHistoryCalls = 0;
let veniceRetrieveCalls = 0;
let failNext: { path: string; status: number } | null = null;
let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const type = req.headers.get("content-type") ?? "";
      const body = type.includes("json") ? await req.json() : type.includes("multipart") ? Object.fromEntries([...(await req.formData()).keys()].map((k) => [k, true])) : (await req.arrayBuffer()).byteLength;
      seen.push({ method: req.method, path: url.pathname + url.search, body, auth: req.headers.get("authorization") });
      if (failNext && url.pathname === failNext.path) {
        const { status } = failNext;
        failNext = null;
        return new Response("no", { status });
      }
      // ComfyUI
      if (url.pathname === "/comfy/prompt") return Response.json({ prompt_id: "p-1", number: 1 });
      if (url.pathname === "/comfy/upload/image") return Response.json({ name: "in-1.png", subfolder: "", type: "input" });
      if (url.pathname.startsWith("/comfy/history/")) {
        comfyHistoryCalls++;
        if (comfyHistoryCalls % 2 === 1) return Response.json({});
        const isVideo = url.pathname.endsWith("v-1");
        return Response.json({ [url.pathname.split("/").at(-1)!]: { status: { status_str: "success", completed: true }, outputs: { "9": isVideo ? { images: [{ filename: "anonymo_0001.mp4", subfolder: "video", type: "output" }] } : { images: [{ filename: "anonymo_0001.png", subfolder: "", type: "output" }, { filename: "preview.png", subfolder: "", type: "temp" }] } } } });
      }
      if (url.pathname === "/comfy/history") return Response.json({});
      if (url.pathname === "/comfy/view") return url.searchParams.get("filename")!.endsWith(".mp4") ? new Response(tinyMp4() as unknown as ArrayBuffer, { headers: { "content-type": "video/mp4" } }) : new Response(solidPng(16, 16, [1, 2, 3]) as unknown as ArrayBuffer, { headers: { "content-type": "image/png" } });
      // Venice
      if (url.pathname === "/venice/image/generate") return Response.json({ images: [Buffer.from(solidPng(16, 16, [4, 5, 6])).toString("base64")] });
      if (url.pathname === "/venice/video/queue") return Response.json({ queue_id: "q-1", model: "x" });
      if (url.pathname === "/venice/video/retrieve") return ++veniceRetrieveCalls === 1 ? Response.json({ status: "PROCESSING" }) : new Response(tinyMp4(2) as unknown as ArrayBuffer, { headers: { "content-type": "video/mp4" } });
      // TTS
      if (url.pathname === "/tts/v1/audio/speech") return new Response(toneWav(0.2) as unknown as ArrayBuffer, { headers: { "content-type": "audio/wav" } });
      // Watermark sidecar
      if (url.pathname === "/wm/v1/watermark/embed") return new Response(tinyMp4(9) as unknown as ArrayBuffer, { headers: { "content-type": "video/mp4", "x-watermark-alg": "videoseal" } });
      if (url.pathname === "/wm/v1/watermark/detect") return Response.json({ alg: "videoseal", id: "00112233aabbccdd" });
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server?.stop(true));
const last = (path: string) => seen.filter((s) => s.path.startsWith(path)).at(-1);
const signal = () => AbortSignal.timeout(5000);

describe("ComfyUI adapter", () => {
  const comfy = () => comfyAdapter({ base: `${base}/comfy`, token: "worker-token", workflows: workflowSet(), pollMs: 5 });

  test("text to image: queues the graph, polls history, downloads only output files, forgets the job", async () => {
    const out = await comfy().generate({ model: "flux.1-schnell", prompt: "a square", n: 1, width: 1024, height: 1024, seed: 11, safe: false }, signal());
    expect(out).toHaveLength(1);
    expect(out[0].mime).toBe("image/png");
    const q = last("/comfy/prompt")!;
    expect(q.auth).toBe("Bearer worker-token");
    const graph = (q.body as { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> }).prompt;
    expect(Object.values(graph).find((n) => n.class_type === "KSampler")?.inputs.seed).toBe(11);
    expect(seen.some((s) => s.path.includes("filename=preview.png"))).toBe(false);
    await Bun.sleep(20);
    expect(last("/comfy/history")?.method).toBe("POST"); // the history entry is deleted
  });

  test("edits upload the image first and reference it in the graph", async () => {
    await comfy().generate({ model: "qwen-image-edit", prompt: "edit", n: 1, width: 1024, height: 1024, seed: 1, safe: true, image: { bytes: solidPng(16, 16, [9, 9, 9]), mime: "image/png" } }, signal());
    expect(last("/comfy/upload/image")?.body).toMatchObject({ image: true });
    const graph = (last("/comfy/prompt")!.body as { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> }).prompt;
    expect(Object.values(graph).find((n) => n.class_type === "LoadImage")?.inputs.image).toBe("in-1.png");
  });

  test("video: submit returns the prompt id, poll reports running then the MP4", async () => {
    const c = comfy();
    comfyHistoryCalls = 0;
    const ref = await c.submit({ model: "wan-2.2", prompt: "pan", seconds: 4, width: 832, height: 480, seed: 3, safe: false }, signal());
    expect(ref).toBe("p-1");
    const graph = (last("/comfy/prompt")!.body as { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> }).prompt;
    expect(Object.values(graph).find((n) => n.class_type === "Wan22ImageToVideoLatent")?.inputs.length).toBe(97);
    expect((await c.poll("v-1", "wan-2.2", signal())).state).toBe("running");
    const done = await c.poll("v-1", "wan-2.2", signal());
    expect(done.state).toBe("done");
    if (done.state === "done") expect(sniffMime(done.media.bytes)).toBe("video/mp4");
  });

  test("errors map to UpstreamError: 429 is unavailable, 400 is a rejection", async () => {
    failNext = { path: "/comfy/prompt", status: 429 };
    const e1 = await comfy().generate({ model: "chroma", prompt: "x", n: 1, width: 1024, height: 1024, seed: 1, safe: false }, signal()).catch((e) => e);
    expect(e1).toBeInstanceOf(UpstreamError);
    expect([e1.status, e1.rejected]).toEqual([503, false]);
    failNext = { path: "/comfy/prompt", status: 400 };
    const e2 = await comfy().generate({ model: "chroma", prompt: "x", n: 1, width: 1024, height: 1024, seed: 1, safe: false }, signal()).catch((e) => e);
    expect([e2.status, e2.rejected]).toEqual([502, true]);
  });
});

describe("Venice adapter", () => {
  const venice = () => veniceAdapter({ base: `${base}/venice`, apiKey: "venice-test-key" });
  test("image generation asks for PNG with safe mode and returns the decoded bytes", async () => {
    const out = await venice().generate({ model: "venice-sd35", prompt: "p", n: 2, width: 1024, height: 1024, seed: 5, safe: true }, signal());
    expect(out.map((m) => m.mime)).toEqual(["image/png", "image/png"]);
    expect(last("/venice/image/generate")).toMatchObject({ auth: "Bearer venice-test-key", body: { model: "venice-sd35", format: "png", safe_mode: true, seed: 6 } });
  });
  test("video: queue, then retrieve until the MP4 arrives", async () => {
    const v = venice();
    expect(await v.submit({ model: "wan-2.5-preview", prompt: "p", seconds: 5, width: 1280, height: 720, seed: 1, safe: false }, signal())).toBe("q-1");
    expect(last("/venice/video/queue")?.body).toMatchObject({ duration: "5s", aspect_ratio: "16:9" });
    expect((await v.poll("q-1", "wan-2.5-preview", signal())).state).toBe("running");
    expect((await v.poll("q-1", "wan-2.5-preview", signal())).state).toBe("done");
    expect(last("/venice/video/retrieve")?.body).toMatchObject({ queue_id: "q-1", delete_media_on_completion: true });
  });
});

describe("TTS adapter and watermark sidecar", () => {
  test("TTS asks for WAV with the stock voice", async () => {
    const out = await ttsAdapter({ base: `${base}/tts` }).speak({ model: "kokoro", input: "hi", voice: "af_sky", speed: 1 }, signal());
    expect(out.mime).toBe("audio/wav");
    expect(last("/tts/v1/audio/speech")?.body).toEqual({ model: "kokoro", input: "hi", voice: "af_sky", response_format: "wav", speed: 1 });
  });
  test("the sidecar client sends the id, returns the marked bytes, and reads detections", async () => {
    const wm = httpWatermarker(`${base}/wm`, { mimes: ["video/mp4"] });
    expect(wm.supports("video/mp4")).toBe(true);
    expect(wm.supports("image/png")).toBe(false);
    const out = await wm.embed(tinyMp4(), "video/mp4", "00112233aabbccdd");
    expect(out.mark).toEqual({ alg: "videoseal", id: "00112233aabbccdd" });
    expect(await wm.detect(out.bytes, "video/mp4")).toEqual({ alg: "videoseal", id: "00112233aabbccdd" });
  });
});
