// Provenance (seams.ts): every image, video and audio output gets an invisible watermark and then a signed C2PA
// manifest that binds the watermark's id and covers every other byte of the file. stamp() verifies its own output
// before returning it and throws otherwise, so media without provenance can never reach a caller.
// One exception: MP4 video when no watermarker handles video (the built-in one marks PNG only; video needs the
// sidecar). Then the video carries the signed manifest alone, and the manifest says so: its watermark is
// { alg: "none" }. verify() accepts "none" for MP4 video only, so an image without its watermark still fails.

import { randomBytes } from "node:crypto";
import type { Provenance } from "../seams.ts";
import { embedManifest, verifyManifest, type ManifestCheck, type ProvenanceKey } from "./c2pa.ts";
import { containerFor, normalizeMime, sniffMime } from "./containers.ts";
import type { Watermarker, WatermarkMark } from "./watermark.ts";

export class ProvenanceError extends Error {}

/** Formats that may carry the signed manifest without an invisible watermark when no watermarker supports them. */
export const MANIFEST_ONLY = new Set(["video/mp4"]);
const NO_WATERMARK: WatermarkMark = { alg: "none", id: "" };

export type ProvenanceCheck = { ok: boolean; manifest: ManifestCheck; watermark: WatermarkMark | null };

export interface MediaProvenance extends Provenance {
  /** Formats stamp() can mark: a C2PA container exists and a watermarker supports it. */
  supports(mime: string): boolean;
  verify(bytes: Uint8Array, signal?: AbortSignal): Promise<ProvenanceCheck>;
  /** Published verification keys, current first. */
  keys(): { keyId: string; publicKeyHex: string }[];
}

export function createProvenance(deps: { key: ProvenanceKey; watermarker: Watermarker; previousKeys?: { keyId: string; publicKeyHex: string }[]; now?: () => Date }): MediaProvenance {
  const known = new Map([[deps.key.keyId, deps.key.publicKeyHex], ...(deps.previousKeys ?? []).map((k) => [k.keyId, k.publicKeyHex] as const)]);
  const publicKeyOf = (id: string) => known.get(id) ?? null;

  async function verify(bytes: Uint8Array, signal?: AbortSignal): Promise<ProvenanceCheck> {
    const manifest = verifyManifest(bytes, publicKeyOf);
    const mime = sniffMime(bytes);
    if (manifest.ok && manifest.generation.watermark.alg === NO_WATERMARK.alg)
      return { ok: !!mime && MANIFEST_ONLY.has(mime), manifest, watermark: null };
    const watermark = mime ? await deps.watermarker.detect(bytes, mime, signal).catch(() => null) : null;
    return { ok: manifest.ok && !!watermark && watermark.id === manifest.generation.watermark.id, manifest, watermark };
  }

  return {
    supports: (mime) => !!containerFor(mime) && (deps.watermarker.supports(mime) || MANIFEST_ONLY.has(normalizeMime(mime))),
    keys: () => [...known].map(([keyId, publicKeyHex]) => ({ keyId, publicKeyHex })),
    verify,
    async stamp(bytes, mimeIn, meta) {
      const mime = normalizeMime(mimeIn);
      const container = containerFor(mime);
      const watermarked = deps.watermarker.supports(mime);
      if (!container || (!watermarked && !MANIFEST_ONLY.has(mime))) throw new ProvenanceError(`no provenance support for ${mime}`);
      if (sniffMime(bytes) !== mime) throw new ProvenanceError(`output is not ${mime}`);
      const id = randomBytes(8).toString("hex");
      const marked = watermarked ? await deps.watermarker.embed(container.strip(bytes), mime, id) : { bytes: container.strip(bytes), mark: NO_WATERMARK };
      if (sniffMime(marked.bytes) !== mime) throw new ProvenanceError("watermarking changed the format");
      let out: Uint8Array;
      try {
        out = embedManifest(marked.bytes, mime, { requestId: meta.requestId, model: meta.model, generatedAt: (deps.now?.() ?? new Date()).toISOString(), watermark: marked.mark }, deps.key);
      } catch (e) {
        throw new ProvenanceError(`manifest: ${(e as Error).message}`);
      }
      const check = await verify(out);
      if (!check.ok) throw new ProvenanceError(`self-check failed (${check.manifest.ok ? "watermark" : check.manifest.reason})`);
      return out;
    },
  };
}
