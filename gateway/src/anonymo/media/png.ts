// A minimal PNG codec: chunk walking, and decode/encode of 8-bit, non-interlaced RGB and RGBA images. That is what
// the ComfyUI workers and Venice return when asked for PNG, and what the pixel watermark needs. Anything else (palette,
// 16-bit, interlaced) throws, so the caller fails closed instead of returning an unmarked image.

import { deflateSync, inflateSync } from "node:zlib";
import { ascii, concatBytes, crc32, readU32be, te, u32be } from "./bytes.ts";

export const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

export type PngChunk = { type: string; data: Uint8Array; start: number; end: number };
export type RawImage = { width: number; height: number; channels: 3 | 4; pixels: Uint8Array };

export const isPng = (b: Uint8Array) => b.length >= 8 && PNG_SIGNATURE.every((v, i) => b[i] === v);

export function pngChunks(b: Uint8Array): PngChunk[] {
  if (!isPng(b)) throw new Error("not a PNG");
  const out: PngChunk[] = [];
  let at = 8;
  while (at + 12 <= b.length) {
    const len = readU32be(b, at);
    const type = ascii(b, at + 4, 4);
    const end = at + 12 + len;
    if (end > b.length) throw new Error("truncated PNG chunk");
    out.push({ type, data: b.subarray(at + 8, at + 8 + len), start: at, end });
    at = end;
    if (type === "IEND") break;
  }
  if (out.at(-1)?.type !== "IEND") throw new Error("PNG has no IEND");
  return out;
}

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const t = te.encode(type);
  return concatBytes([u32be(data.length), t, data, u32be(crc32(t, data))]);
}

/** Insert raw chunk bytes immediately before IEND. Returns the new file and the offset the chunk landed at. */
export function insertBeforeIend(b: Uint8Array, chunkBytes: Uint8Array): { bytes: Uint8Array; offset: number } {
  const iend = pngChunks(b).at(-1)!;
  return { bytes: concatBytes([b.subarray(0, iend.start), chunkBytes, b.subarray(iend.start)]), offset: iend.start };
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(b: Uint8Array): RawImage {
  const chunks = pngChunks(b);
  const ihdr = chunks[0];
  if (ihdr?.type !== "IHDR") throw new Error("PNG has no IHDR");
  const width = readU32be(ihdr.data, 0), height = readU32be(ihdr.data, 4);
  const [depth, colorType, , , interlace] = ihdr.data.subarray(8, 13);
  if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) throw new Error("unsupported PNG layout (need 8-bit RGB/RGBA, not interlaced)");
  if (!width || !height || width * height > 64_000_000) throw new Error("unsupported PNG size");
  const channels = colorType === 6 ? 4 : 3;
  const raw = new Uint8Array(inflateSync(concatBytes(chunks.filter((c) => c.type === "IDAT").map((c) => c.data))));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error("truncated PNG data");
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const up = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      const v = line[x];
      out[x] =
        filter === 0 ? v
        : filter === 1 ? v + a
        : filter === 2 ? v + up
        : filter === 3 ? v + ((a + up) >> 1)
        : filter === 4 ? v + paeth(a, up, c)
        : (() => { throw new Error("bad PNG filter"); })();
    }
  }
  return { width, height, channels, pixels };
}

/** Colour-rendering chunks only. Text and EXIF chunks never survive: ComfyUI's SaveImage writes the whole workflow,
 *  prompt included, into tEXt chunks, and Anonymo never returns or keeps prompt text. */
const KEPT_CHUNKS = new Set(["gAMA", "cHRM", "sRGB", "iCCP", "pHYs"]);

/** Encode pixels as a PNG, carrying over only the colour chunks of `keep` (see KEPT_CHUNKS). */
export function encodePng(img: RawImage, keep: PngChunk[] = []): Uint8Array {
  const stride = img.width * img.channels;
  const raw = new Uint8Array(img.height * (stride + 1));
  for (let y = 0; y < img.height; y++) raw.set(img.pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1); // filter 0 (none)
  const ihdr = concatBytes([u32be(img.width), u32be(img.height), Uint8Array.of(8, img.channels === 4 ? 6 : 2, 0, 0, 0)]);
  const ancillary = keep.filter((c) => KEPT_CHUNKS.has(c.type)).map((c) => pngChunk(c.type, c.data));
  return concatBytes([PNG_SIGNATURE, pngChunk("IHDR", ihdr), ...ancillary, pngChunk("IDAT", new Uint8Array(deflateSync(raw))), pngChunk("IEND", new Uint8Array())]);
}
