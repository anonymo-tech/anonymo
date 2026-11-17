// A reasoning route can spend a small max_tokens budget entirely on thinking and return an empty answer. Under a small
// budget, Anonymo routes marked `reasoning` move behind the others (they stay as the last fallback).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { outputBudgetOf, REASONING_MIN_OUTPUT, reasoningLast } from "../src/api/chat.ts";
import { staticModelsOf, upstreamsDocSchema } from "../src/providers/tiers.ts";
import { supportedParams } from "../src/services/registry.ts";

const route = (id: string, reasoning: boolean, tier: number | null = 2) => ({ id, tier, supportedParameters: reasoning ? ["max_tokens", "reasoning", "include_reasoning"] : ["max_tokens"] });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("reasoning routes under a small output budget", () => {
  const order = [route("deepseek", true), route("mistral", false), route("gemma", false)];

  test("a small budget moves reasoning routes last, keeping every route and the rest of the order", () => {
    expect(ids(reasoningLast(order, 40))).toEqual(["mistral", "gemma", "deepseek"]);
    expect(ids(reasoningLast(order, REASONING_MIN_OUTPUT - 1))).toEqual(["mistral", "gemma", "deepseek"]);
  });

  test("no budget, or a large one, leaves the order alone", () => {
    expect(ids(reasoningLast(order, null))).toEqual(["deepseek", "mistral", "gemma"]);
    expect(ids(reasoningLast(order, REASONING_MIN_OUTPUT))).toEqual(["deepseek", "mistral", "gemma"]);
  });

  test("plain catalogue offers (not Anonymo routes) are never reordered", () => {
    const plain = [route("a", true, null), route("b", false, null)];
    expect(ids(reasoningLast(plain, 40))).toEqual(["a", "b"]);
  });

  test("max_tokens or max_completion_tokens sets the budget", () => {
    expect(outputBudgetOf({ max_tokens: 40 })).toBe(40);
    expect(outputBudgetOf({ max_completion_tokens: 300 })).toBe(300);
    expect(outputBudgetOf({})).toBeNull();
  });

  test("the shipped config marks deepseek-flash as reasoning, and the mark reaches the route's parameters", () => {
    const doc = upstreamsDocSchema.parse(parse(readFileSync(new URL("../config/upstreams.yaml", import.meta.url), "utf8")));
    const flash = doc.routes.find((r) => r.id === "ppq-venice-deepseek-flash")!;
    expect(flash.features).toContain("reasoning");
    expect(supportedParams(staticModelsOf(flash)[0] as never)).toContain("reasoning");
    for (const r of doc.routes.filter((r) => r.id !== "ppq-venice-deepseek-flash")) expect(r.features).not.toContain("reasoning");
  });
});
