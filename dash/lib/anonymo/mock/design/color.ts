// Demo copy of gateway/src/anonymo/ventures/design/color.ts, so demo mode makes looks the way the product does.
// Keep it in step with that file. WS11 · Designer Mo's colour maths (Ventures Overview §2 "Original look", Backend PART 11 "designer").
//
// Palettes are picked in OKLCH, so equal steps in lightness look equal, then converted to sRGB hex here with our own
// OKLab matrices (Björn Ottosson's published coefficients) and chroma-reducing gamut clipping. Contrast is WCAG 2.x
// relative luminance on the final hex, so what the tests check is exactly what a browser paints.

export type Oklch = { l: number; c: number; h: number };
export type Oklab = { l: number; a: number; b: number };
type Rgb = [number, number, number];

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

export function oklchToOklab({ l, c, h }: Oklch): Oklab {
  const rad = (h * Math.PI) / 180;
  return { l, a: c * Math.cos(rad), b: c * Math.sin(rad) };
}

export function oklabToOklch({ l, a, b }: Oklab): Oklch {
  const c = Math.hypot(a, b);
  const h = c < 1e-7 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return { l, c, h };
}

/** OKLab → linear-light sRGB (may fall outside [0, 1] when out of gamut). */
export function oklabToLinearRgb({ l, a, b }: Oklab): Rgb {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

export function linearRgbToOklab([r, g, b]: Rgb): Oklab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

const encode = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const decode = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const EPS = 1e-6;
const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -EPS && v <= 1 + EPS);

const JND = 0.02;
const clipRgb = (rgb: Rgb): Rgb => rgb.map((v) => clamp(v)) as Rgb;
const labDistance = (x: Oklab, y: Oklab) => Math.hypot(x.l - y.l, x.a - y.a, x.b - y.b);

/**
 * CSS Color 4 gamut mapping: keep lightness and hue, binary-search the chroma down until plain channel clipping would
 * move the colour by less than one just-noticeable difference (ΔE OK 0.02). Returns the colour as it will be painted.
 */
export function gamutClip(color: Oklch): Oklch {
  const l = clamp(color.l);
  if (l <= 0 || l >= 1) return { l, c: 0, h: color.h };
  const at = (c: number) => oklchToOklab({ l, c, h: color.h });
  const painted = (lab: Oklab) => oklabToOklch(linearRgbToOklab(clipRgb(oklabToLinearRgb(lab))));
  const origin = at(Math.max(0, color.c));
  const rgb = oklabToLinearRgb(origin);
  if (inGamut(rgb)) return { l, c: Math.max(0, color.c), h: color.h };
  if (labDistance(origin, linearRgbToOklab(clipRgb(rgb))) < JND) return painted(origin);
  let lo = 0;
  let hi = Math.max(0, color.c);
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    const cur = at(mid);
    const curRgb = oklabToLinearRgb(cur);
    if (inGamut(curRgb) || labDistance(cur, linearRgbToOklab(clipRgb(curRgb))) < JND) lo = mid;
    else hi = mid;
  }
  return painted(at(lo));
}

const hex2 = (v: number) => Math.round(clamp(v) * 255).toString(16).padStart(2, "0");

export function oklchToHex(color: Oklch): string {
  const rgb = oklabToLinearRgb(oklchToOklab(gamutClip(color)));
  return "#" + rgb.map((v) => hex2(encode(clamp(v)))).join("");
}

export function hexToLinearRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [decode(((n >> 16) & 255) / 255), decode(((n >> 8) & 255) / 255), decode((n & 255) / 255)];
}

export const hexToOklab = (hex: string): Oklab => linearRgbToOklab(hexToLinearRgb(hex));
export const hexToOklch = (hex: string): Oklch => oklabToOklch(hexToOklab(hex));

/** "r g b" channel triple (0-255) for `rgb(var(--x) / a)`. */
export function hexToRgbTriple(hex: string): string {
  const n = parseInt(hex.replace("#", ""), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/** WCAG 2.x relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToLinearRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Mixes two colours in OKLab, as CSS `color-mix(in oklab, b t, a)` does: t = 0 gives a, t = 1 gives b. */
export function mixHex(a: string, b: string, t: number): string {
  const x = hexToOklab(a);
  const y = hexToOklab(b);
  const lab = { l: x.l + (y.l - x.l) * t, a: x.a + (y.a - x.a) * t, b: x.b + (y.b - x.b) * t };
  return oklchToHex(oklabToOklch(lab));
}

/** Euclidean ΔE in OKLab (≈0.02 is a just-noticeable difference). */
export function deltaEOk(a: string, b: string): number {
  const x = hexToOklab(a);
  const y = hexToOklab(b);
  return Math.hypot(x.l - y.l, x.a - y.a, x.b - y.b);
}

/**
 * Moves the foreground's lightness away from the backgrounds (shedding chroma near the ends) until its contrast against
 * every background reaches `min`. Falls back to pure black or white, the strongest any background allows.
 */
export function fitContrast(fg: Oklch, backgrounds: string[], min: number): { color: Oklch; hex: string } {
  const avgLum = backgrounds.reduce((s, b) => s + luminance(b), 0) / backgrounds.length;
  const dir = avgLum > 0.18 ? -1 : 1;
  let color = gamutClip(fg);
  for (let i = 0; i < 240; i++) {
    const hex = oklchToHex(color);
    if (backgrounds.every((b) => contrastRatio(hex, b) >= min)) return { color, hex };
    const l = clamp(color.l + dir * 0.008);
    color = gamutClip({ l, c: l <= 0.02 || l >= 0.98 ? color.c * 0.7 : color.c, h: color.h });
  }
  const hex = dir < 0 ? "#000000" : "#ffffff";
  return { color: hexToOklch(hex), hex };
}

/** Best readable text for a filled background: a tinted near-white or near-black, else pure, else moves the fill. */
export function textOnFill(fill: Oklch, min: number): { fill: Oklch; fillHex: string; text: string } {
  let f = gamutClip(fill);
  for (let i = 0; i < 120; i++) {
    const fillHex = oklchToHex(f);
    const light = oklchToHex({ l: 0.985, c: Math.min(0.012, f.c), h: f.h });
    const dark = oklchToHex({ l: 0.2, c: Math.min(0.03, f.c * 0.4), h: f.h });
    for (const text of [light, dark, "#ffffff", "#000000"].sort((a, b) => contrastRatio(b, fillHex) - contrastRatio(a, fillHex))) {
      if (contrastRatio(text, fillHex) >= min) return { fill: f, fillHex, text };
    }
    // Neither end works: push the fill towards whichever end it is further from.
    f = gamutClip({ ...f, l: clamp(f.l + (luminance(fillHex) > 0.18 ? 0.01 : -0.01)) });
  }
  const fillHex = oklchToHex(f);
  return { fill: f, fillHex, text: contrastRatio("#ffffff", fillHex) >= contrastRatio("#000000", fillHex) ? "#ffffff" : "#000000" };
}
