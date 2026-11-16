// WS04 · The four Anonymo model IDs and the route record helpers other workstreams import (Overview §2, Backend §4).
//
// A route is one offer (model x provider) whose `tier` is set: the provider row is the route, the offer row carries
// `family`, `quant`, `weightsHash`, `tier`, `upstream` and `qualityRank`. Every Anonymo model ID is an ordinary catalogue
// model whose offers are its routes, so `ctx.catalog.resolve("anonymo-1")` and the existing selection, failover and
// receipts work unchanged. Routes are written from config/upstreams.yaml by src/providers/tiers.ts.
//
//   anonymo-1        best uncensored route: T0 (Venice) first while healthy, warm backups of the same families behind it
//   anonymo-rp       self-hosted 24-27B roleplay routes only
//   anonymo-council  the proposer pool WS09's council draws three families from (this file only registers the set)
//   anonymo-sealed   attested routes only; WS09 fails closed with 409 sealed_unavailable when none is fresh
//
// Direct model IDs (for example `glm-5.3-flash-uncensored`) exist only for routes on our own or non-Venice upstreams. Venice
// models are never relabelled one-for-one under our key: the config loader refuses a Venice direct ID, and refuses an
// Anonymo model ID that only Venice routes would serve.

import type { Candidate } from "../catalog/catalog.ts";
import { attestationFresh } from "../router/select.ts";

export const ANONYMO_1 = "anonymo-1";
export const ANONYMO_RP = "anonymo-rp";
export const ANONYMO_COUNCIL = "anonymo-council";
export const ANONYMO_SEALED = "anonymo-sealed";
export const ANONYMO_MODEL_IDS = [ANONYMO_1, ANONYMO_RP, ANONYMO_COUNCIL, ANONYMO_SEALED] as const;
export type AnonymoModelId = (typeof ANONYMO_MODEL_IDS)[number];

export const isAnonymoModelId = (id: unknown): id is AnonymoModelId => typeof id === "string" && (ANONYMO_MODEL_IDS as readonly string[]).includes(id);

/** Catalogue name and description of each model ID (GET /v1/models shows them). */
export const ANONYMO_MODEL_INFO: Readonly<Record<AnonymoModelId, { name: string; description: string }>> = Object.freeze({
  [ANONYMO_1]: { name: "Anonymo 1", description: "Best uncensored route for the request. Refusals reroute to another model family and are refunded." },
  [ANONYMO_RP]: { name: "Anonymo RP", description: "Long-context roleplay on self-hosted 24-27B uncensored models." },
  [ANONYMO_COUNCIL]: { name: "Anonymo Council", description: "Two or three model families answer and check each other; a strong model merges them." },
  [ANONYMO_SEALED]: { name: "Anonymo Sealed", description: "Runs only on hardware-attested GPU enclaves. Fails instead of downgrading when none is up." },
});

export const TIERS = [0, 1, 2, 3] as const;
export type Tier = (typeof TIERS)[number];
export const UPSTREAM_KINDS = ["venice", "selfhost", "phala", "chutes", "nanogpt", "featherless", "ppq"] as const;
export type UpstreamKind = (typeof UPSTREAM_KINDS)[number];

/** Which tiers each upstream kind may sit in (Backend §4 table). */
export const KIND_TIERS: Readonly<Record<UpstreamKind, readonly Tier[]>> = Object.freeze({
  venice: [0],
  selfhost: [1],
  phala: [2],
  chutes: [2],
  nanogpt: [2],
  featherless: [3],
  ppq: [2],
});

type RouteFields = Pick<Candidate, "modelId" | "providerId" | "providerModelId" | "family" | "tier" | "upstream">;

/** Whether an offer is an Anonymo route (written from config/upstreams.yaml) rather than a plain catalogue offer. */
export const isAnonymoRoute = (c: Pick<Candidate, "tier">) => c.tier != null;

/** `upstream:model`, the route id Backend §4 shows (for example "venice:venice-uncensored"). */
export const routeIdOf = (c: Pick<Candidate, "upstream" | "providerId" | "providerModelId">) => `${c.upstream ?? c.providerId}:${c.providerModelId}`;

/**
 * Every known model family and the name pattern that implies it, matched in order against a lower-cased model name or
 * repository: the first match wins, so more specific names come before the families they contain. This is the single
 * table for the router (WS01): the refusal reroute (anonymo/refusal/family.ts) and the council and manifest
 * (anonymo/trust/families.ts) read it through familyFromName. Fine-tunes count as their base family.
 */
export const MODEL_FAMILIES: readonly (readonly [string, RegExp])[] = [
  ["deepseek", /deepseek/],
  ["glm", /\bglm|chatglm|zhipu|z-ai\b|\bzai\b/],
  ["qwen", /qwen|qwq|\bqvq\b/],
  ["gemma", /gemma/],
  ["gemini", /gemini/],
  ["kimi", /kimi|moonshot/],
  // Venice's uncensored model is Dolphin Mistral 24B. Dolphin builds on Mistral bases unless the name says Llama.
  ["mistral", /mistral|mixtral|magistral|ministral|codestral|devstral|pixtral|\bvenice-uncensored\b|dolphin-?venice|dolphin.*(?:24b|mistral)/],
  ["llama", /llama|hermes|nemotron|\btulu\b|dolphin.*(?:llama|8b|70b)/],
  ["mistral", /dolphin/],
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
  ["wan", /\bwan[-_ ]?\d/],
  ["kokoro", /kokoro/],
  ["flux", /flux/],
];

/** The family a free-form model name or repository implies, or null when no known family matches. */
export function familyFromName(name: string): string | null {
  const n = name.toLowerCase();
  for (const [family, re] of MODEL_FAMILIES) if (re.test(n)) return family;
  return null;
}

/**
 * The model family of a route, for refusal rerouting (WS03: "retry on a route whose family differs") and the council
 * (WS09: "three proposers from three families"). The configured `family` wins. Without one the family is read from the
 * upstream model name; a name that matches no known family is its own family (`model:<name>`), so two different unknown
 * models never count as the same family and the same unknown model on two hosts always does.
 */
export function familyOf(c: Pick<RouteFields, "family" | "providerModelId"> & Partial<Pick<RouteFields, "modelId">>): string {
  if (c.family) return c.family.toLowerCase();
  const name = c.providerModelId || c.modelId || "";
  return familyFromName(name) ?? `model:${name.toLowerCase()}`;
}

export const sameFamily = (a: Parameters<typeof familyOf>[0], b: Parameters<typeof familyOf>[0]) => familyOf(a) === familyOf(b);

/** Candidates grouped by family, each group in the order given (the routing order). */
export function byFamily<T extends Parameters<typeof familyOf>[0]>(candidates: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const c of candidates) {
    const f = familyOf(c);
    out.set(f, [...(out.get(f) ?? []), c]);
  }
  return out;
}

/** The first candidate, in order, whose family differs from every family in `avoid` (WS03's refusal retry target). */
export function nextOtherFamily<T extends Parameters<typeof familyOf>[0]>(ordered: T[], avoid: Iterable<Parameters<typeof familyOf>[0] | string>): T | null {
  const skip = new Set([...avoid].map((a) => (typeof a === "string" ? a.toLowerCase() : familyOf(a))));
  return ordered.find((c) => !skip.has(familyOf(c))) ?? null;
}

/**
 * The routes `anonymo-sealed` may use right now: attested providers whose attestation is fresh (router/select.ts
 * attestationFresh, the same rule as the attested lane). WS09 fails closed when this is empty; nothing here downgrades.
 */
export function sealedRoutes<T extends Pick<Candidate, "provider">>(candidates: T[], opts: { maxAgeMs: number; production: boolean }): T[] {
  return candidates.filter((c) => attestationFresh(c, opts.maxAgeMs, opts.production));
}
