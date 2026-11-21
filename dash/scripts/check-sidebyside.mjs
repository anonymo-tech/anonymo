// Update "sidebyside": the three default slots, the price shown before sending, the merge request, what a receipt says
// about a refusal, the total in micro-USD, the state of a round, and the demo gateway's part in it.
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { createAnonymoClient } from '../lib/anonymo/client.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';
import { formatUsd, musdToUsdString, usdToMusd } from '../lib/anonymo/money.ts';
import {
  ANSWER_MAX_TOKENS, EMPTY_ROUND, MERGE_ANSWER_CHARS, MERGE_INSTRUCTION, MERGE_MAX_TOKENS, MERGE_MODEL, MERGE_QUESTION_CHARS, SLOTS,
  askEstimate, canMerge, chatTurn, slotModels, costOf, defaultSlots, isBusy, listPrice, maxCost, mergeEstimate, mergeRequest, mergeable,
  receiptStrip, reconcileSlots, refusalLabel, rerouteOf, roundReceipts, roundReducer, roundUpEstimate, searchModels, setSlot, totalCost, upperTokens,
} from '../lib/anonymo/sidebyside.ts';
import { parseUpdates, updateOn } from '../lib/anonymo/updates.ts';

const BASE = 'https://demo.anonymo.invalid';
const model = (id, family, rate = null, extra = {}) => ({ id, family, quant: null, weights_hash: null, attested: false, refusal_rate_30d: rate, ...extra });
const route = (name, family, status, cost = '0', role = 'single') => ({
  route: `sample:${name}`, role, provider: 'sample', model: name, family, quant: null, attested: false, weights_hash: null,
  tokens: { in: status === 'ok' ? 12 : 0, out: status === 'ok' ? 40 : 0 }, cost, refused: status === 'refused', status,
});
const receipt = (id, routes, cost, refused = false) => ({
  v: 'anonymo-receipt/1', request_id: id, model_id: 'sample-model', routes, weights_hash: routes.map(() => null),
  tokens: { in: 12, out: 40 }, cost, refused, sealed: false, ts: '2026-11-20T21:04:00.000Z',
});
const clean = (id, cost = '0.000171') => receipt(id, [route('sample-a', 'alpha', 'ok', cost)], cost);
const rerouted = (id, cost = '0.0002') => receipt(id, [route('sample-a', 'alpha', 'refused'), route('sample-b', 'beta', 'ok', cost, 'retry')], cost);
const servedRefusal = (id) => receipt(id, [route('sample-a', 'alpha', 'refused')], '0', true);

async function funded(musd = 5_000_000) {
  const mock = createMockGateway({ delayMs: 0 });
  const { key } = await createAnonymoClient({ baseUrl: BASE, fetch: mock.fetch }).createKey();
  const client = createAnonymoClient({ baseUrl: BASE, fetch: mock.fetch, key });
  if (musd) await mock.simulateDeposit(key, 'rhc', 'USDG', musd);
  return { mock, client, key };
}

/** Plays a list of actions through the reducer. */
const play = (actions, from = EMPTY_ROUND) => actions.reduce(roundReducer, from);
const ask = (run = 1, models = ['m-a', 'm-b', 'm-c'], over = {}) => ({ type: 'ask', run, question: 'What is a receipt?', models, aiReminder: false, crisis: false, ...over });
const done = (run, slot, content, r = null) => ({ type: 'done', run, slot, content, receiptId: r?.request_id ?? null, receipt: r, cutOff: false });

test('sidebyside has its own switch and is always on in demo', () => {
  assert.equal(parseUpdates().has('sidebyside'), false);
  assert.equal(parseUpdates('history,usage').has('sidebyside'), false);
  assert.equal(parseUpdates('sidebyside').has('sidebyside'), true);
  assert.equal(parseUpdates('all').has('sidebyside'), true);
  assert.equal(updateOn('sidebyside', true), true);
  // The updates that were already there keep their switches.
  for (const id of ['history', 'images', 'usage', 'catchup', 'status', 'compare', 'vanish', 'vault', 'video']) assert.equal(parseUpdates('all').has(id), true, id);
});

test('the default slots are anonymo-1 and the two other families that refused least', async () => {
  const { client } = await funded(0);
  const models = (await client.models()).data;
  const slots = defaultSlots(models);
  const info = slots.map((id) => models.find((m) => m.id === id));
  assert.equal(slots.length, 3);
  assert.equal(slots[0], 'anonymo-1');
  assert.equal(new Set(info.map((m) => m.family)).size, 3, 'three different families');
  assert.ok(!slots.includes('anonymo-council'), 'the council does not stream and is three models itself');
  assert.ok(slots.slice(1).every((id) => !id.startsWith('anonymo-')), 'the other two are direct model ids');
  // Lowest 30-day refusal rate first among the families anonymo-1 does not already show.
  const others = slotModels(models).filter((m) => !m.id.startsWith('anonymo-') && m.family !== info[0].family).sort((a, b) => a.refusal_rate_30d - b.refusal_rate_30d);
  assert.deepEqual(slots.slice(1), [others[0].id, others.find((m) => m.family !== others[0].family).id]);
});

test('default slots: never the council, never a repeat, three families whenever three are listed', () => {
  const families = ['alpha', 'beta', 'gamma', 'delta', null];
  const anyModel = fc.record({ id: fc.constantFrom('anonymo-1', 'anonymo-rp', 'anonymo-council', 'anonymo-sealed', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'), family: fc.constantFrom(...families), rate: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }) });
  fc.assert(fc.property(fc.array(anyModel, { maxLength: 12 }), (raw) => {
    const models = raw.map((m) => model(m.id, m.family, m.rate));
    const pool = slotModels(models);
    const slots = defaultSlots(models);
    assert.equal(slots.length, Math.min(3, pool.length));
    assert.equal(new Set(slots).size, slots.length);
    assert.ok(!slots.includes('anonymo-council'));
    assert.ok(slots.every((id) => pool.some((m) => m.id === id)));
    if (pool.some((m) => m.id === MERGE_MODEL)) assert.equal(slots[0], MERGE_MODEL);
    // As many different families as the list allows: three when it names three (two when the first slot's is unknown).
    const named = (list) => new Set(list.filter(Boolean)).size;
    const picked = slots.map((id) => pool.find((m) => m.id === id).family);
    assert.ok(named(picked) >= Math.min(picked[0] ? 3 : 2, named(pool.map((m) => m.family))), JSON.stringify({ picked, listed: pool.map((m) => m.family) }));
    // Asking again with the same list gives the same slots.
    assert.deepEqual(defaultSlots(models), slots);
  }));
});

test('fewer than three models listed gives fewer slots, and the page can tell', () => {
  assert.deepEqual(defaultSlots([]), []);
  assert.deepEqual(defaultSlots([model('anonymo-1', 'alpha'), model('anonymo-council', 'alpha')]), ['anonymo-1']);
  assert.deepEqual(defaultSlots([model('m1', 'alpha', 0.2), model('m2', 'alpha', 0.1), model('m3', 'alpha', null)]), ['m2', 'm1', 'm3'], 'one family only: still three different models');
});

test('choosing a model that sits in another slot trades places; stale choices are replaced', () => {
  assert.deepEqual(setSlot(['a', 'b', 'c'], 0, 'd'), ['d', 'b', 'c']);
  assert.deepEqual(setSlot(['a', 'b', 'c'], 0, 'c'), ['c', 'b', 'a']);
  assert.deepEqual(setSlot(['a', 'b', 'c'], 1, 'b'), ['a', 'b', 'c']);
  assert.deepEqual(setSlot(['a', 'b', 'c'], 7, 'd'), ['a', 'b', 'c']);
  fc.assert(fc.property(fc.integer({ min: 0, max: 2 }), fc.constantFrom('a', 'b', 'c', 'd', 'e'), (i, id) => {
    const next = setSlot(['a', 'b', 'c'], i, id);
    assert.equal(next[i], id);
    assert.equal(new Set(next).size, 3);
  }));
  const models = [model('anonymo-1', 'alpha'), model('m1', 'beta', 0.1), model('m2', 'gamma', 0.2), model('m3', 'delta', 0.3)];
  assert.deepEqual(reconcileSlots(null, models), ['anonymo-1', 'm1', 'm2']);
  assert.deepEqual(reconcileSlots(['m3', 'gone', 'm1'], models), ['m3', 'm1', 'anonymo-1']);
  assert.deepEqual(reconcileSlots(['m3', 'm2', 'm1'], models), ['m3', 'm2', 'm1']);
  assert.deepEqual(reconcileSlots(['m1', 'm1', 'anonymo-council'], models), ['m1', 'anonymo-1', 'm2']);
});

test('the list is searched by id, name and family, and shows the 30-day refusal rate', () => {
  const models = [model('anonymo-1', 'alpha', 0.0027), model('anonymo-council', 'alpha'), model('m1', 'beta', 0.05, { name: 'Night Owl' }), model('m2', 'gamma')];
  assert.deepEqual(searchModels(models, '').map((m) => m.id), ['anonymo-1', 'm1', 'm2']);
  assert.deepEqual(searchModels(models, 'OWL').map((m) => m.id), ['m1']);
  assert.deepEqual(searchModels(models, 'gam').map((m) => m.id), ['m2']);
  assert.deepEqual(searchModels(models, 'anonymo alpha').map((m) => m.id), ['anonymo-1']);
  assert.deepEqual(searchModels(models, 'council'), []);
  assert.equal(refusalLabel(0.0027), '0.27% said no in 30 days');
  assert.equal(refusalLabel(0.05), '5.0% said no in 30 days');
  assert.equal(refusalLabel(0), '0.00% said no in 30 days');
  assert.equal(refusalLabel(null), 'no refusal figure yet');
});

test('list prices are read exactly, and the price on the button never understates', () => {
  assert.deepEqual(listPrice({ pricing: { prompt: '0.00000045', completion: '0.0000018' } }), { in: 450_000, out: 1_800_000 });
  assert.deepEqual(listPrice({ pricing: { prompt: '0.0000000000004', completion: '1' } }), { in: 1, out: 1_000_000_000_000 }, 'a sliver rounds up');
  assert.equal(listPrice({ pricing: { prompt: '0', completion: '0' } }), null, 'a price of zero for both is no price');
  for (const pricing of [undefined, {}, { prompt: '0.1' }, { prompt: '4.5e-7', completion: '1' }, { prompt: '-1', completion: '1' }, { prompt: 1, completion: 2 }]) assert.equal(listPrice({ pricing }), null);
  assert.equal(listPrice(undefined), null);

  const price = { in: 450_000, out: 1_800_000 };
  assert.equal(maxCost(100, price, ANSWER_MAX_TOKENS), Math.ceil((100 * 450_000 + ANSWER_MAX_TOKENS * 1_800_000) / 1e6));
  assert.equal(askEstimate('hello', [price, price, price]), 3 * maxCost(upperTokens('hello'), price, ANSWER_MAX_TOKENS));
  assert.equal(askEstimate('hello', [price, null, price]), null, 'no total when one price is not listed');
  assert.equal(askEstimate('hello', []), null);
  assert.equal(mergeEstimate([{ role: 'user', content: 'x'.repeat(400) }], null), null);
  assert.equal(mergeEstimate([{ role: 'user', content: 'x'.repeat(400) }], price), maxCost(upperTokens('x'.repeat(400)), price, MERGE_MAX_TOKENS));

  assert.equal(formatUsd(roundUpEstimate(6561)), '$0.0066');
  assert.equal(roundUpEstimate(216), 220);
  assert.equal(roundUpEstimate(7), 7);
  assert.equal(roundUpEstimate(0), 0);
  fc.assert(fc.property(fc.integer({ min: 1, max: 10 ** 12 }), (musd) => {
    const shown = roundUpEstimate(musd);
    assert.ok(shown >= musd && shown <= musd * 1.1 + 1, 'rounded up, by a tenth at most');
  }));
});

test('the merge request carries every answer once, labelled and capped, and ends with the instruction', () => {
  const answers = [
    { label: 'A', model: 'anonymo-1', content: 'First take: alpha.' },
    { label: 'B', model: 'm1', content: '  Second take: beta.  ' },
    { label: 'C', model: 'm2', content: 'Third take: gamma.' },
  ];
  const request = mergeRequest('What is a receipt?', answers);
  assert.deepEqual(request.map((m) => m.role), ['user', 'assistant', 'user'], 'roles alternate');
  assert.equal(request[2].content, MERGE_INSTRUCTION);
  assert.match(MERGE_INSTRUCTION, /Keep what they agree on/);
  assert.match(MERGE_INSTRUCTION, /"Where they differed"/);
  const material = request[0].content;
  assert.match(material, /My question:\nWhat is a receipt\?/);
  for (const a of answers) {
    assert.equal(material.split(`Answer ${a.label} (from ${a.model}):\n${a.content.trim()}`).length, 2, `answer ${a.label} appears once under its label`);
    assert.equal(material.split(a.content.trim()).length, 2);
  }
  assert.ok(material.indexOf('Answer A') < material.indexOf('Answer B') && material.indexOf('Answer B') < material.indexOf('Answer C'));
  assert.match(request[1].content, /3 answers/);

  // A blank answer is left out; a single answer still reads correctly.
  const two = mergeRequest('Q', [answers[0], { label: 'B', model: 'm1', content: '   ' }, answers[2]]);
  assert.doesNotMatch(two[0].content, /Answer B/);
  assert.match(two[0].content, /then 2 answers/);
  assert.match(mergeRequest('Q', [answers[0]])[0].content, /then 1 answer,/);

  // Capped: a very long answer or question is cut and marked, so the request stays bounded.
  const long = mergeRequest('q'.repeat(MERGE_QUESTION_CHARS * 3), answers.map((a) => ({ ...a, content: a.label.toLowerCase().repeat(MERGE_ANSWER_CHARS * 3) })));
  const bound = MERGE_QUESTION_CHARS + 3 * MERGE_ANSWER_CHARS + 600;
  assert.ok(long[0].content.length <= bound, `${long[0].content.length} <= ${bound}`);
  assert.equal((long[0].content.match(/ \[…\]/g) ?? []).length, 4);
  assert.ok(!long[0].content.includes('a'.repeat(MERGE_ANSWER_CHARS + 1)));
});

test('merge request: any answers, each once and within the cap', () => {
  const text = fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0);
  fc.assert(fc.property(text, fc.array(text, { minLength: 1, maxLength: 3 }), (question, contents) => {
    const answers = contents.map((content, i) => ({ label: SLOTS[i], model: `m${i}`, content }));
    const request = mergeRequest(question, answers);
    assert.equal(request.length, 3);
    assert.equal(request[2].content, MERGE_INSTRUCTION);
    for (const a of answers) assert.equal(request[0].content.split(`Answer ${a.label} (from ${a.model}):\n`).length, 2);
    assert.equal((request[0].content.match(/^Answer [ABC] \(from m\d\):$/gm) ?? []).length >= answers.length, true);
  }));
});

test('a receipt says which route refused and which one stepped in', () => {
  assert.equal(rerouteOf(null), null);
  assert.equal(rerouteOf(clean('gen-1')), null);

  const moved = rerouteOf(rerouted('gen-2'));
  assert.deepEqual(moved.saidNo.map((r) => r.model), ['sample-a']);
  assert.equal(moved.steppedIn.model, 'sample-b');
  assert.equal(moved.steppedIn.family, 'beta');
  assert.equal(moved.servedRefusal, false);

  const refused = rerouteOf(servedRefusal('gen-3'));
  assert.deepEqual(refused.saidNo.map((r) => r.model), ['sample-a']);
  assert.equal(refused.steppedIn, null);
  assert.equal(refused.servedRefusal, true);

  // Two families refused: nobody stepped in, and both are named.
  const twice = rerouteOf(receipt('gen-4', [route('sample-a', 'alpha', 'refused'), route('sample-b', 'beta', 'refused', '0', 'retry')], '0', true));
  assert.deepEqual(twice.saidNo.map((r) => r.model), ['sample-a', 'sample-b']);
  assert.equal(twice.steppedIn, null);

  // A route marked refused by its flag alone is read the same way; a late or failed route is not a refusal.
  const flagged = receipt('gen-5', [{ ...route('sample-a', 'alpha', 'ok'), refused: true }, route('sample-b', 'beta', 'ok', '0.0001', 'retry')], '0.0001');
  assert.equal(rerouteOf(flagged).steppedIn.model, 'sample-b');
  assert.equal(rerouteOf(receipt('gen-6', [route('sample-a', 'alpha', 'failed'), route('sample-b', 'beta', 'ok', '0.0001')], '0.0001')), null);
});

test('the demo gateway reroutes and stamps one column only, and each column has its own answer and receipt', async () => {
  const { client } = await funded();
  const models = (await client.models()).data;
  const slots = defaultSlots(models);
  const question = 'Please reroute this one for the demo.';
  const before = usdToMusd((await client.balance()).available_usd);
  const results = await Promise.all(slots.map((id) => client.chat({ model: id, messages: [{ role: 'user', content: question }], max_tokens: ANSWER_MAX_TOKENS }, { headers: { refusalCatch: 'on' } })));

  assert.deepEqual(results.map((r) => rerouteOf(r.receipt) !== null), [true, false, false], 'the stamp belongs to the anonymo-1 column alone');
  const moved = rerouteOf(results[0].receipt);
  assert.equal(moved.saidNo.length, 1);
  assert.equal(usdToMusd(moved.saidNo[0].cost), 0, 'the refused attempt is billed nothing');
  assert.notEqual(moved.steppedIn.family, moved.saidNo[0].family, 'another family stepped in');
  assert.equal(new Set(results.map((r) => r.content)).size, 3, 'three different answers');
  assert.equal(new Set(results.map((r) => r.receiptId)).size, 3, 'three receipts');
  for (const [i, r] of results.entries()) {
    assert.equal(r.receipt.model_id, slots[i]);
    assert.ok(r.content.includes(slots[i]) || slots[i] === 'anonymo-1', 'a direct model answers in its own column');
    assert.equal((await client.receipt(r.receiptId)).receipt.request_id, r.receiptId);
  }
  const total = totalCost(results.map((r) => r.receipt));
  assert.equal(before - usdToMusd((await client.balance()).available_usd), total, 'the total is what the balance lost');

  // The price shown before sending covered it.
  const estimate = askEstimate(question, slots.map((id) => listPrice(models.find((m) => m.id === id))));
  assert.ok(estimate !== null && estimate >= total, `${estimate} >= ${total}`);

  // The merge goes to anonymo-1 with the same word in the question, and is not rerouted.
  const request = mergeRequest(question, results.map((r, i) => ({ label: SLOTS[i], model: slots[i], content: r.content })));
  const merged = await client.chat({ model: MERGE_MODEL, messages: request, max_tokens: MERGE_MAX_TOKENS }, { headers: { refusalCatch: 'on' } });
  assert.equal(rerouteOf(merged.receipt), null);
  assert.match(merged.content, /^This is a merged demo answer/);
  assert.match(merged.content, /\n\nWhere they differed:\n- A \(anonymo-1\) /);
  for (const [i, id] of slots.entries()) assert.ok(merged.content.includes(`- ${SLOTS[i]} (${id}) `), `the merge names answer ${SLOTS[i]}`);
  const mergePrice = mergeEstimate(request, listPrice(models.find((m) => m.id === MERGE_MODEL)));
  assert.ok(mergePrice >= costOf(merged.receipt));

  // Without the word, nothing is rerouted, and an ordinary anonymo-1 chat is what it was.
  const plain = await client.chat({ model: 'anonymo-1', messages: [{ role: 'user', content: 'An ordinary question.' }] });
  assert.equal(rerouteOf(plain.receipt), null);
  assert.match(plain.content, /^This is a demo answer from the in-browser mock gateway/);
});

test('the demo gateway lists a price for every model, and it is the price it charges', async () => {
  const { client } = await funded();
  const models = (await client.models()).data;
  for (const m of models) assert.ok(listPrice(m), `${m.id} has a list price`);
  assert.deepEqual(listPrice(models.find((m) => m.id === 'anonymo-1')), { in: 450_000, out: 1_800_000 });
  assert.deepEqual(listPrice(models.find((m) => m.id === 'anonymo-rp')), { in: 80_000, out: 80_000 });
  const direct = slotModels(models).find((m) => !m.id.startsWith('anonymo-'));
  const price = listPrice(direct);
  const r = await client.chat({ model: direct.id, messages: [{ role: 'user', content: 'Hello there' }] });
  assert.equal(costOf(r.receipt), Math.ceil((r.receipt.tokens.in * price.in + r.receipt.tokens.out * price.out) / 1e6));
});

test('with no credit every column fails on its own, and nothing is charged', async () => {
  const { client } = await funded(0);
  const slots = defaultSlots((await client.models()).data);
  const settled = await Promise.allSettled(slots.map((id) => client.chat({ model: id, messages: [{ role: 'user', content: 'Hi' }] })));
  assert.deepEqual(settled.map((s) => s.status), ['rejected', 'rejected', 'rejected']);
  for (const s of settled) assert.equal(s.reason.status, 402);
  assert.equal(usdToMusd((await client.balance()).balance_usd), 0);
});

test('the total is the sum of the receipts in micro-USD', () => {
  assert.equal(costOf(clean('gen-1', '0.000171')), 171);
  assert.equal(costOf(null), null);
  assert.equal(costOf({ ...clean('gen-1'), cost: 'free' }), null);
  assert.equal(totalCost([]), 0);
  assert.equal(totalCost([clean('a', '0.000171'), null, rerouted('b', '0.0002'), servedRefusal('c'), undefined]), 371);
  assert.equal(totalCost([clean('a', '0.1'), clean('b', '0.2')]), 300_000, 'no float drift: 0.1 + 0.2 is exactly 0.30');
  assert.equal(totalCost([{ ...clean('a'), cost: 'free' }, clean('b', '0.000001')]), 1, 'an unreadable amount adds nothing');
  fc.assert(fc.property(fc.array(fc.option(fc.integer({ min: 0, max: 10 ** 9 }), { nil: null }), { maxLength: 6 }), (costs) => {
    const receipts = costs.map((c, i) => (c === null ? null : clean(`gen-${i}`, musdToUsdString(c))));
    const total = totalCost(receipts);
    assert.equal(total, costs.reduce((sum, c) => sum + (c ?? 0), 0));
    assert.ok(Number.isSafeInteger(total));
    assert.equal(totalCost([...receipts].reverse()), total);
  }));
});

test('a round: three columns arrive on their own, then settle', () => {
  assert.equal(isBusy(EMPTY_ROUND), false);
  let round = play([ask()]);
  assert.equal(round.run, 1);
  assert.deepEqual(round.columns.map((c) => [c.model, c.status, c.content]), [['m-a', 'streaming', ''], ['m-b', 'streaming', ''], ['m-c', 'streaming', '']]);
  assert.equal(isBusy(round), true);
  assert.equal(canMerge(round), false);

  round = play([
    { type: 'delta', run: 1, slot: 1, text: 'Hel' },
    { type: 'delta', run: 1, slot: 0, text: 'One' },
    { type: 'delta', run: 1, slot: 1, text: 'lo' },
    { type: 'delta', run: 1, slot: 1, text: '' },
  ], round);
  assert.deepEqual(round.columns.map((c) => c.content), ['One', 'Hello', '']);

  const r = clean('gen-b');
  round = play([done(1, 1, 'Hello.', r), { type: 'stopped', run: 1, slot: 0 }, { type: 'error', run: 1, slot: 2, message: 'Not enough credit for this request. Add funds and try again.', needsFunds: true }], round);
  assert.deepEqual(round.columns.map((c) => c.status), ['stopped', 'done', 'error']);
  assert.equal(round.columns[1].content, 'Hello.');
  assert.equal(round.columns[1].receiptId, 'gen-b');
  assert.equal(round.columns[0].content, 'One', 'a stopped column keeps the text that arrived');
  assert.equal(round.columns[2].needsFunds, true);
  assert.equal(isBusy(round), false);

  // A settled column never changes again.
  const after = play([{ type: 'delta', run: 1, slot: 1, text: ' more' }, { type: 'error', run: 1, slot: 1, message: 'late', needsFunds: false }, { type: 'stopped', run: 1, slot: 2 }, done(1, 0, 'late')], round);
  assert.equal(after, round);
});

test('a round: late events from an earlier question never land in the current one', () => {
  const first = play([ask(1), { type: 'delta', run: 1, slot: 0, text: 'old' }, { type: 'stopped', run: 1, slot: 0 }, { type: 'stopped', run: 1, slot: 1 }, { type: 'stopped', run: 1, slot: 2 }]);
  const second = play([ask(2, ['x', 'y', 'z'])], first);
  assert.equal(second.run, 2);
  assert.deepEqual(second.columns.map((c) => c.model), ['x', 'y', 'z']);
  const stale = [{ type: 'delta', run: 1, slot: 0, text: 'ghost' }, done(1, 1, 'ghost'), { type: 'error', run: 1, slot: 2, message: 'ghost', needsFunds: true }, { type: 'receipt', run: 1, slot: 0, receipt: clean('gen-old') }, { type: 'merge', run: 1, model: MERGE_MODEL }];
  assert.equal(play(stale, second), second);

  // A new question waits for whatever is still arriving, and a run number is never reused.
  assert.equal(roundReducer(second, ask(3)), second);
  assert.equal(roundReducer(first, ask(1)), first);
  assert.equal(roundReducer(first, ask(2, [])), first);

  // Clearing drops the text and keeps the count, so anything still in flight finds nothing to write to.
  const cleared = roundReducer(second, { type: 'clear' });
  assert.deepEqual(cleared, { ...EMPTY_ROUND, run: 2 });
  assert.equal(play([{ type: 'delta', run: 2, slot: 0, text: 'ghost' }, done(2, 1, 'ghost')], cleared), cleared);
});

test('a round: the receipt can arrive after the answer, and only for that answer', () => {
  const r = clean('gen-a');
  let round = play([ask(), { type: 'done', run: 1, slot: 0, content: 'Hi', receiptId: 'gen-a', receipt: null, cutOff: true }]);
  assert.equal(round.columns[0].cutOff, true);
  assert.equal(roundReducer(round, { type: 'receipt', run: 1, slot: 0, receipt: clean('gen-other') }), round);
  assert.equal(roundReducer(round, { type: 'receipt', run: 1, slot: 1, receipt: r }), round, 'a column still arriving takes no receipt');
  round = roundReducer(round, { type: 'receipt', run: 1, slot: 0, receipt: r });
  assert.equal(round.columns[0].receipt, r);
  assert.equal(roundReducer(round, { type: 'receipt', run: 1, slot: 0, receipt: clean('gen-a', '9') }), round, 'the first receipt stays');
});

test('a round: the merge needs two answers and nothing still arriving, and reads no refusal or failure', () => {
  let round = play([ask(), done(1, 0, 'Alpha.', clean('gen-a')), done(1, 1, 'Sorry, no.', servedRefusal('gen-b'))]);
  assert.equal(canMerge(round), false, 'one column is still arriving');
  assert.equal(roundReducer(round, { type: 'merge', run: 1, model: MERGE_MODEL }), round);
  round = roundReducer(round, { type: 'error', run: 1, slot: 2, message: 'x', needsFunds: false });
  assert.deepEqual(mergeable(round), [{ label: 'A', model: 'm-a', content: 'Alpha.' }], 'a served refusal and a failure are left out');
  assert.equal(canMerge(round), false, 'one answer is not enough');

  round = play([ask(), done(1, 0, 'Alpha.', clean('gen-a')), done(1, 1, 'Beta.', rerouted('gen-b')), { type: 'delta', run: 1, slot: 2, text: 'Gam' }, { type: 'stopped', run: 1, slot: 2 }]);
  assert.deepEqual(mergeable(round).map((a) => [a.label, a.content]), [['A', 'Alpha.'], ['B', 'Beta.'], ['C', 'Gam']]);
  assert.equal(canMerge(round), true);
  round = roundReducer(round, { type: 'merge', run: 1, model: MERGE_MODEL });
  assert.equal(round.merge.status, 'streaming');
  assert.equal(isBusy(round), true);
  assert.equal(roundReducer(round, { type: 'merge', run: 1, model: MERGE_MODEL }), round, 'one merge at a time');
  round = play([{ type: 'delta', run: 1, slot: 'merge', text: 'One ' }, { type: 'delta', run: 1, slot: 'merge', text: 'answer.' }], round);
  assert.equal(round.merge.content, 'One answer.');
  assert.deepEqual(round.columns.map((c) => c.content), ['Alpha.', 'Beta.', 'Gam'], 'the merge never writes into a column');

  // A merge that was stopped or failed can be asked for again; one that finished cannot.
  const stopped = roundReducer(round, { type: 'stopped', run: 1, slot: 'merge' });
  assert.equal(canMerge(stopped), true);
  assert.equal(roundReducer(stopped, { type: 'merge', run: 1, model: MERGE_MODEL }).merge.content, '');
  const finished = roundReducer(round, done(1, 'merge', 'One answer.', clean('gen-m', '0.0009')));
  assert.equal(canMerge(finished), false);
  assert.equal(totalCost(roundReceipts(finished)), 171 + 200 + 900);
  // A new question starts clean.
  assert.equal(roundReducer(finished, ask(2)).merge, null);
});

test('round: text only ever lands in the column it was sent to, in order', () => {
  const event = fc.record({ slot: fc.constantFrom(0, 1, 2), text: fc.string({ maxLength: 8 }), stop: fc.boolean() });
  fc.assert(fc.property(fc.array(event, { maxLength: 40 }), (events) => {
    const expected = ['', '', ''];
    const stopped = [false, false, false];
    let round = play([ask()]);
    for (const e of events) {
      if (e.stop) {
        round = roundReducer(round, { type: 'stopped', run: 1, slot: e.slot });
        stopped[e.slot] = true;
      } else {
        round = roundReducer(round, { type: 'delta', run: 1, slot: e.slot, text: e.text });
        if (!stopped[e.slot]) expected[e.slot] += e.text;
      }
    }
    assert.deepEqual(round.columns.map((c) => c.content), expected);
    assert.deepEqual(round.columns.map((c) => c.status === 'stopped'), stopped);
    assert.equal(round.merge, null);
  }));
});

test('the receipt strip lists each model with answered or said no, and the total', () => {
  const round = play([
    ask(1, ['anonymo-1', 'm-b', 'm-c']),
    done(1, 0, 'Alpha.', rerouted('gen-a', '0.0002')),
    done(1, 1, 'Beta.', clean('gen-b', '0.000171')),
    done(1, 2, 'No.', servedRefusal('gen-c')),
    { type: 'merge', run: 1, model: MERGE_MODEL },
    done(1, 'merge', 'One.', clean('gen-m', '0.0009')),
  ]);
  const rows = receiptStrip(round);
  const text = rows.map((r) => (r.kind === 'pair' ? `${r.label}: ${r.value}${r.stamp ? ` [${r.stamp}]` : ''}` : r.kind === 'head' ? `${r.label} ${r.text}` : r.kind === 'center' ? r.text : r.kind));
  assert.deepEqual(text, [
    'logo', 'ANONYMO', 'Side by side',
    'A anonymo-1', 'sample-a: said no [REFUNDED]', 'sample-b: answered', 'charged: $0.0002',
    'B m-b', 'answered: $0.000171',
    'C m-c', 'sample-a: said no [REFUNDED]', 'charged: $0.00',
    '+ Merged by anonymo-1', 'merged: $0.0009',
    'rule', 'Total: $0.001271', 'Thank you. Sleep well.',
  ]);
  assert.equal(rows.find((r) => r.kind === 'pair' && r.label === 'Total').tone, 'amber');

  // A column that failed or was stopped says so, and a merge that never ran is not printed.
  const rough = play([ask(), { type: 'error', run: 1, slot: 0, message: 'x', needsFunds: true }, { type: 'delta', run: 1, slot: 1, text: 'Half' }, { type: 'stopped', run: 1, slot: 1 }, done(1, 2, 'Gamma.', clean('gen-c', '0.000171'))]);
  const lines = receiptStrip(rough).filter((r) => r.kind === 'pair').map((r) => `${r.label}: ${r.value}`);
  assert.deepEqual(lines, ['no answer: $0.00', 'stopped early: see Receipts', 'answered: $0.000171', 'Total: $0.000171']);
  assert.ok(!receiptStrip(rough).some((r) => r.kind === 'head' && r.label === '+'));
});

test('continue in chat: the question and that answer become the first turn', () => {
  const r = clean('gen-a');
  const turn = chatTurn('turn-1', 'What is a receipt?', { model: 'm-a', content: 'A signed record.', receiptId: 'gen-a', receipt: r, status: 'done' });
  assert.deepEqual(turn, { id: 'turn-1', model: 'm-a', prompt: 'What is a receipt?', attachment: null, character: null, content: 'A signed record.', status: 'done', error: null, receiptId: 'gen-a', receipt: r, council: null, councilMode: null });
  assert.equal(chatTurn('turn-2', 'Q', { model: 'm-a', content: 'Half', receiptId: null, receipt: null, status: 'stopped' }).status, 'stopped', 'a stopped answer stays marked as stopped');
});
