import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import { runCoolHeadOnce } from '../server/second-look/cool-head-worker.ts';
import { coolHeadSummary } from '../server/second-look/cool-head-service.ts';
import { evaluateCoolHead } from '../server/second-look/cool-head.ts';
import {
  getPlanning,
  changePlanning,
} from '../server/second-look/planning-store.ts';
import { listSecondLookAlerts } from '../server/second-look/alerts-store.ts';
import {
  linkWallet,
  unlinkWallet,
} from '../server/second-look/wallet-store.ts';
import {
  configuredKeyring,
  sealWallet,
  walletDigest,
} from '../server/second-look/wallet-crypto.ts';
import { coolHeadResponse } from '../lib/client/cool-head-contracts.ts';
import { defaultCoolHeadRules } from '../lib/second-look/cool-head.ts';
const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
if (!connection)
  throw Error('An isolated loopback *_test database is required.');
const endpoint = new URL(connection);
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
  !endpoint.pathname.endsWith('_test')
)
  throw Error('Only an isolated loopback *_test database is allowed.');
for (const key of Object.keys(process.env))
  if (key.startsWith('CONCLAVE_')) delete process.env[key];
Object.assign(process.env, {
  CONCLAVE_ACTIVE_DATA_KEY: 'cool-test',
  CONCLAVE_DATA_KEYS: JSON.stringify({
    'cool-test': randomBytes(32).toString('base64'),
  }),
});
const pool = createDatabase(connection, 4),
  A = 'So11111111111111111111111111111111111111112',
  USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
before(async () => {
  await migrate(pool);
});
after(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query('UPDATE accounts SET disabled_at=now()');
  await pool.query('DELETE FROM second_look_cool_head_jobs');
});
async function fixture() {
  const owner = randomUUID();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [owner]);
  const wallet = await linkWallet(pool, owner, A, 'Behavior fixture');
  return { owner, wallet };
}
const now = () => new Date(Date.now() + 1000);
function summary(walletId, instant, patch = {}) {
  const base = evaluateCoolHead({
    settings: { enabled: true, timezone: 'UTC', dailyBudgetUsd6: null },
    asOf: instant.toISOString(),
    buys: [],
    closes: [],
    coverage: false,
  });
  return {
    ...base,
    nudges: ['chase', 'revenge', 'night', 'budget', 'size'].map(
      (signal, index) => ({
        id: createHash('sha256')
          .update(`${walletId}:${instant.toISOString()}:${index}`)
          .digest('hex'),
        walletId,
        signal,
        at: instant.toISOString(),
        mint: MINT,
        text: 'Observed condition.',
        action: 'Review this trade',
        baseRate: null,
      }),
    ),
    ...patch,
  };
}
async function due(owner, instant) {
  await pool.query(
    'UPDATE second_look_cool_head_jobs SET next_run_at=$2 WHERE account_id=$1',
    [owner, new Date(instant.getTime() - 1)],
  );
}

test('worker persists no more than three daily nudges under concurrent runs and retries', async () => {
  const { owner, wallet } = await fixture(),
    instant = now(),
    fake = async () => summary(wallet.id, instant);
  const results = await Promise.all([
    runCoolHeadOnce(pool, { now: instant, summary: fake }),
    runCoolHeadOnce(pool, { now: instant, summary: fake }),
  ]);
  assert.equal(
    results.reduce((n, r) => n + r.inserted, 0),
    3,
  );
  assert.equal((await listSecondLookAlerts(pool, owner)).alerts.length, 3);
  await due(owner, instant);
  assert.equal(
    (await runCoolHeadOnce(pool, { now: instant, summary: fake })).inserted,
    0,
  );
  const next = new Date(instant.getTime() + 1000);
  await due(owner, next);
  assert.equal(
    (
      await runCoolHeadOnce(pool, {
        now: next,
        summary: async () => summary(wallet.id, next),
      })
    ).inserted,
    0,
  );
  const raw = await pool.query(
    'SELECT payload_ciphertext FROM second_look_alerts WHERE account_id=$1',
    [owner],
  );
  assert(raw.rows.every((r) => !r.payload_ciphertext.includes(MINT)));
});
test('off while evaluation is in flight suppresses delivery immediately', async () => {
  const { owner, wallet } = await fixture(),
    instant = now();
  let entered, release;
  const started = new Promise((resolve) => {
      entered = resolve;
    }),
    pause = new Promise((resolve) => {
      release = resolve;
    });
  const worker = runCoolHeadOnce(pool, {
    now: instant,
    summary: async () => {
      entered();
      await pause;
      return summary(wallet.id, instant);
    },
  });
  await started;
  const plan = await getPlanning(pool, owner);
  await changePlanning(pool, owner, plan.revision, {
    kind: 'settings',
    settings: { ...plan.coolHead, enabled: false },
  });
  release();
  assert.equal((await worker).inserted, 0);
  assert.equal((await listSecondLookAlerts(pool, owner)).alerts.length, 0);
});
test('unlink in flight discards wallet evidence; later unlink removes delivered notes', async () => {
  const { owner, wallet } = await fixture(),
    instant = now();
  let entered, release;
  const started = new Promise((resolve) => {
      entered = resolve;
    }),
    pause = new Promise((resolve) => {
      release = resolve;
    });
  const worker = runCoolHeadOnce(pool, {
    now: instant,
    summary: async () => {
      entered();
      await pause;
      return summary(wallet.id, instant);
    },
  });
  await started;
  await unlinkWallet(pool, owner, wallet.id);
  release();
  assert.equal((await worker).inserted, 0);
  const linked = await linkWallet(pool, owner, A, 'New link');
  await due(owner, instant);
  await runCoolHeadOnce(pool, {
    now: instant,
    summary: async () => summary(linked.id, instant),
  });
  assert.equal((await listSecondLookAlerts(pool, owner)).alerts.length, 3);
  await unlinkWallet(pool, owner, linked.id);
  assert.equal((await listSecondLookAlerts(pool, owner)).alerts.length, 0);
  const counts = await pool.query(
    'SELECT sent FROM second_look_alert_daily_counts WHERE account_id=$1',
    [owner],
  );
  assert.equal(counts.rows[0].sent, 3);
});
test('resetting custom rules to defaults rejects stale in-flight calculations', async () => {
  const { owner, wallet } = await fixture(),
    instant = now();
  const plan = await getPlanning(pool, owner),
    rules = { ...defaultCoolHeadRules, chaseMultiple: 5 };
  await changePlanning(pool, owner, plan.revision, {
    kind: 'settings',
    settings: { ...plan.coolHead, rules },
  });
  const result = await runCoolHeadOnce(pool, {
    now: instant,
    summary: async () => {
      const current = await getPlanning(pool, owner);
      await changePlanning(pool, owner, current.revision, {
        kind: 'settings',
        settings: { enabled: true, timezone: 'UTC', dailyBudgetUsd6: null },
      });
      return summary(wallet.id, instant, { rules });
    },
  });
  assert.equal(result.inserted, 0);
});
test('DST repeats one local day without resetting the daily three-nudge cap', async () => {
  const { owner, wallet } = await fixture(),
    plan = await getPlanning(pool, owner);
  await changePlanning(pool, owner, plan.revision, {
    kind: 'settings',
    settings: { ...plan.coolHead, timezone: 'America/New_York' },
  });
  const first = new Date('2026-11-01T05:30:00.000Z'),
    second = new Date('2026-11-01T06:30:00.000Z');
  const custom = (at) => {
    const result = summary(wallet.id, at);
    return {
      ...result,
      timezone: 'America/New_York',
      today: { ...result.today, day: '2026-11-01' },
    };
  };
  assert.equal(
    (
      await runCoolHeadOnce(pool, {
        now: first,
        summary: async () => custom(first),
      })
    ).inserted,
    3,
  );
  await due(owner, second);
  assert.equal(
    (
      await runCoolHeadOnce(pool, {
        now: second,
        summary: async () => custom(second),
      })
    ).inserted,
    0,
  );
});
test('empty and incomplete cached wallet history never invent personal rates or closed losses', async () => {
  const { owner, wallet } = await fixture(),
    instant = now();
  const empty = await coolHeadSummary(pool, owner, instant.toISOString());
  assert(coolHeadResponse({ summary: empty }));
  assert.equal(empty.coverage, 'partial');
  assert.equal(empty.suggestedBudgetUsd6, null);
  assert.deepEqual(empty.nudges, []);
  const keyring = configuredKeyring(),
    at = instant.toISOString(),
    signature = 'a'.repeat(64),
    digest = walletDigest(owner, 'signature', signature, keyring);
  const trade = {
    signature,
    transactionIndex: 0,
    slot: '1',
    timestamp: at,
    wallet: A,
    feePayer: A,
    signer: true,
    failed: false,
    deltas: [
      {
        mint: USDC,
        decimals: 6,
        amount: '-90000000',
        kind: 'swap',
        counterparty: null,
      },
      {
        mint: MINT,
        decimals: 6,
        amount: '30000000',
        kind: 'swap',
        counterparty: null,
      },
    ],
    fees: [],
    rentLamports: '0',
    warnings: [],
  };
  await pool.query(
    "INSERT INTO second_look_wallet_transactions(wallet_id,account_id,signature_digest,locator_ciphertext,slot,state,ledger_ciphertext) VALUES($1,$2,$3,$4,1,'finalized',$5)",
    [
      wallet.id,
      owner,
      digest,
      await sealWallet(
        { signature },
        owner,
        wallet.id,
        'locator',
        keyring,
        digest,
      ),
      await sealWallet(trade, owner, wallet.id, 'ledger', keyring, digest),
    ],
  );
  const price = {
    mint: USDC,
    at,
    priceUsd: '1',
    lastTradeAt: at,
    liquidityUsd: '1000',
    estimated: false,
    source: 'https://example.org/observed',
  };
  const priceDigest = walletDigest(owner, 'price', USDC + at, keyring);
  await pool.query(
    "INSERT INTO second_look_wallet_prices(wallet_id,account_id,price_at,price_digest,price_ciphertext,priced,kind) VALUES($1,$2,$3,$4,$5,true,'historical')",
    [
      wallet.id,
      owner,
      at,
      priceDigest,
      await sealWallet(
        { mint: USDC, at, price },
        owner,
        wallet.id,
        'price',
        keyring,
        priceDigest,
      ),
    ],
  );
  const result = await coolHeadSummary(pool, owner, at);
  assert.equal(result.today.grossUsd6, '90000000');
  assert.equal(result.today.complete, false);
  assert(result.nudges.every((n) => n.baseRate === null));
  assert(
    !result.nudges.some((n) =>
      ['revenge', 'night', 'streak'].includes(n.signal),
    ),
  );
});
test('historical personal rate never incorporates a position that closes after the current buy', () => {
  const at = '2026-10-12T04:00:00.000Z',
    walletId = randomUUID(),
    base = {
      walletId,
      mint: MINT,
      grossUsd6: '1000000',
      priceUsd: '3',
      hourAgoPriceUsd: '1',
      outcome: 'loss',
    };
  const buys = Array.from({ length: 10 }, (_, i) => ({
    ...base,
    id: String(i),
    at: `2026-10-${String(i + 1).padStart(2, '0')}T04:00:00.000Z`,
    outcomeAt: '2026-10-12T04:01:00.000Z',
  }));
  buys.push({ ...base, id: 'current', at, outcome: null, outcomeAt: null });
  const r = evaluateCoolHead({
    settings: { enabled: true, timezone: 'UTC', dailyBudgetUsd6: null },
    asOf: '2026-10-12T04:02:00.000Z',
    coverage: true,
    buys,
    closes: [],
  });
  assert.equal(r.nudges[0].baseRate, null);
});
test('median daily budget includes zero-spend calendar days', () => {
  const at = '2026-10-12T04:00:00.000Z';
  const r = evaluateCoolHead({
    settings: { enabled: true, timezone: 'UTC', dailyBudgetUsd6: null },
    asOf: at,
    coverage: true,
    buys: [
      {
        id: 'one',
        walletId: randomUUID(),
        mint: MINT,
        at: '2026-10-11T04:00:00.000Z',
        grossUsd6: '1000000000',
        priceUsd: '1',
        hourAgoPriceUsd: null,
        outcome: null,
      },
    ],
    closes: [],
  });
  assert.equal(r.suggestedBudgetUsd6, null);
});

async function saveCoverage(
  owner,
  wallet,
  at,
  transactionCount = 0,
  holdings = [],
) {
  const coverage = {
    sourceId: 'reviewed-fixture',
    snapshotId: 'fixture-cutoff',
    wallet: wallet.address,
    genesisHash: 'fixture-genesis',
    asOf: at,
    asOfSlot: '99',
    startsAtGenesis: true,
    includesClosedTokenAccounts: true,
    includesDelegatedTransfers: true,
    holdingsIncludeRentReserves: true,
    feePolicyId: 'reviewed',
    transactionCount,
    holdings,
  };
  await pool.query(
    'UPDATE second_look_wallet_jobs SET coverage_ciphertext=$3 WHERE account_id=$1 AND wallet_id=$2',
    [
      owner,
      wallet.id,
      await sealWallet(
        coverage,
        owner,
        wallet.id,
        'coverage',
        configuredKeyring(),
      ),
    ],
  );
}
test('fresh linked-wallet snapshots use their oldest real cutoff, including the calendar day, without claiming later budget coverage', async () => {
  const { owner, wallet } = await fixture(),
    other = await linkWallet(pool, owner, USDC, 'Second wallet');
  const requested = '2026-10-13T00:00:02.000Z',
    old = '2026-10-12T23:59:58.000Z',
    newer = '2026-10-13T00:00:01.000Z';
  await saveCoverage(owner, wallet, old);
  await saveCoverage(owner, other, newer);
  const result = await coolHeadSummary(pool, owner, requested);
  assert.equal(result.asOf, old);
  assert.equal(result.today.day, '2026-10-12');
  assert.equal(result.coverage, 'verified');
  assert.equal(result.today.complete, true);
  assert.ok(result.exceptions.includes('SOURCE_SNAPSHOT_CUTOFF'));
  assert.ok(coolHeadResponse({ summary: result }));
});
test('future and stale source snapshots never certify current-day budgets', async () => {
  const { owner, wallet } = await fixture(),
    requested = '2026-10-12T12:00:00.000Z';
  for (const at of ['2026-10-12T12:00:01.000Z', '2026-10-12T11:54:59.000Z']) {
    await saveCoverage(owner, wallet, at);
    const result = await coolHeadSummary(pool, owner, requested);
    assert.equal(result.asOf, requested);
    assert.equal(result.coverage, 'partial');
    assert.equal(result.today.complete, false);
    assert.ok(result.exceptions.includes('COVERAGE_SNAPSHOT_STALE_OR_FUTURE'));
  }
});
test('priced reconciled losses remain available from a fresh archive snapshot between polls', async () => {
  const { owner, wallet } = await fixture(),
    cutoff = '2026-10-12T12:00:00.000Z',
    requested = '2026-10-12T12:00:10.000Z',
    keyring = configuredKeyring();
  const definitions = [
    ['buy', '2026-10-12T11:57:00.000Z', '100000000'],
    ['sell', '2026-10-12T11:58:00.000Z', '50000000'],
    ['buy', '2026-10-12T11:59:00.000Z', '100000000'],
  ];
  for (let i = 0; i < definitions.length; i++) {
    const [side, at, quote] = definitions[i],
      signature = String.fromCharCode(98 + i).repeat(64),
      digest = walletDigest(owner, 'signature', signature, keyring),
      trade = {
        signature,
        transactionIndex: 0,
        slot: String(i + 1),
        timestamp: at,
        wallet: A,
        feePayer: A,
        signer: true,
        failed: false,
        deltas: [
          {
            mint: USDC,
            decimals: 6,
            amount: side === 'buy' ? `-${quote}` : quote,
            kind: 'swap',
            counterparty: null,
          },
          {
            mint: MINT,
            decimals: 0,
            amount: side === 'buy' ? '10' : '-10',
            kind: 'swap',
            counterparty: null,
          },
        ],
        fees: [],
        rentLamports: '0',
        warnings: [],
      };
    await pool.query(
      "INSERT INTO second_look_wallet_transactions(wallet_id,account_id,signature_digest,locator_ciphertext,slot,state,ledger_ciphertext) VALUES($1,$2,$3,$4,$5,'finalized',$6)",
      [
        wallet.id,
        owner,
        digest,
        await sealWallet(
          { signature },
          owner,
          wallet.id,
          'locator',
          keyring,
          digest,
        ),
        i + 1,
        await sealWallet(trade, owner, wallet.id, 'ledger', keyring, digest),
      ],
    );
    const price = {
        mint: USDC,
        at,
        priceUsd: '1',
        lastTradeAt: at,
        liquidityUsd: '1000',
        estimated: false,
        source: 'fixture',
      },
      priceDigest = walletDigest(owner, 'price', USDC + at, keyring);
    await pool.query(
      "INSERT INTO second_look_wallet_prices(wallet_id,account_id,price_at,price_digest,price_ciphertext,priced,kind) VALUES($1,$2,$3,$4,$5,true,'historical')",
      [
        wallet.id,
        owner,
        at,
        priceDigest,
        await sealWallet(
          { mint: USDC, at, price },
          owner,
          wallet.id,
          'price',
          keyring,
          priceDigest,
        ),
      ],
    );
  }
  const mark = {
      mint: MINT,
      at: cutoff,
      priceUsd: '10',
      lastTradeAt: cutoff,
      liquidityUsd: '1000',
      estimated: false,
      source: 'fixture',
    },
    markDigest = walletDigest(owner, 'price', MINT + cutoff, keyring);
  await pool.query(
    "INSERT INTO second_look_wallet_prices(wallet_id,account_id,price_at,price_digest,price_ciphertext,priced,kind) VALUES($1,$2,$3,$4,$5,true,'mark')",
    [
      wallet.id,
      owner,
      cutoff,
      markDigest,
      await sealWallet(
        { mint: MINT, at: cutoff, price: mark },
        owner,
        wallet.id,
        'price',
        keyring,
        markDigest,
      ),
    ],
  );
  await saveCoverage(owner, wallet, cutoff, 3, [
    { mint: MINT, decimals: 0, amount: '10' },
  ]);
  const result = await coolHeadSummary(pool, owner, requested);
  assert.equal(result.asOf, cutoff);
  assert.equal(result.today.complete, true, JSON.stringify(result.exceptions));
  assert.equal(result.today.grossUsd6, '200000000');
  assert.ok(result.nudges.some((n) => n.signal === 'revenge'));
});
