import type { Pool, PoolClient } from 'pg';
import bs58 from 'bs58';
import { one, transaction, type Queryable } from '../db/database.ts';
import { ledgerAccount, post } from '../ledger/ledger.ts';
import { requireCondition } from '../core/errors.ts';
import { readCursor, nextCursor } from '../core/pagination.ts';
import { usd6 as parseUsd6 } from '../ledger/money.ts';
import {
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  address,
} from '../solana/validation.ts';
import { PLATFORM_TOKEN_LABEL, type TokenCluster } from './config.ts';
import {
  TOKEN_PRICE_LIMITS,
  assertUsableQuote,
  type TokenPriceSource,
} from './price.ts';
import {
  quoteTokenDeposit,
  verifyTokenDeposit,
  type TokenDepositEvidence,
} from './token-deposit.ts';
import {
  sameTokenDepositPolicy,
  tokenDepositConfiguration,
  type TokenDepositPolicy,
} from './token-deposit-config.ts';

// Persistence for pay-with-token deposits. Lock order matches the USDC path
// (account owner -> intent -> ledger accounts) so retries never deadlock.

export type StoredTokenDeposit = {
  id: string;
  account_id: string;
  source_wallet: string;
  reference: string;
  cluster: TokenCluster;
  token_mint: string;
  token_program: TokenDepositPolicy['program'];
  decimals: number;
  recipient_wallet: string;
  recipient_token_account: string;
  amount_raw: string;
  usd6: string;
  price_usd6_per_token: string;
  price_source: TokenPriceSource['kind'];
  price_observed_at: Date;
  created_at: Date;
  expires_at: Date;
  state: 'pending' | 'credited' | 'expired';
  credited_signature: string | null;
  credited_slot: string | null;
  ledger_transaction_id: string | null;
};

type TokenDepositEvent = {
  signature: string;
  ledger_transaction_id: string;
  slot: string;
  block_time: string;
  verified_at: Date;
};

const OPEN_INTENT_LIMIT = 20;

async function owner(
  db: Queryable,
  accountId: string,
  exclusive = false,
  requireActive = true,
) {
  const account = await one(
    db,
    `SELECT id FROM accounts WHERE id=$1 AND (NOT $2::boolean OR disabled_at IS NULL) ${exclusive ? 'FOR UPDATE' : 'FOR SHARE'}`,
    [accountId, requireActive],
  );
  requireCondition(
    account,
    404,
    'ACCOUNT_UNAVAILABLE',
    'This account is unavailable.',
  );
}

export function intentPolicy(intent: StoredTokenDeposit): TokenDepositPolicy {
  return {
    cluster: intent.cluster,
    mint: intent.token_mint,
    decimals: intent.decimals,
    program: intent.token_program,
    programId:
      intent.token_program === 'spl-token' ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM,
    recipientWallet: intent.recipient_wallet,
    recipientTokenAccount: intent.recipient_token_account,
  };
}

export async function ownedTokenDeposit(
  db: Queryable,
  accountId: string,
  intentId: string,
) {
  await owner(db, accountId);
  const intent = await one<StoredTokenDeposit>(
    db,
    'SELECT * FROM token_deposit_intents WHERE id=$1 AND account_id=$2',
    [intentId, accountId],
  );
  requireCondition(
    intent,
    404,
    'TOKEN_DEPOSIT_NOT_FOUND',
    'This deposit is unavailable.',
  );
  return intent;
}

function publicTokenDeposit(
  intent: StoredTokenDeposit,
  event: TokenDepositEvent | null,
  now = Date.now(),
) {
  requireCondition(
    (intent.state === 'credited') === (event !== null),
    503,
    'TOKEN_DEPOSIT_STATE_UNAVAILABLE',
    'This deposit’s settlement state is unavailable.',
  );
  const config = tokenDepositConfiguration();
  const credited = intent.state === 'credited' && event !== null;
  const expired = !credited && intent.expires_at.getTime() <= now;
  const policy = intentPolicy(intent);
  return {
    id: intent.id,
    label: PLATFORM_TOKEN_LABEL,
    state: intent.state,
    status: credited
      ? ('credited' as const)
      : expired
        ? ('expired' as const)
        : ('awaiting_payment' as const),
    usd6: intent.usd6,
    amountRaw: intent.amount_raw,
    decimals: intent.decimals,
    price: {
      usd6PerToken: intent.price_usd6_per_token,
      source: intent.price_source,
      observedAt: intent.price_observed_at.toISOString(),
    },
    reference: intent.reference,
    cluster: intent.cluster,
    mint: intent.token_mint,
    program: intent.token_program,
    recipientWallet: intent.recipient_wallet,
    recipientTokenAccount: intent.recipient_token_account,
    sourceWallet: intent.source_wallet,
    createdAt: intent.created_at.toISOString(),
    expiresAt: intent.expires_at.toISOString(),
    paymentWindowOpen:
      !credited &&
      !expired &&
      config.capability.configured &&
      !!config.policy &&
      sameTokenDepositPolicy(config.policy, policy),
    canVerify:
      !credited &&
      config.capability.configured &&
      !!config.policy &&
      sameTokenDepositPolicy(config.policy, policy),
    settlement: event
      ? {
          signature: event.signature,
          transactionId: event.ledger_transaction_id,
          slot: event.slot,
          blockTime: Number(event.block_time),
          verifiedAt: event.verified_at.toISOString(),
        }
      : null,
  };
}

export type TokenDepositView = ReturnType<typeof publicTokenDeposit>;

export async function tokenDepositView(
  db: Queryable,
  intent: StoredTokenDeposit,
  now = Date.now(),
) {
  const event = await one<TokenDepositEvent>(
    db,
    'SELECT signature,ledger_transaction_id,slot,block_time,verified_at FROM token_deposit_events WHERE intent_id=$1',
    [intent.id],
  );
  return publicTokenDeposit(intent, event, now);
}

export async function getOwnedTokenDeposit(
  pool: Pool,
  accountId: string,
  intentId: string,
) {
  return transaction(pool, async (db) =>
    tokenDepositView(db, await ownedTokenDeposit(db, accountId, intentId)),
  );
}

export async function listOwnedTokenDeposits(
  pool: Pool,
  accountId: string,
  cursorValue: string | null,
) {
  return transaction(pool, async (db) => {
    await owner(db, accountId);
    const scope = `token-deposits:${accountId}`,
      cursor = readCursor(cursorValue, scope);
    const rows = await db.query<StoredTokenDeposit & { cursorTime: string }>(
      `SELECT *,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime"
      FROM token_deposit_intents WHERE account_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
      ORDER BY created_at DESC,id DESC LIMIT 21`,
      [accountId, cursor?.time ?? null, cursor?.id ?? null],
    );
    const page = rows.rows.slice(0, 20);
    const events = await db.query<TokenDepositEvent & { intent_id: string }>(
      'SELECT intent_id,signature,ledger_transaction_id,slot,block_time,verified_at FROM token_deposit_events WHERE intent_id=ANY($1::uuid[])',
      [page.map((intent) => intent.id)],
    );
    const settlements = new Map(
      events.rows.map((event) => [event.intent_id, event]),
    );
    return {
      deposits: page.map((intent) =>
        publicTokenDeposit(intent, settlements.get(intent.id) ?? null),
      ),
      nextCursor: nextCursor(rows.rows, 20, scope),
    };
  });
}

/**
 * Quotes at request time with the injected price source and fixes the token
 * amount, the price and the USD6 credit on the intent. The window is the
 * shorter of the configured quote ttl and the price quote's own expiry.
 * With no source wallet given, the account's single verified wallet is used.
 */
export async function createOwnedTokenIntent(
  pool: Pool,
  input: {
    accountId: string;
    usd6: string;
    sourceWallet?: string | null;
    priceSource: TokenPriceSource;
    now?: number;
  },
) {
  const credit = parseUsd6(input.usd6);
  const requestedWallet =
    input.sourceWallet === undefined || input.sourceWallet === null
      ? null
      : address(input.sourceWallet);
  const config = tokenDepositConfiguration();
  requireCondition(
    config.capability.configured &&
      config.policy &&
      config.capability.maximumUsd6,
    503,
    'TOKEN_PAYMENTS_DISABLED',
    'Paying with the platform token is not enabled.',
  );
  const policy = config.policy;
  requireCondition(
    credit <= BigInt(config.capability.maximumUsd6),
    400,
    'TOKEN_DEPOSIT_LIMIT',
    'This amount exceeds the configured token deposit limit.',
  );
  const now = input.now ?? Date.now();
  // Quote before any lock: a slow price source must not hold the account row.
  const quote = assertUsableQuote(await input.priceSource.quote(now), now);
  const terms = quoteTokenDeposit({
    usd6: credit,
    quote,
    decimals: policy.decimals,
  });
  const expiresAtMs = Math.min(
    now + config.capability.quoteTtlMs,
    quote.expiresAtMs,
    now + TOKEN_PRICE_LIMITS.maximumAgeMs,
  );
  requireCondition(
    expiresAtMs > now,
    503,
    'TOKEN_PRICE_STALE',
    'The token price quote is stale or unusable.',
  );
  return transaction(pool, async (db) => {
    await owner(db, input.accountId, true);
    const wallets = await db.query<{ subject: string }>(
      "SELECT subject FROM identities WHERE account_id=$1 AND kind='solana' AND revoked_at IS NULL AND ($2::text IS NULL OR subject=$2) ORDER BY created_at",
      [input.accountId, requestedWallet],
    );
    requireCondition(
      wallets.rows.length > 0,
      403,
      'WALLET_NOT_VERIFIED',
      'Sign in with the source wallet before creating its deposit intent.',
    );
    requireCondition(
      wallets.rows.length === 1,
      400,
      'WALLET_REQUIRED',
      'Choose which verified wallet will send the tokens.',
    );
    const sourceWallet = wallets.rows[0].subject;
    requireCondition(
      ![
        policy.recipientWallet,
        policy.recipientTokenAccount,
        policy.mint,
      ].includes(sourceWallet),
      400,
      'INVALID_DEPOSIT_SOURCE',
      'Use a distinct verified source wallet.',
    );
    const count = await one<{ count: string }>(
      db,
      "SELECT count(*) FROM token_deposit_intents WHERE account_id=$1 AND state='pending' AND expires_at>clock_timestamp()",
      [input.accountId],
    );
    requireCondition(
      Number(count!.count) < OPEN_INTENT_LIMIT,
      409,
      'TOKEN_DEPOSIT_INTENT_LIMIT',
      'Wait for an existing payment window to close before creating another intent.',
    );
    const intent = await one<StoredTokenDeposit>(
      db,
      `INSERT INTO token_deposit_intents(id,account_id,source_wallet,reference,cluster,token_mint,token_program,decimals,
        recipient_wallet,recipient_token_account,amount_raw,usd6,price_usd6_per_token,price_source,price_observed_at,created_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [
        crypto.randomUUID(),
        input.accountId,
        sourceWallet,
        bs58.encode(crypto.getRandomValues(new Uint8Array(32))),
        policy.cluster,
        policy.mint,
        policy.program,
        policy.decimals,
        policy.recipientWallet,
        policy.recipientTokenAccount,
        terms.amountRaw.toString(),
        terms.usd6.toString(),
        terms.priceUsd6PerToken.toString(),
        terms.priceSource,
        new Date(terms.priceObservedAtMs),
        new Date(now),
        new Date(expiresAtMs),
      ],
    );
    requireCondition(
      intent,
      500,
      'TOKEN_DEPOSIT_CREATION_FAILED',
      'The deposit intent could not be created.',
    );
    // The view reports against the real clock, whatever time the quote used.
    return { deposit: await tokenDepositView(db, intent) };
  });
}

async function tokenFloatAccount(client: PoolClient) {
  const float = await one<{ id: string }>(
    client,
    "SELECT id FROM ledger_accounts WHERE owner_id IS NULL AND kind='token_float'",
  );
  requireCondition(
    float,
    503,
    'LEDGER_UNAVAILABLE',
    'The token float ledger account is unavailable.',
  );
  return float;
}

/**
 * Verifies trusted evidence against the intent's fixed terms and credits the
 * quoted usd6 exactly once. A replay of the same transaction returns the prior
 * result; a different transaction for a credited intent, or a transaction
 * already credited elsewhere, is rejected and nothing is credited.
 */
export async function creditTokenDepositEvidence(
  pool: Pool,
  accountId: string,
  intentId: string,
  evidence: TokenDepositEvidence,
) {
  return transaction(pool, async (client) => {
    // Disabling sign-in does not erase an already-received deposit obligation.
    await owner(client, accountId, true, false);
    const intent = await one<StoredTokenDeposit>(
      client,
      'SELECT * FROM token_deposit_intents WHERE id=$1 AND account_id=$2 FOR UPDATE',
      [intentId, accountId],
    );
    requireCondition(
      intent,
      404,
      'TOKEN_DEPOSIT_NOT_FOUND',
      'This deposit is unavailable.',
    );
    const verified = verifyTokenDeposit({
      policy: intentPolicy(intent),
      intent: {
        id: intent.id,
        sourceWallet: intent.source_wallet,
        reference: intent.reference,
        amountRaw: intent.amount_raw,
        createdAtMs: intent.created_at.getTime(),
        expiresAtMs: intent.expires_at.getTime(),
      },
      evidence,
    });
    const previous = await one<{
      event_id: string;
      ledger_transaction_id: string;
    }>(
      client,
      'SELECT event_id,ledger_transaction_id FROM token_deposit_events WHERE intent_id=$1',
      [intentId],
    );
    if (previous) {
      requireCondition(
        previous.event_id === verified.eventId,
        409,
        'TOKEN_DEPOSIT_ALREADY_CREDITED',
        'This deposit has already been credited from another transaction.',
      );
      return {
        credited: true,
        replayed: true,
        transactionId: previous.ledger_transaction_id,
      };
    }
    requireCondition(
      intent.state !== 'credited',
      409,
      'TOKEN_DEPOSIT_UNAVAILABLE',
      'This deposit is no longer awaiting payment.',
    );
    const external = await one(
      client,
      'SELECT event_id FROM token_deposit_events WHERE event_id=$1',
      [verified.eventId],
    );
    requireCondition(
      !external,
      409,
      'TOKEN_DEPOSIT_ALREADY_CREDITED',
      'This transaction has already been credited.',
    );
    const credit = BigInt(intent.usd6);
    const available = await ledgerAccount(client, accountId, 'available');
    const float = await tokenFloatAccount(client);
    const transactionId = await post(
      client,
      `token-deposit:${verified.eventId}`,
      'token_deposit',
      [
        { id: float.id, amount: -credit },
        { id: available.id, amount: credit },
      ],
    );
    await client.query(
      `INSERT INTO token_deposit_events(event_id,intent_id,cluster,signature,instruction_index,amount_raw,ledger_transaction_id,slot,block_time)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        verified.eventId,
        intentId,
        verified.cluster,
        verified.signature,
        verified.instructionIndex,
        verified.amountRaw,
        transactionId,
        verified.slot,
        verified.blockTime,
      ],
    );
    await client.query(
      "UPDATE token_deposit_intents SET state='credited',credited_signature=$2,credited_slot=$3,ledger_transaction_id=$4 WHERE id=$1",
      [intentId, verified.signature, verified.slot, transactionId],
    );
    return { credited: true, replayed: false, transactionId };
  });
}

/** Marks pending intents whose window has closed. Safe to run repeatedly. */
export async function expireTokenDepositIntents(pool: Pool) {
  const result = await pool.query(
    "UPDATE token_deposit_intents SET state='expired' WHERE state='pending' AND expires_at<=clock_timestamp()",
  );
  return { expired: result.rowCount ?? 0 };
}
