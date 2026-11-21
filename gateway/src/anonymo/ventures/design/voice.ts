// WS11 · Designer Mo's naming and copy voice (Ventures Overview §2 "copy voice"; Backend PART 11 "designer").
//
// An optional model step proposes a brand-name shortlist, a tagline and a voice from the clean brief. The reply is
// parsed as JSON and checked; without a model, on a refusal or on bad JSON the deterministic voice is used. Every name,
// whoever proposed it, must pass nameIsSafe against the avoid list (the rival's name and any other marks we must not
// be confused with), so a venture never launches under a confusable name. The avoid list stays local: it is never sent
// to the model.

import { CrewCallError, parseJsonReply, type Llm } from "../llm.ts";
import { defaultVoice, seededRandom, type Mood, type Voice } from "./tokens.ts";

// ---- confusable-name check ------------------------------------------------------------------------------------------

const normalise = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/**
 * A small Metaphone-style sound key: folds spellings that sound alike (ph/f, ck/k, soft c/s, soft g and dg/j, x/ks,
 * z/s, qu/kw), drops vowels after the first letter and silent h/w, and collapses repeats. "Ledgerly", "Ledgerlee" and
 * "Ledgrly" all key to "LJRL".
 */
export function soundKey(name: string): string {
  let s = normalise(name).replace(/[0-9]/g, "");
  if (!s) return "";
  s = s
    .replace(/^kn|^gn|^pn|^wr/, (m) => m[1])
    .replace(/^x/, "s")
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/sch/g, "sk")
    .replace(/tch/g, "ch")
    .replace(/sh|ch/g, "X")
    .replace(/dg/g, "j")
    .replace(/g(?=[eiy])/g, "j")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/q/g, "k")
    .replace(/x/g, "ks")
    .replace(/z/g, "s")
    .replace(/v/g, "f")
    .replace(/th/g, "0")
    .replace(/gh(?![aeiou])/g, "")
    .replace(/mb$/, "m");
  const first = s[0];
  const rest = s.slice(1).replace(/[aeiouyhw]/g, "");
  const key = (/[aeiouy]/.test(first) ? "a" : first) + rest;
  return key.replace(/(.)\1+/g, "$1").toUpperCase();
}

export type NameConflict = { against: string; reason: "same" | "contains" | "spelling" | "sound" };

/** Why `name` could be confused with a name on the avoid list, or null when it is clear of all of them. */
export function nameConflict(name: string, avoid: string[]): NameConflict | null {
  const n = normalise(name);
  const nk = soundKey(name);
  for (const other of avoid) {
    const o = normalise(other);
    if (!o) continue;
    if (n === o) return { against: other, reason: "same" };
    if (o.length >= 4 && n.includes(o)) return { against: other, reason: "contains" };
    if (n.length >= 4 && o.includes(n)) return { against: other, reason: "contains" };
    const d = editDistance(n, o);
    const longest = Math.max(n.length, o.length);
    if (d <= (longest >= 6 ? 2 : 1) || 1 - d / longest >= 0.75) return { against: other, reason: "spelling" };
    const ok = soundKey(other);
    if (nk && nk === ok) return { against: other, reason: "sound" };
    if (nk.length >= 4 && ok.length >= 4 && editDistance(nk, ok) <= 1 && 1 - d / longest >= 0.5) return { against: other, reason: "sound" };
  }
  return null;
}

export const nameIsSafe = (name: string, avoid: string[]): boolean => normalise(name).length >= 2 && nameConflict(name, avoid) === null;

// ---- deterministic fallback ---------------------------------------------------------------------------------------

const HEADS = ["Bright", "Kin", "Nova", "Fern", "Lumen", "Orbit", "Quill", "Harbor", "Mint", "Pebble", "Atlas", "Ember", "Sol", "Vela", "Juno", "Arc", "Tide", "Wren", "Cobble", "Halo"];
const TAILS = ["fold", "wise", "loop", "nest", "way", "path", "mark", "base", "craft", "stack", "bay", "kit", "field", "post", "line", "yard"];

export function fallbackNames(seed: string, avoid: string[], count = 5): string[] {
  const r = seededRandom(`${seed}::names`);
  const out: string[] = [];
  const heads = new Set<string>();
  for (let i = 0; i < 400 && out.length < count; i++) {
    const head = HEADS[Math.floor(r() * HEADS.length)];
    const name = head + TAILS[Math.floor(r() * TAILS.length)];
    if (!heads.has(head) && nameIsSafe(name, [...avoid, ...out])) {
      out.push(name);
      heads.add(head);
    }
  }
  return out;
}

/** A plain tagline from the brief's first clause, trimmed on a word boundary. */
export function fallbackTagline(brief: string): string {
  const first = brief.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0]?.replace(/[.!?;:,\s]+$/, "") ?? "";
  if (!first) return "Made to be used, not explained.";
  let t = first;
  if (t.length > 72) t = t.slice(0, 72).replace(/\s+\S*$/, "");
  return t[0].toUpperCase() + t.slice(1) + ".";
}

// ---- the model step -----------------------------------------------------------------------------------------------

export type VoiceProposal = { names: string[]; name: string; tagline: string; voice: Voice; source: "llm" | "fallback" };

export type VoiceRequest = { seed: string; brief: string; mood: Mood; avoidNames: string[]; llm?: Llm; model?: string };

const NAME_RE = /^[A-Za-z][A-Za-z0-9 .'-]{1,23}$/;
const strings = (v: unknown, max: number, maxLen: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.replace(/\s+/g, " ").trim()).filter((x) => x.length > 0 && x.length <= maxLen).slice(0, max) : [];

export function voicePrompt(brief: string, mood: Mood) {
  return [
    {
      role: "system" as const,
      content:
        "You are Designer Mo, naming a new product and setting its copy voice. Reply with one JSON object only: " +
        '{"names": [5 short invented brand names], "tagline": "at most 80 characters", "tone": [3 adjectives], ' +
        '"doSay": [3 short writing rules], "dontSay": [3 words or phrases to avoid]}. Names must be original coinages that are ' +
        "easy to say and spell and do not resemble any existing product or company. Write plain, specific copy with no hype.",
    },
    { role: "user" as const, content: `Brief: ${brief.slice(0, 2000)}\nMood: ${mood}` },
  ];
}

type Raw = { names?: unknown; tagline?: unknown; tone?: unknown; doSay?: unknown; dontSay?: unknown };

/** Checks a model reply; null when it carries nothing usable. Unsafe or malformed names are dropped. */
export function parseVoiceReply(text: string, avoid: string[]): { names: string[]; tagline: string | null; voice: Partial<Voice> } | null {
  const raw = parseJsonReply<Raw>(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const n of strings(raw.names, 10, 24)) if (NAME_RE.test(n) && nameIsSafe(n, [...avoid, ...names])) names.push(n);
  const tagline = typeof raw.tagline === "string" ? raw.tagline.replace(/\s+/g, " ").trim() : "";
  const lower = tagline.toLowerCase();
  const taglineOk = tagline.length > 0 && tagline.length <= 120 && !avoid.some((a) => a.trim() && lower.includes(a.trim().toLowerCase()));
  const voice: Partial<Voice> = {};
  const tone = strings(raw.tone, 5, 40);
  const doSay = strings(raw.doSay, 5, 120);
  const dontSay = strings(raw.dontSay, 6, 80);
  if (tone.length) voice.tone = tone;
  if (doSay.length) voice.doSay = doSay;
  if (dontSay.length) voice.dontSay = dontSay;
  if (!names.length && !taglineOk && !Object.keys(voice).length) return null;
  return { names, tagline: taglineOk ? tagline : null, voice };
}

export async function proposeVoice(req: VoiceRequest): Promise<VoiceProposal> {
  const base = defaultVoice(req.mood);
  const fallback = (): VoiceProposal => {
    const names = fallbackNames(req.seed, req.avoidNames);
    return { names, name: names[0] ?? "Untitled", tagline: fallbackTagline(req.brief), voice: base, source: "fallback" };
  };
  if (!req.llm) return fallback();
  let text: string;
  try {
    const reply = await req.llm.call({ model: req.model ?? "anonymo-1", messages: voicePrompt(req.brief, req.mood), json: true, temperature: 0.8, maxTokens: 600 });
    if (reply.refused) return fallback();
    text = reply.text;
  } catch (e) {
    if (e instanceof CrewCallError && e.fatal) throw e;
    return fallback();
  }
  const parsed = parseVoiceReply(text, req.avoidNames);
  if (!parsed) return fallback();
  const names = [...parsed.names];
  for (const n of fallbackNames(req.seed, [...req.avoidNames, ...names])) if (names.length < 5) names.push(n);
  return {
    names,
    name: names[0] ?? "Untitled",
    tagline: parsed.tagline ?? fallbackTagline(req.brief),
    voice: {
      tone: parsed.voice.tone ?? base.tone,
      doSay: parsed.voice.doSay ?? base.doSay,
      // House rules stay whatever the model adds.
      dontSay: [...new Set([...(parsed.voice.dontSay ?? []), ...base.dontSay])],
    },
    source: "llm",
  };
}
