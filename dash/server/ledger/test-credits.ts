import type { Pool, PoolClient } from 'pg';
import { one, transaction, type Queryable } from '../db/database.ts';
import { ServiceError, requireCondition } from '../core/errors.ts';
import { decimalUsd6, usd6 } from './money.ts';
import { getBalance, ledgerAccount, post } from './ledger.ts';
import { welcomeCreditGrantedUsd6 } from './welcome-credit.ts';

// Internal test credit is local-testing balance only. It is never USDC, never a
// deposit and never chain evidence; deposits keep their separate verified path.
export const INTERNAL_TEST_CREDIT_KIND = 'internal_test_credit' as const;
export const INTERNAL_TEST_CREDIT_LABEL = 'Internal test credit (not USDC)';
/** Per-grant ceiling; migration 018 enforces the same bound. */
export const INTERNAL_TEST_CREDIT_MAX_USD6 = 100_000_000n;
/** The one automatic grant an account can receive from signing in. */
export const SIGN_IN_TEST_CREDIT_REFERENCE = 'sign-in';

type Env = Record<string, string | undefined>;
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const referencePattern = /^[A-Za-z0-9][A-Za-z0-9:_-]{2,95}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function loopbackUrl(value: string | undefined | null, protocols: string[]) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) && loopbackHosts.has(url.hostname);
  } catch {
    return false;
  }
}

/** Any production marker, or real mainnet USDC deposits, disables test credit. */
export function productionEnvironment(env: Env = process.env) {
  return (
    env.NODE_ENV === 'production' ||
    env.CONCLAVE_ENVIRONMENT === 'production' ||
    (env.CONCLAVE_SOLANA_CLUSTER === 'mainnet-beta' &&
      env.CONCLAVE_DEPOSITS_ENABLED === 'true')
  );
}

/**
 * A remote database qualifies only with verified TLS. The live internal-testing
 * database may be hosted (Supabase) while the app itself stays on localhost;
 * the loopback app-origin requirement and the production markers still apply.
 */
function verifiedDatabaseUrl(value: string | undefined | null) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      ['postgres:', 'postgresql:'].includes(url.protocol) &&
      !!url.hostname &&
      [...url.searchParams].length === 1 &&
      url.searchParams.get('sslmode') === 'verify-full'
    );
  } catch {
    return false;
  }
}

/**
 * Operator gate: explicit internal-testing flag, no production marker, a
 * loopback or TLS-verified database, and a loopback app origin whenever one
 * is configured.
 */
export function internalTestingAllowed(env: Env = process.env) {
  return (
    env.CONCLAVE_INTERNAL_TESTING === 'true' &&
    !productionEnvironment(env) &&
    (loopbackUrl(env.CONCLAVE_DATABASE_URL, ['postgres:', 'postgresql:']) ||
      verifiedDatabaseUrl(env.CONCLAVE_DATABASE_URL)) &&
    (!env.CONCLAVE_APP_ORIGIN ||
      loopbackUrl(env.CONCLAVE_APP_ORIGIN, ['http:', 'https:']))
  );
}

/** Sign-in gate. Returns the configured grant, or null when inert. Never throws. */
export function signInTestCreditUsd6(
  origin: string,
  env: Env = process.env,
): bigint | null {
  if (
    !internalTestingAllowed(env) ||
    env.CONCLAVE_MODE !== 'service' ||
    !loopbackUrl(origin, ['http:', 'https:'])
  )
    return null;
  try {
    const amount = decimalUsd6(env.CONCLAVE_INTERNAL_TEST_CREDIT_USD ?? '');
    return amount > 0n && amount <= INTERNAL_TEST_CREDIT_MAX_USD6
      ? amount
      : null;
  } catch {
    return null;
  }
}

async function fundingAccount(client: PoolClient) {
  await client.query(
    "INSERT INTO ledger_accounts(id,owner_id,kind) VALUES($1,NULL,'internal_test_funding') ON CONFLICT(owner_id,kind) DO NOTHING",
    [crypto.randomUUID()],
  );
  const account = await one<{ id: string }>(
    client,
    "SELECT id FROM ledger_accounts WHERE owner_id IS NULL AND kind='internal_test_funding'",
  );
  if (!account) throw new Error('Internal test funding account unavailable.');
  return account;
}

export type InternalTestCreditGrant = {
  transactionId: string;
  amountUsd6: string;
  reference: string;
  replayed: boolean;
};

/**
 * Credits an active account from the internal test funding account. The same
 * (account, reference) pair never credits twice; a replay with a different
 * amount is rejected. Callers own gating; this seam has no HTTP endpoint.
 */
export async function grantInternalTestCredit(
  pool: Pool,
  accountId: string,
  amountUsd6: string,
  reference: string,
) {
  return transaction(pool, (client) =>
    grantInternalTestCreditInTransaction(
      client,
      accountId,
      amountUsd6,
      reference,
    ),
  );
}

export async function grantInternalTestCreditInTransaction(
  client: PoolClient,
  accountId: string,
  amountUsd6: string,
  reference: string,
): Promise<InternalTestCreditGrant> {
  const amount = usd6(amountUsd6);
  requireCondition(
    amount <= INTERNAL_TEST_CREDIT_MAX_USD6,
    400,
    'INVALID_AMOUNT',
    'An internal test credit grant cannot exceed 100 USD.',
  );
  requireCondition(
    typeof reference === 'string' && referencePattern.test(reference),
    400,
    'INVALID_REFERENCE',
    'The internal test credit reference is invalid.',
  );
  requireCondition(
    typeof accountId === 'string' && uuidPattern.test(accountId),
    400,
    'INVALID_ACCOUNT',
    'The account identifier is invalid.',
  );
  // Same lock order as reservations: owner row, then ledger accounts.
  requireCondition(
    await one(
      client,
      'SELECT id FROM accounts WHERE id=$1 AND disabled_at IS NULL FOR UPDATE',
      [accountId],
    ),
    409,
    'ACCOUNT_UNAVAILABLE',
    'This account is unavailable.',
  );
  const previous = await one<{
    amount_usd6: string;
    ledger_transaction_id: string;
  }>(
    client,
    'SELECT amount_usd6::text,ledger_transaction_id FROM internal_test_credit_grants WHERE account_id=$1 AND reference=$2',
    [accountId, reference],
  );
  if (previous) {
    requireCondition(
      previous.amount_usd6 === amount.toString(),
      409,
      'REFERENCE_CONFLICT',
      'This internal test credit reference was already used with a different amount.',
    );
    return {
      transactionId: previous.ledger_transaction_id,
      amountUsd6: previous.amount_usd6,
      reference,
      replayed: true,
    };
  }
  const available = await ledgerAccount(client, accountId, 'available');
  const funding = await fundingAccount(client);
  const transactionId = await post(
    client,
    `internal-test-credit:${accountId}:${reference}`,
    INTERNAL_TEST_CREDIT_KIND,
    [
      { id: funding.id, amount: -amount },
      { id: available.id, amount },
    ],
  );
  await client.query(
    'INSERT INTO internal_test_credit_grants(account_id,reference,amount_usd6,ledger_transaction_id) VALUES($1,$2,$3,$4)',
    [accountId, reference, amount.toString(), transactionId],
  );
  return {
    transactionId,
    amountUsd6: amount.toString(),
    reference,
    replayed: false,
  };
}

/**
 * Sign-in hook. Inert unless internal testing is explicitly enabled against a
 * loopback origin and a loopback or TLS-verified database. Runs after the sign-in commits and never
 * blocks it; the fixed reference makes the grant exactly once per account.
 */
export async function grantSignInTestCredit(
  pool: Pool,
  accountId: string | null,
  origin: string,
  env: Env = process.env,
) {
  const amount = signInTestCreditUsd6(origin, env);
  if (amount === null || !accountId) return null;
  try {
    return await grantInternalTestCredit(
      pool,
      accountId,
      amount.toString(),
      SIGN_IN_TEST_CREDIT_REFERENCE,
    );
  } catch (error) {
    // A changed configured amount must not grant a second sign-in credit.
    if (!(error instanceof ServiceError && error.code === 'REFERENCE_CONFLICT'))
      console.warn(
        'Internal test credit was not granted:',
        error instanceof ServiceError ? error.code : 'UNEXPECTED_ERROR',
      );
    return null;
  }
}

export async function internalTestCreditGrantedUsd6(
  db: Queryable,
  accountId: string,
) {
  const row = await one<{ total: string | null }>(
    db,
    'SELECT sum(amount_usd6)::text AS total FROM internal_test_credit_grants WHERE account_id=$1',
    [accountId],
  );
  return row?.total ?? '0';
}

/** Credit provenance is lifetime granted usage credit, not a token balance. */
export async function labelledBalance(pool: Pool, accountId: string) {
  const [balance, granted, welcomeGranted] = await Promise.all([
    getBalance(pool, accountId),
    internalTestCreditGrantedUsd6(pool, accountId),
    welcomeCreditGrantedUsd6(pool, accountId),
  ]);
  return {
    ...balance,
    ...(granted === '0'
      ? {}
      : {
        internalTestCredit: {
          grantedUsd6: granted,
          label: INTERNAL_TEST_CREDIT_LABEL,
        },
      }),
    ...(welcomeGranted === '0'
      ? {}
      : {
        welcomeCredit: {
          grantedUsd6: welcomeGranted,
          label: 'Welcome usage credit (not USDC)',
        },
      }),
  };
}
