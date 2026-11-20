import assert from 'node:assert/strict';
import test from 'node:test';
import { AnonymoApiError, createAnonymoClient } from '../lib/anonymo/client.ts';
import { compareSizes, comparisonTotal, formatComparePrice, planComparison, runComparison, toggleCompareModel } from '../lib/anonymo/compare.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';
import { usdToMusd } from '../lib/anonymo/money.ts';
import { parseUpdates, updateOn } from '../lib/anonymo/updates.ts';

const model = (id, price, sizes = ['1024x1024']) => ({ id, pricing: { usd_per_image: price }, sizes });
const first = model('image-a', '0.0505', ['1024x1024', '1536x1024']);
const second = model('image-b', '0.008', ['768x768', '1024x1024']);
const third = model('image-c', '0.01');
const fourth = model('image-d', '0.002');

test('compare has its own opt-in and is always on in demo', () => {
  assert.equal(parseUpdates().has('compare'), false);
  assert.equal(parseUpdates('images').has('compare'), false);
  assert.equal(parseUpdates('images,compare').has('compare'), true);
  assert.equal(parseUpdates('all').has('compare'), true);
  assert.equal(updateOn('compare', true), true);
});

test('selection accepts any catalog models up to four and can remove a selected model', () => {
  const ids = Array.from({ length: 12 }, (_, i) => `image-${i}`);
  const selected = ids.reduce(toggleCompareModel, []);
  assert.deepEqual(selected, ids.slice(0, 4));
  const removed = toggleCompareModel(selected, ids[1]);
  assert.deepEqual(toggleCompareModel(removed, ids.at(-1)), [ids[0], ids[2], ids[3], ids.at(-1)]);
});

test('the price sums one image per model and size falls back only where unsupported', () => {
  assert.deepEqual(compareSizes([first, second]), ['1024x1024', '1536x1024', '768x768']);
  const plan = planComparison([first, second], '1536x1024');
  assert.deepEqual(plan.map(({ size }) => size), ['1536x1024', '768x768']);
  assert.equal(comparisonTotal(plan), 58_500);
  assert.equal(formatComparePrice(comparisonTotal(plan)), '$0.0585');
  assert.equal(formatComparePrice(80_000), '$0.08');
});

test('out-of-range and duplicate comparisons send no requests', async () => {
  const generate = () => assert.fail('invalid comparison sent a request');
  for (const models of [[], [first], [first, first], [first, second, third, fourth, model('image-e', '1')]]) {
    await runComparison(planComparison(models, '1024x1024'), 'A lighthouse', generate, assert.fail);
  }
  await runComparison(planComparison([first, second], '1024x1024'), '  ', generate, assert.fail);
});

test('requests start in parallel and a success arrives independently of a block and failures', async () => {
  const plan = planComparison([first, second, third, fourth], '1536x1024');
  const requests = [];
  const jobs = new Map();
  const results = new Map();
  const run = runComparison(plan, '  A lighthouse  ', (body) => {
    requests.push(body);
    const job = Promise.withResolvers();
    jobs.set(body.model, job);
    return job.promise;
  }, (id, result) => results.set(id, result));

  assert.deepEqual(requests, plan.map(({ model: m, size }) => ({ model: m.id, size, n: 1, prompt: 'A lighthouse' })));
  const receipt = { payload: { request_id: 'sample-request' }, sig: 'sample-signature' };
  const png = Uint8Array.from([137, 80, 78, 71]);
  jobs.get(second.id).resolve({
    data: [{ b64_json: Buffer.from(png).toString('base64') }],
    anonymo: { request_id: 'sample-request', cost_usd: '0.007', receipt },
  });
  await Promise.resolve();
  assert.equal(results.size, 1);
  assert.deepEqual(results.get(second.id), { status: 'ready', price: 7000, png, requestId: 'sample-request', receipt });

  jobs.get(first.id).reject(new AnonymoApiError(451, 'media_blocked', 'Safety check failed'));
  jobs.get(third.id).reject(new AnonymoApiError(502, 'upstream_failure', 'Provider unavailable'));
  jobs.get(fourth.id).resolve({ data: [], anonymo: {} });
  await run;
  assert.deepEqual([...results.values()].map(({ status }) => status), ['ready', 'blocked', 'failed', 'unconfirmed']);
});

test('demo image requests return their own receipts and debit only successful images', async () => {
  const mock = createMockGateway({ imageDelayMs: 0 });
  const options = { baseUrl: 'https://demo.anonymo.invalid', fetch: mock.fetch };
  const { key } = await createAnonymoClient(options).createKey();
  const client = createAnonymoClient({ ...options, key });
  const models = (await client.mediaModels()).data.filter((m) => m.kind === 'image' && !m.edit).slice(0, 2);
  const plan = planComparison(models, compareSizes(models)[0]);
  const price = comparisonTotal(plan);
  await mock.simulateDeposit(key, 'rhc', 'USDG', price);

  const results = [];
  await runComparison(plan, 'A nude portrait', client.generateImages, (_id, result) => results.push(result));
  assert.deepEqual(results.map(({ status }) => status), ['blocked', 'blocked']);
  assert.equal(usdToMusd((await client.balance()).available_usd), price);

  const ready = new Map();
  await runComparison(plan, 'A lighthouse', client.generateImages, (id, result) => ready.set(id, result));
  for (const image of plan) {
    const result = ready.get(image.model.id);
    assert.equal(result.status, 'ready');
    assert.equal(result.price, image.price);
    assert.equal(result.receipt.payload.request_id, result.requestId);
    assert.equal(result.receipt.payload.model_id, image.model.id);
    assert.equal(result.receipt.payload.media_units, 1);
    assert.match(result.receipt.payload.outputs_sha256[0], /^[a-f\d]{64}$/);
    assert.equal(result.receipt.sig, null);
  }
  assert.equal(new Set([...ready.values()].map(({ requestId }) => requestId)).size, 2);
  assert.equal(usdToMusd((await client.balance()).available_usd), 0);

  // Both calls can afford one image when they start. Only one can settle.
  await mock.simulateDeposit(key, 'rhc', 'USDG', Math.max(...plan.map(({ price }) => price)));
  const partial = [];
  await runComparison(plan, 'A lighthouse', client.generateImages, (_id, result) => partial.push(result.status));
  assert.deepEqual(partial.sort(), ['failed', 'ready']);
  assert.ok(usdToMusd((await client.balance()).available_usd) >= 0);
});
