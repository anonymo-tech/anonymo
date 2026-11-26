# Media (WS06)

Images, voice and video on the same key as text, ported from Anonyma's `/v1` media routes (Express/SQLite) to Hono and
Drizzle. Spec: Overview §2 (media table) and §6, Backend §2 (media-gate, provenance) and §10.

## Endpoints

| Endpoint | Notes |
|---|---|
| `POST /v1/images/generations` | `model`, `prompt`, `n` from 1 to the model's `max_images`, `size`, `response_format` `url` \| `b64_json`, `seed` |
| `GET /v1/images/welcome` | Dashboard origin. Returns `available` and the current `eligible_models`. Supply a key to check its remaining generation. |
| `POST /v1/images/generations/sponsored` | Dashboard origin and root key. One image, with the normal generation fields, output checks, provenance and a signed zero-cost receipt. Conflicts return 409. |
| `POST /v1/images/edits` | multipart `image` (or JSON `image` as a data URL), same fields. No masks. Image URLs are never fetched |
| `POST /v1/audio/speech` | `model`, `input`, `voice` (stock only), `speed`. Returns WAV with provenance |
| `POST /v1/audio/transcriptions` | Multipart `file`, `model`, optional `language`. Returns `{ "text": "…" }` |
| `GET /v1/video/welcome` | Dashboard origin. Returns `mode` (`welcome` or `complimentary`), `available` and `eligible_clips` with the shortest sponsored length for each model. An authenticated lookup checks the root key's remaining clip. |
| `POST /v1/video/generations/sponsored` | Dashboard origin and root key. Creates one eligible short clip at a zero user quote. Poll the normal job URL for its result and receipt. A used or in-progress welcome grant returns 409. The configured complimentary root can submit again after completion, within its separate daily budget. |
| `POST /v1/video/generations` | `model`, `prompt`, `seconds`, `size`, `seed`. Returns `202` with a job id |
| `GET /v1/video/generations/{id}` | Polls the job. `queued` → `in_progress` → `completed` (with a signed `url`) or `failed` |
| `GET /v1/media/{id}?expires=&sig=` | Short-lived signed download. No key needed, the signature is the credential |
| `GET /v1/media/models` | Models, prices, voices, sizes, licences and per-model image batch limits (`max_images`) |
| `GET /v1/media/provenance/keys` | The Ed25519 keys that sign manifests (JWK) |
| `POST /v1/media/provenance/verify` | Body = a media file (API key required). Reports the manifest check and the watermark |

### Complimentary Video Studio access

Set `ANONYMO_VIDEO_COMP_KEY_COMMIT` to one root key's full public EVM key commitment shown on Balance. The gateway derives that commitment from the authenticated root key. Keys with management privileges on other accounts and child keys receive the normal welcome offer.

`ANONYMO_VIDEO_COMP_DAILY_USD` sets the aggregate UTC-day budget for the configured allowance. Its default is $0.24. Each dispatched attempt reserves its quoted cost, including failed or blocked attempts. An eligible clip remains zero-cost to the root on both video generation routes. Unsupported settings, an in-progress clip or an exhausted pool reject the request before dispatch. The response keeps `mode: "complimentary"` when the budget is exhausted.


Each is also served under `/api/v1`. Errors use the gateway's OpenAI-shaped envelope.

## NanoGPT image models

Set `ANONYMO_NANOGPT_API_KEY` to list these models for text-to-image generation. To override a dollar price, set
`ANONYMO_NANOGPT_IMAGE_USD_` followed by the suffix in the table.

| Anonymo model ID | NanoGPT model ID | USD/image | Max images | Price override suffix |
|---|---|---:|---:|---|
| `google/nano-banana` | `nano-banana` | 0.050 | 4 | `NANO_BANANA` |
| `openai/gpt-image-2` | `gpt-image-2` | 0.080 | 4 | `GPT_IMAGE_2` |
| `bfl/flux.2-max` | `flux-2-max` | 0.090 | 4 | `FLUX_2_MAX` |
| `bfl/flux.2-flash` | `flux-2-flash` | 0.032 | 4 | `FLUX_2_FLASH` |
| `ideogram/v4.5` | `ideogram/v4.5` | 0.076 | 8 | `IDEOGRAM_V4_5` |
| `recraft/v4.1` | `recraft-ai/recraft-v4.1/text-to-image` | 0.050 | 8 | `RECRAFT_V4_1` |
| `krea/krea-2-medium` | `krea/v2/medium/text-to-image` | 0.038 | 4 | `KREA_2_MEDIUM` |
| `xai/grok-imagine-2` | `xai/grok-imagine-image/v2.0/text-to-image` | 0.076 | 4 | `GROK_IMAGINE_2` |

Choose a `size` from the model's listed width × height presets. The default is `1024x1024`. For aspect-ratio models,
these presets specify the shape and the provider determines the pixel dimensions. Grok Imagine Image 2.0 uses the
1K tier at the listed price. [NanoGPT image API reference](https://docs.nano-gpt.com/api-reference/image-generation)

## NanoGPT voice models

With `ANONYMO_NANOGPT_API_KEY` and `ANONYMO_FEATURE_MEDIA` configured, `GET /v1/media/models` lists both voice models.

- `kokoro/kokoro-82m` offers 33 stock voices, 10,000 characters per request, and speeds from 0.5 to 2. The default
  rate is $0.003 per 1,000 input characters, configurable with `ANONYMO_NANOGPT_SPEECH_USD_KOKORO`.
- `openai/whisper-large-v3` accepts MP3, OGG, WAV, M4A and AAC. The multipart body can be up to 4 MB and the audio
  can be up to 5 minutes. The default rate is $0.001 per started minute, configurable with
  `ANONYMO_NANOGPT_TRANSCRIPTION_USD_WHISPER`. FFmpeg counts decoded samples in memory before the gateway reserves credit.
  The response contains only the transcript, which goes back to the caller without a floor check. When that text
  is sent as a chat message, the normal chat floor check applies.

Neither endpoint stores audio, input text or transcripts. [NanoGPT transcription API](https://docs.nano-gpt.com/api-reference/endpoint/audio-transcriptions)

## The order every request runs in

1. API key, role and per-key rate limit.
2. Validation (model, sizes, voices). Fields that would carry a voice sample or a reference image are refused here.
3. **Floor gate** (`ctx.anonymo.floor`) with the right `modality` and `hasUpload` (true only for edits). A block is
   `451 floor_blocked` and is never rerouted, and a gate that cannot answer is `503 floor_unavailable`. Nothing is sent
   or held.
   Then, for images and video, the **nudity prompt check** (`prompt-check.ts`): word rules, then the floor's guard
   model asked one yes/no question (when it runs gpt-oss-safeguard). A prompt asking for nudity or sex gets
   `451 explicit_media_unavailable` with `stage: "prompt"`, and nothing is sent or charged. A guard error does not
   block: the media gate below still checks the output.
4. **Region rules.** A blocked region gets `451 region_blocked`. Every upstream is asked for safe output, in every
   region.
5. For edits, the **upload itself** goes through the media gate. An explicit upload is refused before any model sees it.
6. **Hold** (`reserve`) at the quoted price: per image, per 1k characters, or per video second.
7. **Upstream** (NanoGPT, Venice, the ComfyUI worker pool, or the TTS worker pool).
8. **Media gate** on every image and on sampled video frames. A block releases the hold and nothing is stored or
   returned. One blocked image stops the whole batch.
9. **Provenance**: an invisible watermark, then a signed C2PA manifest. `stamp()` verifies its own output and throws
   otherwise, so unmarked media cannot be returned. MP4 video, when no video watermarker is configured (the built-in
   one marks PNG and WAV), carries the signed manifest alone, with its watermark recorded as `{ "alg": "none" }`;
   verification accepts that for MP4 video only.
10. Delivery (signed URL or inline), then **settle**.

Any failure after step 6 releases the hold, so nothing is charged.

## Safety rules enforced here

- **Safe for work only, everywhere.** Anonymo's adult content is text only. Every image and video upstream runs in safe
  mode, and the media gate blocks any frame it scores as sexually explicit (`451 explicit_media_unavailable`), for
  every key and in every region. Nothing is charged.
- **No NSFW edits of uploaded photos.** The upload is scored first and an explicit upload is refused before any model
  sees it.
- **Stock voices only.** `voice` must be one of the model's listed voices. Clone fields (`reference_audio`,
  `speaker_wav`, `voice_url` and the like) and multipart bodies are refused before anything is sent.
- **No uploads to video.** `image_url`, `input_reference` and similar fields are refused.
- **Apache-licensed self-hosted image and video models only.** Voice may be Apache-2.0 or MIT. FLUX [dev] is refused
  under any spelling (`catalog.ts` `assertLicensed`, run on every catalog). Venice models appear only when configured,
  and only as `venice/<id>`.
- **The gate fails closed.** A classifier error, timeout, missing frame, invalid number, or an explicit frame whose age
  can't be read is a block. An explicit frame that also looks under 25 or like a real person is reported as
  `nsfw_minor` or `nsfw_real_person`, so those attempts stay visible in the floor's counts.

## What is never stored

- **Prompt text:** not in `media_jobs`, the ledger, the receipts or the logs. The test suite scans every table for it.
- **Output media:** held only in process memory (`store.ts`) for the signed-URL window (`ANONYMO_MEDIA_TTL_S`, default
  1 hour), then zeroed and dropped. `b64_json` responses are never stored at all.
- **Upstream metadata:** PNG text chunks (ComfyUI writes the whole workflow, prompt included, into `tEXt`) and RIFF
  `LIST` chunks are stripped. As a backstop, an output that still contains the prompt verbatim is refused.

## Provenance: how it works and the gaps

**Watermark (`watermark.ts`).** The built-in `anonymo-lsb-v1` is a keyed spread watermark in the blue-channel LSB of
PNGs and in the sample LSB of 16-bit WAV. It changes a pixel or sample by at most one level, so it is invisible and
inaudible. It carries a 64-bit id, and a majority vote recovers that id through scattered bit damage. **It does not
survive lossy re-encoding, resizing or cropping.** A robust learned watermark (TrustMark, VideoSeal or AudioSeal
class) belongs in the worker sidecar (`ANONYMO_WATERMARK_URL`, contract in `watermark.ts`). MP4 is watermarked only
through that sidecar, so **video is blocked until the sidecar is deployed**.

**C2PA manifest (`c2pa.ts`, `containers.ts`).** No maintained C2PA library runs under Bun without a native addon, and
`gateway/package.json` is owned by WS01. The manifest is therefore built in process:

- a JUMBF manifest store with the C2PA 2.x box layout and UUIDs, containing:
  - `c2pa.actions` (`c2pa.created`, `trainedAlgorithmicMedia`);
  - `c2pa.hash.data` (sha256 of the whole file except the manifest unit);
  - `anonymo.generation` (model, request id, time, and the watermark id);
- a CBOR claim with sha256 bindings to each assertion;
- a COSE_Sign1 EdDSA signature.

It is embedded in a PNG `caBX` chunk, a WAV `C2PA` chunk, or a top-level MP4 `uuid` box. It verifies end to end with
`verifyManifest()` and the key from `GET /v1/media/provenance/keys`. It has three known gaps against a conformant C2PA
validator (c2patool):

1. The signature carries a `kid`, not an `x5chain` certificate chained to the C2PA trust list. That needs an X.509
   signing certificate, which is an operator task.
2. The claim is attached to the COSE structure, not detached.
3. MP4 uses `c2pa.hash.data` rather than `c2pa.hash.bmff.v2`.

When a C2PA library with a WASM build works under Bun, it can replace `embedManifest`/`verifyManifest` behind the same
`Provenance` interface.

Output formats are PNG, WAV and MP4 only. Anything else an upstream returns is refused (`502 provenance_failed`)
rather than returned unmarked.

## Interfaces and doubles

| Piece | Interface | Production | Tests |
|---|---|---|---|
| Media gate | `MediaGate` (seams) / `MediaOutputGate` | `createMediaGate(httpClassifier(url))` | `createMediaGate(double)` |
| Classifier | `MediaClassifier` | `POST {url}/v1/score` (contract in `gate.ts`) | mock scores keyed to fixture colours |
| Hosted classifier | `MediaClassifier` | `hostedClassifier`: NanoGPT `POST /api/nsfw/image` + Llama Guard 4 (PPQ), images only | fetch doubles (`test/media/hosted.test.ts`) |
| Provenance | `Provenance` (seams) / `MediaProvenance` | `createProvenance(...)` | same, with an MP4 watermark double |
| Region rules | `RegionRules` (seams) | `ctx.anonymo.region` once WS02 adds it, else `placeholderRegionRules` | header `x-anonymo-country` |
| Upstreams | `ImageUpstream`, `SpeechUpstream`, `VideoUpstream` | `nanogptAdapter`, `veniceAdapter`, `comfyAdapter`, `ttsAdapter` | in-process doubles, and fake HTTP servers |

Tests swap services with `setMediaServices(ctx, {...})`. Configuration is read from the environment (list in
`services.ts`). An unconfigured upstream answers `503` and charges nothing. An unconfigured classifier blocks every
image and video.

## Notes for other workstreams

- **WS02**: when `region` is added to `ctx.anonymo`, media uses it automatically (`regionRulesOf`). Upload
  hash-matching (Hive) is WS02's 02c. Media calls the floor gate with `hasUpload: true` for edits. A `nsfw_minor`
  output block is logged as a count only (`media output blocked`, with reason and model). Wiring it into the abuse and
  preservation flow is WS02's call.
- **WS09**: media responses carry a signed receipt (`anonymo.receipt` and `x-anonymo-receipt`, signed with
  `ctx.signer`). It is not yet a row in `generations` or the hourly Merkle root.
- **WS10**: ComfyUI workers must run with `--disable-metadata` and a tmpfs input/output directory with a cleaner. The
  gateway deletes each job from `/history`, but ComfyUI has no API to delete files. WS10 also hosts the classifier and
  the watermark sidecar, routes `/v1/media/*` to the replica that made the link (or runs media on one replica), and
  strips any client-sent `x-anonymo-country`. `sweepVideoJobs(ctx)` can run as a periodic job. Polling GETs already
  advance jobs.

### Everyday Studio (Update 32)

Set `ANONYMO_FEATURE_STUDIO=true` to enable the extra visual safety checks and serve the existing image and video routes. `ANONYMO_FEATURE_MEDIA` also enables speech and transcription. In the dashboard build, include `studio` in `NEXT_PUBLIC_ANONYMO_UPDATES`.

Studio keeps the existing text floor, SFW prompt check and media gate. Configure the existing media classifier as above, then provision these additional sidecars with request and response logging disabled.

| Base URL variable | Endpoint | Response |
| --- | --- | --- |
| `ANONYMO_SFW_SHIELDGEMMA_URL` | `POST /v1/shieldgemma2` | `{"frames":["safe", "unsafe"]}` |
| `ANONYMO_SFW_LLAVAGUARD_URL` | `POST /v1/llavaguard` | `{"frames":["safe", "unsafe"]}` |
| `ANONYMO_SFW_PERSON_URL` | `POST /v1/person-likeness` | `{"face_detected":true,"person_likeness":true}` |

Each request body is raw media with its MIME type. Set the matching `ANONYMO_SFW_SHIELDGEMMA_TOKEN`, `ANONYMO_SFW_LLAVAGUARD_TOKEN` or `ANONYMO_SFW_PERSON_TOKEN` to send bearer auth. For each output, both model hosts must return exactly the requested `X-Sample-Frames` count. Use one verdict for an image and evenly spaced frames for a clip (`ANONYMO_MEDIA_VIDEO_FRAMES`, default 8). Each label reflects whether the frame passes the Studio SFW policy. For animated images, return an image verdict covering the whole image. For uploads, run face detection and a real-person likeness check on the whole image, including when a face is obscured. The likeness check distinguishes a photo of a real person from a cartoon or other synthetic character. It needs no identity match or biometric retention.

An unsafe output verdict blocks delivery and billing, including when the other model passes or is unavailable. Unavailable checks fail closed. Real-person edit refusals return 451 with `floor_blocked` and category `real_person`. Signed Studio receipts include prompt, upload when applicable, and checked output verdicts. Synchronous safety refusals carry their zero-cost receipt in `x-anonymo-receipt`. For clips, poll the existing job URL for the receipt. A Studio output block returns a terminal failed job with HTTP 451.
