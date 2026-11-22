// WS11 · Designer Mo's uniqueness check vs the gallery (Backend PART 11 "designer: ... uniqueness check vs gallery").
//
// Every venture gets its own look. designDistance scores how far apart two systems look: OKLab ΔE across the roles a
// visitor notices first (fills, page and text, both themes), plus the font pair and the corner and shadow styles.
// ensureUnique re-seeds deterministically (seed#1, seed#2, ...) until the system sits at least `min` from every
// gallery entry, within a bounded number of attempts.
//
// The distance alone can pass a look that reads as the same brand: two runs of one idea once came out as two teals at
// distance 18.6, layout and type equal, only the shade apart. So the main colour must also land in a different hue
// family (HUE_FAMILY_GAP degrees of OKLCH hue) from each of the most recent looks. Hue is free across the circle in
// every mood, and the recent looks block at most RECENT_LOOKS * 2 * HUE_FAMILY_GAP degrees, so there is always room.

import { deltaEOk, hexToOklch } from "./color.ts";
import { generateDesignSystem, type DesignSystem, type PaletteRole } from "./tokens.ts";

/** Roles compared, with how much each one shapes the overall impression. */
const ROLE_WEIGHTS: [PaletteRole, number][] = [
  ["primary", 3],
  ["accent", 2],
  ["bg", 1],
  ["surface", 0.5],
  ["text", 0.5],
];

export const DEFAULT_MIN_DISTANCE = 18;
/** Degrees of OKLCH hue between the main colours of a new look and each recent one. */
export const HUE_FAMILY_GAP = 40;
/** How many of the most recent looks the hue rule is checked against. */
export const RECENT_LOOKS = 3;
/** Below this chroma a colour reads as a grey and has no hue family. */
const GREY_CHROMA = 0.03;

/** Degrees between two systems' main (light-theme primary) colours: 0 for the same family, up to 180. Two greys count
 *  as the same family; a grey and a colour as far apart. */
export function hueGap(a: DesignSystem, b: DesignSystem): number {
  const x = hexToOklch(a.palette.light.primary);
  const y = hexToOklch(b.palette.light.primary);
  const greyX = x.c < GREY_CHROMA;
  const greyY = y.c < GREY_CHROMA;
  if (greyX || greyY) return greyX && greyY ? 0 : 180;
  const d = Math.abs(x.h - y.h) % 360;
  return Math.round((d > 180 ? 360 - d : d) * 100) / 100;
}

/** The smallest hue gap to any of the recent looks (Infinity when there are none). */
export const nearestHueGap = (ds: DesignSystem, recent: DesignSystem[]) => recent.reduce((m, g) => Math.min(m, hueGap(ds, g)), Infinity);

/** 0 for identical systems; ~10 is "similar", 18+ reads as a different brand. */
export function designDistance(a: DesignSystem, b: DesignSystem): number {
  let sum = 0;
  let weight = 0;
  for (const theme of ["light", "dark"] as const) {
    for (const [role, w] of ROLE_WEIGHTS) {
      sum += w * deltaEOk(a.palette[theme][role], b.palette[theme][role]);
      weight += w;
    }
  }
  const colour = (100 * sum) / weight;
  const fonts = (a.fonts.display.family === b.fonts.display.family ? 0 : 8) + (a.fonts.body.family === b.fonts.body.family ? 0 : 3);
  const shape = (a.radii.style === b.radii.style ? 0 : 4) + (a.shadows.style === b.shadows.style ? 0 : 3);
  return Math.round((colour + fonts + shape) * 100) / 100;
}

export type UniqueResult = { system: DesignSystem; attempts: number; distance: number; hueGap: number; unique: boolean };

/** Distance to the nearest gallery entry (Infinity for an empty gallery). */
export const nearestDistance = (ds: DesignSystem, gallery: DesignSystem[]) => gallery.reduce((m, g) => Math.min(m, designDistance(ds, g)), Infinity);

/**
 * Re-seeds until the system is at least `min` from every gallery entry and its main colour is in a different hue family
 * from each of `recent` (by default the first RECENT_LOOKS of the gallery: callers list the gallery newest first).
 * `attempts` counts re-seeds (0 when the first system already qualified). When the bound runs out the best candidate
 * is returned with unique: false: one that keeps the hue rule if any did, then the most distant.
 */
export function ensureUnique(ds: DesignSystem, gallery: DesignSystem[], min = DEFAULT_MIN_DISTANCE, maxAttempts = 32, recent: DesignSystem[] = gallery.slice(0, RECENT_LOOKS)): UniqueResult {
  const base = ds.seed.replace(/#\d+$/, "");
  const judge = (system: DesignSystem, attempts: number): UniqueResult => {
    const distance = nearestDistance(system, gallery);
    const gap = nearestHueGap(system, recent);
    return { system, attempts, distance, hueGap: gap, unique: distance >= min && gap >= HUE_FAMILY_GAP };
  };
  const better = (a: UniqueResult, b: UniqueResult) => {
    const hueA = a.hueGap >= HUE_FAMILY_GAP;
    const hueB = b.hueGap >= HUE_FAMILY_GAP;
    return hueA !== hueB ? hueA : a.distance > b.distance;
  };
  let best = judge(ds, 0);
  if (best.unique) return best;
  for (let n = 1; n <= maxAttempts; n++) {
    const candidate = judge(generateDesignSystem(`${base}#${n}`, ds.mood), n);
    if (candidate.unique) return candidate;
    if (better(candidate, best)) best = candidate;
  }
  return { ...best, unique: false, attempts: maxAttempts };
}
