import { ServiceError } from '../core/errors.ts';

const maximum = 9_000_000_000_000_000n;

export function usd6(value: unknown, allowZero = false): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value)) {
    throw new ServiceError(400, 'INVALID_AMOUNT', 'Amounts must be integer micro-USD strings.');
  }
  const amount = BigInt(value);
  if (amount > maximum || amount < (allowZero ? 0n : 1n)) {
    throw new ServiceError(400, 'INVALID_AMOUNT', 'The amount is outside the supported range.');
  }
  return amount;
}

export function decimalUsd6(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,6})?$/.test(value)) {
    throw new ServiceError(400, 'INVALID_AMOUNT', 'A nonnegative USD amount with at most six decimal places is required.');
  }
  const [whole, fraction = ''] = value.split('.');
  return usd6((BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))).toString(), true);
}

export function ceilRatio(numerator: bigint, denominator: bigint) {
  if (numerator < 0n || denominator <= 0n) throw new RangeError('Invalid ratio.');
  return (numerator + denominator - 1n) / denominator;
}
