import { log } from "../../lib/util.ts";
import { boundedJson, providerFetch } from "../../providers/network.ts";
import { NANOGPT_VIDEO_MODELS } from "./catalog.ts";
import { isSilentMp4, videoOnlyMp4 } from "./containers.ts";
import { MAX_MEDIA_BYTES, readCapped, UpstreamError, VideoSubmissionDeclined, type VideoFailure, type VideoPoll, type VideoUpstream } from "./upstreams.ts";

const RUN_ID = /^vid_[A-Za-z0-9_-]{1,128}$/;
const transient = (status: number) => status === 408 || status === 429 || status >= 500;
const failed = (reason?: VideoFailure): VideoPoll => ({ state: "failed", reason, message: "NanoGPT video failed" });
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
      const diagnose = (reason: string, providerStatus?: number) =>
        log.warn("video provider submission failed", { provider: "nanogpt", model: model.id, reason, provider_status: providerStatus });
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
      }).catch(() => {
        diagnose("connection_failed");
        throw new UpstreamError("NanoGPT video is unavailable", 503);
      });
      const result = await json(res) as { runId?: string; id?: string; error?: { type?: string } } | null;
      if (!res.ok) {
        if (res.status === 451 || result?.error?.type === "CONTENT_POLICY_VIOLATION") {
          diagnose("policy_block", res.status);
          throw new UpstreamError("NanoGPT blocked the video request", 451, true);
        }
        diagnose("http_error", res.status);
        if ([401, 402, 403, 429].includes(res.status))
          throw new VideoSubmissionDeclined("NanoGPT video is unavailable", 503);
        const unavailable = transient(res.status);
        throw new UpstreamError("NanoGPT video submission failed", unavailable ? 503 : 502, !unavailable);
      }
      const id = result?.runId ?? result?.id;
      if (typeof id !== "string" || !RUN_ID.test(id)) {
        diagnose(id == null ? "missing_job_id" : "invalid_job_id", res.status);
        throw new UpstreamError("NanoGPT returned no valid video job ID", 502);
      }
      return id;
    },
    async poll(ref, _model, signal) {
      if (!RUN_ID.test(ref)) return failed("upstream_job_missing");
      const res = await request(base + "/video/status?" + new URLSearchParams({ requestId: ref }), { headers: auth, signal, redirect: "error" });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        if (transient(res.status)) return { state: "running" };
        return res.status === 451 ? blocked() : failed(res.status === 404 ? "upstream_job_missing" : undefined);
      }
      const result = await json(res) as { data?: { status?: string; isNSFWError?: boolean; output?: { video?: { url?: string } } } } | null;
      const status = result?.data;
      if (status?.isNSFWError === true) return blocked();
      if (status?.status === "IN_QUEUE" || status?.status === "IN_PROGRESS") return { state: "running" };
      if (status?.status === "FAILED") return failed("upstream_render_failed");
      if (status?.status === "CANCELED") return failed("upstream_cancelled");
      if (status?.status !== "COMPLETED") return failed();
      if (typeof status.output?.video?.url !== "string") return failed("upstream_output_unavailable");
      const url = URL.parse(status.output.video.url);
      if (!url || url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return failed("upstream_output_unavailable");

      // The file link is separate from the API and never receives its credential.
      const file = await download(url, { signal, redirect: "error" });
      if (!file.ok || Number(file.headers.get("content-length")) > MAX_MEDIA_BYTES) {
        await file.body?.cancel().catch(() => undefined);
        return transient(file.status) ? { state: "running" } : failed("upstream_output_unavailable");
      }
      let bytes: Uint8Array;
      try {
        bytes = await readCapped(file);
      } catch (e) {
        if (e instanceof UpstreamError) return failed("upstream_output_unavailable");
        throw e;
      }
      // Some models (Veo) add a soundtrack even with audio off. Keep only the picture track the gate reviews.
      const silent = videoOnlyMp4(bytes);
      if (!silent || !isSilentMp4(silent)) return failed("upstream_output_invalid");
      return { state: "done", media: { bytes: silent, mime: "video/mp4" } };
    },
  };
}
