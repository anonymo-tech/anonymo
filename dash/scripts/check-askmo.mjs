import assert from 'node:assert/strict';
import test from 'node:test';
import { ASK_TOPICS, answerSections } from '../lib/anonymo/askmo.ts';
import { API_PATHS, createAnonymoClient } from '../lib/anonymo/client.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';
import { setupReturn } from '../lib/anonymo/setup-return.ts';
import { parseUpdates, updateOn } from '../lib/anonymo/updates.ts';

const baseUrl = 'https://demo.anonymo.invalid';

test('Ask Mo is off by default, independently switchable, and available in demo', () => {
  assert.equal(parseUpdates().has('askmo'), false);
  assert.equal(parseUpdates('search,sidebyside').has('askmo'), false);
  assert.equal(parseUpdates('askmo').has('askmo'), true);
  assert.equal(updateOn('askmo', true), true);
  assert.equal(Object.keys(ASK_TOPICS).length, 6);
  assert.deepEqual(setupReturn('/dashboard/ask'), { href: '/dashboard/ask', label: 'Ask Mo', needsCredit: true });
  assert.equal(setupReturn('/dashboard/ask?question=private'), null);
});

test('the browser sends a question and topic to Ask Mo and gets a sourced answer with a receipt', async () => {
  const mock = createMockGateway({ delayMs: 0 });
  const { key } = await createAnonymoClient({ baseUrl, fetch: mock.fetch }).createKey();
  await mock.simulateDeposit(key, 'rhc', 'USDG', 5_000_000);
  const calls = [];
  const client = createAnonymoClient({ baseUrl, key, fetch: (url, init) => {
    calls.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
    return mock.fetch(url, init);
  } });
  const request = { question: 'What matters before making a first offer?', topic: 'negotiation' };
  const answer = await client.askMo(request);
  assert.match(answer.text, /\[1\]/);
  assert.ok(answer.sources.length);
  assert.equal(answer.receiptId, answer.receipt.request_id);
  assert.deepEqual(answerSections(answer.text).map(({ heading }) => heading), [undefined, 'What a professional would check', 'Region notes']);

  const opinion = await client.secondOpinion(request);
  assert.equal(opinion.council.mode, 'select');
  assert.equal(new Set(opinion.council.proposers.map(({ family }) => family)).size, 3);
  assert.ok(opinion.council.comparison.agree);
  assert.ok(opinion.council.comparison.disagree);
  assert.ok(opinion.receiptId);
  assert.notEqual(opinion.receiptId, answer.receiptId);
  assert.deepEqual(calls, [{ path: API_PATHS.askMo, body: request }, { path: API_PATHS.secondOpinion, body: request }]);
});
