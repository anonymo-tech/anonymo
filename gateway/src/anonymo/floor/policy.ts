// The floor policy: the four lines Anonymo blocks for everyone, written for a guard model (Overview §6, Backend §10).
// Everything outside these four categories is allowed. The policy is deliberately adult-permissive: a guard that flags
// explicit-but-legal adult content is a bug, and the adult-legal suite in gateway/data/floor-suite/ fails on it.

import type { FloorCategory } from "../seams.ts";

export type PolicyCategory = { code: string; category: FloorCategory; name: string; shouldNot: string[]; can: string[] };

export const FLOOR_POLICY: readonly PolicyCategory[] = [
  {
    code: "S1",
    category: "minor",
    name: "Sexual content involving minors",
    shouldNot: [
      "Sexual or sexualised content of any kind involving a person under 18, or a character described, drawn or implied to be under 18, including fully fictional or synthetic content.",
      "Requests to sexualise a child's body, clothing or behaviour, or to treat a child as a sexual partner.",
    ],
    can: [
      "Sexual content between adults, including adult roleplay in which every participant is clearly an adult.",
      "Sex education, puberty and health questions, parenting questions, abuse prevention, recognising grooming, reporting, survivor support and the law.",
    ],
  },
  {
    code: "S2",
    category: "real_person",
    name: "Sexual content about real, identifiable people",
    shouldNot: [
      "Sexual or nude text or imagery about a real, identifiable person, whether a public figure or a private individual.",
      "Requests to 'undress', nudify or sexually edit a photo of a real person.",
    ],
    can: [
      "Sexual content about fictional adults.",
      "Non-sexual discussion, news, criticism, commentary and satire about real people.",
      "Questions about the law on deepfakes and intimate-image abuse, and how to get such content taken down.",
    ],
  },
  {
    code: "S3",
    category: "voice_clone",
    name: "Cloning a real person's voice",
    shouldNot: [
      "Requests to clone, imitate or synthesise the voice of a real, identifiable person, including the requester's own voice.",
      "Producing audio, or a script for synthesis, meant to pass as a real person speaking.",
    ],
    can: [
      "Stock and fictional voices.",
      "General discussion of how speech synthesis works, and how to detect or defend against voice fraud.",
    ],
  },
  {
    code: "S4",
    category: "cbrn",
    name: "Chemical, biological, radiological, nuclear and explosive weapons",
    shouldNot: [
      "Meaningful, actionable help to make, acquire, enhance, weaponise, deliver or detonate chemical, biological, radiological or nuclear weapons, or explosive devices.",
      "Synthesis routes, precursor acquisition, quantities, cultivation or enhancement of pathogens, and device assembly.",
    ],
    can: [
      "History, policy, arms control, news and fiction without actionable technical detail.",
      "Medical treatment, safety, detection, decontamination, emergency response and harm reduction.",
    ],
  },
] as const;

export const POLICY_PREAMBLE =
  "Everything outside these categories is ALLOWED. That includes explicit sexual content between adults, graphic violence and dark themes in fiction, drug use and harm reduction, profanity, offensive opinions, and security research. Never flag content only because it is explicit, dark, offensive or illegal in some places.";

const byCode = new Map(FLOOR_POLICY.map((p) => [p.code, p.category]));

const categoryBlock = () =>
  FLOOR_POLICY.map((p) => [`${p.code}: ${p.name}.`, "Should not", ...p.shouldNot.map((s) => `- ${s}`), "Can", ...p.can.map((s) => `- ${s}`)].join("\n")).join("\n");

/** A Llama Guard 3 prompt with our four categories instead of the default taxonomy. Sent raw to /v1/completions. */
export function llamaGuardPrompt(text: string): string {
  return [
    "<|begin_of_text|><|start_header_id|>user<|end_header_id|>",
    "",
    "Task: Check if there is unsafe content in 'User' messages in conversations according to our safety policy with the below categories.",
    "",
    "<BEGIN UNSAFE CONTENT CATEGORIES>",
    categoryBlock(),
    "<END UNSAFE CONTENT CATEGORIES>",
    "",
    POLICY_PREAMBLE,
    "",
    "<BEGIN CONVERSATION>",
    "",
    `User: ${text}`,
    "",
    "<END CONVERSATION>",
    "",
    "Provide your safety assessment for ONLY THE LAST User message in the above conversation:",
    " - First line must read 'safe' or 'unsafe'.",
    " - If unsafe, a second line must include a comma-separated list of violated categories.<|eot_id|><|start_header_id|>assistant<|end_header_id|>",
    "",
    "",
  ].join("\n");
}

/** The same policy as a system message, for guard endpoints that apply their own chat template. */
export function llamaGuardChatMessages(text: string) {
  const system = [
    "You are a content-safety classifier. Classify ONLY the user message against these categories.",
    "",
    categoryBlock(),
    "",
    POLICY_PREAMBLE,
    "",
    "Answer with 'safe', or with 'unsafe' and on a second line a comma-separated list of the violated category codes. Output nothing else.",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: text },
  ];
}

/** gpt-oss-safeguard (bring-your-own-policy reasoning classifier) takes the policy as the system message, laid out as
 *  its user guide recommends: instructions, definitions, what violates, what is safe, boundary examples, with the
 *  output format stated at the top and again at the end. About 950 tokens for four categories (about 240 each; the
 *  guide's sweet spot is 400-600 per policy). "Reasoning: low" keeps the hidden reasoning short. */
export function safeguardMessages(text: string) {
  const system = [
    "# Anonymo floor policy",
    "",
    "Reasoning: low",
    "",
    "## INSTRUCTIONS",
    "Classify the content in the user message against the four categories S1-S4 below. Everything outside them is allowed.",
    'Return only a JSON object and nothing else: {"violation": 1, "policy_category": "S<n>"} if the content violates a category, or {"violation": 0, "policy_category": null} if it does not.',
    "If several categories apply, return the first in this order: S1, S2, S3, S4.",
    "",
    "## DEFINITIONS",
    "- Minor: a person or character under 18, or one described, drawn or implied to be under 18 (by age, school year, body or behaviour), even if the text also calls them an adult.",
    "- Real, identifiable person: a real individual, public or private, who is named or recognisable. Fictional characters are not real people.",
    "- Actionable: specific enough to help someone carry it out, such as steps, quantities, sources or routes.",
    "",
    "## VIOLATES (1)",
    ...FLOOR_POLICY.map((p) => `${p.code} ${p.name}: ${p.shouldNot.join(" ")}`),
    "",
    "## SAFE (0)",
    POLICY_PREAMBLE,
    ...FLOOR_POLICY.flatMap((p) => p.can.map((s) => `- ${s}`)),
    "",
    "## EXAMPLES",
    '- An explicit sex scene between two adult characters: {"violation": 0, "policy_category": null}',
    '- Sexual roleplay where one character is in middle school: {"violation": 1, "policy_category": "S1"}',
    '- An erotic story about a named, real actress: {"violation": 1, "policy_category": "S2"}',
    '- A request to make a voice model of a named singer: {"violation": 1, "policy_category": "S3"}',
    '- How voice-cloning scams work and how to spot them: {"violation": 0, "policy_category": null}',
    '- Step-by-step synthesis of a nerve agent: {"violation": 1, "policy_category": "S4"}',
    "",
    'Answer with only the JSON object: {"violation": 0 or 1, "policy_category": "S1", "S2", "S3", "S4" or null}.',
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: text },
  ];
}

/** ShieldGemma asks one yes/no question per policy, so one prompt per category. */
export function shieldGemmaPrompt(text: string, p: PolicyCategory): string {
  const principle = `"No ${p.name}": ${p.shouldNot.join(" ")} Allowed: ${p.can.join(" ")} ${POLICY_PREAMBLE}`;
  return [
    "You are a policy expert trying to help determine whether a user prompt is in violation of the defined safety policies.",
    "",
    "<start_of_turn>",
    `Human Question: ${text}`,
    "<end_of_turn>",
    "",
    "Our safety principle is defined in the below:",
    "",
    `* ${principle}`,
    "",
    "Does the human question violate the above principle? Your answer must start with 'Yes' or 'No'. And then walk through step by step to be sure we answer correctly.",
    "",
  ].join("\n");
}

export class FloorParseError extends Error {
  constructor(what: string) {
    super(`floor guard returned an unparseable verdict (${what})`); // never includes the model output: it may echo the prompt
  }
}

const LLAMA_GUARD = /^(safe|unsafe)(?:\n\s*(S\d+(?:\s*,\s*S\d+)*))?$/;

/** Strict Llama Guard verdict parse. Anything that is not exactly `safe` or `unsafe\nS<n>[,S<n>]` with known codes throws,
 *  and the gate turns a throw into a closed failure. Returns the first violated category in policy order. */
export function parseLlamaGuard(output: unknown): FloorCategory | null {
  if (typeof output !== "string") throw new FloorParseError("not a string");
  const m = LLAMA_GUARD.exec(output.trim());
  if (!m) throw new FloorParseError("shape");
  if (m[1] === "safe") {
    if (m[2]) throw new FloorParseError("safe with categories");
    return null;
  }
  if (!m[2]) throw new FloorParseError("unsafe without category");
  const codes = m[2].split(",").map((c) => c.trim());
  const cats = codes.map((c) => byCode.get(c));
  if (cats.some((c) => !c)) throw new FloorParseError("unknown category");
  for (const p of FLOOR_POLICY) if (cats.includes(p.category)) return p.category;
  throw new FloorParseError("unreachable");
}

/** Strict gpt-oss-safeguard verdict parse: one JSON object (a ```json fence around it is tolerated) whose violation is
 *  the number 0 with a null category, or the number 1 with a known code. Anything else throws (fails closed). Extra
 *  fields, such as a rationale, are ignored. */
export function parseSafeguard(output: unknown): FloorCategory | null {
  if (typeof output !== "string") throw new FloorParseError("not a string");
  const s = output.trim();
  const body = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(s)?.[1] ?? s;
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    throw new FloorParseError("not JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new FloorParseError("shape");
  const { violation, policy_category: code } = v as { violation?: unknown; policy_category?: unknown };
  if (violation === 0) {
    if (code != null) throw new FloorParseError("safe with category");
    return null;
  }
  if (violation !== 1) throw new FloorParseError("shape");
  if (typeof code !== "string") throw new FloorParseError("unsafe without category");
  const cat = byCode.get(code.trim());
  if (!cat) throw new FloorParseError("unknown category");
  return cat;
}

/** Strict ShieldGemma answer parse: the answer must start with the word Yes or No. */
export function parseShieldGemma(output: unknown): boolean {
  if (typeof output !== "string") throw new FloorParseError("not a string");
  const m = /^(yes|no)\b/i.exec(output.trim());
  if (!m) throw new FloorParseError("shape");
  return m[1].toLowerCase() === "yes";
}
