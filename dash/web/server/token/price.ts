import { ServiceError, requireCondition } from '../core/errors.ts';
import { ceilRatio } from '../ledger/money.ts';

// Platform token pricing. All arithmetic is integer: USD6 (micro-USD) and raw
// token units (10^decimals per whole token). A price is "USD6 per whole token".
//
// Only a simulated source exists today. It is for localnet tests and the
// buyback simulation; production needs a manipulation-resistant source (pool
// TWAP plus an independent sanity bound) that fails closed when stale. A spot
// aggregator quote on its own is never an acceptable price source.

export type TokenPriceQuote = {
  /** Micro-USD per one whole token. */
  priceUsd6PerToken: bigint;
  source: 'simulated' | 'pool-twap' | 'oracle';
  observedAtMs: number;
  expiresAtMs: number;
  /** Width of the source's own uncertainty band, in basis points. */
  confidenceBps: number;
};

export interface TokenPriceSource {
  readonly kind: TokenPriceQuote['source'];
  quote(nowMs?: number): Promise<TokenPriceQuote>;
}

/** Hard limits every consumer applies regardless of source. */
export const TOKEN_PRICE_LIMITS = Object.freeze({
  /** A quote older than this is stale and must not be used. */
  maximumAgeMs: 15 * 60_000,
  /** Payment quotes expire quickly; the token amount is fixed for this long. */
  defaultQuoteTtlMs: 120_000,
  maximumSlippageBps: 500,
  maximumConfidenceBps: 1_000,
});

const BPS = 10_000n;

function requireBps(value: number, maximum: number) {
  requireCondition(
    Number.isSafeInteger(value) && value >= 0 && value <= maximum,
    503,
    'TOKEN_PRICE_UNAVAILABLE',
    'The token price parameters are invalid.',
  );
  return BigInt(value);
}

export function requirePrice(price: bigint) {
  requireCondition(
    typeof price === 'bigint' && price > 0n && price <= (1n << 63n),
    503,
    'TOKEN_PRICE_UNAVAILABLE',
    'The token price is unavailable.',
  );
  return price;
}

export function tokenScale(decimals: number) {
  requireCondition(
    Number.isSafeInteger(decimals) && decimals >= 0 && decimals <= 9,
    503,
    'CONFIGURATION_REQUIRED',
    'The token decimals are invalid.',
  );
  return 10n ** BigInt(decimals);
}

/** Raw token units needed to cover a USD6 amount at a price; rounds up so the payer never underpays. */
export function tokensForUsd6(
  amountUsd6: bigint,
  priceUsd6PerToken: bigint,
  decimals: number,
) {
  requireCondition(amountUsd6 >= 0n, 400, 'INVALID_AMOUNT', 'The amount is invalid.');
  const price = requirePrice(priceUsd6PerToken);
  return ceilRatio(amountUsd6 * tokenScale(decimals), price);
}

/** USD6 value of raw token units at a price; rounds down so credit never exceeds value. */
export function usd6ForTokens(
  rawAmount: bigint,
  priceUsd6PerToken: bigint,
  decimals: number,
) {
  requireCondition(rawAmount >= 0n, 400, 'INVALID_AMOUNT', 'The amount is invalid.');
  const price = requirePrice(priceUsd6PerToken);
  return (rawAmount * price) / tokenScale(decimals);
}

/** Adds a slippage buffer to a raw token amount (rounds up). */
export function withSlippage(rawAmount: bigint, slippageBps: number) {
  const bps = requireBps(slippageBps, TOKEN_PRICE_LIMITS.maximumSlippageBps);
  return ceilRatio(rawAmount * (BPS + bps), BPS);
}

/** Lower bound after slippage (rounds down); used as a swap's minimum output. */
export function minimumAfterSlippage(rawAmount: bigint, slippageBps: number) {
  const bps = requireBps(slippageBps, TOKEN_PRICE_LIMITS.maximumSlippageBps);
  return (rawAmount * (BPS - bps)) / BPS;
}

/** Rejects stale, expired, future-dated or over-wide quotes. */
export function assertUsableQuote(
  quote: TokenPriceQuote,
  nowMs = Date.now(),
  maximumAgeMs = TOKEN_PRICE_LIMITS.maximumAgeMs,
) {
  requirePrice(quote.priceUsd6PerToken);
  const fresh =
    Number.isSafeInteger(quote.observedAtMs) &&
    Number.isSafeInteger(quote.expiresAtMs) &&
    quote.observedAtMs <= nowMs &&
    nowMs - quote.observedAtMs <= maximumAgeMs &&
    quote.expiresAtMs > nowMs &&
    Number.isSafeInteger(quote.confidenceBps) &&
    quote.confidenceBps >= 0 &&
    quote.confidenceBps <= TOKEN_PRICE_LIMITS.maximumConfidenceBps;
  if (!fresh)
    throw new ServiceError(
      503,
      'TOKEN_PRICE_STALE',
      'The token price quote is stale or unusable.',
    );
  return quote;
}

export type SimulatedPriceOptions = {
  priceUsd6PerToken: bigint;
  /** Optional deterministic per-call drift, applied as +/- bps in sequence. */
  driftSequenceBps?: readonly number[];
  ttlMs?: number;
  confidenceBps?: number;
};

/**
 * Deterministic price for localnet tests and the buyback simulation. It never
 * reads a network. The drift sequence lets tests exercise slippage and stale
 * paths without randomness.
 */
export function createSimulatedPriceSource(
  options: SimulatedPriceOptions,
): TokenPriceSource {
  const base = requirePrice(options.priceUsd6PerToken);
  const drift = options.driftSequenceBps ?? [];
  const ttl = options.ttlMs ?? TOKEN_PRICE_LIMITS.defaultQuoteTtlMs;
  const confidence = options.confidenceBps ?? 0;
  requireBps(confidence, TOKEN_PRICE_LIMITS.maximumConfidenceBps);
  requireCondition(
    Number.isSafeInteger(ttl) && ttl > 0 && ttl <= TOKEN_PRICE_LIMITS.maximumAgeMs,
    503,
    'TOKEN_PRICE_UNAVAILABLE',
    'The simulated price ttl is invalid.',
  );
  let calls = 0;
  return {
    kind: 'simulated',
    async quote(nowMs = Date.now()) {
      const step = drift.length ? drift[calls % drift.length] : 0;
      calls += 1;
      requireCondition(
        Number.isSafeInteger(step) && Math.abs(step) < 10_000,
        503,
        'TOKEN_PRICE_UNAVAILABLE',
        'The simulated drift is invalid.',
      );
      const price = (base * (BPS + BigInt(step))) / BPS;
      return {
        priceUsd6PerToken: requirePrice(price),
        source: 'simulated',
        observedAtMs: nowMs,
        expiresAtMs: nowMs + ttl,
        confidenceBps: confidence,
      };
    },
  };
}
