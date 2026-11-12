// WS06 · Provenance: every output format carries a signed C2PA manifest and an invisible watermark, both verifiable,
// and stamp() refuses anything it cannot mark (Backend §2 provenance, §10 "no media without it").
import { describe, expect, test } from "bun:test";
import { provenanceKeyFromSeed, verifyManifest, TRAINED_ALGORITHMIC_MEDIA } from "../../src/anonymo/media/c2pa.ts";
import { containerFor, sniffMime } from "../../src/anonymo/media/containers.ts";
import { decodePng, pngChunks } from "../../src/anonymo/media/png.ts";
import { createProvenance, ProvenanceError } from "../../src/anonymo/media/provenance.ts";
import { lsbWatermarker } from "../../src/anonymo/media/watermark.ts";
import { gradientPng, solidPng, testWatermarker, tinyMp4, toneWav, TEST_WATERMARK_KEY } from "./fixtures.ts";

const key = provenanceKeyFromSeed(new Uint8Array(32).fill(3));
const prov = createProvenance({ key, watermarker: testWatermarker() });
const meta = { requestId: "req_test_1", model: "flux.1-schnell" };

const CASES: [string, string, () => Uint8Array][] = [
  ["solid PNG", "image/png", () => solidPng(64, 64, [40, 90, 200])],
  ["RGBA PNG", "image/png", () => solidPng(48, 32, [250, 250, 250], { alpha: true })],
  ["gradient PNG", "image/png", () => gradientPng(96, 80)],
  ["WAV tone", "audio/wav", () => toneWav(0.4)],
  ["MP4", "video/mp4", () => tinyMp4()],
];

describe("provenance", () => {
  for (const [name, mime, make] of CASES)
    test(`${name}: stamped output verifies (manifest, signature, data hash, watermark)`, async () => {
      const out = await prov.stamp(make(), mime, meta);
      expect(sniffMime(out)).toBe(mime);
      const check = await prov.verify(out);
      expect(check.ok).toBe(true);
      if (!check.manifest.ok) throw new Error("manifest invalid");
      expect(check.manifest.generation.model).toBe(meta.model);
      expect(check.manifest.generation.requestId).toBe(meta.requestId);
      expect(check.manifest.generation.ai_generated).toBe(true);
      expect(check.manifest.digitalSourceType).toBe(TRAINED_ALGORITHMIC_MEDIA);
      expect(check.manifest.keyId).toBe(key.keyId);
      expect(check.watermark?.id).toBe(check.manifest.generation.watermark.id);
    });

  test("the watermark changes no PNG pixel by more than one level, in the blue channel only", async () => {
    const src = gradientPng(64, 64);
    const out = await prov.stamp(src, "image/png", meta);
    const a = decodePng(src), b = decodePng(out);
    for (let i = 0; i < a.pixels.length; i++) {
      const d = Math.abs(a.pixels[i] - b.pixels[i]);
      expect(d).toBeLessThanOrEqual(i % 3 === 2 ? 1 : 0);
    }
  });

  test("changing one byte outside the manifest breaks the data hash", async () => {
    for (const [, mime, make] of CASES) {
      const out = await prov.stamp(make(), mime, meta);
      const loc = containerFor(mime)!.extract(out)!;
      const tampered = new Uint8Array(out);
      const at = loc.offset > 40 ? loc.offset - 5 : out.length - 1; // inside the image data / samples / last box
      tampered[at] ^= 0x01;
      const check = verifyManifest(tampered, (id) => (id === key.keyId ? key.publicKeyHex : null));
      expect(check.ok).toBe(false);
    }
  });

  test("a manifest signed by an unknown key, or with a forged signature, is rejected", async () => {
    const out = await prov.stamp(solidPng(32, 32, [10, 10, 10]), "image/png", meta);
    expect(verifyManifest(out, () => null)).toEqual({ ok: false, reason: "unknown_key" });
    const other = provenanceKeyFromSeed(new Uint8Array(32).fill(9));
    expect(verifyManifest(out, () => other.publicKeyHex).ok).toBe(false);
  });

  test("an unmarked file has no manifest and no watermark", async () => {
    const check = await prov.verify(solidPng(32, 32, [1, 2, 3]));
    expect(check.ok).toBe(false);
    expect(check.manifest).toEqual({ ok: false, reason: "no_manifest" });
    expect(check.watermark).toBeNull();
  });

  test("the watermark survives a stripped manifest and scattered bit damage", async () => {
    const out = await prov.stamp(gradientPng(128, 128), "image/png", meta);
    const id = ((await prov.verify(out)).manifest as { generation: { watermark: { id: string } } }).generation.watermark.id;
    const stripped = containerFor("image/png")!.strip(out);
    expect(verifyManifest(stripped, () => key.publicKeyHex).ok).toBe(false);
    const wm = lsbWatermarker(TEST_WATERMARK_KEY);
    // Flip the blue LSB of every 7th pixel: about 14% of the carrier, well inside the majority vote.
    const img = decodePng(stripped);
    for (let i = 0; i < img.width * img.height; i += 7) img.pixels[i * 3 + 2] ^= 1;
    const { encodePng } = await import("../../src/anonymo/media/png.ts");
    expect((await wm.detect(encodePng(img), "image/png"))?.id).toBe(id);
    // Without the key, nothing is found.
    expect(await lsbWatermarker(new Uint8Array(32).fill(1)).detect(out, "image/png")).toBeNull();
  });

  test("upstream text chunks (ComfyUI's workflow, with the prompt) never survive", async () => {
    const src = solidPng(32, 32, [100, 100, 100], { text: "a secret prompt" });
    expect(pngChunks(src).some((c) => c.type === "tEXt")).toBe(true);
    const out = await prov.stamp(src, "image/png", meta);
    expect(pngChunks(out).map((c) => c.type)).not.toContain("tEXt");
    expect(Buffer.from(out).includes(Buffer.from("a secret prompt"))).toBe(false);
    const wav = await prov.stamp(toneWav(0.3, 16_000, 440, { id: "LIST", text: "INFOICMT a secret prompt" }), "audio/wav", meta);
    expect(Buffer.from(wav).includes(Buffer.from("a secret prompt"))).toBe(false);
  });

  test("an upstream's own manifest is replaced, not kept beside ours", async () => {
    const once = await prov.stamp(solidPng(32, 32, [5, 5, 5]), "image/png", { requestId: "upstream", model: "x" });
    const twice = await prov.stamp(once, "image/png", meta);
    expect(pngChunks(twice).filter((c) => c.type === "caBX").length).toBe(1);
    expect(((await prov.verify(twice)).manifest as { generation: { requestId: string } }).generation.requestId).toBe(meta.requestId);
  });

  test("formats without a container or watermark, or bytes that lie about their type, are refused", async () => {
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1);
    await expect(prov.stamp(jpeg, "image/jpeg", meta)).rejects.toBeInstanceOf(ProvenanceError);
    await expect(prov.stamp(toneWav(0.2), "image/png", meta)).rejects.toBeInstanceOf(ProvenanceError);
    const noVideoMark = createProvenance({ key, watermarker: lsbWatermarker(TEST_WATERMARK_KEY) });
    expect(noVideoMark.supports("video/mp4")).toBe(false);
    await expect(noVideoMark.stamp(tinyMp4(), "video/mp4", meta)).rejects.toBeInstanceOf(ProvenanceError);
    // Too small to carry the 96-bit mark three times over.
    await expect(prov.stamp(solidPng(4, 4, [0, 0, 0]), "image/png", meta)).rejects.toThrow();
  });
});
