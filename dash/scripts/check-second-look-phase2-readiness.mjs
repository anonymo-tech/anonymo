import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
const vapid = createECDH('prime256v1');
vapid.setPrivateKey(Buffer.alloc(32, 39));
import { createDatabase } from '../server/db/database.ts';
import {
  phase2Configuration,
  phase2Readiness,
  inspectPhase2Database,
} from '../server/second-look/phase2-readiness.ts';
import { migrate } from './migrate.mjs';

const configured = () => ({
  CONCLAVE_SECOND_LOOK_COOL_HEAD_POPULATION_FILE:
    '/private/operator-reviewed-population.json',
  CONCLAVE_SECOND_LOOK_COOL_HEAD_POPULATION_SHA256: 'f'.repeat(64),
  CONCLAVE_SECOND_LOOK_PUSH_ENABLED: 'true',
  CONCLAVE_PUSH_VAPID_SUBJECT: 'https://conclave.example',
  CONCLAVE_PUSH_VAPID_PRIVATE_KEY: vapid.getPrivateKey().toString('base64url'),
  CONCLAVE_PUSH_VAPID_PUBLIC_KEY: vapid.getPublicKey().toString('base64url'),
  CONCLAVE_DATABASE_URL:
    'postgresql://fixture@127.0.0.1:5549/synthetic_readiness_test',
  CONCLAVE_ACTIVE_DATA_KEY: 'readiness-fixture',
  CONCLAVE_DATA_KEYS: JSON.stringify({
    'readiness-fixture': Buffer.alloc(32, 38).toString('base64'),
  }),
  CONCLAVE_WALLET_INGEST_ENABLED: 'true',
  CONCLAVE_WALLET_RPC_URL: 'https://rpc.example.test/?token=never-emit-this',
  CONCLAVE_WALLET_ARCHIVE_URL:
    'https://archive.example.test/?token=never-emit-this',
  CONCLAVE_WALLET_ARCHIVE_SOURCE_ID: 'private-source-label',
  CONCLAVE_WALLET_PRICE_URL:
    'https://prices.example.test/?token=never-emit-this',
  CONCLAVE_WALLET_FEE_POLICY_ID: 'private-fee-label',
  CONCLAVE_SECOND_LOOK_GRAPH_URL:
    'https://graph.example.test/?token=never-emit-this',
  CONCLAVE_SECOND_LOOK_GRAPH_SOURCE_ID: 'private-graph-label',
  CONCLAVE_SOLANA_CLUSTER: 'mainnet-beta',
  CONCLAVE_EXIT_WATCH_ENABLED: 'true',
  CONCLAVE_ROBINHOOD_READ_ENABLED: 'true',
  CONCLAVE_ROBINHOOD_RPC_URL: 'https://evm.example.test/?token=never-emit-this',
  CONCLAVE_ROBINHOOD_SOURCE_ID: 'private-evm-label',
});
test('missing configuration reports actionable blockers and unknown database state, never all-clear', async () => {
  const result = await phase2Readiness({ env: {} });
  assert.equal(result.configurationReady, false);
  assert.equal(result.fullPhase2Ready, false);
  assert.equal(result.database.checked, false);
  assert.equal(result.database.reachable, null);
  assert.equal(result.database.workers, null);
  for (const code of [
    'DATABASE_NOT_CONFIGURED',
    'ENCRYPTED_STORAGE_NOT_CONFIGURED',
    'WALLET_INGEST_NOT_CONFIGURED',
    'COMPLETE_WALLET_ARCHIVE_REQUIRED',
    'HISTORICAL_PRICES_REQUIRED',
    'WHOLE_MARKET_GRAPH_SOURCE_REQUIRED',
    'EXIT_WATCH_NOT_CONFIGURED',
    'POPULATION_DATASET_NOT_CONFIGURED',
  ])
    assert.ok(
      result.blockers.some((b) => b.code === code),
      code,
    );
});
test('fully supplied configuration is distinct from validated source coverage and worker activation', async () => {
  const env = configured(),
    result = await phase2Readiness({ env });
  assert.equal(result.configurationReady, true);
  assert.equal(result.activationValidated, false);
  assert.equal(result.fullPhase2Ready, false);
  assert.equal(result.configuration.wallet.archiveAdapterConfigured, true);
  assert.equal(result.configuration.wallet.coverageValidated, false);
  assert.equal(result.configuration.marketGraph.adapterConfigured, true);
  assert.equal(
    result.configuration.marketGraph.wholeMarketCoverageValidated,
    false,
  );
  assert.equal(result.configuration.robinhood.receiptReadsConfigured, true);
  assert.equal(result.configuration.robinhood.completeWalletHistory, false);
  assert.equal(result.configuration.robinhood.followMetricsReady, false);
  assert.equal(
    result.configuration.populationBaseRates.artifactConfigured,
    true,
  );
  assert.equal(
    result.configuration.populationBaseRates.artifactValidated,
    false,
  );
  const text = JSON.stringify(result);
  for (const value of [
    'never-emit-this',
    'example.test',
    'private-source-label',
    'private-graph-label',
    'private-fee-label',
    'private-evm-label',
    'readiness-fixture',
    env.CONCLAVE_DATA_KEYS,
    env.CONCLAVE_DATABASE_URL,
    env.CONCLAVE_SECOND_LOOK_COOL_HEAD_POPULATION_FILE,
    env.CONCLAVE_SECOND_LOOK_COOL_HEAD_POPULATION_SHA256,
  ])
    assert.equal(text.includes(value), false);
});
test('current SOL spot and asserted flags never substitute for complete historical pricing or graph evidence', async () => {
  const env = {
    ...configured(),
    CONCLAVE_WALLET_PRICE_URL: undefined,
    CONCLAVE_WALLET_ARCHIVE_URL: undefined,
    CONCLAVE_SECOND_LOOK_GRAPH_URL: undefined,
    CONCLAVE_WALLET_SOL_SPOT_ENABLED: 'true',
    CONCLAVE_COMPLETE_HISTORY: 'true',
    CONCLAVE_PHASE2_READY: 'true',
  };
  const result = await phase2Readiness({ env });
  assert.equal(result.configuration.wallet.solSpotConfigured, true);
  assert.equal(
    result.configuration.wallet.historicalPriceAdapterConfigured,
    false,
  );
  assert.equal(result.configuration.wallet.coverageValidated, false);
  for (const code of [
    'HISTORICAL_PRICES_REQUIRED',
    'COMPLETE_WALLET_ARCHIVE_REQUIRED',
    'WHOLE_MARKET_GRAPH_SOURCE_REQUIRED',
  ])
    assert.ok(result.blockers.some((b) => b.code === code));
  assert.equal(result.fullPhase2Ready, false);
});
test('invalid keyring and unsafe endpoints cannot become configured capabilities', () => {
  const env = {
    ...configured(),
    CONCLAVE_DATA_KEYS: 'bad secret input',
    CONCLAVE_WALLET_RPC_URL: 'http://rpc.example.test',
    CONCLAVE_WALLET_ARCHIVE_URL: undefined,
    CONCLAVE_SECOND_LOOK_GRAPH_URL: 'https://user:password@example.test',
  };
  const result = phase2Configuration(env);
  assert.equal(result.encryptedKeyringConfigured, false);
  assert.equal(result.wallet.ingestConfigured, false);
  assert.equal(result.marketGraph.adapterConfigured, false);
  assert.equal(result.exit.configured, false);
});
test('database failures are reduced to safe state without upstream error text', async () => {
  const pool = {
    connect: async () => {
      throw new Error('postgresql://secret-user:private-password@private-host');
    },
  };
  const result = await phase2Readiness({ env: configured(), pool });
  assert.equal(result.database.checked, true);
  assert.equal(result.database.reachable, false);
  assert.equal(result.fullPhase2Ready, false);
  assert.equal(JSON.stringify(result).includes('private-password'), false);
});
test('missing schema uses read-only statements and cannot report migrations or workers as ready', async () => {
  const calls = [],
    pool = {
      connect: async () => ({
        release() {},
        async query(sql) {
          calls.push(sql);
          if (sql.includes('to_regclass'))
            return { rows: [{ present: false }] };
          if (sql.includes('pg_class'))
            return { rows: [{ n: 0, protected: null }] };
          return { rows: [] };
        },
      }),
    };
  const result = await inspectPhase2Database(pool);
  assert.equal(result.migrationsPresent, 0);
  assert.equal(result.migrationChecksumsMatch, false);
  assert.equal(result.privateRowSecurityEnabled, false);
  assert.equal(result.workers, null);
  assert.match(calls[0], /READ ONLY$/);
  assert.ok(
    calls.every((sql) => !/INSERT|UPDATE|DELETE|ALTER|CREATE/.test(sql)),
  );
});
const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
await test(
  'real PostgreSQL migrations, RLS and queue counts remain separate from activation',
  { skip: !connection },
  async () => {
    const url = new URL(connection);
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
        url.pathname.endsWith('_test'),
    );
    const pool = createDatabase(connection, 2);
    try {
      await migrate(pool);
      const report = await phase2Readiness({
        env: { ...configured(), CONCLAVE_DATABASE_URL: connection },
        pool,
      });
      assert.equal(report.database.reachable, true);
      assert.equal(report.database.migrationsPresent, 12);
      assert.equal(report.database.migrationChecksumsMatch, true);
      assert.equal(report.database.privateTablesPresent, 34);
      assert.equal(report.database.privateRowSecurityEnabled, true);
      for (const worker of Object.values(report.database.workers)) {
        assert.equal(worker.activationValidated, false);
        assert.ok(Number.isInteger(worker.due));
        assert.ok(Number.isInteger(worker.leased));
      }
      assert.equal(report.fullPhase2Ready, false);
      assert.equal(report.activationValidated, false);
      assert.ok(
        report.blockers.some(
          (b) => b.code === 'LIVE_SOURCE_COVERAGE_UNVERIFIED',
        ),
      );
    } finally {
      await pool.end();
    }
  },
);

test('in-app reminders and personal history do not imply Web Push or population-rate activation', async () => {
  const result = await phase2Readiness({
    env: {
      ...configured(),
      CONCLAVE_PUSH_VAPID_PUBLIC_KEY: 'asserted',
      CONCLAVE_POPULATION_READY: 'true',
      CONCLAVE_SECOND_LOOK_COOL_HEAD_POPULATION_SHA256: undefined,
    },
  });
  assert.equal(result.configuration.webPush.deliveryConfigured, false);
  assert.equal(result.configuration.webPush.vapidConfigurationValidated, false);
  assert.equal(
    result.configuration.populationBaseRates.artifactConfigured,
    false,
  );
  assert.ok(
    result.blockers.some((b) => b.code === 'WEB_PUSH_ACTIVATION_UNVERIFIED'),
  );
  assert.ok(
    result.blockers.some((b) => b.code === 'POPULATION_BASE_RATES_UNVERIFIED'),
  );
  assert.ok(
    result.blockers.some((b) => b.code === 'POPULATION_DATASET_NOT_CONFIGURED'),
  );
});
