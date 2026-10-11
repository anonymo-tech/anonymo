import type { Pool } from 'pg';
import { transaction } from '../db/database.ts';
import { ServiceError, requireCondition } from '../core/errors.ts';
import { address } from '../solana/validation.ts';
import { productionEnvironment } from '../ledger/test-credits.ts';
import {
  burnPeriodOverlaps,
  maturedBurnReserveUsd6,
  nextBurnPeriodStart,
  recordBurnExecution,
  requireClosedHour,
  type BurnFundingSource,
  type TokenBurnRecordInput,
} from './burn-ledger.ts';
import { BUYBACK_LIMITS, type BuybackExecutor } from './buyback.ts';
import {
  requireWriteCapableToken,
  type PlatformTokenConfig,
  type PlatformTokenUnavailable,
} from './config.ts';
import type { TokenRpc } from './localnet-rpc.ts';
import { assertUsableQuote, usd6ForTokens, type TokenPriceSource } from './price.ts';
import {
  buildSignedTransaction,
  burnCheckedInstruction,
  type TokenKeypair,
} from './transaction-builder.ts';

// Burn executor. One call settles one closed period: it reads the matured
// reserve, obtains the tokens (bought via the buyback executor, or already
// held for deposit-funded burns), burns exactly that many with `BurnChecked`
// from the burn wallet's own token account, waits for finality, and only then
// records the execution and its immutable token_burns row in one database
// transaction. Every refusal happens before anything is sent:
//   - config.burnEnabled is the kill switch
//   - mainnet-beta is locked (requireWriteCapableToken)
//   - a period already covered by a recorded burn is refused
//   - nothing is ever spent beyond the matured reserve
// If the database write fails after the chain burn finalized, the thrown error
// carries the signatures so an operator can reconcile; the tokens are gone
// either way, which is why the chain step runs last among the fallible steps
// and the record is written immediately after.

const HOUR_MS = 3_600_000;

export type ExecuteBurnInput = {
  pool: Pool;
  config: PlatformTokenConfig | PlatformTokenUnavailable;
  rpc: TokenRpc;
  priceSource: TokenPriceSource;
  /** Burn wallet: owner of `burnTokenAccount`, pays the fee, signs the burn. */
  keypair: TokenKeypair;
  burnTokenAccount: string;
  /** Whole UTC hour that has passed; the period is [previous end, periodEnd). */
  periodEnd: Date;
  funding: BurnFundingSource;
  /** Required for 'buyback-simulation'. */
  buyback?: BuybackExecutor;
  /** Required for 'token-deposits': the deposited tokens to burn. */
  tokensRaw?: bigint;
  slippageBps?: number;
  /** Test clock; the database still requires the period to have closed. */
  nowMs?: number;
};

export type ExecuteBurnResult = {
  id: string;
  ledgerTransactionId: string;
  recordHash: string;
  periodStart: string;
  periodEnd: string;
  maturedUsd6: string;
  spentUsd6: string;
  priceUsd6PerToken: string;
  tokensBoughtRaw: string;
  tokensBurnedRaw: string;
  swapSignature: string | null;
  burnSignature: string;
  finalizedSlot: number;
};

export class BurnRecordingError extends ServiceError {
  readonly burnSignature: string;
  readonly swapSignature: string | null;
  constructor(burnSignature: string, swapSignature: string | null, cause: unknown) {
    super(
      503,
      'TOKEN_BURN_UNRECORDED',
      'The on-chain burn finalized but could not be recorded; reconcile by signature.',
    );
    this.burnSignature = burnSignature;
    this.swapSignature = swapSignature;
    this.cause = cause;
  }
}

export async function executeBurn(input: ExecuteBurnInput): Promise<ExecuteBurnResult> {
  const config = requireWriteCapableToken(input.config);
  requireCondition(
    config.burnEnabled,
    503,
    'TOKEN_BURN_DISABLED',
    'Platform token burns are disabled.',
  );
  // A simulated buyback must never spend the real reserve: no production markers.
  requireCondition(
    !productionEnvironment(),
    503,
    'TOKEN_MAINNET_LOCKED',
    'Platform token burns are not enabled in this environment.',
  );
  requireCondition(
    input.rpc.cluster === config.cluster,
    503,
    'CONFIGURATION_REQUIRED',
    'The burn RPC client is for a different network.',
  );
  const burnTokenAccount = address(input.burnTokenAccount);
  const nowMs = input.nowMs ?? Date.now();
  const periodEnd = requireClosedHour(input.periodEnd, nowMs);
  const slippageBps = input.slippageBps ?? BUYBACK_LIMITS.defaultSlippageBps;
  if (input.funding === 'jupiter')
    throw new ServiceError(
      501,
      'NOT_IMPLEMENTED',
      'A live buyback is not implemented; use the localnet simulation.',
    );
  if (input.funding === 'buyback-simulation')
    requireCondition(
      input.buyback !== undefined && input.buyback.kind === 'simulated-jupiter',
      503,
      'CONFIGURATION_REQUIRED',
      'A buyback simulation needs the simulated executor.',
    );
  if (input.funding === 'token-deposits')
    requireCondition(
      typeof input.tokensRaw === 'bigint' && input.tokensRaw > 0n,
      400,
      'TOKEN_BURN_AMOUNT_INVALID',
      'A deposit-funded burn needs the token amount to burn.',
    );

  // Period and maturity, read before anything leaves this process. A period
  // whose final hour a recorded burn already covers is refused as covered;
  // otherwise the period runs from the previous burn's end (or the first
  // accrual) to periodEnd.
  requireCondition(
    !(await burnPeriodOverlaps(input.pool, new Date(periodEnd.getTime() - HOUR_MS), periodEnd)),
    409,
    'TOKEN_BURN_PERIOD_COVERED',
    'A recorded burn already covers part of this period.',
  );
  const periodStart = await nextBurnPeriodStart(input.pool);
  requireCondition(
    periodStart !== null && periodStart.getTime() < periodEnd.getTime(),
    409,
    'TOKEN_BURN_NOTHING_MATURED',
    'No reserve has matured for this period.',
  );
  requireCondition(
    !(await burnPeriodOverlaps(input.pool, periodStart, periodEnd)),
    409,
    'TOKEN_BURN_PERIOD_COVERED',
    'A recorded burn already covers part of this period.',
  );
  const maturedUsd6 = await maturedBurnReserveUsd6(input.pool, periodEnd, nowMs);
  requireCondition(
    maturedUsd6 > 0n,
    409,
    'TOKEN_BURN_NOTHING_MATURED',
    'No reserve has matured for this period.',
  );

  // The chain must be the configured one and the burn wallet must own the account.
  await input.rpc.getGenesisHash();
  const quote = assertUsableQuote(await input.priceSource.quote(nowMs), nowMs);

  let tokensBoughtRaw = 0n;
  let tokensBurnedRaw: bigint;
  let spentUsd6: bigint;
  let swapSignature: string | null = null;
  if (input.funding === 'buyback-simulation') {
    spentUsd6 = maturedUsd6;
    const swapped = await input.buyback!.swap({ usdcRaw: spentUsd6, quote, slippageBps });
    requireCondition(
      swapped.tokensOutRaw > 0n && swapped.signature !== null,
      409,
      'TOKEN_SWAP_REJECTED',
      'The buyback returned no tokens.',
    );
    tokensBoughtRaw = swapped.tokensOutRaw;
    tokensBurnedRaw = swapped.tokensOutRaw;
    swapSignature = swapped.signature;
  } else {
    // Deposit-funded: the tokens already sit in the burn wallet. The reserve
    // releases their value at the quote price, never more than has matured.
    tokensBurnedRaw = input.tokensRaw!;
    const value = usd6ForTokens(tokensBurnedRaw, quote.priceUsd6PerToken, config.decimals);
    spentUsd6 = value < maturedUsd6 ? value : maturedUsd6;
    requireCondition(
      spentUsd6 > 0n,
      409,
      'TOKEN_BURN_AMOUNT_INVALID',
      'The deposited tokens are worth less than one micro-USD at this price.',
    );
  }

  const held = await input.rpc.getTokenAccountBalance(burnTokenAccount);
  requireCondition(
    held.decimals === config.decimals && held.amountRaw >= tokensBurnedRaw,
    409,
    'TOKEN_BURN_AMOUNT_INVALID',
    'The burn wallet does not hold the tokens to burn.',
  );

  const { blockhash, lastValidBlockHeight } = await input.rpc.getLatestBlockhash();
  const burn = buildSignedTransaction({
    payer: input.keypair,
    recentBlockhash: blockhash,
    instructions: [
      burnCheckedInstruction({
        programId: config.programId,
        tokenAccount: burnTokenAccount,
        mint: config.mint,
        owner: input.keypair.address,
        amountRaw: tokensBurnedRaw,
        decimals: config.decimals,
      }),
    ],
  });
  const burnSignature = await input.rpc.sendTransaction(burn.base64);
  const { slot } = await input.rpc.waitForFinalized(burnSignature, lastValidBlockHeight);

  const record: TokenBurnRecordInput = {
    periodStart,
    periodEnd,
    maturedUsd6,
    spentUsd6,
    funding: input.funding,
    cluster: config.cluster,
    tokenMint: config.mint,
    tokenProgram: config.program,
    tokenDecimals: config.decimals,
    priceUsd6PerToken: quote.priceUsd6PerToken,
    priceSource: quote.source,
    tokensBoughtRaw,
    tokensBurnedRaw,
    swapSignature,
    burnSignature,
    finalizedSlot: slot,
  };
  let recorded: { id: string; ledgerTransactionId: string; recordHash: string };
  try {
    recorded = await transaction(input.pool, (client) => recordBurnExecution(client, record));
  } catch (error) {
    throw new BurnRecordingError(burnSignature, swapSignature, error);
  }
  return {
    ...recorded,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    maturedUsd6: maturedUsd6.toString(),
    spentUsd6: spentUsd6.toString(),
    priceUsd6PerToken: quote.priceUsd6PerToken.toString(),
    tokensBoughtRaw: tokensBoughtRaw.toString(),
    tokensBurnedRaw: tokensBurnedRaw.toString(),
    swapSignature,
    burnSignature,
    finalizedSlot: slot,
  };
}
