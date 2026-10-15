import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { migrate } from './migrate.mjs';
import { createDatabase } from '../server/db/database.ts';
import {
  generateSessionToken,
  hashToken,
  SESSION_COOKIE_NAME,
} from '../server/auth/index.ts';
import { dispatch } from '../server/routes/dispatch.ts';
import {
  walletsResponse,
  walletResponse,
  pnlResponse,
  reportsResponse,
  resolutionResponse,
  signatureResponse,
} from '../lib/client/second-look-contracts.ts';
const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
if (!connection)
  throw Error('An isolated CONCLAVE_TEST_DATABASE_URL is required.');
const url = new URL(connection);
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
  !url.pathname.endsWith('_test')
)
  throw Error('Only a loopback *_test database is permitted.');
for (const key of Object.keys(process.env))
  if (key.startsWith('CONCLAVE_')) delete process.env[key];
Object.assign(process.env, {
  CONCLAVE_DATABASE_URL: connection,
  CONCLAVE_MODE: 'service',
  CONCLAVE_APP_ORIGIN: 'https://conclave.example',
  CONCLAVE_SOLANA_CLUSTER: 'mainnet-beta',
});
process.env.CONCLAVE_ACTIVE_DATA_KEY = 'integration-fixture';
process.env.CONCLAVE_DATA_KEYS = JSON.stringify({
  'integration-fixture': randomBytes(32).toString('base64'),
});
const pool = createDatabase(connection, 3),
  origin = 'https://conclave.example';
let owner, other;
async function account() {
  const id = randomUUID(),
    session = generateSessionToken();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [id]);
  await pool.query(
    "INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [await hashToken(session), id],
  );
  return { id, session };
}
before(async () => {
  await migrate(pool);
  owner = await account();
  other = await account();
});
after(() => pool.end());
function request(
  path,
  { method = 'GET', body, who = owner, headers = {} } = {},
) {
  return dispatch(
    new Request(`${origin}/api/second-look/${path}`, {
      method,
      headers: {
        ...(who
          ? {
              cookie: `${SESSION_COOKIE_NAME}=${who.session}`,
              'X-Conclave-Account-Id': who.id,
            }
          : {}),
        ...(method !== 'GET'
          ? { 'content-type': 'application/json', origin }
          : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
test('capabilities are public and contain only safe metadata', async () => {
  const response = await request('capabilities', { who: null });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.token.configured, false);
  assert.equal(data.telegram.configured, false);
  assert.equal(data.signature.signsOrSubmits, false);
  assert.equal(JSON.stringify(data).includes(connection), false);
});
test('all account record routes reject missing session', async () => {
  for (const path of [
    'wallets',
    'reports',
    'signature/capabilities',
    'telegram/status',
  ]) {
    const r = await request(path, { who: null });
    assert.equal(r.status, 401, path);
  }
});
test('cross-origin state changes are blocked before dispatch', async () => {
  const r = await request('wallets', {
    method: 'POST',
    body: { address: '11111111111111111111111111111111' },
    headers: { origin: 'https://hostile.example' },
  });
  assert.equal(r.status, 403);
});
test('pinned account mismatch is rejected before mutation', async () => {
  const r = await request('wallets', {
    method: 'POST',
    body: { address: '11111111111111111111111111111111' },
    headers: { 'X-Conclave-Account-Id': other.id },
  });
  assert.equal(r.status, 401);
});
test('wallet create/list/P&L/delete contract and cross-account isolation', async () => {
  const created = await request('wallets', {
    method: 'POST',
    body: {
      address: '11111111111111111111111111111111',
      label: 'Fixture wallet',
    },
  });
  assert.equal(created.status, 201);
  const data = await created.json();
  assert.equal(walletResponse(data), true);
  const id = data.wallet.id;
  const listed = await request('wallets');
  assert.equal(walletsResponse(await listed.json()), true);
  const pnl = await request(`wallets/${id}/pnl`);
  assert.equal(pnl.status, 200);
  assert.equal(pnlResponse(await pnl.json()), true);
  for (const [path, method] of [
    [`wallets/${id}`, 'GET'],
    [`wallets/${id}/pnl`, 'GET'],
    [`wallets/${id}`, 'DELETE'],
  ]) {
    const r = await request(path, { method, who: other });
    assert.equal(r.status, 404);
  }
  const deleted = await request(`wallets/${id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { deleted: true });
});
test('exact mint resolves offline; disabled token execution has no charges', async () => {
  const mint = 'So11111111111111111111111111111111111111112';
  const resolved = await request('resolve', {
    method: 'POST',
    body: { input: mint },
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolutionResponse(await resolved.json()), true);
  const quotesBefore = (
    await pool.query('SELECT count(*) FROM secondlook_token_quotes')
  ).rows[0].count;
  const quote = await request('tokens/check', {
    method: 'POST',
    body: { mint, mode: 'standard', idempotencyKey: randomUUID() },
  });
  assert.equal(quote.status, 503);
  assert.equal(
    (await pool.query('SELECT count(*) FROM secondlook_token_quotes')).rows[0]
      .count,
    quotesBefore,
  );
});
test('recent reports route is registered and account scoped', async () => {
  const r = await request('reports');
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(reportsResponse(data), true);
  assert.deepEqual(data.reports, []);
});
test('message inspection reaches real firewall; malformed transaction does not call RPC', async () => {
  const r = await request('signature/inspect', {
    method: 'POST',
    body: {
      kind: 'message',
      message: 'Sign in to example.com',
      pageOrigin: null,
    },
  });
  assert.equal(r.status, 200);
  assert.equal(signatureResponse(await r.json()), true);
  const invalid = await request('signature/inspect', {
    method: 'POST',
    body: {
      kind: 'transaction',
      transaction: 'not-a-wire-transaction',
      encoding: 'base64',
    },
  });
  assert.equal(invalid.status, 400);
});
test('Telegram status works without enabling a bot and webhook never bypasses authentication', async () => {
  const r = await request('telegram/status');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).linked, false);
  const webhook = await dispatch(
    new Request(`${origin}/api/second-look/telegram/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  assert.equal(webhook.status, 503);
  const other = await dispatch(
    new Request(`${origin}/api/second-look/telegram/delivery`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  assert.equal(other.status, 403);
});
