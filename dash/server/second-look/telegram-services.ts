import { collectTokenFacts } from './token-facts.ts';
import { evaluateTokenFacts } from './token-rules.ts';
import { resolveTokenInput } from './input.ts';
import {
  createTokenProviders,
  tokenProviderConfig,
  type TokenProviders,
} from './providers.ts';
import { inspectSignature, transactionBase64 } from './signature.ts';
import { parseSerializedTransaction } from '../solana/serialized.ts';
import { createPaymentRpc } from '../solana/payment-rpc.ts';
import { serviceConfig } from '../core/config.ts';
import { requireCondition } from '../core/errors.ts';
import type { TelegramServices } from './telegram.ts';

/** Telegram consumes the same deterministic facts service. It never invokes
 * quote approval, paid/deep execution, or account-owned report caches. */
export function createTelegramServices(
  options: { providers?: TokenProviders } = {},
): TelegramServices {
  return {
    async token(input, context) {
      const config = options.providers?.config ?? tokenProviderConfig();
      requireCondition(
        config.enabled && config.rpcUrl,
        503,
        'TOKEN_CHECK_UNAVAILABLE',
        'Token checks are not configured.',
      );
      const providers = options.providers ?? createTokenProviders(config);
      const resolved = await resolveTokenInput(
        input,
        context.signal,
        providers,
      );
      requireCondition(
        resolved.status === 'resolved' && resolved.mint,
        400,
        'TOKEN_MINT_REQUIRED',
        'Supply an exact Solana mint; ambiguous tickers and pool links require selection in the web app.',
      );
      const facts = await collectTokenFacts(resolved.mint, {
        providers,
        signal: context.signal,
      });
      const evaluated = evaluateTokenFacts(facts);
      const now = Date.now();
      const fresh = evaluated.checks.filter(
        (check) =>
          check.sources.length > 0 &&
          check.sources.every(
            (source) =>
              Date.parse(source.expiresAt) > now &&
              Date.parse(source.observedAt) <= now,
          ),
      );
      const details = fresh
        .flatMap((check) =>
          check.facts
            .filter((fact) => fact.value !== null)
            .map((fact) => ({ label: fact.label, value: String(fact.value) })),
        )
        .slice(0, 12);
      return {
        title: 'Before You Buy · sourced facts',
        mint: facts.mint,
        observedAt: facts.observedAt,
        facts: details,
        unknowns: evaluated.checks
          .filter(
            (check) => check.status !== 'complete' || !fresh.includes(check),
          )
          .map((check) => check.label)
          .slice(0, 13),
      };
    },
    async firewall(input, signal) {
      const action = /^(\S+)\s+([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(input);
      if (action && /^(?:https:\/\/|solana-action:)/.test(action[1])) {
        const config = serviceConfig();
        requireCondition(
          config.rpcUrl && config.cluster,
          503,
          'RPC_UNAVAILABLE',
          'A Solana reader is not configured.',
        );
        const rpc = createPaymentRpc({
          rpcUrl: config.rpcUrl,
          cluster: config.cluster,
        });
        return inspectSignature(
          { kind: 'action', url: action[1], account: action[2] },
          {
            cluster: config.cluster,
            rpc: (method, params, cancellation) =>
              rpc.call(method, params, cancellation),
            signal,
          },
        );
      }
      if (/^https?:\/\//i.test(input))
        return inspectSignature({ kind: 'domain', url: input }, { signal });
      for (const encoding of ['base64', 'base58'] as const) {
        try {
          parseSerializedTransaction(transactionBase64(input, encoding));
        } catch {
          continue;
        }
        const config = serviceConfig();
        requireCondition(
          config.rpcUrl && config.cluster,
          503,
          'RPC_UNAVAILABLE',
          'A Solana reader is not configured.',
        );
        const rpc = createPaymentRpc({
          rpcUrl: config.rpcUrl,
          cluster: config.cluster,
        });
        return inspectSignature(
          { kind: 'transaction', transaction: input, encoding },
          {
            cluster: config.cluster,
            rpc: (method, params, cancellation) =>
              rpc.call(method, params, cancellation),
            signal,
          },
        );
      }
      return inspectSignature(
        { kind: 'message', message: input, pageOrigin: null },
        { signal },
      );
    },
  };
}
