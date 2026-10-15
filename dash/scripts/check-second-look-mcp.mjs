import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import {
  mcpConfig,
  beginMcpConsent,
  approveMcpConsent,
  exchangeMcpCode,
  authenticateMcp,
  hashMcpSecret,
} from '../server/second-look/mcp-auth.ts';
import { mcpRoutes, runMcpTool } from '../server/second-look/mcp.ts';
import { linkWallet } from '../server/second-look/wallet-store.ts';
import { SECOND_LOOK_SWITCHES } from '../lib/second-look/releases.ts';
const connection = process.env.CONCLAVE_TEST_DATABASE_URL,
  url = new URL(connection ?? 'https://invalid.test');
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
  !url.pathname.endsWith('_test')
)
  throw Error('Disposable loopback test database required');
for (const k of Object.keys(process.env))
  if (k.startsWith('CONCLAVE_')) delete process.env[k];
process.env.CONCLAVE_DATA_KEYS = JSON.stringify({
  mcp: randomBytes(32).toString('base64'),
});
process.env.CONCLAVE_ACTIVE_DATA_KEY = 'mcp';
const origin = 'https://workspace.example.test',
  redirect = 'http://127.0.0.1:45678/callback',
  client = { id: 'test-client', name: 'Test client', redirects: [redirect] };
process.env.CONCLAVE_MCP_CLIENTS = JSON.stringify([client]);
const config = mcpConfig(origin),
  pool = createDatabase(connection, 6),
  code = (e) => (expected) => expected.code === e;
before(() => migrate(pool));
after(() => pool.end());
async function session() {
  const accountId = randomUUID();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
  return { accountId, tokenHash: hashMcpSecret(randomUUID()) };
}
function flow(scope = 'wallet:read') {
  const verifier = randomBytes(32).toString('base64url'),
    params = new URLSearchParams({
      client_id: client.id,
      redirect_uri: redirect,
      resource: config.resource,
      response_type: 'code',
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      state: randomBytes(24).toString('base64url'),
      scope,
    });
  return { verifier, params };
}
async function approved(s, scope = 'wallet:read') {
  const f = flow(scope),
    consent = await beginMcpConsent(pool, s, f.params, config),
    target = new URL(
      await approveMcpConsent(pool, s, consent.id, true, config),
    );
  return {
    consent,
    target,
    exchange: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.id,
      redirect_uri: redirect,
      resource: config.resource,
      code: target.searchParams.get('code'),
      code_verifier: f.verifier,
    }),
  };
}
const req = (token, body, headers = {}) =>
  new Request(config.resource, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      accept: 'application/json',
      'mcp-protocol-version': '2025-11-25',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
  });
test('consent binds registered redirect, session, audience and available scopes', async () => {
  const s = await session(),
    other = await session();
  for (const [key, value] of [
    ['redirect_uri', 'https://evil.example/'],
    ['resource', 'https://other.example/mcp'],
    ['code_challenge_method', 'plain'],
    ['scope', 'wallet:write'],
  ]) {
    const f = flow();
    f.params.set(key, value);
    await assert.rejects(beginMcpConsent(pool, s, f.params, config));
  }
  const f = flow(),
    consent = await beginMcpConsent(pool, s, f.params, config);
  await assert.rejects(
    approveMcpConsent(pool, other, consent.id, true, config),
  );
  await assert.rejects(
    approveMcpConsent(
      pool,
      { ...s, tokenHash: 'wrong' },
      consent.id,
      true,
      config,
    ),
  );
  const denied = new URL(
    await approveMcpConsent(pool, s, consent.id, false, config),
  );
  assert.equal(denied.searchParams.get('error'), 'access_denied');
  assert.equal(denied.searchParams.get('code'), null);
  await assert.rejects(approveMcpConsent(pool, s, consent.id, true, config));
});
test('PKCE exchange is atomic, single use, expires and never stores bearer secrets', async () => {
  const s = await session(),
    f = await approved(s);
  const bad = new URLSearchParams(f.exchange);
  bad.set('code_verifier', 'z'.repeat(43));
  await assert.rejects(
    exchangeMcpCode(pool, bad, config),
    code('INVALID_GRANT'),
  );
  const results = await Promise.allSettled([
    exchangeMcpCode(pool, f.exchange, config),
    exchangeMcpCode(pool, f.exchange, config),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const token = results.find((r) => r.status === 'fulfilled').value
    .access_token;
  const row = (
    await pool.query(
      'SELECT * FROM second_look_mcp_grants WHERE account_id=$1',
      [s.accountId],
    )
  ).rows[0];
  assert.equal(row.token_hash, hashMcpSecret(token));
  assert.equal(JSON.stringify(row).includes(token), false);
  await assert.rejects(
    authenticateMcp(
      pool,
      req(token, { method: 'ping' }, { origin: 'https://evil.example' }),
      config,
    ),
    code('ORIGIN_REJECTED'),
  );
  await pool.query(
    "UPDATE second_look_mcp_grants SET expires_at=now()-interval '1 second' WHERE id=$1",
    [row.id],
  );
  await assert.rejects(
    authenticateMcp(pool, req(token, { method: 'ping' }), config),
    code('INVALID_TOKEN'),
  );
  const expired = await approved(s);
  await pool.query(
    "UPDATE second_look_mcp_codes SET expires_at=now()-interval '1 second' WHERE id=$1",
    [expired.consent.id],
  );
  await assert.rejects(
    exchangeMcpCode(pool, expired.exchange, config),
    code('INVALID_GRANT'),
  );
});
test('MCP scopes filter tool discovery and prevent account crossing, escalation and revoked use', async () => {
  const s = await session(),
    other = await session(),
    f = await approved(s),
    grant = await exchangeMcpCode(pool, f.exchange, config),
    token = grant.access_token;
  const invoke = async (body) =>
    mcpRoutes(pool, req(token, body), 'second-look/mcp', origin);
  assert.equal(
    (await (await invoke({ method: 'initialize' })).json()).result
      .protocolVersion,
    '2025-11-25',
  );
  const tools = (await (await invoke({ method: 'tools/list' })).json()).result
    .tools;
  assert.deepEqual(
    tools.map((t) => t.name),
    ['conclave_pnl'],
  );
  assert.equal(
    (
      await invoke({
        method: 'tools/call',
        params: { name: 'conclave_token_check', arguments: {} },
      })
    ).status,
    403,
  );
  const foreign = await linkWallet(
    pool,
    other.accountId,
    'So11111111111111111111111111111111111111112',
    'Private wallet',
  );
  const denied = await (
    await invoke({
      method: 'tools/call',
      params: { name: 'conclave_pnl', arguments: { walletId: foreign.id } },
    })
  ).json();
  assert.equal(denied.result.isError, true);
  assert.equal(JSON.stringify(denied).includes('Private wallet'), false);
  const own = await linkWallet(
    pool,
    s.accountId,
    '11111111111111111111111111111111',
    'Own wallet',
  );
  const result = await (
    await invoke({
      method: 'tools/call',
      params: { name: 'conclave_pnl', arguments: { walletId: own.id } },
    })
  ).json();
  assert.equal(result.result.isError, false);
  assert.equal(JSON.parse(result.result.content[0].text).netUsd6, null);
  SECOND_LOOK_SWITCHES.wallet = false;
  try {
    assert.equal(
      (await (await invoke({ method: 'tools/list' })).json()).result.tools
        .length,
      0,
    );
    await assert.rejects(
      runMcpTool(
        pool,
        s.accountId,
        'conclave_pnl',
        { walletId: own.id },
        req(token, {}),
      ),
      code('FEATURE_UNAVAILABLE'),
    );
  } finally {
    SECOND_LOOK_SWITCHES.wallet = true;
  }
  await pool.query(
    'UPDATE second_look_mcp_grants SET revoked_at=now() WHERE token_hash=$1',
    [hashMcpSecret(token)],
  );
  assert.equal((await invoke({ method: 'ping' })).status, 401);
});
test('authorization tables enable RLS and deny public access', async () => {
  const { rows } = await pool.query(
    "SELECT relname,relrowsecurity,has_table_privilege('public',oid,'SELECT') AS readable FROM pg_class WHERE relname=ANY($1::text[])",
    [['second_look_mcp_codes', 'second_look_mcp_grants']],
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.relrowsecurity && !r.readable));
});
