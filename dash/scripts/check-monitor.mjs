import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrationFiles } from './check-readiness.mjs';
import {
  alertIds,
  loadAlertConfig,
  parseAlertConfig,
  runMonitor,
} from './monitor.mjs';

const read = (path) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const rawConfig = () => JSON.parse(read('../deploy/alerts.json'));
const monitorUrl = 'postgresql://conclave_maintenance@database.example/fixture';
const migrationUrl = 'postgresql://conclave_migrator@database.example/fixture';
const env = (extra = {}) => ({
  CONCLAVE_MONITOR_DATABASE_URL: monitorUrl,
  CONCLAVE_MIGRATION_DATABASE_URL: migrationUrl,
  ...extra,
});

/** A fake pool: every alert query answers with the value configured for its marker. */
function fakePools({ values = {}, failing = [], applied } = {}) {
  const log = [];
  const pools = new Map();
  const make = (url) => {
    const pool = {
      async connect() {
        return {
          async query(sql, parameters) {
            log.push({ url, sql, parameters });
            if (/^(BEGIN READ ONLY|ROLLBACK)$/.test(sql)) return { rows: [] };
            const marker = /\/\* monitor:(\w+) \*\//.exec(sql)?.[1];
            if (marker) {
              if (failing.includes(marker))
                throw new Error('relation does not exist');
              return { rows: [{ value: values[marker] ?? '0' }] };
            }
            if (sql.includes('FROM schema_migrations'))
              return { rows: applied };
            throw new Error('Unexpected query');
          },
          release() {},
        };
      },
      async end() {},
    };
    pools.set(url, pool);
    return pool;
  };
  return { createPool: make, log };
}

async function evaluate(options = {}, environment = env()) {
  const files = await migrationFiles();
  const { createPool, log } = fakePools({
    applied: files.map((item) => ({ ...item })),
    ...options,
  });
  const result = await runMonitor(environment, {
    config: options.config ?? (await loadAlertConfig()),
    createPool,
    now: () => new Date('2026-10-10T12:00:00Z'),
  });
  return { ...result, log };
}
const find = (result, id) => result.alerts.find((item) => item.alert === id);

void test('committed thresholds parse and describe exactly the known alerts', async () => {
  const config = await loadAlertConfig();
  assert.deepEqual(Object.keys(config).sort(), [...alertIds].sort());
  assert.equal(config.uncaptured_overage.parameters.windowHours, 24);
  const raw = rawConfig();
  assert.equal(raw.pages, 'the operator');
  // The README catalogue documents every alert by id.
  const readme = read('../deploy/README.md');
  for (const id of alertIds) assert.ok(readme.includes(`\`${id}\``), id);
});

void test('no alerts: nothing is printed and the exit code is zero', async () => {
  const result = await evaluate();
  assert.deepEqual(result.alerts, []);
  assert.equal(result.exitCode, 0);
});

void test('a warning threshold alerts without paging', async () => {
  const result = await evaluate({
    values: { holds_stuck_reconciliation: '1', uncaptured_overage: '1' },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(find(result, 'holds_stuck_reconciliation').severity, 'warning');
  assert.equal(find(result, 'uncaptured_overage').severity, 'warning');
  assert.equal(result.alerts.length, 2);
});

void test('each critical threshold exits 2 and reports aggregate values only', async () => {
  const config = await loadAlertConfig();
  const critical = {
    uncaptured_overage: '1000000',
    holds_stuck_reconciliation: '5',
    rate_limit_storm: '3',
    deposit_intents_expired: '50',
    token_deposit_intents_expired: '50',
    jobs_stuck_running: '5',
    burn_reserve_drift: '1',
  };
  for (const [id, value] of Object.entries(critical)) {
    const result = await evaluate({ values: { [id]: value } });
    assert.equal(result.exitCode, 2, id);
    assert.deepEqual(
      result.alerts.map((item) => [item.alert, item.severity, item.value]),
      [[id, 'critical', value]],
    );
    assert.equal(config[id].critical.toString(), value);
  }
  // One below the threshold stays a warning (or silent).
  const below = await evaluate({ values: { holds_stuck_reconciliation: '4' } });
  assert.equal(below.exitCode, 0);
  assert.equal(find(below, 'holds_stuck_reconciliation').severity, 'warning');
  const quiet = await evaluate({ values: { burn_reserve_drift: '0' } });
  assert.equal(quiet.alerts.length, 0);
  // Output is one flat JSON object per alert with fixed keys.
  const line = JSON.parse(
    JSON.stringify(
      (await evaluate({ values: { jobs_stuck_running: '9' } })).alerts[0],
    ),
  );
  assert.deepEqual(Object.keys(line).sort(), [
    'alert',
    'checkedAt',
    'critical',
    'severity',
    'value',
    'warn',
  ]);
  assert.equal(line.checkedAt, '2026-10-10T12:00:00.000Z');
});

void test('migration checksum drift is critical: mismatch, missing and unknown migrations', async () => {
  const files = await migrationFiles();
  const mismatch = files.map((item) => ({ ...item }));
  mismatch[2].checksum = '0'.repeat(64);
  const changed = await evaluate({ applied: mismatch });
  assert.equal(changed.exitCode, 2);
  assert.equal(find(changed, 'migration_checksum_drift').value, '1');
  const missing = await evaluate({ applied: files.slice(0, -2) });
  assert.equal(find(missing, 'migration_checksum_drift').value, '2');
  const extra = await evaluate({
    applied: [...files, { name: '999-unreviewed.sql', checksum: 'a'.repeat(64) }],
  });
  assert.equal(extra.exitCode, 2);
  const clean = await evaluate({ applied: files });
  assert.equal(find(clean, 'migration_checksum_drift'), undefined);
  // Without the migration connection the check is reported, not skipped silently.
  const { CONCLAVE_MIGRATION_DATABASE_URL: _omitted, ...withoutMigration } =
    env();
  const unchecked = await evaluate({}, withoutMigration);
  assert.equal(unchecked.exitCode, 0);
  assert.deepEqual(
    [
      find(unchecked, 'migration_checksum_drift').severity,
      find(unchecked, 'migration_checksum_drift').reason,
    ],
    ['warning', 'unchecked'],
  );
});

void test('a failing check is a warning and the other checks still run', async () => {
  const result = await evaluate({
    failing: ['deposit_intents_expired'],
    values: { burn_reserve_drift: '7' },
  });
  assert.deepEqual(find(result, 'deposit_intents_expired'), {
    alert: 'deposit_intents_expired',
    severity: 'warning',
    checkedAt: '2026-10-10T12:00:00.000Z',
    reason: 'check_failed',
  });
  assert.equal(find(result, 'burn_reserve_drift').severity, 'critical');
  assert.equal(result.exitCode, 2);
  const quiet = await evaluate({ failing: ['deposit_intents_expired'] });
  assert.equal(quiet.exitCode, 0);
});

void test('every statement is read-only and parameterised', async () => {
  const result = await evaluate();
  assert.ok(result.log.length > 8);
  for (const { sql, parameters } of result.log) {
    assert.match(
      sql.replace(/\/\*.*?\*\//, '').trim(),
      /^(BEGIN READ ONLY|ROLLBACK|SELECT)\b/,
    );
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP)\b/);
    for (const value of parameters ?? [])
      assert.ok(Number.isSafeInteger(value), 'thresholds are bound integers');
  }
  // The migration table is read only through the migration connection.
  for (const entry of result.log) {
    if (entry.sql.includes('schema_migrations'))
      assert.equal(entry.url, migrationUrl);
    if (entry.sql.includes('monitor:')) assert.equal(entry.url, monitorUrl);
  }
});

void test('configured parameters reach the queries and disabled alerts are skipped', async () => {
  const raw = rawConfig();
  raw.alerts.holds_stuck_reconciliation.olderThanMinutes = 45;
  raw.alerts.rate_limit_storm.enabled = false;
  const config = parseAlertConfig(JSON.stringify(raw));
  const result = await evaluate({ config });
  const stuck = result.log.find((entry) =>
    entry.sql.includes('monitor:holds_stuck_reconciliation'),
  );
  assert.deepEqual(stuck.parameters, [45]);
  assert.equal(
    result.log.some((entry) => entry.sql.includes('monitor:rate_limit_storm')),
    false,
  );
});

void test('invalid alert configuration is rejected', () => {
  const mutate = (change) => {
    const raw = rawConfig();
    change(raw);
    return JSON.stringify(raw);
  };
  for (const change of [
    (raw) => delete raw.alerts.jobs_stuck_running,
    (raw) => (raw.alerts.unknown_alert = { warn: 1 }),
    (raw) => (raw.alerts.jobs_stuck_running.warn = 9),
    (raw) => (raw.alerts.jobs_stuck_running.warn = -1),
    (raw) => (raw.alerts.jobs_stuck_running.critical = '1.5'),
    (raw) => (raw.alerts.jobs_stuck_running.graceMinutes = 0),
    (raw) => delete raw.alerts.jobs_stuck_running.graceMinutes,
    (raw) => (raw.alerts.jobs_stuck_running.extra = true),
    (raw) => (raw.alerts.jobs_stuck_running.enabled = 'yes'),
    (raw) => (raw.schema = 'other'),
  ])
    assert.throws(() => parseAlertConfig(mutate(change)));
  assert.throws(() => parseAlertConfig('{'));
  assert.doesNotThrow(() => parseAlertConfig(JSON.stringify(rawConfig())));
});

void test('a monitoring database URL is required and the CLI hides configuration', async () => {
  await assert.rejects(runMonitor({}, { config: await loadAlertConfig() }));
  const script = fileURLToPath(new URL('./monitor.mjs', import.meta.url));
  for (const args of [[], ['--bogus']]) {
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', script, ...args],
      { encoding: 'utf8', env: {} },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Monitoring could not run/);
  }
});
