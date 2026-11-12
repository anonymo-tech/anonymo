// The invisible watermark every output carries next to its C2PA manifest (EU AI Act Art. 50 asks for both a label
// and a machine-readable mark). A manifest can be stripped with the file's metadata; the watermark lives in the
// pixels or samples themselves.
//
// Built in ("anonymo-lsb-v1"): a keyed spread watermark in the least significant bit of the blue channel of a PNG,
// or of 16-bit PCM samples in a WAV. 96 bits (a 32-bit tag plus a 64-bit id) are each repeated at up to 31 positions
// chosen by an HMAC-keyed generator, and read back by majority vote, so a reader without the key sees noise in the
// LSB plane and a reader with it recovers the id even after scattered bit damage. It is invisible and inaudible
// (a change of at most 1/255 or 1/32768), but it does NOT survive lossy re-encoding, resizing or cropping. A robust
// learned watermark (TrustMark, VideoSeal, AudioSeal class) belongs in the worker sidecar: HttpWatermarker below
// speaks to one, and it is the only way MP4 output gets a watermark at all.

import { bytesEqual, concatBytes, hmacBytes, readU32le, te } from "./bytes.ts";
import { decodePng, encodePng, isPng, pngChunks } from "./png.ts";
import { normalizeMime } from "./containers.ts";

export const LSB_ALG = "anonymo-lsb-v1";
export type WatermarkMark = { alg: string; id: string }; // id: 16 hex chars
export interface Watermarker {
  supports(mime: string): boolean;
  embed(bytes: Uint8Array, mime: string, id: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mark: WatermarkMark }>;
  detect(bytes: Uint8Array, mime: string, signal?: AbortSignal): Promise<WatermarkMark | null>;
}

const TAG = te.encode("AnWm");
const MESSAGE_BITS = 96;
const MAX_REPEAT = 31;

function messageBits(id: string): Uint8Array {
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Error("watermark id must be 16 hex characters");
  const bytes = concatBytes([TAG, Uint8Array.from(Buffer.from(id, "hex"))]);
  const bits = new Uint8Array(MESSAGE_BITS);
  for (let i = 0; i < MESSAGE_BITS; i++) bits[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  return bits;
}

/** The carrier positions for each message bit: distinct, keyed, independent of the content. */
function positions(key: Uint8Array, slots: number): { repeat: number; at: Uint32Array } {
  const repeat = Math.min(MAX_REPEAT, Math.floor(slots / MESSAGE_BITS));
  if (repeat < 3) throw new Error("media too small to carry a watermark");
  const need = repeat * MESSAGE_BITS;
  const at = new Uint32Array(need);
  const used = new Uint8Array(slots);
  let block = new Uint8Array();
  let counter = 0, offset = 0;
  for (let i = 0; i < need; ) {
    if (offset + 4 > block.length) {
      block = hmacBytes(key, `${LSB_ALG}:${slots}:${counter++}`);
      offset = 0;
    }
    const v = readU32le(block, offset) % slots;
    offset += 4;
    if (used[v]) continue;
    used[v] = 1;
    at[i++] = v;
  }
  return { repeat, at };
}

type Carrier = { slots: number; get(i: number): number; set(i: number, bit: number): void; finish(): Uint8Array };

function pngCarrier(bytes: Uint8Array): Carrier {
  const img = decodePng(bytes);
  const keep = pngChunks(bytes);
  const pixel = (i: number) => i * img.channels + 2; // blue channel
  return {
    slots: img.width * img.height,
    get: (i) => img.pixels[pixel(i)] & 1,
    set: (i, bit) => void (img.pixels[pixel(i)] = (img.pixels[pixel(i)] & 0xfe) | bit),
    finish: () => encodePng(img, keep),
  };
}

function wavCarrier(bytes: Uint8Array): Carrier {
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF" || String.fromCharCode(...bytes.subarray(8, 12)) !== "WAVE") throw new Error("not a WAV file");
  let at = 12, fmt: Uint8Array | null = null, data: { start: number; size: number } | null = null;
  const end = Math.min(bytes.length, readU32le(bytes, 4) + 8);
  while (at + 8 <= end) {
    const id = String.fromCharCode(...bytes.subarray(at, at + 4));
    const size = readU32le(bytes, at + 4);
    if (id === "fmt ") fmt = bytes.subarray(at + 8, at + 8 + size);
    if (id === "data") data = { start: at + 8, size: Math.min(size, end - at - 8) };
    at += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error("WAV without fmt or data");
  const format = fmt[0] | (fmt[1] << 8), bitsPerSample = fmt[14] | (fmt[15] << 8);
  if ((format !== 1 && format !== 0xfffe) || bitsPerSample !== 16) throw new Error("watermark needs 16-bit PCM WAV");
  const out = new Uint8Array(bytes);
  const sample = (i: number) => data!.start + i * 2; // low byte of a little-endian sample
  return {
    slots: Math.floor(data.size / 2),
    get: (i) => out[sample(i)] & 1,
    set: (i, bit) => void (out[sample(i)] = (out[sample(i)] & 0xfe) | bit),
    finish: () => out,
  };
}

const carrierFor = (bytes: Uint8Array, mime: string): Carrier => {
  const m = normalizeMime(mime);
  if (m === "image/png" && isPng(bytes)) return pngCarrier(bytes);
  if (m === "audio/wav") return wavCarrier(bytes);
  throw new Error(`no built-in watermark for ${m}`);
};

/** The built-in keyed LSB watermark for PNG images and 16-bit WAV audio. */
export function lsbWatermarker(key: Uint8Array): Watermarker {
  return {
    supports: (mime) => ["image/png", "audio/wav"].includes(normalizeMime(mime)),
    async embed(bytes, mime, id) {
      const c = carrierFor(bytes, mime);
      const bits = messageBits(id);
      const { repeat, at } = positions(key, c.slots);
      for (let b = 0; b < MESSAGE_BITS; b++) for (let r = 0; r < repeat; r++) c.set(at[b * repeat + r], bits[b]);
      return { bytes: c.finish(), mark: { alg: LSB_ALG, id } };
    },
    async detect(bytes, mime) {
      let c: Carrier;
      try {
        c = carrierFor(bytes, mime);
      } catch {
        return null;
      }
      let layout;
      try {
        layout = positions(key, c.slots);
      } catch {
        return null;
      }
      const { repeat, at } = layout;
      const out = new Uint8Array(MESSAGE_BITS / 8);
      for (let b = 0; b < MESSAGE_BITS; b++) {
        let ones = 0;
        for (let r = 0; r < repeat; r++) ones += c.get(at[b * repeat + r]);
        if (ones * 2 > repeat) out[b >> 3] |= 1 << (7 - (b & 7));
      }
      if (!bytesEqual(out.subarray(0, 4), TAG)) return null;
      return { alg: LSB_ALG, id: Buffer.from(out.subarray(4)).toString("hex") };
    },
  };
}

/**
 * A watermark sidecar (WS10 runs it next to the ComfyUI workers). Contract, defined here:
 *   POST {base}/v1/watermark/embed   body = media bytes, content-type = mime, x-watermark-id = 16 hex
 *        → 200 with the marked bytes in the same format, x-watermark-alg = the algorithm used
 *   POST {base}/v1/watermark/detect  body = media bytes → 200 {"alg": "...", "id": "16 hex"} or 404 when none is found
 */
export function httpWatermarker(base: string, opts: { token?: string; mimes: string[]; timeoutMs?: number; fetch?: typeof fetch }): Watermarker {
  const f = opts.fetch ?? fetch;
  const url = (p: string) => base.replace(/\/$/, "") + p;
  const headers = (mime: string, extra: Record<string, string> = {}) => ({ "content-type": mime, ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...extra });
  const signalOf = (s?: AbortSignal) => AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? 60_000), ...(s ? [s] : [])]);
  return {
    supports: (mime) => opts.mimes.includes(normalizeMime(mime)),
    async embed(bytes, mime, id, signal) {
      const r = await f(url("/v1/watermark/embed"), { method: "POST", headers: headers(mime, { "x-watermark-id": id }), body: bytes, signal: signalOf(signal) });
      if (!r.ok) throw new Error(`watermark sidecar returned ${r.status}`);
      const out = new Uint8Array(await r.arrayBuffer());
      if (!out.length) throw new Error("watermark sidecar returned no media");
      return { bytes: out, mark: { alg: r.headers.get("x-watermark-alg") || "sidecar", id } };
    },
    async detect(bytes, mime, signal) {
      const r = await f(url("/v1/watermark/detect"), { method: "POST", headers: headers(mime), body: bytes, signal: signalOf(signal) });
      if (r.status === 404 || !r.ok) return null;
      const j = (await r.json()) as { alg?: string; id?: string };
      return j.id && /^[0-9a-f]{16}$/.test(j.id) ? { alg: j.alg || "sidecar", id: j.id } : null;
    },
  };
}

/** The first watermarker that supports a format wins; a format none supports is refused (the output is not returned). */
export function chainWatermarkers(list: Watermarker[]): Watermarker {
  const pick = (mime: string) => list.find((w) => w.supports(mime));
  return {
    supports: (mime) => !!pick(mime),
    async embed(bytes, mime, id, signal) {
      const w = pick(mime);
      if (!w) throw new Error(`no watermarker for ${normalizeMime(mime)}`);
      return w.embed(bytes, mime, id, signal);
    },
    async detect(bytes, mime, signal) {
      for (const w of list.filter((x) => x.supports(mime))) {
        const m = await w.detect(bytes, mime, signal);
        if (m) return m;
      }
      return null;
    },
  };
}
