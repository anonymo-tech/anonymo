// ComfyUI workflow graphs (API format) for the self-hosted models. The built-in graphs use ComfyUI core nodes and the
// weight file names WS10 is expected to provision (U: names and step counts are not yet checked against real
// workers). A deployment overrides any of them with ANONYMO_COMFY_WORKFLOWS_DIR/<model id>.json, an API-format export
// whose string values may be exactly "{{prompt}}", "{{negative}}", "{{seed}}", "{{width}}", "{{height}}",
// "{{frames}}", "{{fps}}" or "{{image}}". Values are substituted in the parsed tree, never by string splicing, so a
// prompt can never change the graph's shape.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type WorkflowVars = { prompt: string; negative: string; seed: number; width: number; height: number; frames?: number; fps?: number; image?: string };
type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

type Dit = { unet: string; clip: string; clipType: string; vae: string; steps: number; cfg: number; sampler: string; scheduler: string; shift?: number };
const DIT: Record<string, Dit> = {
  "flux.1-schnell": { unet: "flux1-schnell.safetensors", clip: "t5xxl_fp8_e4m3fn.safetensors", clipType: "flux", vae: "ae.safetensors", steps: 4, cfg: 1, sampler: "euler", scheduler: "simple" },
  "flux.2-klein-4b": { unet: "flux2-klein-4b.safetensors", clip: "qwen3_4b.safetensors", clipType: "flux2", vae: "flux2-vae.safetensors", steps: 4, cfg: 1, sampler: "euler", scheduler: "simple" },
  chroma: { unet: "chroma-hd.safetensors", clip: "t5xxl_fp8_e4m3fn.safetensors", clipType: "chroma", vae: "ae.safetensors", steps: 26, cfg: 4, sampler: "euler", scheduler: "beta" },
  "z-image-turbo": { unet: "z_image_turbo_bf16.safetensors", clip: "qwen_3_4b.safetensors", clipType: "lumina2", vae: "ae.safetensors", steps: 8, cfg: 1, sampler: "res_multistep", scheduler: "simple", shift: 3 },
  "qwen-image": { unet: "qwen_image_fp8_e4m3fn.safetensors", clip: "qwen_2.5_vl_7b_fp8_scaled.safetensors", clipType: "qwen_image", vae: "qwen_image_vae.safetensors", steps: 20, cfg: 2.5, sampler: "euler", scheduler: "simple", shift: 3 },
  "qwen-image-edit": { unet: "qwen_image_edit_fp8_e4m3fn.safetensors", clip: "qwen_2.5_vl_7b_fp8_scaled.safetensors", clipType: "qwen_image", vae: "qwen_image_vae.safetensors", steps: 20, cfg: 2.5, sampler: "euler", scheduler: "simple", shift: 3 },
};

function textToImage(d: Dit, v: WorkflowVars): Graph {
  const g: Graph = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: d.unet, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: d.clip, type: d.clipType } },
    "3": { class_type: "VAELoader", inputs: { vae_name: d.vae } },
    "4": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: v.prompt } },
    "5": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: v.negative } },
    "6": { class_type: "EmptySD3LatentImage", inputs: { width: v.width, height: v.height, batch_size: 1 } },
    "7": { class_type: "KSampler", inputs: { model: d.shift ? ["10", 0] : ["1", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0], seed: v.seed, steps: d.steps, cfg: d.cfg, sampler_name: d.sampler, scheduler: d.scheduler, denoise: 1 } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "anonymo" } },
  };
  if (d.shift) g["10"] = { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: d.shift } };
  return g;
}

function imageEdit(d: Dit, v: WorkflowVars): Graph {
  const g = textToImage(d, v);
  g["11"] = { class_type: "LoadImage", inputs: { image: v.image } };
  g["12"] = { class_type: "ImageScaleToTotalPixels", inputs: { image: ["11", 0], upscale_method: "lanczos", megapixels: 1 } };
  g["13"] = { class_type: "VAEEncode", inputs: { pixels: ["12", 0], vae: ["3", 0] } };
  g["4"] = { class_type: "TextEncodeQwenImageEdit", inputs: { clip: ["2", 0], prompt: v.prompt, vae: ["3", 0], image: ["12", 0] } };
  g["5"] = { class_type: "TextEncodeQwenImageEdit", inputs: { clip: ["2", 0], prompt: v.negative, vae: ["3", 0] } };
  g["7"].inputs.latent_image = ["13", 0];
  delete g["6"];
  return g;
}

function wan22(v: WorkflowVars): Graph {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "wan2.2_ti2v_5B_fp16.safetensors", weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", type: "wan" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "wan2.2_vae.safetensors" } },
    "4": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: v.prompt } },
    "5": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: v.negative } },
    "6": { class_type: "Wan22ImageToVideoLatent", inputs: { vae: ["3", 0], width: v.width, height: v.height, length: v.frames, batch_size: 1 } },
    "7": { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: 8 } },
    "8": { class_type: "KSampler", inputs: { model: ["7", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0], seed: v.seed, steps: 20, cfg: 5, sampler_name: "uni_pc", scheduler: "simple", denoise: 1 } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "CreateVideo", inputs: { images: ["9", 0], fps: v.fps } },
    "11": { class_type: "SaveVideo", inputs: { video: ["10", 0], filename_prefix: "anonymo", format: "mp4", codec: "h264" } },
  };
}

const PLACEHOLDER = /^\{\{(prompt|negative|seed|width|height|frames|fps|image)\}\}$/;
function substitute(node: unknown, v: WorkflowVars): unknown {
  if (typeof node === "string") {
    const m = PLACEHOLDER.exec(node);
    return m ? (v as Record<string, unknown>)[m[1]] : node;
  }
  if (Array.isArray(node)) return node.map((x) => substitute(x, v));
  if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, x]) => [k, substitute(x, v)]));
  return node;
}

export type WorkflowSet = { build(model: string, v: WorkflowVars): Graph };

export function workflowSet(dir?: string): WorkflowSet {
  return {
    build(model, v) {
      const file = dir ? join(dir, `${model}.json`) : null;
      if (file && /^[a-z0-9.-]+$/.test(model) && existsSync(file)) return substitute(JSON.parse(readFileSync(file, "utf8")), v) as Graph;
      if (model === "wan-2.2") return wan22(v);
      const d = DIT[model];
      if (!d) throw new Error(`no ComfyUI workflow for ${model}`);
      return model === "qwen-image-edit" ? imageEdit(d, v) : textToImage(d, v);
    },
  };
}
