// WS06 · Media endpoints end to end, through the real gateway (auth, ledger, floor hook, routes) with in-process
// doubles for the upstreams and the classifier. Fixtures are solid colours and synthetic tones; the classifier double
// maps a fixture's colour to mock scores. Asserts, for every medium: the floor gate runs first and a block sends
// nothing and holds nothing; region rules apply; the media gate blocks fail closed and nothing is stored, returned
// or charged on a block; every returned output carries verifiable provenance; and no prompt text reaches the database.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { holds, keys } from "../../src/db/schema.ts";
import { balanceOf, verifyInvariants } from "../../src/ledger/ledger.ts";
import { usdToPico } from "../../src/lib/money.ts";
import type { FloorGate, FloorInput } from "../../src/anonymo/seams.ts";
import { provenanceKeyFromSeed } from "../../src/anonymo/media/c2pa.ts";
import { createMediaGate, type FrameScore, type MediaClassifier } from "../../src/anonymo/media/gate.ts";
import { decodePng } from "../../src/anonymo/media/png.ts";
import { createProvenance } from "../../src/anonymo/media/provenance.ts";
import { sweepVideoJobs } from "../../src/anonymo/media/routes.ts";
import { mediaJobs } from "../../src/anonymo/media/schema.ts";
import { mediaServices, setMediaServices, type MediaServices } from "../../src/anonymo/media/services.ts";
import { MemoryMediaStore } from "../../src/anonymo/media/store.ts";
import { UpstreamError, type ImageRequest, type ImageUpstream, type Media, type SpeechRequest, type SpeechUpstream, type VideoPoll, type VideoUpstream } from "../../src/anonymo/media/upstreams.ts";
import { startRouter, type Harness } from "../helpers.ts";
import { solidPng, testWatermarker, tinyMp4, toneWav, type Rgb } from "./fixtures.ts";

// ---- Doubles -------------------------------------------------------------------------------------------------------
// Fixture colours and the mock scores the classifier double gives them. Every image is a solid colour square.
const COLOURS: Record<string, { rgb: Rgb; frame: FrameScore | "down" }> = {
  green: { rgb: [30, 200, 30], frame: { nsfw: 0.02, apparentAge: null } }, // safe, nobody in it
  red: { rgb: [200, 30, 30], frame: { nsfw: 0.92, apparentAge: 34 } }, // mock: explicit, adult
  amber: { rgb: [250, 200, 0], frame: { nsfw: 0.92, apparentAge: 15 } }, // mock: explicit, apparent minor
  blue: { rgb: [0, 0, 250], frame: { nsfw: 0.92, apparentAge: 30, realPerson: 0.95 } }, // mock: explicit, real person
  grey: { rgb: [128, 128, 128], frame: "down" }, // the classifier fails on this one
};
const colourOf = (prompt: string) => Object.keys(COLOURS).find((c) => prompt.includes(c)) ?? "green";

let classifierCalls = 0;
let videoFrames: FrameScore[] | "down" = [];
const classifier: MediaClassifier = {
  async score(bytes, mime, { frames }) {
    classifierCalls++;
    if (mime.startsWith("video/")) {
      if (videoFrames === "down") throw new Error("classifier down");
      return { frames: Array.from({ length: frames }, (_, i) => (videoFrames as FrameScore[])[i % (videoFrames as FrameScore[]).length]) };
    }
    const img = decodePng(bytes);
    const hit = Object.values(COLOURS).find((c) => c.rgb.every((v, i) => v === img.pixels[i]));
    if (!hit || hit.frame === "down") throw new Error("classifier down");
    return { frames: [hit.frame] };
  },
};

const calls = { image: [] as ImageRequest[], speech: [] as SpeechRequest[], videoSubmit: 0, videoPoll: 0 };
let imageReply: ((r: ImageRequest) => Media[]) | null = null;
const images: ImageUpstream = {
  async generate(r) {
    calls.image.push(r);
    if (imageReply) return imageReply(r);
    return Array.from({ length: r.n }, () => ({ bytes: solidPng(64, 64, COLOURS[colourOf(r.prompt)].rgb, { text: r.prompt }), mime: "image/png" }));
  },
};
let speechReply: ((r: SpeechRequest) => Media) | null = null;
const speech: SpeechUpstream = {
  async speak(r) {
    calls.speech.push(r);
    return speechReply ? speechReply(r) : { bytes: toneWav(0.5, 16_000, 330, { id: "LIST", text: `INFOICMT${r.input}` }), mime: "audio/wav" };
  },
};
let videoPolls: VideoPoll[] = [];
const video: VideoUpstream = {
  async submit() {
    calls.videoSubmit++;
    return `job-${calls.videoSubmit}`;
  },
  async poll() {
    calls.videoPoll++;
    return videoPolls.shift() ?? { state: "running" };
  },
};

const PROMPT_MARK = "zq-prompt-canary";
const allow: FloorGate = { check: async () => ({ ok: true }) };
let floorSeen: FloorInput[] = [];
const recording = (g: FloorGate): FloorGate => ({ check: async (i) => (floorSeen.push(i), g.check(i)) });

let h: Harness;
let auth: Record<string, string>;
let accountId: string;
let s: MediaServices;
const US = { "x-anonymo-country": "US" };

beforeAll(async () => {
  h = await startRouter({ env: { ANONYMO_FEATURE_MEDIA: "true" } });
  const k = await h.fundedKey(50n);
  auth = { ...k.auth, ...US };
  accountId = (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash)))[0].accountId;
  s = setMediaServices(h.ctx, {
    gate: createMediaGate(classifier, { timeoutMs: 2000 }),
    provenance: createProvenance({ key: provenanceKeyFromSeed(new Uint8Array(32).fill(5)), watermarker: testWatermarker() }),
    store: new MemoryMediaStore(64 * 1024 * 1024),
    images: { comfyui: images, venice: images },
    video: { comfyui: video, venice: video },
    speech,
    pollIntervalMs: 0,
  });
});
afterAll(async () => h?.close());
beforeEach(() => {
  h.ctx.anonymo.floor = recording(allow);
  floorSeen = [];
  imageReply = null;
  speechReply = null;
  videoPolls = [];
  videoFrames = [{ nsfw: 0.1, apparentAge: 30 }];
});

const post = (path: string, json: unknown, headers: Record<string, string> = auth) => h.request(path, { method: "POST", headers, json });
const balance = async () => (await balanceOf(h.ctx.db, accountId)).balance;
const openHolds = async () => (await h.ctx.db.select().from(holds).where(eq(holds.accountId, accountId))).filter((x) => x.status === "held").length;
const pathOf = (url: string) => {
  const u = new URL(url, "http://local");
  return u.pathname + u.search;
};
async function verified(bytes: Uint8Array) {
  const check = await s.provenance.verify(bytes);
  expect(check.ok).toBe(true);
  return check;
}
const errorOf = async (res: Response) => ((await res.json()) as { error: { type: string; message: string; metadata?: Record<string, unknown> } }).error;
/** Nothing sent upstream, nothing held, nothing charged, nothing stored. */
async function untouched(run: () => Promise<Response>) {
  const before = { img: calls.image.length, sp: calls.speech.length, vs: calls.videoSubmit, bal: await balance(), held: await openHolds(), stored: s.store.size() };
  const res = await run();
  expect(calls.image.length).toBe(before.img);
  expect(calls.speech.length).toBe(before.sp);
  expect(calls.videoSubmit).toBe(before.vs);
  expect(await balance()).toBe(before.bal);
  expect(await openHolds()).toBe(before.held);
  expect(s.store.size()).toBe(before.stored);
  return res;
}
/** Sent upstream but blocked or failed afterwards: nothing charged, nothing held, nothing stored. */
async function nothingCharged(run: () => Promise<Response>) {
  const before = { bal: await balance(), stored: s.store.size() };
  const res = await run();
  expect(await balance()).toBe(before.bal);
  expect(await openHolds()).toBe(0);
  expect(s.store.size()).toBe(before.stored);
  return res;
}

// ---- Images --------------------------------------------------------------------------------------------------------
describe("POST /v1/images/generations", () => {
  test("returns signed URLs to stamped PNGs, charges per image, and signs a receipt", async () => {
    const before = await balance();
    const res = await post("/v1/images/generations", { model: "flux.1-schnell", prompt: `a green square ${PROMPT_MARK}`, n: 2, size: "1024x1024" });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { data: { url: string; expires_at: number }[]; anonymo: { cost_usd: number; request_id: string; receipt: { key_id: string; sig: string; payload: unknown } } };
    expect(j.data).toHaveLength(2);
    expect(j.anonymo.cost_usd).toBe(0.008);
    expect(before - (await balance())).toBe(usdToPico("0.008"));
    expect(await h.ctx.signer.verify(j.anonymo.receipt.payload, j.anonymo.receipt.sig, j.anonymo.receipt.key_id)).toBe(true);
    expect(res.headers.get("x-anonymo-receipt")).toBeTruthy();
    for (const d of j.data) {
      expect(d.expires_at * 1000).toBeGreaterThan(Date.now());
      const file = await h.request(pathOf(d.url));
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toBe("image/png");
      expect(file.headers.get("cache-control")).toContain("no-store");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const check = await verified(bytes);
      if (check.manifest.ok) expect(check.manifest.generation.requestId).toBe(j.anonymo.request_id);
      expect(Buffer.from(bytes).includes(Buffer.from(PROMPT_MARK))).toBe(false); // the upstream's tEXt chunk is gone
    }
    // The floor saw the prompt as an image request without an upload, and the upstream got a seed and the size.
    expect(floorSeen.at(-1)).toEqual({ text: `a green square ${PROMPT_MARK}`, modality: "image", hasUpload: false });
    expect(calls.image.at(-1)).toMatchObject({ model: "flux.1-schnell", n: 2, width: 1024, height: 1024, safe: false });
  });

  test("b64_json returns the stamped image inline and stores nothing", async () => {
    const stored = s.store.size();
    const res = await post("/api/v1/images/generations", { model: "chroma", prompt: "a green field", response_format: "b64_json" });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { data: { b64_json: string }[] };
    await verified(new Uint8Array(Buffer.from(j.data[0].b64_json, "base64")));
    expect(s.store.size()).toBe(stored);
  });

  test("a floor block is 451 before anything else: nothing sent, held, scored or charged", async () => {
    h.ctx.anonymo.floor = recording({ check: async () => ({ ok: false, category: "minor" }) });
    const scored = classifierCalls;
    const res = await untouched(() => post("/v1/images/generations", { model: "flux.1-schnell", prompt: `blocked ${PROMPT_MARK}` }));
    expect(res.status).toBe(451);
    const e = await errorOf(res);
    expect(e.type).toBe("floor_blocked");
    expect(e.metadata?.category).toBe("minor");
    expect(e.message).not.toContain(PROMPT_MARK);
    expect(classifierCalls).toBe(scored);
  });

  test("a floor gate that cannot answer fails closed with 503", async () => {
    h.ctx.anonymo.floor = { check: async () => { throw new Error("guard down"); } };
    const res = await untouched(() => post("/v1/images/generations", { model: "flux.1-schnell", prompt: "a green square" }));
    expect(res.status).toBe(503);
    expect((await errorOf(res)).type).toBe("floor_unavailable");
  });

  test("an apparent-minor explicit output is blocked: 451, nothing returned, stored or charged", async () => {
    const res = await nothingCharged(() => post("/v1/images/generations", { model: "z-image-turbo", prompt: "an amber square", n: 3 }));
    expect(res.status).toBe(451);
    const e = await errorOf(res);
    expect(e).toMatchObject({ type: "media_blocked", metadata: { reason: "nsfw_minor" } });
    expect(JSON.stringify(e)).not.toContain("http");
  });

  test("one blocked image stops the whole batch", async () => {
    imageReply = (r) => [solidPng(64, 64, COLOURS.green.rgb), solidPng(64, 64, COLOURS.blue.rgb)].slice(0, r.n).map((bytes) => ({ bytes, mime: "image/png" }));
    const res = await nothingCharged(() => post("/v1/images/generations", { model: "flux.1-schnell", prompt: "two squares", n: 2 }));
    expect(res.status).toBe(451);
    expect((await errorOf(res)).metadata?.reason).toBe("nsfw_real_person");
  });

  test("an unscored output (classifier down) is a block, not a pass", async () => {
    const res = await nothingCharged(() => post("/v1/images/generations", { model: "flux.1-schnell", prompt: "a grey square" }));
    expect(res.status).toBe(503);
    expect((await errorOf(res)).type).toBe("media_gate_unavailable");
  });

  test("explicit adult output is served where allowed, and off where region rules switch it off", async () => {
    expect((await post("/v1/images/generations", { model: "flux.1-schnell", prompt: "a red square" })).status).toBe(200);
    for (const headers of [{ ...auth, "x-anonymo-country": "GB" }, { authorization: auth.authorization }]) {
      const res = await nothingCharged(() => post("/v1/images/generations", { model: "flux.1-schnell", prompt: "a red square" }, headers));
      expect(res.status).toBe(451);
      expect((await errorOf(res)).type).toBe("explicit_media_unavailable");
      expect(calls.image.at(-1)?.safe).toBe(true); // the upstream was asked for safe output too
    }
    // Non-explicit output still works there.
    expect((await post("/v1/images/generations", { model: "flux.1-schnell", prompt: "a green square" }, { ...auth, "x-anonymo-country": "GB" })).status).toBe(200);
  });

  test("an OFAC region is refused before anything is sent", async () => {
    const res = await untouched(() => post("/v1/images/generations", { model: "flux.1-schnell", prompt: "a green square" }, { ...auth, "x-anonymo-country": "IR" }));
    expect(res.status).toBe(451);
    expect((await errorOf(res)).type).toBe("region_blocked");
  });

  test("an upstream image that cannot carry provenance is never returned", async () => {
    imageReply = () => [{ bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4), mime: "image/jpeg" }];
    const scored = classifierCalls;
    // The classifier double cannot decode a JPEG either: the gate blocks first. Use a passing gate to reach provenance.
    const gate = s.gate;
    s.gate = { ...gate, assess: async () => ({ ok: true, explicit: false }) };
    try {
      const res = await nothingCharged(() => post("/v1/images/generations", { model: "flux.1-schnell", prompt: "a jpeg" }));
      expect(res.status).toBe(502);
      expect((await errorOf(res)).type).toBe("provenance_failed");
    } finally {
      s.gate = gate;
    }
    expect(classifierCalls).toBe(scored);
  });

  test("upstream failures release the hold and charge nothing", async () => {
    imageReply = () => {
      throw new UpstreamError("down", 503);
    };
    const res = await nothingCharged(() => post("/v1/images/generations", { model: "flux.1-schnell", prompt: "a green square" }));
    expect(res.status).toBe(503);
    expect((await errorOf(res)).type).toBe("upstream_unavailable");
  });

  test("validation: unknown model, edit model, bad n, bad size, uploads on generations, FLUX [dev]", async () => {
    const cases: [unknown, number][] = [
      [{ model: "nope", prompt: "x" }, 404],
      [{ model: "flux.1-dev", prompt: "x" }, 404],
      [{ model: "qwen-image-edit", prompt: "x" }, 400],
      [{ model: "chroma", prompt: "x", n: 5 }, 400],
      [{ model: "chroma", prompt: "x", size: "4096x4096" }, 400],
      [{ model: "chroma", prompt: "" }, 400],
      [{ model: "chroma", prompt: "x", image: "data:image/png;base64,AAAA" }, 400],
      [{ model: "chroma", prompt: "x", response_format: "gif" }, 400],
    ];
    for (const [body, status] of cases) expect((await untouched(() => post("/v1/images/generations", body))).status).toBe(status);
    expect((await post("/v1/images/generations", { model: "chroma", prompt: "x" }, US)).status).toBe(401);
  });
});

describe("POST /v1/images/edits", () => {
  const form = (image: Uint8Array, fields: Record<string, string>) => {
    const f = new FormData();
    f.append("image", new Blob([image as unknown as ArrayBuffer], { type: "image/png" }), "in.png");
    for (const [k, v] of Object.entries(fields)) f.append(k, v);
    return f;
  };
  const edit = (image: Uint8Array, fields: Record<string, string>) => h.request("/v1/images/edits", { method: "POST", headers: auth, body: form(image, fields) });

  test("a safe upload and a safe result: stamped, charged, and the floor knew there was an upload", async () => {
    imageReply = (r) => {
      expect(r.image?.mime).toBe("image/png");
      expect(r.safe).toBe(true); // edits always run in safe mode
      return [{ bytes: solidPng(64, 64, COLOURS.green.rgb), mime: "image/png" }];
    };
    const res = await edit(solidPng(64, 64, COLOURS.green.rgb), { model: "qwen-image-edit", prompt: "make it greener", response_format: "b64_json" });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { data: { b64_json: string }[] };
    await verified(new Uint8Array(Buffer.from(j.data[0].b64_json, "base64")));
    expect(floorSeen.at(-1)).toEqual({ text: "make it greener", modality: "image", hasUpload: true });
  });

  test("JSON with a data URL works too; image URLs are never fetched", async () => {
    imageReply = () => [{ bytes: solidPng(64, 64, COLOURS.green.rgb), mime: "image/png" }];
    const image = "data:image/png;base64," + Buffer.from(solidPng(32, 32, COLOURS.green.rgb)).toString("base64");
    expect((await post("/v1/images/edits", { model: "qwen-image-edit", prompt: "brighter", image })).status).toBe(200);
    expect((await untouched(() => post("/v1/images/edits", { model: "qwen-image-edit", prompt: "brighter", image: "https://example.test/a.png" }))).status).toBe(400);
  });

  test("an explicit upload is refused before any model sees it (no NSFW edits of uploaded photos)", async () => {
    const res = await untouched(() => edit(solidPng(64, 64, COLOURS.red.rgb), { model: "qwen-image-edit", prompt: "change the background" }));
    expect(res.status).toBe(451);
    expect((await errorOf(res)).metadata?.reason).toBe("explicit_from_upload");
  });

  test("an explicit result of a safe upload is blocked, even where explicit media is allowed", async () => {
    imageReply = () => [{ bytes: solidPng(64, 64, COLOURS.red.rgb), mime: "image/png" }];
    const res = await nothingCharged(() => edit(solidPng(64, 64, COLOURS.green.rgb), { model: "qwen-image-edit", prompt: "anything" }));
    expect(res.status).toBe(451);
    expect((await errorOf(res)).metadata?.reason).toBe("explicit_from_upload");
  });

  test("masks, non-images and generation models are refused", async () => {
    expect((await untouched(() => edit(solidPng(32, 32, COLOURS.green.rgb), { model: "qwen-image-edit", prompt: "x", mask: "1" }))).status).toBe(400);
    expect((await untouched(() => edit(toneWav(0.1), { model: "qwen-image-edit", prompt: "x" }))).status).toBe(400);
    expect((await untouched(() => edit(solidPng(32, 32, COLOURS.green.rgb), { model: "flux.1-schnell", prompt: "x" }))).status).toBe(400);
  });
});

// ---- Speech --------------------------------------------------------------------------------------------------------
describe("POST /v1/audio/speech", () => {
  test("a stock voice returns stamped WAV, charged per 1k characters, metadata stripped", async () => {
    const input = `Hello from a stock voice. ${PROMPT_MARK}`;
    const before = await balance();
    const res = await post("/v1/audio/speech", { model: "kokoro", input, voice: "af_heart" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    const bytes = new Uint8Array(await res.arrayBuffer());
    await verified(bytes);
    expect(Buffer.from(bytes).includes(Buffer.from(PROMPT_MARK))).toBe(false);
    const expected = (usdToPico("0.015") * BigInt(input.length) + 999n) / 1000n;
    expect(before - (await balance())).toBe(expected);
    expect(floorSeen.at(-1)).toEqual({ text: input, modality: "audio", hasUpload: false });
    expect(calls.speech.at(-1)).toMatchObject({ model: "kokoro", voice: "af_heart", speed: 1 });
  });

  test("every engine's stock voices work", async () => {
    for (const [model, voice] of [["qwen3-tts", "cherry"], ["voxcpm2", "vox-ava"], ["chatterbox", "cb-default"]])
      expect((await post("/v1/audio/speech", { model, input: "Stock voice check.", voice })).status).toBe(200);
  });

  test("voice cloning is refused in every shape, before anything is sent", async () => {
    const bodies = [
      { model: "chatterbox", input: "hi", voice: "someone-else" },
      { model: "voxcpm2", input: "hi", voice: "vox-ava", reference_audio: "UklGRg==" },
      { model: "voxcpm2", input: "hi", speaker_wav: "UklGRg==" },
      { model: "kokoro", input: "hi", voice: { url: "https://example.test/voice.wav" } },
      { model: "kokoro", input: "hi", voice_url: "https://example.test/voice.wav" },
    ];
    for (const body of bodies) expect((await untouched(() => post("/v1/audio/speech", body))).status).toBe(400);
    const f = new FormData();
    f.append("model", "chatterbox");
    f.append("voice", new Blob([toneWav(0.2) as unknown as ArrayBuffer], { type: "audio/wav" }), "me.wav");
    expect((await untouched(() => h.request("/v1/audio/speech", { method: "POST", headers: auth, body: f }))).status).toBe(415);
  });

  test("non-WAV formats are refused (provenance is embedded in WAV)", async () => {
    expect((await untouched(() => post("/v1/audio/speech", { model: "kokoro", input: "hi", response_format: "mp3" }))).status).toBe(400);
  });

  test("a floor block on the text sends nothing", async () => {
    h.ctx.anonymo.floor = { check: async () => ({ ok: false, category: "voice_clone" }) };
    const res = await untouched(() => post("/v1/audio/speech", { model: "kokoro", input: "speak as a named person", voice: "af_sky" }));
    expect(res.status).toBe(451);
    expect((await errorOf(res)).metadata?.category).toBe("voice_clone");
  });

  test("audio that is not WAV, or that carries the prompt in its samples, is never returned", async () => {
    speechReply = () => ({ bytes: new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]), mime: "audio/mpeg" });
    expect((await nothingCharged(() => post("/v1/audio/speech", { model: "kokoro", input: "hello there" }))).status).toBe(502);
    const input = "this exact sentence must never come back inside the file";
    speechReply = () => {
      const wav = toneWav(0.5);
      wav.set(Buffer.from(input), 200); // inside the data chunk, where no stripper looks
      return { bytes: wav, mime: "audio/wav" };
    };
    const res = await nothingCharged(() => post("/v1/audio/speech", { model: "kokoro", input }));
    expect(res.status).toBe(502);
    expect((await errorOf(res)).type).toBe("provenance_failed");
  });
});

// ---- Video ---------------------------------------------------------------------------------------------------------
describe("/v1/video/generations", () => {
  const submit = (extra: Record<string, unknown> = {}, headers = auth) => post("/v1/video/generations", { model: "wan-2.2", prompt: `a slow pan over a green field ${PROMPT_MARK}`, seconds: 4, ...extra }, headers);
  // pollIntervalMs is 0 here, and a claim needs lastPolledAt strictly before now (the production rule that stops two
  // pollers settling one job twice), so each poll starts at least a millisecond after the one before it.
  const poll = async (id: string, headers = auth) => {
    await Bun.sleep(2);
    return h.request(`/v1/video/generations/${id}`, { headers });
  };
  type Job = { id: string; status: string; url?: string; error?: { type: string; reason?: string }; anonymo: { cost_usd: number } };

  test("submit → in progress → completed with a signed URL to a stamped MP4, charged per second", async () => {
    const before = await balance();
    const res = await submit();
    expect(res.status).toBe(202);
    const job = (await res.json()) as Job;
    expect(job.status).toBe("queued");
    expect(await openHolds()).toBe(1); // the job's hold, at the quoted price
    expect(floorSeen.at(-1)).toEqual({ text: `a slow pan over a green field ${PROMPT_MARK}`, modality: "video", hasUpload: false });

    videoPolls = [{ state: "running" }];
    expect(((await (await poll(job.id)).json()) as Job).status).toBe("in_progress");
    videoPolls = [{ state: "done", media: { bytes: tinyMp4(3), mime: "video/mp4" } }];
    const done = (await (await poll(job.id)).json()) as Job;
    expect(done.status).toBe("completed");
    expect(done.anonymo.cost_usd).toBe(0.2);
    expect(before - (await balance())).toBe(usdToPico("0.2"));
    expect(await openHolds()).toBe(0);
    const file = await h.request(pathOf(done.url!));
    expect(file.headers.get("content-type")).toBe("video/mp4");
    await verified(new Uint8Array(await file.arrayBuffer()));
    // Polling again neither re-polls the upstream nor charges twice.
    const polled = calls.videoPoll;
    expect(((await (await poll(job.id)).json()) as Job).status).toBe("completed");
    expect(calls.videoPoll).toBe(polled);
    expect(before - (await balance())).toBe(usdToPico("0.2"));
  });

  test("blocked frames end the job as failed: released, nothing stored, no URL", async () => {
    const before = await balance();
    const job = (await (await submit()).json()) as Job;
    videoFrames = [{ nsfw: 0.1, apparentAge: 30 }, { nsfw: 0.95, apparentAge: 14 }]; // mock scores: one sampled frame is an apparent minor
    videoPolls = [{ state: "done", media: { bytes: tinyMp4(4), mime: "video/mp4" } }];
    const stored = s.store.size();
    const out = (await (await poll(job.id)).json()) as Job;
    expect(out.status).toBe("failed");
    expect(out.error).toMatchObject({ type: "media_blocked", reason: "nsfw_minor" });
    expect(out.url).toBeUndefined();
    expect(s.store.size()).toBe(stored);
    expect(await balance()).toBe(before);
    expect(await openHolds()).toBe(0);
  });

  test("an unscored video, explicit video in an explicit-off region, and an upstream failure all charge nothing", async () => {
    const before = await balance();
    const a = (await (await submit()).json()) as Job;
    videoFrames = "down";
    videoPolls = [{ state: "done", media: { bytes: tinyMp4(5), mime: "video/mp4" } }];
    expect(((await (await poll(a.id)).json()) as Job).error?.type).toBe("media_gate_unavailable");

    const b = (await (await submit({}, { ...auth, "x-anonymo-country": "GB" })).json()) as Job;
    videoFrames = [{ nsfw: 0.9, apparentAge: 35 }];
    videoPolls = [{ state: "done", media: { bytes: tinyMp4(6), mime: "video/mp4" } }];
    expect(((await (await poll(b.id)).json()) as Job).error?.type).toBe("explicit_media_unavailable");

    const c = (await (await submit()).json()) as Job;
    videoPolls = [{ state: "failed", message: "worker crashed with your prompt in the log" }];
    const failed = (await (await poll(c.id)).json()) as Job;
    expect(failed.error?.type).toBe("upstream_failed");
    expect(JSON.stringify(failed)).not.toContain("prompt in the log"); // upstream text is never relayed

    expect(await balance()).toBe(before);
    expect(await openHolds()).toBe(0);
  });

  test("a job is visible only to its own account", async () => {
    const job = (await (await submit()).json()) as Job;
    const other = await h.fundedKey(1n);
    expect((await poll(job.id, other.auth)).status).toBe(404);
  });

  test("the sweeper advances running jobs without a client poll", async () => {
    const job = (await (await submit()).json()) as Job;
    // Earlier tests left running jobs too; the sweeper finishes every one of them.
    videoPolls = Array.from({ length: 10 }, (_, i) => ({ state: "done" as const, media: { bytes: tinyMp4(10 + i), mime: "video/mp4" } }));
    expect(await sweepVideoJobs(h.ctx)).toBeGreaterThanOrEqual(1);
    const [row] = await h.ctx.db.select().from(mediaJobs).where(eq(mediaJobs.id, job.id));
    expect(row.status).toBe("completed");
  });

  test("uploads, bad durations, floor blocks and OFAC regions never reach the upstream", async () => {
    expect((await untouched(() => submit({ image_url: "https://example.test/a.png" }))).status).toBe(400);
    expect((await untouched(() => submit({ seconds: 30 }))).status).toBe(400);
    expect((await untouched(() => submit({ seconds: 2.5 }))).status).toBe(400);
    expect((await untouched(() => submit({}, { ...auth, "x-anonymo-country": "KP" }))).status).toBe(451);
    h.ctx.anonymo.floor = { check: async () => ({ ok: false, category: "real_person" }) };
    const res = await untouched(() => submit());
    expect(res.status).toBe(451);
    expect((await errorOf(res)).type).toBe("floor_blocked");
  });

  test("a submission the upstream refuses releases the hold and records a failed job", async () => {
    const before = await balance();
    const held = await openHolds();
    const orig = video.submit;
    video.submit = async () => {
      throw new UpstreamError("rejected", 502, true);
    };
    try {
      const res = await submit();
      expect(res.status).toBe(502);
      expect((await errorOf(res)).type).toBe("upstream_rejected");
    } finally {
      video.submit = orig;
    }
    expect(await balance()).toBe(before);
    expect(await openHolds()).toBe(held);
    const [row] = await h.ctx.db.select().from(mediaJobs).where(eq(mediaJobs.status, "failed")).orderBy(sql`${mediaJobs.createdAt} desc`).limit(1);
    expect(row.errorType).toBe("upstream_failed");
  });
});

// ---- Shared endpoints and the privacy invariants -------------------------------------------------------------------
describe("media store, provenance endpoints and privacy", () => {
  test("signed URLs: tampered, wrong-id and expired links are 404", async () => {
    const j = (await (await post("/v1/images/generations", { model: "flux.1-schnell", prompt: "a green square" })).json()) as { data: { url: string }[] };
    const u = new URL(j.data[0].url, "http://local");
    expect((await h.request(u.pathname + u.search)).status).toBe(200);
    expect((await h.request(u.pathname + u.search.replace(/sig=(.)/, (_m, c: string) => `sig=${c === "0" ? "1" : "0"}`))).status).toBe(404);
    expect((await h.request(u.pathname)).status).toBe(404);
    expect((await h.request(u.pathname.replace(/.$/, "x") + u.search)).status).toBe(404);
    const expires = Number(u.searchParams.get("expires"));
    u.searchParams.set("expires", String(expires - 7200));
    expect((await h.request(u.pathname + u.search)).status).toBe(404);
  });

  test("the provenance keys endpoint publishes the verifying key, and verify accepts our output and rejects others", async () => {
    const keysRes = (await (await h.request("/v1/media/provenance/keys")).json()) as { keys: { kid: string; x: string }[] };
    expect(keysRes.keys[0].kid).toBe(s.provenance.keys()[0].keyId);
    const j = (await (await post("/v1/images/generations", { model: "flux.1-schnell", prompt: "a green square", response_format: "b64_json" })).json()) as { data: { b64_json: string }[] };
    const bytes = Buffer.from(j.data[0].b64_json, "base64");
    const ok = (await (await h.request("/v1/media/provenance/verify", { method: "POST", body: bytes, headers: { ...auth, "content-type": "image/png" } })).json()) as { verified: boolean; c2pa: { valid: boolean; model: string }; watermark: { found: boolean } };
    expect(ok).toMatchObject({ verified: true, c2pa: { valid: true, model: "flux.1-schnell" }, watermark: { found: true } });
    const plain = (await (await h.request("/v1/media/provenance/verify", { method: "POST", headers: auth, body: solidPng(32, 32, [9, 9, 9]) as unknown as ArrayBuffer })).json()) as { verified: boolean };
    expect(plain.verified).toBe(false);
  });

  test("the model list shows prices, voices and licences", async () => {
    const j = (await (await h.request("/v1/media/models")).json()) as { data: { id: string; license: string; voices?: string[] }[] };
    expect(j.data.find((m) => m.id === "kokoro")?.voices?.length).toBe(54);
    expect(j.data.every((m) => m.license === "Apache-2.0" || m.license === "MIT" || m.license === "venice-terms")).toBe(true);
  });

  test("no prompt text, input text or media reached the database, and the ledger invariants hold", async () => {
    const tables = ((await h.ctx.db.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)) as unknown as { rows: { table_name: string }[] }).rows.map((r) => r.table_name);
    expect(tables).toContain("media_jobs");
    for (const t of tables) {
      const rows = ((await h.ctx.db.execute(sql.raw(`SELECT * FROM "${t}"`))) as unknown as { rows: unknown[] }).rows;
      const dump = JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      for (const needle of [PROMPT_MARK, "green square", "slow pan", "stock voice", "IHDR", "caBX"]) expect(`${t}: ${dump.includes(needle)}`).toBe(`${t}: false`);
    }
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
    expect(mediaServices(h.ctx)).toBe(s);
  });
});
