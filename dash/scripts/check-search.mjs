// Update "search": Private Web Search in the workspace. The switch, which models may search, the `:online` model id,
// citations read from `url_citation` annotations (JSON and stream), the demo gateway's fake sources and price, and the
// copy rules for the new text.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { createAnonymoClient, AnonymoApiError } from '../lib/anonymo/client.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';
import { usdToMusd } from '../lib/anonymo/money.ts';
import { canSearch, citationsOf, MAX_CITATIONS, onlineModel, safeLink, stripOnline, WEB_SEARCH_PRICE_USD } from '../lib/anonymo/search.ts';
import { parseUpdates, RELEASED, UPDATE_IDS, updateOn } from '../lib/anonymo/updates.ts';

const BASE = 'https://demo.anonymo.invalid';

async function funded(musd = 5_000_000) {
  const mock = createMockGateway({ delayMs: 0 });
  const { key } = await createAnonymoClient({ baseUrl: BASE, fetch: mock.fetch }).createKey();
  const client = createAnonymoClient({ baseUrl: BASE, fetch: mock.fetch, key });
  if (musd) await mock.simulateDeposit(key, 'rhc', 'USDG', musd);
  return { mock, client, key };
}

test('search is an optional update: off by default, on with its switch or "all", shown in demo, not released', () => {
  assert.ok(UPDATE_IDS.includes('search'));
  assert.equal(RELEASED.has('search'), false);
  assert.equal(parseUpdates().has('search'), false);
  assert.equal(parseUpdates('history,usage').has('search'), false);
  assert.equal(parseUpdates('search').has('search'), true);
  assert.equal(parseUpdates('all').has('search'), true);
  assert.equal(updateOn('search', true), true);
  const source = readFileSync(new URL('../lib/anonymo/updates.ts', import.meta.url), 'utf8');
  assert.match(source, /\/\/ {3}search {4}in chat/);
});

test('sealed, council and :private models never search', () => {
  for (const m of ['anonymo-sealed', 'anonymo-council', 'some/model:private', 'some/model:private:nitro', '']) {
    assert.equal(canSearch(m), false, m);
    assert.equal(onlineModel(m, true), m, m);
  }
  for (const m of ['anonymo-1', 'anonymo-rp', 'some/model', 'some/model:nitro']) assert.equal(canSearch(m), true, m);
  assert.equal(onlineModel('anonymo-1', true), 'anonymo-1:online');
  assert.equal(onlineModel('anonymo-1', false), 'anonymo-1');
  assert.equal(onlineModel('anonymo-1:online', true), 'anonymo-1:online');
});

test('stripOnline undoes onlineModel for any model id', () => {
  fc.assert(fc.property(fc.stringMatching(/^[a-z0-9-]{1,12}(\/[a-z0-9.-]{1,12})?(:(nitro|floor|free))?$/), fc.boolean(), (m, on) => {
    const sent = onlineModel(m, on);
    assert.deepEqual(stripOnline(sent), { model: m, online: on && sent !== m });
  }));
});

test('citations: url_citation only, http(s) links only, no repeats, at most ten', () => {
  const list = [
    { type: 'url_citation', url_citation: { url: 'https://example.org/a', title: 'A' } },
    { type: 'url_citation', url_citation: { url: 'https://example.org/a', title: 'A again' } },
    { type: 'url_citation', url_citation: { url: 'javascript:alert(1)', title: 'bad' } },
    { type: 'url_citation', url_citation: { url: 'data:text/html,hi', title: 'bad' } },
    { type: 'file_citation', file_citation: { file_id: 'x' } },
    { type: 'url_citation', url_citation: { url: 'http://example.net/b' } },
    null,
    'text',
  ];
  assert.deepEqual(citationsOf(list), [
    { url: 'https://example.org/a', title: 'A' },
    { url: 'http://example.net/b', title: 'example.net' },
  ]);
  assert.deepEqual(citationsOf('nope'), []);
  const many = Array.from({ length: 20 }, (_, i) => ({ type: 'url_citation', url_citation: { url: `https://example.org/${i}`, title: `${i}` } }));
  assert.equal(citationsOf(many).length, MAX_CITATIONS);
  assert.equal(safeLink('ftp://example.org/x'), null);
});

test('demo: a :online stream carries citations and is charged the search price once', async () => {
  const { client } = await funded();
  const before = usdToMusd((await client.balance()).balance_usd);
  const result = await client.chat({ model: onlineModel('anonymo-1', true), messages: [{ role: 'user', content: 'Which river runs through the old town?' }] });
  assert.match(result.content, /\[1\]/);
  assert.equal(result.citations?.length, 3);
  assert.ok(result.citations.every((c) => c.url.startsWith('https://')));
  assert.ok(result.receipt);
  const cost = usdToMusd(result.receipt.cost);
  assert.ok(cost >= usdToMusd(WEB_SEARCH_PRICE_USD), 'the receipt includes the search');
  const after = usdToMusd((await client.balance()).balance_usd);
  assert.equal(before - after, cost);
});

test('demo: the same chat without search has no citations and costs less', async () => {
  const { client } = await funded();
  const plain = await client.chat({ model: 'anonymo-1', messages: [{ role: 'user', content: 'Which river runs through the old town?' }] });
  const searched = await client.chat({ model: 'anonymo-1:online', messages: [{ role: 'user', content: 'Which river runs through the old town?' }] });
  assert.equal(plain.citations, undefined);
  assert.ok(usdToMusd(searched.receipt.cost) - usdToMusd(plain.receipt.cost) >= usdToMusd(WEB_SEARCH_PRICE_USD) - 5);
});

test('demo: sealed and council refuse a search before anything is charged', async () => {
  const { client } = await funded();
  await assert.rejects(client.chat({ model: 'anonymo-sealed:online', messages: [{ role: 'user', content: 'hi' }] }), (e) => e instanceof AnonymoApiError && e.status === 409);
  await assert.rejects(client.chat({ model: 'anonymo-council:online', messages: [{ role: 'user', content: 'hi' }] }), (e) => e instanceof AnonymoApiError && e.status === 400);
});

test('client: JSON replies carry citations from message.annotations', async () => {
  const fake = async () => Response.json({
    id: 'req_demo', object: 'chat.completion', model: 'anonymo-council',
    choices: [{ index: 0, message: { role: 'assistant', content: 'See [1].', annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.org/x', title: 'X', start_index: 4, end_index: 7 } }] }, finish_reason: 'stop' }],
  });
  const client = createAnonymoClient({ baseUrl: BASE, fetch: fake, key: 'anm_live_sample' });
  const result = await client.chat({ model: 'anonymo-council', messages: [{ role: 'user', content: 'x' }] });
  assert.deepEqual(result.citations, [{ url: 'https://example.org/x', title: 'X' }]);
});

test('copy: the new text keeps the copy rules', () => {
  const files = ['../components/dashboard/web-sources.tsx', '../lib/anonymo/search.ts', '../lib/anonymo/mock/search.ts', '../components/docs-view.tsx'];
  const banned = /\b(unfiltered|no rules|anything goes|yield|invest|profit|APY|moon)\b/i;
  for (const f of files) {
    const text = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.equal(banned.test(text), false, f);
  }
  const docs = readFileSync(new URL('../components/docs-view.tsx', import.meta.url), 'utf8');
  assert.match(docs, /id="search"/);
  assert.match(docs, /:online/);
  assert.match(docs, /WEB_SEARCH_PRICE_USD/);
});
