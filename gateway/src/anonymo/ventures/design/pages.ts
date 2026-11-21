// WS11 · Designer Mo's page renderers (Ventures Overview §2 "Original look"; Backend PART 11 "designer").
//
// Three standalone HTML documents built only from a DesignSystem and clean content: a landing page, a "Brand vs
// Rival" comparison page and the dashboard's design-system preview. Every piece of text is escaped; pages carry no
// script at all (inline SVG icons, CSS-only motion), and the only external request is the fonts stylesheet. On the
// comparison page a row about the rival is shown only when it cites a dated, functional source fact, and each one is
// footnoted with its date, so the Adman's claim checker passes every row that reaches the page.

import { contrastRatio } from "./color.ts";
import { fontLinks, toCss } from "./css.ts";
import { brandMark, FEATURE_ICONS, icon, isIconName, type IconName } from "./icons.ts";
import { PALETTE_ROLES, SCALE_STEPS, seededRandom, type DesignSystem, type PaletteRole, type ThemeName } from "./tokens.ts";

// ---- escaping ----------------------------------------------------------------------------------------------------

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const e = escapeHtml;

/** Only same-page anchors, relative paths, http(s) and mailto links survive; anything else becomes "#". */
export function safeHref(href: string | undefined): string {
  const h = (href ?? "").trim();
  if (!h) return "#";
  if (/^(#|\/(?!\/)|\.{1,2}\/)/.test(h)) return h;
  if (/^(https?:|mailto:)/i.test(h)) return h;
  return "#";
}

export type Cta = string | { label: string; href?: string };
const ctaOf = (c: Cta, fallbackHref: string) => (typeof c === "string" ? { label: c, href: fallbackHref } : { label: c.label, href: c.href ?? fallbackHref });

function button(c: Cta, cls: string, fallbackHref = "#pricing", withArrow = true): string {
  const { label, href } = ctaOf(c, fallbackHref);
  return `<a class="btn ${cls}" href="${e(safeHref(href))}">${e(label)}${withArrow ? icon("arrowRight") : ""}</a>`;
}

function documentShell(ds: DesignSystem, title: string, description: string, body: string, extraCss = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(description)}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="${ds.palette.light.bg}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="${ds.palette.dark.bg}" media="(prefers-color-scheme: dark)">
<meta name="generator" content="Anonymo Ventures Designer Mo (${e(ds.id)})">
${fontLinks(ds)}
<style>
${toCss(ds)}
${extraCss}
</style>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
${body}
</body>
</html>
`;
}

function nav(ds: DesignSystem, brand: string, links: [string, string][], cta?: Cta): string {
  const items = links.map(([href, label]) => `<li><a href="${e(href)}">${e(label)}</a></li>`).join("");
  return `<header class="nav"><div class="container nav-inner">
<a class="brand" href="#top">${brandMark(ds.mark, `${ds.id}-nav`)}<span>${e(brand)}</span></a>
${items ? `<ul class="nav-links">${items}</ul>` : ""}
<div class="nav-actions">${cta ? button(cta, "btn-primary btn-sm", "#pricing", false) : ""}</div>
</div></header>`;
}

function footer(ds: DesignSystem, brand: string, links: [string, string][], note?: string): string {
  return `<footer class="footer"><div class="container footer-inner">
<a class="brand" href="#top">${brandMark(ds.mark, `${ds.id}-foot`)}<span>${e(brand)}</span></a>
<nav aria-label="Footer">${links.map(([href, label]) => `<a href="${e(href)}">${e(label)}</a>`).join("")}</nav>
${note ? `<p>${e(note)}</p>` : ""}
</div></footer>`;
}

/** Splits a headline so its last two words carry the brand gradient. */
function gradientHeadline(text: string): string {
  const words = text.trim().split(/\s+/);
  if (words.length < 3) return `<span class="grad">${e(text)}</span>`;
  return `${e(words.slice(0, -2).join(" "))} <span class="grad">${e(words.slice(-2).join(" "))}</span>`;
}

export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "Custom";
  return Number.isInteger(n) ? `$${n.toLocaleString("en-US")}` : `$${n.toFixed(2)}`;
}

// ---- landing page ------------------------------------------------------------------------------------------------

export type LandingContent = {
  brand: string;
  tagline: string;
  subhead: string;
  cta: Cta;
  secondaryCta?: Cta;
  eyebrow?: string;
  features: { title: string; body: string; icon?: IconName | string }[];
  steps?: { title: string; body: string }[];
  pricing?: { name: string; priceUsdMonthly: number | null; period?: string; blurb?: string; features: string[]; highlight?: boolean; cta?: Cta }[];
  stats?: { label: string; value: string }[];
  faq?: { q: string; a: string }[];
  ctaHeadline?: string;
  ctaBody?: string;
  footerNote?: string;
};

function heroVisual(ds: DesignSystem, c: LandingContent): string {
  const kpis = (c.stats?.length ? c.stats : c.features.map((f) => ({ value: "On", label: f.title }))).slice(0, 3);
  const r = seededRandom(`${ds.seed}::chart`);
  const bars = Array.from({ length: 14 }, (_, i) => {
    const h = Math.min(100, Math.round(22 + i * 4.6 + r() * 22));
    return `<span style="--h:${h}%;--i:${i}"${i >= 12 ? ' class="hot"' : ""}></span>`;
  }).join("");
  const rows = c.features
    .slice(0, 3)
    .map((f, i) => `<div class="row"><span class="ico">${icon(featureIcon(f.icon, i))}</span><span>${e(f.title)}</span><em>live</em></div>`)
    .join("");
  const float = c.stats?.[0] ? `${c.stats[0].value} ${c.stats[0].label}` : c.features[0]?.title ?? c.brand;
  return `<div class="hero-visual reveal d2" aria-hidden="true">
<div class="window">
<div class="window-bar"><span></span><span></span><span></span><i>${e(c.brand)} · overview</i></div>
<div class="window-body">
<div class="kpis">${kpis.map((k) => `<div class="kpi"><b>${e(k.value)}</b><small>${e(k.label)}</small></div>`).join("")}</div>
<div class="chart">${bars}</div>
<div class="rows">${rows}</div>
</div>
</div>
<div class="float-card">${icon("checkCircle")}<span>${e(float)}</span></div>
</div>`;
}

const featureIcon = (name: string | undefined, i: number): IconName => (isIconName(name) ? name : FEATURE_ICONS[i % FEATURE_ICONS.length]);

export function renderLanding(ds: DesignSystem, c: LandingContent): string {
  const links: [string, string][] = [["#features", "Features"]];
  if (c.steps?.length) links.push(["#how", "How it works"]);
  if (c.pricing?.length) links.push(["#pricing", "Pricing"]);
  if (c.faq?.length) links.push(["#faq", "FAQ"]);
  const primaryHref = c.pricing?.length ? "#pricing" : "#start";

  const hero = `<section class="hero" id="top"><div class="container hero-grid">
<div class="hero-copy">
<span class="pill reveal"><span class="badge badge-primary">${e(c.eyebrow ?? "New")}</span><span>Introducing ${e(c.brand)}</span></span>
<h1 class="reveal d1">${gradientHeadline(c.tagline)}</h1>
<p class="lead reveal d2">${e(c.subhead)}</p>
<div class="hero-actions reveal d3">${button(c.cta, "btn-primary btn-lg", primaryHref)}${button(c.secondaryCta ?? { label: c.steps?.length ? "See how it works" : "Explore features", href: c.steps?.length ? "#how" : "#features" }, "btn-secondary btn-lg", "#features", false)}</div>
${c.pricing?.some((p) => p.priceUsdMonthly === 0) ? `<p class="hero-note reveal d4">${icon("checkCircle")}Free plan available</p>` : ""}
</div>
${heroVisual(ds, c)}
</div></section>`;

  const stats = c.stats?.length
    ? `<section class="container" aria-label="Key numbers"><div class="stats">${c.stats.map((s) => `<div class="stat"><b>${e(s.value)}</b><span>${e(s.label)}</span></div>`).join("")}</div></section>`
    : "";

  const features = `<section class="section" id="features"><div class="container">
<div class="section-head"><span class="eyebrow">Features</span><h2 class="h2">Everything ${e(c.brand)} does for you</h2></div>
<div class="grid">${c.features.map((f, i) => `<article class="card feature"><span class="ico">${icon(featureIcon(f.icon, i))}</span><h3>${e(f.title)}</h3><p>${e(f.body)}</p></article>`).join("")}</div>
</div></section>`;

  const steps = c.steps?.length
    ? `<section class="section" id="how" style="padding-top:0"><div class="container">
<div class="section-head"><span class="eyebrow">How it works</span><h2 class="h2">Up and running in ${c.steps.length} steps</h2></div>
<ol class="steps">${c.steps.map((s) => `<li class="step"><h3>${e(s.title)}</h3><p>${e(s.body)}</p></li>`).join("")}</ol>
</div></section>`
    : "";

  const pricing = c.pricing?.length
    ? `<section class="section" id="pricing" style="padding-top:0"><div class="container">
<div class="section-head center"><span class="eyebrow">Pricing</span><h2 class="h2">Simple plans, priced in dollars</h2><p class="lead">Start small and move up when you need to.</p></div>
<div class="pricing">${c.pricing
        .map(
          (p) => `<article class="card plan${p.highlight ? " highlight" : ""}">${p.highlight ? `<span class="badge badge-primary flag">Most popular</span>` : ""}
<div><h3>${e(p.name)}</h3>${p.blurb ? `<p class="muted">${e(p.blurb)}</p>` : ""}</div>
<div class="price"><b>${e(formatUsd(p.priceUsdMonthly))}</b><span>${p.priceUsdMonthly === null ? "" : e(p.period ?? "/ month")}</span></div>
<ul>${p.features.map((f) => `<li>${icon("check")}<span>${e(f)}</span></li>`).join("")}</ul>
${button(p.cta ?? c.cta, p.highlight ? "btn-primary" : "btn-secondary", "#start", false)}
</article>`,
        )
        .join("")}</div>
</div></section>`
    : "";

  const faq = c.faq?.length
    ? `<section class="section" id="faq" style="padding-top:0"><div class="container">
<div class="section-head center"><span class="eyebrow">FAQ</span><h2 class="h2">Questions, answered</h2></div>
<div class="faq">${c.faq.map((f, i) => `<details${i === 0 ? " open" : ""}><summary>${e(f.q)}</summary><p>${e(f.a)}</p></details>`).join("")}</div>
</div></section>`
    : "";

  const band = `<section class="container" id="start"><div class="cta-band">
<h2 class="h2">${e(c.ctaHeadline ?? `Start with ${c.brand} today.`)}</h2>
${c.ctaBody ? `<p>${e(c.ctaBody)}</p>` : ""}
${button(c.cta, "btn-inverse btn-lg", primaryHref)}
</div></section>`;

  const body = `${nav(ds, c.brand, links, c.cta)}
<main id="main">
${hero}
${stats}
${features}
${steps}
${pricing}
${faq}
${band}
</main>
${footer(ds, c.brand, links, c.footerNote)}`;
  return documentShell(ds, `${c.brand} · ${c.tagline}`, c.subhead, body);
}

// ---- comparison page ---------------------------------------------------------------------------------------------

export type ComparisonRow = { feature: string; us: boolean | string; them: boolean | string; source?: { fact: string; observedAt: string } };
export type ComparisonContent = {
  brand: string;
  rival: string;
  rows: ComparisonRow[];
  switchOffer?: string | { title?: string; body: string; cta?: Cta };
  cta: Cta;
  intro?: string;
  /** Defaults to the latest source date among the cited rows. */
  comparedOn?: string;
};

/** YYYY-MM-DD for an ISO-ish date, or null when it cannot be read as a date. */
export function isoDay(s: string | undefined): string | null {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s.trim());
  if (m) return m[1];
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

/** Rows that may appear: each must cite a non-empty fact with a readable observation date. */
export function citedRows(rows: ComparisonRow[]): { cited: (ComparisonRow & { source: { fact: string; observedAt: string } })[]; dropped: ComparisonRow[] } {
  const cited: (ComparisonRow & { source: { fact: string; observedAt: string } })[] = [];
  const dropped: ComparisonRow[] = [];
  for (const r of rows) {
    if (r.source && r.source.fact?.trim() && isoDay(r.source.observedAt)) cited.push(r as ComparisonRow & { source: { fact: string; observedAt: string } });
    else dropped.push(r);
  }
  return { cited, dropped };
}

function cell(v: boolean | string): string {
  if (v === true) return `<span class="yes">${icon("check")}<span class="sr-only">Yes</span></span>`;
  if (v === false) return `<span class="no">${icon("x")}<span class="sr-only">No</span></span>`;
  return `<span class="val">${e(v)}</span>`;
}

export function renderComparison(ds: DesignSystem, c: ComparisonContent): string {
  const { cited } = citedRows(c.rows);
  const days = cited.map((r) => isoDay(r.source.observedAt)!).sort();
  const comparedOn = isoDay(c.comparedOn) ?? days[days.length - 1] ?? "an unrecorded date";
  const rows = cited
    .map(
      (r, i) => `<tr><th scope="row">${e(r.feature)}</th><td class="us">${cell(r.us)}</td><td>${cell(r.them)}<sup class="cite"><a href="#src-${i + 1}" id="ref-${i + 1}" aria-label="Source ${i + 1}">[${i + 1}]</a></sup></td></tr>`,
    )
    .join("");
  const notes = cited
    .map((r, i) => `<li id="src-${i + 1}">${e(r.source.fact)} Observed ${e(isoDay(r.source.observedAt))}. <a href="#ref-${i + 1}" aria-label="Back to row ${i + 1}">↩</a></li>`)
    .join("");
  const offer = c.switchOffer
    ? (() => {
        const o = typeof c.switchOffer === "string" ? { body: c.switchOffer } : c.switchOffer;
        return `<div class="card offer"><div><h3>${e(o.title ?? `Switching from ${c.rival}?`)}</h3><p class="muted">${e(o.body)}</p></div>${button(o.cta ?? c.cta, "btn-primary", "#start")}</div>`;
      })()
    : "";

  const body = `${nav(ds, c.brand, [["#compare", "Comparison"], ["#sources", "Sources"]], c.cta)}
<main id="main">
<section class="hero" id="top" style="padding-bottom:clamp(2rem,5vw,3rem)"><div class="container">
<div class="hero-copy">
<span class="eyebrow reveal">Comparison</span>
<h1 class="reveal d1"><span class="grad">${e(c.brand)}</span> <span class="muted">vs</span> ${e(c.rival)}</h1>
<p class="lead reveal d2">${e(c.intro ?? `A side-by-side look at what you get. Every statement about ${c.rival} is dated and sourced below.`)}</p>
</div>
</div></section>
<section class="container" id="compare">
<div class="table-wrap reveal d3"><table class="compare">
<caption class="sr-only">${e(c.brand)} compared with ${e(c.rival)}</caption>
<thead><tr><th scope="col">Feature</th><th scope="col" class="us">${e(c.brand)}</th><th scope="col">${e(c.rival)}</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
<ol class="footnotes" id="sources" aria-label="Sources">${notes}</ol>
<p class="disclaimer">Compared on ${e(comparedOn)} from public information. ${e(c.rival)} is a trademark of its owner; no affiliation.</p>
${offer}
</section>
<section class="container section" id="start" style="padding-bottom:0"><div class="cta-band">
<h2 class="h2">${e(`Try ${c.brand} side by side.`)}</h2>
${button(c.cta, "btn-inverse btn-lg", "#start")}
</div></section>
</main>
${footer(ds, c.brand, [["#compare", "Comparison"], ["#sources", "Sources"]], `${c.rival} is a trademark of its owner; no affiliation.`)}`;
  return documentShell(ds, `${c.brand} vs ${c.rival}`, `${c.brand} compared with ${c.rival}, with dated sources.`, body);
}

// ---- design-system preview ---------------------------------------------------------------------------------------

const PREVIEW_CSS = `
.pv-head{display:grid;gap:var(--space-4);padding-block:clamp(2.5rem,6vw,4.5rem) var(--space-7)}
.pv-head h1{font-size:clamp(2.2rem,1rem + 4vw,var(--hero-max));line-height:var(--leading-tight)}
.pv-meta{display:flex;flex-wrap:wrap;gap:.5rem}
.pv-themes{display:grid;gap:var(--space-5);grid-template-columns:repeat(auto-fit,minmax(min(100%,460px),1fr))}
.pv-pane{display:grid;gap:var(--space-6);align-content:start;padding:clamp(1rem,3vw,2rem);border:1px solid var(--border);border-radius:var(--radius-xl);box-shadow:var(--shadow-md)}
.pv-pane h2{font-size:var(--size-lg)}
.swatches{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(min(100%,150px),1fr))}
.swatch{overflow:hidden;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface)}
.swatch i{display:grid;place-items:center;height:64px;font:600 var(--size-sm)/1 var(--font-display);font-style:normal;border-bottom:1px solid var(--border)}
.swatch div{display:grid;gap:2px;padding:8px 10px;font-size:var(--size-xs)}
.swatch b{font-weight:600}
.swatch code{color:var(--muted)}
.pv-row{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem}
.pv-scale{display:grid;gap:.6rem}
.pv-scale div{display:flex;align-items:baseline;gap:1rem;min-width:0;border-bottom:1px solid var(--border);padding-bottom:.6rem}
.pv-scale code{flex:none;width:9ch;color:var(--muted);font-size:var(--size-xs)}
.pv-scale span{font-family:var(--font-display);font-weight:var(--display-weight);letter-spacing:var(--display-tracking);line-height:1.1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pv-boxes{display:grid;gap:var(--space-4);grid-template-columns:repeat(auto-fill,minmax(min(100%,140px),1fr))}
.pv-box{display:grid;place-items:center;height:88px;border:1px solid var(--border);background:var(--surface);font-size:var(--size-xs);color:var(--muted);text-align:center}
.pv-space{display:grid;gap:6px}
.pv-space div{display:flex;align-items:center;gap:.75rem;font-size:var(--size-xs);color:var(--muted)}
.pv-space span{height:10px;border-radius:3px;background:linear-gradient(90deg,var(--primary),var(--accent))}
.pv-voice{display:grid;gap:var(--space-5);grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr))}
.pv-voice ul{margin:0;padding-left:1.1rem;display:grid;gap:.35rem;color:var(--muted)}
.pv-mini{display:grid;gap:var(--space-4);grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr))}
`;

/** The foreground/background pair each swatch reports its contrast for. */
const SWATCH_PAIR: Record<PaletteRole, [PaletteRole, PaletteRole]> = {
  bg: ["text", "bg"],
  surface: ["text", "surface"],
  surface2: ["text", "surface2"],
  text: ["text", "bg"],
  muted: ["muted", "bg"],
  primary: ["primaryText", "primary"],
  primaryText: ["primaryText", "primary"],
  accent: ["accentText", "accent"],
  accentText: ["accentText", "accent"],
  border: ["text", "border"],
  success: ["success", "bg"],
  warning: ["warning", "bg"],
  danger: ["danger", "bg"],
};

const grade = (r: number) => (r >= 7 ? "AAA" : r >= 4.5 ? "AA" : r >= 3 ? "AA large" : "decorative");

function swatches(ds: DesignSystem, theme: ThemeName): string {
  const p = ds.palette[theme];
  return PALETTE_ROLES.map((role) => {
    const [fg, bg] = SWATCH_PAIR[role];
    const ratio = contrastRatio(p[fg], p[bg]);
    const textColour = role === fg ? p[bg] : p[fg];
    return `<div class="swatch"><i style="background:${p[role]};color:${textColour}">Aa</i><div><b>${e(role)}</b><code>${p[role]}</code><span>${e(fg)} on ${e(bg)} ${ratio.toFixed(2)}:1 · ${grade(ratio)}</span></div></div>`;
  }).join("");
}

function componentSamples(): string {
  return `<div class="pv-row"><a class="btn btn-primary" href="#">Primary${icon("arrowRight")}</a><a class="btn btn-secondary" href="#">Secondary</a><a class="btn btn-ghost" href="#">Ghost</a><a class="btn btn-accent btn-sm" href="#">Accent</a></div>
<div class="pv-row"><span class="badge">Default</span><span class="badge badge-primary">Primary</span><span class="badge badge-accent">Accent</span><span class="badge badge-soft">Soft</span><span class="badge badge-success">Success</span><span class="badge badge-warning">Warning</span><span class="badge badge-danger">Danger</span></div>
<label class="field"><span class="label">Email for updates</span><span class="input-row"><input class="input" type="email" placeholder="name@example.com"><a class="btn btn-primary" href="#">Join</a></span><span class="hint">We only write when something ships.</span></label>
<div class="pv-mini">
<article class="card feature"><span class="ico">${icon("bolt")}</span><h3>Feature card</h3><p>Icon, title and one plain sentence.</p></article>
<article class="card plan highlight"><span class="badge badge-primary flag">Most popular</span><h3>Plan</h3><div class="price"><b>$12</b><span>/ month</span></div><ul><li>${icon("check")}<span>Included item</span></li></ul></article>
</div>
<div class="faq" style="margin:0;max-width:none"><details open><summary>Question in the FAQ?</summary><p>Answers stay short and specific.</p></details></div>`;
}

export function renderDesignPreview(ds: DesignSystem): string {
  const f = ds.fonts;
  const scale = [...SCALE_STEPS]
    .reverse()
    .map((s) => `<div><code>${s} ${ds.scale.sizes[s]}</code><span style="font-size:${ds.scale.sizes[s]}">${e(ds.name)}</span></div>`)
    .join("");
  const panes = (["light", "dark"] as const)
    .map((t) => `<section class="pv-pane" data-theme="${t}" aria-label="${t} theme"><h2>${t === "light" ? "Light" : "Dark"} theme</h2><div class="swatches">${swatches(ds, t)}</div>${componentSamples()}</section>`)
    .join("");
  const radii = (["sm", "md", "lg", "xl", "button"] as const).map((k) => `<div class="pv-box" style="border-radius:${ds.radii[k]}">radius ${k}<br>${ds.radii[k]}</div>`).join("");
  const shadows = (["sm", "md", "lg"] as const).map((k) => `<div class="pv-box" style="border-radius:var(--radius-md);box-shadow:var(--shadow-${k})">shadow ${k}</div>`).join("");
  const spacing = ds.spacing.steps.map((v, i) => `<div><code>space-${i + 1}</code><span style="width:${v}"></span>${v}</div>`).join("");
  const list = (xs: string[]) => `<ul>${xs.map((x) => `<li>${e(x)}</li>`).join("")}</ul>`;

  const body = `<main id="main" class="container">
<header class="pv-head" id="top">
<span class="eyebrow">Design system preview</span>
<h1><span class="grad">${e(ds.name)}</span></h1>
<p class="lead">A ${e(ds.mood)} system. Display ${e(f.display.family)}, body ${e(f.body.family)}, mono ${e(f.mono.family)}, all ${e(f.display.licence)}.</p>
<div class="pv-meta"><span class="badge">id ${e(ds.id)}</span><span class="badge">seed ${e(ds.seed)}</span><span class="badge badge-soft">${e(ds.radii.style)} corners</span><span class="badge badge-soft">${e(ds.shadows.style)} shadows</span><span class="badge badge-soft">ratio ${ds.scale.ratio}</span></div>
</header>
<div class="pv-themes">${panes}</div>
<section class="section"><div class="section-head"><span class="eyebrow">Type scale</span><h2 class="h2">Modular scale ${ds.scale.ratio} from ${ds.scale.basePx}px</h2></div><div class="pv-scale">${scale}</div>
<p class="muted" style="margin-top:var(--space-5);font-family:var(--font-body)">Body text in ${e(f.body.family)}. <code>Mono in ${e(f.mono.family)}</code></p></section>
<section class="section" style="padding-top:0"><div class="section-head"><span class="eyebrow">Shape</span><h2 class="h2">Corners, depth and rhythm</h2></div>
<div class="pv-boxes">${radii}${shadows}</div>
<div class="pv-space" style="margin-top:var(--space-6)">${spacing}</div>
<p class="muted" style="margin-top:var(--space-5)">Motion ${ds.motion.fastMs} / ${ds.motion.baseMs} / ${ds.motion.slowMs} ms, easing <code>${e(ds.motion.easing)}</code>.</p></section>
<section class="section" style="padding-top:0"><div class="section-head"><span class="eyebrow">Voice</span><h2 class="h2">${ds.voice.tone.map((t) => e(t)).join(", ")}</h2></div>
<div class="pv-voice"><div class="card"><h3>Do</h3>${list(ds.voice.doSay)}</div><div class="card"><h3>Don't say</h3>${list(ds.voice.dontSay)}</div></div></section>
</main>`;
  return documentShell(ds, `${ds.name} · design system`, `Preview of the ${ds.name} design system.`, body, PREVIEW_CSS);
}
