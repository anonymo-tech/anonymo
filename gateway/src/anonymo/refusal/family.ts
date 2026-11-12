// WS03 · which model family a route belongs to, so a refused attempt is retried on a different family (Backend §5).
//
// WS04 is adding a `family` field to the route record. Until that lands this reads it when present (on the offer,
// the provider, the model row or the model's `arch`) and otherwise derives the family from the base model the
// operator declared or from the model slug. Fine-tunes and abliterated variants count as their base family, since
// they tend to share their base's refusals.

import type { Candidate, ModelRow } from "../../catalog/catalog.ts";

/** Ordered: the first match wins, so more specific names come before the families they contain. */
const FAMILIES: [string, RegExp][] = [
  ["deepseek", /deepseek/],
  ["qwen", /qwen|qwq|\bqvq\b/],
  ["gemma", /gemma/],
  ["gemini", /gemini/],
  ["mistral", /mistral|mixtral|magistral|ministral|codestral|devstral|pixtral|\bvenice-uncensored\b|dolphin-?venice|dolphin.*(?:24b|mistral)/],
  ["llama", /llama|hermes|nemotron|\btulu\b|dolphin.*(?:llama|8b|70b)/],
  ["glm", /\bglm|chatglm|zhipu|z-ai/],
  ["kimi", /kimi|moonshot/],
  ["minimax", /minimax/],
  ["phi", /\bphi-?\d/],
  ["command", /command-?[ra]|cohere|aya/],
  ["gpt-oss", /gpt-oss/],
  ["gpt", /\bgpt-|openai\/|\bo[134](?:-|$)/],
  ["claude", /claude|anthropic/],
  ["grok", /grok|x-ai\//],
  ["yi", /\byi-|01-ai/],
  ["falcon", /falcon/],
  ["granite", /granite/],
  ["olmo", /olmo/],
  ["ernie", /ernie|baidu/],
  ["hunyuan", /hunyuan|tencent/],
  ["seed", /seed-oss|bytedance/],
];

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null);

/** The family named by a free-form model name or repository, or null when none of the known families matches. */
export function familyFromName(name: string): string | null {
  const n = name.toLowerCase();
  for (const [family, re] of FAMILIES) if (re.test(n)) return family;
  return null;
}

/**
 * The family of a route. Read in order: an explicit `family` on the offer, provider, model row or `arch` (WS04),
 * then the declared base model (models_lane.base_model), then the model id. Unknown models count as a family of
 * their own author, so two unknown models of the same author are never treated as different families.
 */
export function familyOf(model: ModelRow, candidate?: Candidate | null, baseModel?: string | null): string {
  const explicit =
    str((candidate as { family?: unknown } | null | undefined)?.family) ??
    str((model as { family?: unknown }).family) ??
    str((model.arch as { family?: unknown } | null)?.family);
  if (explicit) return explicit;
  return (baseModel ? familyFromName(baseModel) : null) ?? familyFromName(model.id) ?? familyFromName(model.name ?? "") ?? `author:${(model.author || model.id.split("/")[0] || model.id).toLowerCase()}`;
}
