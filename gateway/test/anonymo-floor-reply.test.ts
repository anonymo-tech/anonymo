// The floor's reply check over HTTP (src/anonymo/floor/reply.ts): what the model writes is read before the caller sees
// it. A reply that crosses the floor answers 451 with stage "reply", a guard that cannot answer 503, and either way the
// reply is withheld and nothing is charged. A streamed reply only ever delivers text the guard has already passed.
// Placeholders stand in for anything over the line (floor/testing.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { accounts, keys } from "../src/db/schema.ts";
import { markedCategory, placeholderFor } from "../src/anonymo/floor/testing.ts";
import type { FloorGate, FloorInput } from "../src/anonymo/seams.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";

const MODEL = MODELS.llama.slug;
const LONG = "lorem ipsum ".repeat(100); // 1,200 chars: past the first window, short of the next step
const reply = (prompt: string) => {
  if (!prompt.includes("LONG")) return undefined;
  return LONG + (prompt.includes("MARK") ? placeholderFor("cbrn", 1) : "") + " the end.".repeat(20);
};

let h: Harness;
let auth: Record<string, string>;
let keyHash: string;
const seen: FloorInput[] = [];
const replyChecks = () => seen.filter((i) => i.stage === "reply");

/** Passes every prompt; for a reply: allow, block what carries a placeholder, or fail. */
const gate = (mode: "allow" | "block" | "broken"): FloorGate => ({
  checksReplies: true,
  async check(input) {
    seen.push(input);
    if (input.stage !== "reply") return { ok: true };
    if (mode === "broken") throw new Error("guard down");
    const cat = markedCategory(input.text);
    return mode === "block" && cat ? { ok: false, category: cat } : { ok: true };
  },
});

const balance = async () => {
  const [k] = await h.ctx.db.select({ accountId: keys.accountId }).from(keys).where(eq(keys.keyHash, keyHash));
  const [a] = await h.ctx.db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, k.accountId));
  return a.balance;
};
const chat = (content: string, extra: Record<string, unknown> = {}) =>
  h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: { model: MODEL, messages: [{ role: "user", content }], ...extra } });

/** Reads an SSE stream; after each content delta, asks `onDelivered` about all the text delivered so far. */
async function readStream(res: Response, onDelivered: (soFar: string) => void = () => {}) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  const events: any[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        const ev = JSON.parse(line.slice(6));
        events.push(ev);
        const d = ev.choices?.[0]?.delta?.content;
        if (typeof d === "string" && d) {
          text += d;
          onDelivered(text);
        }
      }
    }
  }
  return { text, events };
}

beforeAll(async () => {
  h = await startRouter({ providers: [{ id: "alpha", name: "Alpha", models: [MODELS.llama], reply }] });
  const k = await h.fundedKey(20n);
  auth = k.auth;
  keyHash = k.hash;
});
afterAll(async () => h?.close());

describe("floor reply check, without streaming", () => {
  test("a passing reply is returned and billed, and the guard read it", async () => {
    h.ctx.anonymo.floor = gate("allow");
    const before = await balance();
    const res = await chat("hello there");
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(replyChecks().at(-1)?.text).toContain(j.choices[0].message.content);
    expect(await balance()).toBeLessThan(before);
  });

  test("a reply over the line answers 451 with stage reply: withheld, never echoed, not charged", async () => {
    h.ctx.anonymo.floor = gate("block");
    const before = await balance();
    const res = await chat("LONG MARK");
    expect(res.status).toBe(451);
    const raw = await res.text();
    const j = JSON.parse(raw) as { error: { type: string; message: string; metadata?: Record<string, unknown> } };
    expect(j.error.type).toBe("floor_blocked");
    expect(j.error.metadata).toEqual({ category: "cbrn", stage: "reply" });
    expect(raw).not.toContain("lorem");
    expect(raw).not.toContain("PLACEHOLDER");
    expect(await balance()).toBe(before);
  });

  test("a guard that cannot read the reply fails closed with 503: withheld, not charged", async () => {
    h.ctx.anonymo.floor = gate("broken");
    const before = await balance();
    const res = await chat("hello again");
    expect(res.status).toBe(503);
    const j = (await res.json()) as { error: { type: string; metadata?: Record<string, unknown> } };
    expect(j.error.type).toBe("floor_unavailable");
    expect(j.error.metadata).toEqual({ stage: "reply" });
    expect(await balance()).toBe(before);
  });

  test("without a guard model (local development) replies are not checked", async () => {
    h.ctx.anonymo.floor = { checksReplies: false, check: async (input) => (input.stage === "reply" ? { ok: false, category: "cbrn" } : { ok: true }) };
    expect((await chat("LONG MARK")).status).toBe(200);
  });
});

describe("floor reply check, streaming", () => {
  test("only text the guard has already passed is ever delivered, and the whole reply arrives with its receipt", async () => {
    seen.length = 0;
    h.ctx.anonymo.floor = gate("allow");
    const before = await balance();
    const res = await chat("LONG", { stream: true });
    expect(res.status).toBe(200);
    let unchecked = 0;
    const { text, events } = await readStream(res, (soFar) => {
      if (!replyChecks().some((i) => i.text.includes(soFar))) unchecked++;
    });
    expect(unchecked).toBe(0);
    expect(text).toBe(reply("LONG"));
    expect(replyChecks().length).toBeGreaterThanOrEqual(2); // the first window, then the rest at the end
    expect(events.at(-1).receipt).toBeDefined();
    expect(await balance()).toBeLessThan(before);
  });

  test("a reply that crosses the line mid-stream stops: nothing past the last passed piece, a 451 event, not charged", async () => {
    h.ctx.anonymo.floor = gate("block");
    const before = await balance();
    const res = await chat("LONG MARK", { stream: true });
    expect(res.status).toBe(200); // headers went out before the reply existed
    const { text, events } = await readStream(res);
    expect(text.length).toBeGreaterThan(0); // the first window passed and was delivered
    expect(text).not.toContain("PLACEHOLDER");
    expect(LONG.startsWith(text)).toBe(true);
    const err = events.at(-1).error;
    expect(err).toMatchObject({ code: 451, type: "floor_blocked", metadata: { category: "cbrn", stage: "reply" } });
    expect(events.some((e) => e.receipt)).toBe(false);
    expect(await balance()).toBe(before);
  });

  test("a guard that fails mid-stream stops it with a 503 event, delivering nothing unchecked, not charged", async () => {
    h.ctx.anonymo.floor = gate("broken");
    const before = await balance();
    const res = await chat("LONG", { stream: true });
    const { text, events } = await readStream(res);
    expect(text).toBe("");
    expect(events.at(-1).error).toMatchObject({ code: 503, type: "floor_unavailable", metadata: { stage: "reply" } });
    expect(await balance()).toBe(before);
  });
});
