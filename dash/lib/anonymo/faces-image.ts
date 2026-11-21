// Update "faces": the picture work, done in this browser with a canvas. One painted sheet is cut into six faces, and the
// art inside an imported card is made small enough to keep. Nothing here talks to the network.

import { SHEET_COLS, SHEET_ROWS, tileRects } from './faces.ts';

/** Base64 (what the gateway sends for an image) to a file-like Blob. */
export function b64ToBlob(b64: string, type = 'image/png'): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

type Surface = { ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D; toBlob: (type: string, quality: number) => Promise<Blob> };

function surface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (ctx) return { ctx, toBlob: (type, quality) => canvas.convertToBlob({ type, quality }) };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser could not open a canvas.');
  return {
    ctx,
    toBlob: (type, quality) =>
      new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('This browser could not save the picture.'))), type, quality)),
  };
}

/** Faces are kept as JPEG: every browser can write it, and a face on a plain ground stays small. */
const KEEP_TYPE = 'image/jpeg';
const KEEP_QUALITY = 0.9;
/** What shows through a see-through card image once it is flattened: the workspace's own ground. */
const GROUND = '#241027';

/** Cuts a painted sheet into its six faces, row by row. */
export async function sliceSheet(sheet: Blob): Promise<Blob[]> {
  const image = await createImageBitmap(sheet);
  try {
    const out: Blob[] = [];
    for (const r of tileRects(image.width, image.height, SHEET_COLS, SHEET_ROWS)) {
      const s = surface(r.w, r.h);
      s.ctx.drawImage(image, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      out.push(await s.toBlob(KEEP_TYPE, KEEP_QUALITY));
    }
    return out;
  } finally {
    image.close();
  }
}

/** A picture no larger than `max` on its longer side, flattened onto the workspace ground. Used for a card's own art. */
export async function shrink(picture: Blob, max = 768): Promise<Blob> {
  const image = await createImageBitmap(picture);
  try {
    const scale = Math.min(1, max / Math.max(image.width, image.height));
    const w = Math.max(1, Math.round(image.width * scale)), h = Math.max(1, Math.round(image.height * scale));
    const s = surface(w, h);
    s.ctx.fillStyle = GROUND;
    s.ctx.fillRect(0, 0, w, h);
    s.ctx.drawImage(image, 0, 0, w, h);
    return await s.toBlob(KEEP_TYPE, KEEP_QUALITY);
  } finally {
    image.close();
  }
}
