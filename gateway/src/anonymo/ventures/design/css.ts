// WS11 · Designer Mo's stylesheet (Ventures Overview §2 "palette, type, components, copy voice"; Backend PART 11
// "designer: Design-system generator (tokens, components, copy voice)").
//
// toCss turns a DesignSystem into one self-contained stylesheet: custom properties for light and dark (following
// prefers-color-scheme unless a [data-theme] overrides it, and scoped [data-theme] panes for side-by-side previews),
// base styles, and the component library every venture page is built from. Tints are mixed here in OKLab and the
// text colours that sit on them are re-checked for contrast, so no component falls below WCAG AA. Written from the
// generated tokens only; it never reads or imitates anyone else's CSS.

import { fitContrast, hexToOklch, mixHex } from "./color.ts";
import { fontStack } from "./fonts.ts";
import { SCALE_STEPS, type DesignSystem, type Palette, type ThemeName } from "./tokens.ts";

/** Derived tints and the readable "ink" versions of the brand and status colours on them. */
export function derivedColours(p: Palette) {
  const primarySoft = mixHex(p.bg, p.primary, 0.12);
  const accentSoft = mixHex(p.bg, p.accent, 0.14);
  const primaryWash = mixHex(p.surface, p.primary, 0.06);
  const soft = { success: mixHex(p.bg, p.success, 0.12), warning: mixHex(p.bg, p.warning, 0.14), danger: mixHex(p.bg, p.danger, 0.12) };
  const grounds = [p.bg, p.surface, p.surface2, primaryWash];
  const ink = (hex: string, extra: string[] = []) => fitContrast(hexToOklch(hex), [...grounds, ...extra], 4.5).hex;
  return {
    primarySoft,
    accentSoft,
    primaryWash,
    primaryInk: ink(p.primary, [primarySoft]),
    accentInk: ink(p.accent, [accentSoft]),
    successSoft: soft.success,
    warningSoft: soft.warning,
    dangerSoft: soft.danger,
    successInk: ink(p.success, [soft.success]),
    warningInk: ink(p.warning, [soft.warning]),
    dangerInk: ink(p.danger, [soft.danger]),
  };
}

const kebab = (s: string) => s.replace(/[A-Z0-9]+/g, (m) => "-" + m.toLowerCase());

export function themeVars(ds: DesignSystem, theme: ThemeName): string {
  const p = ds.palette[theme];
  const d = derivedColours(p);
  const lines = [...Object.entries(p), ...Object.entries(d)].map(([k, v]) => `--${kebab(k)}:${v};`);
  lines.push(`--shadow-rgb:${ds.shadowRgb[theme]};`, `--ring:${mixHex(p.bg, p.primary, 0.45)};`, `--grain-opacity:${theme === "light" ? 0.05 : 0.08};`, `color-scheme:${theme};`);
  return lines.join("");
}

function staticVars(ds: DesignSystem): string {
  const f = ds.fonts;
  const out = [
    `--font-display:${fontStack(f.display)};`,
    `--font-body:${fontStack(f.body)};`,
    `--font-mono:${fontStack(f.mono)};`,
    `--display-weight:${f.display.weight};`,
    `--display-tracking:${f.display.tracking};`,
    ...SCALE_STEPS.map((s) => `--size-${s}:${ds.scale.sizes[s]};`),
    `--hero-min:${ds.scale.hero.min};--hero-max:${ds.scale.hero.max};`,
    `--leading-tight:${ds.scale.leading.tight};--leading-snug:${ds.scale.leading.snug};--leading-body:${ds.scale.leading.body};`,
    ...ds.spacing.steps.map((v, i) => `--space-${i + 1}:${v};`),
    `--section:${ds.spacing.section};--gutter:clamp(16px, 4vw, 40px);--maxw:1160px;`,
    `--radius-sm:${ds.radii.sm};--radius-md:${ds.radii.md};--radius-lg:${ds.radii.lg};--radius-xl:${ds.radii.xl};--radius-button:${ds.radii.button};`,
    `--shadow-sm:${ds.shadows.sm};--shadow-md:${ds.shadows.md};--shadow-lg:${ds.shadows.lg};`,
    `--dur-fast:${ds.motion.fastMs}ms;--dur-base:${ds.motion.baseMs}ms;--dur-slow:${ds.motion.slowMs}ms;--ease:${ds.motion.easing};--ease-emph:${ds.motion.emphasized};`,
  ];
  return out.join("");
}

/** Film grain as an inline SVG turbulence filter, so the page needs no image requests. */
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 1 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

const BASE = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%;scroll-behavior:smooth;scroll-padding-top:80px}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font-family:var(--font-body);font-size:var(--size-base);line-height:var(--leading-body);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;overflow-x:clip;position:relative;isolation:isolate}
body::before{content:"";position:absolute;z-index:-2;inset:0 0 auto 0;height:min(1100px,140vh);pointer-events:none;background:radial-gradient(42% 46% at 12% 8%,color-mix(in oklab,var(--primary) 28%,transparent),transparent 72%),radial-gradient(36% 40% at 88% 4%,color-mix(in oklab,var(--accent) 26%,transparent),transparent 70%),radial-gradient(48% 36% at 62% 46%,color-mix(in oklab,var(--primary) 12%,transparent),transparent 72%),linear-gradient(180deg,transparent 60%,var(--bg));filter:saturate(1.1)}
body::after{content:"";position:fixed;z-index:-1;inset:0;pointer-events:none;background-image:${GRAIN};background-size:180px;opacity:var(--grain-opacity);mix-blend-mode:overlay}
img,svg,video{display:block;max-width:100%}
h1,h2,h3,h4{margin:0;font-family:var(--font-display);font-weight:var(--display-weight);letter-spacing:var(--display-tracking);line-height:var(--leading-snug);text-wrap:balance;overflow-wrap:break-word;hyphens:auto}
p{margin:0;text-wrap:pretty}
a{color:inherit;text-decoration-color:color-mix(in oklab,var(--primary) 55%,transparent);text-underline-offset:.22em;text-decoration-thickness:1px}
a:hover{text-decoration-color:var(--primary)}
:focus-visible{outline:2px solid var(--primary-ink);outline-offset:3px;border-radius:var(--radius-sm)}
::selection{background:var(--ring);color:var(--text)}
code,kbd,pre,.mono{font-family:var(--font-mono);font-size:.92em}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.skip-link{position:absolute;left:12px;top:-60px;z-index:100;padding:.6rem 1rem;border-radius:var(--radius-md);background:var(--primary);color:var(--primary-text)}
.skip-link:focus{top:12px}
.container{width:min(100% - 2 * var(--gutter),var(--maxw));margin-inline:auto}
.section{padding-block:var(--section)}
.section-head{display:grid;gap:var(--space-4);max-width:46rem;margin-bottom:clamp(2rem,5vw,3.5rem)}
.section-head.center{margin-inline:auto;text-align:center;justify-items:center}
.eyebrow{display:inline-flex;align-items:center;gap:.55rem;font-family:var(--font-mono);font-size:var(--size-xs);font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--primary-ink)}
.eyebrow::before{content:"";width:18px;height:1px;background:currentColor}
.h2{font-size:clamp(var(--size-xl),1rem + 2.6vw,min(var(--size-4xl),3.25rem));line-height:var(--leading-snug)}
.lead{font-size:clamp(var(--size-base),.92rem + .5vw,var(--size-lg));color:var(--muted);max-width:40rem}
.muted{color:var(--muted)}
`;

const BUTTONS = `
.btn{--btn-bg:transparent;--btn-fg:var(--text);--btn-bd:transparent;display:inline-flex;align-items:center;justify-content:center;gap:.55em;min-height:44px;max-width:100%;padding:.72em 1.3em;border:1px solid var(--btn-bd);border-radius:var(--radius-button);background:var(--btn-bg);color:var(--btn-fg);font:600 var(--size-sm)/1.15 var(--font-body);letter-spacing:.005em;text-align:center;text-decoration:none;cursor:pointer;transition:transform var(--dur-fast) var(--ease),box-shadow var(--dur-base) var(--ease),background-color var(--dur-base) var(--ease),border-color var(--dur-base) var(--ease)}
.btn:hover{transform:translateY(-1px)}
.btn:active{transform:translateY(0) scale(.98)}
.btn svg{width:1.1em;height:1.1em;flex:none;transition:transform var(--dur-base) var(--ease)}
.btn:hover svg{transform:translateX(3px)}
.btn-primary{--btn-bg:var(--primary);--btn-fg:var(--primary-text);box-shadow:var(--shadow-md),inset 0 1px 0 rgb(255 255 255 / .2)}
.btn-primary:hover{box-shadow:var(--shadow-lg),inset 0 1px 0 rgb(255 255 255 / .2)}
.btn-secondary{--btn-bg:var(--surface);--btn-bd:var(--border);box-shadow:var(--shadow-sm)}
.btn-secondary:hover{--btn-bd:var(--primary)}
.btn-ghost{--btn-fg:var(--text)}
.btn-ghost:hover{--btn-bg:var(--surface-2)}
.btn-accent{--btn-bg:var(--accent);--btn-fg:var(--accent-text)}
.btn-inverse{--btn-bg:var(--primary-text);--btn-fg:var(--primary);box-shadow:0 10px 30px -12px rgb(0 0 0 / .35)}
.btn-lg{min-height:52px;padding:.95em 1.65em;font-size:var(--size-base)}
.btn-sm{min-height:36px;padding:.5em .95em;font-size:var(--size-xs)}
.badge{display:inline-flex;align-items:center;gap:.35em;padding:.3em .7em;border:1px solid var(--border);border-radius:999px;background:var(--surface-2);color:var(--text);font:600 var(--size-xs)/1.2 var(--font-body);letter-spacing:.01em;white-space:nowrap}
.badge-primary{background:var(--primary);color:var(--primary-text);border-color:transparent}
.badge-accent{background:var(--accent);color:var(--accent-text);border-color:transparent}
.badge-soft{background:var(--primary-soft);color:var(--primary-ink);border-color:transparent}
.badge-success{background:var(--success-soft);color:var(--success-ink);border-color:transparent}
.badge-warning{background:var(--warning-soft);color:var(--warning-ink);border-color:transparent}
.badge-danger{background:var(--danger-soft);color:var(--danger-ink);border-color:transparent}
.pill{display:inline-flex;align-items:center;gap:.6rem;max-width:100%;padding:.3rem .85rem .3rem .3rem;border:1px solid var(--border);border-radius:999px;background:color-mix(in oklab,var(--surface) 82%,transparent);box-shadow:var(--shadow-sm);font-size:var(--size-sm);color:var(--muted);backdrop-filter:blur(8px)}
.pill span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;

const FORMS = `
.field{display:grid;gap:.45rem}
.label{font-size:var(--size-sm);font-weight:600}
.hint{font-size:var(--size-xs);color:var(--muted)}
.input{width:100%;min-height:44px;padding:.72em .95em;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface);color:var(--text);font:inherit;font-size:var(--size-sm);transition:border-color var(--dur-fast) var(--ease),box-shadow var(--dur-base) var(--ease)}
.input::placeholder{color:var(--muted)}
.input:hover{border-color:color-mix(in oklab,var(--primary) 40%,var(--border))}
.input:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 4px var(--primary-soft)}
.input-row{display:flex;flex-wrap:wrap;gap:.6rem}
.input-row .input{flex:1 1 220px;width:auto}
`;

const LAYOUT = `
.card{position:relative;padding:var(--space-6);border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--surface);box-shadow:var(--shadow-sm);transition:box-shadow var(--dur-base) var(--ease),border-color var(--dur-base) var(--ease),transform var(--dur-base) var(--ease)}
.card:hover{box-shadow:var(--shadow-md);border-color:color-mix(in oklab,var(--primary) 32%,var(--border))}
.nav{position:sticky;top:0;z-index:50;background:color-mix(in oklab,var(--bg) 74%,transparent);border-bottom:1px solid color-mix(in oklab,var(--border) 70%,transparent);backdrop-filter:saturate(1.5) blur(16px);-webkit-backdrop-filter:saturate(1.5) blur(16px)}
.nav-inner{display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);min-height:66px}
.brand{display:inline-flex;align-items:center;gap:.6rem;min-width:0;font-family:var(--font-display);font-weight:var(--display-weight);font-size:var(--size-md);letter-spacing:var(--display-tracking);text-decoration:none}
.brand span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.brand-mark{width:30px;height:30px;flex:none}
.nav-links{display:none;gap:var(--space-6);margin:0;padding:0;list-style:none}
.nav-links a{color:var(--muted);font-size:var(--size-sm);font-weight:500;text-decoration:none;transition:color var(--dur-fast) var(--ease)}
.nav-links a:hover{color:var(--text)}
.nav-actions{display:flex;align-items:center;gap:.5rem;flex:none}
@media (min-width:760px){.nav-links{display:flex}}
.hero{position:relative;padding-block:clamp(3.5rem,9vw,7rem) clamp(3.5rem,8vw,6rem)}
.hero-grid{display:grid;gap:clamp(3rem,6vw,4.5rem);align-items:center}
@media (min-width:980px){.hero-grid{grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr)}}
.hero-copy{display:grid;gap:var(--space-5);justify-items:start;min-width:0}
.hero h1{font-size:clamp(var(--hero-min),1rem + 5.4vw,var(--hero-max));line-height:var(--leading-tight)}
.grad{background:linear-gradient(100deg,var(--primary-ink) 10%,var(--accent-ink) 90%);-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.hero-actions{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:var(--space-2)}
.hero-note{display:flex;align-items:center;gap:.5rem;font-size:var(--size-sm);color:var(--muted)}
.hero-note svg{width:18px;height:18px;color:var(--success-ink);flex:none}
.hero-visual{position:relative;min-width:0;perspective:1800px}
.window{position:relative;overflow:hidden;border:1px solid var(--border);border-radius:var(--radius-xl);background:color-mix(in oklab,var(--surface) 90%,transparent);box-shadow:var(--shadow-lg);backdrop-filter:blur(10px)}
@media (min-width:980px){.window{transform:rotateY(-9deg) rotateX(5deg) rotateZ(.5deg);transform-origin:30% 50%}}
.window-bar{display:flex;align-items:center;gap:6px;padding:12px 14px;border-bottom:1px solid var(--border);background:var(--surface-2)}
.window-bar span{width:10px;height:10px;border-radius:50%;background:var(--border)}
.window-bar i{margin-inline:auto;padding:4px 12px;border-radius:999px;background:var(--bg);color:var(--muted);font:500 var(--size-xs)/1.2 var(--font-mono);font-style:normal;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%}
.window-body{display:grid;gap:12px;padding:clamp(12px,2.4vw,20px)}
.kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.kpi{min-width:0;padding:12px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg)}
.kpi b,.kpi small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kpi b{font-family:var(--font-display);font-weight:var(--display-weight);font-size:var(--size-lg);letter-spacing:var(--display-tracking);line-height:1.2}
.kpi small{color:var(--muted);font-size:var(--size-xs)}
.chart{display:flex;align-items:flex-end;gap:clamp(3px,1vw,7px);height:clamp(110px,18vw,150px);padding:12px;border:1px solid var(--border);border-radius:var(--radius-md);background:linear-gradient(180deg,var(--bg),var(--primary-wash))}
.chart span{flex:1;height:var(--h);border-radius:min(var(--radius-sm),6px) min(var(--radius-sm),6px) 2px 2px;background:linear-gradient(180deg,var(--primary),color-mix(in oklab,var(--primary) 55%,var(--accent)));transform-origin:bottom;animation:grow var(--dur-slow) var(--ease-emph) both;animation-delay:calc(var(--i) * 45ms + 200ms)}
.chart span.hot{background:linear-gradient(180deg,var(--accent),color-mix(in oklab,var(--accent) 60%,var(--primary)))}
.rows{display:grid;gap:8px}
.row{display:flex;align-items:center;gap:10px;min-width:0;padding:9px 12px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg);font-size:var(--size-sm)}
.row .ico{width:28px;height:28px;border-radius:var(--radius-sm)}
.row .ico svg{width:15px;height:15px}
.row > span:not(.ico){flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row em{font:500 var(--size-xs)/1 var(--font-mono);font-style:normal;color:var(--success-ink)}
.float-card{position:absolute;left:-20px;bottom:-26px;display:flex;align-items:center;gap:10px;max-width:calc(100% - 24px);padding:12px 16px;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--surface);box-shadow:var(--shadow-lg);font-size:var(--size-sm);font-weight:600;animation:float 7s ease-in-out infinite}
.float-card svg{width:20px;height:20px;color:var(--success-ink);flex:none}
.float-card span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (max-width:979px){.float-card{left:12px;bottom:-22px}}
.ico{display:grid;place-items:center;flex:none;width:46px;height:46px;border:1px solid color-mix(in oklab,var(--primary) 22%,transparent);border-radius:var(--radius-md);background:var(--primary-soft);color:var(--primary-ink)}
.ico svg{width:22px;height:22px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,170px),1fr));gap:var(--space-4)}
.stat{display:grid;gap:.35rem;padding:var(--space-5) var(--space-5) var(--space-5) var(--space-6);border:1px solid var(--border);border-radius:var(--radius-lg);background:color-mix(in oklab,var(--surface) 80%,transparent);position:relative;overflow:hidden}
.stat::before{content:"";position:absolute;left:0;top:18%;bottom:18%;width:3px;border-radius:0 3px 3px 0;background:linear-gradient(180deg,var(--primary),var(--accent))}
.stat b{font-family:var(--font-display);font-weight:var(--display-weight);font-size:clamp(var(--size-xl),1rem + 2.2vw,var(--size-3xl));letter-spacing:var(--display-tracking);line-height:1.05}
.stat span{color:var(--muted);font-size:var(--size-sm)}
.grid{display:grid;gap:var(--space-5);grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))}
.feature{display:grid;gap:var(--space-4);align-content:start}
.feature h3{font-size:var(--size-lg)}
.feature p{color:var(--muted)}
.feature::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:radial-gradient(120% 80% at 0% 0%,var(--primary-soft),transparent 55%);opacity:0;transition:opacity var(--dur-base) var(--ease)}
.feature:hover::after{opacity:.7}
.feature > *{position:relative;z-index:1}
.steps{display:grid;gap:var(--space-5);grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));margin:0;padding:0;list-style:none;counter-reset:step}
.step{display:grid;gap:var(--space-3);align-content:start;counter-increment:step}
.step::before{content:counter(step,decimal-leading-zero);display:block;padding-bottom:var(--space-3);border-bottom:1px solid var(--border);color:var(--primary-ink);font:500 var(--size-sm)/1 var(--font-mono)}
.step h3{font-size:var(--size-md)}
.step p{color:var(--muted)}
`;

const COMMERCE = `
.pricing{display:grid;gap:var(--space-5);grid-template-columns:repeat(auto-fit,minmax(min(100%,270px),1fr));align-items:stretch}
.plan{display:flex;flex-direction:column;gap:var(--space-5);padding:var(--space-7) var(--space-6)}
.plan h3{font-size:var(--size-lg)}
.price{display:flex;align-items:baseline;flex-wrap:wrap;gap:.35rem}
.price b{font-family:var(--font-display);font-weight:var(--display-weight);font-size:clamp(var(--size-2xl),1.2rem + 2.2vw,var(--size-4xl));letter-spacing:var(--display-tracking);line-height:1}
.price span{color:var(--muted);font-size:var(--size-sm)}
.plan ul{display:grid;gap:.65rem;flex:1;margin:0;padding:0;list-style:none}
.plan li{display:flex;gap:.6rem;align-items:flex-start;font-size:var(--size-sm)}
.plan li svg{flex:none;width:18px;height:18px;margin-top:.15em;color:var(--success-ink)}
.plan .btn{width:100%}
.plan.highlight{border:1.5px solid var(--primary);background:linear-gradient(180deg,var(--primary-wash),var(--surface) 45%);box-shadow:var(--shadow-lg),0 0 0 5px var(--primary-soft)}
.plan .flag{position:absolute;top:-13px;left:var(--space-6)}
@media (min-width:980px){.plan.highlight{transform:translateY(-12px)}}
.table-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--surface);box-shadow:var(--shadow-md);-webkit-overflow-scrolling:touch}
.compare{width:100%;border-collapse:collapse;font-size:var(--size-sm)}
.compare th,.compare td{padding:15px 18px;border-bottom:1px solid var(--border);text-align:left;vertical-align:middle}
.compare thead th{background:var(--surface-2);font-family:var(--font-display);font-weight:var(--display-weight);font-size:var(--size-base);letter-spacing:var(--display-tracking)}
.compare tbody tr:last-child > *{border-bottom:0}
.compare tbody th{font-weight:500}
.compare .us{background:var(--primary-wash)}
.compare thead .us{color:var(--primary-ink);box-shadow:inset 0 3px 0 var(--primary)}
.compare tbody tr{transition:background-color var(--dur-fast) var(--ease)}
.compare tbody tr:hover{background:color-mix(in oklab,var(--surface-2) 60%,transparent)}
.yes,.no,.val{display:inline-flex;align-items:center;gap:.4rem;font-weight:600}
.yes{color:var(--success-ink)}
.no{color:var(--danger-ink)}
.yes svg,.no svg{width:24px;height:24px;flex:none;padding:4px;border-radius:50%;stroke-width:2.4}
.yes svg{background:var(--success-soft)}
.no svg{background:var(--danger-soft)}
.cite{margin-left:.25rem;font:500 .72em/1 var(--font-mono);vertical-align:super}
.cite a{color:var(--muted);text-decoration:none}
.cite a:hover{color:var(--primary-ink)}
@media (max-width:560px){.compare th,.compare td{padding:11px 10px}.compare thead th{font-size:var(--size-sm)}}
.footnotes{display:grid;gap:.4rem;margin:var(--space-5) 0 0;padding-left:1.4rem;color:var(--muted);font-size:var(--size-xs)}
.footnotes li:target{color:var(--text)}
.disclaimer{margin-top:var(--space-4);color:var(--muted);font-size:var(--size-xs)}
.offer{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-4);margin-top:var(--space-6);border-style:dashed;border-color:color-mix(in oklab,var(--primary) 45%,var(--border));background:var(--primary-wash)}
.offer h3{font-size:var(--size-lg);margin-bottom:.25rem}
.offer p{max-width:44rem;font-size:var(--size-base)}
.faq{display:grid;gap:var(--space-3);max-width:48rem;margin-inline:auto}
.faq details{border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface);transition:box-shadow var(--dur-base) var(--ease),border-color var(--dur-base) var(--ease)}
.faq details[open]{border-color:color-mix(in oklab,var(--primary) 35%,var(--border));box-shadow:var(--shadow-md)}
.faq summary{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:var(--space-4) var(--space-5);font-weight:600;cursor:pointer;list-style:none}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"";flex:none;width:12px;height:12px;background:linear-gradient(currentColor,currentColor) center/100% 2px no-repeat,linear-gradient(currentColor,currentColor) center/2px 100% no-repeat;color:var(--primary-ink);transition:transform var(--dur-base) var(--ease)}
.faq details[open] summary::after{transform:rotate(45deg)}
.faq details p{padding:0 var(--space-5) var(--space-5);color:var(--muted)}
.cta-band{position:relative;overflow:hidden;display:grid;gap:var(--space-5);justify-items:start;padding:clamp(2.5rem,6vw,4.75rem) clamp(1.25rem,5vw,4.25rem);border-radius:var(--radius-xl);background:var(--primary);color:var(--primary-text);box-shadow:var(--shadow-lg);isolation:isolate}
.cta-band::before{content:"";position:absolute;inset:0;z-index:-1;background:radial-gradient(55% 120% at 100% 0%,color-mix(in oklab,var(--accent) 34%,transparent),transparent 62%),radial-gradient(45% 90% at 0% 110%,rgb(0 0 0 / .14),transparent 70%)}
.cta-band::after{content:"";position:absolute;inset:0;z-index:-1;background-image:${GRAIN};background-size:180px;opacity:.12;mix-blend-mode:overlay}
.cta-band h2{max-width:22ch}
.cta-band p{max-width:40rem}
.footer{margin-top:var(--section);padding-block:var(--space-8) var(--space-7);border-top:1px solid var(--border);color:var(--muted);font-size:var(--size-sm)}
.footer-inner{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-5)}
.footer nav{display:flex;flex-wrap:wrap;gap:var(--space-5)}
.footer a{color:var(--muted);text-decoration:none}
.footer a:hover{color:var(--text)}
.footer .brand{color:var(--text)}
`;

const MOTION = `
@keyframes rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
@keyframes grow{from{transform:scaleY(.08)}to{transform:none}}
@keyframes float{0%,100%{translate:0 0}50%{translate:0 -7px}}
.reveal{animation:rise calc(var(--dur-slow) * 1.8) var(--ease-emph) both}
.d1{animation-delay:70ms}.d2{animation-delay:140ms}.d3{animation-delay:210ms}.d4{animation-delay:280ms}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
@media print{body::before,body::after{display:none}.nav{position:static}}
`;

/** The whole stylesheet for a design system. */
export function toCss(ds: DesignSystem): string {
  const light = themeVars(ds, "light");
  const dark = themeVars(ds, "dark");
  return [
    `/* ${ds.name} · ${ds.id} · generated by Anonymo Ventures Designer Mo. Fonts: ${ds.fonts.display.family}, ${ds.fonts.body.family}, ${ds.fonts.mono.family} (OFL-1.1). */`,
    `:root{${staticVars(ds)}${light}}`,
    `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${dark}}}`,
    `[data-theme="dark"]{${dark}}`,
    `[data-theme="light"]{${light}}`,
    `[data-theme]:not(:root){background:var(--bg);color:var(--text)}`,
    BASE,
    BUTTONS,
    FORMS,
    LAYOUT,
    COMMERCE,
    MOTION,
  ]
    .map((s) => s.trim())
    .join("\n");
}

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The Google Fonts css2 URL for the system's three families (only weights each family has). */
export function googleFontsUrl(ds: DesignSystem): string {
  const seen = new Set<string>();
  const families: string[] = [];
  for (const f of [ds.fonts.display, ds.fonts.body, ds.fonts.mono]) {
    if (seen.has(f.family)) continue;
    seen.add(f.family);
    const name = f.family.replace(/ /g, "+");
    const weights = [...new Set(f.weights)].sort((a, b) => a - b);
    families.push(weights.length === 1 && weights[0] === 400 ? `family=${name}` : `family=${name}:wght@${weights.join(";")}`);
  }
  return `https://fonts.googleapis.com/css2?${families.join("&")}&display=swap`;
}

/** `<link>` tags that load the fonts (stylesheet only; no scripts). */
export function fontLinks(ds: DesignSystem): string {
  return [
    `<link rel="preconnect" href="https://fonts.googleapis.com">`,
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
    `<link rel="stylesheet" href="${attr(googleFontsUrl(ds))}">`,
  ].join("\n");
}
