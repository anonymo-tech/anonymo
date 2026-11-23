// Update 05 "Pair my coding tool": the keyless setups, the receipt check that decides "Confirmed", the paste reader,
// the test-model choice and the client's owner-only generation lookup. Mocked: no coding tool or gateway runs here.
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { AnonymoApiError, API_PATHS, createAnonymoClient } from '../lib/anonymo/client.ts';
import { CLOCK_MARGIN_MS, checkReceipt, diagnosePaste, isReceiptId, loadAttempt, receiptIdIn, saveAttempt, testModels, testPrompt } from '../lib/anonymo/connect.ts';
import { KEY_PLACEHOLDER, MCP_CLIENTS, MCP_KEY_ENV, mcpEndpoint, mcpSetupText } from '../lib/anonymo/presets.ts';

const BASE = 'https://api.anonymo.example';
const KEY_SHAPE = /anm_(live|test)_[A-Za-z0-9_-]{16,}/g;

test('05 setups never hold a key: only the placeholder and an environment reference', () => {
  assert.deepEqual(MCP_CLIENTS.map((c) => c.id), ['cursor', 'claude-code']);
  for (const client of MCP_CLIENTS) {
    const texts = [...client.steps(BASE).map((s) => s.text), mcpSetupText(client, BASE)];
    for (const text of texts) {
      for (const hit of text.match(KEY_SHAPE) ?? []) assert.equal(hit, KEY_PLACEHOLDER, `${client.id}: only the placeholder may look like a key`);
      assert.ok(!text.includes('?'), `${client.id}: no query string in the endpoint`);
    }
    const whole = mcpSetupText(client, BASE);
    assert.ok(whole.includes(`${BASE}/mcp`));
    assert.ok(whole.includes(`export ${MCP_KEY_ENV}=${KEY_PLACEHOLDER}`));
  }
  assert.equal(mcpEndpoint(`${BASE}/`), `${BASE}/mcp`);
});

test('05 Cursor reads the key through ${env:…} in mcp.json; Claude Code keeps ${…} unexpanded with single quotes', () => {
  const cursor = MCP_CLIENTS.find((c) => c.id === 'cursor');
  const json = JSON.parse(cursor.steps(BASE).find((s) => s.language === 'json').text);
  assert.deepEqual(json, { mcpServers: { anonymo: { url: `${BASE}/mcp`, headers: { Authorization: 'Bearer ${env:ANONYMO_API_KEY}' } } } });
  const claude = MCP_CLIENTS.find((c) => c.id === 'claude-code');
  const add = claude.steps(BASE).find((s) => s.text.startsWith('claude mcp add')).text;
  assert.equal(add, `claude mcp add --transport http --scope project anonymo ${BASE}/mcp --header 'Authorization: Bearer \${ANONYMO_API_KEY}'`);
  // A double-quoted header would let the shell write the key into .mcp.json.
  assert.ok(!/"Authorization: Bearer \$/.test(add));
});

const attempt = { client: 'cursor', model: 'anonymo-1', startedAt: Date.parse('2026-11-22T12:00:00Z') };
// The lookup a minute later, a 200 ms round trip; the gateway's clock agrees with this browser's unless a test says not.
const timing = { sentAt: attempt.startedAt + 60_000, receivedAt: attempt.startedAt + 60_200 };
const iso = (ms) => new Date(ms).toISOString();
const gen = (over = {}) => ({ id: 'gen-1795000000-abcdefghijklmn', model: 'anonymo-1', created_at: '2026-11-22T12:00:30Z', origin: 'mcp', total_cost: 0.0001, checked_at: iso(timing.sentAt + 100), ...over });

test('05 Confirmed only with MCP origin, a call made after the test started and the test model', () => {
  assert.equal(checkReceipt(attempt, gen(), timing).status, 'confirmed');
  assert.deepEqual(checkReceipt(attempt, gen({ origin: null }), timing), { status: 'unconfirmed', reasons: ['origin'], generation: gen({ origin: null }) });
  const older = gen();
  delete older.origin; // a gateway without update 05 says nothing about origin
  assert.deepEqual(checkReceipt(attempt, older, timing).reasons, ['origin']);
  assert.deepEqual(checkReceipt(attempt, gen({ created_at: '2026-11-22T11:59:50Z' }), timing).reasons, ['time']);
  assert.deepEqual(checkReceipt(attempt, gen({ created_at: 'not a date' }), timing).reasons, ['time']);
  assert.deepEqual(checkReceipt(attempt, gen({ model: 'qwen/qwen3-32b' }), timing).reasons, ['model']);
  assert.deepEqual(checkReceipt(attempt, gen({ origin: null, model: 'x', created_at: '2020-01-01T00:00:00Z' }), timing).reasons, ['origin', 'time', 'model']);
  // The margin: CLOCK_MARGIN_MS plus half the round trip before the start is accepted, a millisecond more is not.
  assert.equal(checkReceipt(attempt, gen({ created_at: iso(attempt.startedAt - CLOCK_MARGIN_MS - 100) }), timing).status, 'confirmed');
  assert.equal(checkReceipt(attempt, gen({ created_at: iso(attempt.startedAt - CLOCK_MARGIN_MS - 101) }), timing).status, 'unconfirmed');
});

test('05 a phone clock that is minutes off neither confirms an old call nor rejects a new one', () => {
  const fast = 5 * 60_000; // this browser runs five minutes ahead of the gateway
  const server = (browserMs) => browserMs - fast;
  const checked = iso(server(timing.sentAt + 100));
  // Made ten seconds before the test started (gateway time): unconfirmed, although it is "after" by the fast clock's start minus 5 min.
  assert.equal(checkReceipt(attempt, gen({ checked_at: checked, created_at: iso(server(attempt.startedAt) - 10_000) }), timing).status, 'unconfirmed');
  // Made ten seconds after: confirmed, although the browser clock says it is from before the start.
  assert.equal(checkReceipt(attempt, gen({ checked_at: checked, created_at: iso(server(attempt.startedAt) + 10_000) }), timing).status, 'confirmed');
  // A slow browser clock, the other way round.
  const slow = (browserMs) => browserMs + fast;
  const checkedSlow = iso(slow(timing.sentAt + 100));
  assert.equal(checkReceipt(attempt, gen({ checked_at: checkedSlow, created_at: iso(slow(attempt.startedAt) - 10_000) }), timing).status, 'unconfirmed');
  assert.equal(checkReceipt(attempt, gen({ checked_at: checkedSlow, created_at: iso(slow(attempt.startedAt) + 10_000) }), timing).status, 'confirmed');
  // No checked_at (an older gateway): clocks taken as equal and only the margin applies.
  const bare = gen();
  delete bare.checked_at;
  assert.equal(checkReceipt(attempt, { ...bare, created_at: iso(attempt.startedAt - CLOCK_MARGIN_MS) }, timing).status, 'confirmed');
  assert.equal(checkReceipt(attempt, { ...bare, created_at: iso(attempt.startedAt - CLOCK_MARGIN_MS - 1) }, timing).status, 'unconfirmed');
});

test('05 property: confirmed exactly when origin, time (on the gateway clock) and model all bind, whatever the clock skew', () => {
  fc.assert(
    fc.property(
      fc.constantFrom('mcp', null, undefined),
      fc.integer({ min: -3_600_000, max: 3_600_000 }), // gateway clock minus browser clock
      fc.integer({ min: -60_000, max: 60_000 }), // when the call was made, relative to the start (gateway clock)
      fc.integer({ min: 0, max: 4_000 }), // round trip
      fc.constantFrom('anonymo-1', 'anonymo-2', 'qwen/qwen3-32b'),
      (origin, skew, offset, trip, model) => {
        const t = { sentAt: attempt.startedAt + 30_000, receivedAt: attempt.startedAt + 30_000 + trip };
        const g = gen({ origin, model, created_at: iso(attempt.startedAt + skew + offset), checked_at: iso(t.sentAt + trip / 2 + skew) });
        const ok = origin === 'mcp' && offset >= -CLOCK_MARGIN_MS - trip / 2 && model === attempt.model;
        assert.equal(checkReceipt(attempt, g, t).status === 'confirmed', ok);
      },
    ),
  );
});

test('05 the receipt id is read from the id alone or from the tool’s whole reply', () => {
  const id = 'gen-1795000000-Ab_cd-EfGhIjKlMn';
  assert.ok(isReceiptId(id));
  assert.equal(receiptIdIn(id), id);
  assert.equal(receiptIdIn(`ready\n{"receipt_id":"${id}","cost_usd":0.0001}`), id);
  assert.equal(receiptIdIn('  receipt_id: ' + id + '.'), id);
  assert.equal(receiptIdIn('ready'), null);
  assert.equal(receiptIdIn('gen-abc'), null);
  assert.ok(!isReceiptId(`${id}?x`));
});

test('05 a pasted error points at its recovery', () => {
  assert.equal(diagnosePaste('{"error":{"code":401,"type":"missing_key","message":"The chat tool needs an Anonymo API key."}}'), 'missing_credential');
  assert.equal(diagnosePaste('Error: 401 Unauthorized'), 'missing_credential');
  assert.equal(diagnosePaste('{"error":{"code":402,"type":"insufficient_credits"}}'), 'insufficient_funds');
  assert.equal(diagnosePaste('That model is not live yet: model_not_found'), 'unavailable_model');
  assert.equal(diagnosePaste('MCP error -32600: Cross-origin requests to /mcp are not allowed.'), 'unsupported_config');
  assert.equal(diagnosePaste('Failed to connect: ECONNREFUSED 127.0.0.1:8787'), 'unsupported_config');
  assert.equal(diagnosePaste('ready'), null);
});

test('05 the test model is a live text model, anonymo-1 first; council, sealed, swarm and media are left out', () => {
  const text = { input_modalities: ['text'], output_modalities: ['text'] };
  const rows = [
    { id: 'qwen/qwen3-32b', architecture: text },
    { id: 'anonymo-council' },
    { id: 'anonymo-sealed' },
    { id: 'anonymo-swarm' },
    { id: 'img/model', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
    { id: 'mixed/model', architecture: { input_modalities: ['text'], output_modalities: ['image', 'text'] } },
    { id: 'down/model', availability: 'temporarily_unavailable' },
    { id: 'acme/embed-small', architecture: { input_modalities: ['text'], output_modalities: ['embeddings'] } },
    { id: 'anonymo-1' },
  ];
  assert.deepEqual(testModels(rows), ['anonymo-1', 'qwen/qwen3-32b']);
  assert.deepEqual(testModels(rows.filter((m) => m.id !== 'anonymo-1')), ['qwen/qwen3-32b']);
  assert.deepEqual(testModels([{ id: 'anonymo-council' }]), []);
  assert.deepEqual(testModels(null), []);
  assert.match(testPrompt('anonymo-1'), /anonymo chat tool with model "anonymo-1".*receipt_id/);
});

test('05 the test is kept for this tab without the key, and junk is ignored', () => {
  const store = new Map();
  const s = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  saveAttempt(s, attempt);
  assert.deepEqual(loadAttempt(s), attempt);
  assert.ok(![...store.values()].some((v) => /anm_/.test(v)));
  saveAttempt(s, null);
  assert.equal(loadAttempt(s), null);
  store.set('anonymo.connect.attempt.v1', '{"client":"vim","model":"x","startedAt":1}');
  assert.equal(loadAttempt(s), null);
  store.set('anonymo.connect.attempt.v1', 'not json');
  assert.equal(loadAttempt(s), null);
  assert.equal(loadAttempt(null), null);
  assert.doesNotThrow(() => saveAttempt({ setItem() { throw new Error('blocked'); }, removeItem() {} }, attempt));
});

test('05 client.generation asks the owner-only lookup with the key in the header, never in the URL', async () => {
  const key = 'anm_test_local_fixture_abcdefgh';
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, auth: new Headers(init.headers).get('authorization'), cache: init.cache });
    if (String(url).includes('missing')) return new Response(JSON.stringify({ error: { message: 'Generation not found.', type: 'not_found', code: 404 } }), { status: 404, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ data: gen() }), { headers: { 'content-type': 'application/json' } });
  };
  const client = createAnonymoClient({ baseUrl: BASE, key, fetch });
  assert.deepEqual(await client.generation('gen-1795000000-abcdefghijklmn'), gen());
  assert.equal(seen[0].url, `${BASE}/api/v1/generation?id=gen-1795000000-abcdefghijklmn`);
  assert.equal(seen[0].auth, `Bearer ${key}`);
  assert.equal(seen[0].cache, 'no-store');
  assert.ok(!seen[0].url.includes(key));
  assert.equal(API_PATHS.generation('a b&c'), '/api/v1/generation?id=a%20b%26c');
  await assert.rejects(client.generation('gen-missing'), (e) => e instanceof AnonymoApiError && e.status === 404);
  await assert.rejects(createAnonymoClient({ baseUrl: BASE, fetch }).generation('gen-1'), (e) => e instanceof AnonymoApiError && e.status === 401);
});
