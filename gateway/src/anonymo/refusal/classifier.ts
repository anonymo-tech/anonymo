// WS03 · the default refusal classifier (spec: Backend §5).
//
// Two layers: phrase rules that read only the opening of a reply, and an optional small-model classifier on any
// OpenAI-compatible endpoint (ANONYMO_REFUSAL_URL). The model decides when it answers in time; when it is not
// configured, slow, down or says something unparsable, the phrase rules decide (fail open to the rules, never to
// "refused"). Nothing here stores or logs the prompt or the reply.

import type { RefusalClassifier } from "../seams.ts";

/** How much of the reply the rules read: refusals say so in their opening sentences. */
const OPENING_CHARS = 320;

/**
 * Openers that are a refusal wherever they start the reply. Written so ordinary answers that share words with them
 * ("I can't wait", "as an AI researcher", "I won't bore you") do not match.
 */
const DECLINE = String.raw`(?:can(?:'|’|no)?t|won(?:'|’)?t|will not|must not|am not going to|(?:'|’)m not going to|am unable to|(?:'|’)m unable to|am not able to|(?:'|’)m not able to|am not allowed to|(?:'|’)m not allowed to|do not feel comfortable|don(?:'|’)?t feel comfortable)`;
const ACTS = String.raw`(?:help(?!\s+(?:but|myself|thinking|feeling|wondering|noticing|it))|assist|provide (?:that|this|any|you with|information|instructions|content|guidance|details)|create (?:that|this|content|explicit|sexual|violent)|write (?:that|this|content|explicit|sexual|violent|a story|an? (?:essay|article|story|poem) (?:that|about|on|which))|generate|produce (?:that|this|content)|comply|fulfil|fulfill|engage (?:in|with)|participate in|do (?:that|this)|support (?:that|this)|continue (?:with )?(?:this|that) (?:conversation|request|roleplay|role-play|story|scenario)|role-?play (?:that|this)|answer (?:that|this))`;
const REFUSAL_RULES: RegExp[] = [
  new RegExp(String.raw`\bI(?:'m| am)? ?(?:so |very |really |truly )?sorry,? (?:but )?(?:I|we) (?:${DECLINE}|must decline|have to decline)\b`, "i"),
  // "I ?": the contracted forms ("I'm unable to", "I'm not able to") have no space after "I".
  new RegExp(String.raw`\bI ?${DECLINE} ${ACTS}`, "i"),
  /\bI (?:must|have to|need to|will have to|'ll have to) (?:respectfully |politely )?(?:decline|refuse)\b/i,
  /\bI(?:'m| am) (?:not permitted|not allowed) to (?:help|assist|provide|create|write|generate|comply|engage|do|continue|discuss)\b/i,
  /\bI(?:'d| would) (?:rather|prefer) not (?:help|assist|write|create|engage|continue|provide)\b/i,
  /\b(?:I apologi[sz]e|my apologies|unfortunately),? (?:but )?I (?:can(?:'|no)?t|cannot|won'?t|am unable|'m unable|am not able|'m not able)\b/i,
  /\bit (?:would|wouldn'?t) (?:not )?be (?:appropriate|ethical|responsible|right) for me to\b/i,
  /\bI(?:'m| am) not (?:able|going|willing) to (?:engage|help|assist|participate|provide|create|write) (?:with|in)\b/i,
  /\bI(?:(?:'m| am) not| do not feel| don(?:'|’)?t feel) comfortable (?:creating|writing|helping|providing|generating|producing|engaging|continuing|with (?:this|that))\b/i,
];

/** Rules that still hold inside a roleplay reply: an in-character "I can't do this" is a line of dialogue, these are not. */
const POLICY_RULES: RegExp[] = [
  /\bas an AI(?: language model| assistant| model)?,? I (?:can(?:'|no)?t|cannot|don'?t|do not|am not able|'m not able|won'?t|must)\b/i,
  /\b(?:this|that|your) request (?:goes against|violates|is against|conflicts with)\b/i,
  /\b(?:goes against|violates|is against|outside of?) (?:my|our|the) (?:guidelines|programming|principles|content polic(?:y|ies)|usage polic(?:y|ies)|ethical guidelines|terms of (?:use|service))\b/i,
];

/** A reply that opens with dialogue or an action (`"…"`, `*…*`) is in character. */
const IN_CHARACTER = /^[\s]*["“”'‘*_~(\[—–-]/;

/** A policy lecture at the very start of the reply ("It's important to remember that…" before any answer). */
const LECTURE_OPENERS: RegExp[] = [
  /^\W*(?:I understand (?:you(?:'re| are)|that you)[^.]{0,80}\.\s*)?(?:However|But),? (?:it(?:'s| is) important|I (?:must|need to|have to|want to) (?:emphasi[sz]e|remind|stress|point out))/i,
  /^\W*(?:It(?:'s| is) (?:important|crucial|essential) to (?:note|remember|understand|recogni[sz]e) that)[^.]{0,160}\b(?:illegal|harmful|unethical|dangerous|inappropriate|against)\b/i,
  /^\W*(?:I(?:'m| am) (?:really )?(?:concerned|worried) (?:about|by))\b/i,
];

/** Openers so plain that the model is not asked (saves the classifier round trip). */
const PLAIN_REFUSALS: RegExp[] = [
  /^\W*(?:I(?:'m| am) )?(?:so |very |really )?sorry,? (?:but )?I (?:can(?:'|no)?t|cannot|won'?t) (?:help|assist|provide|comply|do that|fulfil|fulfill|create|write)\b/i,
  /^\W*I (?:can(?:'|no)?t|cannot|won'?t) (?:help|assist) with (?:that|this)\b/i,
  /^\W*I(?:'m| am) (?:not able|unable) to (?:help|assist|provide|comply) with (?:that|this)\b/i,
  // "I'm not able to write sexually explicit content…" (qwen/qwen4-max, receipt gen-1795224826-Nqic8uhhctKqow).
  /^\W*I(?:'m|’m| am) (?:not able|unable|not going) to (?:write|create|generate|produce) (?:that|this|it|sexually|explicit|sexual|graphic|the (?:scene|story|content))\b/i,
];

export const phraseRules = {
  /** True when the opening of `head` reads as a refusal or a policy lecture. */
  isRefusal(head: string): boolean {
    const opening = head.trimStart().slice(0, OPENING_CHARS);
    if (!opening) return false;
    if (POLICY_RULES.some((r) => r.test(opening))) return true;
    if (IN_CHARACTER.test(opening)) return false;
    return REFUSAL_RULES.some((r) => r.test(opening)) || LECTURE_OPENERS.some((r) => r.test(opening));
  },
  /** A refusal so unambiguous that it needs no second opinion. */
  isPlainRefusal(head: string): boolean {
    const opening = head.trimStart().slice(0, OPENING_CHARS);
    return !IN_CHARACTER.test(opening) && PLAIN_REFUSALS.some((r) => r.test(opening));
  },
};

export const phraseRefusalClassifier: RefusalClassifier = {
  async isRefusal(_prompt, head) {
    return phraseRules.isRefusal(head);
  },
};

export type ModelClassifierOptions = {
  /** Base URL of an OpenAI-compatible API, e.g. http://refusal-classifier:8000/v1 */
  url: string;
  model: string;
  apiKey?: string;
  /** The model's answer must arrive within this, or the rules decide. The whole head check is capped at about 1.2 s. */
  timeoutMs: number;
  fetch?: typeof fetch;
};

const SYSTEM = [
  "You label assistant replies. Given a user request and the opening of an assistant's reply, decide whether the",
  "assistant refused: declined, deflected, lectured about policy or ethics instead of answering, or gave a",
  "watered-down non-answer. Roleplay, fiction, blunt or explicit content, and answers that add a short caveat but",
  "then do what was asked are NOT refusals. Answer with exactly one word: REFUSAL or ANSWER.",
].join(" ");

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/** Ask the small model. Returns null when it cannot answer (network, timeout, HTTP error, unparsable reply). */
export async function askModel(o: ModelClassifierOptions, prompt: string, head: string): Promise<boolean | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs);
  try {
    const res = await (o.fetch ?? fetch)(o.url.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}) },
      body: JSON.stringify({
        model: o.model,
        temperature: 0,
        max_tokens: 3,
        stream: false,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `User request:\n${clip(prompt, 2000)}\n\nOpening of the assistant's reply:\n${clip(head, 1200)}\n\nREFUSAL or ANSWER?` },
        ],
      }),
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const word = String(j.choices?.[0]?.message?.content ?? "").trim().toUpperCase();
    if (word.startsWith("REFUS")) return true;
    if (word.startsWith("ANSWER")) return false;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Phrase rules plus the small model; any failure of the model falls back to the rules. */
export function layeredRefusalClassifier(o: ModelClassifierOptions): RefusalClassifier {
  return {
    async isRefusal(prompt, head) {
      if (!head.trim()) return false; // tool calls, images or an empty opening: nothing to judge
      if (phraseRules.isPlainRefusal(head)) return true;
      const verdict = await askModel(o, prompt, head);
      return verdict ?? phraseRules.isRefusal(head);
    },
  };
}

/** The classifier for this deployment: the layered one when ANONYMO_REFUSAL_URL is set, else the phrase rules. */
export function defaultRefusalClassifier(env: Record<string, unknown>): RefusalClassifier {
  const url = typeof env.ANONYMO_REFUSAL_URL === "string" ? env.ANONYMO_REFUSAL_URL.trim() : "";
  if (!url) return phraseRefusalClassifier;
  const timeout = Number(env.ANONYMO_REFUSAL_TIMEOUT_MS ?? 700);
  return layeredRefusalClassifier({
    url,
    model: typeof env.ANONYMO_REFUSAL_MODEL === "string" && env.ANONYMO_REFUSAL_MODEL ? env.ANONYMO_REFUSAL_MODEL : "refusal-classifier",
    apiKey: typeof env.ANONYMO_REFUSAL_KEY === "string" && env.ANONYMO_REFUSAL_KEY ? env.ANONYMO_REFUSAL_KEY : undefined,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 1200) : 700,
  });
}
