# Media (WS06)

Images, voice and video on the same key as text, ported from Anonyma's `/v1` media routes (Express/SQLite) to Hono and
Drizzle. Spec: Overview §2 (media table) and §6, Backend §2 (media-gate, provenance) and §10.

## Endpoints

| Endpoint | Notes |
|---|---|
| `POST /v1/images/generations` | `model`, `prompt`, `n` 1–4, `size`, `response_format` `url` \| `b64_json`, `seed` |
| `POST /v1/images/edits` | multipart `image` (or JSON `image` as a data URL), same fields. No masks. Image URLs are never fetched |
| `POST /v1/audio/speech` | `model`, `input`, `voice` (stock only), `speed`. Returns WAV |
| `POST /v1/video/generations` | `model`, `prompt`, `seconds`, `size`, `seed`. Returns `202` with a job id |
| `GET /v1/video/generations/{id}` | Polls the job. `queued` → `in_progress` → `completed` (with a signed `url`) or `failed` |
| `GET /v1/media/{id}?expires=&sig=` | Short-lived signed download. No key needed, the signature is the credential |
| `GET /v1/media/models` | Models, prices, voices, sizes, licences |
| `GET /v1/media/provenance/keys` | The Ed25519 keys that sign manifests (JWK) |
| `POST /v1/media/provenance/verify` | Body = a media file (API key required). Reports the manifest check and the watermark |

Each is also served under `/api/v1`. Errors use the gateway's OpenAI-shaped envelope.

## The order every request runs in

1. API key, role and per-key rate limit.
2. Validation (model, sizes, voices). Fields that would carry a voice sample or a reference image are refused here.
3. **Floor gate** (`ctx.anonymo.floor`) with the right `modality` and `hasUpload` (true only for edits). A block is
   `451 floor_blocked` and is never rerouted, and a gate that cannot answer is `503 floor_unavailable`. Nothing is sent
   or held.
4. **Region rules.** A blocked region gets `451 region_blocked`. Every upstream is asked for safe output, in every
   region.
5. For edits, the **upload itself** goes through the media gate. An explicit upload is refused before any model sees it.
6. **Hold** (`reserve`) at the quoted price: per image, per 1k characters, or per video second.
7. **Upstream** (Venice, the ComfyUI worker pool, or the TTS worker pool).
8. **Media gate** on every image and on sampled video frames. A block releases the hold and nothing is stored or
   returned. One blocked image stops the whole batch.
9. **Provenance**: an invisible watermark, then a signed C2PA manifest. `stamp()` verifies its own output and throws
   otherwise, so unmarked media cannot be returned.
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
| Provenance | `Provenance` (seams) / `MediaProvenance` | `createProvenance(...)` | same, with an MP4 watermark double |
| Region rules | `RegionRules` (seams) | `ctx.anonymo.region` once WS02 adds it, else `placeholderRegionRules` | header `x-anonymo-country` |
| Upstreams | `ImageUpstream`, `SpeechUpstream`, `VideoUpstream` | `veniceAdapter`, `comfyAdapter`, `ttsAdapter` | in-process doubles, and fake HTTP servers |

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
