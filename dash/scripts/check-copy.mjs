// Product rules the dashboard's source must keep (Overview §10, Backend §2 "no email, no identity fields", the brief's
// "no analytics that send identifiers"), plus a guard that no Conclave branding comes back.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import nextConfig from '../next.config.ts';

const root = new URL('..', import.meta.url).pathname;
// The Solana deposit verifier and the secret guard are kept only as reference code for CI checks; they render no copy.
const SKIP = new Set(['node_modules', 'dist', '.vinext', '.wrangler', '.next', 'server', 'scripts']);
const SKIP_FILES = new Set(['lib/guards/wordlists.ts', 'lib/anonymo/card.ts']);

function files(dir = root) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (/\.(tsx?|css|json|md|svg)$/.test(name) && !SKIP_FILES.has(relative(root, path))) out.push(path);
  }
  return out;
}
const sources = files()
  .filter((f) => !f.endsWith('pnpm-lock.yaml'))
  .map((f) => ({ file: relative(root, f), text: readFileSync(f, 'utf8') }));

function hits(pattern, allow = () => false) {
  const found = [];
  for (const { file, text } of sources) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (pattern.test(line) && !allow(file, lines, i)) found.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  return found;
}

void test('banned phrases from Overview §10 never appear', () => {
  // README explains the rule by quoting the phrases; it is documentation, not product copy.
  const notReadme = (file) => file === 'README.md';
  assert.deepEqual(hits(/no rules|anything goes|unfiltered/i, notReadme), []);
  assert.deepEqual(hits(/powered by venice/i, notReadme), []);
});

void test('no profit or investment language about the token', () => {
  const codeYield = (_f, lines, i) => /^\s*yield\b/.test(lines[i]);
  assert.deepEqual(hits(/\b(invest(ment|ing|or)?s?|profits?|APY|APR|yield|passive income|moon)\b/i, (f, l, i) => f === 'README.md' || codeYield(f, l, i)), []);
});

void test('"fully private" appears only next to anonymo-sealed and its attestation', () => {
  const nearSealed = (_file, lines, i) => {
    const around = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
    return /sealed/i.test(around) && /attest/i.test(around);
  };
  assert.deepEqual(hits(/fully private/i, (f, l, i) => f === 'README.md' || nearSealed(f, l, i)), []);
});

void test('no email, name, phone or identity fields anywhere', () => {
  assert.deepEqual(hits(/type=["']email["']|type=["']tel["']/i), []);
  assert.deepEqual(hits(/autoComplete=["'](email|name|given-name|family-name|tel|username|bday)/i), []);
  assert.deepEqual(hits(/placeholder=["'][^"']*(e-?mail|your name|phone|date of birth)/i), []);
});

void test('no analytics or tracking scripts', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.deepEqual(deps.filter((d) => /analytics|posthog|segment|mixpanel|amplitude|plausible|sentry|datadog|hotjar|gtag/i.test(d)), []);
  assert.deepEqual(hits(/googletagmanager|google-analytics|gtag\(|posthog|mixpanel|plausible\.io|sentry/i), []);
});

void test('public reading pages instruct the edge to leave their HTML intact', async () => {
  const rules = await nextConfig.headers();
  for (const route of ['/', '/docs', '/brief', '/whitepaper', '/roadmap']) {
    const rule = rules.find((entry) => entry.source === route);
    const cache = rule?.headers.find((header) => header.key.toLowerCase() === 'cache-control');
    assert.ok(cache?.value.split(',').map((part) => part.trim()).includes('no-transform'), route);
  }
});

void test('adults only is stated on every surface', () => {
  const read = (f) => readFileSync(join(root, f), 'utf8');
  assert.match(read('app/layout.tsx'), /<AgeGate \/>/, 'the 18+ notice is on entry to every page');
  assert.match(read('components/site-chrome.tsx'), /<AdultsOnly \/>/, 'public pages');
  assert.match(read('components/dashboard/workspace-shell.tsx'), /<AdultsOnly compact \/>/, 'workspace top bar');
  assert.match(read('components/age-gate.tsx'), /18 or older/);
});

void test('no Conclave branding or assets remain in the app', () => {
  // Provenance comments may name where the layout came from; nothing a visitor sees may.
  const comment = (_f, lines, i) => /^\s*(\/\/|\/\*|\*)/.test(lines[i]) || /^\s*The workspace keeps the Conclave layout/.test(lines[i]);
  assert.deepEqual(hits(/conclave/i, (f, l, i) => f === 'README.md' || comment(f, l, i)), []);
});

void test('the Venice badge is behind its flag and says "Built in Venice"', () => {
  const brand = readFileSync(join(root, 'components/brand.tsx'), 'utf8');
  assert.match(brand, /if \(!VENICE_BADGE\) return null/);
  assert.match(brand, /Built in Venice/);
});
