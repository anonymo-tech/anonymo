import { describe, expect, test } from "bun:test";
import { contrastRatio, deltaEOk, gamutClip, hexToOklch, mixHex, oklchToHex } from "../../src/anonymo/ventures/design/color.ts";
import { derivedColours, googleFontsUrl, toCss } from "../../src/anonymo/ventures/design/css.ts";
import { PAIRINGS } from "../../src/anonymo/ventures/design/fonts.ts";
import { generateDesignSystem, MOODS, PALETTE_ROLES, type Mood } from "../../src/anonymo/ventures/design/tokens.ts";
import { DEFAULT_MIN_DISTANCE, HUE_FAMILY_GAP, RECENT_LOOKS, designDistance, ensureUnique, hueGap } from "../../src/anonymo/ventures/design/uniqueness.ts";

// Designer Mo's tokens (Ventures Overview §2, Backend PART 11): deterministic systems, OKLCH colour maths, WCAG
// contrast in both themes for every seed, and the uniqueness re-seed against the gallery.

const HEX = /^#[0-9a-f]{6}$/;

describe("OKLCH → sRGB", () => {
  test("known reference colours convert exactly", () => {
    expect(oklchToHex({ l: 0.6279554, c: 0.2576833, h: 29.2338852 })).toBe("#ff0000");
    expect(oklchToHex({ l: 0.8664396, c: 0.2948272, h: 142.4953389 })).toBe("#00ff00");
    expect(oklchToHex({ l: 0.4520137, c: 0.3132144, h: 264.0520206 })).toBe("#0000ff");
    expect(oklchToHex({ l: 1, c: 0, h: 0 })).toBe("#ffffff");
    expect(oklchToHex({ l: 0, c: 0, h: 0 })).toBe("#000000");
    expect(oklchToHex({ l: 0.5998708, c: 0, h: 0 })).toBe("#808080");
  });

  test("hex → OKLCH matches the published values and round-trips", () => {
    const red = hexToOklch("#ff0000");
    expect(red.l).toBeCloseTo(0.62796, 4);
    expect(red.c).toBeCloseTo(0.25768, 4);
    expect(red.h).toBeCloseTo(29.2339, 2);
    for (const hex of ["#336699", "#f0e6d2", "#0a0a0a", "#c0ffee", "#7b2d8e"]) expect(oklchToHex(hexToOklch(hex))).toBe(hex);
  });

  test("out-of-gamut colours are clipped by chroma, keeping lightness and hue", () => {
    const wild = { l: 0.7, c: 0.4, h: 150 };
    const clipped = gamutClip(wild);
    expect(clipped.c).toBeLessThan(0.4);
    const back = hexToOklch(oklchToHex(wild));
    expect(Math.abs(back.l - 0.7)).toBeLessThan(0.02);
    expect(Math.abs(back.h - 150)).toBeLessThan(4);
    expect(oklchToHex({ l: 1.4, c: 0.3, h: 20 })).toBe("#ffffff");
  });

  test("contrast ratio and ΔE behave", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
    expect(deltaEOk("#123456", "#123456")).toBe(0);
    expect(mixHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixHex("#000000", "#ffffff", 1)).toBe("#ffffff");
  });
});

describe("generateDesignSystem", () => {
  test("is deterministic: same seed and mood give the same system", () => {
    const a = generateDesignSystem("venture-alpha", "bold");
    const b = generateDesignSystem("venture-alpha", "bold");
    expect(a).toEqual(b);
    expect(toCss(a)).toBe(toCss(b));
    expect(generateDesignSystem("venture-alpha")).toEqual(generateDesignSystem("venture-alpha"));
    expect(generateDesignSystem("venture-beta", "bold").palette).not.toEqual(a.palette);
    expect(a.id).toMatch(/^ds_[0-9a-f]{16}$/);
  });

  test("every font is an OFL-1.1 Google family and the stylesheet URL asks only for listed weights", () => {
    for (const p of PAIRINGS) for (const f of [p.display, p.body, p.mono]) expect(f.licence).toBe("OFL-1.1");
    const ds = generateDesignSystem("fonts", "luxe");
    const url = googleFontsUrl(ds);
    expect(url.startsWith("https://fonts.googleapis.com/css2?")).toBe(true);
    expect(url).toContain(`family=${ds.fonts.body.family.replace(/ /g, "+")}:wght@400;500;600`);
    expect(url.endsWith("&display=swap")).toBe(true);
    for (const m of MOODS) expect(PAIRINGS.some((p) => p.moods.includes(m))).toBe(true);
  });

  test("property: WCAG contrast holds over 300 seeds in both themes", () => {
    const failures: string[] = [];
    const moods: (Mood | undefined)[] = [...MOODS, undefined];
    for (let i = 0; i < 300; i++) {
      const ds = generateDesignSystem(`prop-seed-${i}-${(i * 7919) % 1013}`, moods[i % moods.length]);
      for (const theme of ["light", "dark"] as const) {
        const p = ds.palette[theme];
        for (const role of PALETTE_ROLES) if (!HEX.test(p[role])) failures.push(`${ds.seed} ${theme} ${role} ${p[role]}`);
        const check = (label: string, fg: string, bg: string, min: number) => {
          const r = contrastRatio(fg, bg);
          if (r < min) failures.push(`${ds.seed} ${theme} ${label} ${r.toFixed(2)} < ${min}`);
        };
        check("text/bg", p.text, p.bg, 7);
        check("text/surface", p.text, p.surface, 7);
        check("text/surface2", p.text, p.surface2, 7);
        check("muted/bg", p.muted, p.bg, 4.5);
        check("muted/surface", p.muted, p.surface, 4.5);
        check("primaryText/primary", p.primaryText, p.primary, 4.5);
        check("accentText/accent", p.accentText, p.accent, 4.5);
        check("primary/bg", p.primary, p.bg, 3);
        for (const s of ["success", "warning", "danger"] as const) check(`${s}/bg`, p[s], p.bg, 4.5);
        const d = derivedColours(p);
        check("primaryInk/primarySoft", d.primaryInk, d.primarySoft, 4.5);
        check("successInk/successSoft", d.successInk, d.successSoft, 4.5);
        check("dangerInk/primaryWash", d.dangerInk, d.primaryWash, 4.5);
      }
    }
    expect(failures).toEqual([]);
  });

  test("light themes are light and dark themes are dark", () => {
    for (let i = 0; i < 40; i++) {
      const ds = generateDesignSystem(`theme-${i}`);
      expect(hexToOklch(ds.palette.light.bg).l).toBeGreaterThan(0.9);
      expect(hexToOklch(ds.palette.dark.bg).l).toBeLessThan(0.25);
    }
  });
});

describe("uniqueness vs gallery", () => {
  test("distance is zero to itself and positive to another system", () => {
    const a = generateDesignSystem("same", "calm");
    expect(designDistance(a, a)).toBe(0);
    expect(designDistance(a, generateDesignSystem("other", "bold"))).toBeGreaterThan(0);
  });

  test("a system already in the gallery is re-seeded deterministically until far enough", () => {
    const ds = generateDesignSystem("crowded", "technical");
    const r = ensureUnique(ds, [ds]);
    expect(r.attempts).toBeGreaterThanOrEqual(1);
    expect(r.unique).toBe(true);
    expect(r.distance).toBeGreaterThanOrEqual(DEFAULT_MIN_DISTANCE);
    expect(r.system.seed).toBe(`crowded#${r.attempts}`);
    expect(r.system.mood).toBe("technical");
    expect(ensureUnique(ds, [ds])).toEqual(r);
  });

  test("clears a whole gallery of same-mood systems, and reports zero attempts when already unique", () => {
    const gallery = Array.from({ length: 10 }, (_, i) => generateDesignSystem(`gallery-${i}`, "playful"));
    const r = ensureUnique(generateDesignSystem("newcomer", "playful"), gallery, 15);
    expect(r.unique).toBe(true);
    for (const g of gallery) expect(designDistance(r.system, g)).toBeGreaterThanOrEqual(15);
    const lone = generateDesignSystem("lonely", "luxe");
    expect(ensureUnique(lone, [])).toMatchObject({ attempts: 0, unique: true, system: lone });
  });

  test("hue gap: zero to itself, measured the short way round the circle", () => {
    const a = generateDesignSystem("hue-a", "calm");
    expect(hueGap(a, a)).toBe(0);
    const b = generateDesignSystem("hue-b", "bold");
    expect(hueGap(a, b)).toBeGreaterThanOrEqual(0);
    expect(hueGap(a, b)).toBeLessThanOrEqual(180);
    expect(hueGap(a, b)).toBe(hueGap(b, a));
  });

  test("the same idea run again and again: every new look is in a new hue family from the latest looks", () => {
    // A run's look is seeded by its own id; the brief's mood is the same every time (the two-teals case). The hue rule
    // holds for every look, even once the gallery is so full of one mood that the distance bound runs out (the
    // fallback prefers a candidate that keeps the hue rule); while the gallery is small both rules hold.
    const made: ReturnType<typeof generateDesignSystem>[] = [];
    for (let i = 0; i < 24; i++) {
      const gallery = [...made].reverse(); // newest first, as the designer step reads it
      const r = ensureUnique(generateDesignSystem(`v_same_idea_${i}`, "calm"), gallery);
      for (const g of gallery.slice(0, RECENT_LOOKS)) expect(hueGap(r.system, g)).toBeGreaterThanOrEqual(HUE_FAMILY_GAP);
      if (i < 8) {
        expect(r.unique).toBe(true);
        for (const g of gallery) expect(designDistance(r.system, g)).toBeGreaterThanOrEqual(DEFAULT_MIN_DISTANCE);
      }
      made.push(r.system);
    }
  });

  test("a look that is far enough but in the same hue family as a recent one is re-seeded", () => {
    // Find a pair the distance rule alone would pass but the hue rule rejects, then check ensureUnique moves on.
    let pair: [ReturnType<typeof generateDesignSystem>, ReturnType<typeof generateDesignSystem>] | null = null;
    for (let i = 0; i < 400 && !pair; i++) {
      const a = generateDesignSystem(`near-a-${i}`, "calm");
      for (let j = 0; j < 40 && !pair; j++) {
        const b = generateDesignSystem(`near-b-${i}-${j}`, "calm");
        if (designDistance(a, b) >= DEFAULT_MIN_DISTANCE && hueGap(a, b) < HUE_FAMILY_GAP) pair = [a, b];
      }
    }
    expect(pair).not.toBeNull();
    const [earlier, candidate] = pair!;
    const r = ensureUnique(candidate, [earlier]);
    expect(r.attempts).toBeGreaterThanOrEqual(1);
    expect(r.unique).toBe(true);
    expect(r.hueGap).toBeGreaterThanOrEqual(HUE_FAMILY_GAP);
  });

  test("an impossible minimum stops at the bound and says so", () => {
    const ds = generateDesignSystem("bounded", "calm");
    const r = ensureUnique(ds, [ds], 10_000, 5);
    expect(r.unique).toBe(false);
    expect(r.attempts).toBe(5);
  });
});
