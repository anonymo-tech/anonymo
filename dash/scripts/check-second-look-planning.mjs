import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { migrate } from './migrate.mjs';
import { createDatabase } from '../server/db/database.ts';
import pg from 'pg';
import {
  changePlanning,
  getPlanning,
} from '../server/second-look/planning-store.ts';
import {
  generateSessionToken,
  hashToken,
  SESSION_COOKIE_NAME,
} from '../server/auth/index.ts';
import { dispatch } from '../server/routes/dispatch.ts';
import {
  planningResponse,
  exitPlanInput,
} from '../lib/client/planning-contracts.ts';
const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
if (!connection)
  throw Error('An isolated loopback *_test database is required.');
const endpoint = new URL(connection);
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
  !endpoint.pathname.endsWith('_test')
)
  throw Error('Only an isolated loopback *_test database is allowed.');
for (const key of Object.keys(process.env))
  if (key.startsWith('CONCLAVE_')) delete process.env[key];
Object.assign(process.env, {
  CONCLAVE_DATABASE_URL: connection,
  CONCLAVE_MODE: 'service',
  CONCLAVE_APP_ORIGIN: 'https://conclave.example',
  CONCLAVE_SOLANA_CLUSTER: 'mainnet-beta',
  CONCLAVE_ACTIVE_DATA_KEY: 'planning-fixture',
  CONCLAVE_DATA_KEYS: JSON.stringify({
    'planning-fixture': randomBytes(32).toString('base64'),
  }),
});
const pool = createDatabase(connection, 4),
  origin = 'https://conclave.example';
let owner, other;
const mint = 'So11111111111111111111111111111111111111112';
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
after(async () => {
  try {
    const ids = [owner?.id, other?.id].filter(Boolean);
    await pool.query('DELETE FROM sessions WHERE account_id=ANY($1::uuid[])', [
      ids,
    ]);
    await pool.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [ids]);
  } finally {
    await pool.end();
  }
});
function request(
  path,
  { who = owner, method = 'GET', body, headers = {} } = {},
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
        ...(method === 'GET'
          ? {}
          : { origin, 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function state(who = owner) {
  const r = await request('planning', { who });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(planningResponse(data), true);
  return data;
}
const settings = {
  enabled: true,
  timezone: 'America/New_York',
  dailyBudgetUsd6: '123456789',
};
async function wallet(who = owner) {
  const r = await request('wallets', {
    who,
    method: 'POST',
    body: { address: mint, label: 'Planning fixture' },
  });
  assert.equal(r.status, 201);
  return (await r.json()).wallet;
}
const plan = (walletId) => ({
  walletId,
  mint,
  takeProfit: { priceUsd: '0.000000000000000002', sizeBps: 2500 },
  stopLoss: { priceUsd: '0.000000000000000001', sizeBps: 10000 },
  trailingBps: 500,
});
test('planning requires session, matching account and same-origin mutations', async () => {
  for (const [path, method, body] of [
    ['planning', 'GET'],
    ['planning/cool-head', 'PATCH', { revision: 0, ...settings }],
    ['planning/exit-plans', 'POST', { revision: 0, ...plan(randomUUID()) }],
    ['planning/exit-plans/' + randomUUID(), 'DELETE', { revision: 0 }],
  ]) {
    assert.equal(
      (await request(path, { who: null, method, body })).status,
      401,
    );
  }
  assert.equal(
    (
      await request('planning', {
        headers: { 'X-Conclave-Account-Id': other.id },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request('planning/cool-head', {
        method: 'PATCH',
        body: { revision: 0, ...settings },
        headers: { origin: 'https://hostile.example' },
      })
    ).status,
    403,
  );
});
test('read defaults are honest and do not create records', async () => {
  const s = await state();
  assert.equal(s.revision, 0);
  assert.equal(s.coolHead.enabled, true);
  assert.equal(s.coolHead.dailyBudgetUsd6, null);
  assert.deepEqual(s.exitPlans, []);
  assert.deepEqual(s.capabilities, {
    priceWatch: false,
    notificationDelivery: true,
    executesTrades: false,
    behaviorHistory: false,
  });
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) FROM second_look_planning WHERE account_id=$1',
        [owner.id],
      )
    ).rows[0].count,
    '0',
  );
});
test('budget persists encrypted and stale/concurrent mutations cannot overwrite it', async () => {
  const results = await Promise.all([
    request('planning/cool-head', {
      method: 'PATCH',
      body: { revision: 0, ...settings },
    }),
    request('planning/cool-head', {
      method: 'PATCH',
      body: { revision: 0, ...settings, dailyBudgetUsd6: '999999' },
    }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const s = await state();
  assert.equal(s.revision, 1);
  assert.equal((await state(other)).revision, 0);
  const row = (
    await pool.query(
      'SELECT settings_ciphertext FROM second_look_planning WHERE account_id=$1',
      [owner.id],
    )
  ).rows[0];
  assert.match(row.settings_ciphertext, /^v1\./);
  assert.equal(row.settings_ciphertext.includes(settings.timezone), false);
  const response = await request('planning/cool-head', {
    method: 'PATCH',
    body: {
      revision: s.revision,
      enabled: false,
      timezone: 'UTC',
      dailyBudgetUsd6: null,
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).coolHead, {
    enabled: false,
    timezone: 'UTC',
    dailyBudgetUsd6: null,
  });
});
test('invalid settings and unrecognized fields do not mutate saved state', async () => {
  const s = await state();
  for (const invalid of [
    { ...settings, dailyBudgetUsd6: '0' },
    { ...settings, dailyBudgetUsd6: '01' },
    { ...settings, dailyBudgetUsd6: '1.50' },
    { ...settings, dailyBudgetUsd6: 100 },
    { ...settings, timezone: 'Mars/Olympus' },
    { ...settings, enabled: 'true' },
    { ...settings, accountId: other.id },
  ]) {
    assert.equal(
      (
        await request('planning/cool-head', {
          method: 'PATCH',
          body: { revision: s.revision, ...invalid },
        })
      ).status,
      400,
    );
  }
  assert.equal((await state()).revision, s.revision);
});
test('linked-wallet ownership, exact price ordering and reminder-only creation', async () => {
  const theirs = await wallet(other),
    own = await wallet(),
    s = await state();
  assert.equal(
    (
      await request('planning/exit-plans', {
        method: 'POST',
        body: { revision: s.revision, ...plan(theirs.id) },
      })
    ).status,
    404,
  );
  for (const invalid of [
    {
      ...plan(own.id),
      takeProfit: { priceUsd: '0.000000000000000001', sizeBps: 2500 },
    },
    { ...plan(own.id), trailingBps: 10000 },
    { ...plan(own.id), stopLoss: null },
    { ...plan(own.id), mode: 'keeper' },
    { ...plan(own.id), takeProfit: { priceUsd: '1e9', sizeBps: 10000 } },
    { ...plan(own.id), stopLoss: { priceUsd: '0.01', sizeBps: 10001 } },
  ]) {
    assert.equal(
      (
        await request('planning/exit-plans', {
          method: 'POST',
          body: { revision: s.revision, ...invalid },
        })
      ).status,
      400,
    );
  }
  const r = await request('planning/exit-plans', {
    method: 'POST',
    body: { revision: s.revision, ...plan(own.id) },
  });
  assert.equal(r.status, 201);
  const data = await r.json();
  assert.equal(planningResponse(data), true);
  assert.equal(data.exitPlans[0].status, 'awaiting_feed');
  assert.equal(data.exitPlans[0].takeProfit.priceUsd, '0.000000000000000002');
  assert.equal((await state(other)).exitPlans.length, 0);
  const ciphertext = (
    await pool.query(
      'SELECT payload_ciphertext FROM second_look_exit_plans WHERE account_id=$1',
      [owner.id],
    )
  ).rows[0].payload_ciphertext;
  assert.equal(ciphertext.includes(mint), false);
  assert.equal(ciphertext.includes('0.000000000000000002'), false);
});
test('retries, duplicates and foreign deletes preserve both plans and revision', async () => {
  const s = await state(),
    p = s.exitPlans[0];
  assert.equal(
    (
      await request('planning/exit-plans', {
        method: 'POST',
        body: { revision: s.revision - 1, ...plan(p.walletId) },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request('planning/exit-plans', {
        method: 'POST',
        body: { revision: s.revision, ...plan(p.walletId) },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request('planning/exit-plans', {
        method: 'POST',
        body: { revision: s.revision, ...plan(p.walletId.toUpperCase()) },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`planning/exit-plans/${p.id}`, {
        who: other,
        method: 'DELETE',
        body: { revision: 0 },
      })
    ).status,
    404,
  );
  assert.equal((await state()).revision, s.revision);
  assert.equal((await state(other)).revision, 0);
  assert.equal(
    (
      await request(`planning/exit-plans/${p.id}`, {
        method: 'DELETE',
        body: { revision: s.revision },
      })
    ).status,
    200,
  );
  assert.equal((await state()).exitPlans.length, 0);
});
test('unlink cascades reminder drafts and RLS denies an unprivileged database reader', async () => {
  const own = await wallet(),
    s = await state();
  assert.equal(
    (
      await request('planning/exit-plans', {
        method: 'POST',
        body: { revision: s.revision, ...plan(own.id) },
      })
    ).status,
    201,
  );
  assert.equal(
    (await request(`wallets/${own.id}`, { method: 'DELETE' })).status,
    200,
  );
  assert.equal((await state()).exitPlans.length, 0);
  const rows = (
    await pool.query(
      "SELECT relname,relrowsecurity FROM pg_class WHERE relname IN ('second_look_planning','second_look_exit_plans')",
    )
  ).rows;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.relrowsecurity));
  const role = 'planning_probe_' + randomUUID().replaceAll('-', '');
  const client = await pool.connect();
  try {
    await client.query(`CREATE ROLE ${role} NOLOGIN`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`SET ROLE ${role}`);
    await assert.rejects(
      client.query('SELECT * FROM second_look_planning'),
      (e) => e.code === '42501',
    );
    await client.query('RESET ROLE');
    await client.query(
      `GRANT SELECT ON second_look_planning,second_look_exit_plans TO ${role}`,
    );
    await client.query(`SET ROLE ${role}`);
    assert.equal(
      (await client.query('SELECT * FROM second_look_planning')).rowCount,
      0,
    );
    assert.equal(
      (await client.query('SELECT * FROM second_look_exit_plans')).rowCount,
      0,
    );
  } finally {
    await client.query('RESET ROLE');
    await client.query(`DROP OWNED BY ${role}`);
    await client.query(`DROP ROLE ${role}`);
    client.release();
  }
});
test('restricted API grants can save settings and plans without wallet-update permission', async () => {
  const own = await wallet();
  const role = 'planning_api_' + randomUUID().replaceAll('-', '');
  const tables = [
    'accounts',
    'second_look_wallets',
    'second_look_wallet_transactions',
    'second_look_planning',
    'second_look_exit_plans',
  ];
  let restricted;
  try {
    await pool.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await pool.query(`GRANT SELECT ON ${tables.join(',')} TO ${role}`);
    await pool.query(`GRANT UPDATE(id) ON accounts TO ${role}`);
    await pool.query(
      `GRANT INSERT ON second_look_planning,second_look_exit_plans TO ${role}`,
    );
    await pool.query(
      `GRANT UPDATE(revision,settings_ciphertext,updated_at) ON second_look_planning TO ${role}`,
    );
    await pool.query(`GRANT DELETE ON second_look_exit_plans TO ${role}`);
    for (const table of tables)
      await pool.query(
        `CREATE POLICY ${role} ON ${table} TO ${role} USING(true) WITH CHECK(true)`,
      );
    restricted = new pg.Pool({
      connectionString: connection,
      options: `-c role=${role}`,
      max: 2,
    });
    const initial = await getPlanning(restricted, owner.id);
    const saved = await changePlanning(restricted, owner.id, initial.revision, {
      kind: 'settings',
      settings,
    });
    const added = await changePlanning(restricted, owner.id, saved.revision, {
      kind: 'create',
      plan: plan(own.id),
    });
    assert.equal(added.exitPlans.length, 1);
    await assert.rejects(
      restricted.query('UPDATE second_look_wallets SET id=id WHERE id=$1', [
        own.id,
      ]),
      (e) => e.code === '42501',
    );
    const cleared = await changePlanning(restricted, owner.id, added.revision, {
      kind: 'delete',
      id: added.exitPlans[0].id,
    });
    assert.equal(cleared.exitPlans.length, 0);
  } finally {
    await restricted?.end();
    for (const table of tables)
      await pool.query(`DROP POLICY IF EXISTS ${role} ON ${table}`);
    await pool.query(`DROP OWNED BY ${role}`);
    await pool.query(`DROP ROLE ${role}`);
  }
});
test('client validation rejects execution, duplicate IDs and malformed prices', () => {
  const p = {
    ...plan(randomUUID()),
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mode: 'reminder',
    status: 'awaiting_feed',
  };
  const s = {
    revision: 1,
    coolHead: settings,
    exitPlans: [p],
    capabilities: {
      priceWatch: false,
      notificationDelivery: false,
      executesTrades: false,
      behaviorHistory: false,
    },
  };
  assert.equal(planningResponse(s), true);
  assert.equal(planningResponse({ ...s, exitPlans: [p, p] }), false);
  assert.equal(
    planningResponse({
      ...s,
      capabilities: { ...s.capabilities, executesTrades: true },
    }),
    false,
  );
  assert.equal(
    exitPlanInput({ ...p, takeProfit: { priceUsd: 'NaN', sizeBps: 5000 } }),
    false,
  );
});
