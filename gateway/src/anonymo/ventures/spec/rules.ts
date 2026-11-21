// WS11 · Spec Filter rules (Ventures Backend spec, PART 4 "Spec Filter (the firewall)" and Law 4).
//
// The filter keeps function and drops expression. These rules decide, per string, whether it may enter the Spec:
// natural-language copy longer than 8 words, CSS values, class names, colours, fonts, asset URLs (images, icons, logos),
// legal text and code are all refused. Identifiers (field names, path patterns, extensions) have their own shape rules.

export const MAX_LABEL_WORDS = 8;

export const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

const COLOUR = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|oklch|lab|lch)\s*\(/i;
const CSS_VALUE = /\b\d+(\.\d+)?(px|rem|em|vh|vw|pt|ms)\b|!important|\b(font-family|font-size|font-weight|line-height|background(-color)?|border(-radius)?|margin|padding|z-index|display|flex|grid-template)\s*:/i;
const CSS_RULE = /[.#][a-z_][\w-]*\s*\{|[a-z-]+\s*:\s*[^;{}]+;|@media|@font-face|@import|var\(--/i;
const CLASS_NAME = /\b[a-z]+(?:-[a-z0-9]+){2,}\b|\b[a-z]+__[a-z0-9-]+\b|\bclass(Name)?\s*=|\b(btn|col|row|flex|grid|text|bg|px|py|mt|mb)-[a-z0-9-]+\b/;
const FONT = /^(inter|roboto|helvetica( neue)?|arial|open sans|lato|montserrat|georgia|times new roman|sf pro( display| text)?|poppins|source sans( pro)?|noto sans|ibm plex( sans| mono)?|menlo|monaco|consolas|system-ui|sans-serif|serif|monospace)$/i;
const ASSET = /[\w-]\.(png|jpe?g|gif|svg|webp|ico|avif|bmp|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|wav)\b|\/[\w./-]+\.(css|js|mjs|map)\b|https?:\/\/|\bdata:[a-z]+\/|\bwww\.[a-z0-9-]+\./i;
const BRANDING = /\b(logo|logos|logotype|icon|icons|favicon|wordmark|brand ?mark|mascot)\b/i;
const LEGAL = /©|\(c\)\s*\d{4}|\bcopyright\b|all rights reserved|\bterms (of|and) (service|use|conditions)\b|\bprivacy (policy|notice)\b|\btrademarks?\b|®|™|\blicensed under\b|\bcookie (policy|notice|settings)\b|\bgdpr\b|\bliabilit(y|ies)\b|\bindemnif|\bwarrant(y|ies)\b|\bgoverning law\b|\bvat\b.*\bexcl|\bexclud\w* (vat|tax)/i;
const CODE = new RegExp(
  [
    /=>|===|!==|&&|\|\||[;{}]|\$\{|\/\*|\*\/|^\s*\/\//.source,
    /\b(const|let|var)\s+[\w$]+\s*=/.source,
    /\bfunction\s*[\w$]*\s*\(/.source,
    /\breturn\s+[\w$.]+\s*[;(.]/.source,
    /\bimport\s+[\w{*][^]*\bfrom\b|\bimport\s*\(/.source,
    /\bexport\s+(default|const|function|class)\b/.source,
    /\bclass\s+[A-Z]\w*\s*(\{|extends)/.source,
    /\bnew\s+[A-Z]\w*\s*\(/.source,
    /\b(typeof|await)\s+[\w$]+\s*[.(]/.source,
    /\b[A-Za-z_$][\w$]*\s*\([^)]*\)\s*[.;{]/.source,
    /\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/.source,
    /<\/?[a-z][\w-]*[\s>/]/.source,
  ].join("|"),
);

export type RuleHit = "copy-length" | "css" | "colour" | "class-name" | "font" | "asset-url" | "branding" | "legal" | "code" | "empty";

/** The first rule a label breaks, or null when it may be kept. */
export function labelViolation(s: string, maxWords = MAX_LABEL_WORDS): RuleHit | null {
  const t = s.trim();
  if (!t || !/\p{L}|\d/u.test(t)) return "empty";
  if (wordCount(t) > maxWords) return "copy-length";
  if (COLOUR.test(t)) return "colour";
  if (CSS_VALUE.test(t) || CSS_RULE.test(t)) return "css";
  if (FONT.test(t)) return "font";
  if (ASSET.test(t)) return "asset-url";
  if (BRANDING.test(t)) return "branding";
  if (LEGAL.test(t)) return "legal";
  if (CODE.test(t)) return "code";
  if (CLASS_NAME.test(t)) return "class-name";
  return null;
}

/** Normalises a label (entities already decoded) and applies the rules; null when it must be dropped. */
export function cleanLabel(s: string | null | undefined, maxWords = MAX_LABEL_WORDS): string | null {
  if (typeof s !== "string") return null;
  const t = s
    .replace(/[​-‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—•·|:>*✓✔→]+|[\s\-–—•·|:,>*→]+$/g, "")
    .trim();
  if (t.length > 120) return null;
  return labelViolation(t, maxWords) ? null : t;
}

/** Field and column names: identifier-like, or a short spaced column title ("Invoice Number"). */
export const IDENTIFIER = /^[A-Za-z_$][\w$.-]{0,63}$/;
export const COLUMN = /^[A-Za-z][\w .()/-]{0,40}$/;
/** `/api/v1/invoices/:id`: path segments only, no host, query, ids or code. */
export const PATH_PATTERN = /^\/(?:[A-Za-z0-9._~-]+|:id)?(?:\/(?:[A-Za-z0-9._~-]+|:id))*\/?$/;
export const HTTP_METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const isIdentifier = (s: string) => IDENTIFIER.test(s) && !COLOUR.test(s);
export const isColumn = (s: string) => COLUMN.test(s) && wordCount(s) <= 6 && !COLOUR.test(s) && !ASSET.test(s);

/** Plan names kept as-is because they are generic words; anything else becomes "Tier N". */
export const GENERIC_PLAN_NAMES = new Set([
  "free", "starter", "basic", "standard", "plus", "pro", "premium", "team", "teams", "business", "enterprise", "personal", "individual",
  "growth", "scale", "unlimited", "hobby", "advanced", "professional", "essentials", "lite", "max", "ultimate", "custom", "startup",
]);

export const isGenericPlanName = (name: string) => GENERIC_PLAN_NAMES.has(name.trim().toLowerCase());

/** Removes a brand word (the target's own name) from a label; null when nothing functional is left. */
export function stripBrand(label: string, brands: string[]): string | null {
  let t = label;
  for (const b of brands) {
    if (!b) continue;
    const re = new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(['’]s)?\\b`, "gi");
    if (re.test(t)) return null;
  }
  t = t.trim();
  return t || null;
}
