// The typed gateway client against the in-browser mock gateway: the whole visitor path (key → deposit → balance →
// chat → receipt → proof → withdrawal), the error codes the UI explains, and the pure helpers. The mock answers in the
// real gateway's shapes; scripts/check-gateway-live.mjs runs the same client against a running gateway.
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { API_PATHS, AnonymoApiError, createAnonymoClient, describeError, newIdempotencyKey, readChatStream, receiptIdFromHeader } from '../lib/anonymo/client.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';
import { formatUsd, musdToUsdString, parseUsd, usdToMusd } from '../lib/anonymo/money.ts';
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

void test('POST /keys returns an anm_live_ key once, its caps and the deposit instructions with one key_commit', async () => {
  const { created } = await funded();
  assert.ok(isApiKey(created.key));
  assert.match(created.key_hash, /^[0-9a-f]{64}$/);
  assert.equal(created.deposit.paused, false);
  assert.match(created.deposit.evm.key_commit, /^0x[0-9a-f]{64}$/);
  assert.equal(created.deposit.coin.key_commit, created.deposit.evm.key_commit, 'one commitment per key on every EVM rail');
  for (const c of created.deposit.evm.chains) assert.ok(CHAINS[c.chain] && c.tokens.length > 0);
  assert.ok(!maskKey(created.key).includes(created.key.slice(14, -4)));
});

void test('the visitor path: deposit → balance → streamed chat → receipt → verified proof → withdraw to source', async () => {
  const { mock, client, created } = await funded();
  await mock.simulateDeposit(created.key, 'rhc', 'USDG', 20_000_000);
  const before = await client.balance();
  assert.equal(usdToMusd(before.available_usd), 20_000_000);
  assert.equal(before.withdraw_to[0].chain, 'rhc');
  const deposits = await client.deposits();
  assert.equal(deposits.data[0].status, 'credited');
  assert.match(deposits.data[0].ref, /^rhc:0x[0-9a-f]{64}:0$/);

  let streamed = '';
  const reply = await client.chat(
    { model: 'anonymo-1', messages: [{ role: 'user', content: 'Explain the floor in one paragraph.' }] },
    { onDelta: (d) => (streamed += d) },
  );
  assert.ok(reply.content.length > 40);
  assert.equal(streamed, reply.content);
  assert.equal(reply.finishReason, 'stop');
  assert.ok(reply.receiptId);
  assert.equal(reply.receipt.request_id, reply.receiptId, 'the receipt rides on the last stream event');

  const view = await client.receipt(reply.receiptId);
  assert.equal(view.receipt.model_id, 'anonymo-1');
  assert.equal(view.receipt.refused, false);
  assert.equal(view.receipt.routes.length, 1);
  const proof = await client.receiptProof(reply.receiptId);
  assert.equal(proof.rooted, true);
  assert.equal(proof.leaf, view.leaf);
  assert.ok(proof.proof.length >= 2, 'a multi-level path');
  assert.ok(verifyInclusion(proof.leaf, proof.proof, proof.root));
  assert.ok(!verifyInclusion(proof.leaf, proof.proof.slice(1), proof.root));

  const after = await client.balance();
  assert.equal(after.held_usd, 0);
  assert.equal(usdToMusd(after.available_usd), 20_000_000 - usdToMusd(view.receipt.cost));

  const dest = after.withdraw_to[0];
  const wd = await client.withdraw({ chain: dest.chain, to: dest.address, amount_usd: 'all' }, newIdempotencyKey());
  assert.equal(wd.withdrawal.to, dest.address);
  assert.equal(wd.withdrawal.amount_usd, after.available_usd);
  const empty = await client.balance();
  assert.equal(empty.available_usd, 0);
  assert.equal(empty.withdraw_to[0].max_usd, 0, 'spent credit is not withdrawable');
  assert.equal((await client.withdrawals()).length, 1);
});

void test('withdrawals need an Idempotency-Key, replay the first result, and go only to a source address', async () => {
  const { mock, client, created } = await funded();
  await mock.simulateDeposit(created.key, 'tron', 'USDT', 3_000_000);
  const raw = await mock.fetch(`${BASE}${API_PATHS.withdraw}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${created.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ chain: 'tron', to: 'Tsomeone', amount_usd: '1' }),
  });
  assert.equal(raw.status, 400);
  assert.equal((await raw.json()).error.type, 'idempotency_key_required');
  await assert.rejects(
    client.withdraw({ chain: 'tron', to: 'Tnot-a-source', amount_usd: '1' }, newIdempotencyKey()),
    (e) => e.status === 403 && e.code === 'not_source_address',
  );
  const dest = (await client.balance()).withdraw_to[0];
  const idem = newIdempotencyKey();
  const first = await client.withdraw({ chain: dest.chain, to: dest.address, amount_usd: '1.5' }, idem);
  const again = await client.withdraw({ chain: dest.chain, to: dest.address, amount_usd: '1.5' }, idem);
  assert.equal(again.replay, true);
  assert.equal(again.withdrawal.id, first.withdrawal.id);
  assert.equal(usdToMusd((await client.balance()).available_usd), 1_500_000, 'a replay never withdraws twice');
});

void test('property: across deposits, coin payments, chats and withdrawals, no destination offers more than is withdrawable', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.oneof(
          fc.record({ op: fc.constant('deposit'), usd: fc.integer({ min: 1, max: 50 }), chain: fc.constantFrom('base', 'rhc', 'tron') }),
          fc.record({ op: fc.constant('coin'), usd: fc.integer({ min: 1, max: 50 }) }),
          fc.record({ op: fc.constant('chat') }),
          fc.record({ op: fc.constant('withdraw'), part: fc.integer({ min: 1, max: 100 }) }),
        ),
        { maxLength: 8 },
      ),
      async (ops) => {
        const { mock, client, created } = await funded();
        for (const o of ops) {
          if (o.op === 'deposit') await mock.simulateDeposit(created.key, o.chain, o.chain === 'tron' ? 'USDT' : 'USDC', o.usd * 1_000_000);
          if (o.op === 'coin') await mock.simulateCoinPayment(created.key, o.usd * 1_000_000);
          if (o.op === 'chat') await client.chat({ model: 'anonymo-1', messages: [{ role: 'user', content: 'hi' }] }).catch(() => null);
          if (o.op === 'withdraw') {
            const d = (await client.balance()).withdraw_to.find((x) => usdToMusd(x.max_usd) >= 1_000_000);
            if (d) {
              const amount = Math.max(1_000_000, Math.floor((usdToMusd(d.max_usd) * o.part) / 100));
              await client.withdraw({ chain: d.chain, to: d.address, amount_usd: musdToUsdString(amount) }, newIdempotencyKey());
            }
          }
          const b = await client.balance();
          assert.ok(b.available_usd >= 0 && b.held_usd === 0);
          const withdrawable = usdToMusd(b.available_usd) - usdToMusd(b.usage_only_usd);
          for (const d of b.withdraw_to) assert.ok(usdToMusd(d.max_usd) <= withdrawable, 'usage-only credit is never withdrawable');
        }
      },
    ),
    { numRuns: 40 },
  );
});

void test('ANMO payments credit usage-only balance; a payment over the cap is held', async () => {
  const { mock, client, created } = await funded();
  await mock.simulateCoinPayment(created.key, 5_000_000);
  const b = await client.balance();
  assert.equal(usdToMusd(b.usage_only_usd), 5_000_000);
  assert.deepEqual(b.withdraw_to, [], 'nothing to withdraw: coin credit is usage only');
  await mock.simulateCoinPayment(created.key, 300_000_000);
  const rows = (await client.deposits()).data;
  assert.equal(rows[0].chain, 'coin');
  assert.equal(rows[0].status, 'held');
  assert.equal(rows[0].reason, 'over_cap');
  assert.equal(usdToMusd((await client.balance()).balance_usd), 5_000_000);
});

void test('council answers as one JSON body with every seat; the receipt lists proposers and the aggregator or judge', async () => {
  const { mock, client, created } = await funded();
  await mock.simulateDeposit(created.key, 'arbitrum', 'USDT', 5_000_000);
  const reply = await client.chat({ model: 'anonymo-council', messages: [{ role: 'user', content: 'Compare two plans.' }] });
  assert.equal(reply.councilMode, 'merge');
  assert.equal(reply.council.proposers.length, 3);
  assert.equal(new Set(reply.council.proposers.map((p) => p.family)).size, 3, 'three different families');
  assert.ok(reply.council.aggregator);
  const view = await client.receipt(reply.receiptId);
  assert.equal(view.receipt.routes.length, 4);
  assert.deepEqual(view.receipt.routes.map((r) => r.role), ['proposer', 'proposer', 'proposer', 'aggregator']);
  const select = await client.chat({ model: 'anonymo-council', messages: [{ role: 'user', content: 'Pick one.' }] }, { headers: { councilMode: 'select' } });
  assert.equal(select.council.mode, 'select');
  assert.ok(select.council.judge);
  assert.equal(select.council.aggregator, undefined);
});

void test('sealed carries an attestation quote hash, and fails with 409 sealed_unavailable rather than downgrading', async () => {
  const { mock, client, created } = await funded();
  await mock.simulateDeposit(created.key, 'base', 'USDC', 5_000_000);
  const reply = await client.chat({ model: 'anonymo-sealed', messages: [{ role: 'user', content: 'hi' }] });
  assert.match(reply.receipt.attestation_quote_hash, /^0x[0-9a-f]{64}$/);
  assert.equal(reply.receipt.sealed, true);

  const down = await funded({ sealedAvailable: false });
  await down.mock.simulateDeposit(down.created.key, 'base', 'USDC', 5_000_000);
  await assert.rejects(
    down.client.chat({ model: 'anonymo-sealed', messages: [{ role: 'user', content: 'hi' }] }),
    (e) => e instanceof AnonymoApiError && e.status === 409 && e.code === 'sealed_unavailable',
  );
  assert.equal(usdToMusd((await down.client.balance()).available_usd), 5_000_000, 'nothing charged');
});

void test('errors: the gateway shape ({code: status, type}) maps to codes, and the UI text never echoes the prompt', async () => {
  const { client } = await funded();
  const secret = 'a prompt that must never be echoed';
  const e402 = await client.chat({ model: 'anonymo-1', messages: [{ role: 'user', content: secret }] }).catch((e) => e);
  assert.equal(e402.status, 402);
  assert.equal(e402.code, 'insufficient_balance');
  assert.ok(!describeError(e402).includes(secret));
  const anon = createAnonymoClient({ baseUrl: BASE, fetch: createMockGateway().fetch });
  await assert.rejects(anon.balance(), (e) => e.status === 401);
  const body = JSON.stringify({ error: { code: 451, message: 'blocked', type: 'floor_blocked', metadata: { category: 'cbrn' } } });
  const blocked = createAnonymoClient({ baseUrl: BASE, key: 'anm_live_' + 'a'.repeat(32), fetch: async () => new Response(body, { status: 451 }) });
  const floor = await blocked.balance().catch((e) => e);
  assert.equal(floor.code, 'floor_blocked');
  assert.equal(floor.category, 'cbrn');
  assert.match(describeError(floor), /not sent to any model/);
  assert.match(describeError(floor), /not charged/);
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
  assert.equal(balance.held_usd, 0);
  assert.ok(usdToMusd(balance.available_usd) > 5_000_000 - 5_000);
});

void test('the x-anonymo-receipt header decodes to its request id', () => {
  const payload = Buffer.from(JSON.stringify({ request_id: 'gen-1-abc', model_id: 'anonymo-1' })).toString('base64url');
  assert.equal(receiptIdFromHeader(`${payload}.c2ln.key1`), 'gen-1-abc');
  assert.equal(receiptIdFromHeader('not-a-header'), null);
  assert.equal(receiptIdFromHeader(null), null);
});

void test('money: gateway USD numbers and strings convert to micro-USD exactly', () => {
  assert.equal(usdToMusd(10), 10_000_000);
  assert.equal(usdToMusd(0.0000154), 15);
  assert.equal(usdToMusd('0.0000165'), 17);
  assert.equal(usdToMusd('12.5'), 12_500_000);
  assert.ok(Number.isNaN(usdToMusd('abc')));
  assert.equal(musdToUsdString(12_500_000), '12.5');
  assert.equal(musdToUsdString(1), '0.000001');
  fc.assert(fc.property(fc.integer({ min: 0, max: 10 ** 12 }), (m) => usdToMusd(musdToUsdString(m)) === m));
});

void test('the SSE reader handles split frames, CRLF and [DONE]', async () => {
  const enc = new TextEncoder();
  const frames = [': ANONYMO PROCESSING\n\ndata: {"id":"a","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"he"},', '"finish_reason":null}]}\r\n\r\n', 'data: {"id":"a","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'];
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
