// Demo copy of gateway/src/anonymo/ventures/design/tokens.ts, so demo mode makes looks the way the product does.
// Keep it in step with that file. WS11 · Designer Mo's design-system generator (Ventures Overview §2 "Designer Mo (beanie) — Original look. Generates a
// fresh design system (palette, type, components, copy voice) for each venture"; Backend PART 11 "designer").
//
// Deterministic: the same seed and mood always give the same system, byte for byte, so a venture's look can be rebuilt
// and its artifact hash checked. Nothing here ever sees a competitor's CSS; the only inputs are a seed and a mood.
// Colours are chosen in OKLCH and every text role is pushed until it meets WCAG contrast in both themes.

import { fitContrast, gamutClip, hexToOklch, hexToRgbTriple, oklchToHex, textOnFill, type Oklch } from "./color.ts";
import { pairingsFor, type DisplayFace, type FontFace } from "./fonts.ts";

export const MOODS = ["bold", "calm", "playful", "luxe", "technical"] as const;
export type Mood = (typeof MOODS)[number];

export const PALETTE_ROLES = ["bg", "surface", "surface2", "text", "muted", "primary", "primaryText", "accent", "accentText", "border", "success", "warning", "danger"] as const;
export type PaletteRole = (typeof PALETTE_ROLES)[number];
export type Palette = Record<PaletteRole, string>;
export type ThemeName = "light" | "dark";

export const SCALE_STEPS = ["xs", "sm", "base", "md", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl"] as const;
export type ScaleStep = (typeof SCALE_STEPS)[number];

export type RadiusStyle = "sharp" | "soft" | "round" | "pill";
export type ShadowStyle = "flat" | "soft" | "crisp" | "glow";

export type Voice = { tone: string[]; doSay: string[]; dontSay: string[] };

export type DesignSystem = {
  id: string;
  seed: string;
  name: string;
  mood: Mood;
  palette: { light: Palette; dark: Palette };
  /** Channel triples for shadows, per theme ("r g b"). */
  shadowRgb: { light: string; dark: string };
  fonts: { display: DisplayFace; body: FontFace; mono: FontFace };
  scale: { ratio: number; basePx: number; sizes: Record<ScaleStep, string>; hero: { min: string; max: string }; leading: { tight: number; snug: number; body: number } };
  spacing: { unitPx: number; steps: string[]; section: string };
  radii: { style: RadiusStyle; sm: string; md: string; lg: string; xl: string; button: string };
  shadows: { style: ShadowStyle; sm: string; md: string; lg: string };
  motion: { fastMs: number; baseMs: number; slowMs: number; easing: string; emphasized: string };
  voice: Voice;
  /** The generated brand mark: which glyph and how it is turned. */
  mark: { shape: number; rotate: number };
};

// ---- seeded randomness ---------------------------------------------------------------------------------------------

export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 over the FNV-1a hash of the seed. */
export function seededRandom(seed: string): () => number {
  let a = hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (r: () => number, lo: number, hi: number) => lo + (hi - lo) * r();
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length) % xs.length];
const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

// ---- mood recipes --------------------------------------------------------------------------------------------------

type Recipe = {
  chroma: [number, number];
  accentOffsets: number[];
  neutralChroma: number;
  warmNeutrals: boolean;
  ratio: number[];
  basePx: number;
  radii: RadiusStyle[];
  shadows: ShadowStyle[];
  motion: DesignSystem["motion"];
  section: string;
};

const RECIPES: Record<Mood, Recipe> = {
  bold: { chroma: [0.19, 0.26], accentOffsets: [150, 180, 205, -150], neutralChroma: 0.012, warmNeutrals: false, ratio: [1.333, 1.3], basePx: 16, radii: ["sharp", "soft"], shadows: ["crisp", "glow"], motion: { fastMs: 120, baseMs: 200, slowMs: 360, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", emphasized: "cubic-bezier(0.3, 0, 0, 1)" }, section: "clamp(4.5rem, 10vw, 8rem)" },
  calm: { chroma: [0.08, 0.13], accentOffsets: [30, 45, -40, 160], neutralChroma: 0.01, warmNeutrals: false, ratio: [1.2, 1.25], basePx: 17, radii: ["soft", "round"], shadows: ["soft", "flat"], motion: { fastMs: 160, baseMs: 280, slowMs: 520, easing: "cubic-bezier(0.4, 0, 0.2, 1)", emphasized: "cubic-bezier(0.22, 1, 0.36, 1)" }, section: "clamp(5rem, 11vw, 9rem)" },
  playful: { chroma: [0.16, 0.23], accentOffsets: [120, 150, -120, 90], neutralChroma: 0.016, warmNeutrals: false, ratio: [1.25, 1.3], basePx: 16, radii: ["round", "pill"], shadows: ["crisp", "soft"], motion: { fastMs: 140, baseMs: 240, slowMs: 480, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)", emphasized: "cubic-bezier(0.68, -0.4, 0.27, 1.4)" }, section: "clamp(4.5rem, 10vw, 8rem)" },
  luxe: { chroma: [0.05, 0.11], accentOffsets: [180, 40, -35], neutralChroma: 0.008, warmNeutrals: true, ratio: [1.333, 1.414], basePx: 17, radii: ["sharp", "soft"], shadows: ["soft", "flat"], motion: { fastMs: 180, baseMs: 320, slowMs: 640, easing: "cubic-bezier(0.25, 0.1, 0.25, 1)", emphasized: "cubic-bezier(0.16, 1, 0.3, 1)" }, section: "clamp(5.5rem, 12vw, 10rem)" },
  technical: { chroma: [0.12, 0.19], accentOffsets: [60, 180, -60, 140], neutralChroma: 0.01, warmNeutrals: false, ratio: [1.2, 1.25], basePx: 16, radii: ["sharp", "soft"], shadows: ["flat", "crisp", "glow"], motion: { fastMs: 90, baseMs: 160, slowMs: 280, easing: "cubic-bezier(0.2, 0, 0, 1)", emphasized: "cubic-bezier(0.05, 0.7, 0.1, 1)" }, section: "clamp(4rem, 9vw, 7rem)" },
};

const RADII: Record<RadiusStyle, Omit<DesignSystem["radii"], "style">> = {
  sharp: { sm: "2px", md: "4px", lg: "6px", xl: "10px", button: "4px" },
  soft: { sm: "6px", md: "10px", lg: "16px", xl: "24px", button: "10px" },
  round: { sm: "10px", md: "16px", lg: "24px", xl: "32px", button: "14px" },
  pill: { sm: "12px", md: "18px", lg: "28px", xl: "36px", button: "999px" },
};

const SH = (a: number) => `rgb(var(--shadow-rgb) / ${a})`;
const SHADOWS: Record<ShadowStyle, Omit<DesignSystem["shadows"], "style">> = {
  flat: { sm: `0 0 0 1px ${SH(0.06)}`, md: `0 1px 0 ${SH(0.06)}, 0 0 0 1px ${SH(0.05)}`, lg: `0 2px 0 ${SH(0.07)}, 0 0 0 1px ${SH(0.06)}` },
  soft: { sm: `0 1px 2px ${SH(0.06)}`, md: `0 6px 16px -4px ${SH(0.1)}, 0 2px 4px -2px ${SH(0.06)}`, lg: `0 30px 60px -18px ${SH(0.22)}, 0 12px 24px -12px ${SH(0.12)}` },
  crisp: { sm: `0 1px 0 ${SH(0.08)}`, md: `0 3px 0 ${SH(0.1)}, 0 0 0 1px ${SH(0.08)}`, lg: `8px 10px 0 -2px ${SH(0.16)}, 0 0 0 1px ${SH(0.1)}` },
  glow: { sm: `0 0 0 1px ${SH(0.06)}`, md: `0 10px 30px -10px color-mix(in oklab, var(--primary) 40%, transparent)`, lg: `0 40px 90px -30px color-mix(in oklab, var(--primary) 55%, transparent), 0 0 0 1px ${SH(0.06)}` },
};

const HUE_NAMES: [number, string][] = [
  [18, "Ember"], [42, "Copper"], [68, "Saffron"], [100, "Citron"], [140, "Moss"], [168, "Jade"], [198, "Lagoon"],
  [228, "Harbor"], [258, "Cobalt"], [288, "Iris"], [318, "Orchid"], [345, "Fuchsia"], [361, "Ember"],
];
const MOOD_NOUNS: Record<Mood, string[]> = {
  bold: ["Signal", "Voltage", "Flare"],
  calm: ["Tide", "Linen", "Haze"],
  playful: ["Pop", "Confetti", "Bounce"],
  luxe: ["Atelier", "Velvet", "Salon"],
  technical: ["Grid", "Circuit", "Vector"],
};
const hueName = (h: number) => HUE_NAMES.find(([max]) => h < max)?.[1] ?? "Ember";

// ---- palettes -------------------------------------------------------------------------------------------------------

type Seeds = { hue: number; chroma: number; accentHue: number; accentChroma: number; neutralHue: number; neutralChroma: number; lightBgL: number; darkBgL: number; primaryL: [number, number]; accentL: [number, number] };

function buildPalette(s: Seeds, theme: ThemeName): Palette {
  const light = theme === "light";
  const nc = s.neutralChroma;
  const bgL = light ? s.lightBgL : s.darkBgL;
  const bg = oklchToHex({ l: bgL, c: light ? nc : nc * 1.6, h: s.neutralHue });
  const surface = oklchToHex({ l: light ? Math.min(1, bgL + 0.022) : bgL + 0.04, c: light ? nc * 0.5 : nc * 1.8, h: s.neutralHue });
  const surface2 = oklchToHex({ l: light ? bgL - 0.035 : bgL + 0.075, c: light ? nc * 1.4 : nc * 2, h: s.neutralHue });
  const border = oklchToHex({ l: light ? bgL - 0.1 : bgL + 0.14, c: nc * 2, h: s.neutralHue });
  const grounds = [bg, surface, surface2];

  const text = fitContrast({ l: light ? 0.24 : 0.95, c: Math.min(0.03, nc * 2.2), h: s.neutralHue }, grounds, 7).hex;
  const muted = fitContrast({ l: light ? 0.5 : 0.74, c: Math.min(0.03, nc * 2), h: s.neutralHue }, grounds, 4.5).hex;

  // Primary must read as a UI colour on the page (3:1) and carry its own label (4.5:1).
  const p0 = fitContrast({ l: light ? s.primaryL[0] : s.primaryL[1], c: s.chroma, h: s.hue }, [bg, surface], 3).color;
  const primary = textOnFill(p0, 4.5);
  const accent = textOnFill(gamutClip({ l: light ? s.accentL[0] : s.accentL[1], c: s.accentChroma, h: s.accentHue }), 4.5);

  const status = (h: number, c: number) => fitContrast({ l: light ? 0.5 : 0.78, c, h }, grounds, 4.5).hex;
  return {
    bg,
    surface,
    surface2,
    text,
    muted,
    primary: primary.fillHex,
    primaryText: primary.text,
    accent: accent.fillHex,
    accentText: accent.text,
    border,
    success: status(150, 0.15),
    warning: status(70, 0.15),
    danger: status(25, 0.19),
  };
}

// ---- the generator --------------------------------------------------------------------------------------------------

/** Picks a mood from the seed when none is given. */
export const moodFor = (seed: string, mood?: Mood): Mood => mood ?? pick(seededRandom(`${seed}::mood`), MOODS);

export function generateDesignSystem(seed: string, mood?: Mood): DesignSystem {
  const m = moodFor(seed, mood);
  const r = seededRandom(`${seed}::${m}`);
  const recipe = RECIPES[m];

  const hue = round(between(r, 0, 360), 2);
  const accentHue = round((hue + pick(r, recipe.accentOffsets) + between(r, -12, 12) + 720) % 360, 2);
  const chroma = round(between(r, ...recipe.chroma));
  const seeds: Seeds = {
    hue,
    chroma,
    accentHue,
    accentChroma: round(Math.min(0.28, chroma * between(r, 0.8, 1.15))),
    neutralHue: recipe.warmNeutrals ? round(between(r, 55, 85), 2) : hue,
    neutralChroma: round(recipe.neutralChroma * between(r, 0.6, 1.3), 4),
    lightBgL: round(between(r, 0.972, 0.992)),
    darkBgL: round(between(r, 0.14, 0.2)),
    primaryL: [round(between(r, 0.5, 0.62)), round(between(r, 0.7, 0.8))],
    accentL: [round(between(r, 0.62, 0.78)), round(between(r, 0.66, 0.8))],
  };
  const light = buildPalette(seeds, "light");
  const dark = buildPalette(seeds, "dark");

  const pairing = pick(r, pairingsFor(m));
  const ratio = pick(r, recipe.ratio);
  const sizes = {} as Record<ScaleStep, string>;
  SCALE_STEPS.forEach((step, i) => (sizes[step] = `${round((recipe.basePx * ratio ** (i - 2)) / 16)}rem`));
  const heroMax = Math.min(pairing.display.wide ? 4 : 5.75, Math.max(4, (recipe.basePx * ratio ** 7) / 16));

  const radiusStyle = pick(r, recipe.radii);
  const shadowStyle = pick(r, recipe.shadows);
  const textDark = hexToOklch(light.text);

  return {
    id: "ds_" + [hashSeed(`${seed}\u0000${m}`), hashSeed(`${m}\u0000${seed}`)].map((n) => n.toString(16).padStart(8, "0")).join(""), // the product uses sha256 here; the demo has no node:crypto
    seed,
    name: `${hueName(hue)} ${pick(r, MOOD_NOUNS[m])}`,
    mood: m,
    palette: { light, dark },
    shadowRgb: { light: hexToRgbTriple(oklchToHex({ l: Math.min(0.3, textDark.l), c: 0.03, h: textDark.h })), dark: "0 0 0" },
    fonts: { display: pairing.display, body: pairing.body, mono: pairing.mono },
    scale: {
      ratio,
      basePx: recipe.basePx,
      sizes,
      hero: { min: "2.35rem", max: `${round(heroMax, 2)}rem` },
      leading: { tight: pairing.display.category === "serif" ? 1.04 : 0.98, snug: 1.2, body: m === "calm" || m === "luxe" ? 1.7 : 1.6 },
    },
    spacing: { unitPx: 4, steps: [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12].map((v) => `${v}rem`), section: recipe.section },
    radii: { style: radiusStyle, ...RADII[radiusStyle] },
    shadows: { style: shadowStyle, ...SHADOWS[shadowStyle] },
    motion: recipe.motion,
    voice: defaultVoice(m),
    mark: { shape: Math.floor(r() * 6), rotate: Math.round(between(r, -30, 30)) },
  };
}

// ---- default copy voice (voice.ts may replace it with a model's proposal) -------------------------------------------

const VOICES: Record<Mood, Voice> = {
  bold: {
    tone: ["direct", "confident", "high-energy"],
    doSay: ["Lead with the outcome in the first five words", "Use short, active sentences", "Put a real number in every claim we can back"],
    dontSay: ["revolutionary", "game-changing", "best-in-class"],
  },
  calm: {
    tone: ["reassuring", "plain-spoken", "warm"],
    doSay: ["Explain one thing at a time", "Say what happens next", "Prefer everyday words to jargon"],
    dontSay: ["supercharge", "crush it", "disrupt"],
  },
  playful: {
    tone: ["upbeat", "friendly", "a little cheeky"],
    doSay: ["Write like you talk", "Use verbs people can picture", "Keep jokes out of anything about money"],
    dontSay: ["leverage", "synergy", "solutions"],
  },
  luxe: {
    tone: ["assured", "spare", "considered"],
    doSay: ["Say less and let detail carry it", "Name materials, steps and craft", "Keep headlines under eight words"],
    dontSay: ["cheap", "hurry", "unbeatable"],
  },
  technical: {
    tone: ["precise", "candid", "efficient"],
    doSay: ["Show the command, the limit or the latency", "State trade-offs plainly", "Link the docs from every claim"],
    dontSay: ["magic", "seamless", "AI-powered everything"],
  },
};

export const defaultVoice = (mood: Mood): Voice => ({
  tone: [...VOICES[mood].tone],
  doSay: [...VOICES[mood].doSay],
  dontSay: [...VOICES[mood].dontSay, "copy or paraphrase another product's wording"],
});
