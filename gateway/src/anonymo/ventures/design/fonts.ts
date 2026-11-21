// WS11 · Designer Mo's type library (Ventures Overview §2 "Original look": palette, type, components, copy voice).
//
// Only families published on Google Fonts under the SIL Open Font License 1.1, so every venture can ship, embed and
// self-host its fonts. Each pairing is a display face, a body face and a mono face that sit well together, tagged with
// the moods it suits. Weights listed are ones the family actually has, so the stylesheet URL never asks for a missing cut.

import type { Mood } from "./tokens.ts";

export type FontCategory = "sans" | "serif" | "mono";
export type FontFace = {
  family: string;
  category: FontCategory;
  weights: number[];
  fallback: string;
  licence: "OFL-1.1";
};
export type DisplayFace = FontFace & { weight: number; tracking: string; /** Extended faces set smaller heroes. */ wide?: boolean };

const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const SERIF = 'ui-serif, Georgia, "Times New Roman", serif';
const MONO = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

const face = (family: string, category: FontCategory, weights: number[]): FontFace => ({
  family,
  category,
  weights,
  fallback: category === "serif" ? SERIF : category === "mono" ? MONO : SANS,
  licence: "OFL-1.1",
});
const display = (family: string, category: FontCategory, weights: number[], weight: number, tracking: string, wide = false): DisplayFace => ({ ...face(family, category, weights), weight, tracking, ...(wide ? { wide } : {}) });

export const DISPLAY_FACES = {
  spaceGrotesk: display("Space Grotesk", "sans", [500, 700], 700, "-0.035em"),
  syne: display("Syne", "sans", [700, 800], 800, "-0.03em", true),
  fraunces: display("Fraunces", "serif", [600, 700], 600, "-0.025em"),
  instrumentSerif: display("Instrument Serif", "serif", [400], 400, "-0.015em"),
  bricolage: display("Bricolage Grotesque", "sans", [600, 800], 800, "-0.04em"),
  unbounded: display("Unbounded", "sans", [600, 700], 700, "-0.03em", true),
  playfair: display("Playfair Display", "serif", [600, 700], 600, "-0.02em"),
  sora: display("Sora", "sans", [600, 700], 600, "-0.035em"),
  outfit: display("Outfit", "sans", [600, 700], 600, "-0.03em"),
  cormorant: display("Cormorant Garamond", "serif", [500, 600], 600, "-0.01em"),
  archivo: display("Archivo", "sans", [700, 800], 800, "-0.035em"),
  dmSerif: display("DM Serif Display", "serif", [400], 400, "-0.015em"),
  jakarta: display("Plus Jakarta Sans", "sans", [700, 800], 800, "-0.04em"),
  youngSerif: display("Young Serif", "serif", [400], 400, "-0.02em"),
  familjen: display("Familjen Grotesk", "sans", [600, 700], 700, "-0.035em"),
  gloock: display("Gloock", "serif", [400], 400, "-0.015em"),
} as const;

const B = [400, 500, 600];
export const BODY_FACES = {
  inter: face("Inter", "sans", B),
  dmSans: face("DM Sans", "sans", B),
  plexSans: face("IBM Plex Sans", "sans", B),
  workSans: face("Work Sans", "sans", B),
  figtree: face("Figtree", "sans", B),
  onest: face("Onest", "sans", B),
  instrumentSans: face("Instrument Sans", "sans", B),
  publicSans: face("Public Sans", "sans", B),
  hanken: face("Hanken Grotesk", "sans", B),
  manrope: face("Manrope", "sans", B),
} as const;

export const MONO_FACES = {
  jetbrains: face("JetBrains Mono", "mono", [400, 500]),
  plexMono: face("IBM Plex Mono", "mono", [400, 500]),
  spaceMono: face("Space Mono", "mono", [400, 700]),
  dmMono: face("DM Mono", "mono", [400, 500]),
  firaCode: face("Fira Code", "mono", [400, 500]),
  martian: face("Martian Mono", "mono", [400, 500]),
  sourceCode: face("Source Code Pro", "mono", [400, 500]),
} as const;

export type FontPairing = { display: DisplayFace; body: FontFace; mono: FontFace; moods: Mood[] };

const D = DISPLAY_FACES;
const Bo = BODY_FACES;
const M = MONO_FACES;
export const PAIRINGS: FontPairing[] = [
  { display: D.spaceGrotesk, body: Bo.inter, mono: M.jetbrains, moods: ["technical", "bold"] },
  { display: D.syne, body: Bo.dmSans, mono: M.dmMono, moods: ["bold", "playful"] },
  { display: D.fraunces, body: Bo.instrumentSans, mono: M.plexMono, moods: ["calm", "luxe", "playful"] },
  { display: D.instrumentSerif, body: Bo.inter, mono: M.jetbrains, moods: ["luxe", "calm"] },
  { display: D.bricolage, body: Bo.figtree, mono: M.martian, moods: ["playful", "bold"] },
  { display: D.unbounded, body: Bo.onest, mono: M.spaceMono, moods: ["bold", "playful", "technical"] },
  { display: D.playfair, body: Bo.workSans, mono: M.plexMono, moods: ["luxe"] },
  { display: D.sora, body: Bo.publicSans, mono: M.firaCode, moods: ["technical", "calm"] },
  { display: D.outfit, body: Bo.hanken, mono: M.dmMono, moods: ["calm", "playful"] },
  { display: D.cormorant, body: Bo.manrope, mono: M.sourceCode, moods: ["luxe", "calm"] },
  { display: D.archivo, body: Bo.plexSans, mono: M.plexMono, moods: ["technical", "bold"] },
  { display: D.dmSerif, body: Bo.dmSans, mono: M.dmMono, moods: ["luxe", "calm"] },
  { display: D.jakarta, body: Bo.inter, mono: M.jetbrains, moods: ["technical", "calm", "bold"] },
  { display: D.youngSerif, body: Bo.instrumentSans, mono: M.martian, moods: ["playful", "calm"] },
  { display: D.familjen, body: Bo.figtree, mono: M.firaCode, moods: ["bold", "technical"] },
  { display: D.gloock, body: Bo.hanken, mono: M.sourceCode, moods: ["luxe", "bold"] },
];

export const pairingsFor = (mood: Mood) => PAIRINGS.filter((p) => p.moods.includes(mood));

/** CSS font-family value: the family, then the system fallback. */
export const fontStack = (f: FontFace) => `"${f.family}", ${f.fallback}`;
