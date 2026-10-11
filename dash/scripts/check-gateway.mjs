import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGatewayClient,
  modelForFamily,
  parseUsd6,
  GatewayError,
  publicGatewayError,
} from '../server/gateway/index.ts';
import {
  recordedStream,
  recordedStreams,
  recordedText,
  reviewedPricing as recordedPricing,
} from './fixtures/gateway-recorded.mjs';

const key = 'test-key-not-a-credential';
const input = {
  modelId: 'gpt-6.1-sol',
  messages: [{ role: 'user', content: 'A local test' }],
};
const imageInput = {
  modelId: 'nano-banana-2',
  prompt: 'A local test',
  clientRequestId: 'image_operation_1',
};
const videoInput = {
  modelId: 'runway-gen4',
  prompt: 'A local test',
  duration: 5,
  aspectRatio: '16:9',
  quality: '720p',
};
const output = {
  url: 'https://api.inference.invalid/v1/media/gen_test/0?sig=test&exp=1',
  content_type: 'image/png',
};
const data = (value) => `data: ${JSON.stringify(value)}\n\n`;
const end =
  data({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
  'data: [DONE]\n\n';
const collect = async (stream) => {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
};
function sse(text, split = 7, cancel = () => {}) {
  const encoded = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === encoded.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoded.slice(offset, offset + split));
        offset = Math.min(offset + split, encoded.length);
      },
      cancel,
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const client = (fetch, extra = {}) =>
  createGatewayClient({ apiKey: key, fetch, ...extra });
const failure = (code, ambiguous) => (error) => {
  assert.ok(error instanceof GatewayError);
  assert.equal(error.code, code);
  assert.equal(error.billingAmbiguous, ambiguous);
  return true;
};

void test('USD6 rounds sub-micro-dollar and exponent costs up and rejects negative, malformed, and unsafe inputs', () => {
  assert.equal(parseUsd6('0.000001'), 1);
  assert.equal(parseUsd6('0.123456'), 123456);
  assert.equal(parseUsd6('9007199254.740991'), Number.MAX_SAFE_INTEGER);
  assert.equal(parseUsd6(12), 12_000_000);
  // Recorded GATEWAY costs: 7 and 8 decimal places round up to the micro-dollar.
  assert.equal(parseUsd6('0.0000124'), 13);
  assert.equal(parseUsd6('0.00032604'), 327);
  assert.equal(parseUsd6('0.0003872'), 388);
  assert.equal(parseUsd6('0.000448'), 448);
  assert.equal(parseUsd6('0.0000001'), 1);
  assert.equal(parseUsd6('0.00000000000000000001'), 1);
  assert.equal(parseUsd6('1.0000000'), 1_000_000);
  assert.equal(parseUsd6('0.0000010000000'), 1);
  // Exponent notation, either case and sign.
  assert.equal(parseUsd6('3.1e-05'), 31);
  assert.equal(parseUsd6('3.1E-05'), 31);
  assert.equal(parseUsd6('1e-6'), 1);
  assert.equal(parseUsd6('1e-7'), 1);
  assert.equal(parseUsd6('1.5e+2'), 150_000_000);
  assert.equal(parseUsd6('2E1'), 20_000_000);
  assert.equal(parseUsd6('0e5'), 0);
  assert.equal(parseUsd6('0.0'), 0);
  assert.equal(parseUsd6('9.007199254740991e9'), Number.MAX_SAFE_INTEGER);
  for (const value of [
    '-0',
    '-1',
    '-0.0000124',
    '-3.1e-05',
    '+1',
    '01',
    ' 1',
    '1 ',
    '',
    '.5',
    '1.',
    '1e',
    '1e+',
    'e5',
    '0x10',
    'NaN',
    'Infinity',
    '1e1000',
    '1e400',
    '1e17',
    '9007199254.740992',
    '9007199254.7409911',
    '1'.repeat(65),
    0.1,
    -0,
    -1,
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    Infinity,
    null,
    undefined,
    {},
    [],
  ])
    assert.throws(
      () => parseUsd6(value),
      RangeError,
      JSON.stringify(value) ?? 'undefined',
    );
});

void test('missing key and strict privacy never send a request', async () => {
  let requests = 0;
  const fetch = async () => {
    requests += 1;
    throw new Error('must not run');
  };
  const unconfigured = createGatewayClient({ fetch });
  assert.equal(unconfigured.configured, false);
  await assert.rejects(
    collect(unconfigured.chat(input)),
    failure('unavailable', false),
  );
  await assert.rejects(
    collect(client(fetch).chat({ ...input, privacy: 'strict' })),
    failure('privacy_unavailable', false),
  );
  assert.equal(requests, 0);
});

void test('family allowlist rejects aliases, unknown families, and prototype keys', () => {
  assert.equal(modelForFamily('gpt'), 'gpt-6.1-sol');
  assert.equal(modelForFamily('deepseek'), 'deepseek/deepseek-v4-pro-0813');
  assert.equal(modelForFamily('qwen'), 'qwen/qwen3.8-2.4t-a95b');
  assert.equal(modelForFamily('llama'), 'meta-llama/llama-4-scout');
  assert.equal(modelForFamily('sora'), null);
  assert.equal(modelForFamily('__proto__'), null);
});

void test('reviewed open-weight families send only their exact text model IDs and cannot request strict privacy', async () => {
  for (const family of ['deepseek', 'qwen', 'llama']) {
    let calls = 0;
    const modelId = modelForFamily(family);
    const provider = client(async (_url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      assert.equal(body.model, modelId);
      assert.equal(body.stream, true);
      return sse(
        data({ choices: [{ delta: { content: 'Mock review' } }] }) + end,
      );
    });
    const events = await collect(
      provider.chat({ ...input, modelId, privacy: 'standard' }),
    );
    assert.equal(events[0].text, 'Mock review');
    await assert.rejects(
      collect(provider.chat({ ...input, modelId, privacy: 'strict' })),
      failure('privacy_unavailable', false),
    );
    await assert.rejects(
      collect(provider.chat({ ...input, modelId: family })),
      failure('invalid_request', false),
    );
    assert.equal(calls, 1);
  }
});

void test('open-weight catalog rates normalize exactly and privacy labels never certify strict routing', async () => {
  const rows = [
    ['deepseek/deepseek-v4-pro-0813', '0.6963', '2.0889', 696300, 2088900],
    ['qwen/qwen3.8-2.4t-a95b', '2.11', '6.33', 2110000, 6330000],
    ['meta-llama/llama-4-scout', '0.1055', '0.3165', 105500, 316500],
  ];
  const models = await client(async () =>
    json({
      data: rows.map(([id, inputPrice, outputPrice]) => ({
        id,
        type: 'chat',
        privacyLevel: 'zdr',
        supported_parameters: [
          'max_tokens',
          'response_format',
          'structured_outputs',
        ],
        pricing: {
          currency: 'USD',
          input_per_1M_tokens: inputPrice,
          output_per_1M_tokens: outputPrice,
        },
      })),
    }),
  ).catalog();
  assert.equal(models.length, 3);
  for (const [id, _inputPrice, _outputPrice, inputUsd6, outputUsd6] of rows) {
    const model = models.find((entry) => entry.id === id);
    assert.equal(model.pricing.inputPerMillionUsd6, inputUsd6);
    assert.equal(model.pricing.outputPerMillionUsd6, outputUsd6);
    assert.equal(model.strictPrivacyAvailable, false);
  }
});

void test('chat SSE handles split UTF-8, CRLF, comments, empty final choices, and exact numeric costs', async () => {
  let captured;
  const text =
    ': gateway-routing-receipt {"private":"ignored"}\r\n\r\n' +
    data({
      choices: [{ delta: { content: 'Hello 🌱' }, finish_reason: null }],
    }).replaceAll('\n', '\r\n') +
    'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16,"cost":0.123456}}\r\n\r\n' +
    end;
  const events = await collect(
    client(async (url, init) => {
      captured = { url, init };
      return sse(text, 1);
    }).chat(input),
  );
  assert.equal(captured.url, 'https://api.inference.invalid/v1/chat/completions');
  assert.equal(captured.init.redirect, 'error');
  assert.equal(captured.init.credentials, 'omit');
  assert.equal(captured.init.headers.Authorization, `Bearer ${key}`);
  assert.equal(JSON.parse(captured.init.body).max_tokens, 1024);
  assert.equal(events[0].text, 'Hello 🌱');
  assert.deepEqual(events.at(-1), {
    type: 'done',
    finishReason: 'stop',
    costUsd6: 123456,
    costSource: 'provider',
    usageCostUsd6: null,
    providerCostUsd6: 123456,
    providerId: null,
    usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
  });
});

void test('completed stream with missing usage/cost leaves them unknown', async () => {
  const events = await collect(client(async () => sse(end)).chat(input));
  assert.equal(events.at(-1).costUsd6, null);
  assert.equal(events.at(-1).usage, null);
  assert.equal(events.at(-1).providerId, null);
});

// Recorded real GATEWAY /v1/chat/completions stream shape (2026-10-10, 16-token
// probe). The routing receipt is trimmed; it is an SSE comment either way.
// The completion id and timestamp are synthetic placeholders.
// Usage is Anthropic-style and the stream carries no cost field at all.
const recordedFrames = (usage) =>
  ': gateway-routing-receipt {"v":2,"request_id":"probe_stream_1","route":"direct"}\n\n' +
  ': gateway-routing-receipt-sig {"alg":"ECDSA-SHA256","sig":"fixture"}\n\n' +
  'data: {"id":"chatcmpl-fixture0000000001","object":"chat.completion.chunk","created":1700000000,"model":"anthropic/claude-opus-5.5","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n' +
  'data: {"id":"chatcmpl-fixture0000000001","object":"chat.completion.chunk","created":1700000000,"model":"anthropic/claude-opus-5.5","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
  'data: {"id":"chatcmpl-fixture0000000001","object":"chat.completion.chunk","created":1700000000,"model":"anthropic/claude-opus-5.5","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
  `data: {"id":"chatcmpl-fixture0000000001","object":"chat.completion.chunk","created":1700000000,"model":"anthropic/claude-opus-5.5","choices":[],"usage":${usage}}\n\n` +
  'data: [DONE]\n\n';
const recordedUsage =
  '{"input_tokens":20,"output_tokens":4,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}';
const reviewedPricing = {
  inputPerMillionUsd6: '4220000',
  outputPerMillionUsd6: '21100000',
};

void test('recorded GATEWAY stream: usage without cost stays unknown unless reviewed pricing is supplied', async () => {
  const plain = await collect(
    client(async () => sse(recordedFrames(recordedUsage), 5)).chat(input),
  );
  assert.deepEqual(plain[0], {
    type: 'reference',
    providerId: 'chatcmpl-fixture0000000001',
  });
  assert.equal(plain.find((event) => event.type === 'text').text, 'ok');
  assert.deepEqual(plain.at(-1), {
    type: 'done',
    finishReason: 'stop',
    usage: { inputTokens: 20, outputTokens: 4, totalTokens: null },
    costUsd6: null,
    costSource: null,
    usageCostUsd6: null,
    providerCostUsd6: null,
    providerId: 'chatcmpl-fixture0000000001',
  });
  const priced = await collect(
    client(async () => sse(recordedFrames(recordedUsage), 5)).chat({
      ...input,
      pricing: reviewedPricing,
    }),
  );
  // 20 × 4.22 + 4 × 21.10 USD per million = 168.8 micro-USD, rounded up.
  assert.equal(priced.at(-1).costUsd6, 169);
  assert.equal(priced.at(-1).costSource, 'usage');
  assert.equal(
    (
      await collect(
        client(async () => sse(recordedFrames(recordedUsage))).chat({
          ...input,
          pricing: { inputPerMillionUsd6: 1000000, outputPerMillionUsd6: 0 },
        }),
      )
    ).at(-1).costUsd6,
    20,
  );
});

void test('usage-derived cost fails closed on other billable components and never overrides a provider cost', async () => {
  const derive = async (usage, pricing = reviewedPricing) =>
    (
      await collect(
        client(async () => sse(recordedFrames(usage))).chat({
          ...input,
          pricing,
        }),
      )
    ).at(-1);
  for (const usage of [
    '{"input_tokens":20,"output_tokens":4,"cache_read_input_tokens":3,"cache_creation_input_tokens":0}',
    '{"input_tokens":20,"output_tokens":4,"cache_creation_input_tokens":1}',
    // Cached prompt tokens have no reviewed rate (GATEWAY bills them discounted).
    '{"prompt_tokens":20,"completion_tokens":4,"total_tokens":24,"prompt_tokens_details":{"cached_tokens":2}}',
    '{"prompt_tokens":20,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":21}}',
    '{"prompt_tokens":20,"completion_tokens":4,"prompt_tokens_details":{"cache_write_tokens":2}}',
    '{"prompt_tokens":20,"completion_tokens":4,"prompt_tokens_details":{"audio_tokens":1}}',
    '{"prompt_tokens":20,"completion_tokens":4,"completion_tokens_details":{"image_tokens":1}}',
    '{"prompt_tokens":20,"completion_tokens":4,"total_tokens":30}',
    // Reasoning inside the completion count can never exceed it.
    '{"prompt_tokens":20,"completion_tokens":4,"total_tokens":24,"completion_tokens_details":{"reasoning_tokens":9}}',
    // Reasoning beside the completion count must account for the whole total.
    '{"prompt_tokens":20,"completion_tokens":4,"total_tokens":32,"completion_tokens_details":{"reasoning_tokens":9}}',
    // Without a total, reasoning within the completion count is ambiguous.
    '{"prompt_tokens":20,"completion_tokens":4,"completion_tokens_details":{"reasoning_tokens":3}}',
    '{"prompt_tokens":20,"completion_tokens":4,"completion_tokens_details":{"reasoning_tokens":"x"}}',
    '{"prompt_tokens":20,"completion_tokens":4,"completion_tokens_details":{"reasoning_tokens":1},"output_tokens_details":{"reasoning_tokens":2}}',
    '{"prompt_tokens":20,"completion_tokens":4,"server_tool_use":{"web_search_requests":1}}',
    '{"prompt_tokens":20,"completion_tokens":4,"extra_properties":{"google":{"cached_content_token_count":7}}}',
    '{"prompt_tokens":20,"completion_tokens":4,"audio_tokens":0.5}',
    '{"prompt_tokens":20,"completion_tokens":4,"audio_tokens":"0.5"}',
    '{"prompt_tokens":20}',
  ]) {
    const done = await derive(usage);
    assert.equal(done.costUsd6, null, usage);
    assert.equal(done.costSource, null, usage);
  }
  const openai = await derive(
    '{"prompt_tokens":20,"completion_tokens":4,"total_tokens":24,"is_byok":false,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":3},"cost_details":{"upstream_inference_cost":null}}',
  );
  assert.equal(openai.costUsd6, 169);
  assert.equal(openai.costSource, 'usage');
  // Zero cache counts are inert.
  const uncached = await derive(
    '{"prompt_tokens":20,"completion_tokens":4,"total_tokens":24,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":0,"audio_tokens":0,"video_tokens":0}}',
  );
  assert.equal(uncached.costUsd6, 169);
  // Cached usage settles at the provider cost, which carries the discount.
  const cached = await derive(
    '{"prompt_tokens":1251,"completion_tokens":128,"total_tokens":1379,"cost":0.001542,"prompt_tokens_details":{"cached_tokens":1152}}',
  );
  assert.equal(cached.costUsd6, 1542);
  assert.equal(cached.costSource, 'provider');
  assert.equal(cached.usageCostUsd6, null);
  // Reasoning reported beside the completion count is billed as output:
  // 20 × 4.22 + (4 + 9) × 21.10 = 358.7 micro-USD, rounded up.
  for (const usage of [
    '{"prompt_tokens":20,"completion_tokens":4,"total_tokens":33,"completion_tokens_details":{"reasoning_tokens":9}}',
    '{"prompt_tokens":20,"completion_tokens":4,"completion_tokens_details":{"reasoning_tokens":9}}',
  ]) {
    const separate = await derive(usage);
    assert.equal(separate.costUsd6, 359, usage);
    assert.equal(separate.costSource, 'usage', usage);
  }
  // Labels and flags are metadata, not billable counts.
  const labelled = await derive(
    '{"prompt_tokens":20,"completion_tokens":4,"total_tokens":24,"is_byok":false,"extra_properties":{"google":{"traffic_type":"ON_DEMAND","region":"2026-10-10"}},"service_tier":"standard"}',
  );
  assert.equal(labelled.costUsd6, 169);
  // A provider cost always wins over the usage price, higher or lower.
  const reported = await derive(
    '{"input_tokens":20,"output_tokens":4,"cost":0.0002}',
  );
  assert.equal(reported.costUsd6, 200);
  assert.equal(reported.costSource, 'provider');
  assert.equal(reported.usageCostUsd6, 169);
  assert.equal(reported.providerCostUsd6, 200);
  const lower = await derive(
    '{"input_tokens":20,"output_tokens":4,"cost":0.0001234}',
  );
  assert.equal(lower.costUsd6, 124);
  assert.equal(lower.costSource, 'provider');
  assert.equal(lower.usageCostUsd6, 169);
  assert.equal(lower.providerCostUsd6, 124);
  // A provider cost still settles usage that cannot be priced.
  const underivable = await derive(
    '{"input_tokens":20,"output_tokens":4,"cache_creation_input_tokens":5,"cost":0.0000124}',
  );
  assert.equal(underivable.costUsd6, 13);
  assert.equal(underivable.costSource, 'provider');
  assert.equal(underivable.usageCostUsd6, null);
});

// Live regression: a gpt-6.1-sol answer was delivered and settled at 0 because
// the stream's cost read 0. Every completion processes its prompt, so a zero
// cost or zero-token usage can never confirm that delivered output was free.
void test('a zero reported cost or zero-token usage never settles delivered output as free', async () => {
  const finish = async (text, pricing = reviewedPricing) =>
    (
      await collect(
        client(async () => sse(text)).chat({
          ...input,
          ...(pricing ? { pricing } : {}),
        }),
      )
    ).at(-1);
  // Zero cost beside billable usage falls back to the reviewed usage price.
  for (const usage of [
    '{"prompt_tokens":20,"completion_tokens":4,"total_tokens":24,"cost":0}',
    '{"prompt_tokens":20,"completion_tokens":4,"total_tokens":24,"is_byok":false,"cost":0.0,"cost_details":{"upstream_inference_cost":null}}',
    '{"input_tokens":20,"output_tokens":4,"cost":"0"}',
  ]) {
    const done = await finish(recordedFrames(usage));
    assert.equal(done.costUsd6, 169, usage);
    assert.equal(done.costSource, 'usage', usage);
  }
  // Without derivable usage or reviewed pricing, a zero cost stays unknown.
  for (const [text, pricing] of [
    [
      recordedFrames(
        '{"prompt_tokens":20,"completion_tokens":4,"prompt_tokens_details":{"cache_write_tokens":2},"cost":0}',
      ),
      reviewedPricing,
    ],
    [
      recordedFrames(
        '{"prompt_tokens":20,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":2},"cost":0}',
      ),
      reviewedPricing,
    ],
    [
      recordedFrames(
        '{"prompt_tokens":20,"completion_tokens":4,"cost":0,"cost_details":{"upstream_inference_cost":0}}',
      ),
      null,
    ],
    [
      recordedFrames('{"prompt_tokens":20,"completion_tokens":4,"cost":0}'),
      null,
    ],
    [
      data({ choices: [{ delta: { content: 'ok' } }], cost: 0 }) + end,
      reviewedPricing,
    ],
    [data({ choices: [], cost: 0 }) + end, reviewedPricing],
  ]) {
    const done = await finish(text, pricing);
    assert.equal(done.costUsd6, null);
    assert.equal(done.costSource, null);
  }
  // Usage that reports no prompt, or no output beside delivered text, is not derivable.
  for (const usage of [
    '{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}',
    '{"prompt_tokens":0,"completion_tokens":4,"total_tokens":4}',
    '{"prompt_tokens":20,"completion_tokens":0,"total_tokens":20}',
  ]) {
    const done = await finish(recordedFrames(usage));
    assert.equal(done.costUsd6, null, usage);
    assert.equal(done.costSource, null, usage);
  }
  // A positive provider cost is authoritative, even below the usage price.
  const reported = await finish(
    recordedFrames(
      '{"prompt_tokens":20,"completion_tokens":4,"cost":0.000001}',
    ),
  );
  assert.equal(reported.costUsd6, 1);
  assert.equal(reported.costSource, 'provider');
  assert.equal(reported.usageCostUsd6, 169);
  const unpriced = await finish(
    recordedFrames(
      '{"prompt_tokens":20,"completion_tokens":4,"cost":0.000001}',
    ),
    null,
  );
  assert.equal(unpriced.costUsd6, 1);
  assert.equal(unpriced.costSource, 'provider');
  // A BYOK zero cost falls back to the upstream inference cost, before usage.
  for (const pricing of [null, reviewedPricing]) {
    const byok = await finish(
      recordedFrames(
        '{"prompt_tokens":20,"completion_tokens":4,"cost":0,"is_byok":true,"cost_details":{"upstream_inference_cost":0.0000124}}',
      ),
      pricing,
    );
    assert.equal(byok.costUsd6, 13);
    assert.equal(byok.costSource, 'provider');
  }
  // A positive cost takes precedence over a different upstream cost.
  const both = await finish(
    recordedFrames(
      '{"prompt_tokens":20,"completion_tokens":4,"cost":0.00002,"cost_details":{"upstream_inference_cost":0.00009}}',
    ),
  );
  assert.equal(both.costUsd6, 20);
  assert.equal(both.providerCostUsd6, 20);
});

// Live regressions (2026-10-10): llama and deepseek costs with 7–8 decimals
// were rejected, gemini's separately reported reasoning made usage
// underivable, and gpt's BYOK zero cost settled a delivered answer for free.
void test('every recorded model stream settles at its exact canonical USD6', async () => {
  assert.deepEqual(
    [...new Set(recordedStreams.map((entry) => entry.family))].sort(),
    ['claude', 'deepseek', 'gemini', 'gpt', 'grok', 'llama', 'qwen'],
  );
  for (const entry of recordedStreams) {
    for (const split of [1, 7, 4096]) {
      let sent;
      const events = await collect(
        client(async (_url, init) => {
          sent = JSON.parse(init.body);
          return sse(recordedStream(entry), split);
        }).chat({
          modelId: entry.modelId,
          messages: [{ role: 'user', content: 'A recorded fixture' }],
          maxOutputTokens: 2048,
          pricing: recordedPricing[entry.family],
        }),
      );
      assert.equal(sent.model, entry.modelId);
      assert.deepEqual(events[0], {
        type: 'reference',
        providerId: entry.providerId,
      });
      assert.equal(
        events
          .filter((event) => event.type === 'text')
          .map((event) => event.text)
          .join(''),
        recordedText,
        entry.family,
      );
      const usage = events.filter((event) => event.type === 'usage').at(-1);
      assert.equal(usage.settlementUsd6, entry.expected.costUsd6, entry.family);
      assert.deepEqual(
        events.at(-1),
        {
          type: 'done',
          finishReason: 'stop',
          usage: entry.tokens,
          ...entry.expected,
          providerId: entry.providerId,
        },
        entry.family,
      );
      assert.ok(Number.isSafeInteger(events.at(-1).costUsd6));
      assert.ok(events.at(-1).costUsd6 > 0);
    }
    // Without reviewed pricing only a positive provider cost can settle.
    const unpriced = (
      await collect(
        client(async () => sse(recordedStream(entry))).chat({
          modelId: entry.modelId,
          messages: [{ role: 'user', content: 'A recorded fixture' }],
        }),
      )
    ).at(-1);
    assert.equal(unpriced.costUsd6, entry.expected.providerCostUsd6);
  }
});

void test('invalid reviewed pricing is rejected before any request', async () => {
  let requests = 0;
  const provider = client(async () => {
    requests++;
    return sse(end);
  });
  for (const pricing of [
    null,
    {},
    { inputPerMillionUsd6: '4.22', outputPerMillionUsd6: '1' },
    { inputPerMillionUsd6: '-1', outputPerMillionUsd6: '1' },
    { inputPerMillionUsd6: 1.5, outputPerMillionUsd6: 1 },
    { inputPerMillionUsd6: '01', outputPerMillionUsd6: '1' },
    { inputPerMillionUsd6: '9007199254740992', outputPerMillionUsd6: '1' },
  ])
    await assert.rejects(
      collect(provider.chat({ ...input, pricing })),
      failure('invalid_request', false),
    );
  assert.equal(requests, 0);
});

void test('recorded upstream 429 rate limit is unbilled and sanitized', async () => {
  const body = {
    error: {
      message: 'Provider returned error',
      code: 429,
      metadata: {
        provider_error_code: 'engine_overloaded',
        limit_source: 'upstream_provider_shared_pool',
      },
    },
  };
  try {
    await collect(client(async () => json(body, 429)).chat(input));
    assert.fail('expected rejection');
  } catch (error) {
    failure('provider_unavailable', false)(error);
    assert.ok(!JSON.stringify(publicGatewayError(error)).includes('shared_pool'));
  }
  // Other upstream failures still retain the reservation.
  await assert.rejects(
    collect(client(async () => json(body, 502)).chat(input)),
    failure('provider_unavailable', true),
  );
});

void test('chat returns an upstream generation ID for correlation without treating it as idempotency', async () => {
  const events = await collect(
    client(async () =>
      sse(
        data({
          id: 'gen-provider-123',
          choices: [{ delta: { content: 'Hi' } }],
        }) + end,
      ),
    ).chat(input),
  );
  assert.equal(events.at(-1).providerId, 'gen-provider-123');
  const conflict =
    data({ id: 'gen-first', choices: [] }) +
    data({ id: 'gen-second', choices: [] }) +
    end;
  await assert.rejects(
    collect(client(async () => sse(conflict)).chat(input)),
    failure('invalid_response', true),
  );
});

void test('CR-only SSE and multiline data are decoded', async () => {
  const text =
    'data: {"choices":\rdata: [{"delta":{"content":"hello"}}]}\r\r' +
    end.replaceAll('\n', '\r');
  const events = await collect(client(async () => sse(text, 1)).chat(input));
  assert.equal(events[0].text, 'hello');
});

void test('refusals retain a content-filter finish state', async () => {
  const text =
    data({
      choices: [
        {
          delta: { refusal: 'Cannot fulfill this request.' },
          finish_reason: 'content_filter',
        },
      ],
    }) + 'data: [DONE]\n\n';
  const events = await collect(client(async () => sse(text)).chat(input));
  assert.equal(events[0].type, 'refusal');
  assert.equal(events.at(-1).finishReason, 'content_filter');
});

void test('upstream SSE errors never export provider details and remain billing-ambiguous', async () => {
  const secret = 'upstream credential private prompt';
  try {
    await collect(
      client(async () =>
        sse(data({ error: { message: secret, code: 502 } })),
      ).chat(input),
    );
    assert.fail('expected rejection');
  } catch (error) {
    failure('provider_unavailable', true)(error);
    assert.ok(!JSON.stringify(publicGatewayError(error)).includes(secret));
    assert.equal(error.cause, undefined);
  }
});

void test('EOF without DONE or finish frame is never a completed billable answer', async () => {
  for (const text of [
    data({ choices: [{ delta: { content: 'Partial' } }] }),
    'data: [DONE]\n\n',
    end.replace('[DONE]\n\n', '[DONE]'),
  ])
    await assert.rejects(
      collect(client(async () => sse(text)).chat(input)),
      failure('stream_interrupted', true),
    );
});

void test('malformed or unrepresentable stream cost is rejected; sub-micro-dollar cost rounds up', async () => {
  for (const amount of ['-1', '-0.0000124', '9007199254740993', '1e400']) {
    for (const text of [
      `data: {"choices":[],"usage":{"cost":${amount}}}\n\n` + end,
      `data: {"choices":[],"usage":{"cost":0,"cost_details":{"upstream_inference_cost":${amount}}}}\n\n` +
        end,
      `data: {"choices":[],"usage":{"cost":"${amount}x"}}\n\n` + end,
    ])
      await assert.rejects(
        collect(client(async () => sse(text)).chat(input)),
        failure('invalid_response', true),
        text,
      );
  }
  for (const [amount, expected] of [
    ['0.0000001', 1],
    ['1e-7', 1],
    ['3.1e-05', 31],
    ['0.00032604', 327],
  ]) {
    const text = `data: {"choices":[],"usage":{"cost":${amount}}}\n\n` + end;
    const done = (await collect(client(async () => sse(text)).chat(input))).at(
      -1,
    );
    assert.equal(done.costUsd6, expected, amount);
    assert.equal(done.costSource, 'provider', amount);
  }
});

void test('HTTP authorization and balance rejection are sanitized and not ambiguous', async () => {
  for (const [status, code] of [
    [401, 'authentication'],
    [402, 'insufficient_credit'],
  ]) {
    let requests = 0;
    const service = client(async () => {
      requests += 1;
      return json(
        { message: 'credit-id and secret must stay private' },
        status,
      );
    });
    await assert.rejects(service.submitVideo(videoInput), failure(code, false));
    assert.equal(requests, 1);
  }
});

void test('network failure after dispatch is ambiguous and never retried', async () => {
  let requests = 0;
  const service = client(async () => {
    requests += 1;
    throw new Error('private URL and key');
  });
  await assert.rejects(
    service.submitVideo(videoInput),
    failure('provider_unavailable', true),
  );
  assert.equal(requests, 1);
});

void test('timeout bounds a fetch which ignores AbortSignal', async () => {
  const service = client(() => new Promise(() => {}), {
    timeouts: { requestMs: 5 },
  });
  await assert.rejects(
    service.submitVideo(videoInput),
    failure('timeout', true),
  );
});

void test('pre-dispatch abort is unbilled; stream read timeout is ambiguous', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    collect(
      client(async () => assert.fail('no fetch')).chat({
        ...input,
        signal: controller.signal,
      }),
    ),
    failure('cancelled', false),
  );
  const stalled = client(
    async () =>
      new Response(new ReadableStream({ start() {} }), {
        headers: { 'content-type': 'text/event-stream' },
      }),
    { timeouts: { chatMs: 5 } },
  );
  await assert.rejects(collect(stalled.chat(input)), failure('timeout', true));
});

void test('consumer returning early aborts the underlying stream', async () => {
  let signal;
  const service = client(async (_url, init) => {
    signal = init.signal;
    return sse(data({ choices: [{ delta: { content: 'One' } }] }) + end, 1);
  });
  const iterator = service.chat(input);
  await iterator.next();
  await iterator.return();
  assert.equal(signal.aborted, true);
});

void test('oversized request is rejected before network; oversized response preserves uncertainty', async () => {
  await assert.rejects(
    collect(
      client(async () => assert.fail('no fetch')).chat({
        ...input,
        messages: Array.from({ length: 10 }, () => ({
          role: 'user',
          content: 'x'.repeat(64_000),
        })),
      }),
    ),
    failure('invalid_request', false),
  );
  await assert.rejects(
    collect(
      client(async () => sse(`data: ${'x'.repeat(140_000)}\n\n`)).chat(input),
    ),
    failure('response_too_large', true),
  );
});

void test('image generation sends caller idempotency key and exact returned cost', async () => {
  let sent;
  const result = await client(async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return new Response(
      '{"model":"nano-banana-2","cost":0.092,"data":' +
        JSON.stringify([output]) +
        '}',
      { headers: { 'content-type': 'application/json' } },
    );
  }).generateImage(imageInput);
  assert.equal(sent.body.client_request_id, imageInput.clientRequestId);
  assert.equal(sent.body.response_format, 'url');
  assert.equal(result.costUsd6, 92_000);
  assert.equal(result.status, 'completed');
});

void test('image timeout is not resubmitted; explicit recovery only performs GET', async () => {
  let requests = 0;
  let recoveredUrl;
  const service = client(async (url, init) => {
    requests += 1;
    if (init.method === 'POST') throw new Error('connection lost');
    recoveredUrl = url;
    return json({ model: imageInput.modelId, data: [output] });
  });
  await assert.rejects(
    service.generateImage(imageInput),
    failure('provider_unavailable', true),
  );
  assert.equal(requests, 1);
  const result = await service.recoverImage(imageInput.clientRequestId);
  assert.equal(
    recoveredUrl,
    'https://api.inference.invalid/v1/images/generations/by-key/image_operation_1',
  );
  assert.equal(result.costUsd6, null);
  assert.equal(requests, 2);
});

void test('signed output and upload origins are allowlisted', async () => {
  const service = client(async () =>
    json({ data: [{ ...output, url: 'https://evil.invalid/steal' }] }),
  );
  await assert.rejects(
    service.generateImage(imageInput),
    failure('invalid_response', true),
  );
  await assert.rejects(
    client(async () => assert.fail('no fetch')).generateImage({
      ...imageInput,
      imageUrl: 'http://127.0.0.1/private',
    }),
    failure('invalid_request', false),
  );
  let source;
  await client(
    async (_url, init) => {
      source = JSON.parse(init.body).image_url;
      return json({ data: [output] });
    },
    { referenceOrigins: ['https://uploads.conclave.invalid'] },
  ).generateImage({
    ...imageInput,
    imageUrl: 'https://uploads.conclave.invalid/image?token=private',
  });
  assert.equal(source, 'https://uploads.conclave.invalid/image?token=private');
});

void test('video submission and explicit polls retain estimated versus actual cost', async () => {
  let requests = 0;
  const service = client(async (_url, init) => {
    requests += 1;
    return init.method === 'POST'
      ? json(
          {
            id: 'gen_video',
            model: videoInput.modelId,
            status: 'pending',
            estimated_cost: '0.069',
          },
          202,
        )
      : json({
          id: 'gen_video',
          model: videoInput.modelId,
          status: 'completed',
          cost: '0.068',
          data: { ...output, content_type: 'video/mp4' },
        });
  });
  const submitted = await service.submitVideo(videoInput);
  assert.equal(submitted.estimatedCostUsd6, 69_000);
  assert.equal(submitted.costUsd6, null);
  assert.equal(requests, 1);
  const result = await service.videoStatus(submitted.id);
  assert.equal(result.costUsd6, 68_000);
  assert.equal(result.estimatedCostUsd6, null);
  assert.equal(requests, 2);
});

void test('failed video preserves actual billed cost while omitting raw provider error', async () => {
  const result = await client(async () =>
    json({ id: 'gen_video', status: 'failed', cost: '0.01', error: 'secret' }),
  ).videoStatus('gen_video');
  assert.equal(result.status, 'failed');
  assert.equal(result.costUsd6, 10_000);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

void test('unsupported video options and unsafe lookup IDs never reach GATEWAY', async () => {
  const service = client(async () => assert.fail('no fetch'));
  await assert.rejects(
    service.submitVideo({ ...videoInput, duration: 6 }),
    failure('invalid_request', false),
  );
  await assert.rejects(
    service.submitVideo({ ...videoInput, modelId: 'sora' }),
    failure('invalid_request', false),
  );
  await assert.rejects(
    service.videoStatus('../keys'),
    failure('invalid_request', false),
  );
});

void test('poll rejects a mismatched job ID', async () => {
  await assert.rejects(
    client(async () =>
      json({ id: 'another_job', status: 'pending' }),
    ).videoStatus('gen_video'),
    failure('invalid_response', true),
  );
});

void test('failed media lookups do not imply the original generation was unbilled', async () => {
  const service = client(async () =>
    json({ message: 'private account detail' }, 404),
  );
  await assert.rejects(
    service.videoStatus('gen_video'),
    failure('not_found', true),
  );
  await assert.rejects(
    service.recoverImage('image_operation_1'),
    failure('not_found', true),
  );
});

void test('request correlation ID is restricted and forwarded separately from the prompt', async () => {
  let sent;
  await collect(
    client(async (_url, init) => {
      sent = init;
      return sse(end);
    }).chat({ ...input, requestId: 'operation_123' }),
  );
  assert.equal(sent.headers['x-request-id'], 'operation_123');
  await assert.rejects(
    collect(
      client(async () => assert.fail('no fetch')).chat({
        ...input,
        requestId: 'bad\r\nheader',
      }),
    ),
    failure('invalid_request', false),
  );
});

void test('SSE event size is counted as bytes for non-ASCII payloads', async () => {
  await assert.rejects(
    collect(
      client(async () =>
        sse(
          data({ choices: [{ delta: { content: '🌱'.repeat(33_000) } }] }),
          4096,
        ),
      ).chat(input),
    ),
    failure('response_too_large', true),
  );
});

void test('JSON content-type and exact money precision fail closed', async () => {
  await assert.rejects(
    client(
      async () =>
        new Response('{"data":[]}', {
          headers: { 'content-type': 'text/html; note=application/json' },
        }),
    ).catalog(),
    failure('invalid_response', false),
  );
  // Costs round up to the next micro-dollar; negative costs fail closed.
  const rounded = await client(
    async () =>
      new Response(
        '{"cost":0.0000001,"data":' + JSON.stringify([output]) + '}',
        { headers: { 'content-type': 'application/json' } },
      ),
  ).generateImage(imageInput);
  assert.equal(rounded.costUsd6, 1);
  await assert.rejects(
    client(
      async () =>
        new Response('{"cost":-0.01,"data":' + JSON.stringify([output]) + '}', {
          headers: { 'content-type': 'application/json' },
        }),
    ).generateImage(imageInput),
    failure('invalid_response', true),
  );
  // Reviewed catalog prices stay exact: sub-micro-dollar precision is rejected.
  await assert.rejects(
    client(async () =>
      json({
        data: [
          {
            id: 'gpt-6.1-sol',
            type: 'chat',
            pricing: {
              currency: 'USD',
              input_per_1M_tokens: '0.7912501',
              output_per_1M_tokens: '4.7475',
            },
          },
        ],
      }),
    ).catalog(),
    failure('invalid_response', false),
  );
});

void test('catalog normalizes only explicit supported IDs without claiming strict privacy', async () => {
  const models = await client(async () =>
    json({
      data: [
        {
          id: 'gpt-6.1-sol',
          type: 'chat',
          name: 'GPT',
          context_length: 400000,
          privacyLevel: 'zdr',
          pricing: {
            currency: 'USD',
            input_per_1M_tokens: '0.79125',
            output_per_1M_tokens: '4.7475',
          },
        },
        {
          id: 'veo3-fast-i2v',
          type: 'image',
          category: 'image-to-video',
          pricing: { currency: 'USD' },
        },
        { id: 'unknown', type: 'chat', pricing: { currency: 'USD' } },
      ],
    }),
  ).catalog();
  assert.equal(models.length, 1);
  assert.equal(models[0].pricing.inputPerMillionUsd6, 791250);
  assert.equal(models[0].contextLength, 400000);
  assert.equal(models[0].strictPrivacyAvailable, false);
  assert.equal(models[0].privacyLevel, 'zdr');
});
