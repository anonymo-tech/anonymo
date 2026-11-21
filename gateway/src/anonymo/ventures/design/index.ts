// WS11 · Designer Mo, the crew's designer (Ventures Overview §2 "Designer Mo (beanie) — Original look. Generates a
// fresh design system (palette, type, components, copy voice) for each venture"; Backend PART 11 "designer:
// Design-system generator (tokens, components, copy voice), uniqueness check vs gallery").
//
// A CLEAN step: its inputs are a seed, the clean brief, the avoid-list of names and the gallery of earlier ventures'
// systems. It never sees a competitor's pages or CSS. Output: the system, its stylesheet, the dashboard preview and a
// sha256 over the canonical system + stylesheet, so the artifact can be stored and checked by hash.

import { createHash } from "node:crypto";
import type { Llm } from "../llm.ts";
import { toCss } from "./css.ts";
import { renderDesignPreview } from "./pages.ts";
import { generateDesignSystem, moodFor, MOODS, type DesignSystem, type Mood } from "./tokens.ts";
import { DEFAULT_MIN_DISTANCE, ensureUnique } from "./uniqueness.ts";
import { proposeVoice, type VoiceProposal } from "./voice.ts";

export { contrastRatio, deltaEOk, oklchToHex, hexToOklch } from "./color.ts";
export { fontLinks, googleFontsUrl, toCss } from "./css.ts";
export { escapeHtml, renderComparison, renderDesignPreview, renderLanding, citedRows, type ComparisonContent, type ComparisonRow, type LandingContent } from "./pages.ts";
export { generateDesignSystem, MOODS, type DesignSystem, type Mood, type Palette } from "./tokens.ts";
export { designDistance, ensureUnique, DEFAULT_MIN_DISTANCE } from "./uniqueness.ts";
export { nameIsSafe, nameConflict, proposeVoice, soundKey } from "./voice.ts";

const MOOD_WORDS: [Mood, RegExp][] = [
  ["technical", /\b(api|sdk|developer|devs?|cli|infra|database|logs?|monitor\w*|deploy\w*|webhooks?|terminal)\b/i],
  ["luxe", /\b(luxury|premium|boutique|bespoke|atelier|jewel\w*|fashion|concierge|wine)\b/i],
  ["playful", /\b(kids?|fun|games?|pets?|party|social|creator|meme|stickers?|quiz)\b/i],
  ["calm", /\b(health|wellness|sleep|therapy|meditat\w*|journal\w*|care|budget\w*|calm|family)\b/i],
  ["bold", /\b(launch|growth|sales|ads?|marketing|fitness|sports?|trading|crypto|payments?)\b/i],
];

/** A mood from the brief's vocabulary, or the seed's own pick when the brief gives no hint. */
export function moodFromBrief(brief: string, seed: string): Mood {
  return MOOD_WORDS.find(([, re]) => re.test(brief))?.[0] ?? moodFor(seed);
}

export type DesignVentureInput = {
  seed: string;
  brief: string;
  mood?: Mood;
  /** Names the venture must not be confusable with (the rival's name, other marks). Never sent to a model. */
  avoidNames: string[];
  /** Earlier ventures' systems; the new one must look different from all of them. */
  gallery: DesignSystem[];
  llm?: Llm;
  model?: string;
  minDistance?: number;
};

export type DesignVentureResult = {
  system: DesignSystem;
  css: string;
  preview: string;
  sha256: string;
  brand: Omit<VoiceProposal, "voice">;
  uniqueness: { attempts: number; distance: number; unique: boolean };
};

const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(v);

export const systemSha256 = (system: DesignSystem, css: string) => createHash("sha256").update(canonical({ system, css })).digest("hex");

export async function designVenture(input: DesignVentureInput): Promise<DesignVentureResult> {
  const mood = input.mood && (MOODS as readonly string[]).includes(input.mood) ? input.mood : moodFromBrief(input.brief, input.seed);
  const unique = ensureUnique(generateDesignSystem(input.seed, mood), input.gallery, input.minDistance ?? DEFAULT_MIN_DISTANCE);
  const proposal = await proposeVoice({ seed: unique.system.seed, brief: input.brief, mood, avoidNames: input.avoidNames, llm: input.llm, model: input.model });
  const system: DesignSystem = { ...unique.system, voice: proposal.voice };
  const css = toCss(system);
  const { voice: _voice, ...brand } = proposal;
  return {
    system,
    css,
    preview: renderDesignPreview(system),
    sha256: systemSha256(system, css),
    brand,
    uniqueness: { attempts: unique.attempts, distance: unique.distance, unique: unique.unique },
  };
}
