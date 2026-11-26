// What media stores and which request bodies it reads, for the data inventory (src/privacy/inventory.ts and
// outside.ts register these). Checked against the real schema and source by test/data-inventory.test.ts.

import type { Evidence, ExternalDoc, TableDoc } from "../../privacy/types.ts";

const ev = (file: string, contains: string): Evidence => ({ file, contains });

export const mediaTables: Record<string, TableDoc> = {
  media_jobs: {
    category: "request",
    request: "yes",
    purpose: "One row per asynchronous video job (POST /v1/video/generations): which model and upstream ran it, its size and length, its status and what it cost. Never the prompt and never the video: the output lives only in process memory for the signed-URL window.",
    retention: "No automatic deletion: no job or route in the code removes rows from this table.",
    columns: {
      id: "Random job id (vid_…), also the id of the job's ledger hold.",
      account_id: "Account of the key that submitted the job; only that account can read it.",
      key_hash: "Hash of the submitting key.",
      hold_id: "The ledger hold reserved at the quoted price; settled on completion, released on any failure or block.",
      model: "Media model id from the catalog (wan-2.2, venice/…).",
      upstream: "venice or comfyui.",
      upstream_ref: "The upstream's own job reference (a ComfyUI prompt id or a Venice queue id); random, issued by the upstream.",
      status: "queued, running, finishing, completed, failed or blocked.",
      seconds: "Requested video length in seconds.",
      width: "Output width in pixels.",
      height: "Output height in pixels.",
      explicit_allowed: "Whether region rules allowed explicit output at submission; derived from the country code, which is not stored.",
      price_pico: "Quoted price in pico-USD, the amount held.",
      charged_pico: "Amount actually charged; null until settled.",
      error_type: {
        purpose: "A fixed machine-readable reason (upstream_failed, media_blocked:nsfw_minor …); never upstream or request text.",
        review: { covers: ["name:content"], verdict: "no-request-content", why: "Written only from a fixed set of codes in src/anonymo/media/routes.ts; upstream error text is discarded, never stored." },
      },
      media_id: "Id of the output in the in-memory media store; meaningless once that expires.",
      media_expires_at: "When the signed download link and the in-memory output expire.",
      last_polled_at: "When the upstream was last polled for this job.",
      created_at: "When the row was created.",
      updated_at: "When the row last changed.",
    },
  },
};

export const mediaBodyReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/anonymo/media/routes.ts",
  carries: "prompt-or-answer",
  reads: "An image, speech or video request: model, prompt or input text, size, count, seed and voice; for image edits one uploaded image (multipart or a data URL); for provenance checks a media file.",
  then: "Runs the floor gate on the text, region rules, a ledger hold, the upstream, the media gate on every visual output and provenance (watermark and signed C2PA manifest). The upload and the output are held in memory only; the output stays in memory for the signed-URL window (default one hour) and is then dropped.",
  kept: "Video job metadata in media_jobs and the usual ledger hold and settlement. Sponsored images also store account-level availability, a transient random reservation ID and an aggregate UTC-day budget counter in KV. The hourly free-generation rate limit uses a keyed digest. No prompt, input text, address, upload or output is stored.",
  evidence: [ev("src/anonymo/media/routes.ts", "const body = await readJson("), ev("src/anonymo/media/routes.ts", "raw.formData();"), ev("src/anonymo/media/routes.ts", "req.arrayBuffer())")],
};

export const transcriptionBodyReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/anonymo/media/transcription.ts",
  carries: "prompt-or-answer",
  reads: "One multipart audio upload, its model and an optional language code.",
  then: "Decodes audio in memory to validate its duration. Sends the audio to NanoGPT and returns the transcript directly.",
  kept: "The ledger hold and settlement contain only billing metadata. The upload, its filename and the transcript stay out of storage and logs.",
  evidence: [ev("src/anonymo/media/transcription.ts", "req.formData()"), ev("src/anonymo/media/routes.ts", "s.transcription.transcribe(")],
};
