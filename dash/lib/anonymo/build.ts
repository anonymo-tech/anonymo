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

/** A typical build (about 6,000 tokens of reply). */
export function buildTypicalUsd(pricing: Pricing, inputChars: number): number | null {
  return buildCeilingUsd(pricing, inputChars, 6_000);
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

// ---- demo -------------------------------------------------------------------------------------------------------

/** Demo mode's app: a small working game, so the page can be tried with no key. */
export const DEMO_APP = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Catch the Stars</title>
<style>html,body{margin:0;height:100%;background:#120e1c;color:#f5efe6;font:16px system-ui,sans-serif;overflow:hidden}
canvas{display:block;width:100%;height:100%}#hud{position:fixed;top:12px;left:0;right:0;text-align:center;font-weight:700;letter-spacing:.04em}
#start{position:fixed;inset:0;display:grid;place-items:center;text-align:center;background:#120e1cdd}h1{margin:0 0 8px;font-size:clamp(28px,6vw,54px)}</style></head>
<body><canvas id="c"></canvas><div id="hud">Score 0</div><div id="start"><div><h1>Catch the Stars</h1><p>Move with ← → or your finger. Tap or press any key.</p></div></div>
<script>const c=document.getElementById('c'),x=c.getContext('2d'),hud=document.getElementById('hud'),st=document.getElementById('start');
let W,H,p,stars,score,run=false,miss;function fit(){W=c.width=innerWidth;H=c.height=innerHeight}addEventListener('resize',fit);fit();
function reset(){p={x:W/2,w:90};stars=[];score=0;miss=0;run=true;st.style.display='none'}
const keys={};addEventListener('keydown',e=>{keys[e.key]=1;if(!run)reset()});addEventListener('keyup',e=>keys[e.key]=0);
addEventListener('pointerdown',e=>{if(!run)reset();p.x=e.clientX});addEventListener('pointermove',e=>{if(e.buttons||e.pointerType==='touch')p.x=e.clientX});
function loop(){requestAnimationFrame(loop);x.fillStyle='#120e1c';x.fillRect(0,0,W,H);if(!run)return;
if(keys.ArrowLeft)p.x-=9;if(keys.ArrowRight)p.x+=9;p.x=Math.max(45,Math.min(W-45,p.x));
if(Math.random()<.04)stars.push({x:Math.random()*W,y:-20,v:2+Math.random()*3+score/20});
for(const s of stars){s.y+=s.v;x.font='28px serif';x.fillText('⭐',s.x-14,s.y)}
stars=stars.filter(s=>{if(s.y>H-40&&s.y<H-10&&Math.abs(s.x-p.x)<p.w/2){score++;return false}if(s.y>H){miss++;return false}return true});
x.fillStyle='#ff6b4a';x.fillRect(p.x-p.w/2,H-30,p.w,14);hud.textContent='Score '+score+'   Missed '+miss+'/5';
if(miss>=5){run=false;st.style.display='grid';st.querySelector('p').textContent='Score '+score+'. Tap or press any key to play again.'}}loop();</script></body></html>`;
