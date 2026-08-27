import type { Pool } from 'pg';
import {
  jsonResponse,
  readJson,
  stringField,
  uuidField,
} from '../core/http.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';
import { rateLimit } from '../core/rate-limit.ts';
import { rpcBuckets } from './solana.ts';
import { createSolanaReader, SolanaError } from '../solana/index.ts';
import { signature as transactionSignature } from '../solana/validation.ts';
import type { TokenPriceSource } from '../token/price.ts';
import type { TokenDepositEvidence } from '../token/token-deposit.ts';
import {
  sameTokenDepositPolicy,
  tokenDepositCapability,
  tokenDepositConfiguration,
} from '../token/token-deposit-config.ts';
import {
  createOwnedTokenIntent,
  creditTokenDepositEvidence,
  getOwnedTokenDeposit,
  intentPolicy,
  listOwnedTokenDeposits,
  ownedTokenDeposit,
} from '../token/token-deposit-store.ts';

export type TokenEvidenceReader = {
  readDepositEvidence(
    signature: string,
    signal?: AbortSignal,
  ): Promise<TokenDepositEvidence>;
};

export type TokenDepositRouteOptions = {
  /** Overrides the configured price source (tests, future live sources). */
  priceSource?: TokenPriceSource;
  /** Overrides the evidence reader; `null` means none is available. */
  evidenceReader?: TokenEvidenceReader | null;
};

function fields(
  body: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) {
  const keys = Object.keys(body);
  requireCondition(
    required.every((key) => Object.hasOwn(body, key)) &&
      keys.every((key) => required.includes(key) || optional.includes(key)),
    400,
    'INVALID_REQUEST',
    'Only the required request fields are accepted.',
  );
}

/**
 * The default reader needs a public https endpoint, which the shared Solana
 * reader can verify against a pinned genesis hash (devnet today). A localnet
 * http validator has no reader here: callers inject one or get 503.
 */
function defaultEvidenceReader(
  config: ReturnType<typeof tokenDepositConfiguration>,
): TokenEvidenceReader | null {
  if (!config.policy || !config.rpcUrl) return null;
  const cluster = config.policy.cluster;
  if (cluster !== 'devnet' && cluster !== 'mainnet-beta') return null;
  if (!config.rpcUrl.startsWith('https:')) return null;
  return createSolanaReader({ rpcUrl: config.rpcUrl, cluster });
}

/** Called only after session/account binding and the dispatch origin check. */
export async function tokenDepositRoutes(
  pool: Pool,
  request: Request,
  path: string,
  accountId: string,
  options: TokenDepositRouteOptions = {},
): Promise<Response | null> {
  if (!path.startsWith('token/deposits')) return null;
  try {
    if (path === 'token/deposits/capabilities' && request.method === 'GET')
      return jsonResponse(tokenDepositCapability());
    if (path === 'token/deposits' && request.method === 'GET') {
      await rateLimit(pool, `token-deposit-read:${accountId}`, 60);
      const query = new URL(request.url).searchParams;
      requireCondition(
        [...query.keys()].every((key) => key === 'cursor') &&
          query.getAll('cursor').length <= 1,
        400,
        'INVALID_REQUEST',
        'Only one cursor may be supplied.',
      );
      return jsonResponse(
        await listOwnedTokenDeposits(pool, accountId, query.get('cursor')),
      );
    }
    if (path === 'token/deposits' && request.method === 'POST') {
      await rateLimit(pool, `token-deposit-create:${accountId}`, 10);
      const config = tokenDepositConfiguration();
      requireCondition(
        config.capability.configured,
        503,
        'TOKEN_PAYMENTS_DISABLED',
        'Paying with the platform token is not enabled.',
      );
      const body = await readJson(request, 2048);
      fields(body, ['usd6'], ['sourceWallet']);
      const priceSource = options.priceSource ?? config.priceSource;
      requireCondition(
        priceSource,
        503,
        'TOKEN_PRICE_UNAVAILABLE',
        'The token price is unavailable.',
      );
      const result = await createOwnedTokenIntent(pool, {
        accountId,
        usd6: stringField(body, 'usd6', 20),
        sourceWallet: Object.hasOwn(body, 'sourceWallet')
          ? stringField(body, 'sourceWallet', 44)
          : null,
        priceSource,
      });
      return jsonResponse(result, 201);
    }
    const match = /^token\/deposits\/([^/]+)(?:\/(verify))?$/.exec(path);
    if (
      match &&
      ((request.method === 'GET' && !match[2]) ||
        (request.method === 'POST' && match[2]))
    ) {
      const id = uuidField(match[1]).toLowerCase();
      await rateLimit(
        pool,
        `token-deposit-${request.method === 'GET' ? 'read' : 'verify'}:${accountId}`,
        request.method === 'GET' ? 60 : 10,
      );
      // Verification spends configured-RPC quota: same per-client and shared
      // ceilings as the USDC routes, before any reader exists.
      if (request.method === 'POST') await rpcBuckets(pool, request, accountId);
      if (request.method === 'GET')
        return jsonResponse({
          deposit: await getOwnedTokenDeposit(pool, accountId, id),
        });
      const body = await readJson(request, 2048);
      fields(body, ['signature']);
      const signature = transactionSignature(
        stringField(body, 'signature', 88),
      );
      const current = await getOwnedTokenDeposit(pool, accountId, id);
      if (current.settlement) {
        requireCondition(
          current.settlement.signature === signature,
          409,
          'TOKEN_DEPOSIT_ALREADY_CREDITED',
          'This deposit has already been credited from another transaction.',
        );
        return jsonResponse({
          deposit: current,
          credited: true,
          replayed: true,
          transactionId: current.settlement.transactionId,
        });
      }
      const config = tokenDepositConfiguration();
      requireCondition(
        config.capability.configured && config.policy,
        503,
        'TOKEN_PAYMENTS_DISABLED',
        'Paying with the platform token is not enabled.',
      );
      const intent = await ownedTokenDeposit(pool, accountId, id);
      requireCondition(
        sameTokenDepositPolicy(config.policy, intentPolicy(intent)),
        503,
        'TOKEN_DEPOSIT_POLICY_UNAVAILABLE',
        'This deposit’s original network and treasury are not configured.',
      );
      const reader =
        options.evidenceReader === undefined
          ? defaultEvidenceReader(config)
          : options.evidenceReader;
      requireCondition(
        reader,
        503,
        'TOKEN_EVIDENCE_UNAVAILABLE',
        'Token payment verification is not available on this network.',
      );
      const evidence = await reader.readDepositEvidence(
        signature,
        request.signal,
      );
      const result = await creditTokenDepositEvidence(
        pool,
        accountId,
        id,
        evidence,
      );
      return jsonResponse({
        ...result,
        deposit: await getOwnedTokenDeposit(pool, accountId, id),
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
