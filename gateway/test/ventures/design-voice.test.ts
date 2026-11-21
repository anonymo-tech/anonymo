import { describe, expect, test } from "bun:test";
import { CrewCallError, scriptedLlm } from "../../src/anonymo/ventures/llm.ts";
import { designVenture } from "../../src/anonymo/ventures/design/index.ts";
import { generateDesignSystem } from "../../src/anonymo/ventures/design/tokens.ts";
import { fallbackNames, nameConflict, nameIsSafe, parseVoiceReply, proposeVoice, soundKey } from "../../src/anonymo/ventures/design/voice.ts";

// Designer Mo's naming and voice (Ventures Overview §2 "copy voice"): a model may propose names, tagline and tone, but
// every name must be clear of the avoid list by spelling and by sound, and a missing model or bad reply falls back.

const BRIEF = "Invoicing for freelancers that pays out in stablecoins. Clients pay by link.";

describe("nameIsSafe", () => {
  test("rejects names that are spelled or sound like the rival", () => {
    expect(nameIsSafe("Ledgerlee", ["Ledgerly"])).toBe(false);
    expect(nameIsSafe("Ledgrly", ["Ledgerly"])).toBe(false);
    expect(nameIsSafe("ledgerly", ["Ledgerly"])).toBe(false);
    expect(nameIsSafe("Ledgerly Pro", ["Ledgerly"])).toBe(false);
    expect(nameIsSafe("Fenix", ["Phoenix"])).toBe(false);
    expect(nameConflict("Kwikbooks", ["QuickBooks"])?.reason).toBe("sound");
    expect(soundKey("Ledgerly")).toBe(soundKey("Ledgerlee"));
  });

  test("accepts a distinct name", () => {
    expect(nameIsSafe("Brightfold", ["Ledgerly"])).toBe(true);
    expect(nameIsSafe("Tallybook", ["Ledgerly", "Phoenix"])).toBe(true);
    expect(nameIsSafe("Brightfold", [])).toBe(true);
  });

  test("fallback names are deterministic, distinct and safe", () => {
    const a = fallbackNames("seed-1", ["Arcstack"]);
    expect(a).toEqual(fallbackNames("seed-1", ["Arcstack"]));
    expect(a).toHaveLength(5);
    expect(new Set(a).size).toBe(5);
    for (const n of a) expect(nameIsSafe(n, ["Arcstack"])).toBe(true);
  });
});

describe("proposeVoice", () => {
  const reply = {
    names: ["Ledgerlee", "Brightfold", "<b>Bad</b>", "Coinwren"],
    tagline: "Get paid before the coffee cools.",
    tone: ["warm", "quick"],
    doSay: ["Name the amount"],
    dontSay: ["moon"],
  };

  test("parses a fenced JSON reply, drops unsafe names and never sends the avoid list to the model", async () => {
    const llm = scriptedLlm([{ when: (c) => c.json === true, reply: () => "Here you go:\n```json\n" + JSON.stringify(reply) + "\n```" }]);
    const v = await proposeVoice({ seed: "s", brief: BRIEF, mood: "calm", avoidNames: ["Ledgerly"], llm });
    expect(v.source).toBe("llm");
    expect(v.name).toBe("Brightfold");
    expect(v.names.slice(0, 2)).toEqual(["Brightfold", "Coinwren"]);
    expect(v.names).toHaveLength(5);
    expect(v.names.some((n) => !nameIsSafe(n, ["Ledgerly"]))).toBe(false);
    expect(v.tagline).toBe("Get paid before the coffee cools.");
    expect(v.voice.tone).toEqual(["warm", "quick"]);
    expect(v.voice.dontSay).toContain("moon");
    expect(v.voice.dontSay).toContain("copy or paraphrase another product's wording");
    expect(llm.calls).toHaveLength(1);
    expect(JSON.stringify(llm.calls[0].messages)).not.toContain("Ledgerly");
  });

  test("a tagline naming the rival is replaced", () => {
    const p = parseVoiceReply(JSON.stringify({ ...reply, tagline: "Better than Ledgerly" }), ["Ledgerly"]);
    expect(p?.tagline).toBeNull();
  });

  test("falls back on bad JSON, a refusal, no model, or a non-fatal error", async () => {
    const base = { seed: "s", brief: BRIEF, mood: "bold" as const, avoidNames: ["Ledgerly"] };
    const expected = await proposeVoice(base);
    expect(expected.source).toBe("fallback");
    expect(expected.tagline).toBe("Invoicing for freelancers that pays out in stablecoins.");
    expect(expected.names).toEqual(fallbackNames("s", ["Ledgerly"]));
    for (const llm of [
      scriptedLlm([{ when: () => true, reply: () => "sorry, no json here" }]),
      scriptedLlm([{ when: () => true, reply: () => "{ names: [broken" }]),
      scriptedLlm([{ when: () => true, reply: () => ({ text: JSON.stringify(reply), refused: true }) }]),
      { async call(): Promise<never> { throw new CrewCallError(502, "upstream_error", "boom"); } },
    ]) {
      expect(await proposeVoice({ ...base, llm })).toEqual(expected);
    }
  });

  test("a fatal crew error (floor block, cap) stops the step", async () => {
    const llm = { async call(): Promise<never> { throw new CrewCallError(451, "floor_blocked", "blocked"); } };
    await expect(proposeVoice({ seed: "s", brief: BRIEF, mood: "calm", avoidNames: [], llm })).rejects.toBeInstanceOf(CrewCallError);
  });
});

describe("designVenture", () => {
  test("returns a unique system, stylesheet, preview and a stable hash", async () => {
    const taken = generateDesignSystem("venture-42", "calm");
    const input = { seed: "venture-42", brief: "A calm budgeting journal for families", avoidNames: ["Ledgerly"], gallery: [taken] };
    const a = await designVenture(input);
    const b = await designVenture(input);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.sha256).toBe(b.sha256);
    expect(a.system.mood).toBe("calm");
    expect(a.uniqueness.attempts).toBeGreaterThanOrEqual(1);
    expect(a.uniqueness.unique).toBe(true);
    expect(a.css).toContain("prefers-color-scheme:dark");
    expect(a.preview.startsWith("<!doctype html>")).toBe(true);
    expect(a.brand.source).toBe("fallback");
    expect(nameIsSafe(a.brand.name, ["Ledgerly"])).toBe(true);
  });

  test("uses the model's voice in the system when one is given", async () => {
    const llm = scriptedLlm([{ when: () => true, reply: () => JSON.stringify({ names: ["Coinwren"], tagline: "Paid by link.", tone: ["crisp"], doSay: ["Be brief"], dontSay: [] }) }]);
    const r = await designVenture({ seed: "v", brief: BRIEF, mood: "technical", avoidNames: [], gallery: [], llm });
    expect(r.brand).toMatchObject({ name: "Coinwren", tagline: "Paid by link.", source: "llm" });
    expect(r.system.voice.tone).toEqual(["crisp"]);
    expect(r.preview).toContain("crisp");
  });
});
