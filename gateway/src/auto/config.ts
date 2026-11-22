import { z } from "zod";
import { AUTO_CLASSES, type AutoClass } from "./classify.ts";

// Auto Model settings. The candidate lists are model ids, in the operator's order of preference. Only the ones that are
// live in the catalogue at request time are eligible; the order here only breaks ties (see auto/rank.ts).
//
// Defaults are the reviewed PPQ Regular Chat models (providers/ppq-chat.ts), each list spread over different model
// families so the refusal catch always has another family to retry on. Abliterated and e2ee-named offerings are left
// out (they serve on separate terms), and so are the pooled Anonymo ids: Auto answers with a named model.

export const DEFAULT_AUTO_CANDIDATES: Readonly<Record<AutoClass, readonly string[]>> = Object.freeze({
  // DeepSeek and GLM lead on code and tool calls; Gemma and Venice Uncensored are the other-family fallbacks.
  code: ["venice/deepseek-v4-1-flash-uncensored", "venice/glm-5-3-flash-uncensored", "venice/gemma-4-uncensored", "venice/venice-uncensored-1-2"],
  // The roleplay-tuned Venice model and the Dolphin Mistral it grew from, then GLM Heretic and Gemma.
  roleplay: ["venice/venice-uncensored-role-play", "cognitivecomputations/dolphin-mistral-24b-venice-edition", "venice/olafangensan-glm-4.7-flash-heretic", "venice/gemma-4-uncensored"],
  // The reasoning-capable DeepSeek builds first, then GLM 5.3 and Gemma.
  reasoning: ["venice/deepseek-v4-1-flash-uncensored", "venice/deepseek-v4-1-flash-1017-uncensored", "venice/glm-5-3-flash-uncensored", "venice/gemma-4-uncensored"],
  // Gemma 4 reads images. A model only counts here while its catalogue entry lists image input.
  vision: ["venice/gemma-4-uncensored"],
  general: ["venice/venice-uncensored-1-2", "venice/glm-5-3-flash-uncensored", "venice/deepseek-v4-1-flash-uncensored", "venice/gemma-4-uncensored"],
});

const modelId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((s) => !s.startsWith("anonymo-auto") && !s.startsWith("anonymo-council") && !s.startsWith("@"), "a candidate must be a model id, not anonymo-auto, anonymo-council or an @ route");
const list = z.array(modelId).min(1).max(8).refine((xs) => new Set(xs).size === xs.length, "model ids must not repeat");
/** ANONYMO_AUTO_MODELS: a JSON object of class -> model ids. A class it leaves out keeps the default list. */
export const autoCandidatesSchema = z.strictObject(Object.fromEntries(AUTO_CLASSES.map((c) => [c, list.optional()])) as Record<AutoClass, z.ZodOptional<typeof list>>);

const flag = z.union([z.boolean(), z.string()]).transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

export const autoEnv = {
  ANONYMO_FEATURE_AUTO: flag.default(true), // model "anonymo-auto"; off: the id is unknown and not listed
  ANONYMO_AUTO_MODELS: z.string().optional(), // JSON, see autoCandidatesSchema
  ANONYMO_AUTO_MIN_SAMPLES: z.coerce.number().int().min(1).default(20), // checked replies before a model's refusal rate counts
  ANONYMO_AUTO_STATS_TTL_MS: z.coerce.number().int().min(0).default(60_000), // how long the 30-day refusal counts are reused
};

export type AutoSettings = {
  enabled: boolean;
  candidates: Readonly<Record<AutoClass, readonly string[]>>;
  minSamples: number;
  statsTtlMs: number;
};

/** Parse the candidate lists. Throws with the problem (never the raw value) so a bad setting stops the router. */
export function parseAutoCandidates(raw: string | undefined): Readonly<Record<AutoClass, readonly string[]>> {
  if (!raw?.trim()) return DEFAULT_AUTO_CANDIDATES;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("ANONYMO_AUTO_MODELS is not valid JSON.");
  }
  const r = autoCandidatesSchema.safeParse(json);
  if (!r.success) throw new Error("ANONYMO_AUTO_MODELS: " + r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
  return Object.freeze(Object.fromEntries(AUTO_CLASSES.map((c) => [c, Object.freeze([...(r.data[c] ?? DEFAULT_AUTO_CANDIDATES[c])])])) as Record<AutoClass, readonly string[]>);
}

export function autoSettings(e: z.infer<z.ZodObject<typeof autoEnv>>): AutoSettings {
  return { enabled: e.ANONYMO_FEATURE_AUTO, candidates: parseAutoCandidates(e.ANONYMO_AUTO_MODELS), minSamples: e.ANONYMO_AUTO_MIN_SAMPLES, statsTtlMs: e.ANONYMO_AUTO_STATS_TTL_MS };
}
