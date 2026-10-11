import type { Pool } from 'pg';
import { one, transaction } from '../db/database.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';
import { ownedDeposit, getOwnedDeposit } from './deposit-store.ts';
import { ownedPayment, getOwnedPayment } from './deposit-payment.ts';
import { depositConfiguration, sameDepositPolicy } from './deposit-config.ts';
import { createPaymentRpc, type PaymentRpc } from './payment-rpc.ts';
import { record, uint } from './validation.ts';
import {
  decodeTransactionBase64,
  encodeTransactionBase64,
  validateSignedDepositTransaction,
} from '../../lib/solana/deposit-transaction.ts';

type SubmitInput = {
  accountId: string;
  intentId: string;
  paymentId: string;
  signedTransaction?: string;
};

/** The only chain-writing deposit operation. Every call requires an explicit
 * authenticated action. A retry relays the same immutable bytes/signature. */
export async function submitOwnedPayment(
  pool: Pool,
  input: SubmitInput,
  options: { rpc?: PaymentRpc; signal?: AbortSignal } = {},
) {
  options.signal?.throwIfAborted();
  const pinned = await transaction(pool, async (db) => {
    // Serialize with deposit settlement and account disabling in the same order.
    requireCondition(
      await one(
        db,
        'SELECT id FROM accounts WHERE id=$1 AND disabled_at IS NULL FOR UPDATE',
        [input.accountId],
      ),
      404,
      'ACCOUNT_UNAVAILABLE',
      'This account is unavailable.',
    );
    const intent = await ownedDeposit(db, input.accountId, input.intentId);
    const payment = await ownedPayment(
      db,
      input.accountId,
      input.intentId,
      true,
    );
    requireCondition(
      payment && payment.id === input.paymentId,
      404,
      'DEPOSIT_PAYMENT_NOT_FOUND',
      'This saved payment is unavailable.',
    );
    let signedTransaction =
      input.signedTransaction ?? payment.signed_transaction;
    requireCondition(
      signedTransaction,
      409,
      'DEPOSIT_SIGNATURE_REQUIRED',
      'This payment has no retained wallet signature.',
    );
    let signature: string;
    try {
      const checked = validateSignedDepositTransaction(
        decodeTransactionBase64(signedTransaction),
        {
          sourceWallet: intent.source_wallet,
          sourceTokenAccount: payment.source_token_account,
          recipientTokenAccount: intent.policy.recipientTokenAccount,
          mint: intent.policy.usdcMint,
          reference: intent.reference,
          amountUsd6: intent.amount_usd6,
          recentBlockhash: payment.recent_blockhash,
        },
      );
      signature = checked.signature;
      signedTransaction = encodeTransactionBase64(checked.signedTransaction);
    } catch {
      throw new ServiceError(
        422,
        'DEPOSIT_SIGNATURE_INVALID',
        'The wallet signature does not match the exact prepared transfer.',
      );
    }
    requireCondition(
      !payment.signed_transaction ||
        (payment.signed_transaction === signedTransaction &&
          payment.signature === signature),
      409,
      'DEPOSIT_SIGNATURE_CHANGED',
      'Another signature is already retained for this payment. Recover that original transfer.',
    );
    if (intent.state === 'credited') return { settled: true as const };
    requireCondition(await one(db, "SELECT id FROM identities WHERE account_id=$1 AND kind='solana' AND subject=$2 AND revoked_at IS NULL", [input.accountId, intent.source_wallet]),
      409, 'DEPOSIT_SOURCE_UNAVAILABLE', 'The deposit source wallet is no longer linked. Recover existing transfers before continuing.');
    const config = depositConfiguration();
    requireCondition(
      config.capability.walletSubmission && config.policy && config.rpcUrl,
      503,
      'DEPOSIT_PAYMENTS_DISABLED',
      'Wallet payment submission is unavailable.',
    );
    requireCondition(
      sameDepositPolicy(config.policy, intent.policy),
      503,
      'DEPOSIT_POLICY_UNAVAILABLE',
      'This payment’s original network and treasury are unavailable.',
    );
    requireCondition(
      ['prepared', 'submitted'].includes(payment.state),
      409,
      'DEPOSIT_PAYMENT_UNAVAILABLE',
      'This payment is available for recovery only.',
    );
    requireCondition(
      payment.expires_at.getTime() > Date.now() &&
        intent.expires_at.getTime() > Date.now(),
      409,
      'DEPOSIT_PAYMENT_EXPIRED',
      'The signing window has closed. Check the original transfer; no replacement was created.',
    );
    options.signal?.throwIfAborted();
    const replayed = payment.signed_transaction !== null;
    if (!replayed) {
      await db.query(
        "UPDATE deposit_payments SET state='submitted',signed_transaction=$2,signature=$3,submitted_at=clock_timestamp() WHERE id=$1",
        [payment.id, signedTransaction, signature],
      );
    }
    return {
      settled: false as const,
      replayed,
      signedTransaction,
      signature,
      recentBlockhash: payment.recent_blockhash,
      lastValidBlockHeight: payment.last_valid_block_height,
      contextSlot: payment.context_slot,
      rpcUrl: config.rpcUrl,
      cluster: intent.policy.cluster,
      policy: intent.policy,
      expiresAtMs: Math.min(
        payment.expires_at.getTime(),
        intent.expires_at.getTime(),
      ),
    };
  });
  let settledBeforeSend = pinned.settled;
  if (!pinned.settled) {
    const rpc =
      options.rpc ??
      createPaymentRpc({ rpcUrl: pinned.rpcUrl, cluster: pinned.cluster });
    requireCondition(
      rpc.cluster === pinned.cluster,
      503,
      'DEPOSIT_POLICY_UNAVAILABLE',
      'The payment network is unavailable.',
    );
    try {
      await rpc.verifyGenesis(options.signal);
      const contextSlot = Number(pinned.contextSlot);
      const valid = record(
        await rpc.call(
          'isBlockhashValid',
          [
            pinned.recentBlockhash,
            { commitment: 'confirmed', minContextSlot: contextSlot },
          ],
          options.signal,
        ),
      );
      requireCondition(
        uint(record(valid.context).slot) >= contextSlot &&
          typeof valid.value === 'boolean',
        503,
        'DEPOSIT_RPC_INVALID',
        'The transaction validity could not be checked.',
      );
      const height = uint(
        await rpc.call(
          'getBlockHeight',
          [{ commitment: 'confirmed', minContextSlot: contextSlot }],
          options.signal,
        ),
      );
      requireCondition(
        valid.value && BigInt(height) <= BigInt(pinned.lastValidBlockHeight),
        409,
        'DEPOSIT_PAYMENT_EXPIRED',
        'The original blockhash expired. Recover the original transfer; no replacement was created.',
      );
      // Keep the signed pin committed separately. The final bounded send holds
      // the account lock so settlement/disable cannot race this dispatch.
      settledBeforeSend = await transaction(pool, async (db) => {
        requireCondition(
          await one(
            db,
            'SELECT id FROM accounts WHERE id=$1 AND disabled_at IS NULL FOR UPDATE',
            [input.accountId],
          ),
          404,
          'ACCOUNT_UNAVAILABLE',
          'This account is unavailable.',
        );
        const intent = await ownedDeposit(db, input.accountId, input.intentId);
        const saved = await ownedPayment(
          db,
          input.accountId,
          input.intentId,
          true,
        );
        requireCondition(
          saved &&
            saved.id === input.paymentId &&
            saved.signature === pinned.signature &&
            saved.signed_transaction === pinned.signedTransaction,
          409,
          'DEPOSIT_SIGNATURE_CHANGED',
          'The saved signature changed. Recover the original payment.',
        );
        if (intent.state === 'credited') return true;
        requireCondition(await one(db, "SELECT id FROM identities WHERE account_id=$1 AND kind='solana' AND subject=$2 AND revoked_at IS NULL", [input.accountId, intent.source_wallet]),
          409, 'DEPOSIT_SOURCE_UNAVAILABLE', 'The deposit source wallet is no longer linked. Recover existing transfers before continuing.');
        requireCondition(
          saved.state === 'submitted',
          409,
          'DEPOSIT_PAYMENT_UNAVAILABLE',
          'This payment is available for recovery only.',
        );
        const current = depositConfiguration();
        requireCondition(
          current.capability.walletSubmission &&
            current.rpcUrl === pinned.rpcUrl &&
            current.policy &&
            sameDepositPolicy(current.policy, pinned.policy) &&
            sameDepositPolicy(intent.policy, pinned.policy),
          503,
          'DEPOSIT_PAYMENTS_DISABLED',
          'Wallet payment submission is unavailable.',
        );
        requireCondition(
          pinned.expiresAtMs > Date.now(),
          409,
          'DEPOSIT_PAYMENT_EXPIRED',
          'The signing window has closed. Recover the original transfer; no replacement was created.',
        );
        options.signal?.throwIfAborted();
        const sendSignal = options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)])
          : AbortSignal.timeout(10000);
        const accepted = await rpc.call(
          'sendTransaction',
          [
            pinned.signedTransaction,
            {
              encoding: 'base64',
              skipPreflight: false,
              preflightCommitment: 'confirmed',
              maxRetries: 0,
              minContextSlot: contextSlot,
            },
          ],
          sendSignal,
        );
        requireCondition(
          accepted === pinned.signature,
          503,
          'DEPOSIT_SUBMISSION_UNCERTAIN',
          'The original signature is retained. Read its status before continuing.',
        );
        await db.query(
          "UPDATE deposit_payments SET acknowledged_at=clock_timestamp() WHERE id=$1 AND signature=$2 AND acknowledged_at IS NULL AND state='submitted'",
          [input.paymentId, pinned.signature],
        );
        return false;
      });
    } catch (error) {
      // The bytes were durably pinned before any network call. RPC errors and
      // cancellation cannot clear them or authorize a fresh transaction.
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(
        503,
        'DEPOSIT_SUBMISSION_UNCERTAIN',
        'The original signature is retained. Check it or explicitly resend that same transfer.',
        true,
      );
    }
  }
  const [payment, deposit] = await Promise.all([
    getOwnedPayment(pool, input.accountId, input.intentId),
    getOwnedDeposit(pool, input.accountId, input.intentId),
  ]);
  return {
    payment,
    deposit,
    submitted: settledBeforeSend || !!payment?.acknowledgedAt,
    replayed: settledBeforeSend || pinned.settled || pinned.replayed,
  };
}
