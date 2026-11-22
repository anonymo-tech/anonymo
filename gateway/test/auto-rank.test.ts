// Auto Model ranking (src/auto/rank.ts) and candidate config (src/auto/config.ts): pure, so checked without a router.
import { describe, expect, test } from "bun:test";
import { rankCandidates, refusalBucket, type RankInput } from "../src/auto/rank.ts";
import { AUTO_CLASSES } from "../src/auto/classify.ts";
import { DEFAULT_AUTO_CANDIDATES, parseAutoCandidates } from "../src/auto/config.ts";
import { PPQ_CHAT_MODELS } from "../src/providers/ppq-chat.ts";
import { familyFromName } from "../src/anonymo/models.ts";
import { loadConfig } from "../src/config.ts";

const c = (id: string, configIndex: number, price: bigint, refusals: RankInput["refusals"] = null): RankInput => ({ id, configIndex, price, refusals });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("rankCandidates", () => {
  test("lower refusal rate first, whatever the price", () => {
    const r = rankCandidates([c("cheap", 0, 1n, { total: 100, refused: 30 }), c("dear", 1, 9n, { total: 100, refused: 2 })], { minSamples: 20 });
    expect(ids(r)).toEqual(["dear", "cheap"]);
    expect(r[0].refusalRate).toBe(0.02);
  });

  test("the same rate (to the percentage point): cheaper first", () => {
    const r = rankCandidates([c("a", 0, 9n, { total: 1000, refused: 31 }), c("b", 1, 3n, { total: 1000, refused: 34 })], { minSamples: 20 });
    expect(ids(r)).toEqual(["b", "a"]);
  });

  test("too few readings: no rate yet, ranked after every measured model, then by price", () => {
    const r = rankCandidates([c("new-cheap", 0, 1n, { total: 3, refused: 0 }), c("none", 1, 2n), c("measured", 2, 50n, { total: 40, refused: 20 })], { minSamples: 20 });
    expect(ids(r)).toEqual(["measured", "new-cheap", "none"]);
    expect(r[1].refusalRate).toBeNull();
    expect(refusalBucket({ total: 3, refused: 0 }, 20)).toBeNull();
  });

  test("ties fall back to the configured order, then the id", () => {
    expect(ids(rankCandidates([c("z", 1, 5n), c("y", 0, 5n)], { minSamples: 1 }))).toEqual(["y", "z"]);
    expect(ids(rankCandidates([c("z", 0, 5n), c("y", 0, 5n)], { minSamples: 1 }))).toEqual(["y", "z"]);
  });

  test("deterministic: any input order gives the same ranking", () => {
    let seed = 0xa070;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let run = 0; run < 200; run++) {
      const xs = Array.from({ length: 6 }, (_, i) => c(`m${i}`, i, BigInt(Math.floor(rand() * 4)), rand() < 0.3 ? null : { total: Math.floor(rand() * 60), refused: Math.floor(rand() * 10) }));
      const want = ids(rankCandidates(xs, { minSamples: 20 }));
      const shuffled = [...xs].sort(() => rand() - 0.5);
      expect(ids(rankCandidates(shuffled, { minSamples: 20 }))).toEqual(want);
    }
  });
});

describe("candidate config", () => {
  test("defaults: every class has a list; every id is a reviewed PPQ Regular Chat model; no abliterated or e2ee ids", () => {
    const reviewed = new Set(PPQ_CHAT_MODELS.map((m) => m.id));
    for (const cls of AUTO_CLASSES) {
      expect(DEFAULT_AUTO_CANDIDATES[cls].length).toBeGreaterThan(0);
      for (const id of DEFAULT_AUTO_CANDIDATES[cls]) {
        expect(reviewed.has(id)).toBe(true);
        expect(id).not.toMatch(/abliterat|e2ee/);
      }
    }
  });

  test("defaults with more than one model span more than one family (the refusal catch needs another family)", () => {
    for (const cls of AUTO_CLASSES) {
      const list = DEFAULT_AUTO_CANDIDATES[cls];
      if (list.length > 1) expect(new Set(list.map((id) => familyFromName(id) ?? id)).size).toBeGreaterThan(1);
    }
  });

  test("ANONYMO_AUTO_MODELS overrides only the classes it names", () => {
    const parsed = parseAutoCandidates(JSON.stringify({ code: ["a/one", "b/two"] }));
    expect(parsed.code).toEqual(["a/one", "b/two"]);
    expect(parsed.general).toEqual(DEFAULT_AUTO_CANDIDATES.general);
    expect(parseAutoCandidates(undefined)).toBe(DEFAULT_AUTO_CANDIDATES);
  });

  test("bad settings stop the router, with the reason and without the value", () => {
    expect(() => parseAutoCandidates("{nope")).toThrow("not valid JSON");
    expect(() => parseAutoCandidates(JSON.stringify({ code: [] }))).toThrow("code");
    expect(() => parseAutoCandidates(JSON.stringify({ code: ["x", "x"] }))).toThrow("must not repeat");
    expect(() => parseAutoCandidates(JSON.stringify({ code: ["anonymo-auto"] }))).toThrow();
    expect(() => parseAutoCandidates(JSON.stringify({ code: ["anonymo-council"] }))).toThrow();
    expect(() => parseAutoCandidates(JSON.stringify({ chess: ["x"] }))).toThrow();
    expect(() => loadConfig({ ANONYMO_AUTO_MODELS: "[1]" })).toThrow("ANONYMO_AUTO_MODELS");
  });

  test("loadConfig: on by default, with the default lists", () => {
    const cfg = loadConfig({ ANONYMO_AUTO_MODELS: "" });
    expect(cfg.auto.enabled).toBe(true);
    expect(cfg.auto.candidates).toBe(DEFAULT_AUTO_CANDIDATES);
    expect(loadConfig({ ANONYMO_FEATURE_AUTO: "false" }).auto.enabled).toBe(false);
  });
});
