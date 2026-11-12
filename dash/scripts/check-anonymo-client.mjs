// The typed gateway client against the in-browser mock gateway: the whole visitor path (key → deposit → balance →
// chat → receipt → proof → withdrawal), the error codes the UI explains, and the pure helpers.
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { AnonymoApiError, createAnonymoClient, describeError, readChatStream } from '../lib/anonymo/client.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';
import { formatUsd, parseUsd } from '../lib/anonymo/money.ts';
import { hashPair, rootFromProof, verifyInclusion } from '../lib/anonymo/proof.ts';
import { KEY_PLACEHOLDER, PRESETS, presetText } from '../lib/anonymo/presets.ts';
import { ANONYMO_MODEL_IDS } from '../lib/anonymo/types.ts';
import { CHAINS } from '../lib/anonymo/chains.ts';
import { isApiKey, maskKey } from '../lib/anonymo/key-store.ts';

const BASE = 'https://demo.anonymo.invalid';

async function funded(options = {}) {
  const mock = createMockGateway({ delayMs: 0, ...options });
  const anon = createAnonymoClient({ baseUrl: BASE, fetch: mock.fetch });
  const created = await anon.createKey();
  const client = createAnonymoClient({ baseUrl: BASE, fetch: mock.fetch, key: created.key });
  return { mock, client, created };
}

void test('POST /keys returns an anm_live_ key once, with a deposit address per chain', async () => {
  const { created } = await funded();
  assert.ok(isApiKey(created.key));
  assert.equal(created.key_prefix, created.key.slice(0, 13));
  assert.deepEqual(created.deposit_addresses.map((a) => a.chain).sort(), Object.keys(CHAINS).sort());
  for (const a of created.deposit_addresses) assert.deepEqual(a.tokens, CHAINS[a.chain].tokens);
  assert.ok(!maskKey(created.key).includes(created.key.slice(14, -4)));
});

void test('the visitor path: deposit → balance → streamed chat → receipt → verified proof → withdraw to source', async () => {
  const { mock, client, created } = await funded();
  await mock.simulateDeposit(created.key, 'base', 'USDC', 20_000_000);
  const before = await client.balance();
  assert.equal(before.available_musd, 20_000_000);
  assert.equal(before.sources[0].chain, 'base');

  let streamed = '';
  const reply = await client.chat(
    { model: 'anonymo-1', messages: [{ role: 'user', content: 'Explain the floor in one paragraph.' }] },
    { onDelta: (d) => (streamed += d) },
  );
  assert.ok(reply.content.length > 40);
  assert.equal(streamed, reply.content);
  assert.equal(reply.finishReason, 'stop');
  assert.ok(reply.receiptId);

  const signed = await client.receipt(reply.receiptId);
  assert.equal(signed.receipt.model_id, 'anonymo-1');
  assert.equal(signed.receipt.refused, false);
  assert.equal(signed.receipt.routes.length, 1);
  const proof = await client.receiptProof(reply.receiptId);
  assert.equal(proof.leaf, signed.leaf);
  assert.ok(proof.proof.length >= 2, 'a multi-level path');
  assert.ok(verifyInclusion(proof.leaf, proof.proof, proof.root));
  assert.ok(!verifyInclusion(proof.leaf, proof.proof.slice(1), proof.root));

  const after = await client.balance();
  assert.equal(after.held_musd, 0);
  assert.equal(after.available_musd, 20_000_000 - signed.receipt.cost_musd);

  const source = after.sources[0];
  const wd = await client.withdraw({ chain: source.chain, source_address: source.address, amount_musd: 'all' });
  assert.equal(wd.to, source.address);
  assert.equal(wd.amount_musd, after.available_musd);
  const empty = await client.balance();
  assert.equal(empty.available_musd, 0);
  assert.equal(empty.sources[0].withdrawable_musd, 0, 'spent credit is not withdrawable');
});

void test('property: across deposits, chats and withdrawals, sources never offer more than is available', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.oneof(fc.record({ op: fc.constant('deposit'), usd: fc.integer({ min: 1, max: 50 }), chain: fc.constantFrom('base', 'solana', 'tron') }), fc.record({ op: fc.constant('chat') }), fc.record({ op: fc.constant('withdraw'), part: fc.integer({ min: 1, max: 100 }) })), { maxLength: 8 }),
      async (ops) => {
        const { mock, client, created } = await funded();
        for (const o of ops) {
          if (o.op === 'deposit') await mock.simulateDeposit(created.key, o.chain, o.chain === 'tron' ? 'USDT' : 'USDC', o.usd * 1_000_000);
          if (o.op === 'chat') await client.chat({ model: 'anonymo-1', messages: [{ role: 'user', content: 'hi' }] }).catch(() => null);
          if (o.op === 'withdraw') {
            const s = (await client.balance()).sources.find((x) => x.withdrawable_musd > 0);
            if (s) await client.withdraw({ chain: s.chain, source_address: s.address, amount_musd: Math.max(1, Math.floor((s.withdrawable_musd * o.part) / 100)) });
          }
          const b = await client.balance();
          assert.ok(b.available_musd >= 0 && b.held_musd === 0);
          assert.ok(b.sources.reduce((t, x) => t + x.withdrawable_musd, 0) <= b.available_musd);
        }
      },
    ),
    { numRuns: 40 },
  );
});

void test('a refused first attempt is rerouted to another family and nets to zero on the ledger', async () => {
  const { mock, client, created } = await funded();
  await mock.simulateDeposit(created.key, 'solana', 'USDC', 5_000_000);
  const reply = await client.chat({ model: 'anonymo-1', messages: [{ role: 'user', content: 'please reroute this' }] });
  const { receipt } = await client.receipt(reply.receiptId);
  assert.equal(receipt.refused, true);
  assert.equal(receipt.routes.length, 2);
  assert.deepEqual(receipt.refused_routes, [receipt.routes[0]]);
  assert.ok(receipt.refund_musd > 0);
  const balance = await client.balance();
  assert.equal(balance.available_musd, 5_000_000 - receipt.cost_musd, 'the refused attempt costs nothing');
  assert.equal(balance.refused_refunded_musd, receipt.refund_musd);
});

void test('council returns the merged reply and every proposer; the receipt lists proposers and aggregator', async () => {
  const { mock, client, created } = await funded();
  await mock.simulateDeposit(created.key, 'arbitrum', 'USDT', 5_000_000);
  const reply = await client.chat({ model: 'anonymo-council', messages: [{ role: 'user', content: 'Compare two plans.' }] });
  assert.equal(reply.councilMode, 'merge');
  assert.equal(reply.council?.proposers.length, 3);
  assert.equal(new Set(reply.council.proposers.map((p) => p.family)).size, 3, 'three different families');
  const { receipt } = await client.receipt(reply.receiptId);
  assert.equal(receipt.routes.length, 4);
  const select = await client.chat(
    { model: 'anonymo-council', messages: [{ role: 'user', content: 'Pick one.' }] },
    { headers: { councilMode: 'select' } },
  );
  assert.equal(select.council.mode, 'select');
  assert.equal(select.council.aggregator, null);
});

void test('sealed carries an attestation quote hash, and fails with 409 rather than downgrading', async () => {
  const { mock, client, created } = await funded();
  await mock.simulateDeposit(created.key, 'base', 'USDC', 5_000_000);
  const reply = await client.chat({ model: 'anonymo-sealed', messages: [{ role: 'user', content: 'hi' }] });
  const { receipt } = await client.receipt(reply.receiptId);
  assert.match(receipt.attestation_quote_hash, /^0x[0-9a-f]{64}$/);

  const down = await funded({ sealedAvailable: false });
  await down.mock.simulateDeposit(down.created.key, 'base', 'USDC', 5_000_000);
  await assert.rejects(
    down.client.chat({ model: 'anonymo-sealed', messages: [{ role: 'user', content: 'hi' }] }),
    (e) => e instanceof AnonymoApiError && e.status === 409 && e.code === 'sealed_unavailable',
  );
  assert.equal((await down.client.balance()).available_musd, 5_000_000, 'nothing charged');
});

void test('no credit → 402, no key → 401, and the UI text explains each without echoing the prompt', async () => {
  const { client } = await funded();
  const secret = 'a prompt that must never be echoed';
  const e402 = await client.chat({ model: 'anonymo-1', messages: [{ role: 'user', content: secret }] }).catch((e) => e);
  assert.equal(e402.status, 402);
  assert.ok(!describeError(e402).includes(secret));
  const anon = createAnonymoClient({ baseUrl: BASE, fetch: createMockGateway().fetch });
  await assert.rejects(anon.balance(), (e) => e.status === 401);
  const floor = new AnonymoApiError(451, 'floor_blocked', 'blocked', 'cbrn');
  assert.match(describeError(floor), /not sent to any model/);
  assert.match(describeError(floor), /not charged/);
});

void test('withdrawals refuse a destination and an unknown source', async () => {
  const { mock, client, created } = await funded();
  await mock.simulateDeposit(created.key, 'tron', 'USDT', 3_000_000);
  const raw = await mock.fetch(`${BASE}/withdraw`, {
    method: 'POST',
    headers: { authorization: `Bearer ${created.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ chain: 'tron', source_address: 'x', amount_musd: 1, to: 'T-someone-else' }),
  });
  assert.equal(raw.status, 400);
  await assert.rejects(client.withdraw({ chain: 'tron', source_address: 'Tnot-a-source', amount_musd: 1 }), (e) => e.status === 404);
});

void test('aborting a stream stops it and charges only what was delivered', async () => {
  const { mock, client, created } = await funded({ delayMs: 5 });
  await mock.simulateDeposit(created.key, 'base', 'USDC', 5_000_000);
  const controller = new AbortController();
  let parts = 0;
  await assert.rejects(
    client.chat(
      { model: 'anonymo-1', messages: [{ role: 'user', content: 'long answer' }] },
      { signal: controller.signal, onDelta: () => ++parts === 3 && controller.abort() },
    ),
    (e) => e.name === 'AbortError',
  );
  await new Promise((r) => setTimeout(r, 30));
  const balance = await client.balance();
  assert.equal(balance.held_musd, 0);
  assert.ok(balance.available_musd > 5_000_000 - 5_000);
});

void test('the SSE reader handles split frames, CRLF and [DONE]', async () => {
  const enc = new TextEncoder();
  const frames = ['data: {"id":"a","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"he"},', '"finish_reason":null}]}\r\n\r\n', 'data: {"id":"a","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'];
  const body = new ReadableStream({ start(c) { for (const f of frames) c.enqueue(enc.encode(f)); c.close(); } });
  let text = '';
  for await (const chunk of readChatStream(body)) text += chunk.choices[0].delta.content ?? '';
  assert.equal(text, 'hello');
});

void test('money: formatting and parsing round-trip for every amount a person can type', () => {
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(1_234_560_000), '$1,234.56');
  assert.equal(formatUsd(850), '$0.00085');
  assert.equal(formatUsd(-5_000_000), '−$5.00');
  assert.equal(parseUsd('12.5'), 12_500_000);
  assert.equal(parseUsd('1e3'), null);
  assert.equal(parseUsd('-1'), null);
  fc.assert(fc.property(fc.integer({ min: 0, max: 999_999_999 }), fc.integer({ min: 0, max: 99 }), (d, c) => parseUsd(`${d}.${String(c).padStart(2, '0')}`) === d * 1_000_000 + c * 10_000));
});

void test('proof: sorted-pair hashing is commutative and a tampered sibling fails', () => {
  const a = '0x' + '11'.repeat(32), b = '0x' + '22'.repeat(32), c = '0x' + '33'.repeat(32);
  assert.equal(hashPair(a, b), hashPair(b, a));
  const root = hashPair(hashPair(a, b), c);
  assert.ok(verifyInclusion(a, [b, c], root));
  assert.ok(!verifyInclusion(a, [c, b], root));
  assert.equal(rootFromProof('0x12', []), null);
});

void test('presets: every frontend from the spec, each carrying the base URL and the key only when given', () => {
  assert.deepEqual(PRESETS.map((p) => p.name), ['JanitorAI', 'SillyTavern', 'Chub', 'Agnai', 'Open WebUI', 'LibreChat', 'TypingMind']);
  for (const p of PRESETS) {
    assert.ok(ANONYMO_MODEL_IDS.includes(p.defaultModel));
    const text = presetText(p, { base: 'https://api.example', key: KEY_PLACEHOLDER, model: p.defaultModel });
    assert.match(text, /https:\/\/api\.example\/v1/);
    assert.match(text, /anm_live_YOUR_KEY|ANONYMO_API_KEY/);
  }
});

void test('character cards: V2 JSON and V3 PNG import, build an rp prompt, and save sealed (no plaintext leaves)', async () => {
  const { readCardFile } = await import('../lib/anonymo/characters-store.ts');
  const { buildCharacterMessages, writeCardToPng, deriveViewingKey, sealCard, cardHash } = await import('../lib/anonymo/card.ts');
  const v2 = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Sample Character', description: 'A test card.', first_mes: 'Hello, traveller.', tags: ['demo'], character_book: { entries: [{ keys: ['lamp'], content: 'The lamp is old.' }] } } };
  const fromJson = await readCardFile(new File([JSON.stringify(v2)], 'card.json', { type: 'application/json' }));
  assert.equal(fromJson.data.name, 'Sample Character');
  const png = writeCardToPng(v2, null, 'v3');
  const fromPng = await readCardFile(new File([png], 'card.png', { type: 'image/png' }));
  assert.equal(fromPng.spec, 'chara_card_v3');
  assert.deepEqual(fromPng.data.character_book, fromJson.data.character_book);
  assert.notEqual(await cardHash(fromPng), await cardHash(fromJson), 'the spec version is part of the hash');
  await assert.rejects(readCardFile(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'x.png')), /PNG|chunk/);

  const built = buildCharacterMessages(fromJson, [{ role: 'user', content: 'What about the lamp?' }]);
  assert.equal(built.messages[0].role, 'system');
  assert.match(built.messages[0].content, /The lamp is old\./);
  assert.equal(built.messages[1].content, 'Hello, traveller.');

  const { mock, client, created } = await funded();
  await mock.simulateDeposit(created.key, 'base', 'USDC', 1_000_000);
  const sealed = await sealCard(await deriveViewingKey(created.key), fromJson);
  assert.ok(!sealed.sealed_card.includes('Sample Character'));
  const saved = await client.importCharacter({ visibility: 'private', sealed_card: sealed.sealed_card, card_hash: sealed.card_hash });
  assert.match(saved.data.id, /^ch_/);
});
