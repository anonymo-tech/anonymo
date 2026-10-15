import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, transaction } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import {
  generateSessionToken,
  hashToken,
  SESSION_COOKIE_NAME,
} from '../server/auth/index.ts';
import { dispatch } from '../server/routes/dispatch.ts';
import { linkWallet } from '../server/second-look/wallet-store.ts';
import { addFollowTrader } from '../server/second-look/follow-store.ts';
import { insertSecondLookAlert } from '../server/second-look/alerts-store.ts';
import { creditVerifiedDeposit } from '../server/ledger/ledger.ts';
import {
  alertsResponse,
  alertReadResponse,
  exitWatchResponse,
} from '../lib/client/alerts-contracts.ts';
import {
  followList,
  followCheck,
  followTraderResponse,
} from '../lib/client/follow-contracts.ts';
import { whyMovedReport } from '../lib/client/why-contracts.ts';
import { coolHeadResponse } from '../lib/client/cool-head-contracts.ts';
import {
  steadyResponse,
  steadyPurchaseResponse,
} from '../lib/client/steady-contracts.ts';
import {
  taxPreviewResponse,
  taxUnlockResponse,
  taxExportResponse,
} from '../lib/client/tax-contracts.ts';
import { planningResponse } from '../lib/client/planning-contracts.ts';

const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
if (!connection)
  throw new Error('An isolated loopback *_test database is required.');
const endpoint = new URL(connection);
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
  !endpoint.pathname.endsWith('_test')
)
  throw new Error('Use a loopback *_test database only.');
for (const name of Object.keys(process.env))
  if (name.startsWith('CONCLAVE_')) delete process.env[name];
const origin = 'https://conclave.example';
Object.assign(process.env, {
  CONCLAVE_DATABASE_URL: connection,
  CONCLAVE_MODE: 'service',
  CONCLAVE_APP_ORIGIN: origin,
  CONCLAVE_SOLANA_CLUSTER: 'mainnet-beta',
  CONCLAVE_ACTIVE_DATA_KEY: 'phase2-route-fixture',
  CONCLAVE_DATA_KEYS: JSON.stringify({
    'phase2-route-fixture': Buffer.alloc(32, 37).toString('base64'),
  }),
});
const pool = createDatabase(connection, 4),
  mint = 'So11111111111111111111111111111111111111112';
let owner,
  other,
  ownedWallet,
  foreignWallet,
  trader,
  foreignTrader,
  alertId,
  foreignAlertId;
const accounts = [];
async function account() {
  const id = randomUUID(),
    session = generateSessionToken();
  accounts.push(id);
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [id]);
  await pool.query(
    "INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [await hashToken(session), id],
  );
  return { id, session };
}
async function insertAlert(who) {
  return transaction(
    pool,
    async (client) =>
      (
        await insertSecondLookAlert(client, who.id, {
          kind: 'follow_sell',
          dedupeKey: randomUUID(),
          occurredAt: new Date().toISOString(),
          title: 'Observed sell',
          message: 'A finalized sell was observed.',
          evidence: { scope: 'fixture' },
        })
      ).id,
  );
}
before(async () => {
  await migrate(pool);
  owner = await account();
  other = await account();
  ownedWallet = await linkWallet(pool, owner.id, mint, 'My wallet');
  foreignWallet = await linkWallet(pool, other.id, mint, 'Foreign wallet');
  trader = await addFollowTrader(pool, owner.id, mint, 'Followed trader');
  foreignTrader = await addFollowTrader(pool, other.id, mint, 'Foreign trader');
  alertId = await insertAlert(owner);
  foreignAlertId = await insertAlert(other);
  await creditVerifiedDeposit(pool, {
    accountId: owner.id,
    reference: `phase2-route-fixture-${randomUUID()}`,
    amountUsd6: '40000000',
  });
});
after(async () => {
  await pool.end();
});
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
const reads = [
  'alerts',
  'follow/traders',
  'cool-head',
  'planning/watch',
  'steady',
];
function writes() {
  return [
    ['why-moved', { mint, window: '6h' }],
    [
      `tax/${ownedWallet.id}/preview`,
      { year: 2025, jurisdiction: 'US', method: 'fifo', selections: [] },
    ],
    [
      'steady/purchase',
      { idempotencyKey: randomUUID(), expectedPriceUsd6: '12000000' },
    ],
  ];
}
test('all Phase 2 read and write routes require a session before accessing data', async () => {
  for (const path of reads)
    assert.equal((await request(path, { who: null })).status, 401, path);
  for (const [path, body] of writes())
    assert.equal(
      (await request(path, { who: null, method: 'POST', body })).status,
      401,
      path,
    );
});
test('pinned account headers fence every Phase 2 route before any read or charge', async () => {
  for (const path of reads)
    assert.equal(
      (await request(path, { headers: { 'X-Conclave-Account-Id': other.id } }))
        .status,
      401,
      path,
    );
  for (const [path, body] of writes())
    assert.equal(
      (
        await request(path, {
          method: 'POST',
          body,
          headers: { 'X-Conclave-Account-Id': other.id },
        })
      ).status,
      401,
      path,
    );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM second_look_purchases WHERE account_id=$1',
        [owner.id],
      )
    ).rows[0].n,
    0,
  );
});
test('cross-origin Phase 2 posts are rejected before quote, export or purchase processing', async () => {
  for (const [path, body] of [
    ...writes(),
    [`alerts/${alertId}/read`, {}],
    ['follow/traders', { address: mint }],
  ])
    assert.equal(
      (
        await request(path, {
          method: 'POST',
          body,
          headers: { origin: 'https://elsewhere.example' },
        })
      ).status,
      403,
      path,
    );
});
test('successful account-scoped reads satisfy strict UI contracts and omit other users records', async () => {
  for (const [path, validator] of [
    ['alerts', alertsResponse],
    ['follow/traders', followList],
    ['cool-head', coolHeadResponse],
    ['planning/watch', exitWatchResponse],
    ['steady', steadyResponse],
    ['planning', planningResponse],
    [`follow/traders/${trader.id}/check`, followCheck],
  ]) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    const data = await response.json();
    assert.ok(validator(data), path);
    assert.equal(JSON.stringify(data).includes(foreignTrader.id), false);
    assert.equal(JSON.stringify(data).includes(foreignAlertId), false);
  }
  const follow = await (await request('follow/traders')).json();
  assert.equal(follow.traders.length, 1);
  assert.equal(follow.traders[0].id, trader.id);
  const alerts = await (await request('alerts')).json();
  assert.equal(alerts.alerts.length, 1);
  assert.equal(alerts.alerts[0].id, alertId);
});
test('foreign trader check, settings and deletion never reveal or mutate the other account', async () => {
  for (const [suffix, method, body] of [
    ['/check', 'GET', undefined],
    ['', 'PATCH', { label: 'Not mine' }],
    ['', 'DELETE', {}],
  ])
    assert.equal(
      (
        await request(`follow/traders/${foreignTrader.id}${suffix}`, {
          method,
          body,
        })
      ).status,
      404,
    );
  const edited = await request(`follow/traders/${trader.id}`, {
    method: 'PATCH',
    body: { label: 'Updated private label' },
  });
  assert.equal(edited.status, 200);
  assert.ok(followTraderResponse(await edited.json()));
});
test('read-reminder updates are ownership bound and use the strict mutation contract', async () => {
  assert.equal(
    (
      await request(`alerts/${foreignAlertId}/read`, {
        method: 'POST',
        body: {},
      })
    ).status,
    404,
  );
  const own = await request(`alerts/${alertId}/read`, {
    method: 'POST',
    body: {},
  });
  assert.equal(own.status, 200);
  assert.ok(alertReadResponse(await own.json()));
  assert.equal((await request('alerts?cursor=not-a-cursor')).status, 400);
});
test('Why It Moved returns explicitly scoped missing evidence without external calls', async () => {
  const r = await request('why-moved', {
    method: 'POST',
    body: { mint, window: '6h' },
  });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.ok(whyMovedReport(data));
  assert.equal(data.evidence.scope, 'tracked_wallets');
  assert.equal(data.evidence.wholeMarket, false);
  assert.equal(data.largestDriver, null);
  assert.equal(data.evidence.observedTrades, 0);
  assert.equal(
    (
      await request('why-moved', {
        method: 'POST',
        body: { mint, window: '6h', accountId: other.id },
      })
    ).status,
    400,
  );
});
test('tax and exit-plan routes reject foreign wallet IDs before creating records', async () => {
  const options = {
    year: 2025,
    jurisdiction: 'US',
    method: 'fifo',
    selections: [],
  };
  for (const [action, body] of [
    ['preview', options],
    ['export', { ...options, format: 'generic_json' }],
    [
      'unlock',
      {
        year: 2025,
        idempotencyKey: randomUUID(),
        expectedPriceUsd6: '9000000',
      },
    ],
  ])
    assert.equal(
      (
        await request(`tax/${foreignWallet.id}/${action}`, {
          method: 'POST',
          body,
        })
      ).status,
      404,
      action,
    );
  const plan = {
    revision: 0,
    walletId: foreignWallet.id,
    mint,
    takeProfit: { priceUsd: '1', sizeBps: 10000 },
    stopLoss: null,
    trailingBps: null,
  };
  assert.equal(
    (await request('planning/exit-plans', { method: 'POST', body: plan }))
      .status,
    404,
  );
  const preview = await request(`tax/${ownedWallet.id}/preview`, {
    method: 'POST',
    body: options,
  });
  assert.equal(preview.status, 200);
  const data = await preview.json();
  assert.ok(taxPreviewResponse(data));
  assert.equal(data.report.complete, false);
});
test('explicit Steady purchase, included tax unlock and partial export round trip satisfy client contracts', async () => {
  const body = { idempotencyKey: randomUUID(), expectedPriceUsd6: '12000000' };
  const response = await request('steady/purchase', { method: 'POST', body });
  assert.equal(response.status, 200);
  const purchase = await response.json();
  assert.ok(steadyPurchaseResponse(purchase));
  assert.equal(purchase.replayed, false);
  const replay = await (
    await request('steady/purchase', { method: 'POST', body })
  ).json();
  assert.ok(steadyPurchaseResponse(replay));
  assert.equal(replay.replayed, true);
  assert.equal(replay.transactionId, purchase.transactionId);
  const unlock = await request(`tax/${ownedWallet.id}/unlock`, {
    method: 'POST',
    body: {
      year: 2025,
      idempotencyKey: randomUUID(),
      expectedPriceUsd6: '9000000',
    },
  });
  assert.equal(unlock.status, 200);
  const access = await unlock.json();
  assert.ok(taxUnlockResponse(access));
  assert.equal(access.chargedUsd6, '0');
  const exported = await request(`tax/${ownedWallet.id}/export`, {
    method: 'POST',
    body: {
      year: 2025,
      jurisdiction: 'US',
      method: 'fifo',
      selections: [],
      format: 'generic_json',
    },
  });
  assert.equal(exported.status, 200);
  const data = await exported.json();
  assert.ok(taxExportResponse(data));
  assert.equal(data.report.complete, false);
  assert.match(data.content, /incomplete|unavailable|coverage|exception/i);
});
