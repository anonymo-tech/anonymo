// Synthetic media for the media suite: solid colours, generated patterns, a sine tone and a minimal MP4. No fixture
// depicts anyone; classifier scores in these tests are mock numbers keyed to a fixture's colour, never real scores.

import { concatBytes, te, u32be, u32le } from "../../src/anonymo/media/bytes.ts";
import { decodePng, encodePng, pngChunk } from "../../src/anonymo/media/png.ts";
import { chainWatermarkers, lsbWatermarker, type Watermarker } from "../../src/anonymo/media/watermark.ts";

export type Rgb = [number, number, number];

export function solidPng(width: number, height: number, rgb: Rgb, opts: { alpha?: boolean; text?: string } = {}): Uint8Array {
  const channels = opts.alpha ? 4 : 3;
  const pixels = new Uint8Array(width * height * channels);
  for (let i = 0; i < width * height; i++) pixels.set(opts.alpha ? [...rgb, 255] : rgb, i * channels);
  const png = encodePng({ width, height, channels, pixels });
  if (!opts.text) return png;
  // A tEXt chunk the way ComfyUI writes its workflow, inserted after IHDR.
  const ihdrEnd = 8 + 25;
  return concatBytes([png.subarray(0, ihdrEnd), pngChunk("tEXt", te.encode(`prompt\0${opts.text}`)), png.subarray(ihdrEnd)]);
}

export function gradientPng(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) pixels.set([(x * 255) / Math.max(1, width - 1), (y * 255) / Math.max(1, height - 1), (x ^ y) & 0xff], (y * width + x) * 3);
  return encodePng({ width, height, channels: 3, pixels });
}

/** The colour of the first pixel of a PNG we generated (filter 0 rows), for keying mock scores. */
export function firstPixel(png: Uint8Array): Rgb {
  const img = decodePng(png);
  return [img.pixels[0], img.pixels[1], img.pixels[2]];
}

export function toneWav(seconds = 0.5, rate = 16_000, hz = 440, extraChunk?: { id: string; text: string }): Uint8Array {
  const samples = Math.round(seconds * rate);
  const data = new Uint8Array(samples * 2);
  const view = new DataView(data.buffer);
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000), true);
  const fmt = concatBytes([Uint8Array.of(1, 0, 1, 0), u32le(rate), u32le(rate * 2), Uint8Array.of(2, 0, 16, 0)]);
  const extra = extraChunk ? concatBytes([te.encode(extraChunk.id), u32le(extraChunk.text.length), te.encode(extraChunk.text), extraChunk.text.length & 1 ? Uint8Array.of(0) : new Uint8Array()]) : new Uint8Array();
  const body = concatBytes([te.encode("WAVE"), te.encode("fmt "), u32le(16), fmt, extra, te.encode("data"), u32le(data.length), data]);
  return concatBytes([te.encode("RIFF"), u32le(body.length), body]);
}

const mp4Box = (type: string, payload: Uint8Array) => concatBytes([u32be(8 + payload.length), te.encode(type), payload]);
/** A structurally valid MP4 box sequence (ftyp, moov, mdat) with synthetic payload bytes. Not playable, and it need not be. */
export function tinyMp4(seed = 1): Uint8Array {
  const payload = new Uint8Array(4096).map((_, i) => (i * 31 + seed * 17) & 0xff);
  return concatBytes([mp4Box("ftyp", concatBytes([te.encode("isom"), u32be(512), te.encode("isomiso2mp41")])), mp4Box("moov", new Uint8Array(64)), mp4Box("mdat", payload)]);
}

/** Test double for the video watermark sidecar: a `free` box carrying "AnWm" + the id, appended at the end. */
export const mp4WatermarkDouble: Watermarker = {
  supports: (mime) => mime === "video/mp4",
  async embed(bytes, _mime, id) {
    return { bytes: concatBytes([bytes, mp4Box("free", concatBytes([te.encode("AnWm"), Uint8Array.from(Buffer.from(id, "hex"))]))]), mark: { alg: "test-mp4", id } };
  },
  async detect(bytes) {
    const tag = Buffer.from("AnWm");
    const at = Buffer.from(bytes).lastIndexOf(tag);
    return at < 0 ? null : { alg: "test-mp4", id: Buffer.from(bytes.subarray(at + 4, at + 12)).toString("hex") };
  },
};

export const TEST_WATERMARK_KEY = new Uint8Array(32).fill(7);
export const testWatermarker = () => chainWatermarkers([lsbWatermarker(TEST_WATERMARK_KEY), mp4WatermarkDouble]);
