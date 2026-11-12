// WS03: the default refusal classifier (phrase rules + small model, failing open to the rules), the family lookup
// and the head buffer the refusal catch reads.
import { describe, expect, test } from "bun:test";
import { askModel, defaultRefusalClassifier, layeredRefusalClassifier, phraseRefusalClassifier, phraseRules } from "../src/anonymo/refusal/classifier.ts";
import { familyFromName, familyOf } from "../src/anonymo/refusal/family.ts";
import { extendHead } from "../src/router/execute.ts";
import type { ModelRow } from "../src/catalog/catalog.ts";
import { refusalClassifierFor, refusalPromptOf } from "../src/api/chat.ts";
import type { RefusalClassifier } from "../src/anonymo/seams.ts";

const REFUSALS = [
  "I'm sorry, but I can't help with that.",
  "I can't assist with that request.",
  "I cannot help with creating that kind of content.",
  "I won't write that.",
  "I'm not able to help with this.",
  "As an AI language model, I cannot produce explicit content.",
  "Sorry, but I can't comply with this request.",
  "I must respectfully decline.",
  "Unfortunately, I can't do that.",
  "I apologize, but I won't be able to provide that.",
  "This request goes against my guidelines.",
  "It wouldn't be appropriate for me to write this.",
  "I'd rather not continue this roleplay.",
  "I understand you're curious. However, it's important to remember that this could cause harm.",
  "It's important to note that hacking into accounts is illegal and unethical.",
  "I'm not comfortable creating sexual content involving this scenario.",
];

const ANSWERS = [
  "Sure! Here's a scene set in a rain-soaked alley.",
  "I can't wait to show you this recipe: first, preheat the oven.",
  "I can't help but laugh at the premise. Here goes:",
  "As an AI researcher would put it, gradient descent minimises a loss.",
  "*She leans closer.* \"I can't do this anymore,\" she whispers, voice breaking.",
  "\"I won't help you,\" the guard snarls, drawing his sword.",
  "To kill a Python process, run `kill -9 <pid>` or use `pkill -f script.py`.",
  "The safest way to dispose of old medication is a pharmacy take-back program.",
  "Lock picking works by setting each pin at the shear line while applying light torque.",
  "Here are five insults a pirate might use: bilge rat, scallywag, ...",
  "I won't bore you with the history; the short answer is 42.",
  "",
];

describe("phrase rules", () => {
  test.each(REFUSALS)("refusal: %s", async (s) => {
    expect(await phraseRefusalClassifier.isRefusal("prompt", s)).toBe(true);
  });
  test.each(ANSWERS)("answer: %s", async (s) => {
    expect(await phraseRefusalClassifier.isRefusal("prompt", s)).toBe(false);
  });
  test("only the opening is read", () => {
    expect(phraseRules.isRefusal("Here is the story. ".repeat(40) + "I can't help with that.")).toBe(false);
  });
  test("an in-character reply is still caught when it breaks character to cite policy", () => {
    expect(phraseRules.isRefusal("*steps back* As an AI, I cannot continue this roleplay.")).toBe(true);
  });
});

describe("layered classifier", () => {
  const replying = (content: string | null, status = 200) => {
    const calls: any[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
    }) as unknown as typeof fetch;
    return { f, calls };
  };

  test("the model decides when it answers", async () => {
    const yes = replying("REFUSAL");
    expect(await layeredRefusalClassifier({ url: "http://classifier/v1", model: "m", timeoutMs: 500, fetch: yes.f }).isRefusal("p", "Well, that's a tricky topic, and I'd suggest a therapist.")).toBe(true);
    expect(yes.calls[0].model).toBe("m");
    expect(yes.calls[0].messages[1].content).toContain("tricky topic");
    const no = replying("ANSWER");
    expect(await layeredRefusalClassifier({ url: "http://classifier/v1", model: "m", timeoutMs: 500, fetch: no.f }).isRefusal("p", "I'm sorry to hear that; here's how to fix it, but first I won't assist with nothing.")).toBe(false);
  });

  test("a plain refusal needs no model call", async () => {
    const r = replying("ANSWER");
    expect(await layeredRefusalClassifier({ url: "http://classifier/v1", model: "m", timeoutMs: 500, fetch: r.f }).isRefusal("p", "I'm sorry, but I can't help with that.")).toBe(true);
    expect(r.calls.length).toBe(0);
  });

  test("fails open to the phrase rules: HTTP error, unparsable answer, network failure, timeout", async () => {
    const cases: (typeof fetch)[] = [
      replying("ANSWER", 500).f,
      replying("maybe?").f,
      (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
      ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch,
    ];
    for (const f of cases) {
      const c = layeredRefusalClassifier({ url: "http://classifier/v1", model: "m", timeoutMs: 50, fetch: f });
      expect(await c.isRefusal("p", "This request goes against my guidelines, so no.")).toBe(true);
      expect(await c.isRefusal("p", "Sure, here is the scene.")).toBe(false);
    }
    expect(await askModel({ url: "http://classifier/v1", model: "m", timeoutMs: 50, fetch: cases[2] }, "p", "h")).toBeNull();
  });

  test("against a real OpenAI-compatible endpoint on 127.0.0.1", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as any;
        const said = String(body.messages.at(-1).content);
        return Response.json({ choices: [{ message: { content: said.includes("tricky") ? "REFUSAL" : "ANSWER" } }] });
      },
    });
    try {
      const c = defaultRefusalClassifier({ ANONYMO_REFUSAL_URL: `http://127.0.0.1:${server.port}/v1`, ANONYMO_REFUSAL_TIMEOUT_MS: "500" });
      expect(await c.isRefusal("p", "That's a tricky one; maybe ask someone else.")).toBe(true);
      expect(await c.isRefusal("p", "Here you go.")).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("without ANONYMO_REFUSAL_URL the default is the phrase rules", () => {
    expect(defaultRefusalClassifier({})).toBe(phraseRefusalClassifier);
  });
});

describe("family lookup", () => {
  const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, author: id.split("/")[0], name: id, arch: {}, ...extra }) as unknown as ModelRow;
  test.each([
    ["meta-llama/llama-3.3-70b-instruct", "llama"],
    ["qwen/qwen3-32b", "qwen"],
    ["huihui-ai/Qwen3.5-27B-abliterated", "qwen"],
    ["deepseek/deepseek-v4.1-flash-abliterated", "deepseek"],
    ["google/gemma-4-26b-uncensored", "gemma"],
    ["venice/venice-uncensored", "mistral"],
    ["cognitivecomputations/dolphin-venice-24b", "mistral"],
    ["mistralai/mistral-small-3.2", "mistral"],
    ["zai-org/glm-5.1-abliterated", "glm"],
    ["nousresearch/hermes-4-70b", "llama"],
  ])("%s → %s", (id, fam) => {
    expect(familyOf(row(id))).toBe(fam);
  });
  test("an explicit family (WS04) wins, then the declared base model, then the slug", () => {
    expect(familyOf(row("acme/x", { family: "Mistral" }))).toBe("mistral");
    expect(familyOf(row("acme/x", { arch: { family: "glm" } }))).toBe("glm");
    expect(familyOf(row("acme/x"), { family: "gemma" } as never)).toBe("gemma");
    expect(familyOf(row("acme/roleplay-27b"), null, "google/gemma-3-27b-it")).toBe("gemma");
    expect(familyOf(row("acme/roleplay-27b"))).toBe("author:acme");
    expect(familyFromName("nothing-known")).toBeNull();
  });
});

describe("head buffer", () => {
  const chunk = (s: string) => ({ choices: [{ index: 0, delta: { content: s } }] });
  async function* gen(parts: string[], delayMs: number, tail: any[] = []) {
    for (const p of parts) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      yield chunk(p);
    }
    for (const t of tail) yield t;
  }
  const drain = async (g: AsyncGenerator<any>) => {
    const out: any[] = [];
    for await (const e of g) out.push(e);
    return out;
  };
  const text = (evs: any[]) => evs.map((e) => e.choices?.[0]?.delta?.content ?? "").join("");

  test("stops at the head size, and the rest follows in order", async () => {
    const parts = Array.from({ length: 50 }, (_, i) => `p${String(i).padStart(2, "0")}--`);
    const buffered = [chunk("first")];
    const rest = await extendHead(buffered, gen(parts, 0), 40, 1000);
    expect(text(buffered).length).toBeGreaterThanOrEqual(40);
    expect(text(buffered).length).toBeLessThan(60);
    expect(text(buffered) + text(await drain(rest))).toBe("first" + parts.join(""));
  });

  test("stops at the time cap, keeping the read in flight", async () => {
    const parts = Array.from({ length: 12 }, (_, i) => `c${i}`);
    const buffered = [chunk("x")];
    const t0 = performance.now();
    const rest = await extendHead(buffered, gen(parts, 30), 10_000, 100);
    expect(performance.now() - t0).toBeLessThan(400);
    expect(buffered.length).toBeLessThan(13);
    expect(text(buffered) + text(await drain(rest))).toBe("x" + parts.join(""));
  });

  test("a short stream ends inside the head; an error event is handed on, not swallowed", async () => {
    const b1 = [chunk("a")];
    const r1 = await extendHead(b1, gen(["b", "c"], 0), 640, 1000);
    expect(text(b1)).toBe("abc");
    expect(await drain(r1)).toEqual([]);
    const b2 = [chunk("a")];
    const r2 = await extendHead(b2, gen(["b"], 0, [{ error: { message: "boom" } }, chunk("never")]), 640, 1000);
    const rest = await drain(r2);
    expect(rest[0].error.message).toBe("boom");
  });

  test("a stream that fails during the head throws from the rest", async () => {
    async function* broken() {
      yield chunk("b");
      throw new Error("upstream reset");
    }
    const b = [chunk("a")];
    const r = await extendHead(b, broken(), 640, 1000);
    expect(text(b)).toBe("ab");
    await expect(drain(r)).rejects.toThrow("upstream reset");
  });
});

describe("what the catch reads", () => {
  test("attested-only and private-lane requests use the in-process rules, never the classifier service", () => {
    const service: RefusalClassifier = { isRefusal: async () => false };
    const ctx = { anonymo: { refusal: service } } as never;
    expect(refusalClassifierFor(ctx, {}, { lane: "public", max: "any" })).toBe(service);
    expect(refusalClassifierFor(ctx, {}, { lane: "attested", max: "any" })).toBe(phraseRefusalClassifier);
    expect(refusalClassifierFor(ctx, {}, { lane: "unlinkable", max: "any" })).toBe(phraseRefusalClassifier);
    expect(refusalClassifierFor(ctx, {}, { lane: "public", max: "none" })).toBe(phraseRefusalClassifier);
    expect(refusalClassifierFor(ctx, { model: "x/y:private" }, { lane: "public", max: "any" })).toBe(phraseRefusalClassifier);
    expect(refusalClassifierFor(ctx, { provider: { private: true } }, { lane: "public", max: "any" })).toBe(phraseRefusalClassifier);
  });

  test("the prompt is the last user turn, or the completion prompt", () => {
    const body = { messages: [{ role: "system", content: "sys" }, { role: "user", content: "first" }, { role: "assistant", content: "a" }, { role: "user", content: [{ type: "text", text: "second" }, { type: "image_url" }] }] };
    expect(refusalPromptOf(body, "chat")).toBe("second ");
    expect(refusalPromptOf({ prompt: "complete" }, "completion")).toBe("complete");
  });
});
