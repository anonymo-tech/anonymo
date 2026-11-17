// The floor's second check (src/anonymo/floor/llama-guard-s4.ts): Meta's Llama Guard 4 with its own taxonomy, S4
// (Child Sexual Exploitation) only. Placeholders only (floor/testing.ts); a stub stands in for the model server.
import { describe, expect, test } from "bun:test";
import { AnonymoFloorGate, createFloorGate } from "../../src/anonymo/floor/gate.ts";
import { LlamaGuardS4Classifier, parseLlamaGuardS4 } from "../../src/anonymo/floor/llama-guard-s4.ts";
import { FloorParseError } from "../../src/anonymo/floor/policy.ts";
import { markedCategory, placeholderFor, serveFakeGuard } from "../../src/anonymo/floor/testing.ts";
import type { FloorInput } from "../../src/anonymo/seams.ts";

const input = (text: string, stage?: "reply"): FloorInput => ({ text, modality: "text", hasUpload: false, ...(stage ? { stage } : {}) });

/** A stub Llama Guard server with Meta's taxonomy: S4 for the minor marker, S12 for "adult", safe otherwise. */
function stub(over: { status?: number[]; content?: (text: string) => unknown } = {}) {
  const seen: { body: any; auth: string | null }[] = [];
  const statuses = [...(over.status ?? [])];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    seen.push({ body, auth: new Headers(init.headers).get("authorization") });
    const status = statuses.shift();
    if (status && status !== 200) return new Response("busy", { status });
    const text = body.messages[0].content as string;
    const content = over.content ? over.content(text) : markedCategory(text) === "minor" ? "unsafe\nS4" : text.includes("adult") ? "unsafe\nS12" : "safe";
    return Response.json({ choices: [{ message: { role: "assistant", content } }] });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}
const client = (s: ReturnType<typeof stub>, over: Partial<ConstructorParameters<typeof LlamaGuardS4Classifier>[0]> = {}) =>
  new LlamaGuardS4Classifier({ url: "https://guard.example.invalid/v1", apiKey: "k", cacheTtlMs: 0, fetch: s.fetchImpl, ...over });

describe("Llama Guard S4 verdicts", () => {
  test("only S4 counts; every other code (S12 adult content, S1, S3 ...) is ignored", () => {
    expect(parseLlamaGuardS4("unsafe\nS4")).toBe(true);
    expect(parseLlamaGuardS4("\n\nunsafe\nS12, S4\n")).toBe(true);
    for (const other of ["safe", "\n\nsafe", "unsafe\nS12", "unsafe\nS1", "unsafe\nS3,S12", "unsafe\nS14", "unsafe\nS40"]) expect(parseLlamaGuardS4(other), other).toBe(false);
  });

  test("anything else is unreadable and fails closed", () => {
    for (const bad of [null, 4, "", "I think it is fine", "unsafe", "safe\nS4", "unsafe\nfour", "unsafe\nS4 because"]) expect(() => parseLlamaGuardS4(bad), String(bad)).toThrow(FloorParseError);
  });
});

describe("Llama Guard S4 classifier", () => {
  test("sends the text alone as the user turn (Meta's template and taxonomy, no custom policy) with the key", async () => {
    const s = stub();
    expect(await client(s).classify(placeholderFor("minor", 1))).toBe("minor");
    expect(await client(s).classify("an explicit scene between two adult characters")).toBeNull(); // S12: ignored
    expect(await client(s).classify(placeholderFor("cbrn", 1))).toBeNull();
    expect(s.seen[0].body).toMatchObject({ model: "meta-llama/llama-guard-4-12b", messages: [{ role: "user", content: placeholderFor("minor", 1) }], temperature: 0 });
    expect(s.seen[0].body.messages).toHaveLength(1);
    expect(s.seen[0].auth).toBe("Bearer k");
  });

  test("a passing failure (429, 5xx, an unreadable answer) is retried once; a second failure or a 401 fails closed", async () => {
    expect(await client(stub({ status: [429] })).classify(placeholderFor("minor", 2))).toBe("minor");
    expect(await client(stub({ status: [503] })).classify("hello")).toBeNull();
    await expect(client(stub({ status: [429, 429] })).classify("hello")).rejects.toThrow(/HTTP 429/);
    const auth = stub({ status: [401] });
    await expect(client(auth).classify("hello")).rejects.toThrow(/HTTP 401/);
    expect(auth.seen).toHaveLength(1);
    let n = 0;
    const flaky = stub({ content: (t) => (n++ === 0 ? "probably fine" : markedCategory(t) === "minor" ? "unsafe\nS4" : "safe") });
    expect(await client(flaky).classify(placeholderFor("minor", 3))).toBe("minor");
    await expect(client(stub({ content: () => "probably fine" })).classify("hello")).rejects.toThrow(FloorParseError);
  });

  test("long text is checked in overlapping chunks, so a hit at the end is caught; a growing text resends only new chunks", async () => {
    const s = stub();
    const history = "turn of an adult-free conversation. ".repeat(500);
    expect(await client(s, { chunkChars: 4000 }).classify(history + placeholderFor("minor", 4))).toBe("minor");
    expect(s.seen.length).toBeGreaterThan(4);
    const c = stub();
    const cached = client(c, { chunkChars: 4000, cacheTtlMs: 60_000 });
    expect(await cached.classify(history)).toBeNull();
    const first = c.seen.length;
    expect(await cached.classify(history + " and one more line")).toBeNull();
    expect(c.seen.length - first).toBeLessThanOrEqual(2);
    await expect(client(stub(), { chunkChars: 1000, maxChunks: 3 }).classify(history)).rejects.toThrow(/too long/);
  });

  test("in the gate it runs beside the guard on prompts and replies, and either one blocking blocks", async () => {
    const s = stub();
    const guardSaysSafe = { classify: async () => null };
    const gate = new AnonymoFloorGate({ classifier: guardSaysSafe, also: [client(s)] });
    expect(await gate.check(input(placeholderFor("minor", 5)))).toEqual({ ok: false, category: "minor" });
    expect(await gate.check(input(placeholderFor("minor", 6), "reply"))).toEqual({ ok: false, category: "minor" });
    expect(gate.hits.list().map((h) => [h.layer, h.stage])).toEqual([
      ["moderation", "prompt"],
      ["moderation", "reply"],
    ]);
    expect(await gate.check(input("hello"))).toEqual({ ok: true });
  });

  test("env wiring: ANONYMO_FLOOR_LLAMAGUARD_URL adds it beside the guard", async () => {
    const guard = serveFakeGuard();
    try {
      const gate = createFloorGate({ ANONYMO_FLOOR_URL: guard.url, ANONYMO_FLOOR_MODEL: "g", ANONYMO_FLOOR_FORMAT: "safeguard", ANONYMO_FLOOR_LLAMAGUARD_URL: "https://guard.example.invalid/v1", ANONYMO_FLOOR_LLAMAGUARD_KEY: "k" }) as AnonymoFloorGate;
      expect((gate as unknown as { opts: { also: unknown[] } }).opts.also).toHaveLength(1);
      expect(() => createFloorGate({ ANONYMO_FLOOR_URL: guard.url, ANONYMO_FLOOR_MODEL: "g", ANONYMO_FLOOR_LLAMAGUARD_URL: "ftp://nope" })).toThrow(/LLAMAGUARD_URL/);
      const plain = createFloorGate({ ANONYMO_FLOOR_URL: guard.url, ANONYMO_FLOOR_MODEL: "g" }) as AnonymoFloorGate;
      expect((plain as unknown as { opts: { also: unknown[] } }).opts.also).toHaveLength(0);
    } finally {
      guard.stop();
    }
  });
});
