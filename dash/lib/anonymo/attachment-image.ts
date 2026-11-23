// Features 02, 03 and 06: picture work for the attachment editor, done in this browser with a canvas. Nothing here
// talks to the network. Images are decoded the way they are shown (EXIF orientation applied), so a selection made on
// screen is the same region of the source. Every output is drawn onto a new canvas and encoded fresh as PNG: no EXIF,
// thumbnails, colour profiles, text chunks or other bytes of the original survive.

import { toPixels, type Rect } from './region.ts';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 8192;

export type DecodedImage = { name: string; bitmap: ImageBitmap; width: number; height: number };

/** Decodes an image file with its EXIF orientation applied. Throws a plain-language error for anything unusable. */
export async function decodeImage(file: File): Promise<DecodedImage> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file (PNG, JPEG or WebP).');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('Choose an image smaller than 20 MB.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('This image could not be opened. Try a PNG or JPEG.');
  }
  if (bitmap.width > MAX_IMAGE_SIDE || bitmap.height > MAX_IMAGE_SIDE) {
    bitmap.close();
    throw new Error('Choose an image no larger than 8192 pixels on a side.');
  }
  return { name: file.name.slice(0, 240), bitmap, width: bitmap.width, height: bitmap.height };
}

type Canvas = { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D };

function canvasOf(width: number, height: number): Canvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (ctx) return { canvas, ctx };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser could not open a canvas.');
  return { canvas, ctx };
}

async function pngOf(c: Canvas): Promise<Blob> {
  if ('convertToBlob' in c.canvas) return c.canvas.convertToBlob({ type: 'image/png' });
  const canvas = c.canvas;
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('This browser could not save the picture.'))), 'image/png'));
}

const dataUrlOf = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('The picture could not be read.')));
    reader.onerror = () => reject(new Error('The picture could not be read.'));
    reader.readAsDataURL(blob);
  });

/** The selected pixels only, on an opaque ground, scaled to at most `maxSide`, as a new PNG. */
export async function cropPng(source: CanvasImageSource & { width: number; height: number }, rect: Rect, maxSide = 1600) {
  const { sx, sy, sw, sh } = toPixels(rect, source.width, source.height);
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const width = Math.max(1, Math.round(sw * scale)), height = Math.max(1, Math.round(sh * scale));
  const c = canvasOf(width, height);
  c.ctx.fillStyle = '#ffffff';
  c.ctx.fillRect(0, 0, width, height);
  c.ctx.drawImage(source, sx, sy, sw, sh, 0, 0, width, height);
  const blob = await pngOf(c);
  return { blob, url: await dataUrlOf(blob), width, height };
}

/** Feature 06: the whole picture with every box filled opaque, flattened into a new PNG. The source is not touched. */
export async function flattenRedacted(source: CanvasImageSource & { width: number; height: number }, boxes: readonly Rect[], fill = '#000000') {
  const c = canvasOf(source.width, source.height);
  c.ctx.fillStyle = '#ffffff';
  c.ctx.fillRect(0, 0, source.width, source.height);
  c.ctx.drawImage(source, 0, 0);
  c.ctx.globalAlpha = 1;
  c.ctx.globalCompositeOperation = 'source-over';
  c.ctx.fillStyle = fill;
  for (const box of boxes) {
    const { sx, sy, sw, sh } = toPixels(box, source.width, source.height);
    c.ctx.fillRect(sx, sy, sw, sh);
  }
  return pngOf(c);
}

// ---- Detection with the browser's own Shape Detection API, where it exists. No engine is downloaded. --------------

type DetectedBox = { boundingBox: DOMRectReadOnly; rawValue?: string };
type Detector = { detect: (image: ImageBitmapSource) => Promise<DetectedBox[]> };
type DetectorClass = new (options?: { formats?: string[] }) => Detector;
const detectorClass = (name: 'TextDetector' | 'BarcodeDetector'): DetectorClass | null =>
  typeof globalThis !== 'undefined' && typeof (globalThis as Record<string, unknown>)[name] === 'function'
    ? ((globalThis as Record<string, unknown>)[name] as DetectorClass)
    : null;

export type DetectedText = { text: string; rect: Rect };

/** A platform detector that does not answer in time counts as unavailable, so the editor never waits forever. */
export const DETECT_TIMEOUT_MS = 4000;
function inTime<T>(work: Promise<T>, ms = DETECT_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Detection timed out.')), ms);
    work.then((v) => { clearTimeout(timer); resolve(v); }, (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error('Detection failed.')); });
  });
}
export const textDetectionSupported = () => detectorClass('TextDetector') !== null;

/** Local text recognition (TextDetector), boxes normalised to the image. null when this browser has none. */
export async function detectText(image: ImageBitmap | HTMLCanvasElement | OffscreenCanvas): Promise<DetectedText[] | null> {
  const Detector = detectorClass('TextDetector');
  if (!Detector) return null;
  try {
    const found = await inTime(new Detector().detect(image));
    return found
      .filter((f) => (f.rawValue ?? '').trim())
      .map((f) => ({ text: f.rawValue!.trim(), rect: normalise(f.boundingBox, image.width, image.height) }));
  } catch {
    return null;
  }
}

export async function qrDetectionSupported(): Promise<boolean> {
  const Detector = detectorClass('BarcodeDetector') as (DetectorClass & { getSupportedFormats?: () => Promise<string[]> }) | null;
  if (!Detector) return false;
  try {
    return !Detector.getSupportedFormats || (await inTime(Detector.getSupportedFormats())).includes('qr_code');
  } catch {
    return false;
  }
}

/** QR codes (BarcodeDetector), boxes normalised to the image. null when this browser cannot detect them. */
export async function detectQr(image: ImageBitmap): Promise<Rect[] | null> {
  if (!(await qrDetectionSupported())) return null;
  const Detector = detectorClass('BarcodeDetector')!;
  try {
    const found = await inTime(new Detector({ formats: ['qr_code'] }).detect(image));
    return found.map((f) => normalise(f.boundingBox, image.width, image.height));
  } catch {
    return null;
  }
}

function normalise(box: DOMRectReadOnly, width: number, height: number): Rect {
  const x = Math.max(0, box.x / width), y = Math.max(0, box.y / height);
  return { x, y, w: Math.min(1 - x, box.width / width), h: Math.min(1 - y, box.height / height) };
}
