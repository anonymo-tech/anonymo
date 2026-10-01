// Property tests over the integer money math: micro-USD parsing (money.ts),
// the platform fee / burn share / hold buffer (platform-fee.ts), provider cost
// and usage parsing (gateway/codec.ts), platform token pricing (token/price.ts)
// and the chat quote maximum (routes/call-contract.ts).
//
// Pure: no database, network or environment. Every property runs with the
// fixed seed below and at least 2000 cases, so a failure reproduces exactly.
// Raise the case count with CONCLAVE_PROPERTY_RUNS (never below 2000).
//
//   pnpm test:money-properties
//   CONCLAVE_PROPERTY_RUNS=20000 node --experimental-strip-types scripts/check-money-properties.mjs
//
// Expected values are restated independently here (remainder-based ceilings,
// string-built decimal amounts, scientific notation built from digit strings)
// rather than calling the functions under test.

import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { ServiceError } from '../server/core/errors.ts';
import { ceilRatio, decimalUsd6, usd6 } from '../server/ledger/money.ts';
import {
  HOLD_BUFFER_LIMITS,
  PLATFORM_FEE_LIMITS,
  applyHoldBuffer,
  holdBufferConfig,
  platformFeeConfig,
  priceQuoteMaximum,
  priceWithPlatformFee,
  splitPlatformFee,
} from '../server/ledger/platform-fee.ts';
import {
  cost,
  integer,
  parseExactUsd6,
  parseUsd6,
  usage,
} from '../server/gateway/codec.ts';
import { GatewayError } from '../server/gateway/errors.ts';
import {
  TOKEN_PRICE_LIMITS,
  assertUsableQuote,
  minimumAfterSlippage,
  requirePrice,
  tokenScale,
  tokensForUsd6,
  usd6ForTokens,
  withSlippage,
} from '../server/token/price.ts';
import {
  CHAT_REQUEST_BUDGET_USD6,
  MAX_REASONING_TOKENS,
  quoteMaximum,
} from '../server/routes/call-contract.ts';

/** Fixed so every run explores the same cases; change it deliberately, never per run. */
export const SEED = 20261010;
const requestedRuns = Number(process.env.CONCLAVE_PROPERTY_RUNS ?? '2000');
const RUNS =
  Number.isSafeInteger(requestedRuns) && requestedRuns >= 2000
    ? requestedRuns
    : 2000;
const settings = { seed: SEED, numRuns: RUNS, endOnFailure: true };
/** Synchronous properties only; fails the enclosing test on the first counterexample. */
function check(property) {
  // A synchronous property returns nothing; a promise here would mean an unchecked async property.
  const outcome = fc.assert(property, settings);
  assert.equal(outcome, undefined);
}

const USD6_MAXIMUM = 9_000_000_000_000_000n;
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const TWO_53 = 2n ** 53n;
const TEN_18 = 10n ** 18n;
const BPS = 10_000n;

/** Ceiling restated with an explicit remainder, independent of ceilRatio. */
const ceil = (numerator, denominator) =>
  numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);

function serviceCode(work) {
  try {
    work();
  } catch (error) {
    if (error instanceof ServiceError) return error.code;
    if (error instanceof RangeError) return 'RangeError';
    if (error instanceof GatewayError) return `gateway:${error.code}`;
    throw error;
  }
  return null;
}

// Amounts up to 10^18 with extra weight on the edges that matter for overflow.
const largeAmount = fc.oneof(
  fc.bigInt({ min: 0n, max: TEN_18 }),
  fc.bigInt({ min: 0n, max: 10_000_000n }),
  fc.constantFrom(0n, 1n, 9_999n, 10_000n, SAFE, TWO_53, TWO_53 + 1n, TEN_18),
);
const bps = (maximum) =>
  fc.oneof(
    fc.integer({ min: 0, max: maximum }),
    fc.constantFrom(0, 1, maximum - 1, maximum),
  );
const usd6Base = fc.oneof(
  fc.bigInt({ min: 1n, max: USD6_MAXIMUM }),
  fc.bigInt({ min: 1n, max: 20_000_000n }),
  fc.constantFrom(1n, 9_999n, 10_000n, USD6_MAXIMUM),
);
const invalidBps = fc.oneof(
  fc.integer({ min: -100_000, max: -1 }),
  fc.integer({ min: 10_001, max: 1_000_000 }),
  fc.constantFrom(Number.NaN, Infinity, -Infinity, 0.5, 1.5, 9999.5, -0.5),
);

// ---------------------------------------------------------------- money.ts

void test('usd6 accepts exactly the canonical integer strings in range', () => {
  check(
    fc.property(
      fc.bigInt({ min: 0n, max: 10n ** 17n }),
      fc.boolean(),
      (n, allowZero) => {
        const text = n.toString();
        const valid =
          text.length <= 16 && n <= USD6_MAXIMUM && n >= (allowZero ? 0n : 1n);
        if (valid) assert.equal(usd6(text, allowZero), n);
        else
          assert.equal(
            serviceCode(() => usd6(text, allowZero)),
            'INVALID_AMOUNT',
          );
      },
    ),
  );
  check(
    fc.property(
      fc.oneof(
        fc.string({ maxLength: 24 }),
        fc.bigInt({ min: 1n, max: USD6_MAXIMUM }).map((n) => `0${n}`),
        fc.bigInt({ min: 1n, max: USD6_MAXIMUM }).map((n) => `+${n}`),
        fc.bigInt({ min: 1n, max: USD6_MAXIMUM }).map((n) => `-${n}`),
        fc.bigInt({ min: 1n, max: USD6_MAXIMUM }).map((n) => `${n}.0`),
        fc.bigInt({ min: 1n, max: USD6_MAXIMUM }).map((n) => ` ${n}`),
      ),
      (text) => {
        const canonical =
          /^\d+$/.test(text) && BigInt(text).toString() === text;
        if (!canonical)
          assert.equal(
            serviceCode(() => usd6(text, true)),
            'INVALID_AMOUNT',
          );
      },
    ),
  );
  check(
    fc.property(
      fc.oneof(
        fc.integer(),
        fc.double(),
        fc.bigInt(),
        fc.constant(null),
        fc.constant(undefined),
      ),
      (value) =>
        assert.equal(
          serviceCode(() => usd6(value, true)),
          'INVALID_AMOUNT',
        ),
    ),
  );
});
