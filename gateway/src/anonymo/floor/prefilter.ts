// A fast, deterministic first layer in front of the guard model. It blocks only unambiguous requests (a request verb
// close to a term that has no legal adult reading), and defers everything else to the model. It never allows anything
// on its own: `null` means "ask the model", not "safe". Precision matters more than recall here, because the
// adult-legal suite must stay at 0% blocked; the guard model catches what this layer misses.
//
// These lists are detection vocabulary, not content. Keep them that way: no example prompts in this file.
//
// Two kinds of rule:
//   - request rules (RULES): a request verb near a term, for prompts only;
//   - content rules (CONTENT_RULES): text that is over the line whoever wrote it, for prompts AND model replies. They
//     cover only the worst category: known CSAM code words, and an under-18 age marker within a few words of a
//     sexual-content word. Clinical, educational and abuse-report vocabulary (puberty, sex education, masturbation,
//     molested, abuse) is deliberately left out of the sexual-content list, so a parent or survivor asking for help is
//     never stopped here; the guard model decides those.

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

type Rule = { category: FloorCategory; re: RegExp; unless?: RegExp };

// CSAM jargon: terms with no adult-legal reading.
const MINOR_JARGON = String.raw`(?:lolicon|shotacon|loli|shota|pthc|child porn\w*|kiddie porn\w*|cp porn|underage porn\w*|preteen porn\w*|jailbait porn\w*)`;
// Real-person sexual edits. "Undress" only with a photo as its object, so adult romance prose is not caught.
const NUDIFY = String.raw`(?:nudify|nudifier|undress(?:ing)? (?:this|the|her|his|their|my|a) (?:\w+ )?(?:photo|picture|pic|image|selfie)|remove (?:her|his|their) cloth\w* (?:in|from) (?:this|the|my) (?:photo|picture|pic|image))`;
const DEEPFAKE = String.raw`(?:deepfake (?:porn\w*|nudes?|sex\w*)|fake nudes? of)`;
// Voice cloning of a person (own voice included: stock voices only).
const VOICE = String.raw`(?:clone|cloning|replicate|deepfake) (?:(?:his|her|their|my|your|this|that|the) (?:own )?|\w+'s )voice`;
// An imperative at the start of a sentence or after a request phrase ("please clone her voice").
const IMPERATIVE = String.raw`(?:^|[.!?:;]\s*|\b(?:please|can you|could you|would you|i want you to|i want to|help me|let's|lets)\s+)`;
// Trafficking or recruiting children, and the words that mark text as fighting it instead.
const TRAFFIC_CHILDREN = String.raw`(?:(?:traffic\w*|smuggl\w*) (?:(?:young|little|underage) )?(?:children|kids|girls|boys|minors|a child|a kid)|(?:recruit\w*|sell\w*|buy\w*) (?:(?:young|little|underage) )?(?:children|kids|girls|boys|minors|a child|a kid)(?:\W+\w+){0,5}?\W+(?:traffic\w*|for sex|prostitut\w*|sex work\w*))`;
const COUNTER_TRAFFICKING = /\b(?:prevent\w*|stop\w*|report\w*|detect\w*|recogni[sz]\w*|spot|identify\w*|protect\w*|rescue\w*|fight\w*|combat\w*|bust\w*|arrest\w*|investigat\w*|expos\w*|dismantl\w*|warning signs?|survivors?|victims?)\b/;
const SEX_TRAFFIC = String.raw`(?:(?:children|kids|girls|boys|minors) (?:to )?sex[- ]?traffic\w*|sex[- ]?traffic\w* (?:children|kids|girls|boys|minors)|(?:my|our|a new|new) (?:child )?(?:sex )?trafficking (?:ring|business|operation))`;
// CBRN agents and devices with no civilian recipe use.
const CBRN_AGENT = String.raw`(?:sarin|tabun|soman|cyclosarin|vx(?: nerve)?(?: agent| gas)?|novichok|nerve agents?|mustard gas|sulfur mustard|lewisite|ricin|abrin|anthrax|bacillus anthracis|botulinum toxin|weaponi[sz]ed \w+|smallpox|variola|weapons[- ]grade (?:uranium|plutonium)|dirty bomb|pipe bomb|nail bomb|car bomb|suicide vest|tatp|triacetone triperoxide|hmtd|semtex|c-?4 explosive|improvised explosive device|\bied\b)`;
const CBRN_VERB = String.raw`(?:make|making|synthesi[sz]e|synthesi[sz]ing|produce|producing|manufacture|cook|brew|build|assemble|culture|grow|weaponi[sz]e|aerosoli[sz]e|enrich|extract|purify|detonate|obtain|acquire|buy)`;

const RULES: Rule[] = [
  { category: "minor", re: near(REQUEST, MINOR_JARGON) },
  { category: "minor", re: near(MINOR_JARGON, String.raw`(?:story|roleplay|rp|image|picture|pics?|video|links?|site|sites)`, 3) },
  // Asking how to traffic or recruit children. Text about stopping, reporting or detecting trafficking is left to the
  // guard model.
  { category: "minor", re: near(REQUEST, TRAFFIC_CHILDREN, 8), unless: COUNTER_TRAFFICKING },
  { category: "minor", re: near(REQUEST, SEX_TRAFFIC, 10), unless: COUNTER_TRAFFICKING },
  { category: "minor", re: new RegExp(String.raw`\b(?:get away with|not get caught|avoid (?:getting )?caught)\b(?:\W+\w+){0,4}?\W+(?:child|children|kids?|minors?|girls?|boys?)(?: sex)? traffick\w*`), unless: COUNTER_TRAFFICKING },
  { category: "real_person", re: new RegExp(String.raw`\b${NUDIFY}\b`) },
  { category: "real_person", re: near(REQUEST, DEEPFAKE, 4) },
  { category: "voice_clone", re: near(REQUEST, VOICE, 4) },
  { category: "voice_clone", re: new RegExp(IMPERATIVE + VOICE + String.raw`\b`) },
  { category: "cbrn", re: new RegExp(String.raw`\b${REQUEST}\b(?:\W+\w+){0,4}?\W+${CBRN_VERB}\b(?:\W+\w+){0,4}?\W+${CBRN_AGENT}`) },
];

// ---- content rules (prompts and replies) -------------------------------------------------------------------------
// Code words used to trade CSAM, with no other reading.
const CSAM_CODE = String.raw`(?:pthc|ptsc|hussyfan|raygold|babyshivid|kingpass|lolicon|shotacon|toddlercon)`;
// An age under 18, a school year up to eighth grade, or a word that only names a child. "Teen", "high school" and
// "schoolgirl" are left out: adult roleplay uses them about adults, and the guard model judges those.
const NUM_UNDER_18 = String.raw`(?:[1-9]|1[0-7]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)`;
const MINOR_MARKER = String.raw`(?:${NUM_UNDER_18}[- ]?(?:yo|y/o|yrs? old|years?[- ]old|year olds?)|aged? ${NUM_UNDER_18}|(?:[1-8](?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth)[- ]grader?s?|in (?:the )?(?:[1-8](?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth) grade|middle[- ]school(?:ers?)?|elementary[- ]school(?:ers?)?|grade[- ]school(?:ers?)?|junior high|kindergarten(?:ers?)?|pre-?school(?:ers?)?|pre-?teens?|prepubescent|underaged?|under-age|toddlers?|infants?)`;
// Words that make text sexual content (not a health question or an abuse report). "Naked" is left out: parents use it
// about small children all the time.
const SEXUAL = String.raw`(?:porn\w*|erotic\w*|nsfw|hentai|lewd|smut\w*|nudes?|sexy|seductive\w*|horny|fuck\w*|blowjobs?|handjobs?|cum|cumming|orgasm\w*|sexts?|sexting|sex scenes?|sexual(?:ly)? (?:explicit|roleplay|role-play|stor(?:y|ies)|fantas\w+|content|acts?))`;

const CONTENT_RULES: Rule[] = [
  { category: "minor", re: new RegExp(String.raw`\b${CSAM_CODE}\b`) },
  { category: "minor", re: near(MINOR_MARKER, SEXUAL, 5) },
  { category: "minor", re: near(SEXUAL, MINOR_MARKER, 5) },
];

export type PrefilterHit = { category: FloorCategory; rule: number };

/** Returns the first rule that fires, or null to defer to the guard model. A reply is read with the content rules
 *  only (the request rules match requests, not what a model writes). Content rules are numbered after RULES. */
export function prefilter(text: string, opts: { reply?: boolean } = {}): PrefilterHit | null {
  const n = normalize(text);
  const views = n === deleet(n) ? [n] : [n, deleet(n)];
  for (const v of views) {
    if (!opts.reply) for (const [i, r] of RULES.entries()) if (r.re.test(v) && !r.unless?.test(v)) return { category: r.category, rule: i };
    for (const [i, r] of CONTENT_RULES.entries()) if (r.re.test(v)) return { category: r.category, rule: RULES.length + i };
  }
  return null;
}
