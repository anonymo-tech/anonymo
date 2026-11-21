// Demo copy of gateway/src/anonymo/ventures/design/uniqueness.ts, so demo mode makes looks the way the product does.
// Keep it in step with that file. WS11 · Designer Mo's uniqueness check vs the gallery (Backend PART 11 "designer: ... uniqueness check vs gallery").
//
// Every venture gets its own look. designDistance scores how far apart two systems look: OKLab ΔE across the roles a
// visitor notices first (fills, page and text, both themes), plus the font pair and the corner and shadow styles.
// ensureUnique re-seeds deterministically (seed#1, seed#2, ...) until the system sits at least `min` from every
// gallery entry, within a bounded number of attempts.

import { deltaEOk } from "./color.ts";
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

export type UniqueResult = { system: DesignSystem; attempts: number; distance: number; unique: boolean };

/** Distance to the nearest gallery entry (Infinity for an empty gallery). */
export const nearestDistance = (ds: DesignSystem, gallery: DesignSystem[]) => gallery.reduce((m, g) => Math.min(m, designDistance(ds, g)), Infinity);

/**
 * Re-seeds until the system is at least `min` from every gallery entry. `attempts` counts re-seeds (0 when the first
 * system already qualified). When the bound runs out the most distant candidate is returned with unique: false.
 */
export function ensureUnique(ds: DesignSystem, gallery: DesignSystem[], min = DEFAULT_MIN_DISTANCE, maxAttempts = 32): UniqueResult {
  const base = ds.seed.replace(/#\d+$/, "");
  let best: UniqueResult = { system: ds, attempts: 0, distance: nearestDistance(ds, gallery), unique: false };
  if (best.distance >= min) return { ...best, unique: true };
  for (let n = 1; n <= maxAttempts; n++) {
    const candidate = generateDesignSystem(`${base}#${n}`, ds.mood);
    const distance = nearestDistance(candidate, gallery);
    if (distance >= min) return { system: candidate, attempts: n, distance, unique: true };
    if (distance > best.distance) best = { system: candidate, attempts: n, distance, unique: false };
  }
  return { ...best, attempts: maxAttempts };
}
