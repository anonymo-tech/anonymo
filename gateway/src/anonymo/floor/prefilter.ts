// A fast, deterministic first layer in front of the guard model. It blocks only unambiguous requests (a request verb
// close to a term that has no legal adult reading), and defers everything else to the model. It never allows anything
// on its own: `null` means "ask the model", not "safe". Precision matters more than recall here, because the
// adult-legal suite must stay at 0% blocked; the guard model catches what this layer misses.
//
// These lists are detection vocabulary, not content. Keep them that way: no example prompts in this file.

import type { FloorCategory } from "../seams.ts";

const ZERO_WIDTH = /[­͏؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i" };

/** NFKC, lower case, zero-width and combining marks removed, separators collapsed. */
export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .toLowerCase()
    .replace(/[\s_]+/g, " ");
}

/** A second view with common character substitutions undone inside words (l0li → loli, s4rin → sarin). */
export function deleet(normalized: string): string {
  return normalized.replace(/[a-z0-9@$!]+/g, (w) => (/[a-z]/.test(w) ? w.replace(/[0-9@$!]/g, (c) => LEET[c] ?? c) : w));
}

// A request: an imperative or a how-to marker. Questions about a topic do not match on their own.
const REQUEST = String.raw`(?:write|generate|create|draw|render|make|produce|show|send|give me|find me|describe|roleplay|role-play|rp|imagine|continue|story about|story where|picture of|image of|photo of|video of|how (?:to|do i|do you|can i|would i)|steps? (?:to|for)|recipe for|instructions? (?:to|for)|guide (?:to|for)|walk me through|step[- ]by[- ]step)`;
const near = (a: string, b: string, words = 8) => new RegExp(String.raw`\b${a}\b(?:\W+\w+){0,${words}}?\W+${b}\b`);

type Rule = { category: FloorCategory; re: RegExp };

// CSAM jargon: terms with no adult-legal reading.
const MINOR_JARGON = String.raw`(?:lolicon|shotacon|loli|shota|pthc|child porn\w*|kiddie porn\w*|cp porn|underage porn\w*|preteen porn\w*|jailbait porn\w*)`;
// Real-person sexual edits. "Undress" only with a photo as its object, so adult romance prose is not caught.
const NUDIFY = String.raw`(?:nudify|nudifier|undress(?:ing)? (?:this|the|her|his|their|my|a) (?:\w+ )?(?:photo|picture|pic|image|selfie)|remove (?:her|his|their) cloth\w* (?:in|from) (?:this|the|my) (?:photo|picture|pic|image))`;
const DEEPFAKE = String.raw`(?:deepfake (?:porn\w*|nudes?|sex\w*)|fake nudes? of)`;
// Voice cloning of a person (own voice included: stock voices only).
const VOICE = String.raw`(?:clone|cloning|replicate|deepfake) (?:(?:his|her|their|my|your|this|that|the) (?:own )?|\w+'s )voice`;
// An imperative at the start of a sentence or after a request phrase ("please clone her voice").
const IMPERATIVE = String.raw`(?:^|[.!?:;]\s*|\b(?:please|can you|could you|would you|i want you to|i want to|help me|let's|lets)\s+)`;
// CBRN agents and devices with no civilian recipe use.
const CBRN_AGENT = String.raw`(?:sarin|tabun|soman|cyclosarin|vx(?: nerve)?(?: agent| gas)?|novichok|nerve agents?|mustard gas|sulfur mustard|lewisite|ricin|abrin|anthrax|bacillus anthracis|botulinum toxin|weaponi[sz]ed \w+|smallpox|variola|weapons[- ]grade (?:uranium|plutonium)|dirty bomb|pipe bomb|nail bomb|car bomb|suicide vest|tatp|triacetone triperoxide|hmtd|semtex|c-?4 explosive|improvised explosive device|\bied\b)`;
const CBRN_VERB = String.raw`(?:make|making|synthesi[sz]e|synthesi[sz]ing|produce|producing|manufacture|cook|brew|build|assemble|culture|grow|weaponi[sz]e|aerosoli[sz]e|enrich|extract|purify|detonate|obtain|acquire|buy)`;

const RULES: Rule[] = [
  { category: "minor", re: near(REQUEST, MINOR_JARGON) },
  { category: "minor", re: near(MINOR_JARGON, String.raw`(?:story|roleplay|rp|image|picture|pics?|video|links?|site|sites)`, 3) },
  { category: "real_person", re: new RegExp(String.raw`\b${NUDIFY}\b`) },
  { category: "real_person", re: near(REQUEST, DEEPFAKE, 4) },
  { category: "voice_clone", re: near(REQUEST, VOICE, 4) },
  { category: "voice_clone", re: new RegExp(IMPERATIVE + VOICE + String.raw`\b`) },
  { category: "cbrn", re: new RegExp(String.raw`\b${REQUEST}\b(?:\W+\w+){0,4}?\W+${CBRN_VERB}\b(?:\W+\w+){0,4}?\W+${CBRN_AGENT}`) },
];

export type PrefilterHit = { category: FloorCategory; rule: number };

/** Returns the first rule that fires, or null to defer to the guard model. */
export function prefilter(text: string): PrefilterHit | null {
  const n = normalize(text);
  const views = n === deleet(n) ? [n] : [n, deleet(n)];
  for (const v of views) for (const [i, r] of RULES.entries()) if (r.re.test(v)) return { category: r.category, rule: i };
  return null;
}
