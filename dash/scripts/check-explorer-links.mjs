import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import bs58 from 'bs58';
import sharp from 'sharp';
import ts from 'typescript';
import { runInNewContext } from 'node:vm';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderMetadataToHtml, ViewportHead, mergeViewport } from '../node_modules/vinext/dist/shims/metadata.js';
import {
  parseExplorerLinks,
  explorerNetworkStatus,
  sharedComposerText,
  dashboardLinkInput,
} from '../lib/solana/explorer-links.ts';

const signature = bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => i + 1));
const other = bs58.encode(new Uint8Array(64).fill(12));
const address = bs58.encode(new Uint8Array(32).fill(8));
const reference = (cluster = 'mainnet-beta', source = 'link') => ({ signature, cluster, source });
const allOn = { explorerLinks: true, explainer: true, shareTarget: true };

void test('finds canonical 64-byte signatures in prose, including leading zero bytes', () => {
  assert.deepEqual(parseExplorerLinks(`Please explain (${signature}).`), [reference('mainnet-beta', 'signature')]);
  for (const bytes of [new Uint8Array(64), Uint8Array.from({ length: 64 }, (_, i) => i)]) {
    const value = bs58.encode(bytes);
    assert.equal(parseExplorerLinks(value)[0]?.signature, value);
  }
});

void test('ignores wallet addresses, mints, malformed and wrong-length encodings', () => {
  for (const value of [address, '0'.repeat(88), 'O'.repeat(88), 'I'.repeat(88), 'l'.repeat(88),
    bs58.encode(new Uint8Array(63).fill(9)), bs58.encode(new Uint8Array(65).fill(9)),
    `prefix${signature}suffix`, `_${signature}`, '1'.repeat(89), 'z'.repeat(88)]) {
    assert.deepEqual(parseExplorerLinks(value), [], value);
  }
});

void test('accepts the three explorer transaction paths and preserves cluster query parameters', () => {
  for (const host of ['solscan.io', 'explorer.solana.com', 'solana.fm']) {
    assert.deepEqual(parseExplorerLinks(`https://${host}/tx/${signature}`), [reference()]);
    assert.deepEqual(parseExplorerLinks(`(${host}/tx/${signature}?cluster=devnet).`), [reference('devnet')]);
    assert.deepEqual(parseExplorerLinks(`https://${host}/tx/${signature}/?foo=bar&cluster=testnet#details`), [reference('testnet')]);
    assert.deepEqual(parseExplorerLinks(`https://${host}/tx/${signature}?cluster=mainnet`), [reference()]);
  }
});

void test('does not extract signatures from untrusted URLs or unsupported explorer paths', () => {
  for (const value of [
    `https://solscan.io.evil.example/tx/${signature}`,
    `https://evil.example/tx/${signature}`,
    `https://solscan.io@evil.example/tx/${signature}`,
    `https://demo-account@solscan.io/tx/${signature}`,
    `https://solscan.io:8443/tx/${signature}`,
    `https://solscan.io/account/${signature}`,
    `https://solscan.io/tx/${signature}/extra`,
    `ftp://solscan.io/tx/${signature}`,
    `https://solscan.io/tx/${address}`,
    `https://solana.fm/address/${address}?signature=${signature}`,
  ]) assert.deepEqual(parseExplorerLinks(value), [], value);
});

void test('counts occurrences so multiple references never look like a single transaction', () => {
  const matches = parseExplorerLinks(`${signature} https://solscan.io/tx/${other}?cluster=devnet ${signature}`);
  assert.equal(matches.length, 3);
  assert.deepEqual(matches.map((item) => item.signature), [signature, other, signature]);
});

void test('blocks mismatched and unknown link networks without inferring a network from a bare signature', () => {
  assert.equal(explorerNetworkStatus(reference('devnet'), 'devnet'), 'ready');
  assert.equal(explorerNetworkStatus(reference('devnet'), 'mainnet-beta'), 'different-cluster');
  assert.equal(explorerNetworkStatus(reference(), 'devnet'), 'different-cluster');
  assert.equal(explorerNetworkStatus(reference('custom'), 'mainnet-beta'), 'different-cluster');
  assert.equal(explorerNetworkStatus(reference(), null), 'unconfigured');
  assert.equal(explorerNetworkStatus(reference('mainnet-beta', 'signature'), 'devnet'), 'ready');
});

void test('reads GET share fields as unmodified plain text in order', () => {
  const params = new URLSearchParams({ title: 'Shared research', text: 'Review this', url: 'https://example.com/?x=1&y=2' });
  assert.equal(sharedComposerText(params), 'Shared research\n\nReview this\n\nhttps://example.com/?x=1&y=2');
  assert.equal(sharedComposerText(new URLSearchParams()), '');
});

void test('query and share inputs obey both explorer switches, with share cleanup gated independently', () => {
  const params = new URLSearchParams({ explain: signature, title: 'Research', text: 'Keep this draft', url: `https://solscan.io/tx/${other}`, view: 'chat' });
  const input = dashboardLinkInput(params, allOn);
  assert.equal(input.transaction?.signature, signature);
  assert.deepEqual(input.removeParams, ['explain', 'title', 'text', 'url']);
  assert.equal(params.get('view'), 'chat');
  for (const flags of [
    { explorerLinks: false, explainer: true, shareTarget: true },
    { explorerLinks: true, explainer: false, shareTarget: true },
  ]) {
    const disabled = dashboardLinkInput(params, flags);
    assert.equal(disabled.transaction, null);
    assert.equal(disabled.sharedText, sharedComposerText(params));
    assert.deepEqual(disabled.removeParams, ['title', 'text', 'url']);
  }
  assert.deepEqual(dashboardLinkInput(params, { explorerLinks: false, explainer: false, shareTarget: false }), {
    transaction: null, sharedText: '', removeParams: [],
  });
  const explorerOnly = dashboardLinkInput(params, { ...allOn, shareTarget: false });
  assert.equal(explorerOnly.sharedText, '');
  assert.deepEqual(explorerOnly.removeParams, ['explain']);
});

void test('opens one shared reference, while arbitrary or ambiguous shares remain draft text', () => {
  for (const field of ['title', 'text', 'url']) {
    const input = dashboardLinkInput(new URLSearchParams({ [field]: `https://explorer.solana.com/tx/${signature}?cluster=devnet` }), allOn);
    assert.deepEqual(input.transaction, reference('devnet'));
  }
  const link = `https://solscan.io/tx/${signature}?cluster=devnet`;
  assert.deepEqual(dashboardLinkInput(new URLSearchParams({ text: link, url: link }), allOn).transaction, reference('devnet'));
  for (const text of ['Review this later', address, `${signature} ${other}`]) {
    const input = dashboardLinkInput(new URLSearchParams({ text }), allOn);
    assert.equal(input.transaction, null);
    assert.equal(input.sharedText, text);
  }
});

void test('vinext renders install metadata only with shareTarget enabled, preserving the disabled head', async () => {
  const source = await readFile(new URL('../app/layout.tsx', import.meta.url), 'utf8');
  const file = ts.createSourceFile('layout.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = file.statements.filter((statement) => ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some((declaration) => ['metadata', 'viewport'].includes(declaration.name.getText(file))),
  ).map((statement) => statement.getText(file)).join('\n');
  const code = ts.transpileModule(declarations, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const head = (enabled) => {
    const context = { exports: {}, featureOn: (name) => name === 'shareTarget' && enabled };
    runInNewContext(code, context);
    const { metadata, viewport } = context.exports;
    return renderMetadataToHtml(metadata) + renderToStaticMarkup(ViewportHead({ viewport: mergeViewport([viewport]) }));
  };
  const off = head(false);
  assert.doesNotMatch(off, /rel="manifest"|apple-touch-icon|theme-color/);
  const context = { exports: {}, featureOn: () => false };
  runInNewContext(code, context);
  const { title, description } = context.exports.metadata;
  const baseline = renderMetadataToHtml({ title, description, icons: { icon: '/favicon.svg' } }) +
    renderToStaticMarkup(ViewportHead({ viewport: mergeViewport([]) }));
  assert.equal(off, baseline);
  const on = head(true);
  assert.match(on, /rel="manifest" href="\/manifest.webmanifest"/);
  assert.match(on, /rel="apple-touch-icon" href="\/app-icons\/apple-touch-icon.png"/);
  assert.match(on, /name="theme-color" content="#C10A05"/);
});

void test('manifest declares the GET target and correctly sized, opaque app icons', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'Conclave');
  assert.equal(manifest.short_name, 'Conclave');
  assert.equal(manifest.start_url, '/dashboard');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.background_color, '#ffffff');
  assert.equal(manifest.theme_color, '#C10A05');
  assert.deepEqual(manifest.share_target, {
    action: '/dashboard', method: 'GET', params: { title: 'title', text: 'text', url: 'url' },
  });
  for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['maskable-512.png', 512], ['apple-touch-icon.png', 180]]) {
    const icon = sharp(new URL(`../public/app-icons/${name}`, import.meta.url).pathname);
    const metadata = await icon.metadata();
    assert.equal(metadata.width, size);
    assert.equal(metadata.height, size);
    assert.equal((await icon.stats()).isOpaque, true);
    // Every pixel outside the central 80% circle must remain background paper.
    if (name === 'maskable-512.png') {
      const { data, info } = await icon.removeAlpha().raw().toBuffer({ resolveWithObject: true });
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if (Math.hypot(x - size / 2, y - size / 2) <= size * 0.4) continue;
        const index = (y * size + x) * info.channels;
        assert.deepEqual([...data.subarray(index, index + 3)], [193, 10, 5]);
      }
    }
  }
});
