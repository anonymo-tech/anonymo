import type { Pool } from 'pg';
import bs58 from 'bs58';
import { one, transaction, type Queryable } from '../db/database.ts';
import { requireCondition } from '../core/errors.ts';
import { uuidField } from '../core/http.ts';
import { ownedDeposit, type StoredDeposit } from './deposit-store.ts';
import { depositConfiguration, sameDepositPolicy } from './deposit-config.ts';
import { createPaymentRpc, type PaymentRpc } from './payment-rpc.ts';
import {
  address,
  amount,
  list,
  record,
  requireSolana,
  uint,
  SOLANA_NETWORKS,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
} from './validation.ts';
import {
  buildDepositTransaction,
  decodeTransactionBase64,
  encodeTransactionBase64,
  validateUnsignedDepositTransaction,
  type DepositTransactionTerms,
} from '../../lib/solana/deposit-transaction.ts';

export type StoredPayment = {
  id: string;
  intent_id: string;
  account_id: string;
  state: 'prepared' | 'submitted' | 'finalized' | 'failed' | 'expired';
  source_token_account: string;
  message_base64: string;
  unsigned_transaction: string;
  recent_blockhash: string;
  last_valid_block_height: string;
  context_slot: string;
  fee_lamports: string;
  prepared_at: Date;
  expires_at: Date;
  signed_transaction: string | null;
  signature: string | null;
  submitted_at: Date | null;
  acknowledged_at: Date | null;
  finalized_at: Date | null;
  failure_code: string | null;
  /** Owned joins used to suppress stale signing UI after manual recovery. */
  intent_state: StoredDeposit['state'];
  intent_expires_at: Date;
  policy: StoredDeposit['policy'];
  settlement_verified_at: Date | null;
  settlement_signature: string | null;
  source_linked: boolean;
};

async function account(db: Queryable, accountId: string, exclusive = false) {
  requireCondition(
    await one(
      db,
      `SELECT id FROM accounts WHERE id=$1 AND disabled_at IS NULL ${exclusive ? 'FOR UPDATE' : 'FOR SHARE'}`,
      [uuidField(accountId).toLowerCase()],
    ),
    404,
    'ACCOUNT_UNAVAILABLE',
    'This account is unavailable.',
  );
}

export async function ownedPayment(
  db: Queryable,
  accountId: string,
  intentId: string,
  exclusive = false,
): Promise<StoredPayment | null> {
  accountId = uuidField(accountId).toLowerCase();
  intentId = uuidField(intentId).toLowerCase();
  await account(db, accountId, exclusive);
  await ownedDeposit(db, accountId, intentId);
  return one<StoredPayment>(
    db,
    `SELECT p.*,i.state AS intent_state,i.expires_at AS intent_expires_at,i.policy,e.verified_at AS settlement_verified_at,e.signature AS settlement_signature,
      EXISTS(SELECT 1 FROM identities identity WHERE identity.account_id=p.account_id AND identity.kind='solana' AND identity.subject=i.source_wallet AND identity.revoked_at IS NULL) AS source_linked
      FROM deposit_payments p JOIN deposit_intents i ON i.id=p.intent_id AND i.account_id=p.account_id
      LEFT JOIN deposit_events e ON e.intent_id=i.id
      WHERE p.intent_id=$1 AND p.account_id=$2 ${exclusive ? 'FOR UPDATE OF p' : 'FOR SHARE OF p'}`,
    [intentId, accountId],
  );
}

export function paymentView(row: StoredPayment, intent?: StoredDeposit) {
  const config = depositConfiguration(),
    now = Date.now();
  const credited = (intent?.state ?? row.intent_state) === 'credited';
  const policy = intent?.policy ?? row.policy;
  const window =
    Math.min(
      row.expires_at.getTime(),
      (intent?.expires_at ?? row.intent_expires_at).getTime(),
    ) > now;
  const enabled =
    !!config.policy &&
    row.source_linked === true &&
    config.capability.walletSubmission &&
    sameDepositPolicy(config.policy, policy);
  const matchedSettlement =
    credited &&
    row.signature !== null &&
    row.signature === row.settlement_signature;
  const state = matchedSettlement
    ? ('finalized' as const)
    : row.state === 'prepared' && !window
      ? ('expired' as const)
      : row.state;
  return {
    id: row.id,
    intentId: row.intent_id,
    state,
    sourceTokenAccount: row.source_token_account,
    messageBase64: row.message_base64,
    unsignedTransaction: row.unsigned_transaction,
    recentBlockhash: row.recent_blockhash,
    lastValidBlockHeight: row.last_valid_block_height,
    contextSlot: row.context_slot,
    feeLamports: row.fee_lamports,
    preparedAt: row.prepared_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    signature: row.signature,
    submittedAt: row.submitted_at?.toISOString() ?? null,
    acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
    finalizedAt:
      (
        row.finalized_at ??
        (matchedSettlement ? row.settlement_verified_at : null)
      )?.toISOString() ?? null,
    failureCode: row.failure_code,
    canSign: !credited && state === 'prepared' && window && enabled,
    canSubmit:
      !credited &&
      (state === 'prepared' || state === 'submitted') &&
      window &&
      enabled,
  };
}
export async function getOwnedPayment(
  pool: Pool,
  accountId: string,
  intentId: string,
) {
  return transaction(pool, async (db) => {
    const row = await ownedPayment(db, accountId, intentId);
    return row ? paymentView(row) : null;
  });
}

export function paymentTerms(
  intent: StoredDeposit,
  row: Pick<StoredPayment, 'source_token_account' | 'recent_blockhash'>,
): DepositTransactionTerms {
  return {
    sourceWallet: intent.source_wallet,
    sourceTokenAccount: row.source_token_account,
    recipientTokenAccount: intent.policy.recipientTokenAccount,
    mint: intent.policy.usdcMint,
    reference: intent.reference,
    amountUsd6: intent.amount_usd6,
    recentBlockhash: row.recent_blockhash,
  };
}
function configured(intent: StoredDeposit) {
  const config = depositConfiguration();
  requireCondition(
    config.capability.walletSubmission && config.policy && config.rpcUrl,
    503,
    'DEPOSIT_PAYMENT_UNAVAILABLE',
    'Preparing a new payment is not configured.',
  );
  requireCondition(
    sameDepositPolicy(config.policy, intent.policy),
    503,
    'DEPOSIT_POLICY_UNAVAILABLE',
    'This deposit’s original network and treasury are not configured.',
  );
  requireSolana(
    intent.policy.usdcMint === SOLANA_NETWORKS[intent.policy.cluster].usdcMint,
    'invalid_configuration',
  );
  return config;
}
function windowOpen(intent: StoredDeposit, row?: StoredPayment) {
  requireCondition(
    intent.state === 'awaiting_payment' &&
      intent.expires_at.getTime() > Date.now() &&
      (!row ||
        (row.state === 'prepared' && row.expires_at.getTime() > Date.now())),
    409,
    'DEPOSIT_PAYMENT_RECOVERY_REQUIRED',
    'This payment attempt is no longer available for signing. Check its saved status or recover an existing payment.',
  );
}
function context(value: unknown, minimum = 0) {
  const result = record(value),
    slot = uint(record(result.context).slot);
  requireSolana(
    slot >= minimum && Object.hasOwn(result, 'value'),
    'invalid_response',
  );
  return { value: result.value, slot };
}
function binaryAccount(value: unknown, length: number, owner: string) {
  const entry = record(value),
    data = list(entry.data, 2);
  requireSolana(
    entry.executable === false &&
      address(entry.owner) === owner &&
      data.length === 2 &&
      data[1] === 'base64',
    'invalid_response',
  );
  uint(entry.lamports);
  if (entry.space !== undefined)
    requireSolana(uint(entry.space) === length, 'invalid_response');
  let bytes: Uint8Array;
  if (length === 0) {
    requireSolana(data[0] === '', 'invalid_response');
    bytes = new Uint8Array();
  } else {
    try {
      bytes = decodeTransactionBase64(data[0]);
    } catch {
      requireSolana(false, 'invalid_response');
    }
  }
  requireSolana(bytes.length === length, 'invalid_response');
  return { bytes, lamports: uint(entry.lamports) };
}
function option(data: DataView, offset: number) {
  const tag = data.getUint32(offset, true);
  requireSolana(tag === 0 || tag === 1, 'invalid_response');
  return tag;
}
function tokenAccount(value: unknown) {
  const { bytes } = binaryAccount(value, 165, TOKEN_PROGRAM),
    data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const delegate = option(data, 72),
    native = option(data, 109);
  option(data, 129);
  requireSolana(bytes[108] <= 2, 'invalid_response');
  return {
    mint: bs58.encode(bytes.subarray(0, 32)),
    owner: bs58.encode(bytes.subarray(32, 64)),
    amount: data.getBigUint64(64, true),
    state: bytes[108],
    delegate,
    native,
    delegatedAmount: data.getBigUint64(121, true),
  };
}
function validSource(
  token: ReturnType<typeof tokenAccount>,
  intent: StoredDeposit,
) {
  return (
    token.mint === intent.policy.usdcMint &&
    token.owner === intent.source_wallet &&
    token.state === 1 &&
    token.native === 0 &&
    token.delegate === 0 &&
    token.delegatedAmount === 0n &&
    token.amount >= amount(intent.amount_usd6, true)
  );
}

/** Current-chain validity check only. Never refreshes a stored blockhash. */
export async function assertPaymentBlockhash(
  rpc: PaymentRpc,
  row: Pick<
    StoredPayment,
    'recent_blockhash' | 'last_valid_block_height' | 'context_slot'
  >,
  signal?: AbortSignal,
) {
  const minContextSlot = Number(row.context_slot);
  requireSolana(Number.isSafeInteger(minContextSlot), 'invalid_response');
  const options = { commitment: 'confirmed', minContextSlot };
  const validity = context(
    await rpc.call('isBlockhashValid', [row.recent_blockhash, options], signal),
    minContextSlot,
  );
  requireSolana(typeof validity.value === 'boolean', 'invalid_response');
  const height = uint(await rpc.call('getBlockHeight', [options], signal));
  requireCondition(
    validity.value && BigInt(height) <= BigInt(row.last_valid_block_height),
    409,
    'DEPOSIT_PAYMENT_RECOVERY_REQUIRED',
    'This payment’s blockhash has expired. Recover an existing payment; a replacement is not created automatically.',
  );
}

/** Reads and simulates only. No private key, wallet signature or broadcast exists
 * in this path. RPC work occurs outside account locks; the final short transaction
 * rechecks ownership, identity, configuration and expiry before the unique insert. */
export async function prepareOwnedPayment(
  pool: Pool,
  accountId: string,
  intentId: string,
  options: { rpc?: PaymentRpc; signal?: AbortSignal } = {},
): Promise<{ payment: ReturnType<typeof paymentView>; replayed: boolean }> {
  accountId = uuidField(accountId).toLowerCase();
  intentId = uuidField(intentId).toLowerCase();
  const snapshot = await transaction(pool, async (db) => {
    const intent = await ownedDeposit(db, accountId, intentId);
    requireCondition(
      await one(
        db,
        "SELECT id FROM identities WHERE account_id=$1 AND kind='solana' AND subject=$2 AND revoked_at IS NULL",
        [accountId, intent.source_wallet],
      ),
      403,
      'WALLET_NOT_VERIFIED',
      'Sign in with the source wallet before preparing its deposit.',
    );
    return { intent, payment: await ownedPayment(db, accountId, intentId) };
  });
  windowOpen(snapshot.intent, snapshot.payment ?? undefined);
  const config = configured(snapshot.intent);
  const rpc =
    options.rpc ??
    createPaymentRpc({
      rpcUrl: config.rpcUrl!,
      cluster: snapshot.intent.policy.cluster,
    });
  requireSolana(
    rpc.cluster === snapshot.intent.policy.cluster,
    'wrong_cluster',
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(25_000)])
    : AbortSignal.timeout(25_000);
  await rpc.verifyGenesis(signal);
  if (snapshot.payment) {
    await assertPaymentBlockhash(rpc, snapshot.payment, signal);
    return transaction(pool, async (db) => {
      await account(db, accountId, true);
      const intent = await ownedDeposit(db, accountId, intentId),
        row = await ownedPayment(db, accountId, intentId);
      requireCondition(
        row && row.id === snapshot.payment!.id,
        409,
        'DEPOSIT_PAYMENT_UNAVAILABLE',
        'The payment attempt is unavailable.',
      );
      configured(intent);
      windowOpen(intent, row);
      requireCondition(
        row.source_linked,
        403,
        'WALLET_NOT_VERIFIED',
        'The deposit source wallet is no longer linked. Recover existing transfers before continuing.',
      );
      validateUnsignedDepositTransaction(
        decodeTransactionBase64(row.unsigned_transaction),
        paymentTerms(intent, row),
      );
      return { payment: paymentView(row, intent), replayed: true };
    });
  }
  const intent = snapshot.intent;
  const latest = context(
    await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }], signal),
  );
  const lifetime = record(latest.value),
    recentBlockhash = address(lifetime.blockhash),
    lastValidBlockHeight = uint(lifetime.lastValidBlockHeight);
  let minimum = latest.slot;
  const sources = context(
    await rpc.call(
      'getTokenAccountsByOwner',
      [
        intent.source_wallet,
        { mint: intent.policy.usdcMint },
        {
          commitment: 'confirmed',
          encoding: 'base64',
          minContextSlot: minimum,
        },
      ],
      signal,
    ),
    minimum,
  );
  minimum = sources.slot;
  const seen = new Set<string>(),
    candidates: string[] = [];
  for (const raw of list(sources.value, 64)) {
    const item = record(raw),
      key = address(item.pubkey);
    requireSolana(!seen.has(key), 'invalid_response');
    seen.add(key);
    if (
      validSource(tokenAccount(item.account), intent) &&
      ![
        intent.source_wallet,
        intent.reference,
        intent.policy.usdcMint,
        intent.policy.recipientTokenAccount,
        intent.policy.recipientWallet,
        TOKEN_PROGRAM,
      ].includes(key)
    )
      candidates.push(key);
  }
  candidates.sort();
  const sourceTokenAccount = candidates[0];
  requireCondition(
    sourceTokenAccount,
    409,
    'DEPOSIT_SOURCE_UNAVAILABLE',
    'No supported existing USDC token account has sufficient balance. No account will be created automatically.',
  );
  const group = context(
    await rpc.call(
      'getMultipleAccounts',
      [
        [
          intent.policy.usdcMint,
          sourceTokenAccount,
          intent.policy.recipientTokenAccount,
          intent.source_wallet,
        ],
        {
          commitment: 'confirmed',
          encoding: 'base64',
          minContextSlot: minimum,
        },
      ],
      signal,
    ),
    minimum,
  );
  minimum = group.slot;
  const values = list(group.value, 4);
  requireSolana(
    values.length === 4 && values.every((value) => value !== null),
    'invalid_response',
  );
  const mint = binaryAccount(values[0], 82, TOKEN_PROGRAM).bytes,
    mintView = new DataView(mint.buffer, mint.byteOffset, mint.byteLength);
  option(mintView, 0);
  option(mintView, 46);
  requireSolana(mint[44] === 6 && mint[45] === 1, 'deposit_mismatch');
  requireCondition(
    validSource(tokenAccount(values[1]), intent),
    409,
    'DEPOSIT_SOURCE_UNAVAILABLE',
    'The selected USDC token account is unavailable or its balance changed.',
  );
  const recipient = tokenAccount(values[2]);
  requireSolana(
    recipient.mint === intent.policy.usdcMint &&
      recipient.owner === intent.policy.recipientWallet &&
      recipient.state === 1 &&
      recipient.native === 0,
    'deposit_mismatch',
  );
  const wallet = binaryAccount(values[3], 0, SYSTEM_PROGRAM);
  const built = buildDepositTransaction({
    sourceWallet: intent.source_wallet,
    sourceTokenAccount,
    recipientTokenAccount: intent.policy.recipientTokenAccount,
    mint: intent.policy.usdcMint,
    reference: intent.reference,
    amountUsd6: intent.amount_usd6,
    recentBlockhash,
  });
  const messageBase64 = encodeTransactionBase64(built.message),
    unsignedTransaction = encodeTransactionBase64(built.unsignedTransaction);
  const fee = context(
    await rpc.call(
      'getFeeForMessage',
      [messageBase64, { commitment: 'confirmed', minContextSlot: minimum }],
      signal,
    ),
    minimum,
  );
  minimum = fee.slot;
  requireCondition(
    fee.value !== null,
    409,
    'DEPOSIT_PAYMENT_RECOVERY_REQUIRED',
    'The payment blockhash is no longer usable.',
  );
  const feeLamports = uint(fee.value, 1_000_000);
  requireSolana(feeLamports > 0, 'invalid_response');
  requireCondition(
    wallet.lamports >= feeLamports,
    409,
    'DEPOSIT_FEE_BALANCE_REQUIRED',
    'The source wallet needs enough SOL for the exact network fee.',
  );
  const simulation = context(
    await rpc.call(
      'simulateTransaction',
      [
        unsignedTransaction,
        {
          commitment: 'confirmed',
          encoding: 'base64',
          sigVerify: false,
          replaceRecentBlockhash: false,
          minContextSlot: minimum,
          innerInstructions: true,
        },
      ],
      signal,
    ),
    minimum,
  );
  minimum = simulation.slot;
  const simulated = record(simulation.value);
  requireSolana(Object.hasOwn(simulated, 'err'), 'invalid_response');
  requireCondition(
    simulated.err === null,
    409,
    'DEPOSIT_SIMULATION_FAILED',
    'The prepared transfer did not pass simulation. Nothing was broadcast.',
  );
  requireSolana(
    simulated.replacementBlockhash === undefined ||
      simulated.replacementBlockhash === null,
    'invalid_response',
  );
  if (
    simulated.innerInstructions !== undefined &&
    simulated.innerInstructions !== null
  )
    requireSolana(
      list(simulated.innerInstructions, 1).every(
        (value) => list(record(value).instructions, 0).length === 0,
      ),
      'unsupported_instruction',
    );
  if (simulated.fee !== undefined && simulated.fee !== null)
    requireSolana(uint(simulated.fee) === feeLamports, 'invalid_response');
  if (simulated.unitsConsumed !== undefined)
    uint(simulated.unitsConsumed, 200_000);
  const prepared = {
    recent_blockhash: recentBlockhash,
    last_valid_block_height: String(lastValidBlockHeight),
    context_slot: String(minimum),
  };
  await assertPaymentBlockhash(rpc, prepared, signal);
  requireSolana(!signal.aborted, 'cancelled');
  const result = await transaction(pool, async (db) => {
    await account(db, accountId, true);
    const current = await ownedDeposit(db, accountId, intentId),
      previous = await ownedPayment(db, accountId, intentId, true);
    configured(current);
    windowOpen(current, previous ?? undefined);
    const identity = await one(
      db,
      "SELECT id FROM identities WHERE account_id=$1 AND kind='solana' AND subject=$2 AND revoked_at IS NULL",
      [accountId, current.source_wallet],
    );
    requireCondition(
      identity,
      403,
      'WALLET_NOT_VERIFIED',
      'Sign in with the source wallet before preparing its deposit.',
    );
    if (previous) {
      // Another preparation won the lock. Return its immutable attempt only;
      // its own current validity must be checked before signing/submission.
      return { payment: paymentView(previous, current), replayed: true };
    }
    requireSolana(!signal.aborted, 'cancelled');
    await db.query(
      `INSERT INTO deposit_payments(id,intent_id,account_id,source_token_account,message_base64,unsigned_transaction,
      recent_blockhash,last_valid_block_height,context_slot,fee_lamports,prepared_at,expires_at)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,at,LEAST(at+interval '90 seconds',$11)
      FROM (SELECT clock_timestamp() AS at) clock`,
      [
        crypto.randomUUID(),
        intentId,
        accountId,
        sourceTokenAccount,
        messageBase64,
        unsignedTransaction,
        recentBlockhash,
        lastValidBlockHeight,
        minimum,
        feeLamports,
        current.expires_at,
      ],
    );
    const row = await ownedPayment(db, accountId, intentId);
    requireCondition(
      row,
      503,
      'DEPOSIT_PAYMENT_UNAVAILABLE',
      'The prepared payment could not be read.',
    );
    return { payment: paymentView(row, current), replayed: false };
  });
  // If a concurrent preparation won, re-read and check that retained blockhash
  // outside the lock instead of returning this losing request's chain snapshot.
  return result.replayed
    ? prepareOwnedPayment(pool, accountId, intentId, { rpc, signal })
    : result;
}
