import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDatabase } from '../server/db/database.ts';
import { migrationDrift, migrationFiles } from './check-readiness.mjs';

const defaultConfig = fileURLToPath(
  new URL('../deploy/alerts.json', import.meta.url),
);
const integer = /^(0|[1-9][0-9]{0,17})$/;

/**
 * Alert registry. Each alert measures one non-negative integer with read-only
 * SQL and fires at the highest configured threshold it reaches (value >=
 * threshold). Queries return aggregates only: no account, prompt, address or
 * provider material. The leading comment names the alert for logs and tests.
 * `parameters` are the bounded integers read from deploy/alerts.json.
 */
const minutes = { minimum: 1, maximum: 10_080 };
const alerts = {
  uncaptured_overage: {
    parameters: { windowHours: { minimum: 1, maximum: 720 } },
    query: (p) => ({
      sql: `/* monitor:uncaptured_overage */ SELECT COALESCE(sum(overage_usd6),0)::text AS value
        FROM hold_reconciliations
        WHERE overage_usd6 IS NOT NULL AND created_at >= now() - make_interval(hours => $1::int)`,
      values: [p.windowHours],
    }),
  },
  holds_stuck_reconciliation: {
    parameters: { olderThanMinutes: minutes },
    query: (p) => ({
      sql: `/* monitor:holds_stuck_reconciliation */ SELECT count(*)::text AS value FROM holds
        WHERE state='reconciliation_pending' AND updated_at < now() - make_interval(mins => $1::int)`,
      values: [p.olderThanMinutes],
    }),
  },
  rate_limit_storm: {
    parameters: {
      windowMinutes: minutes,
      bucketHitsAtLeast: { minimum: 1, maximum: 1_000_000 },
    },
    query: (p) => ({
      sql: `/* monitor:rate_limit_storm */ SELECT count(*)::text AS value FROM rate_limits
        WHERE window_start >= now() - make_interval(mins => $1::int) AND hits >= $2::int`,
      values: [p.windowMinutes, p.bucketHitsAtLeast],
    }),
  },
  deposit_intents_expired: {
    parameters: { graceMinutes: minutes },
    query: (p) => ({
      sql: `/* monitor:deposit_intents_expired */ SELECT count(*)::text AS value FROM deposit_intents
        WHERE state='awaiting_payment' AND expires_at < now() - make_interval(mins => $1::int)`,
      values: [p.graceMinutes],
    }),
  },
  token_deposit_intents_expired: {
    parameters: { graceMinutes: minutes },
    query: (p) => ({
      sql: `/* monitor:token_deposit_intents_expired */ SELECT count(*)::text AS value FROM token_deposit_intents
        WHERE state='pending' AND expires_at < now() - make_interval(mins => $1::int)`,
      values: [p.graceMinutes],
    }),
  },
  jobs_stuck_running: {
    parameters: { graceMinutes: minutes },
    query: (p) => ({
      sql: `/* monitor:jobs_stuck_running */ SELECT (
          (SELECT count(*) FROM jobs WHERE state='running'
            AND lease_expires_at < now() - make_interval(mins => $1::int))
        + (SELECT count(*) FROM media_jobs WHERE state IN ('dispatching','polling')
            AND lease_expires_at < now() - make_interval(mins => $1::int))
        + (SELECT count(*) FROM media_ingests WHERE state='processing'
            AND lease_expires_at < now() - make_interval(mins => $1::int))
        )::text AS value`,
      values: [p.graceMinutes],
    }),
  },
  burn_reserve_drift: {
    parameters: {},
    // The reserve balance must equal accrued fee shares minus executed burns.
    query: () => ({
      sql: `/* monitor:burn_reserve_drift */ SELECT abs(
          COALESCE((SELECT balance_usd6 FROM ledger_accounts WHERE kind='burn_reserve' AND owner_id IS NULL),0)
          - (COALESCE((SELECT sum(burn_reserve_usd6) FROM hold_platform_fees),0)
             - CASE WHEN to_regclass('token_burns') IS NULL THEN 0
                    ELSE COALESCE((SELECT sum(spent_usd6) FROM token_burns),0) END)
        )::text AS value`,
      values: [],
    }),
  },
  migration_checksum_drift: {
    parameters: {},
    connection: 'migration',
  },
};
export const alertIds = Object.freeze(Object.keys(alerts));

function threshold(value, name) {
  if (value === null) return null;
  if (
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === 'string' && integer.test(value))
  )
    return BigInt(value);
  throw new Error(`Invalid ${name} threshold.`);
}

/** Validates deploy/alerts.json strictly: unknown keys, missing alerts and unordered thresholds are errors. */
export function parseAlertConfig(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('The alert configuration is not valid JSON.');
  }
  if (
    raw?.schema !== 'conclave-alerts-v1' ||
    typeof raw.alerts !== 'object' ||
    raw.alerts === null ||
    Array.isArray(raw.alerts)
  )
    throw new Error('The alert configuration has an unsupported shape.');
  const unknown = Object.keys(raw.alerts).filter((id) => !alerts[id]);
  const missing = alertIds.filter((id) => !raw.alerts[id]);
  if (unknown.length || missing.length)
    throw new Error('The alert configuration must list exactly the known alerts.');
  const parsed = {};
  for (const id of alertIds) {
    const entry = raw.alerts[id];
    const allowed = new Set([
      'description',
      'enabled',
      'warn',
      'critical',
      ...Object.keys(alerts[id].parameters),
    ]);
    if (
      typeof entry !== 'object' ||
      entry === null ||
      Object.keys(entry).some((key) => !allowed.has(key)) ||
      (entry.enabled !== undefined && typeof entry.enabled !== 'boolean')
    )
      throw new Error(`Invalid configuration for alert ${id}.`);
    const parameters = {};
    for (const [name, bounds] of Object.entries(alerts[id].parameters)) {
      const value = entry[name];
      if (
        !Number.isSafeInteger(value) ||
        value < bounds.minimum ||
        value > bounds.maximum
      )
        throw new Error(`Invalid ${name} for alert ${id}.`);
      parameters[name] = value;
    }
    const warn = threshold(entry.warn ?? null, `${id} warn`);
    const critical = threshold(entry.critical ?? null, `${id} critical`);
    if (warn !== null && critical !== null && warn > critical)
      throw new Error(`The ${id} warn threshold exceeds its critical threshold.`);
    parsed[id] = {
      enabled: entry.enabled !== false,
      warn,
      critical,
      parameters,
    };
  }
  return parsed;
}

export async function loadAlertConfig(path = defaultConfig) {
  return parseAlertConfig(await readFile(path, 'utf8'));
}

async function readOnly(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    try {
      return await work(client);
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    client.release();
  }
}

const severityOf = (value, setting) =>
  setting.critical !== null && value >= setting.critical
    ? 'critical'
    : setting.warn !== null && value >= setting.warn
      ? 'warning'
      : null;

/**
 * Evaluates every enabled alert against read-only SQL. Returns the alerts
 * that fired (one object each) and the exit code: 2 when any is critical.
 * A check that cannot run is reported as a warning rather than skipped
 * silently. The monitor connection is CONCLAVE_MONITOR_DATABASE_URL, else
 * CONCLAVE_DATABASE_URL; the migration check needs
 * CONCLAVE_MIGRATION_DATABASE_URL because the service roles cannot read
 * schema_migrations.
 */
export async function runMonitor(env, options = {}) {
  const config = options.config ?? (await loadAlertConfig());
  const createPool = options.createPool ?? ((url) => createDatabase(url, 1));
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const url = env.CONCLAVE_MONITOR_DATABASE_URL || env.CONCLAVE_DATABASE_URL;
  if (!url) throw new Error('A monitoring database URL is required.');
  const fired = [];
  const report = (id, value) => {
    const setting = config[id];
    const severity = severityOf(value, setting);
    if (severity)
      fired.push({
        alert: id,
        severity,
        checkedAt,
        value: value.toString(),
        warn: setting.warn?.toString() ?? null,
        critical: setting.critical?.toString() ?? null,
      });
  };
  const failed = (id, reason = 'check_failed') =>
    fired.push({ alert: id, severity: 'warning', checkedAt, reason });

  const pool = createPool(url);
  try {
    await readOnly(pool, async (client) => {
      for (const id of alertIds) {
        if (!config[id].enabled || alerts[id].connection) continue;
        try {
          const { sql, values } = alerts[id].query(config[id].parameters);
          const row = (await client.query(sql, values)).rows[0];
          if (!integer.test(String(row?.value))) throw new Error();
          report(id, BigInt(row.value));
        } catch {
          // A failed statement aborts the read-only transaction; recover so
          // the remaining alerts still run.
          failed(id);
          await client.query('ROLLBACK');
          await client.query('BEGIN READ ONLY');
        }
      }
    });
  } finally {
    await pool.end();
  }

  const id = 'migration_checksum_drift';
  if (config[id].enabled) {
    if (!env.CONCLAVE_MIGRATION_DATABASE_URL) failed(id, 'unchecked');
    else {
      const migrationPool = createPool(env.CONCLAVE_MIGRATION_DATABASE_URL);
      try {
        const files = await migrationFiles(options.migrationsDirectory);
        const applied = await readOnly(migrationPool, async (client) =>
          (
            await client.query(
              'SELECT name, checksum FROM schema_migrations ORDER BY name',
            )
          ).rows,
        );
        const drift = migrationDrift(files, applied);
        report(
          id,
          BigInt(
            drift.mismatched.length + drift.pending.length + drift.unknown.length,
          ),
        );
      } catch {
        failed(id);
      } finally {
        await migrationPool.end();
      }
    }
  }
  return {
    alerts: fired,
    exitCode: fired.some((item) => item.severity === 'critical') ? 2 : 0,
  };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const args = process.argv.slice(2);
    if (
      args.length > 1 ||
      (args.length === 1 && !args[0].startsWith('--config='))
    )
      throw new Error();
    const config = await loadAlertConfig(
      args.length ? resolve(args[0].slice(9)) : defaultConfig,
    );
    const { alerts: fired, exitCode } = await runMonitor(process.env, {
      config,
    });
    for (const alert of fired) process.stdout.write(JSON.stringify(alert) + '\n');
    process.exitCode = exitCode;
  } catch {
    process.stderr.write(
      'Monitoring could not run. Set CONCLAVE_MONITOR_DATABASE_URL (or CONCLAVE_DATABASE_URL) and use an optional --config=FILE; no configuration values are logged.\n',
    );
    process.exitCode = 1;
  }
}
