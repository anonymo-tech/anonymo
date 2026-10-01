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

void test('decimal USD converts exactly to micro-USD or fails closed', () => {
  check(
    fc.property(
      fc.bigInt({ min: 0n, max: 9_999_999_999n }),
      fc.integer({ min: 0, max: 6 }),
      fc.integer({ min: 0, max: 999_999 }),
      (whole, places, raw) => {
        const fraction =
          places === 0 ? '' : String(raw % 10 ** places).padStart(places, '0');
        const text = places === 0 ? whole.toString() : `${whole}.${fraction}`;
        const expected =
          whole * 1_000_000n + BigInt(fraction.padEnd(6, '0') || '0');
        if (expected <= USD6_MAXIMUM) assert.equal(decimalUsd6(text), expected);
        else
          assert.equal(
            serviceCode(() => decimalUsd6(text)),
            'INVALID_AMOUNT',
          );
      },
    ),
  );
  check(
    fc.property(
      fc.bigInt({ min: 0n, max: 9_999n }),
      fc.stringMatching(/^[0-9]{7,12}$/),
      (whole, fraction) =>
        assert.equal(
          serviceCode(() => decimalUsd6(`${whole}.${fraction}`)),
          'INVALID_AMOUNT',
        ),
    ),
  );
});

void test('ceilRatio is the least integer bound and rejects invalid ratios', () => {
  check(
    fc.property(
      largeAmount,
      fc.oneof(
        fc.bigInt({ min: 1n, max: TEN_18 }),
        fc.bigInt({ min: 1n, max: 20_000n }),
      ),
      (n, d) => {
        const q = ceilRatio(n, d);
        assert.ok(q * d >= n);
        assert.ok(q === 0n || (q - 1n) * d < n);
        assert.equal(q, ceil(n, d));
        assert.equal(q === 0n, n === 0n);
      },
    ),
  );
  check(
    fc.property(
      fc.bigInt({ min: -TEN_18, max: -1n }),
      fc.bigInt({ min: -TEN_18, max: 0n }),
      (negative, nonPositive) => {
        assert.throws(() => ceilRatio(negative, 1n), RangeError);
        assert.throws(() => ceilRatio(1n, nonPositive), RangeError);
      },
    ),
  );
});

// ---------------------------------------------------------- platform-fee.ts

void test('the fee never exceeds its rate and the burn never falls below its share', () => {
  check(
    fc.property(
      largeAmount,
      bps(10_000),
      bps(10_000),
      (base, feeBps, shareBps) => {
        const split = splitPlatformFee(base, feeBps, shareBps);
        const rate = base * BigInt(feeBps);
        // Fee: the greatest integer at or under base x rate.
        assert.ok(split.platformFeeUsd6 * BPS <= rate);
        assert.ok((split.platformFeeUsd6 + 1n) * BPS > rate);
        // Burn: the least integer at or over fee x share.
        const share = split.platformFeeUsd6 * BigInt(shareBps);
        assert.ok(split.burnReserveUsd6 * BPS >= share);
        assert.ok(
          split.burnReserveUsd6 === 0n ||
            (split.burnReserveUsd6 - 1n) * BPS < share,
        );
        // Consistency of the parts.
        assert.ok(split.burnReserveUsd6 <= split.platformFeeUsd6);
        assert.ok(split.retainedFeeUsd6 >= 0n);
        assert.equal(
          split.burnReserveUsd6 + split.retainedFeeUsd6,
          split.platformFeeUsd6,
        );
        assert.equal(split.totalUsd6, base + split.platformFeeUsd6);
        assert.equal(split.baseUsd6, base);
        if (shareBps === 10_000) assert.equal(split.retainedFeeUsd6, 0n);
        if (shareBps === 0) assert.equal(split.burnReserveUsd6, 0n);
      },
    ),
  );
});

void test('fee, burn and total are monotonic in the base', () => {
  check(
    fc.property(
      largeAmount,
      largeAmount,
      bps(10_000),
      bps(10_000),
      (a, b, feeBps, shareBps) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        const x = splitPlatformFee(low, feeBps, shareBps);
        const y = splitPlatformFee(high, feeBps, shareBps);
        assert.ok(x.platformFeeUsd6 <= y.platformFeeUsd6);
        assert.ok(x.burnReserveUsd6 <= y.burnReserveUsd6);
        assert.ok(x.totalUsd6 <= y.totalUsd6);
        if (low < high) assert.ok(x.totalUsd6 < y.totalUsd6);
      },
    ),
  );
});

void test('a settlement within the quoted maximum never charges more fee than was quoted', () => {
  check(
    fc.property(
      usd6Base,
      fc.bigInt({ min: 0n, max: USD6_MAXIMUM }),
      bps(PLATFORM_FEE_LIMITS.maximumPlatformFeeBps),
      bps(PLATFORM_FEE_LIMITS.maximumBurnShareBps),
      (quotedBase, raw, feeBps, shareBps) => {
        const settledBase = raw % (quotedBase + 1n);
        const config = { platformFeeBps: feeBps, burnShareBps: shareBps };
        const priced = priceWithPlatformFee(quotedBase.toString(), { config });
        const settled = splitPlatformFee(settledBase, feeBps, shareBps);
        if (feeBps === 0) {
          assert.equal(priced.platformFee, null);
          assert.equal(priced.maximumUsd6, quotedBase.toString());
          return;
        }
        const terms = priced.platformFee;
        assert.equal(terms.baseMaximumUsd6, quotedBase.toString());
        assert.equal(
          BigInt(terms.platformFeeMaximumUsd6),
          (quotedBase * BigInt(feeBps)) / BPS,
        );
        assert.equal(
          BigInt(priced.maximumUsd6),
          quotedBase + BigInt(terms.platformFeeMaximumUsd6),
        );
        assert.ok(
          settled.platformFeeUsd6 <= BigInt(terms.platformFeeMaximumUsd6),
        );
        assert.ok(
          settled.burnReserveUsd6 <= BigInt(terms.burnReserveMaximumUsd6),
        );
        assert.ok(settled.totalUsd6 <= BigInt(priced.maximumUsd6));
        // Settling the full quoted base reproduces the quote exactly.
        assert.equal(
          splitPlatformFee(quotedBase, feeBps, shareBps).totalUsd6,
          BigInt(priced.maximumUsd6),
        );
      },
    ),
  );
});

void test('the hold buffer never reserves below the base and stays within its bound', () => {
  check(
    fc.property(
      usd6Base,
      bps(HOLD_BUFFER_LIMITS.maximumHoldBufferBps),
      (base, bufferBps) => {
        const { bufferedBaseMaximumUsd6, reservation } = applyHoldBuffer(
          base.toString(),
          {
            holdBufferBps: bufferBps,
          },
        );
        const buffered = BigInt(bufferedBaseMaximumUsd6);
        assert.ok(buffered >= base);
        assert.equal(buffered, base + ceil(base * BigInt(bufferBps), BPS));
        assert.ok(buffered - base <= ceil(base * 2000n, BPS));
        if (bufferBps === 0) assert.equal(reservation, null);
        else
          assert.deepEqual(reservation, {
            bufferBps,
            baseMaximumUsd6: base.toString(),
            bufferedBaseMaximumUsd6,
          });
      },
    ),
  );
  check(
    fc.property(usd6Base, usd6Base, bps(2000), bps(2000), (a, b, p, q) => {
      const [low, high] = a <= b ? [a, b] : [b, a];
      const [few, many] = p <= q ? [p, q] : [q, p];
      const value = (base, bufferBps) =>
        BigInt(
          applyHoldBuffer(base.toString(), { holdBufferBps: bufferBps })
            .bufferedBaseMaximumUsd6,
        );
      assert.ok(value(low, few) <= value(high, few));
      assert.ok(value(low, few) <= value(low, many));
    }),
  );
});

void test('direct fee, share and buffer settings outside their bounds throw', () => {
  check(
    fc.property(
      largeAmount,
      invalidBps,
      bps(10_000),
      fc.boolean(),
      (base, bad, good, feeSide) => {
        assert.equal(
          serviceCode(() =>
            feeSide
              ? splitPlatformFee(base, bad, good)
              : splitPlatformFee(base, good, bad),
          ),
          'RangeError',
        );
      },
    ),
  );
  check(
    fc.property(
      fc.oneof(
        fc.bigInt({ min: -TEN_18, max: -1n }),
        fc.integer({ min: 0, max: 1000 }),
        fc.constant('1'),
      ),
      bps(10_000),
      (base, rate) =>
        assert.equal(
          serviceCode(() => splitPlatformFee(base, rate, rate)),
          'RangeError',
        ),
    ),
  );
  check(
    fc.property(
      usd6Base,
      fc.oneof(
        fc.integer({ min: 2001, max: 1_000_000 }),
        fc.integer({ min: -1_000_000, max: -1 }),
        fc.constantFrom(Number.NaN, 0.5, 1999.5, Infinity),
      ),
      (base, bad) =>
        assert.equal(
          serviceCode(() =>
            applyHoldBuffer(base.toString(), { holdBufferBps: bad }),
          ),
          'RangeError',
        ),
    ),
  );
});

void test('environment settings parse exactly when canonical and in range', () => {
  const setting = fc.oneof(
    fc.integer({ min: 0, max: 99_999 }).map(String),
    fc.integer({ min: 0, max: 20_000 }).map(String),
    fc.string({ maxLength: 8 }),
    fc.constantFrom(
      undefined,
      '',
      '0',
      '00',
      '01',
      '-1',
      '-0',
      '1.0',
      ' 1',
      '1 ',
      '1e3',
      '0x10',
      '2000',
      '2001',
      '10000',
      '10001',
      '100000',
    ),
  );
  const expected = (value, maximum) => {
    if (value === undefined || value === '') return 0;
    const number = Number(value);
    const canonical =
      value.length <= 5 &&
      Number.isSafeInteger(number) &&
      number >= 0 &&
      String(number) === value;
    return canonical && number <= maximum ? number : 'CONFIGURATION_REQUIRED';
  };
  check(
    fc.property(setting, setting, setting, (fee, share, buffer) => {
      const env = {
        CONCLAVE_PLATFORM_FEE_BPS: fee,
        CONCLAVE_BURN_SHARE_BPS: share,
        CONCLAVE_HOLD_BUFFER_BPS: buffer,
      };
      const feeExpected = expected(
        fee,
        PLATFORM_FEE_LIMITS.maximumPlatformFeeBps,
      );
      const shareExpected = expected(
        share,
        PLATFORM_FEE_LIMITS.maximumBurnShareBps,
      );
      const bufferExpected = expected(
        buffer,
        HOLD_BUFFER_LIMITS.maximumHoldBufferBps,
      );
      if (
        feeExpected === 'CONFIGURATION_REQUIRED' ||
        shareExpected === 'CONFIGURATION_REQUIRED'
      )
        assert.equal(
          serviceCode(() => platformFeeConfig(env)),
          'CONFIGURATION_REQUIRED',
        );
      else
        assert.deepEqual(platformFeeConfig(env), {
          platformFeeBps: feeExpected,
          burnShareBps: shareExpected,
        });
      if (bufferExpected === 'CONFIGURATION_REQUIRED')
        assert.equal(
          serviceCode(() => holdBufferConfig(env)),
          'CONFIGURATION_REQUIRED',
        );
      else
        assert.deepEqual(holdBufferConfig(env), {
          holdBufferBps: bufferExpected,
        });
    }),
  );
});

void test('the priced quote maximum is buffered base plus fee and throws exactly above its limit', () => {
  check(
    fc.property(
      fc.oneof(usd6Base, fc.bigInt({ min: 1n, max: 12_000_000n })),
      bps(PLATFORM_FEE_LIMITS.maximumPlatformFeeBps),
      bps(PLATFORM_FEE_LIMITS.maximumBurnShareBps),
      bps(HOLD_BUFFER_LIMITS.maximumHoldBufferBps),
      fc.option(
        fc.oneof(
          fc.bigInt({ min: 0n, max: 20_000_000n }),
          fc.bigInt({ min: 0n, max: TEN_18 }),
        ),
        { nil: undefined },
      ),
      (base, feeBps, shareBps, bufferBps, limitUsd6) => {
        const buffered = base + ceil(base * BigInt(bufferBps), BPS);
        const fee = (buffered * BigInt(feeBps)) / BPS;
        const total = buffered + fee;
        const options = {
          limitUsd6,
          config: { platformFeeBps: feeBps, burnShareBps: shareBps },
          buffer: { holdBufferBps: bufferBps },
        };
        const outcome = serviceCode(() =>
          priceQuoteMaximum(base.toString(), options),
        );
        if (buffered > USD6_MAXIMUM) {
          // A buffered base past the money range fails closed, never wraps.
          assert.equal(outcome, 'INVALID_AMOUNT');
          return;
        }
        if (limitUsd6 !== undefined && total > limitUsd6) {
          assert.equal(outcome, 'REQUEST_BUDGET_EXCEEDED');
          return;
        }
        assert.equal(outcome, null);
        const priced = priceQuoteMaximum(base.toString(), options);
        assert.equal(BigInt(priced.maximumUsd6), total);
        assert.ok(
          limitUsd6 === undefined || BigInt(priced.maximumUsd6) <= limitUsd6,
        );
        if (feeBps === 0) assert.equal(priced.platformFee, null);
        else {
          assert.equal(BigInt(priced.platformFee.baseMaximumUsd6), buffered);
          assert.equal(BigInt(priced.platformFee.platformFeeMaximumUsd6), fee);
          assert.equal(
            BigInt(priced.platformFee.burnReserveMaximumUsd6),
            ceil(fee * BigInt(shareBps), BPS),
          );
        }
        assert.equal(priced.reservation === null, bufferBps === 0);
      },
    ),
  );
  check(
    fc.property(
      fc.bigInt({ min: 1n, max: 5_000_000n }),
      fc.bigInt({ min: 1n, max: 5_000_000n }),
      bps(2000),
      bps(10_000),
      bps(2000),
      (a, b, feeBps, shareBps, bufferBps) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        const options = {
          config: { platformFeeBps: feeBps, burnShareBps: shareBps },
          buffer: { holdBufferBps: bufferBps },
        };
        assert.ok(
          BigInt(priceQuoteMaximum(low.toString(), options).maximumUsd6) <=
            BigInt(priceQuoteMaximum(high.toString(), options).maximumUsd6),
        );
      },
    ),
  );
});

// ------------------------------------------------------------- gateway/codec.ts

/** A decimal string for micro-USD `micro` with `extra` sub-micro digits appended. */
function decimalText(micro, extra) {
  const whole = (micro / 1_000_000n).toString();
  const fraction = (micro % 1_000_000n).toString().padStart(6, '0') + extra;
  return { text: `${whole}.${fraction}`, whole, fraction };
}
/** The same value in scientific notation, built from its significant digits. */
function scientificText(whole, fraction) {
  // value = digits x 10^-fraction.length dollars = d.ddd x 10^(digits.length - 1 - fraction.length)
  const digits = (whole + fraction).replace(/^0+/, '');
  if (!digits) return null;
  const mantissa =
    digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  return `${mantissa}e${digits.length - 1 - fraction.length}`;
}

void test('provider costs round up to the next micro-dollar and exact prices reject sub-micro precision', () => {
  check(
    fc.property(
      fc.oneof(
        fc.bigInt({ min: 0n, max: SAFE + 10n }),
        fc.bigInt({ min: 0n, max: 100_000n }),
      ),
      fc.oneof(fc.constant(''), fc.stringMatching(/^[0-9]{1,12}$/)),
      fc.boolean(),
      (micro, extra, scientific) => {
        const { text, whole, fraction } = decimalText(micro, extra);
        const value = scientific
          ? (scientificText(whole, fraction) ?? text)
          : text;
        const remainder = /[1-9]/.test(extra);
        const rounded = micro + (remainder ? 1n : 0n);
        if (rounded > SAFE)
          assert.equal(
            serviceCode(() => parseUsd6(value)),
            'RangeError',
          );
        else {
          const parsed = parseUsd6(value);
          assert.ok(Number.isSafeInteger(parsed));
          assert.equal(BigInt(parsed), rounded);
        }
        if (remainder || micro > SAFE)
          assert.equal(
            serviceCode(() => parseExactUsd6(value)),
            'RangeError',
          );
        else assert.equal(BigInt(parseExactUsd6(value)), micro);
      },
    ),
  );
});

void test('provider cost parsing is monotonic and never returns an unsafe number', () => {
  check(
    fc.property(
      fc.bigInt({ min: 0n, max: SAFE }),
      fc.bigInt({ min: 0n, max: SAFE }),
      fc.stringMatching(/^[0-9]{0,9}$/),
      fc.stringMatching(/^[0-9]{0,9}$/),
      (a, b, x, y) => {
        // Compare as exact rationals scaled to 10^-15 dollars.
        const left = decimalText(a, x),
          right = decimalText(b, y);
        const scaled = (micro, extra) =>
          micro * 10n ** 9n + BigInt((extra + '000000000').slice(0, 9));
        const [low, high] =
          scaled(a, x) <= scaled(b, y)
            ? [left.text, right.text]
            : [right.text, left.text];
        const lowValue =
          serviceCode(() => parseUsd6(low)) === null ? parseUsd6(low) : null;
        const highValue =
          serviceCode(() => parseUsd6(high)) === null ? parseUsd6(high) : null;
        if (highValue !== null) {
          assert.notEqual(lowValue, null);
          assert.ok(lowValue <= highValue);
          assert.ok(Number.isSafeInteger(highValue));
        }
      },
    ),
  );
  check(
    fc.property(
      fc.oneof(
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        fc.integer({ min: 0, max: 20_000_000_000 }),
      ),
      (dollars) => {
        const micro = BigInt(dollars) * 1_000_000n;
        if (micro > SAFE)
          assert.equal(
            serviceCode(() => parseUsd6(dollars)),
            'RangeError',
          );
        else assert.equal(BigInt(parseUsd6(dollars)), micro);
      },
    ),
  );
  check(
    fc.property(
      fc.oneof(
        fc.double({ noInteger: true }),
        fc.integer({ min: -1_000_000, max: -1 }),
        fc.constantFrom(-0, Number.MAX_SAFE_INTEGER + 1, Infinity, Number.NaN),
        fc.constantFrom(
          '-1',
          '+1',
          '01',
          '.5',
          '1.',
          ' 1',
          '1 ',
          '0x10',
          'NaN',
          'Infinity',
          '1e',
          '1e1000',
          '1_000',
          '',
        ),
        fc
          .string({ minLength: 65, maxLength: 80 })
          .map((s) => `1${s.replace(/[^0-9]/g, '0')}`),
      ),
      (value) =>
        assert.equal(
          serviceCode(() => parseUsd6(value)),
          'RangeError',
        ),
    ),
  );
});

void test('cost and usage parsing fail closed with the caller billing flag', () => {
  check(
    fc.property(
      fc.oneof(
        fc.constant(undefined),
        fc.constant(null),
        fc.bigInt({ min: 0n, max: 10n ** 12n }).map(String),
        fc.string({ maxLength: 12 }),
        fc.double(),
      ),
      fc.boolean(),
      fc.boolean(),
      (value, ambiguous, exact) => {
        if (value === undefined || value === null) {
          assert.equal(cost(value, ambiguous, exact), null);
          return;
        }
        let direct;
        try {
          direct = exact ? parseExactUsd6(value) : parseUsd6(value);
        } catch {
          direct = undefined;
        }
        if (direct === undefined) {
          assert.throws(
            () => cost(value, ambiguous, exact),
            (error) =>
              error instanceof GatewayError &&
              error.code === 'invalid_response' &&
              error.billingAmbiguous === ambiguous,
          );
        } else assert.equal(cost(value, ambiguous, exact), direct);
      },
    ),
  );
  const count = fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
    fc.integer({ min: 0, max: 1_000_000 }).map(String),
    fc.integer({ min: -1000, max: -1 }),
    fc.double({ noInteger: true }),
    fc.constantFrom('01', '-1', '1.0', '', 'x', Number.MAX_SAFE_INTEGER + 1),
  );
  const valid = (value) => {
    if (value === undefined || value === null) return null;
    const number =
      typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
        ? Number(value)
        : value;
    return typeof number === 'number' &&
      Number.isSafeInteger(number) &&
      number >= 0
      ? number
      : undefined;
  };
  check(
    fc.property(
      count,
      count,
      count,
      count,
      fc.boolean(),
      (prompt, input, completion, total, legacy) => {
        const data = legacy
          ? {
              input_tokens: input,
              output_tokens: completion,
              total_tokens: total,
            }
          : {
              prompt_tokens: prompt,
              input_tokens: input,
              completion_tokens: completion,
              total_tokens: total,
            };
        const chosenInput = legacy ? input : (prompt ?? input);
        const expected = [valid(chosenInput), valid(completion), valid(total)];
        if (expected.includes(undefined))
          assert.throws(
            () => usage(data),
            (error) =>
              error instanceof GatewayError && error.billingAmbiguous === true,
          );
        else
          assert.deepEqual(usage(data), {
            inputTokens: expected[0],
            outputTokens: expected[1],
            totalTokens: expected[2],
          });
        assert.equal(
          integer(chosenInput, 1000),
          valid(chosenInput) !== undefined &&
            valid(chosenInput) !== null &&
            valid(chosenInput) <= 1000
            ? valid(chosenInput)
            : null,
        );
      },
    ),
  );
  for (const value of [undefined, null]) assert.equal(usage(value), null);
  for (const value of ['x', 1, [], true])
    assert.throws(
      () => usage(value),
      (error) => error instanceof GatewayError,
    );
});

// ----------------------------------------------------------- token/price.ts

const price = fc.oneof(
  fc.bigInt({ min: 1n, max: 1n << 63n }),
  fc.bigInt({ min: 1n, max: 10_000_000n }),
  fc.constantFrom(1n, 1n << 63n),
);
const decimals = fc.integer({ min: 0, max: 9 });

void test('token conversions never let a payer underpay or a credit exceed value', () => {
  check(
    fc.property(largeAmount, price, decimals, (amount, unitPrice, places) => {
      const scale = 10n ** BigInt(places);
      const tokens = tokensForUsd6(amount, unitPrice, places);
      assert.ok(tokens * unitPrice >= amount * scale);
      assert.ok(tokens === 0n || (tokens - 1n) * unitPrice < amount * scale);
      assert.ok(usd6ForTokens(tokens, unitPrice, places) >= amount);
      const credit = usd6ForTokens(amount, unitPrice, places);
      assert.ok(credit * scale <= amount * unitPrice);
      assert.ok((credit + 1n) * scale > amount * unitPrice);
      assert.ok(tokensForUsd6(credit, unitPrice, places) <= amount);
    }),
  );
  check(
    fc.property(
      largeAmount,
      largeAmount,
      price,
      decimals,
      (a, b, unitPrice, places) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        assert.ok(
          tokensForUsd6(low, unitPrice, places) <=
            tokensForUsd6(high, unitPrice, places),
        );
        assert.ok(
          usd6ForTokens(low, unitPrice, places) <=
            usd6ForTokens(high, unitPrice, places),
        );
      },
    ),
  );
});

void test('token price inputs outside their bounds throw', () => {
  check(
    fc.property(
      fc.oneof(
        fc.bigInt({ min: -TEN_18, max: 0n }),
        fc.bigInt({ min: (1n << 63n) + 1n, max: 1n << 80n }),
        fc.integer(),
        fc.constant('1'),
      ),
      largeAmount,
      decimals,
      (bad, amount, places) => {
        assert.equal(
          serviceCode(() => requirePrice(bad)),
          'TOKEN_PRICE_UNAVAILABLE',
        );
        assert.equal(
          serviceCode(() => tokensForUsd6(amount, bad, places)),
          'TOKEN_PRICE_UNAVAILABLE',
        );
        assert.equal(
          serviceCode(() => usd6ForTokens(amount, bad, places)),
          'TOKEN_PRICE_UNAVAILABLE',
        );
      },
    ),
  );
  check(
    fc.property(
      fc.oneof(
        fc.integer({ min: 10, max: 1000 }),
        fc.integer({ min: -1000, max: -1 }),
        fc.constantFrom(0.5, Number.NaN, Infinity),
      ),
      price,
      (bad, unitPrice) => {
        assert.equal(
          serviceCode(() => tokenScale(bad)),
          'CONFIGURATION_REQUIRED',
        );
        assert.equal(
          serviceCode(() => tokensForUsd6(1n, unitPrice, bad)),
          'CONFIGURATION_REQUIRED',
        );
      },
    ),
  );
  check(
    fc.property(
      fc.bigInt({ min: -TEN_18, max: -1n }),
      price,
      decimals,
      (negative, unitPrice, places) => {
        assert.equal(
          serviceCode(() => tokensForUsd6(negative, unitPrice, places)),
          'INVALID_AMOUNT',
        );
        assert.equal(
          serviceCode(() => usd6ForTokens(negative, unitPrice, places)),
          'INVALID_AMOUNT',
        );
      },
    ),
  );
});

void test('slippage bounds bracket the amount and are monotonic', () => {
  const slippage = bps(TOKEN_PRICE_LIMITS.maximumSlippageBps);
  check(
    fc.property(largeAmount, largeAmount, slippage, slippage, (a, b, p, q) => {
      const [low, high] = a <= b ? [a, b] : [b, a];
      const [few, many] = p <= q ? [p, q] : [q, p];
      assert.ok(minimumAfterSlippage(low, few) <= low);
      assert.ok(withSlippage(low, few) >= low);
      assert.equal(
        withSlippage(low, few),
        ceil(low * (BPS + BigInt(few)), BPS),
      );
      assert.equal(
        minimumAfterSlippage(low, few),
        (low * (BPS - BigInt(few))) / BPS,
      );
      assert.ok(withSlippage(low, few) <= withSlippage(high, few));
      assert.ok(withSlippage(low, few) <= withSlippage(low, many));
      assert.ok(
        minimumAfterSlippage(low, few) <= minimumAfterSlippage(high, few),
      );
      assert.ok(
        minimumAfterSlippage(low, many) <= minimumAfterSlippage(low, few),
      );
      if (few === 0) {
        assert.equal(withSlippage(low, 0), low);
        assert.equal(minimumAfterSlippage(low, 0), low);
      }
    }),
  );
  check(
    fc.property(
      largeAmount,
      fc.oneof(
        fc.integer({ min: 501, max: 100_000 }),
        fc.integer({ min: -100_000, max: -1 }),
        fc.constantFrom(0.5, Number.NaN, Infinity),
      ),
      (amount, bad) => {
        assert.equal(
          serviceCode(() => withSlippage(amount, bad)),
          'TOKEN_PRICE_UNAVAILABLE',
        );
        assert.equal(
          serviceCode(() => minimumAfterSlippage(amount, bad)),
          'TOKEN_PRICE_UNAVAILABLE',
        );
      },
    ),
  );
});

void test('a token price quote is usable exactly when fresh, unexpired and narrow', () => {
  const minute = 60_000;
  check(
    fc.property(
      fc.integer({ min: 1_700_000_000_000, max: 2_000_000_000_000 }),
      fc.oneof(
        fc.integer({ min: -20 * minute, max: minute }),
        fc.constantFrom(0, -15 * minute, -15 * minute - 1, 1),
      ),
      fc.oneof(
        fc.integer({ min: -minute, max: 10 * minute }),
        fc.constantFrom(0, 1, -1),
      ),
      fc.oneof(
        fc.integer({ min: -10, max: 1100 }),
        fc.constantFrom(0, 1000, 1001, 0.5, Number.NaN),
      ),
      fc.oneof(price, fc.constantFrom(0n, -1n, (1n << 63n) + 1n)),
      fc.oneof(
        fc.constant(undefined),
        fc.integer({ min: 0, max: 30 * minute }),
      ),
      (
        now,
        observedOffset,
        expiresOffset,
        confidenceBps,
        unitPrice,
        maximumAgeMs,
      ) => {
        const quote = {
          priceUsd6PerToken: unitPrice,
          source: 'simulated',
          observedAtMs: now + observedOffset,
          expiresAtMs: now + expiresOffset,
          confidenceBps,
        };
        const age = maximumAgeMs ?? TOKEN_PRICE_LIMITS.maximumAgeMs;
        const priceValid = unitPrice > 0n && unitPrice <= 1n << 63n;
        const fresh =
          observedOffset <= 0 &&
          -observedOffset <= age &&
          expiresOffset > 0 &&
          Number.isInteger(confidenceBps) &&
          confidenceBps >= 0 &&
          confidenceBps <= TOKEN_PRICE_LIMITS.maximumConfidenceBps;
        const outcome = serviceCode(() =>
          assertUsableQuote(quote, now, maximumAgeMs),
        );
        if (!priceValid) assert.equal(outcome, 'TOKEN_PRICE_UNAVAILABLE');
        else if (!fresh) assert.equal(outcome, 'TOKEN_PRICE_STALE');
        else assert.equal(outcome, null);
      },
    ),
  );
});

// --------------------------------------------------- routes/call-contract.ts

const pricing = fc.record({
  inputPerMillionUsd6: fc
    .oneof(
      fc.bigInt({ min: 1n, max: 100_000_000n }),
      fc.bigInt({ min: 1n, max: 5_000_000n }),
    )
    .map(String),
  outputPerMillionUsd6: fc
    .oneof(
      fc.bigInt({ min: 1n, max: 200_000_000n }),
      fc.bigInt({ min: 1n, max: 20_000_000n }),
    )
    .map(String),
  markupBps: fc.oneof(bps(10_000), fc.constantFrom(-1, 10_001, 0.5)),
  maxOutputTokens: fc.oneof(
    fc.integer({ min: 1, max: 8192 }),
    fc.constant(8192),
  ),
  maxInputBytes: fc.oneof(
    fc.integer({ min: 1, max: 32_768 }),
    fc.constantFrom(32_768, 0, 32_769),
  ),
  maxReasoningTokens: fc.oneof(
    fc.constant(undefined),
    fc.integer({ min: 0, max: MAX_REASONING_TOKENS }),
    fc.constantFrom(0, MAX_REASONING_TOKENS, MAX_REASONING_TOKENS + 1, -1, 0.5),
  ),
});
const content = fc.oneof(
  fc.string({ minLength: 1, maxLength: 400 }),
  fc.string({ unit: 'binary', minLength: 1, maxLength: 200 }),
  fc.integer({ min: 1, max: 16_000 }).map((n) => 'x'.repeat(n)),
);
const chatInput = fc.record({
  messages: fc
    .array(content, { minLength: 1, maxLength: 4 })
    .map((parts) => parts.map((text) => ({ role: 'user', content: text }))),
  maxOutputTokens: fc.integer({ min: 1, max: 8192 }),
  privacy: fc.constant('standard'),
});
const route = (values) => ({
  id: 'property-route',
  model_id: 'property-model',
  family: 'property',
  enabled: true,
  fresh: true,
  modality: 'chat',
  card: {},
  pricing: values,
});

/** Independent restatement of the quote maximum and of the order its checks run in. */
function expectedQuote(values, input) {
  const markupValid =
    Number.isSafeInteger(values.markupBps) &&
    values.markupBps >= 0 &&
    values.markupBps <= 10_000;
  const bytesValid =
    Number.isSafeInteger(values.maxInputBytes) &&
    values.maxInputBytes > 0 &&
    values.maxInputBytes <= 32_768;
  if (
    !markupValid ||
    !bytesValid ||
    input.maxOutputTokens > values.maxOutputTokens
  )
    return 'ROUTE_PRICING_UNAVAILABLE';
  const bytes = input.messages.reduce(
    (sum, message) => sum + Buffer.byteLength(message.content, 'utf8'),
    0,
  );
  if (bytes > values.maxInputBytes) return 'PROMPT_TOO_LARGE';
  // Absent reviewed cap: the route's whole output cap is reserved for reasoning.
  const reasoning = values.maxReasoningTokens ?? values.maxOutputTokens;
  if (
    !Number.isSafeInteger(reasoning) ||
    reasoning < 0 ||
    reasoning > MAX_REASONING_TOKENS
  )
    return 'ROUTE_PRICING_UNAVAILABLE';
  const inputTokens = BigInt(bytes + input.messages.length * 256 + 1024);
  const outputTokens = BigInt(input.maxOutputTokens + reasoning);
  const provider = ceil(
    inputTokens * BigInt(values.inputPerMillionUsd6) +
      outputTokens * BigInt(values.outputPerMillionUsd6),
    1_000_000n,
  );
  const maximum = ceil(provider * BigInt(10_000 + values.markupBps), BPS);
  if (maximum > CHAT_REQUEST_BUDGET_USD6) return 'REQUEST_BUDGET_EXCEEDED';
  return maximum > 0n ? maximum : 1n;
}

function quoteOutcome(values, input) {
  const code = serviceCode(() => quoteMaximum(route(values), input));
  return code ?? BigInt(quoteMaximum(route(values), input));
}

void test('the chat quote maximum matches its formula and never exceeds the request budget', () => {
  check(
    fc.property(pricing, chatInput, (values, input) => {
      const outcome = quoteOutcome(values, input);
      assert.equal(outcome, expectedQuote(values, input));
      if (typeof outcome === 'bigint') {
        assert.ok(outcome >= 1n);
        assert.ok(outcome <= CHAT_REQUEST_BUDGET_USD6);
      }
    }),
  );
});

void test('the chat quote maximum is monotonic in input bytes, output tokens and reasoning cap', () => {
  const ok = (value) => typeof value === 'bigint';
  // More input bytes: a larger request never quotes less, and never succeeds where a smaller one failed.
  check(
    fc.property(pricing, chatInput, content, (values, input, extra) => {
      const longer = {
        ...input,
        messages: input.messages.map((message, index) =>
          index === input.messages.length - 1
            ? { ...message, content: message.content + extra }
            : message,
        ),
      };
      const small = quoteOutcome(values, input),
        large = quoteOutcome(values, longer);
      if (ok(large)) {
        assert.ok(ok(small));
        assert.ok(small <= large);
      }
    }),
  );
  check(
    fc.property(
      pricing,
      chatInput,
      fc.integer({ min: 1, max: 8192 }),
      (values, input, other) => {
        const [few, many] =
          input.maxOutputTokens <= other
            ? [input.maxOutputTokens, other]
            : [other, input.maxOutputTokens];
        const small = quoteOutcome(values, { ...input, maxOutputTokens: few }),
          large = quoteOutcome(values, { ...input, maxOutputTokens: many });
        if (ok(large)) {
          assert.ok(ok(small));
          assert.ok(small <= large);
        }
      },
    ),
  );
  check(
    fc.property(
      pricing,
      chatInput,
      fc.integer({ min: 0, max: MAX_REASONING_TOKENS }),
      fc.integer({ min: 0, max: MAX_REASONING_TOKENS }),
      (values, input, a, b) => {
        const [few, many] = a <= b ? [a, b] : [b, a];
        const small = quoteOutcome(
            { ...values, maxReasoningTokens: few },
            input,
          ),
          large = quoteOutcome({ ...values, maxReasoningTokens: many }, input);
        if (ok(large)) {
          assert.ok(ok(small));
          assert.ok(small <= large);
        }
      },
    ),
  );
});

void test('property settings are fixed and meet the minimum case count', () => {
  assert.equal(SEED, 20261010);
  assert.ok(RUNS >= 2000);
});
