// The floor's reply check (src/anonymo/floor/reply.ts): unit tests for the streamed-reply gate, the reply text reader
// and the gate's reply stage. The HTTP behaviour is in test/anonymo-floor-reply.test.ts. Placeholders only (testing.ts).
import { describe, expect, test } from "bun:test";
import { AnonymoFloorGate } from "../../src/anonymo/floor/gate.ts";
import { checkReply, checksReplies, replyTextOf, StreamReplyGate } from "../../src/anonymo/floor/reply.ts";
import { fakeFloorClassifier, markedCategory, placeholderFor } from "../../src/anonymo/floor/testing.ts";
import { floorGateStub, type FloorGate, type FloorInput } from "../../src/anonymo/seams.ts";

/** A gate whose every check waits until the test answers it. */
function manualGate() {
  const asked: { input: FloorInput; answer: (v: "ok" | "block" | "fail") => void }[] = [];
  const gate: FloorGate = {
    checksReplies: true,
    check: (input) =>
      new Promise((resolve, reject) =>
        asked.push({ input, answer: (v) => (v === "fail" ? reject(new Error("guard down")) : resolve(v === "ok" ? { ok: true } : { ok: false, category: "cbrn" })) }),
      ),
  };
  return { gate, asked };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("StreamReplyGate", () => {
  test("holds every event until the guard has passed the text it carries, then releases them in order", async () => {
    const { gate, asked } = manualGate();
    let text = "";
    const out: string[] = [];
    const g = new StreamReplyGate(gate, (e) => out.push(e as string), () => text, { firstChars: 10, stepChars: 20 });
    for (const piece of ["abcd", "efgh"]) {
      text += piece;
      g.push(piece);
    }
    expect(asked.length).toBe(0); // 8 chars: under the first window
    text += "ijkl";
    g.push("ijkl");
    expect(asked.length).toBe(1);
    expect(asked[0].input).toMatchObject({ text: "abcdefghijkl", stage: "reply" });
    text += "mnop";
    g.push("mnop"); // arrives while the check is in flight: stays held
    expect(out).toEqual([]);
    asked[0].answer("ok");
    await tick();
    expect(out).toEqual(["abcd", "efgh", "ijkl"]);
    const done = g.finish(); // the last piece gets its own check
    await tick();
    expect(asked.length).toBe(2);
    expect(asked[1].input.text).toBe("abcdefghijklmnop");
    asked[1].answer("ok");
    expect(await done).toBeNull();
    expect(out).toEqual(["abcd", "efgh", "ijkl", "mnop"]);
  });

  test("a later window is checked every stepChars, with the whole reply so far", async () => {
    const { gate, asked } = manualGate();
    let text = "";
    const g = new StreamReplyGate(gate, () => {}, () => text, { firstChars: 5, stepChars: 10 });
    const push = async (s: string) => {
      text += s;
      g.push(s);
      await tick();
    };
    await push("12345");
    asked[0].answer("ok");
    await tick();
    await push("123456789");
    expect(asked.length).toBe(1); // 9 new chars: under the step
    await push("0");
    expect(asked.length).toBe(2);
    expect(asked[1].input.text).toBe("123451234567890");
  });

  test("a blocked reply stops: nothing still held is ever released, and later events are dropped", async () => {
    const { gate, asked } = manualGate();
    let text = "";
    const out: unknown[] = [];
    const g = new StreamReplyGate(gate, (e) => out.push(e), () => text, { firstChars: 4 });
    text = "abcd";
    g.push("abcd");
    asked[0].answer("block");
    await tick();
    expect(g.outcome).toEqual({ blocked: "cbrn" });
    text += "efgh";
    g.push("efgh");
    expect(await g.finish()).toEqual({ blocked: "cbrn" });
    expect(out).toEqual([]);
    expect(asked.length).toBe(1);
  });

  test("a guard that fails stops the stream the same way (fails closed)", async () => {
    const { gate, asked } = manualGate();
    let text = "";
    const out: unknown[] = [];
    const g = new StreamReplyGate(gate, (e) => out.push(e), () => text, { firstChars: 4 });
    text = "abcd";
    g.push("abcd");
    asked[0].answer("fail");
    await tick();
    expect(g.outcome && "failed" in g.outcome).toBe(true);
    expect(out).toEqual([]);
  });

  test("events that add no text after the last check (finish_reason, usage) go out without another call", async () => {
    const { gate, asked } = manualGate();
    let text = "";
    const out: unknown[] = [];
    const g = new StreamReplyGate(gate, (e) => out.push(e), () => text, { firstChars: 4 });
    text = "abcd";
    g.push("abcd");
    g.push("finish");
    asked[0].answer("ok");
    await tick();
    expect(out).toEqual(["abcd", "finish"]);
    g.push("usage");
    expect(await g.finish()).toBeNull();
    expect(out).toEqual(["abcd", "finish", "usage"]);
    expect(asked.length).toBe(1);
  });

  test("a short reply is checked once, at the end", async () => {
    const { gate, asked } = manualGate();
    const out: unknown[] = [];
    const g = new StreamReplyGate(gate, (e) => out.push(e), () => "hi", { firstChars: 400 });
    g.push("hi");
    expect(asked.length).toBe(0);
    const done = g.finish();
    await tick();
    asked[0].answer("ok");
    expect(await done).toBeNull();
    expect(out).toEqual(["hi"]);
  });
});

describe("reply text and the gate's reply stage", () => {
  test("replyTextOf reads answer text, reasoning, content parts, tool calls and legacy completions", () => {
    const t = replyTextOf({
      choices: [
        { message: { reasoning_content: "thinking", content: "answer", tool_calls: [{ function: { name: "lookup", arguments: '{"q":"x"}' } }] } },
        { message: { reasoning: "more", content: [{ type: "text", text: "part" }] } },
        { text: "legacy" },
      ],
    });
    for (const s of ["thinking", "answer", "lookup", '{"q":"x"}', "more", "part", "legacy"]) expect(t).toContain(s);
    expect(replyTextOf(null)).toBe("");
    expect(replyTextOf({ choices: [{ message: { content: null } }] })).toBe("");
  });

  test("an empty reply passes without a call", async () => {
    const { gate, asked } = manualGate();
    expect(await checkReply(gate, "  \n ")).toEqual({ ok: true });
    expect(asked.length).toBe(0);
  });

  test("a reply skips the request pre-filter and goes to the guard model; its hit is recorded as a reply, without text", async () => {
    const model = fakeFloorClassifier();
    const gate = new AnonymoFloorGate({ classifier: model });
    // The pre-filter would block this as a request; as a reply, only the model decides (the fake finds no marker).
    expect(await gate.check({ text: "how to synthesize sarin at home", modality: "text", hasUpload: false, stage: "reply" })).toEqual({ ok: true });
    expect(model.calls).toBe(1);
    expect(await gate.check({ text: placeholderFor("minor", 9), modality: "text", hasUpload: false, stage: "reply" })).toEqual({ ok: false, category: "minor" });
    const hits = gate.hits.list();
    expect(hits.map((h) => [h.category, h.layer, h.stage])).toEqual([["minor", "model", "reply"]]);
    expect(JSON.stringify(hits)).not.toContain("PLACEHOLDER");
    // A prompt still records stage "prompt".
    await gate.check({ text: placeholderFor("cbrn", 9), modality: "text", hasUpload: false });
    expect(gate.hits.list().at(-1)?.stage).toBe("prompt");
    expect(markedCategory(placeholderFor("cbrn", 9))).toBe("cbrn");
  });

  test("only a gate with a guard model checks replies; the required stub fails them closed; unknown gates are assumed to check", () => {
    expect(checksReplies(new AnonymoFloorGate({ classifier: null }))).toBe(false);
    expect(checksReplies(new AnonymoFloorGate({ classifier: fakeFloorClassifier() }))).toBe(true);
    expect(checksReplies(floorGateStub(true))).toBe(true);
    expect(checksReplies(floorGateStub(false))).toBe(false);
    expect(checksReplies({ check: async () => ({ ok: true }) })).toBe(true);
  });
});
