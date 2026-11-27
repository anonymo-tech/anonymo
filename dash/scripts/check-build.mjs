// Updates "build" and "research": the app sandbox, share links, the research plan, citation renumbering, the report
// reader and the price ceilings.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUILD_CSP,
  BUILD_SANDBOX,
  buildCeilingUsd,
  buildMessages,
  buildTitle,
  decodeShare,
  encodeShare,
  extractHtml,
  isComplete,
  roughUsd,
  sandboxed,
} from '../lib/anonymo/build.ts';
import { DEMO_APP, DEMO_REPORT } from '../lib/anonymo/demo-outputs.ts';
import { blocksOf, inlineOf, parsePlan, readMessages, renumber, reportMessages, researchCeilingUsd, DEPTH_SEARCHES } from '../lib/anonymo/research.ts';
import { RELEASED, UPDATE_IDS, parseUpdates } from '../lib/anonymo/updates.ts';

test('build and research are optional updates, off unless switched on', () => {
  for (const id of ['build', 'research']) {
    assert.ok(UPDATE_IDS.includes(id));
    assert.equal(RELEASED.has(id), false);
    assert.equal(parseUpdates('').has(id), false);
    assert.equal(parseUpdates(id).has(id), true);
    assert.equal(parseUpdates('all').has(id), true);
  }
});

test('extractHtml keeps only the document, with or without fences and chatter', () => {
  assert.equal(extractHtml('no app here'), null);
  const doc = '<!doctype html><html><body>hi</body></html>';
  assert.equal(extractHtml(doc), doc);
  assert.equal(extractHtml('Sure! Here it is:\n```html\n' + doc + '\n```\nEnjoy.'), doc);
  assert.equal(extractHtml('<html lang="en"><body>x</body></html>'), '<html lang="en"><body>x</body></html>');
  const cut = '<!doctype html><html><body><script>let a=';
  assert.equal(extractHtml(cut), cut);
  assert.equal(isComplete(doc), true);
  assert.equal(isComplete(cut), false);
});

test('the sandbox policy comes before anything the app wrote and blocks the network', () => {
  const evil = '<!doctype html><script>fetch("https://x.test")</script><html><head><meta http-equiv="refresh" content="0;url=https://x.test"></head></html>';
  const out = sandboxed(evil);
  const policy = out.indexOf('Content-Security-Policy');
  assert.ok(policy > 0 && policy < out.indexOf('<script>'), 'policy is parsed before the first script');
  assert.equal((out.match(/<!doctype/gi) ?? []).length, 1);
  assert.doesNotMatch(out, /http-equiv="refresh"/i);
  assert.match(BUILD_CSP, /connect-src 'none'/);
  assert.match(BUILD_CSP, /default-src 'none'/);
  assert.match(BUILD_CSP, /form-action 'none'/);
  assert.doesNotMatch(BUILD_SANDBOX, /allow-same-origin|allow-top-navigation|allow-popups|allow-forms/);
});

test('share links round-trip and reject anything else', async () => {
  const app = { title: 'Frog Snake', html: DEMO_APP };
  const link = await encodeShare(app);
  assert.match(link, /^v1\.[A-Za-z0-9_-]+$/);
  assert.ok(link.length < DEMO_APP.length, 'compressed');
  assert.deepEqual(await decodeShare(`#${link}`), app);
  assert.equal(await decodeShare('#v2.abc'), null);
  assert.equal(await decodeShare('#v1.!!!'), null);
  assert.equal(await decodeShare(''), null);
});

test('a change sends the current app and asks for the whole document back', () => {
  const first = buildMessages('a snake game', null);
  assert.equal(first.length, 2);
  const change = buildMessages('make it faster', DEMO_APP);
  assert.equal(change.length, 2);
  assert.ok(change[1].content.includes(DEMO_APP));
  assert.match(change[1].content, /whole updated HTML/);
  assert.equal(buildTitle(DEMO_APP, 'x'), 'Frog Snake – Catch the Flies');
  assert.equal(isComplete(DEMO_APP), true);
  for (const n of DEMO_REPORT.report.match(/\[(\d+)\]/g) ?? []) assert.ok(Number(n.slice(1, -1)) <= DEMO_REPORT.sources.length, `demo cites ${n}`);
  assert.equal(buildTitle(null, 'a game'), 'a game');
});

test('price ceilings use list prices and say unknown when there are none', () => {
  const pricing = { prompt: '0.000002', completion: '0.00001' };
  assert.ok(Math.abs(buildCeilingUsd(pricing, 3500, 16000) - (1000 * 0.000002 + 16000 * 0.00001)) < 1e-9);
  assert.equal(buildCeilingUsd(undefined, 100), null);
  assert.equal(buildCeilingUsd({ prompt: '-1', completion: '-1' }, 100), null);
  assert.equal(roughUsd(null), 'price unknown');
  assert.equal(roughUsd(0.004), 'under $0.01');
  assert.equal(roughUsd(0.163), '$0.16');
  const cheap = { prompt: '0.00000035', completion: '0.0000014' };
  const deep = researchCeilingUsd('deep', cheap, cheap);
  assert.ok(deep > researchCeilingUsd('quick', cheap, cheap));
  assert.ok(deep > DEPTH_SEARCHES.deep * 0.005 && deep < 0.2, `deep report ceiling ${deep}`);
});

test('a read searches for the search words only: they are the one and last user message', () => {
  const m = readMessages('my bigger question', 'cheap flights tokyo');
  assert.deepEqual(m.map((x) => x.role), ['system', 'user']);
  assert.equal(m[1].content, 'cheap flights tokyo');
  assert.match(m[0].content, /my bigger question/);
});

test('the plan is read from JSON, from lines, or falls back to the question', () => {
  assert.deepEqual(parsePlan('["a b c", "d e f", "a b c"]', 4, 'q'), ['a b c', 'd e f']);
  assert.deepEqual(parsePlan('Here:\n1. first search here\n2. second one here', 4, 'q'), ['first search here', 'second one here']);
  assert.deepEqual(parsePlan('```json\n["one two", "three four", "five six"]\n```', 2, 'q'), ['one two', 'three four']);
  assert.deepEqual(parsePlan('', 4, 'my whole question'), ['my whole question']);
});

test('each search\'s [n] marks move to the report\'s shared numbering', () => {
  const all = [];
  const a = renumber({ search: 's1', notes: '- fact [1]\n- other [2]', sources: [{ url: 'https://a.test/', title: 'A' }, { url: 'https://b.test/', title: 'B' }] }, all);
  const b = renumber({ search: 's2', notes: '- again [2] and [1] and [9]', sources: [{ url: 'https://c.test/', title: 'C' }, { url: 'https://a.test/', title: 'A' }] }, all);
  assert.equal(a, '- fact [1]\n- other [2]');
  assert.equal(b, '- again [1] and [3] and ');
  assert.deepEqual(all.map((s) => s.url), ['https://a.test/', 'https://b.test/', 'https://c.test/']);
  const { sources, messages } = reportMessages('q', [
    { search: 's1', notes: '- fact [1]', sources: [{ url: 'javascript:alert(1)', title: 'bad' }, { url: 'https://ok.test/', title: 'ok' }] },
    { search: 's2', notes: 'No useful results.', sources: [{ url: 'https://unread.test/', title: 'unread' }] },
    { search: 's3', notes: '  ', sources: [{ url: 'https://empty.test/', title: 'empty' }] },
  ]);
  assert.deepEqual(sources.map((s) => s.url), ['https://ok.test/']);
  assert.doesNotMatch(messages[1].content, /s2/);
});

test('the report reader handles headings, lists, tables, bold and citations, and no HTML', () => {
  const blocks = blocksOf('## Short answer\nYes **really** [2].\n\n- one [1]\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>x</script>');
  assert.deepEqual(blocks.map((b) => b.kind), ['h', 'p', 'ul', 'table', 'p']);
  assert.deepEqual(blocks[3], { kind: 'table', head: ['A', 'B'], rows: [['1', '2']] });
  assert.equal(blocks[4].text, '<script>x</script>');
  assert.deepEqual(inlineOf('Yes **really** [2].'), [
    { kind: 'text', text: 'Yes ' },
    { kind: 'bold', text: 'really' },
    { kind: 'text', text: ' ' },
    { kind: 'cite', n: 2 },
    { kind: 'text', text: '.' },
  ]);
});
