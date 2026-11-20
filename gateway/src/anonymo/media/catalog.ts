// The media launch set (Overview §2, "Same key, every medium"). Prices are EXAMPLE values until upstream contracts
// are signed (Backend, header note); they are per image, per 1k characters and per video second (Overview §5).
//
// Licensing rule: every self-hosted model must be Apache-2.0 (voice models may also be MIT), and FLUX [dev] is never
// listed under any name (non-commercial). Venice models are listed only under a `venice/` prefix, never relabelled
// one-for-one as ours (AGENTS.md), and only when configured: ANONYMO_VENICE_IMAGE_MODELS / ANONYMO_VENICE_VIDEO_MODELS
// take a comma-separated list of Venice model ids, because which ones the business agreement covers is not settled.
// Hosted models bought through NanoGPT keep their maker's prefix and are listed only with ANONYMO_NANOGPT_API_KEY.

import { NANOGPT_IMAGE_MODELS } from "./nanogpt-models.ts";

export { NANOGPT_IMAGE_MODELS } from "./nanogpt-models.ts";

export type MediaKind = "image" | "speech" | "video";
export type Upstream = "venice" | "comfyui" | "tts" | "nanogpt";
type Base = { id: string; upstream: Upstream; upstreamModel: string; family: string; license: string; name: string };
export const DEFAULT_MAX_IMAGES = 4;
export type ImageModel = Base & { kind: "image"; usdPerImage: string; edit: boolean; sizes: string[]; defaultSize: string; maxImages?: number };
export type SpeechModel = Base & { kind: "speech"; usdPer1kChars: string; voices: string[]; maxChars: number };
export type VideoModel = Base & { kind: "video"; usdPerSecond: string; seconds: [number, number]; allowedSeconds?: readonly number[]; defaultSeconds: number; sizes: string[]; defaultSize: string };
export type MediaModel = ImageModel | SpeechModel | VideoModel;

const SQUARE_AND_WIDE = ["1024x1024", "1152x896", "896x1152", "1216x832", "832x1216", "1344x768", "768x1344"];

// Kokoro v1.0's 54 stock voices (American, British, Japanese, Mandarin, Spanish, French, Hindi, Italian, Portuguese).
export const KOKORO_VOICES = [
  "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
  "jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo",
  "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi", "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang",
  "ef_dora", "em_alex", "em_santa", "ff_siwis", "hf_alpha", "hf_beta", "hm_omega", "hm_psi", "if_sara", "im_nicola",
  "pf_dora", "pm_alex", "pm_santa",
];
// (U) Qwen3-TTS preset speakers; VoxCPM2 and Chatterbox clone from a reference clip, so their "stock voices" are
// reference clips Anonymo licenses and keeps on the TTS worker (WS10), selected by these ids. A caller can never
// supply a clip.
export const QWEN3_TTS_VOICES = ["cherry", "ethan", "chelsie", "serena", "dylan", "jada", "sunny"];
export const VOXCPM2_VOICES = ["vox-ava", "vox-ben", "vox-cleo", "vox-dan"];
export const CHATTERBOX_VOICES = ["cb-default", "cb-ava", "cb-ben"];

export const BUILTIN_MODELS: MediaModel[] = [
  // ---- Images: self-hosted on ComfyUI workers --------------------------------------------------------------------
  { kind: "image", id: "chroma", name: "Chroma", upstream: "comfyui", upstreamModel: "chroma", family: "chroma", license: "Apache-2.0", usdPerImage: "0.010", edit: false, sizes: SQUARE_AND_WIDE, defaultSize: "1024x1024" },
  { kind: "image", id: "z-image-turbo", name: "Z-Image Turbo", upstream: "comfyui", upstreamModel: "z-image-turbo", family: "z-image", license: "Apache-2.0", usdPerImage: "0.006", edit: false, sizes: SQUARE_AND_WIDE, defaultSize: "1024x1024" },
  { kind: "image", id: "qwen-image", name: "Qwen-Image", upstream: "comfyui", upstreamModel: "qwen-image", family: "qwen", license: "Apache-2.0", usdPerImage: "0.020", edit: false, sizes: SQUARE_AND_WIDE, defaultSize: "1024x1024" },
  { kind: "image", id: "qwen-image-edit", name: "Qwen-Image Edit", upstream: "comfyui", upstreamModel: "qwen-image-edit", family: "qwen", license: "Apache-2.0", usdPerImage: "0.025", edit: true, sizes: SQUARE_AND_WIDE, defaultSize: "1024x1024" },
  { kind: "image", id: "flux.1-schnell", name: "FLUX.1 [schnell]", upstream: "comfyui", upstreamModel: "flux.1-schnell", family: "flux", license: "Apache-2.0", usdPerImage: "0.004", edit: false, sizes: SQUARE_AND_WIDE, defaultSize: "1024x1024" },
  { kind: "image", id: "flux.2-klein-4b", name: "FLUX.2 [klein] 4B", upstream: "comfyui", upstreamModel: "flux.2-klein-4b", family: "flux", license: "Apache-2.0", usdPerImage: "0.008", edit: false, sizes: SQUARE_AND_WIDE, defaultSize: "1024x1024" },
  // ---- Voice: OpenAI-compatible TTS workers, stock voices only ---------------------------------------------------
  { kind: "speech", id: "kokoro", name: "Kokoro", upstream: "tts", upstreamModel: "kokoro", family: "kokoro", license: "Apache-2.0", usdPer1kChars: "0.015", voices: KOKORO_VOICES, maxChars: 4096 },
  { kind: "speech", id: "qwen3-tts", name: "Qwen3-TTS", upstream: "tts", upstreamModel: "qwen3-tts", family: "qwen", license: "Apache-2.0", usdPer1kChars: "0.030", voices: QWEN3_TTS_VOICES, maxChars: 4096 },
  { kind: "speech", id: "voxcpm2", name: "VoxCPM2", upstream: "tts", upstreamModel: "voxcpm2", family: "voxcpm", license: "Apache-2.0", usdPer1kChars: "0.030", voices: VOXCPM2_VOICES, maxChars: 4096 },
  { kind: "speech", id: "chatterbox", name: "Chatterbox", upstream: "tts", upstreamModel: "chatterbox", family: "chatterbox", license: "MIT", usdPer1kChars: "0.030", voices: CHATTERBOX_VOICES, maxChars: 4096 },
  // ---- Video: Wan 2.2 on ComfyUI workers, asynchronous ------------------------------------------------------------
  { kind: "video", id: "wan-2.2", name: "Wan 2.2", upstream: "comfyui", upstreamModel: "wan-2.2", family: "wan", license: "Apache-2.0", usdPerSecond: "0.050", seconds: [2, 8], defaultSeconds: 5, sizes: ["1280x704", "704x1280", "832x480", "480x832"], defaultSize: "1280x704" },
];

const FORBIDDEN = /flux.{0,10}\bdev\b/i; // FLUX.1 [dev], flux1-dev, FLUX.2 [dev], flux-dev …
const SELF_HOSTED_LICENSES: Record<MediaKind, string[]> = { image: ["Apache-2.0"], video: ["Apache-2.0"], speech: ["Apache-2.0", "MIT"] };

/** Throws for a model the licensing rule forbids. Run over the whole catalog at startup and in tests. */
export function assertLicensed(m: MediaModel) {
  if (FORBIDDEN.test(m.id) || FORBIDDEN.test(m.upstreamModel) || FORBIDDEN.test(m.name)) throw new Error(`${m.id}: FLUX [dev] is non-commercial and never served`);
  if (m.upstream === "venice") {
    if (!m.id.startsWith("venice/")) throw new Error(`${m.id}: Venice models are listed only under venice/…`);
    return;
  }
  if (m.upstream === "nanogpt") {
    if (!(m.kind === "video" ? /^(alibaba|kling|bytedance|google|lightricks)\// : /^(google|openai|bfl|ideogram|recraft|krea|xai)\//).test(m.id))
      throw new Error(`${m.id}: NanoGPT models keep their maker's prefix`);
    return;
  }
  if (!SELF_HOSTED_LICENSES[m.kind].includes(m.license)) throw new Error(`${m.id}: self-hosted ${m.kind} models must be ${SELF_HOSTED_LICENSES[m.kind].join(" or ")} (got ${m.license})`);
}

const VENICE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
function veniceModels(env: Record<string, string | undefined>): MediaModel[] {
  const ids = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter((s) => VENICE_ID.test(s));
  return [
    ...ids(env.ANONYMO_VENICE_IMAGE_MODELS).map((m): ImageModel => ({ kind: "image", id: `venice/${m}`, name: `${m} (Built in Venice)`, upstream: "venice", upstreamModel: m, family: "venice", license: "venice-terms", usdPerImage: env.ANONYMO_VENICE_IMAGE_USD ?? "0.020", edit: false, sizes: SQUARE_AND_WIDE, defaultSize: "1024x1024" })),
    ...ids(env.ANONYMO_VENICE_VIDEO_MODELS).map((m): VideoModel => ({ kind: "video", id: `venice/${m}`, name: `${m} (Built in Venice)`, upstream: "venice", upstreamModel: m, family: "venice", license: "venice-terms", usdPerSecond: env.ANONYMO_VENICE_VIDEO_USD_PER_S ?? "0.100", seconds: [5, 10], defaultSeconds: 5, sizes: ["1280x720", "720x1280"], defaultSize: "1280x720" })),
  ];
}

type NanoGptVideoModel = Pick<VideoModel, "id" | "name" | "family" | "upstreamModel" | "usdPerSecond" | "seconds" | "allowedSeconds" | "defaultSeconds"> & {
  envUsd: string;
  numericDuration?: boolean;
  audioSwitch?: "enable_audio" | "generateAudio" | "save_audio";
};
export const NANOGPT_VIDEO_MODELS: readonly NanoGptVideoModel[] = [
  { id: "alibaba/wan-3.0", upstreamModel: "alibaba/wan-3.0/text-to-video", name: "Wan 3.0", family: "wan", usdPerSecond: "0.125", envUsd: "ANONYMO_NANOGPT_VIDEO_USD_WAN_3_0", seconds: [2, 30], defaultSeconds: 5, numericDuration: true, audioSwitch: "enable_audio" },
  { id: "kling/kling-3.0-turbo", upstreamModel: "kling-v3-turbo-standard", name: "Kling 3.0 Turbo", family: "kling", usdPerSecond: "0.140", envUsd: "ANONYMO_NANOGPT_VIDEO_USD_KLING_3_0_TURBO", seconds: [3, 15], defaultSeconds: 5 },
  { id: "bytedance/seedance-2.0-fast", upstreamModel: "bytedance-seedance-2-0-fast", name: "Seedance 2.0 Fast", family: "seedance", usdPerSecond: "0.150", envUsd: "ANONYMO_NANOGPT_VIDEO_USD_SEEDANCE_2_0_FAST", seconds: [5, 15], allowedSeconds: [5, 10, 15], defaultSeconds: 5 },
  { id: "google/veo-3.1-lite", upstreamModel: "veo3-1-lite-video", name: "Veo 3.1 Lite", family: "veo", usdPerSecond: "0.065", envUsd: "ANONYMO_NANOGPT_VIDEO_USD_VEO_3_1_LITE", seconds: [4, 8], allowedSeconds: [4, 6, 8], defaultSeconds: 8 },
  { id: "lightricks/ltx-2.3-fast", upstreamModel: "lightricks/ltx-2.3/fast", name: "LTX 2.3 Fast", family: "ltx", usdPerSecond: "0.040", envUsd: "ANONYMO_NANOGPT_VIDEO_USD_LTX_2_3_FAST", seconds: [6, 20], allowedSeconds: [6, 8, 10, 12, 14, 16, 18, 20], defaultSeconds: 6, audioSwitch: "generateAudio" },
];
const USD = /^\d+(\.\d{1,6})?$/;
function nanogptModels(env: Record<string, string | undefined>): MediaModel[] {
  if (!env.ANONYMO_NANOGPT_API_KEY?.trim()) return [];
  const price = (key: string, fallback: string) => {
    const usd = env[key]?.trim() || fallback;
    if (!USD.test(usd)) throw new Error(`${key} must be a dollar amount`);
    return usd;
  };
  return [
    ...NANOGPT_IMAGE_MODELS.map((m): ImageModel => ({
      kind: "image", id: m.id, name: m.name, upstream: "nanogpt", upstreamModel: m.upstreamModel, family: m.family,
      license: "provider-terms", usdPerImage: price(m.envUsd, m.usd), edit: false, sizes: m.sizes, defaultSize: "1024x1024", maxImages: m.maxImages,
    })),
    ...NANOGPT_VIDEO_MODELS.map((m): VideoModel => ({
      kind: "video", id: m.id, name: m.name, upstream: "nanogpt", upstreamModel: m.upstreamModel, family: m.family,
      license: "provider-terms", usdPerSecond: price(m.envUsd, m.usdPerSecond), seconds: m.seconds,
      allowedSeconds: m.allowedSeconds, defaultSeconds: m.defaultSeconds, sizes: ["1280x720", "720x1280"], defaultSize: "1280x720",
    })),
  ];
}

export class MediaCatalog {
  readonly models: MediaModel[];
  constructor(models: MediaModel[]) {
    for (const m of models) assertLicensed(m);
    const ids = new Set<string>();
    for (const m of models) {
      if (ids.has(m.id)) throw new Error(`duplicate media model ${m.id}`);
      ids.add(m.id);
    }
    this.models = models;
  }
  static fromEnv(env: Record<string, string | undefined>) {
    return new MediaCatalog([...BUILTIN_MODELS, ...veniceModels(env), ...nanogptModels(env)]);
  }
  get<K extends MediaKind>(kind: K, id: unknown): Extract<MediaModel, { kind: K }> | null {
    return (this.models.find((m) => m.kind === kind && m.id === id) as Extract<MediaModel, { kind: K }>) ?? null;
  }
}
