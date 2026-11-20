import { boundedJson, providerFetch } from "../../providers/network.ts";
import { NANOGPT_VIDEO_MODELS } from "./catalog.ts";
import { isSilentMp4 } from "./containers.ts";
import { MAX_MEDIA_BYTES, readCapped, UpstreamError, type VideoPoll, type VideoUpstream } from "./upstreams.ts";

const RUN_ID = /^vid_[A-Za-z0-9_-]{1,128}$/;
const transient = (status: number) => status === 408 || status === 429 || status >= 500;
const failed = (): VideoPoll => ({ state: "failed", message: "NanoGPT video failed" });
const blocked = (): VideoPoll => ({ state: "failed", blocked: true, message: "NanoGPT video was blocked" });
const json = (response: Response) => boundedJson(response, 64 * 1024).catch(() => null);

/** NanoGPT's async video API lives under /api beside its OpenAI-compatible /api/v1 endpoints. */
export function nanogptVideoAdapter(o: { base: string; apiKey: string; fetch?: typeof fetch }): VideoUpstream {
  const base = o.base.replace(/\/+$/, "").replace(/\/v1$/, "");
  const request = (o.fetch ?? fetch);
  const download = o.fetch ?? ((url: URL, init: RequestInit) => providerFetch(url, init, { production: true }));
  const auth = { "x-api-key": o.apiKey };

  return {
    async submit(r, signal) {
      const model = NANOGPT_VIDEO_MODELS.find((m) => m.upstreamModel === r.model);
      if (!model) throw new UpstreamError("Unknown NanoGPT video model", 400, true);
      const res = await request(base + "/generate-video", {
        method: "POST", headers: { ...auth, "content-type": "application/json" }, signal, redirect: "error",
        body: JSON.stringify({
          model: r.model,
          prompt: r.prompt,
          mode: "text-to-video",
          duration: model.numericDuration ? r.seconds : String(r.seconds),
          aspect_ratio: r.width > r.height ? "16:9" : "9:16",
          resolution: "720p",
          showExplicitContent: false,
          ...(model.numericDuration ? { seed: r.seed } : {}),
          ...(model.audioSwitch ? { [model.audioSwitch]: false } : {}),
        }),
      }).catch(() => { throw new UpstreamError("NanoGPT video is unavailable", 503); });
      const result = await json(res) as { runId?: string; id?: string; error?: { type?: string } } | null;
      if (!res.ok) {
        if (res.status === 451 || result?.error?.type === "CONTENT_POLICY_VIOLATION")
          throw new UpstreamError("NanoGPT blocked the video request", 451, true);
        const unavailable = transient(res.status) || [401, 402, 403].includes(res.status);
        throw new UpstreamError("NanoGPT video submission failed", unavailable ? 503 : 502, !unavailable);
      }
      const id = result?.runId ?? result?.id;
      if (typeof id !== "string" || !RUN_ID.test(id)) throw new UpstreamError("NanoGPT returned no valid video job ID", 502);
      return id;
    },
    async poll(ref, _model, signal) {
      if (!RUN_ID.test(ref)) return failed();
      const res = await request(base + "/video/status?" + new URLSearchParams({ requestId: ref }), { headers: auth, signal, redirect: "error" });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        if (transient(res.status)) return { state: "running" };
        return res.status === 451 ? blocked() : failed();
      }
      const result = await json(res) as { data?: { status?: string; isNSFWError?: boolean; output?: { video?: { url?: string } } } } | null;
      const status = result?.data;
      if (status?.isNSFWError === true) return blocked();
      if (status?.status === "IN_QUEUE" || status?.status === "IN_PROGRESS") return { state: "running" };
      if (status?.status !== "COMPLETED" || typeof status.output?.video?.url !== "string") return failed();
      const url = URL.parse(status.output.video.url);
      if (!url || url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return failed();

      // The file link is separate from the API and never receives its credential.
      const file = await download(url, { signal, redirect: "error" });
      if (!file.ok || Number(file.headers.get("content-length")) > MAX_MEDIA_BYTES) {
        await file.body?.cancel().catch(() => undefined);
        return transient(file.status) ? { state: "running" } : failed();
      }
      let bytes: Uint8Array;
      try {
        bytes = await readCapped(file);
      } catch (e) {
        if (e instanceof UpstreamError) return failed();
        throw e;
      }
      if (!isSilentMp4(bytes)) return failed();
      return { state: "done", media: { bytes, mime: "video/mp4" } };
    },
  };
}
