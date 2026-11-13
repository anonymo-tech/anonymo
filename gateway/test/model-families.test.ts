import { describe, expect, test } from "bun:test";
import { familyFromName, familyOf as routeFamily, MODEL_FAMILIES } from "../src/anonymo/models.ts";
import { familyFromName as refusalFamilyFromName, familyOf as refusalFamily } from "../src/anonymo/refusal/family.ts";
import { deriveFamily, familyOf as trustFamily } from "../src/anonymo/trust/families.ts";

// WS01: one family table (anonymo/models.ts). The refusal reroute (WS03) and the council and manifest (WS09) read it
// through familyFromName, and each keeps the fallback it had for a model no known family matches.

const KNOWN: [string, string][] = [
  ["deepseek/deepseek-chat", "deepseek"], ["deepseek-r1", "deepseek"],
  ["z-ai/glm-4.6", "glm"], ["thudm/chatglm3", "glm"], ["zai-org/GLM-4.5", "glm"],
  ["qwen/qwen3-235b", "qwen"], ["qwq-32b", "qwen"],
  ["google/gemma-3-27b", "gemma"], ["google/gemini-2.5-pro", "gemini"],
  ["moonshotai/kimi-k2", "kimi"],
  ["mistralai/mistral-large", "mistral"], ["mixtral-8x7b", "mistral"], ["magistral-medium", "mistral"], ["codestral", "mistral"],
  ["venice-uncensored", "mistral"], ["dolphin-mistral-24b", "mistral"], ["dolphin-venice", "mistral"],
  ["meta-llama/llama-3.3-70b", "llama"], ["nousresearch/hermes-4-405b", "llama"], ["cognitivecomputations/dolphin-2.9-llama3-8b", "llama"],
  ["microsoft/phi-4", "phi"], ["cohere/command-r-plus", "command"],
  ["openai/gpt-oss-120b", "gpt-oss"], ["openai/gpt-4o", "gpt"], ["anthropic/claude-sonnet", "claude"], ["x-ai/grok-4", "grok"],
  ["minimax/minimax-m1", "minimax"], ["wan-2.1", "wan"], ["Wan2.2-T2V", "wan"], ["hexgrad/kokoro-82m", "kokoro"], ["black-forest-labs/flux-1", "flux"],
];

describe("model families", () => {
  test("the refusal helper re-exports the one table rather than keeping its own", () => {
    expect(refusalFamilyFromName).toBe(familyFromName);
    expect(new Set(MODEL_FAMILIES.map(([f]) => f)).size).toBeGreaterThan(20);
  });

  test("all three helpers agree on every known family", () => {
    for (const [name, family] of KNOWN) {
      expect(familyFromName(name), name).toBe(family);
      expect(routeFamily({ family: null, providerModelId: name }), name).toBe(family);
      expect(refusalFamily({ id: name, name: "", author: "" } as never), name).toBe(family);
      expect(trustFamily({ id: name, name: null }), name).toBe(family);
    }
  });

  test("an explicit family wins everywhere, lower-cased", () => {
    expect(routeFamily({ family: "Qwen", providerModelId: "deepseek-r1" })).toBe("qwen");
    expect(refusalFamily({ id: "deepseek-r1", name: "", author: "" } as never, { family: "Qwen" } as never)).toBe("qwen");
    expect(trustFamily({ id: "deepseek-r1" }, { family: "Qwen" })).toBe("qwen");
  });

  test("each helper keeps its own fallback for an unknown model", () => {
    expect(familyFromName("acme/unknown-model")).toBeNull();
    // Routing: each unknown model is its own family.
    expect(routeFamily({ family: null, providerModelId: "Acme/Unknown-Model" })).toBe("model:acme/unknown-model");
    // Refusal reroute: unknown models of one author share a family.
    expect(refusalFamily({ id: "acme/unknown-model", name: "", author: "Acme" } as never)).toBe("author:acme");
    // Council and manifest: the author part of the id.
    expect(deriveFamily({ id: "Acme/unknown-model" })).toBe("acme");
    expect(deriveFamily({ id: "solo" })).toBe("solo");
  });

  test("the refusal helper reads the declared base model before the id; the trust helper reads the repository too", () => {
    expect(refusalFamily({ id: "acme/x", name: "", author: "acme" } as never, null, "Qwen/Qwen3-8B")).toBe("qwen");
    expect(deriveFamily({ id: "acme/x", hfRepo: "meta-llama/Llama-3.1-8B" })).toBe("llama");
  });
});
