import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { loadConfig } from "../../src/config.ts";
import { eq } from "drizzle-orm";
import { balanceOf } from "../../src/ledger/ledger.ts";
import { holds, keys } from "../../src/db/schema.ts";
import { mediaJobs } from "../../src/anonymo/media/schema.ts";
import { setMediaServices } from "../../src/anonymo/media/services.ts";
import { createStudioGate, llavaGuardClassifier, shieldGemmaClassifier, stricterVerdict, studioPersonClassifier, type StudioVerdict } from "../../src/anonymo/media/studio.ts";
import { createProvenance } from "../../src/anonymo/media/provenance.ts";
import { provenanceKeyFromSeed } from "../../src/anonymo/media/c2pa.ts";
import { MemoryMediaStore } from "../../src/anonymo/media/store.ts";
import { deployedInventory } from "../../src/privacy/inventory.ts";
import { solidPng, testWatermarker, tinyMp4 } from "./fixtures.ts";
import { startRouter, type Harness } from "../helpers.ts";

const prompt = "A lantern on a quiet dock, studio-fixture-canary";
const image = { bytes: solidPng(64, 64, [1, 2, 3]), mime: "image/png" };
const clip = { bytes: tinyMp4(3), mime: "video/mp4" };
const safe = { shieldgemma2: "safe", llavaguard: "safe" } as const;
const disagree = { shieldgemma2: "safe", llavaguard: "unsafe" } as const;
const store = new MemoryMediaStore();
let h: Harness;
let auth: Record<string, string>;
let accountId: string;
let events: string[];
let output: (typeof safe | typeof disagree) | { shieldgemma2: "unavailable"; llavaguard: "safe" };
let faceDetected: boolean;
let personLikeness: boolean;
let failUpload: boolean;

beforeAll(async () => {
  h = await startRouter({ env: { ANONYMO_FEATURE_STUDIO: "true" } });
  const key = await h.fundedKey(10n);
  auth = key.auth;
  accountId = (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash)))[0].accountId;
  setMediaServices(h.ctx, {
    studio: createStudioGate(
      { async classify() {
        events.push("shieldgemma");
        if (output.shieldgemma2 === "unavailable") throw new Error(prompt);
        return output.shieldgemma2;
      } },
      { async classify() { events.push("llavaguard"); return output.llavaguard; } },
      { async classify() {
        events.push("person");
        if (failUpload) throw new Error(prompt);
        return { faceDetected, personLikeness };
      } },
      3,
    ),
    gate: { assess: async () => ({ ok: true, explicit: false }), check: async () => ({ ok: true }) },
    images: { comfyui: { async generate() { events.push("image upstream"); return [image]; } } },
    video: { comfyui: {
      async submit() { events.push("video upstream"); return "fixture-ref"; },
      async poll() { return { state: "done", media: clip }; },
    } },
    store,
    provenance: createProvenance({ key: provenanceKeyFromSeed(new Uint8Array(32).fill(5)), watermarker: testWatermarker() }),
  });
});
beforeEach(() => {
  events = [];
  output = safe;
  faceDetected = personLikeness = failUpload = false;
  h.ctx.anonymo.floor = { async check() { events.push("text floor"); return { ok: true }; } };
});
afterAll(async () => {
  store.close();
  await h?.close();
});

const post = (path: string, json: unknown) => h.request(path, { method: "POST", headers: auth, json });
const balance = async () => (await balanceOf(h.ctx.db, accountId)).balance;
async function assertNoCharge(before: bigint) {
  expect(await balance()).toBe(before);
  const rows = await h.ctx.db.select().from(holds).where(eq(holds.accountId, accountId));
  expect(rows.some((row) => row.status === "held")).toBe(false);
}
async function signedRefusal(res: Response) {
  const header = res.headers.get("x-anonymo-receipt");
  expect(header).toBeTruthy();
  const receipt = JSON.parse(Buffer.from(header!, "base64url").toString("utf8"));
  expect(await h.ctx.signer.verify(receipt.payload, receipt.sig, receipt.key_id)).toBe(true);
  expect(receipt.payload).toMatchObject({ cost_usd: 0, outputs_sha256: [], provenance: null });
  expect(JSON.stringify(receipt)).not.toContain(prompt);
  return receipt.payload;
}

test("the existing text floor runs before Studio classifiers and generation", async () => {
  h.ctx.anonymo.floor = { async check() { events.push("text floor"); return { ok: false, category: "minor" }; } };
  const res = await post("/v1/images/generations", { model: "flux.1-schnell", prompt });
  expect(res.status).toBe(451);
  expect((await signedRefusal(res)).safety).toEqual({ prompt: "unsafe", outputs: [] });
  expect(events).toEqual(["text floor"]);
});

test("a text-safe request with an unsafe output returns 451, keeps both verdicts and bills zero", async () => {
  const before = await balance();
  output = disagree;
  const res = await post("/v1/images/generations", { model: "flux.1-schnell", prompt });
  expect(res.status).toBe(451);
  expect((await signedRefusal(res)).safety).toEqual({ prompt: "safe", outputs: [disagree] });
  const body = await res.json() as { data?: unknown };
  expect(body.data).toBeUndefined();
  expect(events).toEqual(["text floor", "image upstream", "shieldgemma", "llavaguard"]);
  expect(store.size()).toBe(0);
  await assertNoCharge(before);
});

test("an unavailable member fails closed and the signed receipt contains no upstream error text", async () => {
  const before = await balance();
  output = { shieldgemma2: "unavailable", llavaguard: "safe" };
  const res = await post("/v1/images/generations", { model: "flux.1-schnell", prompt });
  expect(res.status).toBe(503);
  expect((await signedRefusal(res)).safety.outputs).toEqual([output]);
  expect(await res.text()).not.toContain(prompt);
  await assertNoCharge(before);
});

const edit = () => post("/v1/images/edits", {
  model: "qwen-image-edit", prompt, response_format: "b64_json",
  image: `data:image/png;base64,${Buffer.from(image.bytes).toString("base64")}`,
});

test("real-person edits are refused even with an obscured face; an unavailable upload check also fails closed", async () => {
  const before = await balance();
  const priorHolds = (await h.ctx.db.select().from(holds)).length;
  personLikeness = true;
  for (const detected of [true, false]) {
    faceDetected = detected;
    const res = await edit();
    expect(res.status).toBe(451);
    expect(await res.json()).toMatchObject({ error: { type: "floor_blocked", metadata: { category: "real_person" } } });
    expect((await signedRefusal(res)).safety).toEqual({ prompt: "safe", upload: "unsafe", outputs: [] });
  }
  failUpload = true;
  const res = await edit();
  expect(res.status).toBe(503);
  expect((await signedRefusal(res)).safety.upload).toBe("unavailable");
  expect(events).toEqual(["text floor", "person", "text floor", "person", "text floor", "person"]);
  await assertNoCharge(before);
  expect(await h.ctx.db.select().from(holds)).toHaveLength(priorHolds);
});

test("a stylized face can be edited if the likeness and both output checks pass", async () => {
  faceDetected = true;
  const before = await balance();
  const res = await edit();
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    anonymo: { receipt: { payload: { safety: { prompt: "safe", upload: "safe", outputs: [safe] } } } },
  });
  expect(await balance()).toBeLessThan(before);
});

test("Studio mounts visual routes without speech and blocks unsafe video at completion", async () => {
  expect((await post("/v1/audio/speech", {})).status).toBe(404);
  const before = await balance();
  output = disagree;
  const submitted = await post("/v1/video/generations", { model: "wan-2.2", prompt, seconds: 4 });
  expect(submitted.status).toBe(202);
  const { id } = await submitted.json() as { id: string };
  for (let poll = 0; poll < 2; poll++) {
    const res = await h.request(`/v1/video/generations/${id}`, { headers: auth });
    expect(res.status).toBe(451);
    expect((await signedRefusal(res)).safety.outputs).toEqual([disagree]);
    const body = await res.json() as { url?: string };
    expect(body).toMatchObject({ status: "failed", anonymo: { cost_usd: 0 } });
    expect(body.url).toBeUndefined();
  }
  expect(events).toEqual(["text floor", "video upstream", "shieldgemma", "llavaguard"]);
  expect(JSON.stringify(await h.ctx.db.select({ error: mediaJobs.errorType }).from(mediaJobs))).not.toContain(prompt);
  expect(store.size()).toBe(0);
  await assertNoCharge(before);
});

test("Studio completion signs safe clip verdicts with matching output provenance", async () => {
  const submitted = await post("/v1/video/generations", { model: "wan-2.2", prompt, seconds: 4 });
  expect(submitted.status).toBe(202);
  const { id } = await submitted.json() as { id: string };
  const res = await h.request(`/v1/video/generations/${id}`, { headers: auth });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    status: "completed", url: expect.any(String), anonymo: { receipt: { payload: { safety: { prompt: "safe", outputs: [safe] }, provenance: "c2pa+watermark" } } },
  });
});

test("the stricter verdict wins for the full outcome matrix", () => {
  const order: StudioVerdict[] = ["safe", "unavailable", "unsafe"];
  order.forEach((first, i) => order.forEach((second, j) => expect(stricterVerdict(first, second)).toBe(order[Math.max(i, j)])));
});

test("model adapters post bytes and require a real verdict for each requested frame", async () => {
  const endpoint = { url: "https://classifier.example.invalid", token: "fixture-token" }; // gitleaks:allow
  for (const [make, path] of [[shieldGemmaClassifier, "/v1/shieldgemma2"], [llavaGuardClassifier, "/v1/llavaguard"]] as const) {
    const classify = make(endpoint, (async (url, init) => {
      expect(url).toBe(endpoint.url + path);
      expect(init?.body).toBe(clip.bytes);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${endpoint.token}`);
      expect(new Headers(init?.headers).get("x-sample-frames")).toBe("3");
      return Response.json({ frames: ["safe", "unsafe", "safe"] });
    }) as typeof fetch);
    expect(await classify.classify(clip, 3, AbortSignal.timeout(1000))).toBe("unsafe");
    const malformed = make(endpoint, (async () => Response.json({ frames: ["safe"] })) as unknown as typeof fetch);
    await expect(malformed.classify(clip, 3, AbortSignal.timeout(1000))).rejects.toThrow();
  }
  const person = studioPersonClassifier(endpoint, (async (url, init) => {
    expect(url).toBe(endpoint.url + "/v1/person-likeness");
    expect(init?.body).toBe(image.bytes);
    return Response.json({ face_detected: true, person_likeness: false });
  }) as typeof fetch);
  expect(await person.classify(image, AbortSignal.timeout(1000))).toEqual({ faceDetected: true, personLikeness: false });
});

test("the deployed inventory describes the sidecars only with Studio switched on", () => {
  expect(JSON.stringify(deployedInventory({ ventures: false }))).not.toContain("Studio person classifier");
  expect(JSON.stringify(deployedInventory({ ventures: false, studio: true }))).toContain("Studio person classifier");
});

test("Studio is off by default and production needs all three hosts with Studio on", () => {
  expect(loadConfig({}).features.studio).toBe(false);
  const production = {
    ANONYMO_ENV: "production",
    APP_SECRET: "x".repeat(40), // gitleaks:allow
    ADMIN_TOKEN: "y".repeat(30), // gitleaks:allow
    ANONYMO_FEATURE_STUDIO: "true",
    ANONYMO_MEDIA_CLASSIFIER_URL: "https://classifier.example.invalid",
    ANONYMO_SFW_SHIELDGEMMA_URL: "https://classifier.example.invalid",
    ANONYMO_SFW_LLAVAGUARD_URL: "https://classifier.example.invalid",
  };
  expect(() => loadConfig(production)).toThrow(/ANONYMO_SFW_PERSON_URL/);
});
