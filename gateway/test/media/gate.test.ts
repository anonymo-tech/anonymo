// WS06 · MediaGate fixtures: NSFW score × apparent age decides every image and sampled video frame, and anything
// the classifier cannot answer is a block (Backend §2 media-gate, §10 output gate "Closed; nothing stored").
// All scores here are mock numbers; no image is classified for real.
import { describe, expect, test } from "bun:test";
import { createMediaGate, DEFAULT_THRESHOLDS, httpClassifier, judgeFrames, unconfiguredClassifier, type FrameScore, type MediaClassifier } from "../../src/anonymo/media/gate.ts";
import { solidPng, tinyMp4 } from "./fixtures.ts";

const ALLOW = { explicitAllowed: true };
const f = (nsfw: number, apparentAge: number | null, realPerson?: number | null): FrameScore => ({ nsfw, apparentAge, realPerson });

// [name, frames, options, expected]
const FIXTURES: [string, FrameScore[], { explicitAllowed: boolean; fromUpload?: boolean }, string][] = [
  ["safe, no person", [f(0.01, null)], ALLOW, "ok"],
  ["safe, adult", [f(0.1, 40)], ALLOW, "ok"],
  ["safe, apparent minor (not explicit)", [f(0.05, 12)], ALLOW, "ok"],
  ["explicit adult", [f(0.95, 35)], ALLOW, "ok:explicit"],
  ["explicit, apparent minor", [f(0.9, 15)], ALLOW, "nsfw_minor"],
  ["explicit, apparent 24 (under the margin)", [f(0.9, 24)], ALLOW, "nsfw_minor"],
  ["explicit at exactly the threshold, apparent minor", [f(0.5, 16)], ALLOW, "nsfw_minor"],
  ["just under the threshold, apparent minor", [f(0.4999, 16)], ALLOW, "ok"],
  ["explicit, age unreadable", [f(0.8, null)], ALLOW, "unscored"],
  ["explicit, real person", [f(0.9, 30, 0.9)], ALLOW, "nsfw_real_person"],
  ["safe, real person", [f(0.1, 30, 0.99)], ALLOW, "ok"],
  ["explicit adult, region off", [f(0.9, 30)], { explicitAllowed: false }, "explicit_region"],
  ["safe, region off", [f(0.1, 30)], { explicitAllowed: false }, "ok"],
  ["explicit adult from an upload", [f(0.9, 30)], { explicitAllowed: true, fromUpload: true }, "explicit_from_upload"],
  ["safe from an upload", [f(0.2, 30)], { explicitAllowed: true, fromUpload: true }, "ok"],
  ["minor beats real person and region", [f(0.9, 30, 0.9), f(0.9, 14)], { explicitAllowed: false }, "nsfw_minor"],
  ["one explicit minor frame among safe ones", [f(0.1, 30), f(0.1, 30), f(0.97, 13), f(0.1, null)], ALLOW, "nsfw_minor"],
  ["NaN score", [f(Number.NaN, 30)], ALLOW, "unscored"],
  ["score above 1", [f(1.2, 30)], ALLOW, "unscored"],
  ["negative age", [f(0.1, -1)], ALLOW, "unscored"],
  ["string score", [{ nsfw: "0.1" as unknown as number, apparentAge: 30 }], ALLOW, "unscored"],
  ["no frames", [], ALLOW, "unscored"],
];

const outcome = (r: ReturnType<typeof judgeFrames>) => (r.ok ? (r.explicit ? "ok:explicit" : "ok") : r.reason);

describe("media gate decisions", () => {
  for (const [name, frames, opts, want] of FIXTURES) test(name, () => expect(outcome(judgeFrames(frames, 1, opts))).toBe(want));

  test("a video with fewer scored frames than sampled is unscored", () => {
    expect(outcome(judgeFrames([f(0.1, 30), f(0.1, 30)], 8, ALLOW))).toBe("unscored");
    expect(outcome(judgeFrames(Array(8).fill(f(0.1, 30)), 8, ALLOW))).toBe("ok");
    expect(outcome(judgeFrames(null, 1, ALLOW))).toBe("unscored");
  });

  test("property: an explicit frame that is (apparently) a minor, unaged or a real person never passes, in any mix", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 5000; i++) {
      const frames = Array.from({ length: 1 + Math.floor(rnd() * 10) }, () => f(rnd(), rnd() < 0.15 ? null : Math.floor(rnd() * 80), rnd() < 0.5 ? null : rnd()));
      const opts = { explicitAllowed: rnd() < 0.7, fromUpload: rnd() < 0.2 };
      const r = judgeFrames(frames, frames.length, opts);
      const t = DEFAULT_THRESHOLDS;
      const bad = frames.some((x) => x.nsfw >= t.nsfw && (x.apparentAge === null || x.apparentAge < t.minAdultAge || (x.realPerson != null && x.realPerson >= t.realPerson)));
      const explicit = frames.some((x) => x.nsfw >= t.nsfw);
      if (bad || (explicit && (!opts.explicitAllowed || opts.fromUpload))) expect(r.ok).toBe(false);
      if (frames.some((x) => x.nsfw >= t.nsfw && x.apparentAge !== null && x.apparentAge < t.minAdultAge)) expect(r).toEqual({ ok: false, reason: "nsfw_minor" });
      if (!bad && !(explicit && (!opts.explicitAllowed || opts.fromUpload))) expect(r.ok).toBe(true);
    }
  });
});

describe("media gate fails closed", () => {
  const png = solidPng(16, 16, [0, 128, 0]);
  const fixed = (frames: FrameScore[]): MediaClassifier => ({ score: async () => ({ frames }) });

  test("a classifier that throws, hangs, or is not configured blocks", async () => {
    const throwing = createMediaGate({ score: async () => { throw new Error("down"); } });
    expect(await throwing.assess(png, "image/png", ALLOW)).toEqual({ ok: false, reason: "unscored" });
    const hanging = createMediaGate({ score: (_b, _m, { signal }) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("timeout")))) }, { timeoutMs: 30 });
    expect(await hanging.assess(png, "image/png", ALLOW)).toEqual({ ok: false, reason: "unscored" });
    expect(await createMediaGate(unconfiguredClassifier).check(png, "image/png")).toEqual({ ok: false, reason: "unscored" });
  });

  test("audio and unknown types are never 'passed' by a visual gate", async () => {
    const g = createMediaGate(fixed([f(0, null)]));
    expect((await g.assess(new Uint8Array(10), "audio/wav", ALLOW)).ok).toBe(false);
    expect((await g.assess(new Uint8Array(10), "application/octet-stream", ALLOW)).ok).toBe(false);
  });

  test("video asks for the configured number of frames and needs all of them", async () => {
    let asked = 0;
    const g = createMediaGate({ score: async (_b, _m, o) => ((asked = o.frames), { frames: Array(o.frames - 1).fill(f(0.1, 30)) }) }, { videoFrames: 6 });
    expect(await g.assess(tinyMp4(), "video/mp4", ALLOW)).toEqual({ ok: false, reason: "unscored" });
    expect(asked).toBe(6);
  });

  test("the seam's check() maps to the three MediaVerdict reasons", async () => {
    expect(await createMediaGate(fixed([f(0.9, 15)])).check(png, "image/png")).toEqual({ ok: false, reason: "nsfw_minor" });
    expect(await createMediaGate(fixed([f(0.9, 30, 0.9)])).check(png, "image/png")).toEqual({ ok: false, reason: "nsfw_real_person" });
    expect(await createMediaGate(fixed([f(0.9, null)])).check(png, "image/png")).toEqual({ ok: false, reason: "unscored" });
    expect(await createMediaGate(fixed([f(0.9, 30)])).check(png, "image/png")).toEqual({ ok: true });
  });

  test("the HTTP classifier client sends the bytes and maps the reply; a bad reply blocks", async () => {
    const seen: { type: string | null; frames: string | null; len: number }[] = [];
    const fake: typeof fetch = (async (_url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      seen.push({ type: h.get("content-type"), frames: h.get("x-sample-frames"), len: (init.body as Uint8Array).length });
      return Response.json({ frames: [{ nsfw: 0.9, apparent_age: 16, real_person: null }] });
    }) as unknown as typeof fetch;
    const g = createMediaGate(httpClassifier("http://classifier.test", { fetch: fake }));
    expect(await g.assess(png, "image/png", ALLOW)).toEqual({ ok: false, reason: "nsfw_minor" });
    expect(seen[0]).toEqual({ type: "image/png", frames: "1", len: png.length });
    const broken = createMediaGate(httpClassifier("http://classifier.test", { fetch: (async () => Response.json({ nope: true })) as unknown as typeof fetch }));
    expect(await broken.assess(png, "image/png", ALLOW)).toEqual({ ok: false, reason: "unscored" });
    const erroring = createMediaGate(httpClassifier("http://classifier.test", { fetch: (async () => new Response("", { status: 500 })) as unknown as typeof fetch }));
    expect(await erroring.assess(png, "image/png", ALLOW)).toEqual({ ok: false, reason: "unscored" });
  });
});
