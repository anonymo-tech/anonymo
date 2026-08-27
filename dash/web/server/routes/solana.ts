import type { Pool } from 'pg';
import { serviceConfig } from '../core/config.ts';
import {
  jsonResponse,
  readJson,
  stringField,
  uuidField,
} from '../core/http.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';
import {
  RPC_CLIENT_LIMIT,
  RPC_GLOBAL_BUCKET,
  RPC_GLOBAL_LIMIT,
  clientBucket,
  rateLimit,
} from '../core/rate-limit.ts';

/**
 * Every branch that spends configured-RPC quota: one client (edge IP, else the
 * account) is throttled first so many cheap accounts from one place cannot
 * multiply RPC spend, then the shared ceiling protects the RPC budget. Both run
 * before any reader is created.
 */
export async function rpcBuckets(pool: Pool, request: Request, accountId: string) {
  await rateLimit(
    pool,
    `solana-rpc:client:${await clientBucket(request, accountId)}`,
    RPC_CLIENT_LIMIT,
  );
  await rateLimit(pool, RPC_GLOBAL_BUCKET, RPC_GLOBAL_LIMIT);
}
import { createSolanaReader, SolanaError } from '../solana/index.ts';
import { signature as transactionSignature } from '../solana/validation.ts';
import {
  creditDepositEvidence,
  createOwnedDeposit,
  getOwnedDeposit,
  listOwnedDeposits,
  ownedDeposit,
} from '../solana/deposit-store.ts';
import {
  depositCapability,
  depositConfiguration,
  sameDepositPolicy,
} from '../solana/deposit-config.ts';
import { depositPaymentRoutes } from './deposit-payments.ts';

function exact(body: Record<string, unknown>, keys: string[]) {
  requireCondition(
    Object.keys(body).length === keys.length &&
      keys.every((key) => Object.hasOwn(body, key)),
    400,
    'INVALID_REQUEST',
    'Only the required request fields are accepted.',
  );
}

export async function solanaRoutes(
  pool: Pool,
  request: Request,
  path: string,
  accountId: string,
): Promise<Response | null> {
  try {
    const payment = await depositPaymentRoutes(pool, request, path, accountId);
    if (payment) return payment;
    if (path === 'deposits/capabilities' && request.method === 'GET')
      return jsonResponse(depositCapability());
    if (path === 'deposits' && request.method === 'GET') {
      await rateLimit(pool, `deposit-read:${accountId}`, 60);
      const query = new URL(request.url).searchParams;
      requireCondition(
        [...query.keys()].every((key) => key === 'cursor') &&
          query.getAll('cursor').length <= 1,
        400,
        'INVALID_REQUEST',
        'Only one cursor may be supplied.',
      );
      return jsonResponse(
        await listOwnedDeposits(pool, accountId, query.get('cursor')),
      );
    }
    if (path === 'deposits' && request.method === 'POST') {
      await rateLimit(pool, `deposit-create:${accountId}`, 10);
      const body = await readJson(request, 2048);
      exact(body, ['amountUsd6', 'sourceWallet', 'idempotencyKey']);
      const result = await createOwnedDeposit(pool, {
        accountId,
        amountUsd6: stringField(body, 'amountUsd6', 20),
        sourceWallet: stringField(body, 'sourceWallet', 44),
        idempotencyKey: stringField(body, 'idempotencyKey', 128),
      });
      return jsonResponse(result, result.replayed ? 200 : 201);
    }
    const match = /^deposits\/([^/]+)(?:\/(reconcile))?$/.exec(path);
    if (
      match &&
      ((request.method === 'GET' && !match[2]) ||
        (request.method === 'POST' && match[2]))
    ) {
      const id = uuidField(match[1]).toLowerCase();
      await rateLimit(
        pool,
        `deposit-${request.method === 'GET' ? 'read' : 'reconcile'}:${accountId}`,
        request.method === 'GET' ? 60 : 10,
      );
      if (request.method === 'POST') await rpcBuckets(pool, request, accountId);
      if (request.method === 'GET')
        return jsonResponse({
          deposit: await getOwnedDeposit(pool, accountId, id),
        });
      const body = await readJson(request, 2048);
      exact(body, ['signature']);
      const signature = transactionSignature(
        stringField(body, 'signature', 88),
      );
      const current = await getOwnedDeposit(pool, accountId, id);
      if (current.settlement) {
        requireCondition(
          current.settlement.signature === signature,
          409,
          'DEPOSIT_ALREADY_CREDITED',
          'This deposit has already been credited from another transaction.',
        );
        return jsonResponse({
          deposit: current,
          credited: true,
          replayed: true,
          transactionId: current.settlement.transactionId,
        });
      }
      const intent = await ownedDeposit(pool, accountId, id),
        config = depositConfiguration();
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
      const reader = createSolanaReader({
        rpcUrl: config.rpcUrl,
        cluster: intent.policy.cluster,
      });
      const evidence = await reader.readDepositEvidence(
        signature,
        request.signal,
      );
      const result = await creditDepositEvidence(pool, accountId, id, evidence);
      return jsonResponse({
        ...result,
        deposit: await getOwnedDeposit(pool, accountId, id),
      });
    }
    if (path === 'pre-sign-inspections' && request.method === 'POST') {
      await rateLimit(pool, `pre-sign-read:${accountId}`, 10);
      await rpcBuckets(pool, request, accountId);
      const config = serviceConfig();
      requireCondition(
        config.rpcUrl && config.cluster,
        503,
        'RPC_UNAVAILABLE',
        'A Solana network is not configured.',
      );
      const body = await readJson(request, 4096);
      exact(body, ['transaction']);
      const transaction = stringField(body, 'transaction', 1644);
      const reader = createSolanaReader({
        rpcUrl: config.rpcUrl,
        cluster: config.cluster,
      });
      return jsonResponse({
        inspection: await reader.readPreSign(transaction, request.signal),
      });
    }
    if (path === 'program-inspections' && request.method === 'POST') {
      await rateLimit(pool, `program-read:${accountId}`, 10);
      await rpcBuckets(pool, request, accountId);
      const config = serviceConfig();
      requireCondition(
        config.rpcUrl && config.cluster,
        503,
        'RPC_UNAVAILABLE',
        'A Solana network is not configured.',
      );
      const body = await readJson(request, 2048);
      exact(body, ['address']);
      const address = stringField(body, 'address', 44);
      const reader = createSolanaReader({
        rpcUrl: config.rpcUrl,
        cluster: config.cluster,
      });
      return jsonResponse({
        program: await reader.readProgram(address, request.signal),
      });
    }
    if (path === 'explanations' && request.method === 'POST') {
      await rateLimit(pool, `explainer-read:${accountId}`, 20);
      await rpcBuckets(pool, request, accountId);
      const config = serviceConfig();
      requireCondition(
        config.rpcUrl && config.cluster,
        503,
        'RPC_UNAVAILABLE',
        'A Solana network is not configured.',
      );
      const body = await readJson(request, 2048);
      exact(body, ['signature']);
      const signature = stringField(body, 'signature', 88);
      // A signature is typed public transaction data, not a free-form model prompt.
      const reader = createSolanaReader({
        rpcUrl: config.rpcUrl,
        cluster: config.cluster,
      });
      return jsonResponse({
        explanation: await reader.readExplanation(signature, request.signal),
      });
    }
    return null;
  } catch (error) {
    if (error instanceof SolanaError)
      throw new ServiceError(
        422,
        `SOLANA_${error.code.toUpperCase()}`,
        error.message,
        ['not_finalized', 'rpc_timeout', 'rpc_unavailable'].includes(
          error.code,
        ),
      );
    throw error;
  }
}
