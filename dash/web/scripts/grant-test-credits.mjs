import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createDatabase } from '../server/db/database.ts';
import { decimalUsd6 } from '../server/ledger/money.ts';
import { getBalance } from '../server/ledger/ledger.ts';
import { address } from '../server/solana/validation.ts';
import {
  INTERNAL_TEST_CREDIT_LABEL,
  INTERNAL_TEST_CREDIT_MAX_USD6,
  grantInternalTestCredit,
  internalTestingAllowed,
} from '../server/ledger/test-credits.ts';

const usage =
  'Usage: grant-test-credits.mjs --account <accountId|wallet address> --usd <amount> [--reference <reference>]';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RefusedError extends Error {}

export function parseGrantArguments(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        account: { type: 'string' },
        usd: { type: 'string' },
        reference: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw new RefusedError(usage);
  }
  if (!values.account || !values.usd) throw new RefusedError(usage);
  let amount;
  try {
    amount = decimalUsd6(values.usd);
  } catch {
    throw new RefusedError('--usd must be a positive USD amount with at most six decimals.');
  }
  if (amount <= 0n || amount > INTERNAL_TEST_CREDIT_MAX_USD6)
    throw new RefusedError('--usd must be greater than 0 and at most 100 per grant.');
  const reference = values.reference ?? `operator-${randomUUID()}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{2,95}$/.test(reference))
    throw new RefusedError('--reference must be 3-96 characters of letters, digits, colon, underscore or hyphen.');
  return { account: values.account, amountUsd6: amount.toString(), reference };
}

export async function resolveAccount(pool, account) {
  if (uuid.test(account)) {
    const found = await pool.query('SELECT id FROM accounts WHERE id=$1', [account]);
    if (!found.rows.length) throw new RefusedError('No account has this identifier.');
    return found.rows[0].id;
  }
  try {
    address(account);
  } catch {
    throw new RefusedError('--account must be an account UUID or a Solana wallet address.');
  }
  const found = await pool.query(
    "SELECT account_id FROM identities WHERE kind='solana' AND subject=$1 AND revoked_at IS NULL",
    [account],
  );
  if (!found.rows.length) throw new RefusedError('No active account is linked to this wallet address.');
  return found.rows[0].account_id;
}

/** Local operator tool. It never contacts a chain or provider; the database comes from CONCLAVE_DATABASE_URL. */
export async function grantFromCli(argv, env = process.env) {
  if (!internalTestingAllowed(env))
    throw new RefusedError(
      'Refused: requires CONCLAVE_INTERNAL_TESTING=true, no production marker, a loopback or sslmode=verify-full CONCLAVE_DATABASE_URL and (if set) a loopback CONCLAVE_APP_ORIGIN.',
    );
  const input = parseGrantArguments(argv);
  const pool = createDatabase(env.CONCLAVE_DATABASE_URL, 2);
  try {
    const accountId = await resolveAccount(pool, input.account);
    const grant = await grantInternalTestCredit(pool, accountId, input.amountUsd6, input.reference);
    const balance = await getBalance(pool, accountId);
    return {
      accountId,
      label: INTERNAL_TEST_CREDIT_LABEL,
      reference: grant.reference,
      amountUsd6: grant.amountUsd6,
      replayed: grant.replayed,
      transactionId: grant.transactionId,
      availableUsd6: balance.availableUsd6,
    };
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await grantFromCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    // Messages are fixed text or service codes; connection details are never printed.
    const message =
      error instanceof RefusedError
        ? error.message
        : error?.code && /^[A-Z_]+$/.test(error.code)
          ? `Grant failed: ${error.code}`
          : 'Grant failed. Check that migrations are applied (pnpm db:migrate).';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
