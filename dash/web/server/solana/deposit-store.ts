import type { Pool } from 'pg';
import bs58 from 'bs58';
import { one, transaction, type Queryable } from '../db/database.ts';
import { creditVerifiedDepositInTransaction } from '../ledger/ledger.ts';
import { requireCondition } from '../core/errors.ts';
import { digestText } from '../core/digest.ts';
import { readCursor, nextCursor } from '../core/pagination.ts';
import { usd6 } from '../ledger/money.ts';
import {
  verifyUsdcDeposit,
  type DepositEvidence,
  type DepositPolicy,
} from './deposit.ts';
import { address } from './validation.ts';
import {
  DEPOSIT_INTENT_SECONDS,
  depositConfiguration,
  sameDepositPolicy,
} from './deposit-config.ts';

export type StoredDeposit = {
  id: string;
  account_id: string;
  source_wallet: string;
  reference: string;
  amount_usd6: string;
  policy: DepositPolicy;
  state: 'awaiting_payment' | 'credited';
  expires_at: Date;
  created_at: Date;
};

type DepositEvent = {
  signature: string;
  ledger_transaction_id: string;
  slot: string;
  block_time: string;
  verified_at: Date;
};

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

export async function ownedDeposit(
  db: Queryable,
  accountId: string,
  intentId: string,
) {
  await owner(db, accountId);
  const intent = await one<StoredDeposit>(
    db,
    'SELECT * FROM deposit_intents WHERE id=$1 AND account_id=$2',
    [intentId, accountId],
  );
  requireCondition(
    intent,
    404,
    'DEPOSIT_NOT_FOUND',
    'This deposit is unavailable.',
  );
  return intent;
}

export async function depositView(
  db: Queryable,
  intent: StoredDeposit,
  now = Date.now(),
) {
  const event = await one<DepositEvent>(
    db,
    'SELECT signature,ledger_transaction_id,slot,block_time,verified_at FROM deposit_events WHERE intent_id=$1',
    [intent.id],
  );
  return publicDeposit(intent, event, now);
}

function publicDeposit(
  intent: StoredDeposit,
  event: DepositEvent | null,
  now = Date.now(),
) {
  requireCondition(
    (intent.state === 'credited') === (event !== null),
    503,
    'DEPOSIT_STATE_UNAVAILABLE',
    'This deposit’s settlement state is unavailable.',
  );
  const config = depositConfiguration();
  const credited = intent.state === 'credited' && event !== null;
  const expired = intent.expires_at.getTime() <= now;
  return {
    id: intent.id,
    state: intent.state,
    status: credited
      ? ('credited' as const)
      : expired
        ? ('expired' as const)
        : ('awaiting_payment' as const),
    amountUsd6: intent.amount_usd6,
    reference: intent.reference,
    cluster: intent.policy.cluster,
    mint: intent.policy.usdcMint,
    recipientWallet: intent.policy.recipientWallet,
    recipientTokenAccount: intent.policy.recipientTokenAccount,
    sourceWallet: intent.source_wallet,
    createdAt: intent.created_at.toISOString(),
    expiresAt: intent.expires_at.toISOString(),
    paymentWindowOpen:
      !credited &&
      !expired &&
      config.capability.configured &&
      !!config.policy &&
      sameDepositPolicy(config.policy, intent.policy),
    canReconcile:
      !credited &&
      config.capability.recoveryConfigured &&
      !!config.policy &&
      sameDepositPolicy(config.policy, intent.policy),
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

export async function getOwnedDeposit(
  pool: Pool,
  accountId: string,
  intentId: string,
) {
  return transaction(pool, async (db) =>
    depositView(db, await ownedDeposit(db, accountId, intentId)),
  );
}

export async function listOwnedDeposits(
  pool: Pool,
  accountId: string,
  cursorValue: string | null,
) {
  return transaction(pool, async (db) => {
    await owner(db, accountId);
    const scope = `deposits:${accountId}`,
      cursor = readCursor(cursorValue, scope);
    const rows = await db.query<StoredDeposit & { cursorTime: string }>(
      `SELECT *,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime"
      FROM deposit_intents WHERE account_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
      ORDER BY created_at DESC,id DESC LIMIT 21`,
      [accountId, cursor?.time ?? null, cursor?.id ?? null],
    );
    const page = rows.rows.slice(0, 20);
    const events = await db.query<DepositEvent & { intent_id: string }>(
      'SELECT intent_id,signature,ledger_transaction_id,slot,block_time,verified_at FROM deposit_events WHERE intent_id=ANY($1::uuid[])',
      [page.map((intent) => intent.id)],
    );
    const settlements = new Map(
      events.rows.map((event) => [event.intent_id, event]),
    );
    return {
      deposits: page.map((intent) =>
        publicDeposit(intent, settlements.get(intent.id) ?? null),
      ),
      nextCursor: nextCursor(rows.rows, 20, scope),
    };
  });
}

export async function createOwnedDeposit(
  pool: Pool,
  input: {
    accountId: string;
    sourceWallet: string;
    amountUsd6: string;
    idempotencyKey: string;
  },
) {
  const sourceWallet = address(input.sourceWallet),
    amount = usd6(input.amountUsd6);
  requireCondition(
    typeof input.idempotencyKey === 'string' &&
      /^[a-zA-Z0-9_-]{16,128}$/.test(input.idempotencyKey),
    400,
    'INVALID_IDEMPOTENCY_KEY',
    'Use a random idempotency key between 16 and 128 characters.',
  );
  const requestHash = await digestText(
    'deposit-intent',
    JSON.stringify({ sourceWallet, amountUsd6: amount.toString() }),
  );
  return transaction(pool, async (db) => {
    await owner(db, input.accountId, true);
    const previous = await one<{ intent_id: string; request_hash: string }>(
      db,
      'SELECT intent_id,request_hash FROM deposit_intent_requests WHERE account_id=$1 AND idempotency_key=$2',
      [input.accountId, input.idempotencyKey],
    );
    if (previous) {
      requireCondition(
        previous.request_hash === requestHash,
        409,
        'IDEMPOTENCY_CONFLICT',
        'This retry key was already used for different deposit terms.',
      );
      return {
        deposit: await depositView(
          db,
          await ownedDeposit(db, input.accountId, previous.intent_id),
        ),
        replayed: true,
      };
    }
    const config = depositConfiguration();
    requireCondition(
      config.capability.configured &&
        config.policy &&
        config.capability.maximumUsd6,
      503,
      'DEPOSITS_UNAVAILABLE',
      'New Solana deposits are not configured.',
    );
    requireCondition(
      amount <= BigInt(config.capability.maximumUsd6),
      400,
      'DEPOSIT_LIMIT',
      'This amount exceeds the configured deposit limit.',
    );
    requireCondition(
      ![
        config.policy.recipientWallet,
        config.policy.recipientTokenAccount,
        config.policy.usdcMint,
      ].includes(sourceWallet),
      400,
      'INVALID_DEPOSIT_SOURCE',
      'Use a distinct verified source wallet.',
    );
    const identity = await one(
      db,
      "SELECT id FROM identities WHERE account_id=$1 AND kind='solana' AND subject=$2 AND revoked_at IS NULL",
      [input.accountId, sourceWallet],
    );
    requireCondition(
      identity,
      403,
      'WALLET_NOT_VERIFIED',
      'Sign in with the source wallet before creating its deposit intent.',
    );
    const count = await one<{ count: string }>(
      db,
      "SELECT count(*) FROM deposit_intents WHERE account_id=$1 AND state='awaiting_payment' AND expires_at>clock_timestamp()",
      [input.accountId],
    );
    requireCondition(
      Number(count!.count) < 20,
      409,
      'DEPOSIT_INTENT_LIMIT',
      'Wait for an existing payment window to close before creating another intent.',
    );
    const intent = await one<StoredDeposit>(
      db,
      `INSERT INTO deposit_intents(id,account_id,source_wallet,reference,amount_usd6,policy,created_at,expires_at)
      SELECT $1,$2,$3,$4,$5,$6,at,at+($7::integer * interval '1 second') FROM (SELECT date_trunc('second',clock_timestamp()) AS at) clock RETURNING *`,
      [
        crypto.randomUUID(),
        input.accountId,
        sourceWallet,
        bs58.encode(crypto.getRandomValues(new Uint8Array(32))),
        amount.toString(),
        config.policy,
        DEPOSIT_INTENT_SECONDS,
      ],
    );
    requireCondition(
      intent,
      500,
      'DEPOSIT_CREATION_FAILED',
      'The deposit intent could not be created.',
    );
    await db.query(
      'INSERT INTO deposit_intent_requests(account_id,idempotency_key,intent_id,request_hash) VALUES($1,$2,$3,$4)',
      [input.accountId, input.idempotencyKey, intent.id, requestHash],
    );
    return { deposit: await depositView(db, intent), replayed: false };
  });
}

export async function creditDepositEvidence(
  pool: Pool,
  accountId: string,
  intentId: string,
  evidence: DepositEvidence,
) {
  return transaction(pool, async (client) => {
    // Match creation/ledger lock order so recovery cannot deadlock with a retry.
    // Preserve the ledger's trusted settlement policy: disabling sign-in does
    // not erase an already-received deposit obligation. Public reads require active.
    await owner(client, accountId, true, false);
    const intent = await one<StoredDeposit>(
      client,
      'SELECT * FROM deposit_intents WHERE id=$1 AND account_id=$2 FOR UPDATE',
      [intentId, accountId],
    );
    requireCondition(
      intent,
      404,
      'DEPOSIT_NOT_FOUND',
      'This deposit is unavailable.',
    );
    const verified = verifyUsdcDeposit({
      policy: intent.policy,
      intent: {
        id: intent.id,
        sourceWallet: intent.source_wallet,
        reference: intent.reference,
        amountRaw: intent.amount_usd6,
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
      'SELECT event_id,ledger_transaction_id FROM deposit_events WHERE intent_id=$1',
      [intentId],
    );
    if (previous) {
      requireCondition(
        previous.event_id === verified.eventId,
        409,
        'DEPOSIT_ALREADY_CREDITED',
        'This deposit has already been credited from another transaction.',
      );
      return {
        credited: true,
        replayed: true,
        transactionId: previous.ledger_transaction_id,
      };
    }
    requireCondition(
      intent.state === 'awaiting_payment',
      409,
      'DEPOSIT_UNAVAILABLE',
      'This deposit is no longer awaiting payment.',
    );
    const external = await one(
      client,
      'SELECT event_id FROM deposit_events WHERE event_id=$1',
      [verified.eventId],
    );
    requireCondition(
      !external,
      409,
      'DEPOSIT_ALREADY_CREDITED',
      'This transaction has already been credited.',
    );
    const result = await creditVerifiedDepositInTransaction(client, {
      accountId,
      reference: verified.eventId,
      amountUsd6: verified.amountRaw,
    });
    await client.query(
      `INSERT INTO deposit_events(event_id,intent_id,cluster,signature,instruction_index,ledger_transaction_id,slot,block_time)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        verified.eventId,
        intentId,
        verified.cluster,
        verified.signature,
        verified.instructionIndex,
        result.transactionId,
        verified.slot,
        verified.blockTime,
      ],
    );
    await client.query(
      "UPDATE deposit_intents SET state='credited' WHERE id=$1",
      [intentId],
    );
    return {
      credited: true,
      replayed: false,
      transactionId: result.transactionId,
    };
  });
}
