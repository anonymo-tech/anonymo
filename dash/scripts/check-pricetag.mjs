// Update "pricetag": the estimate math (big threads, tiny prices), the worst-case bound, the per-chat limit, refused
// replies counted as $0, unknown prices, the limits kept on the device, and the demo gateway's part in it.
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { createAnonymoClient } from '../lib/anonymo/client.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';
import {
  GATEWAY_REPLY_CAP, MAX_LIMITS, TYPICAL_REPLY_TOKENS, attoToMusd, callSpread, chargeOf, chatSpend, checkLimit, estimateMessage,
  limitSlot, maxReplyTokens, musdToAtto, parseLimit, parseUsdAtto, priceLabel, ratesOf, readLimits, roundForDisplay, spentLabel,
  typicalPromptTokens, usdText, withLimit, worstPromptTokens,
} from '../lib/anonymo/pricetag.ts';
import { RELEASED, UPDATE_IDS, parseUpdates, updateOn } from '../lib/anonymo/updates.ts';

const BASE = 'https://demo.anonymo.invalid';
const ATTO = 10n ** 18n;
const model = (pricing, extra = {}) => ({ id: 'sample-model', context_length: 32_768, pricing, ...extra });
const ANONYMO_1 = model({ prompt: '0.00000045', completion: '0.0000018' });
const user = (content) => ({ role: 'user', content });
const receipt = (cost, refused = false, routes = []) => ({
  v: 'anonymo-receipt/1', request_id: `gen-${Math.random().toString(16).slice(2)}`, model_id: 'sample-model', routes, weights_hash: [],
  tokens: { in: 10, out: 20 }, cost, refused, sealed: false, ts: '2026-11-20T21:04:00.000Z',
});
const turn = (over = {}) => ({ status: 'done', content: 'An answer.', receiptId: null, receipt: null, ...over });
const paid = (cost) => { const r = receipt(cost); return turn({ receipt: r, receiptId: r.request_id }); };

test('pricetag has its own switch, ships off, and is on in demo', () => {
  assert.ok(UPDATE_IDS.includes('pricetag'));
  assert.equal(RELEASED.has('pricetag'), false);
  assert.equal(parseUpdates().has('pricetag'), false);
  assert.equal(parseUpdates('history,usage').has('pricetag'), false);
  assert.equal(parseUpdates('pricetag').has('pricetag'), true);
  assert.equal(parseUpdates('all').has('pricetag'), true);
  assert.equal(updateOn('pricetag', true), true);
});

test('USD decimal strings become exact atto-USD', () => {
  assert.equal(parseUsdAtto('0'), 0n);
  assert.equal(parseUsdAtto('1'), ATTO);
  assert.equal(parseUsdAtto('0.00000045'), 450_000_000_000n);
  assert.equal(parseUsdAtto('0.000000000000000001'), 1n);
  // Past 18 places it rounds up, so a tiny price is never read as free.
  assert.equal(parseUsdAtto('0.0000000000000000001'), 1n);
  assert.equal(parseUsdAtto('0.0000000000000000010'), 1n);
  for (const bad of ['-0.1', '1e-7', 'abc', '', '0x10', null, undefined, 0.0001]) assert.equal(parseUsdAtto(bad), null, String(bad));
  // 0.1 + 0.2 is exact here.
  assert.equal(attoToMusd(parseUsdAtto('0.1') + parseUsdAtto('0.2')), 300_000);
  assert.equal(attoToMusd(1n, 'up'), 1);
  assert.equal(attoToMusd(1n, 'nearest'), 0);
  assert.equal(attoToMusd(0n), 0);
});

test('an unknown price gives no estimate instead of a guess', () => {
  for (const m of [null, undefined, { id: 'x' }, model(undefined), model({}), model({ prompt: '0', completion: '0' }), model({ prompt: '0.000001' }),
    model({ prompt: 'n/a', completion: '0.000001' }), model({ prompt: '0.000001', completion: '0.000001', request: 'free' })]) {
    assert.equal(ratesOf(m), null);
    assert.deepEqual(estimateMessage({ model: m, messages: [user('Hello')] }), { known: false });
  }
  // A free prompt with a priced reply is a known price.
  assert.notEqual(ratesOf(model({ prompt: '0', completion: '0.000001' })), null);
});

test('the estimate for a short message, worked by hand', () => {
  const e = estimateMessage({ model: ANONYMO_1, messages: [user('x'.repeat(400))] });
  assert.equal(e.known, true);
  // About: 400/4 + 4 wrapper = 104 tokens in, a typical 500-token reply.
  assert.equal(e.tokensIn, 104);
  assert.equal(e.typicalOut, TYPICAL_REPLY_TOKENS);
  assert.equal(e.typical, 104n * 450_000_000_000n + 500n * 1_800_000_000_000n); // 946.8 micro-USD
  // Up to: (400 + 16) / 2 + 8 = 216 tokens in, the gateway's 16,384-token cap out.
  assert.equal(e.worstOut, GATEWAY_REPLY_CAP);
  assert.equal(e.worst, 216n * 450_000_000_000n + 16_384n * 1_800_000_000_000n);
  assert.equal(priceLabel(e.typical, 'nearest'), '$0.00095');
  assert.equal(priceLabel(e.worst, 'up'), '$0.03');
});

test('a big thread is priced exactly, with no float drift', () => {
  const messages = Array.from({ length: 10_000 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'y'.repeat(4_000) }));
  const big = { ...ANONYMO_1, context_length: 100_000_000 };
  const e = estimateMessage({ model: big, messages });
  const tokensIn = 10_000 * (1_000 + 4);
  assert.equal(e.tokensIn, tokensIn);
  assert.equal(e.typical, BigInt(tokensIn) * 450_000_000_000n + 500n * 1_800_000_000_000n);
  // $4.518 in and $0.0009 out: about $4.50 for the message, shown to two significant digits.
  assert.equal(attoToMusd(e.typical, 'nearest'), 4_518_900);
  assert.equal(priceLabel(e.typical, 'nearest'), '$4.50');
  assert.ok(e.worst > e.typical);
});

test('a big thread fills the context: the reply bound shrinks to the room left', () => {
  const messages = [user('z'.repeat(60_000))];
  const e = estimateMessage({ model: ANONYMO_1, messages });
  const highIn = worstPromptTokens(messages);
  assert.equal(e.worstOut, Math.min(GATEWAY_REPLY_CAP, 32_768 - highIn));
  // Past the context window there is still a one-token floor, as the gateway's maxOutputTokens has.
  assert.equal(maxReplyTokens(ANONYMO_1, 40_000), 1);
});

test('tiny prices still show a price, never $0', () => {
  const tiny = model({ prompt: '0.000000000000000001', completion: '0.000000000000000001' });
  const e = estimateMessage({ model: tiny, messages: [user('Hi')] });
  assert.ok(e.known && e.typical > 0n);
  assert.equal(priceLabel(e.typical, 'nearest'), '$0.000001');
  assert.equal(priceLabel(e.worst, 'up'), '$0.000001');
  assert.equal(priceLabel(0n), '$0.00');
});

test('the request max_tokens, the model cap and reasoning prices shape the worst case', () => {
  const msgs = [user('Write a haiku.')];
  assert.equal(estimateMessage({ model: ANONYMO_1, messages: msgs, maxTokens: 200 }).worstOut, 200);
  assert.equal(estimateMessage({ model: ANONYMO_1, messages: msgs, maxTokens: 200 }).typicalOut, 200, 'a typical reply never exceeds the cap');
  assert.equal(estimateMessage({ model: { ...ANONYMO_1, top_provider: { max_completion_tokens: 4_096 } }, messages: msgs }).worstOut, 4_096);
  assert.equal(estimateMessage({ model: { ...ANONYMO_1, top_provider: { max_completion_tokens: 4_096 } }, messages: msgs, maxTokens: 90_000 }).worstOut, 4_096);
  const plain = estimateMessage({ model: ANONYMO_1, messages: msgs, maxTokens: 1_000 });
  const reasoning = estimateMessage({ model: model({ ...ANONYMO_1.pricing, internal_reasoning: '0.000005' }), messages: msgs, maxTokens: 1_000 });
  assert.equal(reasoning.typical, plain.typical);
  assert.equal(reasoning.worst - plain.worst, 1_000n * (5_000_000_000_000n - 1_800_000_000_000n));
  const perRequest = estimateMessage({ model: model({ ...ANONYMO_1.pricing, request: '0.001' }), messages: msgs, maxTokens: 1_000 });
  assert.equal(perRequest.worst - plain.worst, 10n ** 15n);
});

test('the council is priced as four to five calls live, and as listed in demo', () => {
  assert.deepEqual(callSpread('anonymo-council', false), { low: 4n, high: 5n });
  assert.deepEqual(callSpread('anonymo-council', true), { low: 1n, high: 1n });
  assert.deepEqual(callSpread('anonymo-1', false), { low: 1n, high: 1n });
  const council = { ...ANONYMO_1, id: 'anonymo-council' };
  const one = estimateMessage({ model: ANONYMO_1, messages: [user('Hi')], maxTokens: 100 });
  const live = estimateMessage({ model: council, messages: [user('Hi')], maxTokens: 100 });
  assert.equal(live.typical, one.typical * 4n);
  assert.equal(live.worst, one.worst * 5n);
});

test('property: the worst case bounds the estimate and grows with the draft', () => {
  const rate = fc.bigInt({ min: 0n, max: 10n ** 14n }).map((n) => {
    const s = n.toString().padStart(19, '0');
    return `${s.slice(0, -18)}.${s.slice(-18)}`;
  });
  fc.assert(fc.property(
    rate, rate, fc.array(fc.string({ maxLength: 400 }), { minLength: 1, maxLength: 20 }), fc.string({ maxLength: 400 }),
    fc.option(fc.integer({ min: 1, max: 50_000 }), { nil: undefined }), fc.option(fc.integer({ min: 1, max: 2_000_000 }), { nil: undefined }),
    (prompt, completion, thread, extra, maxTokens, context) => {
      const m = { id: 'p', context_length: context, pricing: { prompt, completion } };
      const messages = thread.map(user);
      const e = estimateMessage({ model: m, messages, maxTokens });
      if (ratesOf(m) === null) return assert.deepEqual(e, { known: false });
      assert.ok(e.worst >= e.typical, 'up to is never below about');
      assert.ok(worstPromptTokens(messages) >= typicalPromptTokens(messages));
      assert.ok(e.worstOut >= 1 && e.typicalOut <= e.worstOut);
      if (maxTokens) assert.ok(e.worstOut <= maxTokens);
      const longer = estimateMessage({ model: m, messages: [...messages.slice(0, -1), user(messages.at(-1).content + extra)], maxTokens });
      assert.ok(longer.tokensIn >= e.tokensIn);
      // The displayed "up to" rounds up, so it never reads below the bound.
      assert.ok(BigInt(roundForDisplay(attoToMusd(e.worst, 'up'), 'up')) * 10n ** 12n >= e.worst);
    },
  ), { numRuns: 300 });
});

test('a refused reply counts $0, whatever its receipt says', () => {
  assert.deepEqual(chargeOf(turn({ receipt: receipt('0', true) })), { kind: 'refused' });
  assert.deepEqual(chargeOf(turn({ receipt: receipt('0.0004', true) })), { kind: 'refused' });
  // A refusal the router caught and rerouted bills only the reply that answered (the receipt's total).
  const caught = receipt('0.0002', false, [{ status: 'refused', refused: true, cost: '0' }, { status: 'ok', refused: false, cost: '0.0002' }]);
  assert.deepEqual(chargeOf(turn({ receipt: caught })), { kind: 'charged', atto: 200_000_000_000_000n });
  const spend = chatSpend([paid('0.04'), turn({ receipt: receipt('0.5', true) }), paid('0.002')]);
  assert.equal(spend.charged, parseUsdAtto('0.042'));
  assert.equal(spend.refused, 1);
  assert.equal(spend.replies, 3);
  assert.equal(spentLabel(spend.charged), '$0.042');
});

test('this chat so far uses the actual charges, not estimates', () => {
  // Many tiny charges add up exactly: a million picodollar charges are one micro-USD.
  const many = Array.from({ length: 1_000 }, () => paid('0.000000001'));
  assert.equal(chatSpend(many).charged, 1_000_000_000_000n);
  assert.equal(spentLabel(chatSpend(many).charged), '$0.000001');
  // Memory suggestions are a separate paid call for this chat, so they count too.
  assert.equal(chatSpend([turn({ ...paid('0.01'), memoryCharge: { cost: '0.0005', receiptId: 'r' } })]).charged, parseUsdAtto('0.0105'));
  const states = chatSpend([
    turn({ status: 'streaming', content: '' }),
    turn({ receiptId: 'gen-1' }), // receipt still being fetched
    turn({ status: 'error', content: '', error: 'Not enough credit', needsFunds: true }),
    turn({ status: 'error', content: '' }), // turned away before a model ran
    turn({ status: 'stopped', content: 'Half an ans' }),
    turn({ status: 'error', content: 'A reply that broke off' }),
  ]);
  assert.deepEqual(states, { charged: 0n, replies: 0, refused: 0, pending: 2, unknown: 2 });
  assert.equal(chargeOf(turn({ receipt: receipt('garbage') })).kind, 'unknown');
});

test('the per-chat limit blocks a message whose worst case would pass it', () => {
  const e = estimateMessage({ model: ANONYMO_1, messages: [user('Hi')], maxTokens: 1_000 });
  assert.deepEqual(checkLimit(null, { charged: 10n ** 30n }, e), { blocked: false });
  const limit = 500_000; // $0.50
  const room = musdToAtto(limit) - e.worst;
  assert.deepEqual(checkLimit(limit, { charged: room }, e), { blocked: false }, 'reaching the limit exactly is allowed');
  assert.deepEqual(checkLimit(limit, { charged: room + 1n }, e), { blocked: true, reason: 'over', limit, spent: room + 1n, worst: e.worst });
  assert.equal(checkLimit(limit, { charged: musdToAtto(limit) }, e).blocked, true, 'a spent chat stays stopped');
  // An unknown price cannot be checked against a limit, so it blocks only when a limit is set.
  assert.deepEqual(checkLimit(limit, { charged: 0n }, { known: false }), { blocked: true, reason: 'unknown_price', limit });
  assert.deepEqual(checkLimit(null, { charged: 0n }, { known: false }), { blocked: false });
  // Refused replies never push a chat toward its limit.
  const refusedOnly = chatSpend(Array.from({ length: 50 }, () => turn({ receipt: receipt('1', true) })));
  assert.equal(checkLimit(limit, refusedOnly, e).blocked, false);
});

test('a typed limit is a positive plain amount', () => {
  assert.equal(parseLimit('0.50'), 500_000);
  assert.equal(parseLimit('$2'), 2_000_000);
  assert.equal(parseLimit(' 0.000001 '), 1);
  for (const bad of ['0', '', 'abc', '-1', '1e3', '0.0000001', '20000']) assert.equal(parseLimit(bad), null, bad);
});

test('limits are kept per chat on the device, live and demo apart, oldest dropped first', () => {
  assert.notEqual(limitSlot(true), limitSlot(false));
  assert.ok(limitSlot(false).startsWith('anonymo.'), 'wiped with the device');
  assert.deepEqual(readLimits(null), {});
  assert.deepEqual(readLimits([1, 2]), {});
  assert.deepEqual(readLimits({ 'chat-a': 500_000, 'chat-b': -1, 'chat-c': 1.5, 'bad id!': 10, 'chat-d': '5' }), { 'chat-a': 500_000 });
  let limits = withLimit({}, 'chat-a', 500_000);
  limits = withLimit(limits, 'chat-b', 100_000);
  limits = withLimit(limits, 'chat-a', 900_000);
  assert.deepEqual(Object.keys(limits), ['chat-b', 'chat-a']);
  assert.deepEqual(withLimit(limits, 'chat-b', null), { 'chat-a': 900_000 });
  for (let i = 0; i < MAX_LIMITS + 5; i++) limits = withLimit(limits, `chat-${i}`, 1_000);
  assert.equal(Object.keys(limits).length, MAX_LIMITS);
  assert.equal(limits['chat-a'], undefined);
});

test('amounts read plainly', () => {
  assert.equal(usdText(0), '$0.00');
  assert.equal(usdText(42_000), '$0.042');
  assert.equal(usdText(3_100), '$0.0031');
  assert.equal(usdText(1_200_000), '$1.20');
  assert.equal(usdText(1_234_000_000), '$1,234.00');
  assert.equal(roundForDisplay(3_149, 'nearest'), 3_100);
  assert.equal(roundForDisplay(3_101, 'up'), 3_200);
  assert.equal(roundForDisplay(1, 'nearest'), 1);
});

test('demo: the mock gateway lists prices, and each charge stays within the worst case', async () => {
  const mock = createMockGateway({ delayMs: 0 });
  const { key } = await createAnonymoClient({ baseUrl: BASE, fetch: mock.fetch }).createKey();
  const client = createAnonymoClient({ baseUrl: BASE, fetch: mock.fetch, key });
  await mock.simulateDeposit(key, 'rhc', 'USDG', 5_000_000);
  const catalog = (await client.models()).data;
  const thread = [];
  const turns = [];
  for (const id of ['anonymo-1', 'anonymo-rp', 'anonymo-1']) {
    const listed = catalog.find((m) => m.id === id);
    assert.notEqual(ratesOf(listed), null, `${id} has a demo price`);
    const messages = [...thread, user(`Tell me about receipts, part ${turns.length + 1}.`)];
    const e = estimateMessage({ model: listed, messages, demo: true });
    const result = await client.chat({ model: id, messages });
    assert.ok(result.receipt, 'the reply carries its receipt');
    const charged = parseUsdAtto(result.receipt.cost);
    assert.ok(charged > 0n && charged <= e.worst, `${id}: charged ${result.receipt.cost}, up to ${priceLabel(e.worst)}`);
    thread.push(messages.at(-1), { role: 'assistant', content: result.content });
    turns.push({ status: 'done', content: result.content, receiptId: result.receiptId, receipt: result.receipt });
  }
  const spend = chatSpend(turns);
  assert.equal(spend.replies, 3);
  assert.equal(spend.charged, turns.reduce((sum, t) => sum + parseUsdAtto(t.receipt.cost), 0n));
});

test('a flat extra (the web search price) is added once to both the typical and the worst case', () => {
  const messages = [user('Look this up.')];
  const plain = estimateMessage({ model: ANONYMO_1, messages });
  const searched = estimateMessage({ model: ANONYMO_1, messages, extraUsd: '0.005' });
  assert.equal(plain.known && searched.known, true);
  const fiveMilliUsd = 5n * 10n ** 15n; // $0.005 in atto-USD
  assert.equal(searched.typical - plain.typical, fiveMilliUsd);
  assert.equal(searched.worst - plain.worst, fiveMilliUsd);
});
