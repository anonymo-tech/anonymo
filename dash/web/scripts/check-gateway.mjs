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
