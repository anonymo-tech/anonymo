import { ServiceError, requireCondition } from '../core/errors.ts';
import { ceilRatio } from '../ledger/money.ts';
import { address } from '../solana/validation.ts';
import {
  requireWriteCapableToken,
  type PlatformTokenConfig,
  type PlatformTokenUnavailable,
} from './config.ts';
import type { TokenRpc } from './localnet-rpc.ts';
import {
  assertUsableQuote,
  minimumAfterSlippage,
  tokenScale,
  tokensForUsd6,
  TOKEN_PRICE_LIMITS,
  type TokenPriceQuote,
} from './price.ts';
import {
  buildSignedTransaction,
  transferCheckedInstruction,
  type TokenKeypair,
} from './transaction-builder.ts';

// Buyback leg of the USDC path: the matured reserve (USD6) is converted into
// platform tokens that the executor then burns. Only a localnet simulation
// exists. Jupiter is mainnet-only, and a real swap is refused until the
// production requirements below are implemented and reviewed.
//
// Production requirements (FLYWHEEL section 10.4), none of which this file
// satisfies:
//   - an independent, manipulation-resistant price (pool TWAP and/or oracle),
//     fresh within 15 minutes; a spot aggregator quote alone is never enough
//   - `minOut` derived from that floor; the swap fails closed below it
//   - a hard cap on price impact per tranche
//   - tranches at randomized times, never one predictable lump
//   - private submission (bundle) to limit MEV
//   - a Squads multisig burn wallet whose job key can only swap and burn within
//     limits, and a kill switch (CONCLAVE_TOKEN_BURN_ENABLED)

export type BuybackSwapInput = {
  /** USDC, 6 decimals, so the raw amount equals the USD6 figure. */
  usdcRaw: bigint;
  quote: TokenPriceQuote;
  slippageBps: number;
};

export type BuybackSwapResult = {
  tokensOutRaw: bigint;
  /** Swap transaction signature; null when nothing was sent. */
  signature: string | null;
  /** usdcRaw / tokensOut as USD6 per whole token, rounded up. */
  effectivePriceUsd6PerToken: bigint;
};

export interface BuybackExecutor {
  readonly kind: 'simulated-jupiter' | 'jupiter';
  swap(input: BuybackSwapInput): Promise<BuybackSwapResult>;
}

export const BUYBACK_LIMITS = Object.freeze({
  /** Default simulated impact: 1 bp per whole USD spent. */
  defaultImpactBpsPerUsd: 1,
  /** Swaps whose simulated impact exceeds this are refused. */
  maximumImpactBps: 300,
  defaultSlippageBps: 50,
});

export type SimulatedJupiterOptions = {
  rpc: TokenRpc;
  config: PlatformTokenConfig | PlatformTokenUnavailable;
  /** Holds the token supply the simulation "sells"; pays its own fee. */
  makerKeypair: TokenKeypair;
  makerTokenAccount: string;
  /** The burn wallet's token account that receives the bought tokens. */
  burnTokenAccount: string;
  /** Linear price impact in basis points per whole USD spent. */
  impactBpsPerUsd?: number;
  maximumImpactBps?: number;
};

/** The simulated impact for an amount: linear in USD, rounded up. */
export function simulatedImpactBps(usdcRaw: bigint, impactBpsPerUsd: number): number {
  requireCondition(
    Number.isSafeInteger(impactBpsPerUsd) && impactBpsPerUsd >= 0 && impactBpsPerUsd <= 10_000,
    503,
    'CONFIGURATION_REQUIRED',
    'The simulated price impact is invalid.',
  );
  requireCondition(usdcRaw >= 0n, 400, 'INVALID_AMOUNT', 'The amount is invalid.');
  return Number(ceilRatio(usdcRaw * BigInt(impactBpsPerUsd), 1_000_000n));
}

/**
 * Pure part of the simulation, shared with tests: how many tokens the quote
 * price yields after impact, and whether that clears the slippage floor.
 */
export function simulatedSwapQuote(input: {
  usdcRaw: bigint;
  quote: TokenPriceQuote;
  slippageBps: number;
  decimals: number;
  impactBpsPerUsd: number;
  maximumImpactBps: number;
}): { expectedRaw: bigint; minimumOutRaw: bigint; impactBps: number; tokensOutRaw: bigint } {
  requireCondition(
    input.usdcRaw > 0n,
    400,
    'INVALID_AMOUNT',
    'A swap amount must be positive.',
  );
  requireCondition(
    Number.isSafeInteger(input.slippageBps) &&
      input.slippageBps >= 0 &&
      input.slippageBps <= TOKEN_PRICE_LIMITS.maximumSlippageBps,
    400,
    'TOKEN_SWAP_REJECTED',
    'The slippage tolerance is out of range.',
  );
  const expectedRaw = tokensForUsd6(input.usdcRaw, input.quote.priceUsd6PerToken, input.decimals);
  const minimumOutRaw = minimumAfterSlippage(expectedRaw, input.slippageBps);
  const impactBps = simulatedImpactBps(input.usdcRaw, input.impactBpsPerUsd);
  if (impactBps > input.maximumImpactBps)
    throw new ServiceError(
      409,
      'TOKEN_SWAP_REJECTED',
      'The swap would exceed the price impact cap.',
    );
  const tokensOutRaw = expectedRaw - ceilRatio(expectedRaw * BigInt(impactBps), 10_000n);
  if (tokensOutRaw <= 0n || tokensOutRaw < minimumOutRaw)
    throw new ServiceError(
      409,
      'TOKEN_SWAP_REJECTED',
      'The swap would return less than the minimum output.',
    );
  return { expectedRaw, minimumOutRaw, impactBps, tokensOutRaw };
}

/**
 * Localnet stand-in for a Jupiter swap. The token leg is real: a maker wallet
 * delivers the bought tokens to the burn wallet with `TransferChecked`, which
 * the validator finalizes. The USDC leg is accounting only - no USDC moves,
 * the "spent" amount is the ledger reserve debit the executor posts. The price
 * is whatever simulated source the caller configured, less a linear impact.
 * Nothing about this resembles market conditions.
 */
export function createSimulatedJupiter(options: SimulatedJupiterOptions): BuybackExecutor {
  const config = requireWriteCapableToken(options.config);
  requireCondition(
    options.rpc.cluster === config.cluster,
    503,
    'CONFIGURATION_REQUIRED',
    'The buyback RPC client is for a different network.',
  );
  const makerTokenAccount = address(options.makerTokenAccount);
  const burnTokenAccount = address(options.burnTokenAccount);
  requireCondition(
    makerTokenAccount !== burnTokenAccount,
    503,
    'CONFIGURATION_REQUIRED',
    'The maker and burn token accounts must differ.',
  );
  const impactBpsPerUsd = options.impactBpsPerUsd ?? BUYBACK_LIMITS.defaultImpactBpsPerUsd;
  const maximumImpactBps = options.maximumImpactBps ?? BUYBACK_LIMITS.maximumImpactBps;
  requireCondition(
    Number.isSafeInteger(maximumImpactBps) &&
      maximumImpactBps >= 0 &&
      maximumImpactBps <= BUYBACK_LIMITS.maximumImpactBps,
    503,
    'CONFIGURATION_REQUIRED',
    'The price impact cap is invalid.',
  );
  simulatedImpactBps(0n, impactBpsPerUsd);
  return {
    kind: 'simulated-jupiter',
    async swap(input) {
      assertUsableQuote(input.quote);
      const plan = simulatedSwapQuote({
        usdcRaw: input.usdcRaw,
        quote: input.quote,
        slippageBps: input.slippageBps,
        decimals: config.decimals,
        impactBpsPerUsd,
        maximumImpactBps,
      });
      // The maker must actually hold what it sells; a short maker is a refusal, not a partial fill.
      const held = await options.rpc.getTokenAccountBalance(makerTokenAccount);
      requireCondition(
        held.decimals === config.decimals && held.amountRaw >= plan.tokensOutRaw,
        409,
        'TOKEN_SWAP_REJECTED',
        'The simulated liquidity cannot fill this swap.',
      );
      const { blockhash, lastValidBlockHeight } = await options.rpc.getLatestBlockhash();
      const transaction = buildSignedTransaction({
        payer: options.makerKeypair,
        recentBlockhash: blockhash,
        instructions: [
          transferCheckedInstruction({
            programId: config.programId,
            source: makerTokenAccount,
            mint: config.mint,
            destination: burnTokenAccount,
            owner: options.makerKeypair.address,
            amountRaw: plan.tokensOutRaw,
            decimals: config.decimals,
          }),
        ],
      });
      const signature = await options.rpc.sendTransaction(transaction.base64);
      await options.rpc.waitForFinalized(signature, lastValidBlockHeight);
      return {
        tokensOutRaw: plan.tokensOutRaw,
        signature,
        effectivePriceUsd6PerToken: ceilRatio(
          input.usdcRaw * tokenScale(config.decimals),
          plan.tokensOutRaw,
        ),
      };
    },
  };
}

/**
 * Placeholder for the real aggregator path. It refuses on every cluster: on
 * mainnet-beta because token transactions are locked there, elsewhere because
 * no aggregator serves test clusters and the production requirements listed
 * at the top of this file are not implemented.
 */
export function createJupiterExecutor(
  config: PlatformTokenConfig | PlatformTokenUnavailable,
): BuybackExecutor {
  if (!config.configured || !config.writeCapable)
    throw new ServiceError(
      503,
      'TOKEN_MAINNET_LOCKED',
      'Platform token transactions are not enabled on this network.',
    );
  throw new ServiceError(
    501,
    'NOT_IMPLEMENTED',
    'A live buyback is not implemented; use the localnet simulation.',
  );
}
