// Update "build": describe an app or a game in a sentence and a model writes it as one self-contained HTML file. The
// file runs in a sandboxed frame on the page (lib/anonymo/build.ts `sandboxed`), with a policy that lets it run its own
// inline code and nothing else: no network, no forms, no navigation, no access to this site's storage or the key.
// A share link carries the whole app, compressed, in the part of the URL after `#`, which browsers never send to a
// server, so Anonymo never stores or sees a shared app.

export type BuildModel = { id: string; label: string; note: string };

/** The models offered, best first. The first live one is the default. */
export const BUILD_MODELS: readonly BuildModel[] = [
  { id: 'anthropic/claude-sonnet-5.5', label: 'Best', note: 'Claude Sonnet 5.5. Polished apps and games.' },
  { id: 'venice/deepseek-v4-1-flash-uncensored', label: 'Uncensored', note: 'DeepSeek V4.1, uncensored. Any theme, cheapest.' },
  { id: 'x-ai/grok-4.7', label: 'Grok', note: 'Grok 4.7. Fast and loose.' },
];

/** The longest app a reply may be. */
export const BUILD_MAX_TOKENS = 16_000;
/** An idea or a change request, at most. */
export const BUILD_PROMPT_LIMIT = 2_000;
/** The largest app kept or shared (characters of HTML). */
export const BUILD_MAX_HTML = 400_000;

export const BUILD_IDEAS = [
  'A snake game where the snake is a frog eating flies, with a high score',
  'A tip calculator that splits the bill between friends',
  'A flappy bird clone with a rocket dodging candles',
  'A pomodoro timer with a lo-fi look and a progress ring',
  'A drum machine with 8 pads I can play with my keyboard',
  'A "would you rather" party game with 50 spicy questions',
];

const SYSTEM = [
  'You build small web apps and games. Reply with exactly one complete HTML document and nothing else: start with',
  '<!doctype html> and end with </html>. No explanation before or after, no markdown fences.',
  'Rules for the document:',
  '- Everything inline in this one file: CSS in <style>, JavaScript in <script>. Do not load anything from the',
  '  internet: no CDN scripts, no web fonts, no remote images, no fetch or XHR, no forms that submit. Draw graphics',
  '  with CSS, SVG, canvas or emoji. Make sounds with the Web Audio API if sound helps.',
  '- It runs in a sandboxed frame that fills the space it is given, from phone size up to a wide desktop. Make the',
  '  layout responsive, centered, and good-looking out of the box, with a clear title and obvious controls.',
  '- Games: start with a short "press any key or tap to start" screen, support both keyboard and touch, show the',
  '  score, and offer a restart. Keep the frame rate smooth with requestAnimationFrame.',
  '- Do not use alert, confirm, prompt, localStorage, sessionStorage, cookies or window.open: they are blocked.',
  '  Keep state in memory.',
  '- Write working, finished code. No placeholders, no TODOs.',
].join('\n');

export type BuildTurn = { ask: string; html: string };

/** The messages for a first build, or for a change to the current app. */
export function buildMessages(ask: string, current: string | null) {
  const idea = ask.trim().slice(0, BUILD_PROMPT_LIMIT);
  if (!current) return [
    { role: 'system' as const, content: SYSTEM },
    { role: 'user' as const, content: `Build this: ${idea}` },
  ];
  return [
    { role: 'system' as const, content: SYSTEM },
    { role: 'user' as const, content: `Here is the current app:\n\n${current}\n\nChange it: ${idea}\n\nReply with the whole updated HTML document.` },
  ];
}

/** The HTML document inside a reply: fences and chatter around it are dropped. Null when there is none yet. */
export function extractHtml(reply: string): string | null {
  const text = reply.replace(/^﻿/, '');
  const start = text.search(/<!doctype html|<html[\s>]/i);
  if (start === -1) return null;
  const end = text.toLowerCase().lastIndexOf('</html>');
  const html = end > start ? text.slice(start, end + '</html>'.length) : text.slice(start);
  return html.trim() || null;
}

/** Whether a reply has closed its document (a cut-off reply is still shown, marked unfinished). */
export const isComplete = (html: string) => /<\/html>\s*$/i.test(html);

/** The policy every built app runs under: its own inline code, pictures from data, nothing from the network. */
export const BUILD_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "worker-src blob:",
].join('; ');

/** The frame's sandbox: scripts and pointer lock only. No same-origin, forms, popups, downloads or navigation. */
export const BUILD_SANDBOX = 'allow-scripts allow-pointer-lock';

/**
 * The document the frame gets: the policy is the very first thing parsed, before anything the app wrote (even a
 * script placed above its own <head>), so a later meta tag can only narrow it. Any meta refresh is removed. The app's
 * own <html> and <head> tags that follow merge into these, as browsers do with repeated tags.
 */
export function sandboxed(html: string): string {
  const doc = html
    .slice(0, BUILD_MAX_HTML)
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi, '')
    .replace(/^\s*<!doctype[^>]*>/i, '');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${BUILD_CSP}">${doc}`;
}

/** A short name for an app: its <title>, else the first words of the idea. */
export function buildTitle(html: string | null, ask: string): string {
  const title = html?.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1]?.trim();
  const plain = (title || ask).replace(/\s+/g, ' ').trim();
  return plain.length > 60 ? `${plain.slice(0, 57)}…` : plain || 'Untitled app';
}

type Pricing = { prompt?: string; completion?: string } | undefined;

/** Rough tokens in a text (3.5 characters each), rounded up. */
export const tokensOf = (text: string) => Math.ceil(text.length / 3.5);

/** The most a build can cost in USD: every input token plus the longest allowed reply. Null when the price is unknown. */
export function buildCeilingUsd(pricing: Pricing, inputChars: number, maxTokens = BUILD_MAX_TOKENS): number | null {
  const p = Number(pricing?.prompt);
  const c = Number(pricing?.completion);
  if (!Number.isFinite(p) || !Number.isFinite(c) || p < 0 || c < 0) return null;
  return Math.ceil(inputChars / 3.5) * p + maxTokens * c;
}

/** "$0.05", "under $0.01". */
export function roughUsd(usd: number | null): string {
  if (usd === null) return 'price unknown';
  if (usd < 0.01) return 'under $0.01';
  return `$${usd < 1 ? usd.toFixed(2) : usd.toFixed(2)}`;
}

// ---- share links ------------------------------------------------------------------------------------------------

const toB64Url = (bytes: Uint8Array) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64Url = (text: string) => {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** Longest share fragment accepted (characters). Links this long still work in every current browser. */
export const SHARE_MAX = 200_000;

/** `v1.<base64url(deflate-raw(json))>`: the app and its title, compressed. */
export async function encodeShare(app: { title: string; html: string }): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify({ t: app.title.slice(0, 120), h: app.html.slice(0, BUILD_MAX_HTML) }));
  const packed = `v1.${toB64Url(await pipe(json, new CompressionStream('deflate-raw')))}`;
  if (packed.length > SHARE_MAX) throw new Error('This app is too big to share as a link. Download it instead.');
  return packed;
}

/** The app in a share fragment, or null when it is not one. */
export async function decodeShare(fragment: string): Promise<{ title: string; html: string } | null> {
  const text = fragment.replace(/^#/, '');
  if (!text.startsWith('v1.') || text.length > SHARE_MAX) return null;
  try {
    const raw = await pipe(fromB64Url(text.slice(3)), new DecompressionStream('deflate-raw'));
    if (raw.length > BUILD_MAX_HTML * 4) return null;
    const value = JSON.parse(new TextDecoder().decode(raw)) as { t?: unknown; h?: unknown };
    if (typeof value.h !== 'string' || !value.h.trim()) return null;
    return { title: typeof value.t === 'string' ? value.t.slice(0, 120) : 'Shared app', html: value.h.slice(0, BUILD_MAX_HTML) };
  } catch {
    return null;
  }
}
