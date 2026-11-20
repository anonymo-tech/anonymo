// Demo images: the mock gateway paints a picture in the browser from the prompt (no model runs, nothing leaves the
// device). Colours and shapes are seeded by the prompt, so the same prompt gives the same picture. Outside a browser
// (the dash checks) it returns a tiny solid PNG.

import type { MediaImageModel } from '../types.ts';

export const DEMO_IMAGE_MODELS: MediaImageModel[] = [
  { id: 'google/nano-banana', object: 'model', kind: 'image', name: 'Nano Banana (Google)', family: 'gemini', license: 'provider-terms', upstream: 'nanogpt', pricing: { usd_per_image: '0.050' }, edit: false, sizes: ['1024x1024', '1344x768', '768x1344', '1184x864', '864x1184'] },
  { id: 'openai/gpt-image-2', object: 'model', kind: 'image', name: 'GPT Image 2 (OpenAI)', family: 'gpt-image', license: 'provider-terms', upstream: 'nanogpt', pricing: { usd_per_image: '0.080' }, edit: false, sizes: ['1024x1024', '1536x1024', '1024x1536'] },
];

/** The same words the gateway's nudity rule refuses first (gateway src/anonymo/media/prompt-check.ts), in short. */
export const DEMO_NUDITY = /\b(?:nude|nudes|nudity|naked|topless|undress\w*|nsfw|porn\w*|xxx|hentai|sex|sexual|erotic\w*)\b/i;

// A 1x1 plum PNG.
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqP9fDwAFDAJAuIXa2QAAAABJRU5ErkJggg==';

function seeded(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

export async function demoImage(prompt: string, width: number, height: number, index = 0): Promise<string> {
  if (typeof OffscreenCanvas === 'undefined') return TINY_PNG;
  const scale = Math.min(1, 768 / Math.max(width, height));
  const w = Math.round(width * scale), h = Math.round(height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) return TINY_PNG;
  const rand = seeded(`${prompt}#${index}`);
  const hue = Math.floor(rand() * 360);
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, `hsl(${hue} 60% 22%)`);
  sky.addColorStop(0.55, `hsl(${(hue + 40) % 360} 70% 55%)`);
  sky.addColorStop(1, `hsl(${(hue + 70) % 360} 80% 72%)`);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  // A glowing disc in the sky.
  const sx = w * (0.2 + rand() * 0.6), sy = h * (0.18 + rand() * 0.25), sr = Math.min(w, h) * (0.08 + rand() * 0.08);
  const glow = ctx.createRadialGradient(sx, sy, sr * 0.2, sx, sy, sr * 3);
  glow.addColorStop(0, `hsl(${(hue + 50) % 360} 100% 92% / 0.95)`);
  glow.addColorStop(1, 'transparent');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = `hsl(${(hue + 50) % 360} 100% 94%)`;
  ctx.beginPath();
  ctx.arc(sx, sy, sr, 0, Math.PI * 2);
  ctx.fill();
  // Layered hills, darker toward the front.
  for (let layer = 0; layer < 4; layer++) {
    const base = h * (0.55 + layer * 0.11);
    ctx.fillStyle = `hsl(${(hue + 200 + layer * 12) % 360} ${35 + layer * 6}% ${30 - layer * 6}%)`;
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(0, base);
    const steps = 6 + Math.floor(rand() * 5);
    for (let i = 0; i <= steps; i++) ctx.lineTo((w * i) / steps, base - rand() * h * (0.12 - layer * 0.015));
    ctx.lineTo(w, h);
    ctx.fill();
  }
  // Grain.
  for (let i = 0; i < (w * h) / 60; i++) {
    ctx.fillStyle = `rgba(255,255,255,${rand() * 0.05})`;
    ctx.fillRect(rand() * w, rand() * h, 1, 1);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = `600 ${Math.round(h * 0.03)}px ui-monospace, monospace`;
  ctx.fillText('DEMO', Math.round(w * 0.03), Math.round(h * 0.96));
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
