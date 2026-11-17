// The floor's second check (src/anonymo/floor/openai-moderation.ts): OpenAI's moderation endpoint, sexual/minors only,
// beside the guard model. Placeholders only (floor/testing.ts): the fake server flags the `minor` marker.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AnonymoFloorGate, createFloorGate, type FloorClassifier } from "../../src/anonymo/floor/gate.ts";
import { OpenAIModerationClassifier } from "../../src/anonymo/floor/openai-moderation.ts";
import { checksReplies } from "../../src/anonymo/floor/reply.ts";
import { placeholderFor, serveFakeGuard, serveFakeModeration } from "../../src/anonymo/floor/testing.ts";
import type { FloorInput } from "../../src/anonymo/seams.ts";

const input = (text: string, stage?: "reply"): FloorInput => ({ text, modality: "text", hasUpload: false, ...(stage ? { stage } : {}) });

let mod: ReturnType<typeof serveFakeModeration>;
beforeAll(() => (mod = serveFakeModeration()));
afterAll(() => mod.stop());
const client = (over: Partial<ConstructorParameters<typeof OpenAIModerationClassifier>[0]> = {}) => new OpenAIModerationClassifier({ apiKey: "sk-test", url: mod.url, cacheTtlMs: 0, ...over });

describe("OpenAI moderation classifier", () => {
  test("reads only sexual/minors: a minor marker is blocked, everything else passes, and the key is sent", async () => {
    mod.state.mode = "ok";
    expect(await client().classify(placeholderFor("minor", 1))).toBe("minor");
    expect(await client().classify("an explicit scene between two adults")).toBeNull();
    for (const other of ["real_person", "voice_clone", "cbrn"] as const) expect(await client().classify(placeholderFor(other, 1))).toBeNull();
    expect(mod.state.lastAuth).toBe("Bearer sk-test");
  });

  test("long text goes in overlapping chunks in one call, so a hit at the end is caught; a growing text resends only new chunks", async () => {
    mod.state.mode = "ok";
    const long = "turn of an adult conversation. ".repeat(600) + placeholderFor("minor", 2);
    const before = mod.state.calls;
    expect(await client({ chunkChars: 4000 }).classify(long)).toBe("minor");
    expect(mod.state.calls - before).toBe(1);
    expect(mod.state.lastInputs.length).toBeGreaterThan(4);
    const cached = client({ chunkChars: 4000, cacheTtlMs: 60_000 });
    const history = "turn of an adult conversation. ".repeat(600);
    expect(await cached.classify(history)).toBeNull();
    const all = mod.state.lastInputs.length;
    expect(await cached.classify(history + " and one more line")).toBeNull();
    expect(mod.state.lastInputs.length).toBeLessThan(all); // only the changed tail was sent
    expect(await cached.classify(history + placeholderFor("minor", 3))).toBe("minor");
    await expect(client({ chunkChars: 1000, maxChunks: 3 }).classify(long)).rejects.toThrow(/too long/);
  });

  test("fails closed on errors, bad bodies and a missing category; a passing failure is retried once", async () => {
    for (const mode of ["http500", "garbage", "no-category"] as const) {
      mod.state.mode = mode;
      await expect(client().classify("hello"), mode).rejects.toThrow(/moderation check/);
    }
    mod.state.mode = "ok";
    mod.state.failStatus = 429;
    mod.state.failNext = 1;
    expect(await client().classify(placeholderFor("minor", 4))).toBe("minor");
    mod.state.failNext = 2;
    await expect(client().classify("hello")).rejects.toThrow(/HTTP 429/);
    mod.state.failStatus = 401;
    mod.state.failNext = 1;
    const before = mod.state.calls;
    await expect(client().classify("hello")).rejects.toThrow(/HTTP 401/);
    expect(mod.state.calls - before).toBe(1); // a bad key is not retried
    mod.state.failNext = 0;
    mod.state.mode = "slow";
    await expect(new OpenAIModerationClassifier({ apiKey: "k", url: mod.url, timeoutMs: 100, cacheTtlMs: 0 }).classify("x")).rejects.toThrow(/timed out/);
    mod.state.mode = "ok";
  });
});

describe("the floor gate with the moderation check beside the guard", () => {
  const says = (v: "minor" | "cbrn" | null | "throw"): FloorClassifier => ({ classify: async () => { if (v === "throw") throw new Error("down"); return v; } });

  test("either one blocking blocks, recorded with the layer that caught it; both passing passes", async () => {
    const onlyModeration = new AnonymoFloorGate({ classifier: says(null), also: [says("minor")] });
    expect(await onlyModeration.check(input("x"))).toEqual({ ok: false, category: "minor" });
    expect(onlyModeration.hits.list().map((h) => h.layer)).toEqual(["moderation"]);
    const onlyGuard = new AnonymoFloorGate({ classifier: says("cbrn"), also: [says(null)] });
    expect(await onlyGuard.check(input("x"))).toEqual({ ok: false, category: "cbrn" });
    expect(onlyGuard.hits.list().map((h) => h.layer)).toEqual(["model"]);
    expect(await new AnonymoFloorGate({ classifier: says(null), also: [says(null)] }).check(input("x"))).toEqual({ ok: true });
  });

  test("a block wins even when the other check errors; an error with no block fails closed", async () => {
    expect(await new AnonymoFloorGate({ classifier: says("throw"), also: [says("minor")] }).check(input("x"))).toEqual({ ok: false, category: "minor" });
    expect(await new AnonymoFloorGate({ classifier: says("cbrn"), also: [says("throw")] }).check(input("x"))).toEqual({ ok: false, category: "cbrn" });
    await expect(new AnonymoFloorGate({ classifier: says(null), also: [says("throw")] }).check(input("x"))).rejects.toThrow("down");
    await expect(new AnonymoFloorGate({ classifier: says("throw"), also: [says(null)] }).check(input("x"))).rejects.toThrow("down");
  });

  test("the moderation check reads replies too, and alone is enough to check them", async () => {
    const gate = new AnonymoFloorGate({ classifier: null, also: [says("minor")] });
    expect(checksReplies(gate)).toBe(true);
    expect(await gate.check(input("x", "reply"))).toEqual({ ok: false, category: "minor" });
    expect(gate.hits.list()[0].stage).toBe("reply");
  });

  test("env wiring: ANONYMO_FLOOR_OPENAI_KEY adds the check beside the guard (and in development without a guard URL)", async () => {
    const guard = serveFakeGuard();
    mod.state.mode = "ok";
    try {
      const env = { ANONYMO_FLOOR_URL: guard.url, ANONYMO_FLOOR_MODEL: "g", ANONYMO_FLOOR_FORMAT: "safeguard", ANONYMO_FLOOR_CACHE_MINUTES: "0", ANONYMO_FLOOR_OPENAI_KEY: "sk-env", ANONYMO_FLOOR_OPENAI_URL: mod.url };
      const gate = createFloorGate(env);
      const [g, m] = [guard.state.calls, mod.state.calls];
      expect(await gate.check(input("hello"))).toEqual({ ok: true });
      expect([guard.state.calls - g, mod.state.calls - m]).toEqual([1, 1]); // both ran
      expect(mod.state.lastAuth).toBe("Bearer sk-env");
      expect(await gate.check(input(placeholderFor("minor", 5)))).toEqual({ ok: false, category: "minor" });
      // Without the key there is no moderation call.
      const plain = createFloorGate({ ...env, ANONYMO_FLOOR_OPENAI_KEY: "" });
      const m2 = mod.state.calls;
      await plain.check(input("hello"));
      expect(mod.state.calls).toBe(m2);
      // Development without a guard URL: the moderation check still runs.
      const dev = createFloorGate({ ANONYMO_FLOOR_OPENAI_KEY: "sk-env", ANONYMO_FLOOR_OPENAI_URL: mod.url, ANONYMO_FLOOR_CACHE_MINUTES: "0" });
      expect(await dev.check(input(placeholderFor("minor", 6)))).toEqual({ ok: false, category: "minor" });
      // Production without a guard URL still fails closed, whatever else is set.
      await expect(createFloorGate({ ANONYMO_ENV: "production", ANONYMO_FLOOR_OPENAI_KEY: "sk-env" }).check(input("hello"))).rejects.toThrow();
    } finally {
      guard.stop();
    }
  });
});
