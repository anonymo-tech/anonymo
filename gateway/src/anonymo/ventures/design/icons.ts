// WS11 · Designer Mo's icon set (Ventures Overview §2 "Original look"): sixteen 24px line icons drawn for Anonymo
// Ventures, plus the generated brand mark. Inline SVG with currentColor strokes, so pages need no icon font, image
// request or script, and every icon follows the theme.

export const ICONS = {
  bolt: '<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2Z"/>',
  shield: '<path d="M12 3 4.5 6v5.6c0 4.6 3.2 8.4 7.5 9.4 4.3-1 7.5-4.8 7.5-9.4V6L12 3Z"/><path d="m9 12 2 2 4-4"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10.5" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><path d="M12 15v2"/>',
  chart: '<path d="M3.5 20.5h17"/><path d="M6.5 17v-4"/><path d="M11 17V8"/><path d="M15.5 17v-6"/><path d="M20 17V4.5"/>',
  sparkle: '<path d="M12 3.5c.6 4.2 2.3 5.9 6.5 6.5-4.2.6-5.9 2.3-6.5 6.5-.6-4.2-2.3-5.9-6.5-6.5 4.2-.6 5.9-2.3 6.5-6.5Z"/><path d="M19 16.5c.3 1.6.9 2.2 2.5 2.5-1.6.3-2.2.9-2.5 2.5-.3-1.6-.9-2.2-2.5-2.5 1.6-.3 2.2-.9 2.5-2.5Z"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5S9.7 5.9 12 3.5Z"/>',
  layers: '<path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8 12 3.5Z"/><path d="m3.5 12 8.5 4.5 8.5-4.5"/><path d="m3.5 16 8.5 4.5 8.5-4.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  key: '<circle cx="8" cy="15.5" r="4"/><path d="m10.9 12.6 8.6-8.6"/><path d="m16.5 7 2.5 2.5"/><path d="m14.5 9 1.5 1.5"/>',
  users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20c.7-3.4 3.3-5.5 6.5-5.5s5.8 2.1 6.5 5.5"/><path d="M15.5 5.2a3.5 3.5 0 0 1 0 6.6"/><path d="M18 14.8c1.8.8 3 2.6 3.5 5.2"/>',
  code: '<path d="m8 7-5 5 5 5"/><path d="m16 7 5 5-5 5"/><path d="m13.5 4-3 16"/>',
  wallet: '<path d="M4 7.5h14.5a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2H16"/><path d="M16 14h1.5"/>',
  eyeOff: '<path d="m3.5 3.5 17 17"/><path d="M10.3 6.2A9.4 9.4 0 0 1 12 6c5 0 8.5 6 8.5 6a15.6 15.6 0 0 1-2.4 3.1"/><path d="M6.7 7.7C4.6 9.2 3.5 12 3.5 12s3.5 6 8.5 6c1.4 0 2.6-.4 3.7-1"/><path d="M10 10.2a2.5 2.5 0 0 0 3.6 3.5"/>',
  rocket: '<path d="M13.5 15.5 8.5 10.5c1.8-4.4 5.4-7 11-7 0 5.6-2.6 9.2-7 11Z"/><path d="M8.5 10.5H5l2.5-3.5h4"/><path d="M13.5 15.5V19l3.5-2.5v-4"/><path d="M6 15.5c-1.5.8-2 2.4-2 4.5 2.1 0 3.7-.5 4.5-2"/>',
  inbox: '<path d="M3.5 13.5 6 5.5h12l2.5 8V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19v-5.5Z"/><path d="M3.5 13.5h5l1 2.5h5l1-2.5h5"/>',
  heart: '<path d="M12 20s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7.3 4.3 4.3 0 0 1 19.5 10c0 5.6-7.5 10-7.5 10Z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6.5 6.5l11 11"/><path d="M17.5 6.5l-11 11"/>',
  arrowRight: '<path d="M4.5 12h15"/><path d="m13.5 6 6 6-6 6"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.6-5"/>',
} as const;

export type IconName = keyof typeof ICONS;
/** Icons a feature card cycles through when the content names none. */
export const FEATURE_ICONS: IconName[] = ["bolt", "shield", "chart", "sparkle", "layers", "globe", "lock", "clock", "key", "users", "code", "wallet", "eyeOff", "rocket", "inbox", "heart"];

export const isIconName = (s: unknown): s is IconName => typeof s === "string" && Object.prototype.hasOwnProperty.call(ICONS, s);

export function icon(name: IconName, label?: string): string {
  const a11y = label ? `role="img" aria-label="${label.replace(/[&<>"']/g, "")}"` : 'aria-hidden="true"';
  return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${ICONS[name]}</svg>`;
}

const MARKS = [
  '<rect x="2" y="2" width="28" height="28" rx="9" fill="url(#G)"/><circle cx="16" cy="16" r="5.5" style="fill:var(--bg)"/>',
  '<circle cx="12" cy="16" r="9.5" fill="url(#G)"/><circle cx="20" cy="16" r="9.5" fill="url(#G)" opacity=".7"/>',
  '<path d="M16 2.5 29.5 28h-27L16 2.5Z" fill="url(#G)"/><path d="M16 14 22 25H10l6-11Z" style="fill:var(--bg)"/>',
  '<rect x="2" y="2" width="12.5" height="12.5" rx="3.5" fill="url(#G)"/><rect x="17.5" y="2" width="12.5" height="12.5" rx="6.25" fill="url(#G)" opacity=".75"/><rect x="2" y="17.5" width="12.5" height="12.5" rx="6.25" fill="url(#G)" opacity=".75"/><rect x="17.5" y="17.5" width="12.5" height="12.5" rx="3.5" fill="url(#G)"/>',
  '<path d="M3 29V14A11 11 0 0 1 14 3h15v15a11 11 0 0 1-11 11H3Z" fill="url(#G)"/><circle cx="14.5" cy="17.5" r="4" style="fill:var(--bg)"/>',
  '<circle cx="15" cy="17" r="10" fill="none" stroke="url(#G)" stroke-width="5.5"/><circle cx="25" cy="7" r="4.5" fill="url(#G)"/>',
];

/** The venture's generated logo glyph, filled with its own primary→accent gradient. */
export function brandMark(mark: { shape: number; rotate: number }, uid: string): string {
  const id = `g-${uid.replace(/[^a-z0-9_-]/gi, "")}`;
  const body = MARKS[((mark.shape % MARKS.length) + MARKS.length) % MARKS.length].replace(/url\(#G\)/g, `url(#${id})`);
  return `<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--primary)"/><stop offset="1" style="stop-color:var(--accent)"/></linearGradient></defs><g transform="rotate(${mark.rotate} 16 16)">${body}</g></svg>`;
}
