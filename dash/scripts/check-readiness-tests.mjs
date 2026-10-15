import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import bs58 from 'bs58';
import { receiptPublicKey } from '../server/receipts/index.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkReadiness,
  inspectTreasuryTokenAccount,
  migrationDrift,
  migrationFiles,
  runReadiness,
  unexpectedPrivileges,
} from './check-readiness.mjs';
import {
  buildPlan,
  checkEnvironment,
  databaseSuiteFiles,
  parseArguments,
  pureSuites,
  runsIn,
  stepEnvironment,
  treeDigest,
} from '../deploy/deploy.mjs';
import {
  SOLANA_NETWORKS,
  TOKEN_PROGRAM,
} from '../server/solana/validation.ts';

const base = () => ({
  CONCLAVE_MODE: 'service',
  CONCLAVE_APP_ORIGIN: 'https://conclave.example',
  CONCLAVE_DATABASE_URL:
    'postgresql://service_role@database.example/fixture?sslmode=verify-full',
  CONCLAVE_ACTIVE_DATA_KEY: 'active',
  CONCLAVE_DATA_KEYS: JSON.stringify({
    active: randomBytes(32).toString('base64'),
  }),
});
const enabled = () => ({
  ...base(),
  PPQ_API_KEY: randomBytes(24).toString('hex'),
  CONCLAVE_INFERENCE_ENABLED: 'true',
  // Production readiness requires the per-account overage breaker.
  CONCLAVE_MAX_ACCOUNT_OVERAGE_USD6: '1000000',
});
const has = (report, code, status = 'error') =>
  report.findings.some((item) => item.code === code && item.status === status);

void test('unconfigured defaults stay preview and never suggest launch readiness', async () => {
  const { report, exitCode } = await runReadiness([], {});
  assert.equal(exitCode, 0);
  assert.equal(report.readiness, 'preview_only');
  assert.equal(report.capabilities.inferenceConfigured, false);
  assert.equal(report.capabilities.chainConfigured, false);
  assert.equal(report.networkChecksPerformed, false);
  assert.equal(report.databaseChecksPerformed, false);
  assert.ok(has(report, 'PROVIDER_KEY', 'pending'));
  assert.ok(has(report, 'SOLANA_CONFIGURATION', 'pending'));
});

void test('valid local configuration checks never connect to a database or provider', async () => {
  const originalFetch = globalThis.fetch,
    originalConnect = Reflect.get(pg.Pool.prototype, 'connect');
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('Unexpected connection');
  };
  pg.Pool.prototype.connect = function () {
    calls++;
    throw new Error('Unexpected connection');
  };
  try {
    const report = await checkReadiness(enabled(), {
      target: 'worker',
      production: true,
    });
    assert.equal(report.configurationOk, true);
    assert.equal(report.readiness, 'external_verification_required');
    assert.equal(report.capabilities.inferenceConfigured, true);
    assert.ok(has(report, 'DATABASE_READINESS', 'pending'));
    assert.ok(has(report, 'ROUTE_READINESS', 'pending'));
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    pg.Pool.prototype.connect = originalConnect;
  }
});

void test('unsafe production origin and database TLS or routing syntax fail closed', async () => {
  for (const origin of [
    'http://conclave.example',
    'http://localhost:3000',
    'https://localhost',
    'https://user:password@conclave.example',
    'https://conclave.example/private',
  ]) {
    const report = await checkReadiness(
      { ...base(), CONCLAVE_APP_ORIGIN: origin },
      { target: 'api', production: true },
    );
    assert.equal(report.configurationOk, false);
  }
  for (const database of [
    'postgresql://service_role@database.example/fixture?sslmode=disable',
    'postgresql://service_role@database.example/fixture?host=other.example',
    'postgresql://service_role@127.0.0.1/fixture',
    'postgresql://database.example/fixture',
    'postgresql://service_role@database.example/%ZZ',
  ]) {
    const report = await checkReadiness(
      { ...base(), CONCLAVE_DATABASE_URL: database },
      { target: 'api', production: true },
    );
    assert.ok(has(report, 'DATABASE_CONFIGURATION'));
  }
  const local = await checkReadiness(
    {
      ...base(),
      CONCLAVE_APP_ORIGIN: 'http://localhost:3000',
      CONCLAVE_DATABASE_URL: 'postgresql://service_role@127.0.0.1/fixture',
    },
    { target: 'api' },
  );
  assert.equal(local.configurationOk, true);
});

void test('passkeys require explicit enablement and a hostname-bound relying party', async () => {
  const configured = { ...base(), CONCLAVE_PASSKEYS_ENABLED: 'true' };
  assert.ok(
    has(
      await checkReadiness(configured, { target: 'api' }),
      'PASSKEY_CONFIGURATION',
      'pass',
    ),
  );
  assert.ok(
    has(
      await checkReadiness(
        { ...configured, CONCLAVE_APP_ORIGIN: 'http://localhost:3000' },
        { target: 'api' },
      ),
      'PASSKEY_CONFIGURATION',
      'pass',
    ),
  );
  assert.ok(
    has(
      await checkReadiness(
        { ...configured, CONCLAVE_APP_ORIGIN: 'http://127.0.0.1:3000' },
        { target: 'api' },
      ),
      'PASSKEY_CONFIGURATION',
    ),
  );
  assert.ok(
    has(
      await checkReadiness(
        { ...configured, CONCLAVE_PASSKEYS_ENABLED: 'yes' },
        { target: 'api' },
      ),
      'PASSKEY_FLAG_INVALID',
    ),
  );
});

void test('keyring validation rejects invalid lengths, missing active keys and placeholder material', async () => {
  for (const values of [
    { CONCLAVE_DATA_KEYS: '{}' },
    { CONCLAVE_ACTIVE_DATA_KEY: 'missing' },
    {
      CONCLAVE_DATA_KEYS: JSON.stringify({
        active: randomBytes(31).toString('base64'),
      }),
    },
    {
      CONCLAVE_DATA_KEYS: JSON.stringify({
        active: Buffer.alloc(32).toString('base64'),
      }),
    },
  ])
    assert.ok(
      has(
        await checkReadiness({ ...base(), ...values }, { target: 'api' }),
        'STORAGE_KEYS',
      ),
    );
});

void test('explicit capability flags and concurrency bounds cannot be replaced by truthy strings', async () => {
  assert.ok(
    has(
      await checkReadiness(
        { ...enabled(), CONCLAVE_INFERENCE_ENABLED: 'yes' },
        { target: 'worker' },
      ),
      'INFERENCE_FLAG_INVALID',
    ),
  );
  assert.ok(
    has(
      await checkReadiness(
        { ...base(), CONCLAVE_CROSSCHECK_ENABLED: 'true' },
        { target: 'api' },
      ),
      'CROSSCHECK_GATE',
    ),
  );
  for (const value of ['0', '5', '2.5', 'NaN', '4x'])
    assert.ok(
      has(
        await checkReadiness(
          { ...enabled(), CONCLAVE_WORKER_CONCURRENCY: value },
          { target: 'worker' },
        ),
        'WORKER_LIMIT',
      ),
    );
  assert.ok(
    has(
      await checkReadiness(
        { ...enabled(), PPQ_API_KEY: 'invalid key whitespace' },
        { target: 'worker' },
      ),
      'PROVIDER_KEY',
    ),
  );
  assert.ok(
    has(
      await checkReadiness(
        { ...base(), NODE_TLS_REJECT_UNAUTHORIZED: '0' },
        { target: 'api' },
      ),
      'TLS_VERIFICATION_DISABLED',
    ),
  );
});

void test('receipt signer checks enforce trusted identity, live UTC window and separate process custody', async () => {
  const seed = randomBytes(32),
    validFrom = new Date(Date.now() - 60_000).toISOString(),
    validUntil = new Date(Date.now() + 3_600_000).toISOString();
  const signer = {
    CONCLAVE_RECEIPT_SIGNER_KEY_ID: 'review-key',
    CONCLAVE_RECEIPT_SIGNER_EPOCH: '1',
    CONCLAVE_RECEIPT_SIGNER_SEED_HEX: seed.toString('hex'),
    CONCLAVE_RECEIPT_SIGNER_VALID_FROM: validFrom,
    CONCLAVE_RECEIPT_SIGNER_VALID_UNTIL: validUntil,
    CONCLAVE_RECEIPT_TRUSTED_SIGNERS: JSON.stringify([
      {
        keyId: 'review-key',
        epoch: 1,
        publicKey: receiptPublicKey(seed),
        validFrom,
        validUntil,
        revoked: false,
      },
    ]),
  };
  assert.equal(
    (await checkReadiness({ ...base(), ...signer }, { target: 'receipts' }))
      .capabilities.receiptSigner,
    true,
  );
  assert.ok(
    has(
      await checkReadiness({ ...base(), ...signer }, { target: 'api' }),
      'SIGNER_PROCESS_ISOLATION',
      'warning',
    ),
  );
  assert.ok(
    has(
      await checkReadiness(
        { ...base(), ...signer, CONCLAVE_RECEIPT_SIGNER_EPOCH: '2' },
        { target: 'receipts' },
      ),
      'RECEIPT_SIGNER',
    ),
  );
  const revoked = JSON.parse(signer.CONCLAVE_RECEIPT_TRUSTED_SIGNERS);
  revoked[0].revoked = true;
  assert.ok(
    has(
      await checkReadiness(
        {
          ...base(),
          ...signer,
          CONCLAVE_RECEIPT_TRUSTED_SIGNERS: JSON.stringify(revoked),
        },
        { target: 'receipts' },
      ),
      'RECEIPT_SIGNER',
    ),
  );
  const expired = JSON.parse(signer.CONCLAVE_RECEIPT_TRUSTED_SIGNERS);
  expired[0].validUntil = new Date(Date.now() - 1).toISOString();
  assert.ok(
    has(
      await checkReadiness(
        {
          ...base(),
          ...signer,
          CONCLAVE_RECEIPT_SIGNER_VALID_UNTIL: expired[0].validUntil,
          CONCLAVE_RECEIPT_TRUSTED_SIGNERS: JSON.stringify(expired),
        },
        { target: 'receipts' },
      ),
      'RECEIPT_SIGNER',
    ),
  );
  seed.fill(0);
});

void test('chain network is explicit and treasury limits remain exact integer configuration', async () => {
  const chain = {
    ...base(),
    CONCLAVE_SOLANA_CLUSTER: 'devnet',
    CONCLAVE_SOLANA_RPC_URL: 'https://rpc.example',
    CONCLAVE_TREASURY_WALLET: bs58.encode(randomBytes(32)),
    CONCLAVE_TREASURY_TOKEN_ACCOUNT: bs58.encode(randomBytes(32)),
    CONCLAVE_MAX_DEPOSIT_USD6: '1000000',
    CONCLAVE_DEPOSITS_ENABLED: 'true',
  };
  const report = await checkReadiness(chain, { target: 'api' });
  assert.equal(report.configurationOk, true);
  assert.equal(report.capabilities.chainConfigured, true);
  for (const values of [
    { CONCLAVE_SOLANA_CLUSTER: 'testnet' },
    { CONCLAVE_SOLANA_RPC_URL: 'http://rpc.example' },
    { CONCLAVE_SOLANA_CLUSTER: undefined },
  ])
    assert.ok(
      has(
        await checkReadiness({ ...chain, ...values }, { target: 'api' }),
        'SOLANA_CONFIGURATION',
      ),
    );
  for (const amount of ['0', '-1', '1.1', '01', '9000000000000001'])
    assert.ok(
      has(
        await checkReadiness(
          { ...chain, CONCLAVE_MAX_DEPOSIT_USD6: amount },
          { target: 'api' },
        ),
        'DEPOSIT_POLICY',
      ),
    );
  const recovery = {
    ...chain,
    CONCLAVE_DEPOSITS_ENABLED: 'false',
    CONCLAVE_DEPOSIT_RECOVERY_ENABLED: 'true',
  };
  assert.equal(
    (await checkReadiness(recovery, { target: 'api' })).configurationOk,
    true,
  );
});

void test('redacted reporting never interpolates credentials, URLs, paths or unknown environment names', async () => {
  const marker = randomBytes(16).toString('hex');
  const env = {
    ...base(),
    CONCLAVE_APP_ORIGIN: `https://${marker}.example/private`,
    CONCLAVE_DATABASE_URL: `postgresql://user:${marker}@db.example/fixture?unsafe=${marker}`,
    PPQ_API_KEY: marker,
    CONCLAVE_DATA_KEYS: marker,
    CONCLAVE_RECEIPT_SIGNER_SEED_HEX: marker,
    CONCLAVE_SOLANA_RPC_URL: `https://rpc.example/${marker}`,
    [`NEXT_PUBLIC_PRIVATE_KEY_${marker}`]: marker,
  };
  const output = JSON.stringify(
    await checkReadiness(env, { target: 'launch' }),
  );
  assert.ok(!output.includes(marker));
  assert.ok(!output.includes('postgresql://'));
  assert.ok(!output.includes('https://rpc.example'));
  assert.ok(has(JSON.parse(output), 'PUBLIC_SERVER_CONFIGURATION'));
});

void test('CLI rejects unknown or repeated arguments without reflecting them or connecting', async () => {
  for (const args of [
    ['--remote-check'],
    ['--target=unknown'],
    ['--production', '--production'],
    ['--target=api', '--target=worker'],
  ])
    await assert.rejects(runReadiness(args, {}));
  const child = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      fileURLToPath(new URL('./check-readiness.mjs', import.meta.url)),
      '--remote-secret-value',
    ],
    { env: {}, encoding: 'utf8' },
  );
  assert.equal(child.status, 1);
  assert.ok(!child.stderr.includes('remote-secret-value'));
  assert.equal(child.stdout, '');
});

void test('media activation validates integrated storage configuration without claiming live verification', async () => {
  const disabled = await checkReadiness(enabled(), { target: 'api' });
  assert.equal(disabled.capabilities.studioConfigured, false);
  assert.ok(has(disabled, 'MEDIA_CONFIGURATION', 'pending'));
  const activated = await checkReadiness(
    { ...enabled(), CONCLAVE_MEDIA_ENABLED: 'true' },
    { target: 'api' },
  );
  assert.equal(activated.capabilities.studioConfigured, true);
  assert.ok(has(activated, 'MEDIA_CONFIGURATION', 'pass'));
  assert.notEqual(activated.readiness, 'ready');
  const noKeys = await checkReadiness(
    { ...enabled(), CONCLAVE_MEDIA_ENABLED: 'true', CONCLAVE_DATA_KEYS: '' },
    { target: 'api' },
  );
  assert.equal(noKeys.capabilities.studioConfigured, false);
  assert.ok(has(noKeys, 'MEDIA_CONFIGURATION', 'error'));
  const invalid = await checkReadiness(
    { ...enabled(), CONCLAVE_MEDIA_ENABLED: 'yes' },
    { target: 'api' },
  );
  assert.ok(has(invalid, 'MEDIA_FLAG_INVALID', 'error'));
});

void test('wallet payment activation requires deposit creation and coherent chain configuration', async () => {
  const gated = await checkReadiness(
    {
      ...base(),
      CONCLAVE_DEPOSIT_PAYMENTS_ENABLED: 'true',
    },
    { target: 'api' },
  );
  assert.ok(has(gated, 'DEPOSIT_PAYMENT_GATE'));
  const invalid = await checkReadiness(
    {
      ...base(),
      CONCLAVE_DEPOSIT_PAYMENTS_ENABLED: 'yes',
    },
    { target: 'api' },
  );
  assert.ok(has(invalid, 'DEPOSIT_PAYMENTS_FLAG_INVALID'));
});

void test('launch target cannot exit successfully merely because configuration validation passed', async () => {
  const absent = await runReadiness(['--target=launch'], {});
  assert.equal(absent.exitCode, 1);
  assert.ok(has(absent.report, 'LAUNCH_VERIFICATION', 'pending'));
  assert.notEqual(absent.report.readiness, 'ready');
  const seed = randomBytes(32);
  const validFrom = new Date(Date.now() - 60000).toISOString();
  const validUntil = new Date(Date.now() + 3600000).toISOString();
  const values = {
    ...enabled(),
    CONCLAVE_PASSKEYS_ENABLED: 'true',
    CONCLAVE_CROSSCHECK_ENABLED: 'true',
    CONCLAVE_BRIEF_SYNTHESIS_ENABLED: 'true',
    CONCLAVE_SOLANA_CLUSTER: 'devnet',
    CONCLAVE_SOLANA_RPC_URL: 'https://rpc.example',
    CONCLAVE_TREASURY_WALLET: bs58.encode(randomBytes(32)),
    CONCLAVE_TREASURY_TOKEN_ACCOUNT: bs58.encode(randomBytes(32)),
    CONCLAVE_MAX_DEPOSIT_USD6: '1000000',
    CONCLAVE_DEPOSITS_ENABLED: 'true',
    CONCLAVE_DEPOSIT_PAYMENTS_ENABLED: 'true',
    CONCLAVE_RECEIPT_SIGNER_KEY_ID: 'test-signer',
    CONCLAVE_RECEIPT_SIGNER_EPOCH: '1',
    CONCLAVE_RECEIPT_SIGNER_SEED_HEX: seed.toString('hex'),
    CONCLAVE_RECEIPT_SIGNER_VALID_FROM: validFrom,
    CONCLAVE_RECEIPT_SIGNER_VALID_UNTIL: validUntil,
    CONCLAVE_RECEIPT_TRUSTED_SIGNERS: JSON.stringify([
      {
        keyId: 'test-signer',
        epoch: 1,
        publicKey: receiptPublicKey(seed),
        validFrom,
        validUntil,
        revoked: false,
      },
    ]),
  };
  const configured = await runReadiness(
    ['--target=launch', '--production'],
    values,
  );
  assert.equal(configured.report.configurationOk, true);
  assert.equal(configured.report.readiness, 'external_verification_required');
  assert.equal(configured.exitCode, 2);
  seed.fill(0);
});

void test('Brief generation has an explicit gate and requires paid inference prerequisites', async () => {
  assert.ok(
    has(
      await checkReadiness(base(), { target: 'api' }),
      'BRIEF_SYNTHESIS_GATE',
      'pending',
    ),
  );
  assert.ok(
    has(
      await checkReadiness(
        { ...base(), CONCLAVE_BRIEF_SYNTHESIS_ENABLED: 'true' },
        { target: 'api' },
      ),
      'BRIEF_SYNTHESIS_GATE',
    ),
  );
  assert.ok(
    has(
      await checkReadiness(
        { ...enabled(), CONCLAVE_BRIEF_SYNTHESIS_ENABLED: 'true' },
        { target: 'api' },
      ),
      'BRIEF_SYNTHESIS_GATE',
      'pass',
    ),
  );
  assert.ok(
    has(
      await checkReadiness(
        { ...enabled(), CONCLAVE_BRIEF_SYNTHESIS_ENABLED: 'yes' },
        { target: 'api' },
      ),
      'BRIEF_SYNTHESIS_FLAG_INVALID',
    ),
  );
  assert.ok(
    has(
      await checkReadiness(enabled(), { target: 'launch' }),
      'BRIEF_SYNTHESIS_GATE',
    ),
  );
});

// --- live target: every transport is a fake; nothing reaches a real service.

const expectedGrants = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../deploy/expected-grants.json', import.meta.url)),
    'utf8',
  ),
).roles;
const wallet = bs58.encode(randomBytes(32));
const tokenAccountAddress = bs58.encode(randomBytes(32));
const usdcMint = SOLANA_NETWORKS['mainnet-beta'].usdcMint;
const serviceUrl =
  'postgresql://conclave_api@database.example/fixture?sslmode=verify-full';
const migrationUrl =
  'postgresql://conclave_migrator@database.example/fixture?sslmode=verify-full';
const liveEnv = (extra = {}) => ({
  ...base(),
  CONCLAVE_DATABASE_URL: serviceUrl,
  CONCLAVE_MIGRATION_DATABASE_URL: migrationUrl,
  CONCLAVE_SOLANA_CLUSTER: 'mainnet-beta',
  CONCLAVE_SOLANA_RPC_URL: 'https://rpc.example/key-material',
  CONCLAVE_TREASURY_WALLET: wallet,
  CONCLAVE_TREASURY_TOKEN_ACCOUNT: tokenAccountAddress,
  CONCLAVE_MAX_DEPOSIT_USD6: '1000000',
  ...extra,
});
const tokenAccount = (info = {}, outer = {}) => ({
  owner: TOKEN_PROGRAM,
  executable: false,
  lamports: 2039280,
  space: 165,
  data: {
    program: 'spl-token',
    space: 165,
    parsed: {
      type: 'account',
      info: {
        isNative: false,
        mint: usdcMint,
        owner: wallet,
        state: 'initialized',
        tokenAmount: { amount: '0', decimals: 6, uiAmount: 0 },
        ...info,
      },
    },
  },
  ...outer,
});
function fakeRpc({
  genesis = SOLANA_NETWORKS['mainnet-beta'].genesisHash,
  account = tokenAccount(),
  status = 200,
} = {}) {
  const requests = [];
  const fetcher = async (url, init) => {
    const request = JSON.parse(init.body);
    requests.push({ url, ...request });
    const result =
      request.method === 'getGenesisHash'
        ? genesis
        : { context: { slot: 1 }, value: account };
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
      { status, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetcher, requests };
}
const grantRows = (role) => {
  const grants = expectedGrants[role];
  const tables = [];
  const columns = [];
  for (const [privilege, list] of [
    ['SELECT', grants.select],
    ['INSERT', grants.insert],
    ['DELETE', grants.delete],
  ])
    for (const table_name of list)
      tables.push({ table_name, privilege_type: privilege });
  for (const [table_name, list] of Object.entries(grants.update))
    for (const column_name of list.split(','))
      columns.push({ table_name, column_name, privilege_type: 'UPDATE' });
  return { tables, columns };
};
const serviceSession = (over = {}) => ({
  schema: 'conclave',
  role: 'conclave_api',
  rolsuper: false,
  rolbypassrls: false,
  rolcreaterole: false,
  rolcreatedb: false,
  rolreplication: false,
  can_create: false,
  ssl: true,
  ...over,
});
function fakePool(handlers, log) {
  return {
    async connect() {
      return {
        async query(sql) {
          log.push(sql);
          if (/^(BEGIN READ ONLY|ROLLBACK)$/.test(sql)) return { rows: [] };
          if (sql.includes('FROM pg_roles'))
            return { rows: [handlers.session] };
          if (sql.includes('role_table_grants'))
            return { rows: handlers.tables };
          if (sql.includes('role_column_grants'))
            return { rows: handlers.columns };
          if (sql.includes('FROM schema_migrations'))
            return { rows: handlers.applied };
          if (sql.includes('pg_stat_ssl'))
            return { rows: [handlers.migrationSession] };
          throw new Error('Unexpected query');
        },
        release() {},
      };
    },
    async end() {},
  };
}
async function liveRun({
  rpc = {},
  session = {},
  tables,
  columns,
  mutateApplied,
  migrationSession = { schema: 'conclave', ssl: true },
  env = liveEnv(),
  roles = expectedGrants,
  grantsFile,
} = {}) {
  const files = await migrationFiles();
  const applied = files.map((item) => ({ ...item }));
  mutateApplied?.(applied);
  const rows = grantRows('conclave_api');
  const log = [];
  const pool = fakePool(
    {
      session: serviceSession(session),
      tables: tables ?? rows.tables,
      columns: columns ?? rows.columns,
      applied,
      migrationSession,
    },
    log,
  );
  const transport = fakeRpc(rpc);
  const originalFetch = globalThis.fetch,
    originalConnect = Reflect.get(pg.Pool.prototype, 'connect');
  globalThis.fetch = async () => {
    throw new Error('Unexpected network access');
  };
  pg.Pool.prototype.connect = () => {
    throw new Error('Unexpected database access');
  };
  try {
    const result = await runReadiness(['--target=live'], env, {
      fetcher: transport.fetcher,
      createPool: () => pool,
      expectedGrants: roles,
      grantsFile,
    });
    return { ...result, log, requests: transport.requests };
  } finally {
    globalThis.fetch = originalFetch;
    pg.Pool.prototype.connect = originalConnect;
  }
}
const livePassCodes = [
  'LIVE_RPC_GENESIS',
  'LIVE_TREASURY_ACCOUNT',
  'LIVE_DATABASE_ROLE',
  'LIVE_DATABASE_GRANTS',
  'LIVE_MIGRATIONS',
  'LIVE_DATABASE_SCHEMA',
  'LIVE_DATABASE_TLS',
];

void test('live: a matching cluster, treasury account, migrations, role and TLS pass', async () => {
  const { report, exitCode, log, requests } = await liveRun();
  for (const code of livePassCodes) assert.ok(has(report, code, 'pass'), code);
  assert.equal(report.configurationOk, true);
  assert.equal(report.readiness, 'live_verified');
  assert.equal(report.networkChecksPerformed, true);
  assert.equal(report.databaseChecksPerformed, true);
  assert.equal(exitCode, 0);
  assert.deepEqual(
    requests.map((item) => item.method),
    ['getGenesisHash', 'getAccountInfo'],
  );
  const lookup = requests[1].params;
  assert.equal(lookup[0], tokenAccountAddress);
  assert.deepEqual(lookup[1], { encoding: 'jsonParsed', commitment: 'finalized' });
  // Only reads: every statement is a SELECT or a read-only transaction control.
  for (const sql of log)
    assert.match(sql.trim(), /^(BEGIN READ ONLY|ROLLBACK|SELECT)\b/);
  assert.equal(log.filter((sql) => sql === 'BEGIN READ ONLY').length, 2);
  // Fixed text only: no host, URL, address or key material in the report.
  const text = JSON.stringify(report);
  for (const secret of [
    'rpc.example',
    'key-material',
    'database.example',
    wallet,
    tokenAccountAddress,
  ])
    assert.equal(text.includes(secret), false, secret);
});

void test('live: a genesis hash that does not match the selected cluster fails', async () => {
  const { report, exitCode, requests } = await liveRun({
    rpc: { genesis: SOLANA_NETWORKS.devnet.genesisHash },
  });
  assert.ok(has(report, 'LIVE_RPC_GENESIS'));
  assert.ok(has(report, 'LIVE_TREASURY_ACCOUNT'));
  assert.equal(report.readiness, 'live_verification_failed');
  assert.equal(exitCode, 1);
  // The account is never trusted from a cluster that failed identity.
  assert.deepEqual(
    requests.map((item) => item.method),
    ['getGenesisHash'],
  );
});

void test('live: RPC failures are errors without leaking the endpoint', async () => {
  const { report, exitCode } = await liveRun({ rpc: { status: 503 } });
  assert.ok(has(report, 'LIVE_RPC_GENESIS'));
  assert.equal(exitCode, 1);
  assert.equal(JSON.stringify(report).includes('rpc.example'), false);
});

void test('live: the treasury token account must be the initialized, undelegated account of the treasury wallet and USDC mint', async () => {
  const cases = {
    'wrong owner': tokenAccount({ owner: bs58.encode(randomBytes(32)) }),
    'wrong mint': tokenAccount({ mint: SOLANA_NETWORKS.devnet.usdcMint }),
    'delegate present': tokenAccount({
      delegate: bs58.encode(randomBytes(32)),
      delegatedAmount: { amount: '1', decimals: 6, uiAmount: 0.000001 },
    }),
    'close authority present': tokenAccount({
      closeAuthority: bs58.encode(randomBytes(32)),
    }),
    frozen: tokenAccount({ state: 'frozen' }),
    uninitialized: tokenAccount({ state: 'uninitialized' }),
    'other program': tokenAccount({}, { owner: bs58.encode(randomBytes(32)) }),
    'not a token account': {
      owner: TOKEN_PROGRAM,
      data: { program: 'spl-token', parsed: { type: 'mint', info: {} } },
    },
    missing: null,
  };
  for (const [name, account] of Object.entries(cases)) {
    const { report, exitCode } = await liveRun({ rpc: { account } });
    assert.ok(has(report, 'LIVE_RPC_GENESIS', 'pass'), name);
    assert.ok(has(report, 'LIVE_TREASURY_ACCOUNT'), name);
    assert.equal(exitCode, 1, name);
  }
  assert.deepEqual(
    inspectTreasuryTokenAccount(
      { value: tokenAccount() },
      { owner: wallet, mint: usdcMint },
    ),
    [],
  );
  assert.deepEqual(
    inspectTreasuryTokenAccount(
      { value: tokenAccount({ owner: bs58.encode(randomBytes(32)) }) },
      { owner: wallet, mint: usdcMint },
    ),
    ['OWNER'],
  );
  assert.deepEqual(
    inspectTreasuryTokenAccount(undefined, { owner: wallet, mint: usdcMint }),
    ['FORMAT'],
  );
});

void test('live: applied migrations must equal the files on disk by checksum', async () => {
  const mismatch = await liveRun({
    mutateApplied: (applied) => {
      applied[3].checksum = '0'.repeat(64);
    },
  });
  assert.ok(has(mismatch.report, 'LIVE_MIGRATIONS'));
  assert.equal(mismatch.exitCode, 1);
  const pending = await liveRun({ mutateApplied: (applied) => applied.pop() });
  assert.ok(has(pending.report, 'LIVE_MIGRATIONS'));
  const unknown = await liveRun({
    mutateApplied: (applied) =>
      applied.push({ name: '999-unreviewed.sql', checksum: '1'.repeat(64) }),
  });
  assert.ok(has(unknown.report, 'LIVE_MIGRATIONS'));
  const files = [
    { name: '001-a.sql', checksum: 'a' },
    { name: '002-b.sql', checksum: 'b' },
  ];
  assert.deepEqual(
    migrationDrift(files, [
      { name: '001-a.sql', checksum: 'x' },
      { name: '003-c.sql', checksum: 'c' },
    ]),
    { mismatched: ['001-a.sql'], pending: ['002-b.sql'], unknown: ['003-c.sql'] },
  );
  // The service role cannot read schema_migrations, so the migration URL is required.
  const { CONCLAVE_MIGRATION_DATABASE_URL: _omitted, ...withoutMigration } =
    liveEnv();
  const missing = await liveRun({ env: withoutMigration });
  assert.ok(has(missing.report, 'LIVE_MIGRATIONS'));
  assert.equal(missing.exitCode, 1);
});

void test('live: a superuser, bypass-RLS or schema-creating role fails', async () => {
  for (const session of [
    { rolsuper: true },
    { rolbypassrls: true },
    { rolcreaterole: true },
    { rolcreatedb: true },
    { rolreplication: true },
    { can_create: true },
    { can_create: null },
  ]) {
    const { report, exitCode } = await liveRun({ session });
    assert.ok(has(report, 'LIVE_DATABASE_ROLE'), JSON.stringify(session));
    assert.equal(exitCode, 1);
  }
});

void test('live: privileges outside the expected matrix fail', async () => {
  const rows = grantRows('conclave_api');
  const cases = {
    'extra delete': {
      tables: [...rows.tables, { table_name: 'ledger_entries', privilege_type: 'DELETE' }],
    },
    'table-level update': {
      tables: [...rows.tables, { table_name: 'accounts', privilege_type: 'UPDATE' }],
    },
    truncate: {
      tables: [...rows.tables, { table_name: 'holds', privilege_type: 'TRUNCATE' }],
    },
    'unlisted table': {
      tables: [...rows.tables, { table_name: 'schema_migrations', privilege_type: 'SELECT' }],
    },
    'extra column update': {
      columns: [
        ...rows.columns,
        { table_name: 'ledger_accounts', column_name: 'kind', privilege_type: 'UPDATE' },
      ],
    },
  };
  for (const [name, change] of Object.entries(cases)) {
    const { report, exitCode } = await liveRun(change);
    assert.ok(has(report, 'LIVE_DATABASE_GRANTS'), name);
    assert.equal(exitCode, 1, name);
  }
  const unknownRole = await liveRun({ session: { role: 'conclave_migrator' } });
  assert.ok(has(unknownRole.report, 'LIVE_DATABASE_GRANTS'));
  const unloadable = await liveRun({
    roles: null,
    grantsFile: '/nonexistent/grants.json',
  });
  assert.ok(has(unloadable.report, 'LIVE_DATABASE_GRANTS'));
  assert.deepEqual(unexpectedPrivileges(expectedGrants.conclave_api, rows.tables, rows.columns), []);
  assert.deepEqual(
    unexpectedPrivileges(
      expectedGrants.conclave_api,
      [{ table_name: 'accounts', privilege_type: 'DELETE' }],
      [],
    ),
    ['DELETE accounts'],
  );
});

void test('live: the schema and TLS must be exactly as expected', async () => {
  const schema = await liveRun({ session: { schema: 'public' } });
  assert.ok(has(schema.report, 'LIVE_DATABASE_SCHEMA'));
  const migrationSchema = await liveRun({
    migrationSession: { schema: 'public', ssl: true },
  });
  assert.ok(has(migrationSchema.report, 'LIVE_DATABASE_SCHEMA'));
  const plain = await liveRun({ session: { ssl: false } });
  assert.ok(has(plain.report, 'LIVE_DATABASE_TLS'));
  assert.equal(plain.exitCode, 1);
  const migrationPlain = await liveRun({
    migrationSession: { schema: 'conclave', ssl: false },
  });
  assert.ok(has(migrationPlain.report, 'LIVE_DATABASE_TLS'));
  // Loopback development databases need no certificate.
  const local = await liveRun({
    session: { ssl: false },
    migrationSession: { schema: 'conclave', ssl: false },
    env: liveEnv({
      CONCLAVE_DATABASE_URL: 'postgresql://conclave_api@127.0.0.1/fixture',
      CONCLAVE_MIGRATION_DATABASE_URL:
        'postgresql://conclave_migrator@127.0.0.1/fixture',
    }),
  });
  assert.ok(has(local.report, 'LIVE_DATABASE_TLS', 'pass'));
  // A different expected schema is selectable.
  const customFiles = await migrationFiles();
  const custom = await runReadiness(
    ['--target=live', '--schema=other_schema'],
    liveEnv(),
    {
      fetcher: fakeRpc().fetcher,
      createPool: () =>
        fakePool(
          {
            session: serviceSession({ schema: 'other_schema' }),
            ...grantRows('conclave_api'),
            applied: customFiles,
            migrationSession: { schema: 'other_schema', ssl: true },
          },
          [],
        ),
      expectedGrants,
    },
  );
  assert.ok(has(custom.report, 'LIVE_DATABASE_SCHEMA', 'pass'));
});

void test('live: an unreachable database is an error and other targets never use the transports', async () => {
  const { report, exitCode } = await runReadiness(['--target=live'], liveEnv(), {
    fetcher: fakeRpc().fetcher,
    createPool: () => {
      throw new Error('refused');
    },
    expectedGrants,
  });
  assert.ok(has(report, 'LIVE_DATABASE_CONNECT'));
  assert.ok(has(report, 'LIVE_MIGRATIONS'));
  assert.equal(exitCode, 1);
  let calls = 0;
  const trap = {
    fetcher: async () => {
      calls++;
      throw new Error('Unexpected');
    },
    createPool: () => {
      calls++;
      throw new Error('Unexpected');
    },
  };
  for (const target of ['api', 'worker', 'maintenance', 'launch'])
    await runReadiness([`--target=${target}`], liveEnv(), trap);
  assert.equal(calls, 0);
  const preview = await runReadiness([], {}, trap);
  assert.equal(preview.report.networkChecksPerformed, false);
  assert.equal(preview.report.databaseChecksPerformed, false);
});

void test('live: invalid configuration fails closed without connecting', async () => {
  let calls = 0;
  const trap = {
    fetcher: async () => {
      calls++;
      throw new Error('Unexpected');
    },
    createPool: () => {
      calls++;
      throw new Error('Unexpected');
    },
    expectedGrants,
  };
  const { report, exitCode } = await runReadiness(['--target=live'], {}, trap);
  assert.equal(exitCode, 1);
  assert.ok(has(report, 'LIVE_RPC_GENESIS'));
  assert.ok(has(report, 'LIVE_TREASURY_ACCOUNT'));
  assert.ok(has(report, 'LIVE_DATABASE_CONNECT'));
  assert.equal(report.networkChecksPerformed, false);
  assert.equal(calls, 0);
});

void test('live: only supported flags are accepted', async () => {
  await assert.rejects(runReadiness(['--target=live', '--schema=Bad-Name'], {}));
  await assert.rejects(runReadiness(['--schema=conclave'], {}));
  await assert.rejects(runReadiness(['--target=live', '--target=api'], {}));
  await assert.rejects(runReadiness(['--live'], {}));
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      fileURLToPath(new URL('./check-readiness.mjs', import.meta.url)),
      '--target=live',
      '--bogus',
    ],
    { encoding: 'utf8', env: {} },
  );
  assert.equal(result.status, 1);
});

// --- deploy sequence: arguments, ordering and step isolation (nothing is executed).

const webFile = (path) =>
  fileURLToPath(new URL(`../${path}`, import.meta.url));
const environments = JSON.parse(
  readFileSync(webFile('deploy/environments.json'), 'utf8'),
).environments;
const packageScripts = JSON.parse(
  readFileSync(webFile('package.json'), 'utf8'),
).scripts;
const suiteFiles = databaseSuiteFiles(
  readFileSync(webFile('scripts/check-database.mjs'), 'utf8'),
);
const suites = pureSuites(packageScripts, suiteFiles);
const planFor = (environment, mode) =>
  buildPlan({ environment, mode }, { environments, pureSuites: suites });

void test('deploy: exactly one environment and one mode are accepted', () => {
  assert.deepEqual(parseArguments(['--env=staging', '--plan']), {
    environment: 'staging',
    mode: 'plan',
    manifestOut: null,
    keepMirror: false,
    allowDirty: false,
  });
  assert.equal(parseArguments(['--env=production', '--confirm']).mode, 'confirm');
  assert.equal(
    parseArguments(['--env=staging', '--dry-run', '--allow-dirty']).allowDirty,
    true,
  );
  for (const argv of [
    [],
    ['--plan'],
    ['--env=staging'],
    ['--env=staging', '--plan', '--confirm'],
    ['--env=staging', '--dry-run', '--confirm'],
    ['--env=staging', '--confirm', '--allow-dirty'],
    ['--env=staging', '--env=production', '--plan'],
    ['--env=Staging', '--plan'],
    ['--env=staging', '--plan', '--plan'],
    ['--env=staging', '--plan', '--force'],
    ['--env=staging', '--plan', 'extra'],
  ])
    assert.throws(() => parseArguments(argv), /Usage/, argv.join(' '));
});

void test('deploy: the plan runs install, checks, tests, build, migrate, live check, then deploy', () => {
  const ids = planFor('production', 'confirm').map((step) => step.id);
  assert.deepEqual(ids, [
    'environment',
    'source',
    'mirror',
    'install',
    'typecheck',
    'lint',
    'tests-pure',
    'tests-database',
    'build',
    'tests-bundle',
    'digest',
    'migrate',
    'live-check',
    'deploy',
    'manifest',
  ]);
  const plan = planFor('production', 'confirm');
  const command = (id) => plan.find((step) => step.id === id).commands;
  assert.deepEqual(command('install'), [['pnpm', 'install', '--frozen-lockfile']]);
  assert.deepEqual(command('tests-database'), [['pnpm', 'test:database']]);
  assert.deepEqual(command('build'), [['pnpm', 'build']]);
  assert.ok(command('migrate')[0].includes('scripts/migrate.mjs'));
  assert.deepEqual(command('live-check')[0].slice(-3), [
    '--target=live',
    '--production',
    '--schema=conclave',
  ]);
  assert.deepEqual(command('deploy')[0].slice(0, 6), [
    'pnpm',
    'exec',
    'wrangler',
    'deploy',
    '--config',
    'dist/server/wrangler.json',
  ]);
  assert.ok(!planFor('staging', 'plan').find((s) => s.id === 'live-check').commands[0].includes('--production'));
  assert.throws(() => planFor('unknown', 'plan'));
});

void test('deploy: dry-run skips migrations and the deploy; only confirm deploys', () => {
  const plan = planFor('staging', 'dry-run');
  const ran = (mode) => plan.filter((step) => runsIn(step, mode)).map((s) => s.id);
  assert.equal(ran('plan').length, 0);
  assert.ok(!ran('dry-run').includes('migrate'));
  assert.ok(!ran('dry-run').includes('deploy'));
  for (const id of ['install', 'tests-pure', 'tests-database', 'build', 'live-check'])
    assert.ok(ran('dry-run').includes(id), id);
  assert.ok(ran('confirm').includes('migrate'));
  assert.equal(ran('confirm').at(-2), 'deploy');
  // The deploy is the only step that can follow a failure-free live check.
  assert.ok(ran('confirm').indexOf('live-check') < ran('confirm').indexOf('deploy'));
  assert.ok(ran('confirm').indexOf('migrate') < ran('confirm').indexOf('live-check'));
});

void test('deploy: pure suites exclude the database suites, test:database and the bundle runtime check', () => {
  assert.ok(suites.includes('test:readiness'));
  assert.ok(suites.includes('test:monitor'));
  assert.ok(suites.includes('test:solana'));
  for (const name of [
    'test:database',
    'test:runtime',
    'test:ledger',
    'test:service',
    'test:routes',
    'test:reconciliation',
  ])
    assert.equal(suites.includes(name), false, name);
  for (const name of suites) assert.ok(packageScripts[name], name);
  assert.ok(suiteFiles.has('check-ledger.mjs'));
});

void test('deploy: each step receives only the variables it needs', () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/home/operator',
    PPQ_API_KEY: 'provider',
    CONCLAVE_DATABASE_URL: 'service',
    CONCLAVE_MIGRATION_DATABASE_URL: 'migration',
    CONCLAVE_TEST_DATABASE_URL: 'test',
    CONCLAVE_TREASURY_WALLET: 'wallet',
    CLOUDFLARE_API_TOKEN: 'cloudflare',
    UNRELATED: 'x',
  };
  assert.deepEqual(Object.keys(stepEnvironment('build', env)).sort(), ['HOME', 'PATH', 'TZ']);
  assert.equal(stepEnvironment('test', env).CONCLAVE_TEST_DATABASE_URL, 'test');
  for (const kind of ['build', 'test']) {
    const given = stepEnvironment(kind, env);
    for (const name of ['PPQ_API_KEY', 'CONCLAVE_DATABASE_URL', 'CLOUDFLARE_API_TOKEN', 'UNRELATED'])
      assert.equal(name in given, false, `${kind} ${name}`);
  }
  const migrate = stepEnvironment('migrate', env);
  assert.equal(migrate.CONCLAVE_DATABASE_URL, 'migration');
  assert.equal('PPQ_API_KEY' in migrate, false);
  const liveStep = stepEnvironment('live', env);
  assert.equal(liveStep.PPQ_API_KEY, 'provider');
  assert.equal(liveStep.CONCLAVE_MIGRATION_DATABASE_URL, 'migration');
  assert.equal('CLOUDFLARE_API_TOKEN' in liveStep, false);
  assert.deepEqual(
    Object.keys(stepEnvironment('deploy', env)).sort(),
    ['CLOUDFLARE_API_TOKEN', 'HOME', 'PATH', 'TZ'],
  );
  assert.equal(stepEnvironment('build', { TZ: 'America/New_York' }).TZ, 'UTC');
  assert.throws(() => stepEnvironment('other', env));
});

void test('deploy: the environment step reports names only and enforces the expected cluster', () => {
  const staging = environments.staging;
  const complete = Object.fromEntries(
    [
      ...staging.requiredEnvironment.worker,
      ...staging.requiredEnvironment.operator,
    ].map((name) => [name, 'value-that-must-not-be-reported']),
  );
  complete.CONCLAVE_SOLANA_CLUSTER = 'devnet';
  assert.deepEqual(checkEnvironment(staging, complete, 'dry-run'), []);
  // The worker name placeholder only blocks a real deploy.
  assert.equal(checkEnvironment(staging, complete, 'confirm').length, 1);
  const { PPQ_API_KEY: _omitted, ...partial } = complete;
  const missing = checkEnvironment(staging, partial, 'dry-run');
  assert.equal(missing.length, 1);
  assert.match(missing[0], /PPQ_API_KEY/);
  const wrong = checkEnvironment(
    staging,
    { ...complete, CONCLAVE_SOLANA_CLUSTER: 'mainnet-beta' },
    'dry-run',
  );
  assert.equal(wrong.length, 1);
  for (const problem of [...missing, ...wrong])
    assert.equal(problem.includes('value-that-must-not-be-reported'), false);
});

void test('deploy: the manifest file lists names, clusters and schema only', () => {
  const example = readFileSync(webFile('.env.example'), 'utf8');
  assert.deepEqual(Object.keys(environments).sort(), ['production', 'staging']);
  assert.equal(environments.staging.expectedCluster, 'devnet');
  assert.equal(environments.production.expectedCluster, 'mainnet-beta');
  assert.equal(environments.production.production, true);
  for (const environment of Object.values(environments)) {
    assert.equal(environment.databaseSchema, 'conclave');
    assert.match(environment.workerName, /^REPLACE_WITH_/);
    for (const name of environment.requiredEnvironment.worker) {
      assert.match(name, /^[A-Z][A-Z0-9_]*$/);
      assert.ok(example.includes(`${name}=`), name);
    }
    for (const name of environment.requiredEnvironment.operator)
      assert.match(name, /^[A-Z][A-Z0-9_]*$/);
  }
  const text = readFileSync(webFile('deploy/environments.json'), 'utf8');
  assert.equal(/postgres(ql)?:\/\/|https?:\/\//i.test(text), false);
});

void test('deploy: the build digest is stable and sensitive to content and names', () => {
  const directory = mkdtempSync(join(tmpdir(), 'digest-test-'));
  try {
    mkdirSync(join(directory, 'server'));
    writeFileSync(join(directory, 'server/wrangler.json'), '{}');
    writeFileSync(join(directory, 'index.js'), 'a');
    const first = treeDigest(directory);
    assert.equal(first.files, 2);
    assert.equal(treeDigest(directory).sha256, first.sha256);
    writeFileSync(join(directory, 'index.js'), 'b');
    assert.notEqual(treeDigest(directory).sha256, first.sha256);
    writeFileSync(join(directory, 'index.js'), 'a');
    writeFileSync(join(directory, 'extra.js'), '');
    assert.notEqual(treeDigest(directory).sha256, first.sha256);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test('deploy: --plan prints the ordered steps and exits 0 without running anything', () => {
  const script = webFile('deploy/deploy.mjs');
  const result = spawnSync(process.execPath, [script, '--env=staging', '--plan'], {
    encoding: 'utf8',
    env: {},
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.schema, 'conclave-deploy-plan-v1');
  assert.equal(plan.environment, 'staging');
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const order = plan.steps.map((step) => step.id);
  for (const [before, after] of [
    ['install', 'typecheck'],
    ['typecheck', 'tests-pure'],
    ['tests-database', 'build'],
    ['build', 'migrate'],
    ['migrate', 'live-check'],
    ['live-check', 'deploy'],
  ])
    assert.ok(order.indexOf(before) < order.indexOf(after), `${before} < ${after}`);
  assert.equal(byId.get('migrate').runsInDryRun, false);
  assert.equal(byId.get('deploy').runsInDryRun, false);
  assert.equal(byId.get('deploy').runsOnConfirm, true);
  assert.equal(byId.get('build').runsInDryRun, true);
  assert.ok(byId.get('tests-pure').commands.includes('pnpm test:readiness'));
  assert.ok(byId.get('deploy').commands[0].includes('REPLACE_WITH_STAGING_WORKER_NAME'));
  assert.equal(/postgres|https?:|Users/i.test(result.stdout), false);
  for (const argv of [[], ['--env=staging'], ['--env=nope', '--plan'], ['--env=staging', '--plan', '--confirm']]) {
    const rejected = spawnSync(process.execPath, [script, ...argv], {
      encoding: 'utf8',
      env: {},
    });
    assert.equal(rejected.status, 1, argv.join(' '));
    assert.equal(rejected.stdout, '');
  }
});

void test('production readiness fails without the per-account overage breaker and passes with it', async () => {
  const values = enabled();
  delete values.CONCLAVE_MAX_ACCOUNT_OVERAGE_USD6;
  const missing = await checkReadiness(values, { target: 'api', production: true });
  assert.ok(has(missing.report ?? missing, 'PRODUCTION_OVERAGE_BREAKER', 'error'));
  assert.equal(missing.configurationOk, false);
  const invalid = await checkReadiness(
    { ...values, CONCLAVE_MAX_ACCOUNT_OVERAGE_USD6: '0' },
    { target: 'api', production: true },
  );
  assert.equal(invalid.configurationOk, false);
  const configured = await checkReadiness(enabled(), { target: 'api', production: true });
  assert.ok(has(configured, 'PRODUCTION_OVERAGE_BREAKER', 'pass'));
  const local = await checkReadiness(values, { target: 'api' });
  assert.equal(has(local, 'PRODUCTION_OVERAGE_BREAKER'), false);
});
