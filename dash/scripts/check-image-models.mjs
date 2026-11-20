import assert from 'node:assert/strict';
import test from 'node:test';
import { AnonymoApiError, createAnonymoClient } from '../lib/anonymo/client.ts';
import { usdToMusd } from '../lib/anonymo/money.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';

const models = [
  ['google/nano-banana', '0.050', 4, '1344x768'],
  ['openai/gpt-image-2', '0.080', 4, '1536x1024'],
  ['bfl/flux.2-max', '0.090', 4, '720x1280'],
  ['bfl/flux.2-flash', '0.032', 4, '1280x720'],
  ['ideogram/v4.5', '0.076', 8, '720x1280'],
  ['recraft/v4.1', '0.050', 8, '576x1024'],
  ['krea/krea-2-medium', '0.038', 4, '1280x720'],
  ['xai/grok-imagine-2', '0.076', 4, '720x1280'],
];

void test('demo lists all eight image models and generates billable PNG batches at their listed prices and sizes', async () => {
  const mock = createMockGateway({ delayMs: 0, imageDelayMs: 0 });
  const transport = { baseUrl: 'https://demo.anonymo.invalid', fetch: mock.fetch };
  const { key } = await createAnonymoClient(transport).createKey();
  const client = createAnonymoClient({ ...transport, key });
  await mock.simulateDeposit(key, 'rhc', 'USDG', 5_000_000);
  const { data } = await client.mediaModels();
  assert.deepEqual(data.filter((model) => model.kind === 'image').map((model) => model.id), models.map(([id]) => id));
  let balance = usdToMusd((await client.balance()).available_usd);
  for (const [id, price, max, size] of models) {
    const model = data.find((entry) => entry.id === id);
    assert.equal(model.max_images, max);
    assert.equal(model.pricing.usd_per_image, price);
    assert.ok(model.sizes.includes('1024x1024') && model.sizes.includes(size));
    const request = { model: id, prompt: 'A lighthouse at dusk', size };
    await assert.rejects(client.generateImages({ ...request, n: max + 1 }), (e) => e instanceof AnonymoApiError && e.status === 400);
    const reply = await client.generateImages({ ...request, n: max });
    assert.equal(reply.anonymo.model, id);
    assert.equal(reply.data.length, max);
    for (const image of reply.data) assert.equal(Buffer.from(image.b64_json, 'base64').subarray(1, 4).toString(), 'PNG');
    const cost = usdToMusd(price) * max;
    assert.equal(usdToMusd(reply.anonymo.cost_usd), cost);
    balance -= cost;
    assert.equal(usdToMusd((await client.balance()).available_usd), balance);
  }
});
