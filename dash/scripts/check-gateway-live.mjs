// The dashboard's client against a RUNNING gateway (not the mock): every path and shape the UI reads, plus the CORS
// answers a browser on the dashboard's origin needs. Skipped unless ANONYMO_API is set.
//
//   cd gateway && bun run launch                        # mock models, local DB, a funded LAUNCH_KEY
//   ANONYMO_API=http://127.0.0.1:8787 ANONYMO_TEST_KEY=anm_live_… \
//     node --experimental-strip-types --test scripts/check-gateway-live.mjs
//
// ANONYMO_TEST_KEY (a key with credit, e.g. LAUNCH_KEY from gateway/.data/launch.env) enables the chat, receipt and
// proof checks. The four Anonymo model IDs must be seeded on the gateway (scripts/seed-upstreams.ts) for the chat
// checks; a model that is not served is reported, not failed, unless ANONYMO_REQUIRE_MODELS=1.
import assert from 'node:assert/strict';
import test from 'node:test';
import { API_PATHS, createAnonymoClient, newIdempotencyKey } from '../lib/anonymo/client.ts';
import { sealCard, deriveViewingKey } from '../lib/anonymo/card.ts';
import { usdToMusd } from '../lib/anonymo/money.ts';
import { verifyInclusion } from '../lib/anonymo/proof.ts';
import { ANONYMO_MODEL_IDS } from '../lib/anonymo/types.ts';

const API = (process.env.ANONYMO_API ?? '').replace(/\/+$/, '');
const TEST_KEY = process.env.ANONYMO_TEST_KEY ?? '';
const ORIGIN = 'http://localhost:3000';
const skip = !API && 'set ANONYMO_API to run against a live gateway';
const anon = () => createAnonymoClient({ baseUrl: API });

void test('CORS: a browser on the dashboard origin may call every path the dashboard uses', { skip }, async () => {
  const preflight = async (path, method, headers) => {
    const r = await fetch(API + path, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': method, 'access-control-request-headers': headers } });
    const allowed = (r.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    assert.ok(r.headers.get('access-control-allow-origin'), `${method} ${path}: no allow-origin on the preflight`);
    for (const h of headers.split(',').filter(Boolean)) assert.ok(allowed.includes(h), `${method} ${path}: header ${h} not allowed (${allowed})`);
  };
  await preflight(API_PATHS.keys, 'POST', 'content-type');
  for (const p of [API_PATHS.balance, API_PATHS.deposits, API_PATHS.withdrawals, API_PATHS.keyInfo]) await preflight(p, 'GET', 'authorization');
  await preflight(API_PATHS.withdraw, 'POST', 'authorization,content-type,idempotency-key');
  await preflight(API_PATHS.btcpayInvoice, 'POST', 'authorization,content-type');
  await preflight(API_PATHS.chat, 'POST', 'authorization,content-type,x-anonymo-refusal-catch,x-anonymo-sealed');
  await preflight(API_PATHS.characters, 'POST', 'authorization,content-type');
  for (const p of [API_PATHS.models, API_PATHS.manifest, API_PATHS.leaderboard, API_PATHS.receipt('x')]) {
    const r = await fetch(API + p, { headers: { origin: ORIGIN, accept: 'application/json' } });
    assert.ok(r.headers.get('access-control-allow-origin'), `GET ${p}: the dashboard could not read the answer (no CORS)`);
  }
  const chat = await fetch(API + API_PATHS.models, { headers: { origin: ORIGIN } });
  const exposed = (chat.headers.get('access-control-expose-headers') ?? '').toLowerCase();
  for (const h of ['x-anonymo-receipt', 'x-anonymo-council-mode']) assert.ok(exposed.includes(h), `${h} is not exposed to the browser`);
});

void test('a visitor creates a key and reads its deposit instructions, balance and history', { skip }, async () => {
  const created = await anon().createKey({ caps: { daily_usd: '5' } });
  assert.match(created.key, /^anm_live_/);
  assert.match(created.key_hash, /^[0-9a-f]{64}$/);
  assert.equal(created.caps.daily_usd, 5);
  assert.equal(typeof created.deposit.paused, 'boolean');
  const client = createAnonymoClient({ baseUrl: API, key: created.key });
  const me = await client.keyInfo();
  assert.equal(me.key_hash, created.key_hash);
  const deposits = await client.deposits();
  assert.deepEqual(deposits.data, []);
  if (!deposits.instructions.paused && deposits.instructions.evm) {
    const evm = deposits.instructions.evm;
    assert.match(evm.key_commit, /^0x[0-9a-f]{64}$/);
    for (const c of evm.chains) {
      assert.match(c.router, /^0x[0-9a-fA-F]{40}$/);
      for (const t of c.tokens) assert.ok(t.symbol && /^0x[0-9a-fA-F]{40}$/.test(t.address) && Number.isInteger(t.decimals));
    }
  }
  if (!deposits.instructions.paused && deposits.instructions.coin) {
    const coin = deposits.instructions.coin;
    assert.equal(coin.key_commit, deposits.instructions.evm?.key_commit ?? coin.key_commit);
    assert.ok(coin.price_usd === null || Number(coin.price_usd) > 0);
  }
  const balance = await client.balance();
  assert.equal(balance.available_usd, 0);
  assert.deepEqual(balance.withdraw_to, []);
  assert.deepEqual(await client.withdrawals(), []);
  // A fresh key has no source address, so a withdrawal is refused with the code the UI explains.
  await assert.rejects(client.withdraw({ chain: 'rhc', to: '0x' + 'ab'.repeat(20), amount_usd: 'all' }, newIdempotencyKey()), (e) => e.status === 403 && e.code === 'not_source_address');
  await assert.rejects(client.chat({ model: 'anonymo-1', messages: [{ role: 'user', content: 'hi' }] }), (e) => e.status === 402);
});

void test('public trust pages: models, manifest and leaderboard in the shapes the pages render', { skip }, async () => {
  const client = anon();
  const models = (await client.models()).data;
  for (const m of models) for (const k of ['family', 'quant', 'weights_hash', 'attested', 'refusal_rate_30d']) assert.ok(k in m, `${m.id} lacks ${k}`);
  const missing = ANONYMO_MODEL_IDS.filter((id) => !models.some((m) => m.id === id));
  if (missing.length && process.env.ANONYMO_REQUIRE_MODELS === '1') assert.fail(`not served: ${missing.join(', ')}`);
  const manifest = await client.manifest();
  assert.ok(Array.isArray(manifest.models) && manifest.counts.routes === manifest.models.reduce((s, m) => s + m.routes.length, 0));
  const board = await client.leaderboard();
  assert.equal(board.window_days, 30);
  assert.ok(Array.isArray(board.routes) && Array.isArray(board.families));
});

for (const model of ANONYMO_MODEL_IDS)
  void test(`chat with ${model}: reply, signed receipt, and its proof`, { skip: skip || (!TEST_KEY && 'set ANONYMO_TEST_KEY (a funded key)') }, async (t) => {
    const client = createAnonymoClient({ baseUrl: API, key: TEST_KEY });
    if (!(await client.models()).data.some((m) => m.id === model)) {
      if (process.env.ANONYMO_REQUIRE_MODELS === '1') assert.fail(`${model} is not served by this gateway`);
      return t.skip(`${model} is not served by this gateway`);
    }
    const before = usdToMusd((await client.balance()).available_usd);
    let streamed = '';
    const reply = await client.chat(
      { model, messages: [{ role: 'user', content: 'Say hello in five words.' }], max_tokens: 64 },
      { headers: { refusalCatch: 'on', ...(model === 'anonymo-council' ? { councilMode: 'select' } : {}) }, onDelta: (d) => (streamed += d) },
    );
    assert.ok(reply.content.length > 0, 'a reply');
    assert.equal(streamed, reply.content);
    assert.ok(reply.receiptId, 'a receipt id');
    assert.equal(reply.receipt?.request_id, reply.receiptId);
    assert.equal(reply.receipt.model_id, model);
    if (model === 'anonymo-council') {
      assert.equal(reply.council.mode, 'select');
      assert.ok(reply.council.proposers.length >= 2);
      assert.ok(reply.council.judge);
    }
    if (model === 'anonymo-sealed') {
      assert.equal(reply.receipt.sealed, true);
      assert.match(reply.receipt.attestation_quote_hash, /^0x[0-9a-f]{64}$/);
    }
    const view = await client.receipt(reply.receiptId);
    assert.equal(view.receipt.request_id, reply.receiptId);
    assert.equal(view.signature_valid, true);
    assert.equal(view.leaf, view.leaf.toLowerCase());
    const proof = await client.receiptProof(reply.receiptId);
    assert.equal(proof.leaf, view.leaf);
    if (proof.rooted) assert.ok(verifyInclusion(proof.leaf, proof.proof, proof.root), 'the path reaches the root');
    else assert.equal(proof.status, 'pending');
    const after = usdToMusd((await client.balance()).available_usd);
    assert.ok(after <= before, 'the call was paid from the key');
  });

void test('an older receipt whose hour is rooted verifies in the browser code', { skip: skip || (!process.env.ANONYMO_ROOTED_RECEIPT && 'set ANONYMO_ROOTED_RECEIPT to a receipt id from a closed hour') }, async () => {
  const client = anon();
  const proof = await client.receiptProof(process.env.ANONYMO_ROOTED_RECEIPT);
  assert.equal(proof.rooted, true);
  assert.ok(verifyInclusion(proof.leaf, proof.proof, proof.root));
  assert.equal((await client.receipt(process.env.ANONYMO_ROOTED_RECEIPT)).anchor?.root, proof.root);
});

void test('a private character card is stored sealed', { skip: skip || (!TEST_KEY && 'set ANONYMO_TEST_KEY') }, async () => {
  const client = createAnonymoClient({ baseUrl: API, key: TEST_KEY });
  const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Sample Character', description: 'A test card.', personality: '', scenario: '', first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {} } };
  const sealed = await sealCard(await deriveViewingKey(TEST_KEY), card);
  const saved = await client.importCharacter({ visibility: 'private', sealed_card: sealed.sealed_card, card_hash: sealed.card_hash });
  assert.match(saved.data.id, /^ch_/);
  assert.equal(saved.data.visibility, 'private');
});
