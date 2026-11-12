// WS06 · Catalog, region placeholder, signed URLs and the in-memory store.
import { describe, expect, test } from "bun:test";
import { assertLicensed, BUILTIN_MODELS, KOKORO_VOICES, MediaCatalog, type ImageModel } from "../../src/anonymo/media/catalog.ts";
import { placeholderRegionRules } from "../../src/anonymo/media/region.ts";
import { checkMediaSignature, MemoryMediaStore, signedMediaPath, StoreFullError } from "../../src/anonymo/media/store.ts";
import { workflowSet } from "../../src/anonymo/media/workflows.ts";

describe("catalog", () => {
  test("the launch set is all licensed: self-hosted images and video Apache-2.0, voices Apache-2.0 or MIT", () => {
    for (const m of BUILTIN_MODELS) expect(() => assertLicensed(m)).not.toThrow();
    const ids = BUILTIN_MODELS.map((m) => m.id);
    for (const id of ["chroma", "z-image-turbo", "qwen-image", "qwen-image-edit", "flux.1-schnell", "flux.2-klein-4b", "kokoro", "qwen3-tts", "voxcpm2", "chatterbox", "wan-2.2"]) expect(ids).toContain(id);
  });

  test("FLUX [dev] is refused under any spelling, and non-Apache self-hosted image models are refused", () => {
    const base = BUILTIN_MODELS.find((m) => m.id === "flux.1-schnell") as ImageModel;
    for (const id of ["flux.1-dev", "FLUX.1 [dev]", "flux1-dev", "flux-dev", "flux.2-dev", "FLUX.2 [dev]"]) {
      expect(() => assertLicensed({ ...base, id })).toThrow(/FLUX \[dev\]/);
      expect(() => assertLicensed({ ...base, id: "fine", upstreamModel: id })).toThrow(/FLUX \[dev\]/);
    }
    expect(() => assertLicensed({ ...base, id: "sdxl-like", license: "CreativeML-OpenRAIL-M" })).toThrow(/Apache-2.0/);
    expect(() => new MediaCatalog([...BUILTIN_MODELS, { ...base, id: "flux-dev-copy", upstreamModel: "flux1-dev" }])).toThrow();
  });

  test("Venice models appear only when configured, only under venice/, never relabelled", () => {
    expect(MediaCatalog.fromEnv({}).models.some((m) => m.upstream === "venice")).toBe(false);
    const c = MediaCatalog.fromEnv({ ANONYMO_VENICE_IMAGE_MODELS: "venice-sd35, hidream ,bad id!", ANONYMO_VENICE_VIDEO_MODELS: "wan-2.5-preview" });
    const venice = c.models.filter((m) => m.upstream === "venice");
    expect(venice.map((m) => m.id).sort()).toEqual(["venice/hidream", "venice/venice-sd35", "venice/wan-2.5-preview"]);
    expect(c.get("image", "hidream")).toBeNull();
    expect(() => assertLicensed({ ...venice[0], id: "hidream" })).toThrow(/venice\//);
    expect(() => MediaCatalog.fromEnv({ ANONYMO_VENICE_IMAGE_MODELS: "flux-dev" })).toThrow(/FLUX/);
  });

  test("Kokoro offers its 54 stock voices, all distinct", () => {
    expect(KOKORO_VOICES.length).toBe(54);
    expect(new Set(KOKORO_VOICES).size).toBe(54);
  });

  test("ComfyUI workflows put the prompt in a value, never into the graph's shape", () => {
    const prompt = '"}, "99": {"class_type": "Evil", "inputs": {}} {{seed}}';
    const g = workflowSet().build("flux.1-schnell", { prompt, negative: "", seed: 7, width: 1024, height: 1024 });
    expect(Object.values(g).map((n) => n.class_type)).not.toContain("Evil");
    expect(Object.values(g).some((n) => n.inputs.text === prompt)).toBe(true);
    expect(Object.values(workflowSet().build("wan-2.2", { prompt: "p", negative: "", seed: 1, width: 832, height: 480, frames: 121, fps: 24 })).map((n) => n.class_type)).toContain("SaveVideo");
    expect(() => workflowSet().build("flux1-dev", { prompt: "p", negative: "", seed: 1, width: 8, height: 8 })).toThrow();
  });
});

describe("region placeholder", () => {
  const r = placeholderRegionRules({ ANONYMO_EXPLICIT_MEDIA_OFF: "GB,FR", ANONYMO_REGION_BLOCKED: "RU" });
  test("OFAC regions are blocked; explicit media is off where configured and when no country is known", () => {
    for (const cc of ["IR", "KP", "CU", "SY", "RU"]) expect(r.forCountry(cc)).toEqual({ blocked: true, explicitMediaAllowed: false });
    expect(r.forCountry("GB")).toEqual({ blocked: false, explicitMediaAllowed: false });
    expect(r.forCountry("fr")).toEqual({ blocked: false, explicitMediaAllowed: false });
    expect(r.forCountry("US")).toEqual({ blocked: false, explicitMediaAllowed: true });
    expect(r.forCountry(null)).toEqual({ blocked: false, explicitMediaAllowed: false });
    expect(r.forCountry("not-a-country")).toEqual({ blocked: false, explicitMediaAllowed: false });
    expect(placeholderRegionRules().forCountry("GB").explicitMediaAllowed).toBe(false);
  });
});

describe("signed URLs and the store", () => {
  const secret = "s".repeat(40);
  test("a signature is valid for its id until it expires, and for nothing else", () => {
    const now = 1_800_000_000_000;
    const path = signedMediaPath(secret, "m_abc", now + 60_000);
    const u = new URL(path, "http://x");
    const [exp, sig] = [u.searchParams.get("expires")!, u.searchParams.get("sig")!];
    expect(checkMediaSignature(secret, "m_abc", exp, sig, now)).toBe(true);
    expect(checkMediaSignature(secret, "m_abd", exp, sig, now)).toBe(false);
    expect(checkMediaSignature(secret, "m_abc", String(Number(exp) + 1), sig, now)).toBe(false);
    expect(checkMediaSignature(secret, "m_abc", exp, sig, now + 61_000)).toBe(false);
    expect(checkMediaSignature("other-secret", "m_abc", exp, sig, now)).toBe(false);
    expect(checkMediaSignature(secret, "m_abc", exp, undefined, now)).toBe(false);
  });

  test("items vanish at expiry and their bytes are zeroed; a full store refuses new items", () => {
    let t = 1000;
    const s = new MemoryMediaStore(1000, () => t);
    const bytes = new Uint8Array(600).fill(9);
    const a = s.put({ bytes, mime: "image/png", accountId: "acct" }, 5000);
    expect(s.get(a.id)?.bytes.length).toBe(600);
    expect(() => s.put({ bytes: new Uint8Array(600), mime: "image/png", accountId: "acct" }, 5000)).toThrow(StoreFullError);
    t += 5001;
    expect(s.get(a.id)).toBeNull();
    expect(bytes.every((b) => b === 0)).toBe(true);
    expect(s.size()).toBe(0);
    s.close();
  });
});
