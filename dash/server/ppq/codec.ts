import { PpqError } from './errors.ts';

/** Safe integer micro-US dollars. */
export type Usd6 = number;

const maximumUsd6 = BigInt(Number.MAX_SAFE_INTEGER);
// A plain decimal lexeme with an optional exponent. Signs, leading zeros,
// whitespace, bare dots, hex and named values are never money.
const decimalLexeme = /^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/;

function usd6(value: unknown, roundUp: boolean): Usd6 {
  // Fractional JS numbers have already lost their source decimal representation.
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0))
      throw new RangeError('Invalid USD amount');
    value = String(value);
  }
  const match =
    typeof value === 'string' && value.length <= 64
      ? decimalLexeme.exec(value)
      : null;
  if (!match) throw new RangeError('Invalid USD amount');
  const [, whole, fraction = '', exponent = '0'] = match;
  // The amount is digits × 10^shift micro-dollars.
  const digits = BigInt(whole + fraction);
  const shift = Number(exponent) - fraction.length + 6;
  if (digits === 0n) return 0;
  // Any nonzero amount scaled past 10^16 micro-dollars exceeds the safe range.
  if (shift > 16) throw new RangeError('Invalid USD amount');
  let amount: bigint;
  if (shift >= 0) amount = digits * 10n ** BigInt(shift);
  else {
    const divisor = 10n ** BigInt(-shift);
    if (!roundUp && digits % divisor !== 0n)
      throw new RangeError('Invalid USD amount');
    amount = (digits + divisor - 1n) / divisor;
  }
  if (amount > maximumUsd6) throw new RangeError('Invalid USD amount');
  return Number(amount);
}

/**
 * Provider-reported USD as integer micro-dollars, rounded UP to the next
 * micro-dollar. Accepts any number of decimals and exponent notation (PPQ
 * reports costs such as 0.0000124, 0.00032604 or 3.1e-05). Signed, negative,
 * non-numeric and unrepresentable (above MAX_SAFE_INTEGER micro-dollars)
 * amounts are rejected.
 */
export function parseUsd6(value: unknown): Usd6 {
  return usd6(value, true);
}

/** Exact USD (catalog prices): rejects any amount that is not a whole micro-dollar. */
export function parseExactUsd6(value: unknown): Usd6 {
  return usd6(value, false);
}

/** Preserve JSON number lexemes before JSON.parse can round monetary amounts. */
export function parseProviderJson(text: string): unknown {
  let rewritten = '';
  let index = 0;
  let depth = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      const start = index++;
      while (index < text.length) {
        if (text[index] === '\\') index += 2;
        else if (text[index++] === '"') break;
      }
      rewritten += text.slice(start, index);
    } else if (character === '-' || /\d/.test(character)) {
      const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
        text.slice(index),
      )?.[0];
      if (!token) throw new Error('Invalid JSON');
      rewritten += JSON.stringify(token);
      index += token.length;
    } else {
      if (character === '{' || character === '[') {
        depth += 1;
        if (depth > 32) throw new Error('JSON nesting exceeds limit');
      }
      if (character === '}' || character === ']') depth -= 1;
      rewritten += character;
      index += 1;
    }
  }
  return JSON.parse(rewritten) as unknown;
}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function integer(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null {
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value))
    value = Number(value);
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
    ? value
    : null;
}

/**
 * A reported USD amount, or null when absent. Costs round up to the next
 * micro-dollar; `exact` (catalog prices) rejects sub-micro-dollar precision.
 */
export function cost(
  value: unknown,
  ambiguous: boolean,
  exact = false,
): Usd6 | null {
  if (value === undefined || value === null) return null;
  try {
    return exact ? parseExactUsd6(value) : parseUsd6(value);
  } catch {
    throw new PpqError('invalid_response', ambiguous);
  }
}

export type PpqUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export function usage(value: unknown): PpqUsage | null {
  if (value === undefined || value === null) return null;
  const data = record(value);
  if (!data) throw new PpqError('invalid_response', true);
  const count = (value: unknown) => {
    if (value === undefined || value === null) return null;
    const result = integer(value);
    if (result === null) throw new PpqError('invalid_response', true);
    return result;
  };
  return {
    inputTokens: count(data.prompt_tokens ?? data.input_tokens),
    outputTokens: count(data.completion_tokens ?? data.output_tokens),
    totalTokens: count(data.total_tokens),
  };
}
