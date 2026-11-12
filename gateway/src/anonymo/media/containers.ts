// Where a C2PA manifest store lives inside each output format Anonymo returns (C2PA 2.x, "Embedding manifests"):
//   image/png  a `caBX` chunk before IEND
//   audio/wav  a `C2PA` chunk at the end of the RIFF file
//   video/mp4  a top-level `uuid` box with the C2PA UUID, appended after the last box (no offsets move)
// Any other format has no container here, so stamping it throws and the output is never returned.

import { ascii, concatBytes, readU32be, readU32le, te, u32be, u32le } from "./bytes.ts";
import { insertBeforeIend, isPng, pngChunk, pngChunks } from "./png.ts";

export type Located = { store: Uint8Array; offset: number; length: number };
export type Container = {
  mime: string;
  matches(b: Uint8Array): boolean;
  /** The asset without metadata Anonymo never passes on: any manifest store it already carries (an upstream's own),
   *  and text or tag chunks an upstream may have written (ComfyUI writes the workflow, prompt included). */
  strip(b: Uint8Array): Uint8Array;
  /** Wrap a manifest store, insert it, and say where the wrapped unit landed (that range is the hash exclusion). */
  insert(b: Uint8Array, store: Uint8Array): { bytes: Uint8Array; offset: number; length: number };
  extract(b: Uint8Array): Located | null;
};

// ---- PNG -----------------------------------------------------------------------------------------------------------
const PNG_KEEP = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND", "gAMA", "cHRM", "sRGB", "iCCP", "pHYs", "sBIT"]);
const png: Container = {
  mime: "image/png",
  matches: isPng,
  strip(b) {
    const chunks = pngChunks(b);
    return concatBytes([b.subarray(0, 8), ...chunks.filter((c) => PNG_KEEP.has(c.type)).map((c) => b.subarray(c.start, c.end))]);
  },
  insert(b, store) {
    const unit = pngChunk("caBX", store);
    const { bytes, offset } = insertBeforeIend(b, unit);
    return { bytes, offset, length: unit.length };
  },
  extract(b) {
    const c = pngChunks(b).find((x) => x.type === "caBX");
    return c ? { store: c.data, offset: c.start, length: c.end - c.start } : null;
  },
};

// ---- RIFF / WAV ----------------------------------------------------------------------------------------------------
type RiffChunk = { id: string; start: number; end: number; data: Uint8Array };
function riffChunks(b: Uint8Array): { end: number; chunks: RiffChunk[] } {
  if (b.length < 12 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  const end = Math.min(b.length, readU32le(b, 4) + 8);
  const chunks: RiffChunk[] = [];
  let at = 12;
  while (at + 8 <= end) {
    const size = readU32le(b, at + 4);
    const stop = at + 8 + size + (size & 1);
    if (at + 8 + size > end) throw new Error("truncated RIFF chunk");
    chunks.push({ id: ascii(b, at, 4), start: at, end: Math.min(stop, end), data: b.subarray(at + 8, at + 8 + size) });
    at = stop;
  }
  return { end, chunks };
}
const withRiffSize = (body: Uint8Array) => {
  const out = new Uint8Array(body);
  out.set(u32le(out.length - 8), 4);
  return out;
};
const wav: Container = {
  mime: "audio/wav",
  matches: (b) => b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WAVE",
  strip(b) {
    const { chunks } = riffChunks(b);
    return withRiffSize(concatBytes([b.subarray(0, 12), ...chunks.filter((c) => ["fmt ", "fact", "data"].includes(c.id)).map((c) => b.subarray(c.start, c.end))]));
  },
  insert(b, store) {
    const { end } = riffChunks(b);
    const unit = concatBytes([te.encode("C2PA"), u32le(store.length), store, store.length & 1 ? Uint8Array.of(0) : new Uint8Array()]);
    return { bytes: withRiffSize(concatBytes([b.subarray(0, end), unit])), offset: end, length: unit.length };
  },
  extract(b) {
    const c = riffChunks(b).chunks.find((x) => x.id === "C2PA");
    return c ? { store: c.data, offset: c.start, length: c.end - c.start } : null;
  },
};

// ---- ISO BMFF / MP4 ------------------------------------------------------------------------------------------------
export const C2PA_BMFF_UUID = Uint8Array.from(Buffer.from("d8fec3d61b0e483c92975828877ec481", "hex"));
type Box = { type: string; start: number; end: number; header: number };
function boxes(b: Uint8Array): Box[] {
  const out: Box[] = [];
  let at = 0;
  while (at + 8 <= b.length) {
    let size = readU32be(b, at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > b.length) throw new Error("truncated MP4 box");
      size = readU32be(b, at + 8) * 2 ** 32 + readU32be(b, at + 12);
      header = 16;
    } else if (size === 0) size = b.length - at;
    if (size < header || at + size > b.length) throw new Error("bad MP4 box size");
    out.push({ type: ascii(b, at + 4, 4), start: at, end: at + size, header });
    at += size;
  }
  if (at !== b.length || !out.length) throw new Error("not an MP4 file");
  return out;
}
const isC2paBox = (b: Uint8Array, x: Box) => x.type === "uuid" && C2PA_BMFF_UUID.every((v, i) => b[x.start + x.header + i] === v);
const MP4_PURPOSE = te.encode("manifest\0");
const mp4: Container = {
  mime: "video/mp4",
  matches: (b) => b.length >= 12 && ascii(b, 4, 4) === "ftyp",
  strip(b) {
    return concatBytes(boxes(b).filter((x) => !isC2paBox(b, x)).map((x) => b.subarray(x.start, x.end)));
  },
  insert(b, store) {
    const last = boxes(b).at(-1)!;
    if (readU32be(b, last.start) === 0) throw new Error("MP4 ends in an open-ended box; cannot append a manifest");
    const body = concatBytes([C2PA_BMFF_UUID, new Uint8Array(4), MP4_PURPOSE, new Uint8Array(8), store]);
    const unit = concatBytes([u32be(8 + body.length), te.encode("uuid"), body]);
    return { bytes: concatBytes([b, unit]), offset: b.length, length: unit.length };
  },
  extract(b) {
    const x = boxes(b).find((y) => isC2paBox(b, y));
    if (!x) return null;
    const at = x.start + x.header + 16 + 4 + MP4_PURPOSE.length + 8;
    return { store: b.subarray(at, x.end), offset: x.start, length: x.end - x.start };
  },
};

export const CONTAINERS: Record<string, Container> = { "image/png": png, "audio/wav": wav, "video/mp4": mp4 };
export const containerFor = (mime: string) => CONTAINERS[normalizeMime(mime)] ?? null;
export const normalizeMime = (mime: string) => {
  const m = mime.split(";")[0].trim().toLowerCase();
  return m === "audio/x-wav" || m === "audio/wave" ? "audio/wav" : m;
};
/** The format the bytes actually are, whatever an upstream claimed. */
export const sniffMime = (b: Uint8Array): string | null => Object.values(CONTAINERS).find((c) => {
  try {
    return c.matches(b);
  } catch {
    return false;
  }
})?.mime ?? null;
