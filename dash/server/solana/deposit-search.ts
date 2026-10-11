import type { Pool } from 'pg';
import {
  getOwnedDeposit,
  ownedDeposit,
  creditDepositEvidence,
} from './deposit-store.ts';
import { depositConfiguration, sameDepositPolicy } from './deposit-config.ts';
import { createSolanaReader } from './rpc.ts';
import { createPaymentRpc } from './payment-rpc.ts';
import type { DepositEvidence } from './deposit.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';
import { uuidField } from '../core/http.ts';
import {
  record,
  list,
  signature,
  uint,
  requireSolana,
  SolanaError,
} from './validation.ts';

export const DEPOSIT_SEARCH_PAGE_SIZE = 8;
export type DepositSearchReader = {
  readSignaturesForReference: (
    reference: string,
    before: string | null,
    limit: number,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readDepositEvidence: (
    signature: string,
    signal: AbortSignal,
  ) => Promise<DepositEvidence>;
};
export type DepositSearchOptions = {
  signal?: AbortSignal;
  /** Trusted server/test configuration only; no request-supplied RPC endpoint. */
  env?: Record<string, string | undefined>;
  reader?: DepositSearchReader;
  timeoutMs?: number;
};
type PublicDeposit = Awaited<ReturnType<typeof getOwnedDeposit>>;
export type DepositSearchResult = {
  deposit: PublicDeposit;
  credited: boolean;
  replayed: boolean;
  transactionId: string | null;
  search: {
    checked: number;
    nextCursor: string | null;
    status: 'credited' | 'no_match_on_page' | 'incomplete';
    /** An RPC history index can be incomplete; absence is never proof of no payment. */
    exhaustive: false;
  };
};

function decodeCursor(value: unknown, scope: readonly string[]) {
  if (value === undefined || value === null) return null;
  try {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(value))
      throw new Error();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();
    const decoded: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 5 ||
      decoded[0] !== 1 ||
      scope.some((part, i) => decoded[i + 1] !== part)
    )
      throw new Error();
    return signature(decoded[4]);
  } catch {
    throw new ServiceError(
      400,
      'INVALID_CURSOR',
      'This deposit search cursor is invalid.',
    );
  }
}
function encodeCursor(before: string | null, scope: readonly string[]) {
  return before === null
    ? null
    : Buffer.from(JSON.stringify([1, ...scope, before])).toString('base64url');
}
function page(value: unknown, before: string | null) {
  const seen = new Set<string>();
  let previousSlot = Number.MAX_SAFE_INTEGER;
  return list(value, DEPOSIT_SEARCH_PAGE_SIZE).map((raw) => {
    const item = record(raw),
      txid = signature(item.signature),
      slot = uint(item.slot);
    requireSolana(
      !seen.has(txid) && txid !== before && slot <= previousSlot,
      'invalid_response',
    );
    seen.add(txid);
    previousSlot = slot;
    requireSolana(
      Object.hasOwn(item, 'err') &&
        (item.err === null ||
          typeof item.err === 'string' ||
          (typeof item.err === 'object' && !Array.isArray(item.err))),
      'invalid_response',
    );
    requireSolana(
      item.blockTime === null ||
        (typeof item.blockTime === 'number' &&
          Number.isSafeInteger(item.blockTime) &&
          item.blockTime >= 0),
      'invalid_response',
    );
    requireSolana(
      item.confirmationStatus === null ||
        ['processed', 'confirmed', 'finalized'].includes(
          item.confirmationStatus as string,
        ),
      'invalid_response',
    );
    requireSolana(
      item.memo === null ||
        (typeof item.memo === 'string' && item.memo.length <= 2048),
      'invalid_response',
    );
    return { signature: txid, slot, err: item.err };
  });
}
function credited(
  deposit: PublicDeposit,
  checked: number,
  replayed: boolean,
): DepositSearchResult {
  requireCondition(
    deposit.settlement,
    503,
    'DEPOSIT_STATE_UNAVAILABLE',
    'This deposit’s settlement state is unavailable.',
  );
  return {
    deposit,
    credited: true,
    replayed,
    transactionId: deposit.settlement.transactionId,
    search: {
      checked,
      nextCursor: null,
      status: 'credited',
      exhaustive: false,
    },
  };
}
const mismatch = new Set([
  'deposit_mismatch',
  'unsupported_transaction',
  'unsupported_instruction',
  'ambiguous_deposit',
  'invalid_amount',
  'transaction_failed',
]);

/** Reference lookup is discovery only. Credit still requires the complete exact
 * finalized transfer and the existing transactionally unique ledger consumption.
 * No transaction is constructed, signed, broadcast or retried by this function. */
export async function searchOwnedDeposit(
  pool: Pool,
  input: { accountId: string; intentId: string; cursor?: string | null },
  options: DepositSearchOptions = {},
): Promise<DepositSearchResult> {
  const accountId = uuidField(input.accountId).toLowerCase(),
    intentId = uuidField(input.intentId).toLowerCase();
  const current = await getOwnedDeposit(pool, accountId, intentId);
  const scope = [accountId, intentId, current.reference];
  let before = decodeCursor(input.cursor, scope);
  // Known settlement needs no RPC, current network credentials or mutable gate.
  if (current.settlement) return credited(current, 0, true);
  const intent = await ownedDeposit(pool, accountId, intentId),
    config = depositConfiguration(options.env);
  requireCondition(
    config.capability.recoveryConfigured && config.policy && config.rpcUrl,
    503,
    'DEPOSIT_RECOVERY_UNAVAILABLE',
    'Deposit recovery is not configured.',
  );
  requireCondition(
    sameDepositPolicy(config.policy, intent.policy),
    503,
    'DEPOSIT_POLICY_UNAVAILABLE',
    'This deposit’s original network and treasury are not configured for recovery.',
  );
  const timeoutMs = options.timeoutMs ?? 25000;
  requireCondition(
    Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 25000,
    503,
    'DEPOSIT_SEARCH_UNAVAILABLE',
    'Deposit search is unavailable.',
  );
  requireSolana(!options.signal?.aborted, 'cancelled');
  const controller = new AbortController(),
    abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false,
    checked = 0;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const interrupted = () =>
    new SolanaError(timedOut ? 'rpc_timeout' : 'cancelled');
  const wait = <T>(work: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const cancel = () => reject(interrupted());
      if (controller.signal.aborted) {
        void work.catch(() => {});
        cancel();
        return;
      }
      controller.signal.addEventListener('abort', cancel, { once: true });
      work.then(
        (value) => {
          controller.signal.removeEventListener('abort', cancel);
          resolve(value);
        },
        (error) => {
          controller.signal.removeEventListener('abort', cancel);
          reject(error);
        },
      );
    });
  const result = async (
    status: 'no_match_on_page' | 'incomplete',
    next: string | null,
  ): Promise<DepositSearchResult> => {
    const deposit = await getOwnedDeposit(pool, accountId, intentId);
    if (deposit.settlement) return credited(deposit, checked, true);
    return {
      deposit,
      credited: false,
      replayed: false,
      transactionId: null,
      search: {
        checked,
        nextCursor: encodeCursor(next, scope),
        status,
        exhaustive: false,
      },
    };
  };
  try {
    const network = createPaymentRpc({
      rpcUrl: config.rpcUrl,
      cluster: intent.policy.cluster,
    });
    const chain = createSolanaReader({
      rpcUrl: config.rpcUrl,
      cluster: intent.policy.cluster,
    });
    const reader: DepositSearchReader = options.reader ?? {
      async readSignaturesForReference(reference, cursor, limit, signal) {
        await network.verifyGenesis(signal);
        return network.call(
          'getSignaturesForAddress',
          [
            reference,
            {
              commitment: 'finalized',
              limit,
              ...(cursor ? { before: cursor } : {}),
            },
          ],
          signal,
        );
      },
      readDepositEvidence: chain.readDepositEvidence,
    };
    let candidates: ReturnType<typeof page>;
    try {
      candidates = page(
        await wait(
          reader.readSignaturesForReference(
            intent.reference,
            before,
            DEPOSIT_SEARCH_PAGE_SIZE,
            controller.signal,
          ),
        ),
        before,
      );
    } catch (error) {
      if (options.signal?.aborted) throw new SolanaError('cancelled');
      if (
        error instanceof SolanaError &&
        ['wrong_cluster', 'invalid_configuration'].includes(error.code)
      )
        throw error;
      return result('incomplete', before);
    }
    for (const candidate of candidates) {
      let evidence: DepositEvidence;
      try {
        evidence = await wait(
          reader.readDepositEvidence(candidate.signature, controller.signal),
        );
        requireSolana(
          evidence.signature === candidate.signature &&
            record(evidence.transaction).slot === candidate.slot &&
            candidate.err === null,
          'invalid_response',
        );
      } catch (error) {
        if (options.signal?.aborted) throw new SolanaError('cancelled');
        if (
          error instanceof SolanaError &&
          ['wrong_cluster', 'invalid_configuration'].includes(error.code)
        )
          throw error;
        if (
          error instanceof SolanaError &&
          error.code === 'transaction_failed'
        ) {
          checked++;
          before = candidate.signature;
          continue;
        }
        return result('incomplete', before);
      }
      if (options.signal?.aborted) throw new SolanaError('cancelled');
      if (controller.signal.aborted) return result('incomplete', before);
      try {
        const settled = await creditDepositEvidence(
          pool,
          accountId,
          intentId,
          evidence,
        );
        checked++;
        return credited(
          await getOwnedDeposit(pool, accountId, intentId),
          checked,
          settled.replayed,
        );
      } catch (error) {
        if (error instanceof SolanaError && mismatch.has(error.code)) {
          checked++;
          before = candidate.signature;
          continue;
        }
        if (
          error instanceof SolanaError &&
          ['not_finalized', 'invalid_response', 'incomplete_metadata'].includes(
            error.code,
          )
        )
          return result('incomplete', before);
        if (
          error instanceof ServiceError &&
          error.code === 'DEPOSIT_ALREADY_CREDITED'
        ) {
          const deposit = await getOwnedDeposit(pool, accountId, intentId);
          if (deposit.settlement) return credited(deposit, checked, true);
        }
        throw error;
      }
    }
    return result(
      'no_match_on_page',
      candidates.length === DEPOSIT_SEARCH_PAGE_SIZE ? before : null,
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}
