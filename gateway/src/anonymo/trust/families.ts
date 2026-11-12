// Model family of a route: what the council needs three different ones of, and what the manifest lists.
//
// WS04 adds `family`, `quant` and `weightsHash` to the route record. Until that lands (and for any route it leaves
// blank) the family is derived from the model id and name. Reading is defensive on purpose: the field is taken from
// the offer first, then the model, and only a non-empty string counts.

type Named = { id: string; name?: string | null; hfRepo?: string | null };

/** Known families, matched in order against the lower-cased model id, name and Hugging Face repository. */
const FAMILY_PATTERNS: [string, RegExp][] = [
  ["deepseek", /deepseek/],
  ["glm", /\bglm|chatglm|zhipu|z-ai\b|\bzai\b/],
  ["qwen", /qwen|qwq/],
  ["gemma", /gemma/],
  ["kimi", /kimi|moonshot/],
  // Venice's uncensored model is Dolphin Mistral 24B; Dolphin builds on Mistral bases.
  ["mistral", /mistral|mixtral|ministral|magistral|devstral|codestral|dolphin|venice-uncensored/],
  ["llama", /llama|hermes/],
  ["phi", /\bphi-?\d/],
  ["gpt-oss", /gpt-oss/],
  ["command", /command-r|cohere/],
  ["minimax", /minimax/],
  ["grok", /grok/],
  ["wan", /\bwan-?\d|\bwan2/],
  ["kokoro", /kokoro/],
  ["flux", /flux/],
];

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null);

/** The family a model id or name implies, or the author part of the id when no known family matches. */
export function deriveFamily(m: Named): string {
  const hay = [m.id, m.name ?? "", m.hfRepo ?? ""].join(" ").toLowerCase();
  for (const [family, re] of FAMILY_PATTERNS) if (re.test(hay)) return family;
  const slash = m.id.indexOf("/");
  return (slash > 0 ? m.id.slice(0, slash) : m.id).toLowerCase();
}

/** The family of a route: the route record's own field when it has one (WS04), else derived from the model. */
export function familyOf(model: Named & { family?: unknown }, offer?: { family?: unknown } | null): string {
  return str(offer?.family) ?? str(model.family) ?? deriveFamily(model);
}

/** sha256 of the served weights, from the route record when it has one (WS04), else null. Never invented. */
export function weightsHashOf(offer: Record<string, unknown> | null | undefined, model?: Record<string, unknown> | null): string | null {
  const pick = (o: Record<string, unknown> | null | undefined) => (o ? str(o.weightsHash) ?? str(o.weights_hash) : null);
  return pick(offer) ?? pick(model ?? null);
}
