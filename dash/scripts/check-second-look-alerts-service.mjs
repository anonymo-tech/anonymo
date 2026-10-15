import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { migrate } from './migrate.mjs';
import { createDatabase, transaction } from '../server/db/database.ts';
import { configuredKeyring, decryptText } from '../server/core/encryption.ts';
import {
  linkWallet,
  unlinkWallet,
} from '../server/second-look/wallet-store.ts';
import {
  changePlanning,
  getPlanning,
} from '../server/second-look/planning-store.ts';
import {
  insertSecondLookAlert,
  listSecondLookAlerts,
  markSecondLookAlertRead,
} from '../server/second-look/alerts-store.ts';
import { alertsRoutes } from '../server/second-look/alerts-routes.ts';
import {
  alertsResponse,
  alertReadResponse,
  exitWatchResponse,
} from '../lib/client/alerts-contracts.ts';
import {
  processNextExitWatch,
  listExitWatchStatus,
} from '../server/second-look/exit-watch.ts';
import { reserveExitPublicRead } from '../server/second-look/exit-budget.ts';
const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
if (!connection) throw Error('Isolated test database required.');
const endpoint = new URL(connection);
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
  !endpoint.pathname.endsWith('_test')
)
  throw Error('Only loopback *_test databases are allowed.');
for (const key of Object.keys(process.env))
  if (key.startsWith('CONCLAVE_')) delete process.env[key];
Object.assign(process.env, {
  CONCLAVE_ACTIVE_DATA_KEY: 'alerts-test',
  CONCLAVE_DATA_KEYS: JSON.stringify({
    'alerts-test': randomBytes(32).toString('base64'),
  }),
});
const pool = createDatabase(connection, 8),
  mint = 'So11111111111111111111111111111111111111112',
  keyring = configuredKeyring();
const config = {
  enabled: true,
  rpcUrl: 'https://fixture.example.test',
  jupiterApiKey: 'fixture-key-only',
  pollIntervalMs: 15000,
};
const owners = [];
async function account() {
  const id = randomUUID();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [id]);
  owners.push(id);
  return id;
}
const input = (key, kind = 'cool_head') => ({
  kind,
  dedupeKey: key,
  occurredAt: new Date().toISOString(),
  title: 'Position reminder',
  message: 'A fixture observation reached a chosen level.',
  evidence: { sample: 'private-fixture' },
});
before(async () => {
  await migrate(pool);
});
after(async () => {
  await pool.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [owners]);
  await pool.end();
});
async function saved() {
  const owner = await account(),
    wallet = await linkWallet(pool, owner, mint, 'Read-only test wallet');
  const value = await changePlanning(pool, owner, 0, {
    kind: 'create',
    plan: {
      walletId: wallet.id,
      mint,
      takeProfit: { priceUsd: '100', sizeBps: 5000 },
      stopLoss: null,
      trailingBps: null,
    },
  });
  return { owner, wallet, plan: value.exitPlans[0] };
}
const source = (price = '101') => ({
  read: async (m) => {
    const at = new Date().toISOString();
    return {
      primary: {
        source: 'fixture-pool',
        id: randomUUID(),
        mint: m,
        quoteCurrency: 'USD',
        price,
        observedAt: at,
      },
      crosscheck: {
        source: 'fixture-independent',
        id: randomUUID(),
        mint: m,
        quoteCurrency: 'USD',
        price,
        observedAt: at,
      },
      reason: null,
    };
  },
});

void test('dedupe and daily cap stay atomic under concurrent producers', async () => {
  const owner = await account();
  const duplicate = await Promise.all(
    Array.from({ length: 8 }, () =>
      transaction(pool, (client) =>
        insertSecondLookAlert(client, owner, input('same'), {
          keyring,
          dailyLimit: 3,
        }),
      ),
    ),
  );
  assert.equal(duplicate.filter((r) => r.inserted).length, 1);
  assert.equal(new Set(duplicate.map((r) => r.id)).size, 1);
  const capped = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      transaction(pool, (client) =>
        insertSecondLookAlert(client, owner, input(`next-${i}`), {
          keyring,
          dailyLimit: 3,
        }),
      ),
    ),
  );
  assert.equal(capped.filter((r) => r.inserted).length, 2);
  const list = await listSecondLookAlerts(pool, owner);
  assert.equal(alertsResponse(list), true);
  assert.equal(list.alerts.length, 3);
  assert.equal(list.unread, 3);
  const rows = await pool.query(
    'SELECT payload_ciphertext FROM second_look_alerts WHERE account_id=$1',
    [owner],
  );
  assert.equal(JSON.stringify(rows.rows).includes('private-fixture'), false);
});

void test('delivery caps follow local day across a DST boundary', async () => {
  const owner = await account(),
    options = { keyring, dailyLimit: 1, timezone: 'America/New_York' };
  const first = await transaction(pool, (c) =>
    insertSecondLookAlert(c, owner, input('day-a'), {
      ...options,
      now: new Date('2026-11-01T04:30:00.000Z'),
    }),
  );
  const repeatedHour = await transaction(pool, (c) =>
    insertSecondLookAlert(c, owner, input('day-b'), {
      ...options,
      now: new Date('2026-11-01T06:30:00.000Z'),
    }),
  );
  const nextDay = await transaction(pool, (c) =>
    insertSecondLookAlert(c, owner, input('day-c'), {
      ...options,
      now: new Date('2026-11-02T05:30:00.000Z'),
    }),
  );
  assert.equal(first.inserted, true);
  assert.equal(repeatedHour.reason, 'daily_limit');
  assert.equal(nextDay.inserted, true);
});

void test('account filters and authenticated ciphertext prevent cross-account reads and mutation', async () => {
  const owner = await account(),
    other = await account();
  const created = await transaction(pool, (c) =>
    insertSecondLookAlert(c, owner, input('secret'), { keyring }),
  );
  assert.equal((await listSecondLookAlerts(pool, other)).alerts.length, 0);
  await assert.rejects(
    markSecondLookAlertRead(pool, other, created.id),
    (e) => e.code === 'ALERT_NOT_FOUND',
  );
  const marked = await markSecondLookAlertRead(pool, owner, created.id),
    again = await markSecondLookAlertRead(pool, owner, created.id);
  assert.equal(alertReadResponse(marked), true);
  assert.equal(again.readAt, marked.readAt);
  assert.equal((await listSecondLookAlerts(pool, owner)).unread, 0);
  const row = (
    await pool.query(
      'SELECT payload_ciphertext FROM second_look_alerts WHERE id=$1',
      [created.id],
    )
  ).rows[0];
  await assert.rejects(
    decryptText(
      row.payload_ciphertext,
      `second-look-alert:${other}:${created.id}`,
      keyring,
    ),
  );
});

void test('notification insertion rolls back with the producing transaction', async () => {
  const owner = await account();
  await assert.rejects(
    transaction(pool, async (c) => {
      await insertSecondLookAlert(c, owner, input('rollback'), { keyring });
      throw Error('abort');
    }),
  );
  assert.equal((await listSecondLookAlerts(pool, owner)).alerts.length, 0);
});

void test('watcher persists evaluator and reminder in one commit and stops completed plans', async () => {
  const { owner, plan } = await saved();
  const outcomes = await Promise.all([
    processNextExitWatch(pool, config, { source: source(), keyring }),
    processNextExitWatch(pool, config, { source: source(), keyring }),
  ]);
  assert.equal(
    outcomes.reduce((sum, r) => sum + r.alerts, 0),
    1,
  );
  const list = await listSecondLookAlerts(pool, owner);
  assert.equal(list.alerts.length, 1);
  assert.equal(list.alerts[0].planId, plan.id);
  assert.equal(list.alerts[0].kind, 'exit_plan');
  const status = await listExitWatchStatus(pool, owner, config);
  assert.equal(exitWatchResponse(status), true);
  assert.equal(status.plans[0].status, 'completed');
  assert.equal(
    (await processNextExitWatch(pool, config, { source: source(), keyring }))
      .alerts,
    0,
  );
  const row = (
    await pool.query(
      'SELECT state_ciphertext FROM second_look_exit_watches WHERE plan_id=$1',
      [plan.id],
    )
  ).rows[0];
  assert.ok(!row.state_ciphertext.includes('emittedLegs'));
  const state = JSON.parse(
    await decryptText(
      row.state_ciphertext,
      `second-look-exit-watch:${owner}:${plan.id}`,
      keyring,
    ),
  );
  assert.deepEqual(state.emittedLegs, ['take_profit']);
});

void test('stale or missing source leaves a durable unavailable status and emits nothing', async () => {
  const { owner, plan } = await saved();
  const result = await processNextExitWatch(pool, config, {
    keyring,
    source: {
      read: async () => ({
        primary: null,
        crosscheck: null,
        reason: 'EXIT_PRICE_STALE',
      }),
    },
  });
  assert.equal(result.alerts, 0);
  assert.equal((await listSecondLookAlerts(pool, owner)).alerts.length, 0);
  const row = (await listExitWatchStatus(pool, owner, config)).plans.find(
    (p) => p.planId === plan.id,
  );
  assert.equal(row.status, 'unavailable');
  assert.equal(row.reason, 'EXIT_PRICE_STALE');
});

void test('lease loss discards an in-flight result rather than creating a reminder', async () => {
  const { owner, plan } = await saved();
  const result = await processNextExitWatch(pool, config, {
    keyring,
    source: {
      read: async (m) => {
        await pool.query(
          'UPDATE second_look_exit_watches SET lease_token=$2 WHERE plan_id=$1',
          [plan.id, randomUUID()],
        );
        return source().read(m);
      },
    },
  });
  assert.equal(result.reason, 'LEASE_LOST');
  assert.equal((await listSecondLookAlerts(pool, owner)).alerts.length, 0);
});

void test('plan deletion during a quote read cannot recreate the plan or notify afterward', async () => {
  const { owner, plan } = await saved();
  const result = await processNextExitWatch(pool, config, {
    keyring,
    source: {
      read: async (m) => {
        const state = await getPlanning(pool, owner);
        await changePlanning(pool, owner, state.revision, {
          kind: 'delete',
          id: plan.id,
        });
        return source().read(m);
      },
    },
  });
  assert.equal(result.alerts, 0);
  assert.equal((await listSecondLookAlerts(pool, owner)).alerts.length, 0);
  assert.equal(
    (
      await pool.query(
        'SELECT 1 FROM second_look_exit_watches WHERE plan_id=$1',
        [plan.id],
      )
    ).rowCount,
    0,
  );
});

void test('wallet and account deletion cascade through watches and private reminders', async () => {
  const { owner, wallet, plan } = await saved();
  await processNextExitWatch(pool, config, { keyring, source: source() });
  await unlinkWallet(pool, owner, wallet.id);
  assert.equal((await listSecondLookAlerts(pool, owner)).alerts.length, 0);
  assert.equal(
    (
      await pool.query(
        'SELECT 1 FROM second_look_exit_watches WHERE plan_id=$1',
        [plan.id],
      )
    ).rowCount,
    0,
  );
});

void test('new tables enable RLS and grant no privileges to PUBLIC', async () => {
  const rows = await pool.query(
    "SELECT relname,relrowsecurity FROM pg_class WHERE relname IN ('second_look_alerts','second_look_exit_watches','second_look_alert_daily_counts','second_look_provider_budget')",
  );
  assert.equal(rows.rowCount, 4);
  assert.ok(rows.rows.every((r) => r.relrowsecurity));
  const grants = await pool.query(
    "SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name IN ('second_look_alerts','second_look_exit_watches','second_look_alert_daily_counts','second_look_provider_budget') AND grantee='PUBLIC'",
  );
  assert.equal(grants.rowCount, 0);
});

void test('removing a wallet erases private alert evidence without resetting daily delivery cap', async () => {
  const owner = await account(),
    wallet = await linkWallet(pool, owner, mint, 'Cap test wallet');
  await transaction(pool, (c) =>
    insertSecondLookAlert(
      c,
      owner,
      { ...input('before-remove'), walletId: wallet.id },
      { keyring, dailyLimit: 1 },
    ),
  );
  await unlinkWallet(pool, owner, wallet.id);
  assert.equal((await listSecondLookAlerts(pool, owner)).alerts.length, 0);
  const again = await transaction(pool, (c) =>
    insertSecondLookAlert(c, owner, input('after-remove'), {
      keyring,
      dailyLimit: 1,
    }),
  );
  assert.equal(again.reason, 'daily_limit');
});

void test('inbox pagination does not skip tied timestamps and validators reject active-trading claims', async () => {
  const owner = await account(),
    now = new Date();
  await transaction(pool, async (c) => {
    for (let i = 0; i < 52; i++)
      await insertSecondLookAlert(c, owner, input(`page-${i}`, 'follow_sell'), {
        keyring,
        now,
      });
  });
  const page1 = await listSecondLookAlerts(pool, owner);
  assert.equal(page1.alerts.length, 50);
  assert.equal(alertsResponse(page1), true);
  const page2 = await listSecondLookAlerts(
    pool,
    owner,
    JSON.parse(Buffer.from(page1.nextCursor, 'base64url').toString()),
  );
  assert.equal(page2.alerts.length, 2);
  assert.equal(
    new Set([...page1.alerts, ...page2.alerts].map((a) => a.id)).size,
    52,
  );
  assert.equal(
    alertsResponse({ ...page1, alerts: [page1.alerts[0], page1.alerts[0]] }),
    false,
  );
  const watch = await listExitWatchStatus(pool, owner, config);
  assert.equal(
    exitWatchResponse({
      ...watch,
      capability: { ...watch.capability, executesTrades: true },
    }),
    false,
  );
});

void test('alert routes reject malformed cursors and mutable payloads', async () => {
  const owner = await account();
  await assert.rejects(
    alertsRoutes(
      pool,
      new Request('https://example.test/api/second-look/alerts?cursor=wrong'),
      'second-look/alerts',
      owner,
    ),
    (e) => e.code === 'INVALID_CURSOR',
  );
  const created = await transaction(pool, (c) =>
    insertSecondLookAlert(c, owner, input('route'), { keyring }),
  );
  const path = `second-look/alerts/${created.id}/read`;
  await assert.rejects(
    alertsRoutes(
      pool,
      new Request(`https://example.test/api/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'changed' }),
      }),
      path,
      owner,
    ),
    (e) => e.code === 'INVALID_REQUEST',
  );
});

await test('public provider budget allows only one reservation across concurrent callers', async () => {
  await pool.query(
    "DELETE FROM second_look_provider_budget WHERE provider='jupiter_public'",
  );
  const reservations = await Promise.all(
    Array.from({ length: 12 }, () => reserveExitPublicRead(pool)),
  );
  assert.equal(reservations.filter(Boolean).length, 1);
  assert.equal(await reserveExitPublicRead(pool), false);
  await pool.query(
    "UPDATE second_look_provider_budget SET next_read_at=now()-interval '1 second' WHERE provider='jupiter_public'",
  );
  assert.equal(await reserveExitPublicRead(pool), true);
});
