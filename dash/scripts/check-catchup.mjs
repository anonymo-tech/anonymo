// Update "catchup": when to offer a recap, the recap request, and how a recap starts the next chat.
import assert from 'node:assert/strict';
import test from 'node:test';
import { canRecap, estimateTokens, MIN_TURNS, RECAP_INSTRUCTION, recapContext, recapRequest, SUGGEST_TOKENS, SUGGEST_TURNS, suggestRecap, threadTokens, tokenLabel } from '../lib/anonymo/catchup.ts';
import { toSaved } from '../lib/anonymo/history.ts';
import { createAnonymoClient } from '../lib/anonymo/client.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';

const t = (prompt, content = '') => ({ prompt, content });

test('offered after a few turns, suggested once the thread is long in turns or tokens', () => {
  assert.equal(canRecap(Array(MIN_TURNS - 1).fill(t('a', 'b'))), false);
  assert.equal(canRecap(Array(MIN_TURNS).fill(t('a', 'b'))), true);
  assert.equal(suggestRecap(Array(SUGGEST_TURNS - 1).fill(t('a', 'b'))), false);
  assert.equal(suggestRecap(Array(SUGGEST_TURNS).fill(t('a', 'b'))), true);
  assert.equal(suggestRecap([t('x'.repeat(SUGGEST_TOKENS * 4))]), true);
  assert.equal(threadTokens([t('abcd', 'abcdefgh')]), 3);
  assert.equal(estimateTokens(''), 0);
});

test('the recap request is the thread plus one instruction; the recap starts the next chat as context', () => {
  const thread = [{ role: 'user', content: 'Hi Mara' }, { role: 'assistant', content: 'Hello.' }];
  const req = recapRequest(thread);
  assert.deepEqual(req.slice(0, 2), thread);
  assert.deepEqual(req[2], { role: 'user', content: RECAP_INSTRUCTION });
  assert.match(RECAP_INSTRUCTION, /at most 350 words/);
  const ctx = recapContext('  Mara is a smuggler.  ');
  assert.equal(ctx.length, 2);
  assert.equal(ctx[0].role, 'user');
  assert.match(ctx[0].content, /recap of our earlier conversation[\s\S]*\n\nMara is a smuggler\.$/);
  assert.equal(ctx[1].role, 'assistant');
});

test('a recap turn keeps its mark when the chat is saved on the device', () => {
  const base = { id: 'r', model: 'anonymo-1', prompt: 'Recap of “x”', attachment: null, character: null, content: 'notes', status: 'done', error: null, receiptId: null, councilMode: null };
  assert.equal(toSaved([{ ...base, recap: true }])[0].recap, true);
  assert.equal('recap' in toSaved([base])[0], false);
});

test('labels', () => {
  assert.equal(tokenLabel(950), '950 tokens');
  assert.equal(tokenLabel(1234), '1.2k tokens');
  assert.equal(tokenLabel(23456), '23k tokens');
});

test('a recap is an ordinary chat request that the gateway answers and charges', async () => {
  const mock = createMockGateway({ delayMs: 0 });
  const created = await createAnonymoClient({ baseUrl: 'https://demo.anonymo.invalid', fetch: mock.fetch }).createKey();
  const client = createAnonymoClient({ baseUrl: 'https://demo.anonymo.invalid', fetch: mock.fetch, key: created.key });
  await mock.simulateDeposit(created.key, 'rhc', 'USDG', 2_000_000);
  const before = (await client.balance()).available_usd;
  const res = await client.chat({ model: 'anonymo-1', messages: recapRequest([{ role: 'user', content: 'Tell me a story' }, { role: 'assistant', content: 'Once…' }]) });
  assert.ok(res.content.length > 0 && res.receiptId);
  assert.match(res.content, /^Recap so far[\s\S]*- Tell me a story/, 'the demo gateway answers a recap request with recap notes');
  assert.ok((await client.balance()).available_usd < before);
});
