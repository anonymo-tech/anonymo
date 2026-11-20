export type ImageSizeFormat = "pixels" | "asterisk" | "aspect-ratio";

type NanoGptImageModel = {
  upstreamModel: string;
  id: string;
  name: string;
  family: string;
  usd: string;
  envUsd: string;
  sizes: string[];
  sizeFormat: ImageSizeFormat;
  maxImages: number;
  parameters?: { resolution?: "1k" | "2k"; output_format?: "png"; enable_safety_checker?: true };
};

export const NANOGPT_ASPECT_RATIOS: Readonly<Record<string, string>> = {
  "1024x1024": "1:1",
  "1344x768": "16:9", "768x1344": "9:16",
  "1184x864": "4:3", "864x1184": "3:4",
  "1280x720": "16:9", "720x1280": "9:16",
  "1536x1024": "3:2", "1024x1536": "2:3",
};

const WIDESCREEN = ["1024x1024", "1280x720", "720x1280"];
const FLUX_SIZES = [...WIDESCREEN, "1536x1024", "1024x1536"];
const STANDARD = ["1024x1024", "1536x1024", "1024x1536"];

export const NANOGPT_IMAGE_MODELS: readonly NanoGptImageModel[] = [
  {
    upstreamModel: "nano-banana", id: "google/nano-banana", name: "Nano Banana (Google)", family: "gemini",
    usd: "0.050", envUsd: "ANONYMO_NANOGPT_IMAGE_USD_NANO_BANANA",
    sizes: ["1024x1024", "1344x768", "768x1344", "1184x864", "864x1184"], sizeFormat: "aspect-ratio", maxImages: 4,
  },
  {
    upstreamModel: "gpt-image-2", id: "openai/gpt-image-2", name: "GPT Image 2 (OpenAI)", family: "gpt-image",
    usd: "0.080", envUsd: "ANONYMO_NANOGPT_IMAGE_USD_GPT_IMAGE_2",
    sizes: STANDARD, sizeFormat: "pixels", maxImages: 4,
  },
  {
    upstreamModel: "flux-2-max", id: "bfl/flux.2-max", name: "FLUX.2 [max]", family: "flux",
    usd: "0.090", envUsd: "ANONYMO_NANOGPT_IMAGE_USD_FLUX_2_MAX",
    sizes: FLUX_SIZES, sizeFormat: "asterisk", maxImages: 4,
  },
  {
    upstreamModel: "flux-2-flash", id: "bfl/flux.2-flash", name: "FLUX.2 [flash]", family: "flux",
    usd: "0.032", envUsd: "ANONYMO_NANOGPT_IMAGE_USD_FLUX_2_FLASH",
    sizes: FLUX_SIZES, sizeFormat: "asterisk", maxImages: 4,
  },
  {
    upstreamModel: "ideogram/v4.5", id: "ideogram/v4.5", name: "Ideogram V4.5", family: "ideogram",
    usd: "0.076", envUsd: "ANONYMO_NANOGPT_IMAGE_USD_IDEOGRAM_V4_5",
    sizes: [...WIDESCREEN, "1248x832", "832x1248"], sizeFormat: "pixels", maxImages: 8,
  },
  {
    upstreamModel: "recraft-ai/recraft-v4.1/text-to-image", id: "recraft/v4.1", name: "Recraft V4.1", family: "recraft",
    usd: "0.050", envUsd: "ANONYMO_NANOGPT_IMAGE_USD_RECRAFT_V4_1",
    sizes: ["1024x1024", "1024x576", "576x1024", "1024x768", "768x1024"], sizeFormat: "pixels", maxImages: 8,
    parameters: { enable_safety_checker: true },
  },
  {
    upstreamModel: "krea/v2/medium/text-to-image", id: "krea/krea-2-medium", name: "Krea 2 Medium", family: "krea",
    usd: "0.038", envUsd: "ANONYMO_NANOGPT_IMAGE_USD_KREA_2_MEDIUM",
    sizes: FLUX_SIZES, sizeFormat: "aspect-ratio", maxImages: 4,
  },
  {
    upstreamModel: "xai/grok-imagine-image/v2.0/text-to-image", id: "xai/grok-imagine-2", name: "Grok Imagine Image 2.0", family: "grok",
    usd: "0.076", envUsd: "ANONYMO_NANOGPT_IMAGE_USD_GROK_IMAGINE_2",
    sizes: FLUX_SIZES, sizeFormat: "aspect-ratio", maxImages: 4,
    // NanoGPT's 2K tier costs more than the public per-image price.
    parameters: { resolution: "1k", output_format: "png" },
  },
];
