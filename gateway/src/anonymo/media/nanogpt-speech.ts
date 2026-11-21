import { containerFor } from "./containers.ts";
import { readCapped, UpstreamError, type SpeechUpstream } from "./upstreams.ts";

export interface TranscriptionUpstream {
  transcribe(r: { model: string; file: File; language?: string }, signal: AbortSignal): Promise<string>;
}

export function nanogptSpeechAdapter(o: { base: string; apiKey: string; fetch?: typeof fetch }): SpeechUpstream & TranscriptionUpstream {
  const call = async (path: string, init: RequestInit) => {
    let res: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${o.apiKey}`);
      res = await (o.fetch ?? fetch)(o.base.replace(/\/$/, "") + path, { ...init, method: "POST", headers, redirect: "error" });
    } catch {
      throw new UpstreamError("NanoGPT audio request failed", 503);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      const unavailable = [401, 402, 403, 429].includes(res.status) || res.status >= 500;
      throw new UpstreamError("NanoGPT audio request failed", unavailable ? 503 : 502, !unavailable && res.status < 500);
    }
    return res;
  };

  return {
    async speak({ model, input, voice, speed }, signal) {
      const res = await call("/audio/speech", {
        headers: { "content-type": "application/json", accept: "audio/wav" },
        body: JSON.stringify({ model, input, voice, speed, response_format: "wav" }),
        signal,
      });
      try {
        const bytes = await readCapped(res);
        if (containerFor("audio/wav")?.matches(bytes)) return { bytes, mime: "audio/wav" };
      } catch {
        // Upstream errors may include request details. Map them to a safe error.
      }
      throw new UpstreamError("NanoGPT returned unreadable WAV audio", 502);
    },
    async transcribe({ model, file, language }, signal) {
      const body = new FormData();
      body.set("file", file);
      body.set("model", model);
      body.set("response_format", "json");
      if (language) body.set("language", language);
      const res = await call("/audio/transcriptions", { body, signal });
      try {
        const bytes = await readCapped(res, 256 * 1024);
        const result = JSON.parse(new TextDecoder().decode(bytes)) as { text?: unknown } | null;
        if (typeof result?.text === "string") return result.text;
      } catch {
        // JSON parsing errors can contain transcript text.
      }
      throw new UpstreamError("NanoGPT returned an unreadable transcript", 502);
    },
  };
}
