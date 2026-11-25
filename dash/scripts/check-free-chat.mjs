import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnonymoClient } from '../lib/anonymo/client.ts';
import { FREE_DEVICE_SLOT, FREE_PROOF_HEADER, FREE_TOKEN_HEADER, freeContext, freeDevice, hasFreeWork, solveFreeWork } from '../lib/anonymo/free-chat.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';
import { parseUpdates, updateOn } from '../lib/anonymo/updates.ts';

function memoryStorage() {
  const data = new Map();
  return { data, getItem: (slot) => data.get(slot) ?? null, setItem: (slot, value) => data.set(slot, value) };
}

test('free chat is a build opt-in and is available in demo mode', () => {
  assert.equal(parseUpdates(undefined).has('free'), false);
  assert.equal(parseUpdates('FREE').has('free'), true);
  assert.equal(updateOn('free', true), true);
});

test('device tokens are random, persist across sends and are isolated from demo', () => {
  const storage = memoryStorage();
  const token = freeDevice(storage, false);
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(freeDevice(storage, false), token);
  assert.equal(storage.getItem(FREE_DEVICE_SLOT), token);
  assert.notEqual(freeDevice(storage, true), token);
  assert.notEqual(freeDevice(memoryStorage(), false), token);
});

test('free chat keeps the newest text and instructions inside the gateway limits', () => {
  const system = { role: 'system', content: 'Reply in one paragraph.' };
  const latest = { role: 'user', content: 'The latest question.' };
  const turns = Array.from({ length: 48 }, () => ({ role: 'user', content: '🟣'.repeat(1024), name: 'sample-user' }));
  const context = freeContext([system, ...turns, latest]);
  assert.deepEqual(context[0], system);
  assert.deepEqual(context.at(-1), latest);
  assert.ok(context.length < 32);
  assert.ok(context.reduce((n, message) => n + Buffer.byteLength(message.content), 0) <= 32_768);
  assert.equal(context.some((message) => 'name' in message), false);
  assert.throws(() => freeContext([system, { ...latest, content: 'x'.repeat(32_769) }]), /too long/);
});

test('the worker solver uses SHA-256 leading bits and exits on expiry', async () => {
  const challenge = 'sample-puzzle';
  const nonce = await solveFreeWork(challenge, 9, Date.now() + 5000);
  assert.equal(Number.isSafeInteger(nonce), true);
  assert.equal(await hasFreeWork(challenge, nonce, 9), true);
  assert.equal(await solveFreeWork(challenge, 9, Date.now() - 1), null);
});

test('the keyless demo uses the same challenge, worker solution, chat and receipt flow', async () => {
  const storage = memoryStorage();
  const mock = createMockGateway({ storage });
  const requests = [];
  const client = createAnonymoClient({
    baseUrl: 'https://example.test', fetch: (url, init) => {
      requests.push({ path: new URL(url).pathname, headers: new Headers(init.headers), body: init.body });
      return mock.fetch(url, init);
    },
  });
  const token = freeDevice(storage, true);
  const prompt = 'Message content that must stay in transit.';
  const body = { model: 'anonymo-rp', messages: [{ role: 'user', content: prompt }] };
  let remaining = 10;
  for (let i = 0; i < 10; i++) {
    const challenge = await client.freeChallenge(token);
    assert.equal(challenge.remaining, remaining);
    const nonce = await solveFreeWork(challenge.challenge, challenge.difficulty, challenge.expires);
    const proof = `${challenge.challenge}:${nonce}:0`;
    const options = { free: { token, proof, onRemaining: (left) => { remaining = left; } } };
    const reply = await client.chat(body, options);
    assert.equal(remaining, 9 - i);
    assert.ok(reply.content);
    assert.equal(reply.receipt.cost, '0');
    assert.equal(reply.receipt.routes[0].route, 'selfhost:moderated-chat');
    assert.ok(reply.receiptId);
    if (i === 0) await assert.rejects(() => client.chat(body, options), { code: 'invalid_free_proof' });
  }
  const exhausted = await client.freeChallenge(token);
  assert.equal(exhausted.remaining, 0);
  assert.equal(exhausted.challenge, null);
  assert.equal(requests.some((request) => request.headers.has('authorization')), false);
  assert.ok(requests.every((request) => request.headers.get(FREE_TOKEN_HEADER) === token));
  assert.ok(requests.filter((request) => request.body).every((request) => request.headers.has(FREE_PROOF_HEADER)));
  assert.ok([...storage.data.values()].every((value) => !value.includes(prompt)));
  const reopened = createMockGateway({ storage });
  assert.equal((await createAnonymoClient({ baseUrl: 'https://example.test', fetch: reopened.fetch }).freeChallenge(token)).remaining, 0);
});
