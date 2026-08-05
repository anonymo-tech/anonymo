import pg from 'pg';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { readFileSync } from 'node:fs';
import { TLSSocket } from 'node:tls';
import { ServiceError } from '../core/errors.ts';

export type Queryable = Pick<PoolClient, 'query'>;

/** pg's Workers transport has verified TLS, but no peer-certificate API for SCRAM-PLUS. */
export function supportsPostgresChannelBinding() {
  if (
    typeof navigator === 'object' &&
    navigator !== null &&
    navigator.userAgent === 'Cloudflare-Workers'
  )
    return false;
  return typeof TLSSocket.prototype.getPeerCertificate === 'function';
}

const loopbackHosts = ['localhost', '127.0.0.1', '[::1]'];
const certificatePattern = /-----BEGIN CERTIFICATE-----/;

function configurationError() {
  return new ServiceError(
    503,
    'DATABASE_CONFIGURATION_REQUIRED',
    'The database connection is not configured correctly.',
  );
}

/**
 * Optional CA bundle for remote hosts whose certificates do not chain to the
 * system roots (Supabase issues its own CA). Read once per pool; the path is
 * never logged. Loopback hosts ignore it and verification stays mandatory.
 */
function remoteCertificateAuthority(
  env: Record<string, string | undefined>,
): string | undefined {
  const file = env.CONCLAVE_DATABASE_CA_FILE;
  if (!file) return undefined;
  try {
    const bundle = readFileSync(file, 'utf8');
    if (bundle.length > 65536 || !certificatePattern.test(bundle)) throw new Error();
    return bundle;
  } catch {
    throw configurationError();
  }
}

/**
 * Validated pool settings for a PostgreSQL URL: an explicit user and database,
 * no fragment and no parameter other than `sslmode=verify-full`. Remote hosts
 * always verify the server certificate; loopback hosts use plain sockets unless
 * `sslmode` is given.
 */
export function poolConfiguration(
  connectionString: string,
  max = 4,
  env: Record<string, string | undefined> = process.env,
): pg.PoolConfig {
  let endpoint: URL;
  try {
    endpoint = new URL(connectionString);
    if (
      !['postgres:', 'postgresql:'].includes(endpoint.protocol) ||
      !endpoint.hostname ||
      !/^\/[^/]+$/.test(endpoint.pathname) ||
      endpoint.hash ||
      [...endpoint.searchParams].some(
        ([key, value]) => key !== 'sslmode' || value !== 'verify-full',
      )
    )
      throw new Error();
  } catch {
    throw configurationError();
  }
  const local = loopbackHosts.includes(endpoint.hostname);
  const ca = local ? undefined : remoteCertificateAuthority(env);
  return {
    host: endpoint.hostname.replace(/^\[|\]$/g, ''),
    port: endpoint.port ? Number(endpoint.port) : 5432,
    database: decodeURIComponent(endpoint.pathname.slice(1)),
    user: decodeURIComponent(endpoint.username),
    password: decodeURIComponent(endpoint.password),
    ssl:
      local && !endpoint.searchParams.has('sslmode')
        ? false
        : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    enableChannelBinding: supportsPostgresChannelBinding(),
    max,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 10_000,
    application_name: 'conclave',
    options: '-c timezone=UTC',
  };
}

export function createDatabase(connectionString: string, max = 4): Pool {
  return new pg.Pool(poolConfiguration(connectionString, max));
}

export async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function one<T extends QueryResultRow>(
  db: Queryable,
  sql: string,
  values: unknown[] = [],
): Promise<T | null> {
  const result = await db.query<T>(sql, values);
  return result.rows[0] ?? null;
}

// A request owns its pool: sockets may not be reused across Worker request contexts.
export async function withDatabase<T>(
  url: string,
  work: (pool: Pool) => Promise<T>,
) {
  const pool = createDatabase(url);
  try {
    return await work(pool);
  } finally {
    await pool.end();
  }
}
