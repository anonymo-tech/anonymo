import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { serviceConfig, requireService } from '../server/core/config.ts';
import { configuredKeyring } from '../server/core/encryption.ts';
import { createDatabase, poolConfiguration } from '../server/db/database.ts';
import { createPpqClient } from '../server/ppq/index.ts';
import { crossCheckExecutionConfigured } from '../server/crosscheck/execution.ts';
import {
  configuredReceiptSigner,
  configuredReceiptTrust,
} from '../server/receipts/service.ts';
import { createSolanaReader } from '../server/solana/rpc.ts';
import {
  SOLANA_NETWORKS,
  SolanaError,
  TOKEN_PROGRAM,
  assertGenesis,
  record,
} from '../server/solana/validation.ts';
import { depositCapability } from '../server/solana/deposit-config.ts';
import { passkeyCapability } from '../server/auth/passkey.ts';
import {
  mediaCapability,
  mediaStorageConfigured,
} from '../server/media/contract.ts';

const targets = new Set([
  'preview',
  'api',
  'worker',
  'receipts',
  'maintenance',
  'launch',
  'live',
]);
const loopback = (hostname) =>
  ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
const noNetwork = async () => {
  throw new Error('Preflight network access is disabled.');
};
const present = (value) => typeof value === 'string' && value.length > 0;

const defaultSchema = 'conclave';
const schemaName = /^[a-z][a-z0-9_]{0,62}$/;
const rpcByteLimit = 256 * 1024;
const migrationFile = /^\d{3}-[a-z0-9-]+\.sql$/;
const defaultGrantsFile = fileURLToPath(
  new URL('../deploy/expected-grants.json', import.meta.url),
);
const defaultMigrations = fileURLToPath(
  new URL('../server/db/migrations/', import.meta.url),
);

const tokenAccountProblems = {
  ACCOUNT_MISSING: 'the account does not exist at finalized commitment',
  PROGRAM: 'the account is not owned by the SPL Token program',
  FORMAT: 'the account is not a parsed SPL token account',
  OWNER: 'the token owner is not CONCLAVE_TREASURY_WALLET',
  MINT: 'the mint is not the USDC mint pinned for the cluster',
  STATE: 'the account is not in the initialized state',
  DELEGATE: 'a delegate is set',
  CLOSE_AUTHORITY: 'a close authority is set',
};

/**
 * Pure check of a finalized `getAccountInfo` (jsonParsed) result for the
 * treasury USDC token account. Returns the list of problem codes; an empty
 * list means the account is the expected initialized, undelegated account.
 */
export function inspectTreasuryTokenAccount(result, expected) {
  try {
    const value = record(result).value;
    if (value === null || value === undefined) return ['ACCOUNT_MISSING'];
    const account = record(value);
    const problems = [];
    if (account.owner !== TOKEN_PROGRAM) problems.push('PROGRAM');
    const data = record(account.data);
    if (data.program !== 'spl-token') return [...problems, 'FORMAT'];
    const parsed = record(data.parsed);
    if (parsed.type !== 'account') return [...problems, 'FORMAT'];
    const info = record(parsed.info);
    if (info.owner !== expected.owner) problems.push('OWNER');
    if (info.mint !== expected.mint) problems.push('MINT');
    if (info.state !== 'initialized') problems.push('STATE');
    if (info.delegate !== undefined && info.delegate !== null)
      problems.push('DELEGATE');
    if (info.closeAuthority !== undefined && info.closeAuthority !== null)
      problems.push('CLOSE_AUTHORITY');
    return problems;
  } catch {
    return ['FORMAT'];
  }
}

/** One bounded read-only JSON-RPC request. The endpoint never appears in an error. */
async function liveRpc(fetcher, endpoint, method, params) {
  const id = crypto.randomUUID();
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(10_000),
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
  });
  if (!response.ok) throw new SolanaError('rpc_unavailable');
  const text = await response.text();
  if (text.length > rpcByteLimit) throw new SolanaError('response_too_large');
  let payload;
  try {
    payload = record(JSON.parse(text));
  } catch {
    throw new SolanaError('invalid_response');
  }
  if (
    payload.jsonrpc !== '2.0' ||
    payload.id !== id ||
    !Object.hasOwn(payload, 'result') ||
    Object.hasOwn(payload, 'error')
  )
    throw new SolanaError('invalid_response');
  return payload.result;
}

/** Applied migration rows against the files on disk: names and sha256 checksums must match exactly. */
export function migrationDrift(files, applied) {
  const onDisk = new Map(files.map((item) => [item.name, item.checksum]));
  const rows = new Map(applied.map((row) => [row.name, row.checksum]));
  return {
    mismatched: [...onDisk.keys()].filter(
      (name) => rows.has(name) && rows.get(name) !== onDisk.get(name),
    ),
    pending: [...onDisk.keys()].filter((name) => !rows.has(name)),
    unknown: [...rows.keys()].filter((name) => !onDisk.has(name)),
  };
}

/** Same file selection and checksum as scripts/migrate.mjs, without applying anything. */
export async function migrationFiles(directory = defaultMigrations) {
  const names = (await readdir(directory)).filter((name) =>
    migrationFile.test(name),
  );
  return Promise.all(
    names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(async (name) => ({
      name,
      checksum: createHash('sha256')
        .update(await readFile(resolve(directory, name), 'utf8'))
        .digest('hex'),
    })),
  );
}

/**
 * Privileges held by (or granted to PUBLIC for) the connected role that the
 * expected matrix does not list. Table rows come from role_table_grants and
 * column rows from role_column_grants, so column-level UPDATE grants count.
 */
export function unexpectedPrivileges(expected, tableRows, columnRows) {
  const names = (list) => new Set(Array.isArray(list) ? list : []);
  const select = names(expected.select);
  const insert = names(expected.insert);
  const remove = names(expected.delete);
  const columns = (map, table) =>
    new Set(
      String(map?.[table] ?? '')
        .split(',')
        .map((column) => column.trim())
        .filter(Boolean),
    );
  const extra = new Set();
  for (const row of tableRows) {
    const allowed =
      (row.privilege_type === 'SELECT' && select.has(row.table_name)) ||
      (row.privilege_type === 'INSERT' && insert.has(row.table_name)) ||
      (row.privilege_type === 'DELETE' && remove.has(row.table_name));
    if (!allowed) extra.add(`${row.privilege_type} ${row.table_name}`);
  }
  for (const row of columnRows) {
    const table = row.table_name;
    const allowed =
      (row.privilege_type === 'SELECT' &&
        (select.has(table) ||
          columns(expected.selectColumns, table).has(row.column_name))) ||
      (row.privilege_type === 'INSERT' && insert.has(table)) ||
      (row.privilege_type === 'UPDATE' &&
        columns(expected.update, table).has(row.column_name));
    if (!allowed) extra.add(`${row.privilege_type} ${table}`);
  }
  return [...extra].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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

async function withDatabase(createPool, url, env, work) {
  const pool = createPool(url, env);
  try {
    return await readOnly(pool, work);
  } finally {
    await pool.end();
  }
}

const tlsInEffect = (url, env, ssl) => {
  const endpoint = new URL(url);
  if (loopback(endpoint.hostname)) return true;
  return (
    poolConfiguration(url, 1, env).ssl?.rejectUnauthorized === true &&
    ssl === true
  );
};

const sessionQuery = `SELECT current_schema() AS schema, current_user AS role,
  r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
  has_schema_privilege(current_user, current_schema(), 'CREATE') AS can_create,
  (SELECT s.ssl FROM pg_stat_ssl s WHERE s.pid = pg_backend_pid()) AS ssl
  FROM pg_roles r WHERE r.rolname = current_user`;
const tableGrantQuery = `SELECT table_name, privilege_type FROM information_schema.role_table_grants
  WHERE table_schema = current_schema() AND grantee IN (current_user, 'PUBLIC')`;
const columnGrantQuery = `SELECT table_name, column_name, privilege_type FROM information_schema.role_column_grants
  WHERE table_schema = current_schema() AND grantee IN (current_user, 'PUBLIC')`;
const migrationSessionQuery = `SELECT current_schema() AS schema,
  (SELECT s.ssl FROM pg_stat_ssl s WHERE s.pid = pg_backend_pid()) AS ssl`;
const migrationRowsQuery =
  'SELECT name, checksum FROM schema_migrations ORDER BY name';

async function loadExpectedGrants(deps) {
  if (deps.expectedGrants) return deps.expectedGrants;
  const parsed = JSON.parse(
    await readFile(deps.grantsFile ?? defaultGrantsFile, 'utf8'),
  );
  return parsed.roles;
}

/**
 * The live target: read-only requests to the configured RPC endpoint and
 * databases. Findings use fixed text; no host, URL, address or secret is
 * ever included. `deps` supplies the network and database transports so
 * tests never reach a real service.
 */
async function verifyLive(env, state) {
  const { add, config, deps, schema } = state;
  const fetcher = deps.fetcher ?? globalThis.fetch;
  const createPool =
    deps.createPool ?? ((url, values) => new pg.Pool(poolConfiguration(url, 1, values)));

  // (a) Cluster identity and (b) treasury token account.
  let genesisOk = false;
  if (!state.chainConfigured || !state.treasuryConfigured) {
    add(
      'LIVE_RPC_GENESIS',
      'error',
      'Skipped: the Solana cluster, RPC endpoint and treasury configuration are not valid.',
    );
  } else {
    state.networkChecked = true;
    try {
      assertGenesis(
        config.cluster,
        await liveRpc(fetcher, config.rpcUrl, 'getGenesisHash', []),
      );
      genesisOk = true;
      add(
        'LIVE_RPC_GENESIS',
        'pass',
        'The RPC endpoint reports the genesis hash pinned for the selected cluster.',
      );
    } catch (failure) {
      add(
        'LIVE_RPC_GENESIS',
        'error',
        failure instanceof SolanaError && failure.code === 'wrong_cluster'
          ? 'The RPC endpoint reports a genesis hash that does not match the pinned hash for CONCLAVE_SOLANA_CLUSTER.'
          : 'The RPC endpoint could not be read or returned an invalid response.',
      );
    }
  }
  if (!genesisOk)
    add(
      'LIVE_TREASURY_ACCOUNT',
      'error',
      'Skipped: the cluster genesis hash was not verified.',
    );
  else {
    try {
      const problems = inspectTreasuryTokenAccount(
        await liveRpc(fetcher, config.rpcUrl, 'getAccountInfo', [
          env.CONCLAVE_TREASURY_TOKEN_ACCOUNT,
          { encoding: 'jsonParsed', commitment: 'finalized' },
        ]),
        {
          owner: env.CONCLAVE_TREASURY_WALLET,
          mint: SOLANA_NETWORKS[config.cluster].usdcMint,
        },
      );
      add(
        'LIVE_TREASURY_ACCOUNT',
        problems.length ? 'error' : 'pass',
        problems.length
          ? `The treasury USDC token account failed verification: ${problems.map((code) => tokenAccountProblems[code]).join('; ')}.`
          : 'The treasury USDC token account exists, is initialized, is owned by the treasury wallet, holds the pinned USDC mint and has no delegate or close authority.',
      );
    } catch {
      add(
        'LIVE_TREASURY_ACCOUNT',
        'error',
        'The treasury token account could not be read from the RPC endpoint.',
      );
    }
  }

  // (c) Database: role, privileges, schema, migrations and (d) TLS.
  const schemas = [];
  const tls = [];
  let serviceRead = false;
  if (!state.databaseValid)
    add(
      'LIVE_DATABASE_CONNECT',
      'error',
      'Skipped: the service database configuration is not valid.',
    );
  else {
    state.databaseChecked = true;
    try {
      const expectedRoles = await loadExpectedGrants(deps).catch(() => null);
      const session = await withDatabase(
        createPool,
        env.CONCLAVE_DATABASE_URL,
        env,
        async (client) => ({
          session: (await client.query(sessionQuery)).rows[0],
          tables: (await client.query(tableGrantQuery)).rows,
          columns: (await client.query(columnGrantQuery)).rows,
        }),
      );
      serviceRead = true;
      const row = session.session ?? {};
      schemas.push(row.schema);
      tls.push(tlsInEffect(env.CONCLAVE_DATABASE_URL, env, row.ssl));
      const elevated = [
        row.rolsuper,
        row.rolbypassrls,
        row.rolcreaterole,
        row.rolcreatedb,
        row.rolreplication,
      ].some((flag) => flag !== false);
      add(
        'LIVE_DATABASE_ROLE',
        elevated || row.can_create !== false ? 'error' : 'pass',
        elevated
          ? 'The configured database role is a superuser or has bypass-RLS, role-creation, database-creation or replication attributes.'
          : row.can_create !== false
            ? 'The configured database role can create objects in the application schema.'
            : 'The configured database role is not a superuser, cannot bypass row security and has no CREATE on the schema.',
      );
      const expected = expectedRoles?.[row.role];
      if (!expected)
        add(
          'LIVE_DATABASE_GRANTS',
          'error',
          expectedRoles
            ? 'The configured database role is not in the expected grants matrix.'
            : 'The expected grants matrix could not be loaded.',
        );
      else {
        const extra = unexpectedPrivileges(
          expected,
          session.tables,
          session.columns,
        );
        add(
          'LIVE_DATABASE_GRANTS',
          extra.length ? 'error' : 'pass',
          extra.length
            ? `The database role holds ${extra.length} privilege(s) outside the expected matrix, for example: ${extra.slice(0, 5).join(', ')}.`
            : 'The database role privileges are a subset of the expected grants matrix.',
        );
      }
    } catch {
      add(
        'LIVE_DATABASE_CONNECT',
        'error',
        'The service database could not be read with the configured role.',
      );
    }
  }

  let migrationRead = false;
  if (!present(env.CONCLAVE_MIGRATION_DATABASE_URL))
    add(
      'LIVE_MIGRATIONS',
      'error',
      'Set CONCLAVE_MIGRATION_DATABASE_URL to verify applied migration checksums; the service role cannot read schema_migrations.',
    );
  else {
    state.databaseChecked = true;
    try {
      const files = await migrationFiles(deps.migrationsDirectory);
      const read = await withDatabase(
        createPool,
        env.CONCLAVE_MIGRATION_DATABASE_URL,
        env,
        async (client) => ({
          session: (await client.query(migrationSessionQuery)).rows[0],
          applied: (await client.query(migrationRowsQuery)).rows,
        }),
      );
      migrationRead = true;
      schemas.push(read.session?.schema);
      tls.push(
        tlsInEffect(env.CONCLAVE_MIGRATION_DATABASE_URL, env, read.session?.ssl),
      );
      const drift = migrationDrift(files, read.applied);
      const clean = !Object.values(drift).some((names) => names.length);
      add(
        'LIVE_MIGRATIONS',
        clean ? 'pass' : 'error',
        clean
          ? `All ${files.length} migration files are applied and their checksums match the database.`
          : `Migration state differs from the files on disk. Checksum mismatch: ${drift.mismatched.join(', ') || 'none'}. Not applied: ${drift.pending.join(', ') || 'none'}. Applied but not on disk: ${drift.unknown.join(', ') || 'none'}.`,
      );
    } catch {
      add(
        'LIVE_MIGRATIONS',
        'error',
        'The migration table could not be read with CONCLAVE_MIGRATION_DATABASE_URL.',
      );
    }
  }

  if (serviceRead || migrationRead) {
    const schemaOk = schemas.every((value) => value === schema);
    add(
      'LIVE_DATABASE_SCHEMA',
      schemaOk ? 'pass' : 'error',
      schemaOk
        ? 'The connections resolve current_schema() to the expected schema.'
        : 'A database connection resolves current_schema() to a schema other than the expected one.',
    );
    const tlsOk = tls.every(Boolean);
    add(
      'LIVE_DATABASE_TLS',
      tlsOk ? 'pass' : 'error',
      tlsOk
        ? 'Verified TLS (verify-full) is in effect on every non-loopback database connection.'
        : 'A non-loopback database connection does not have verified TLS in effect.',
    );
  }
}

/**
 * Configuration validation only: no connection, migration, inference or chain
 * request. The one exception is the `live` target, which makes read-only
 * requests (see `verifyLive`) through the transports in `options`.
 */
export async function checkReadiness(env = process.env, options = {}) {
  const target =
    options.target ?? (env.CONCLAVE_MODE === 'service' ? 'api' : 'preview');
  if (
    !targets.has(target) ||
    (options.production !== undefined &&
      typeof options.production !== 'boolean') ||
    (options.schema !== undefined &&
      (target !== 'live' || !schemaName.test(options.schema)))
  )
    throw new Error('Choose a supported readiness target and environment.');
  const production = options.production === true;
  const findings = [];
  const add = (code, status, message) =>
    findings.push({ code, status, message });
  const live = target !== 'preview';
  const wantsInference =
    ['worker', 'launch'].includes(target) ||
    env.CONCLAVE_INFERENCE_ENABLED === 'true';
  const wantsSigner = ['receipts', 'launch'].includes(target);
  const wantsChain =
    ['launch', 'live'].includes(target) ||
    env.CONCLAVE_DEPOSITS_ENABLED === 'true' ||
    env.CONCLAVE_DEPOSIT_PAYMENTS_ENABLED === 'true' ||
    env.CONCLAVE_DEPOSIT_RECOVERY_ENABLED === 'true';

  if (
    Object.keys(env).some(
      (name) =>
        /^(NEXT_PUBLIC_|VITE_).*(?:PPQ|DATABASE|DATA_KEYS|SIGNER|PRIVATE_KEY|SECRET|RPC_URL)/i.test(
          name,
        ) && present(env[name]),
    )
  )
    add(
      'PUBLIC_SERVER_CONFIGURATION',
      'error',
      'Remove server credentials and sensitive connection configuration from public-prefixed environment variables.',
    );
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    add(
      'TLS_VERIFICATION_DISABLED',
      'error',
      'Remove the global TLS verification override. Certificate verification is required.',
    );
  if (
    present(env.CONCLAVE_MODE) &&
    !['preview', 'service'].includes(env.CONCLAVE_MODE)
  )
    add(
      'MODE_INVALID',
      'error',
      'Set CONCLAVE_MODE explicitly to preview or service.',
    );
  for (const [name, code] of [
    ['CONCLAVE_INFERENCE_ENABLED', 'INFERENCE_FLAG_INVALID'],
    ['CONCLAVE_CROSSCHECK_ENABLED', 'CROSSCHECK_FLAG_INVALID'],
    ['CONCLAVE_BRIEF_SYNTHESIS_ENABLED', 'BRIEF_SYNTHESIS_FLAG_INVALID'],
    ['CONCLAVE_MEDIA_ENABLED', 'MEDIA_FLAG_INVALID'],
    ['CONCLAVE_DEPOSITS_ENABLED', 'DEPOSITS_FLAG_INVALID'],
    ['CONCLAVE_DEPOSIT_PAYMENTS_ENABLED', 'DEPOSIT_PAYMENTS_FLAG_INVALID'],
    ['CONCLAVE_DEPOSIT_RECOVERY_ENABLED', 'DEPOSIT_RECOVERY_FLAG_INVALID'],
    ['CONCLAVE_PASSKEYS_ENABLED', 'PASSKEY_FLAG_INVALID'],
  ])
    if (present(env[name]) && !['true', 'false'].includes(env[name]))
      add(code, 'error', `Set ${name} to the literal true or false.`);

  let config;
  try {
    config = serviceConfig(env);
    if (live) requireService(config);
    add(
      'SERVICE_CONFIGURATION',
      'pass',
      live
        ? 'The service mode, origin and database fields are present; connectivity is not checked.'
        : 'Preview configuration was checked; this does not enable live services.',
    );
  } catch {
    add(
      'SERVICE_CONFIGURATION',
      'error',
      'For live service targets, set CONCLAVE_MODE, a valid CONCLAVE_APP_ORIGIN and CONCLAVE_DATABASE_URL. The origin must not contain credentials, a path or query.',
    );
  }
  if (env.CONCLAVE_PASSKEYS_ENABLED === 'true' || target === 'launch') {
    const passkeys = passkeyCapability(env);
    add(
      'PASSKEY_CONFIGURATION',
      passkeys.configured ? 'pass' : 'error',
      passkeys.configured
        ? 'Passkey configuration has an exact relying-party hostname; credential and browser verification still require live checks.'
        : 'Passkey sign-in requires its explicit flag, a configured service, and a valid origin hostname. IP-address origins cannot register passkeys.',
    );
  }
  if (target === 'preview' && env.CONCLAVE_MODE === 'service')
    add(
      'PREVIEW_MODE_MISMATCH',
      'error',
      'A preview check requires preview mode; do not label an activated service as preview.',
    );
  if (production && config?.origin) {
    const origin = new URL(config.origin);
    if (origin.protocol !== 'https:' || loopback(origin.hostname))
      add(
        'PRODUCTION_ORIGIN',
        'error',
        'Production requires a non-loopback HTTPS application origin.',
      );
    else
      add(
        'PRODUCTION_ORIGIN',
        'pass',
        'The configured production origin has an HTTPS shape; DNS and domain control are not checked.',
      );
  }

  if (production) {
    const breaker = env.CONCLAVE_MAX_ACCOUNT_OVERAGE_USD6;
    if (typeof breaker === 'string' && /^[1-9][0-9]{0,11}$/.test(breaker))
      add(
        'PRODUCTION_OVERAGE_BREAKER',
        'pass',
        'The per-account overage breaker is configured.',
      );
    else
      add(
        'PRODUCTION_OVERAGE_BREAKER',
        'error',
        'Production requires CONCLAVE_MAX_ACCOUNT_OVERAGE_USD6 (a positive integer, micro-USD per 24 hours) so an account cannot keep overrunning its reservations.',
      );
  }

  let databaseValid = false;
  if (present(env.CONCLAVE_DATABASE_URL)) {
    let pool;
    try {
      pool = createDatabase(env.CONCLAVE_DATABASE_URL, 1);
      const endpoint = new URL(env.CONCLAVE_DATABASE_URL);
      if (
        !endpoint.username ||
        !endpoint.pathname.slice(1) ||
        (endpoint.port && Number(endpoint.port) < 1)
      )
        throw new Error();
      if (production && loopback(endpoint.hostname)) throw new Error();
      if (
        !loopback(endpoint.hostname) &&
        pool.options.ssl?.rejectUnauthorized !== true
      )
        throw new Error();
      databaseValid = true;
      add(
        'DATABASE_CONFIGURATION',
        'pass',
        'Database configuration passed the runtime parser. Remote certificate verification is required; no connection was opened.',
      );
    } catch {
      add(
        'DATABASE_CONFIGURATION',
        'error',
        'Use an explicit database user and database with supported PostgreSQL URL syntax. Remote connections require verified TLS; production must not use loopback.',
      );
    } finally {
      if (pool) await pool.end();
    }
  } else if (live)
    add(
      'DATABASE_CONFIGURATION',
      'error',
      'Set CONCLAVE_DATABASE_URL using a dedicated service role, not the migration owner.',
    );

  let encryptedStorage = false;
  if (
    live ||
    present(env.CONCLAVE_DATA_KEYS) ||
    present(env.CONCLAVE_ACTIVE_DATA_KEY)
  ) {
    try {
      const keyring = configuredKeyring(env);
      for (const encoded of Object.values(keyring.keys)) {
        const key = Buffer.from(encoded, 'base64');
        if (
          key.toString('base64') !== encoded ||
          key.every((byte) => byte === key[0])
        )
          throw new Error();
      }
      encryptedStorage = true;
      add(
        'STORAGE_KEYS',
        'pass',
        'The encryption keyring has valid identifiers and canonical 32-byte keys. Entropy, custody and restore copies still require operator verification.',
      );
    } catch {
      add(
        'STORAGE_KEYS',
        ['api', 'worker', 'launch', 'live'].includes(target) ? 'error' : 'warning',
        'Configure CONCLAVE_DATA_KEYS and its active key with canonical base64 32-byte keys. Reject placeholder keys and keep the recovery copy outside the database.',
      );
    }
  }

  let providerConfigured = false;
  if (present(env.PPQ_API_KEY)) {
    try {
      providerConfigured = createPpqClient({
        apiKey: env.PPQ_API_KEY,
        fetch: noNetwork,
      }).configured;
    } catch {
      /* Fixed result only. */
    }
    add(
      'PROVIDER_KEY',
      providerConfigured ? 'pass' : 'error',
      providerConfigured
        ? 'The provider key passes local syntax validation; validity, balance and account permissions are unverified.'
        : 'PPQ_API_KEY failed local syntax validation. No provider request was made.',
    );
  } else
    add(
      'PROVIDER_KEY',
      wantsInference ? 'error' : 'pending',
      'No PPQ_API_KEY is configured. Inference must remain unavailable.',
    );
  const inferenceConfigured = !!(
    config?.mode === 'service' &&
    config.origin &&
    databaseValid &&
    encryptedStorage &&
    providerConfigured &&
    config.inferenceEnabled
  );
  const media = mediaCapability(env, mediaStorageConfigured(env));
  add(
    'MEDIA_CONFIGURATION',
    env.CONCLAVE_MEDIA_ENABLED === 'true'
      ? media.configured && databaseValid
        ? 'pass'
        : 'error'
      : 'pending',
    media.configured && databaseValid
      ? 'Studio configuration is coherent. Verify migrations, reviewed route prices, separate generation/import workers, ffmpeg, private playback and storage capacity before activation; this check makes no provider calls.'
      : 'Studio generation requires service configuration, encrypted storage, a provider key, and both inference and media activation flags.',
  );
  if (wantsInference && !inferenceConfigured)
    add(
      'INFERENCE_GATE',
      'error',
      'Inference requires service configuration, encryption, a provider key and CONCLAVE_INFERENCE_ENABLED=true.',
    );
  else
    add(
      'INFERENCE_GATE',
      inferenceConfigured ? 'pass' : 'pending',
      inferenceConfigured
        ? 'Local inference gates are coherent; no model, worker or reviewed route was exercised.'
        : 'Inference is disabled.',
    );
  if (target === 'launch' && env.CONCLAVE_CROSSCHECK_ENABLED !== 'true')
    add(
      'CROSSCHECK_GATE',
      'error',
      'Launch Cross-Check requires an explicit CONCLAVE_CROSSCHECK_ENABLED=true gate and a reviewed independent roster.',
    );
  else if (
    env.CONCLAVE_CROSSCHECK_ENABLED === 'true' &&
    (!inferenceConfigured || !crossCheckExecutionConfigured(env))
  )
    add(
      'CROSSCHECK_GATE',
      'error',
      'Cross-Check cannot be enabled without all inference and encrypted-storage prerequisites.',
    );
  else
    add(
      'CROSSCHECK_GATE',
      env.CONCLAVE_CROSSCHECK_ENABLED === 'true' ? 'pass' : 'pending',
      env.CONCLAVE_CROSSCHECK_ENABLED === 'true'
        ? 'Cross-Check configuration gates are coherent; roster contents and expiry are not checked offline.'
        : 'Cross-Check execution is disabled.',
    );
  const wantsSynthesis = env.CONCLAVE_BRIEF_SYNTHESIS_ENABLED === 'true';
  add(
    'BRIEF_SYNTHESIS_GATE',
    wantsSynthesis
      ? inferenceConfigured
        ? 'pass'
        : 'error'
      : target === 'launch'
        ? 'error'
        : 'pending',
    wantsSynthesis && inferenceConfigured
      ? 'Brief analysis configuration gates are coherent. Verify migration 017, reviewed routes, worker evaluation and quoted approval before activation; no model was called.'
      : 'Brief generation requires CONCLAVE_BRIEF_SYNTHESIS_ENABLED=true and all paid inference prerequisites. Existing saved analysis remains readable when generation is disabled.',
  );
  if (
    present(env.CONCLAVE_WORKER_CONCURRENCY) &&
    !/^[1-4]$/.test(env.CONCLAVE_WORKER_CONCURRENCY)
  )
    add(
      'WORKER_LIMIT',
      'error',
      'CONCLAVE_WORKER_CONCURRENCY must be an integer from one through four.',
    );
  else
    add(
      'WORKER_LIMIT',
      'pass',
      'Worker concurrency uses the supported one-to-four range.',
    );

  const signerFields = [
    'CONCLAVE_RECEIPT_SIGNER_KEY_ID',
    'CONCLAVE_RECEIPT_SIGNER_EPOCH',
    'CONCLAVE_RECEIPT_SIGNER_SEED_HEX',
    'CONCLAVE_RECEIPT_SIGNER_VALID_FROM',
    'CONCLAVE_RECEIPT_SIGNER_VALID_UNTIL',
  ];
  let receiptTrust = false,
    receiptSigner = false;
  if (
    wantsSigner ||
    present(env.CONCLAVE_RECEIPT_TRUSTED_SIGNERS) ||
    signerFields.some((name) => present(env[name]))
  ) {
    try {
      configuredReceiptTrust(env);
      receiptTrust = true;
    } catch {
      /* No values or error detail leave this check. */
    }
    add(
      'RECEIPT_TRUST',
      receiptTrust ? 'pass' : 'error',
      receiptTrust
        ? 'Trusted signer entries satisfy bounded UTC validity windows. No downloaded receipt supplied this trust.'
        : 'Configure CONCLAVE_RECEIPT_TRUSTED_SIGNERS with explicit public keys, epochs, UTC validity windows of at most seven days, and revocation states.',
    );
    if (wantsSigner || signerFields.some((name) => present(env[name]))) {
      let signer;
      try {
        signer = configuredReceiptSigner(env);
        if (signer.seed.every((byte) => byte === signer.seed[0]))
          throw new Error();
        receiptSigner = true;
      } catch {
        /* Fixed result only. */
      } finally {
        signer?.seed.fill(0);
      }
      add(
        'RECEIPT_SIGNER',
        receiptSigner ? 'pass' : 'error',
        receiptSigner
          ? 'The signer matches its current, unrevoked trusted key and UTC window. No receipt or chain anchor was created.'
          : 'Configure a matching current receipt signer, 32-byte seed, key ID, epoch and UTC validity window; never generate keys automatically during deployment.',
      );
    }
  } else
    add(
      'RECEIPT_SIGNER',
      'pending',
      'Receipt signing is not configured. Signed receipts and finalized chain anchors are separate activation gates.',
    );
  if (
    ['api', 'worker', 'maintenance'].includes(target) &&
    present(env.CONCLAVE_RECEIPT_SIGNER_SEED_HEX)
  )
    add(
      'SIGNER_PROCESS_ISOLATION',
      'warning',
      'Remove the receipt signing seed from processes that do not issue receipts; use a separate receipt job credential set.',
    );

  const chainPresent =
    present(env.CONCLAVE_SOLANA_CLUSTER) ||
    present(env.CONCLAVE_SOLANA_RPC_URL);
  let chainConfigured = false;
  if (wantsChain || chainPresent) {
    try {
      if (!config?.cluster || !config.rpcUrl) throw new Error();
      createSolanaReader({
        rpcUrl: config.rpcUrl,
        cluster: config.cluster,
        fetcher: noNetwork,
      });
      if (production && loopback(new URL(config.rpcUrl).hostname))
        throw new Error();
      chainConfigured = true;
    } catch {
      /* No network or URL is logged. */
    }
    add(
      'SOLANA_CONFIGURATION',
      chainConfigured ? 'pass' : 'error',
      chainConfigured
        ? 'Solana network and HTTPS RPC configuration have valid local shapes. Genesis hash, endpoint health and finality are not checked.'
        : 'Select CONCLAVE_SOLANA_CLUSTER explicitly and configure a valid HTTPS CONCLAVE_SOLANA_RPC_URL together. No network is selected automatically.',
    );
  } else
    add(
      'SOLANA_CONFIGURATION',
      'pending',
      'No Solana network is selected. Chain features remain unavailable.',
    );
  let treasuryConfigured = false;
  const treasuryPresent = [
    'CONCLAVE_TREASURY_WALLET',
    'CONCLAVE_TREASURY_TOKEN_ACCOUNT',
    'CONCLAVE_MAX_DEPOSIT_USD6',
  ].some((name) => present(env[name]));
  if (wantsChain || treasuryPresent) {
    try {
      const deposit = depositCapability(env);
      treasuryConfigured =
        deposit.cluster !== null && deposit.maximumUsd6 !== null;
    } catch {
      /* Fixed result only. */
    }
    add(
      'DEPOSIT_POLICY',
      treasuryConfigured ? 'pass' : 'error',
      treasuryConfigured
        ? 'Treasury identifiers and positive integer USD6 limit are shaped correctly; ownership, mint and token account are not verified.'
        : 'Configure distinct treasury wallet/token-account identifiers and a positive exact integer CONCLAVE_MAX_DEPOSIT_USD6 limit before enabling deposits.',
    );
  }
  if (
    (env.CONCLAVE_DEPOSITS_ENABLED === 'true' ||
      env.CONCLAVE_DEPOSIT_RECOVERY_ENABLED === 'true') &&
    (!live || !databaseValid || !chainConfigured || !treasuryConfigured)
  )
    add(
      'DEPOSIT_GATE',
      'error',
      'Deposit activation or recovery requires coherent live service, database, chain and treasury configuration.',
    );
  if (target === 'launch' && env.CONCLAVE_DEPOSITS_ENABLED !== 'true')
    add(
      'DEPOSIT_GATE',
      'error',
      'New deposits remain disabled until their explicit gate and reviewed settlement policy are configured.',
    );
  if (
    env.CONCLAVE_DEPOSIT_PAYMENTS_ENABLED === 'true' &&
    (env.CONCLAVE_DEPOSITS_ENABLED !== 'true' ||
      !live ||
      !databaseValid ||
      !chainConfigured ||
      !treasuryConfigured)
  )
    add(
      'DEPOSIT_PAYMENT_GATE',
      'error',
      'Wallet payments require enabled deposit creation and coherent service, database, chain and treasury configuration.',
    );
  if (target === 'launch' && env.CONCLAVE_DEPOSIT_PAYMENTS_ENABLED !== 'true')
    add(
      'DEPOSIT_PAYMENT_GATE',
      'error',
      'Wallet payment submission remains disabled until its explicit gate is enabled after payment-flow verification.',
    );

  const liveState = {
    add,
    config,
    schema: options.schema ?? defaultSchema,
    deps: options,
    chainConfigured,
    treasuryConfigured,
    databaseValid,
    networkChecked: false,
    databaseChecked: false,
  };
  if (target === 'live') await verifyLive(env, liveState);
  if (live) {
    if (target !== 'live')
      add(
        'DATABASE_READINESS',
        'pending',
        'Separately verify applied migration checksums, least-privilege grants, authenticated TLS, UTC settings and transaction invariants. This command never opens a database connection.',
      );
    add(
      'ROUTE_READINESS',
      'pending',
      'Inspect enabled, unexpired immutable routes and independent reviewer rosters against current provider catalog and privacy evidence before activation.',
    );
    add(
      'OPERATIONS_READINESS',
      'pending',
      'Verify worker supervision, lease recovery, maintenance, receipt jobs, key custody, tested backup restoration and alert delivery. Configuration alone proves none of these.',
    );
  }
  if (target === 'launch')
    add(
      'LAUNCH_VERIFICATION',
      'pending',
      'Launch remains unverified until supervised provider billing, finalized deposit recovery and the intended production user journeys are exercised under explicit authorization.',
    );
  const configurationOk = !findings.some((item) => item.status === 'error');
  return {
    schema: 'conclave-readiness-v1',
    target,
    environment: production ? 'production' : 'local',
    checkedAt: new Date().toISOString(),
    configurationOk,
    readiness: !configurationOk
      ? target === 'live'
        ? 'live_verification_failed'
        : 'configuration_invalid'
      : target === 'live'
        ? 'live_verified'
        : target === 'preview'
          ? 'preview_only'
          : 'external_verification_required',
    networkChecksPerformed: liveState.networkChecked,
    databaseChecksPerformed: liveState.databaseChecked,
    capabilities: {
      encryptedStorage,
      inferenceConfigured,
      studioConfigured: media.configured && databaseValid,
      receiptTrust,
      receiptSigner,
      chainConfigured,
      treasuryConfigured,
    },
    findings,
  };
}

export async function runReadiness(args, env = process.env, deps = {}) {
  const options = { ...deps };
  const usage =
    'Usage: check-readiness.mjs [--target=preview|api|worker|receipts|maintenance|launch|live] [--production] [--schema=NAME] [--grants=FILE]';
  for (const arg of args) {
    if (arg === '--production' && options.production === undefined)
      options.production = true;
    else if (
      arg.startsWith('--target=') &&
      options.target === undefined &&
      targets.has(arg.slice(9))
    )
      options.target = arg.slice(9);
    else if (
      arg.startsWith('--schema=') &&
      options.schema === undefined &&
      schemaName.test(arg.slice(9))
    )
      options.schema = arg.slice(9);
    else if (
      arg.startsWith('--grants=') &&
      options.grantsFile === undefined &&
      arg.length > 9
    )
      options.grantsFile = resolve(arg.slice(9));
    else throw new Error(usage);
  }
  const report = await checkReadiness(env, options);
  return {
    report,
    exitCode: !report.configurationOk
      ? 1
      : report.target === 'launch'
        ? 2
        : 0,
  };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const { report, exitCode } = await runReadiness(process.argv.slice(2));
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = exitCode;
  } catch {
    process.stderr.write(
      'Readiness validation could not run. Use a supported target and optional --production; no configuration values are logged.\n',
    );
    process.exitCode = 1;
  }
}
