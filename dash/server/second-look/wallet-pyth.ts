import { createHash } from 'node:crypto';
import {
  record,
  uint,
  assertGenesis,
  requireSolana,
} from '../solana/validation.ts';
import { SOL_MINT } from './trade-parser.ts';
import { decimalRatio, type WalletPrice } from './pnl.ts';

// Pyth's sponsored shard-0 SOL/USD account; this is not an arbitrary caller feed.
// Layout: pyth_solana_receiver_sdk::price_update::PriceUpdateV2 (Borsh).
export const PYTH_SOL_ACCOUNT = '7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE';
const PYTH_RECEIVER = 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ';
const SOL_FEED =
  'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
const DISCRIMINATOR = createHash('sha256')
  .update('account:PriceUpdateV2')
  .digest()
  .subarray(0, 8);

function priceDecimal(price: bigint, exponent: number): string {
  requireSolana(
    price > 0n && exponent >= -18 && exponent <= 0,
    'invalid_response',
  );
  const digits = price.toString().padStart(1 - exponent, '0');
  const value =
    exponent === 0
      ? digits
      : `${digits.slice(0, exponent)}.${digits.slice(exponent)}`;
  decimalRatio(value);
  return value;
}

/** A spot quote never proves historical prices, pool liquidity or last trade time. */
export function parsePythSolSpot(
  value: unknown,
  at: string,
  now = Date.now(),
): WalletPrice {
  const result = record(value),
    context = record(result.context),
    account = record(result.value);
  const slot = uint(context.slot);
  requireSolana(
    account.owner === PYTH_RECEIVER &&
      account.executable === false &&
      Array.isArray(account.data) &&
      account.data.length === 2 &&
      account.data[1] === 'base64' &&
      typeof account.data[0] === 'string' &&
      account.data[0].length <= 184,
    'invalid_response',
  );
  const encoded = account.data[0] as string;
  const data = Buffer.from(encoded, 'base64');
  requireSolana(
    data.toString('base64') === encoded &&
      (data.length === 133 || data.length === 134) &&
      data.subarray(0, 8).equals(DISCRIMINATOR) &&
      data[40] === 1 && // Full guardian verification; Partial changes the offsets.
      data.subarray(41, 73).toString('hex') === SOL_FEED,
    'invalid_response',
  );
  const price = data.readBigInt64LE(73),
    confidence = data.readBigUInt64LE(81),
    exponent = data.readInt32LE(89),
    published = data.readBigInt64LE(93),
    previous = data.readBigInt64LE(101),
    postedSlot = data.readBigUInt64LE(125);
  const timestamp = Number(published) * 1000,
    requested = Date.parse(at);
  requireSolana(
    price > 0n &&
      confidence * 100n <= price * 2n &&
      postedSlot > 0n &&
      postedSlot <= BigInt(slot) &&
      previous >= 0n &&
      previous <= published &&
      Number.isSafeInteger(timestamp) &&
      Number.isFinite(requested) &&
      Math.abs(timestamp - requested) <= 300_000 &&
      now - timestamp <= 300_000 &&
      timestamp <= now + 60_000,
    'invalid_response',
  );
  return {
    mint: SOL_MINT,
    priceUsd: priceDecimal(price, exponent),
    at: new Date(timestamp).toISOString(),
    lastTradeAt: null,
    liquidityUsd: null,
    estimated: true,
    source: 'pyth_solana_spot',
  };
}

export async function readPythSolSpot(
  rpc: (method: string, params: unknown[]) => Promise<unknown>,
  mint: string,
  at: string,
  now = Date.now(),
): Promise<WalletPrice | null> {
  const requested = Date.parse(at);
  if (
    mint !== SOL_MINT ||
    !Number.isFinite(requested) ||
    requested < now - 300_000 ||
    requested > now + 60_000
  )
    return null;
  assertGenesis('mainnet-beta', await rpc('getGenesisHash', []));
  const value = await rpc('getAccountInfo', [
    PYTH_SOL_ACCOUNT,
    { commitment: 'finalized', encoding: 'base64' },
  ]);
  if (record(value).value === null) return null;
  return parsePythSolSpot(value, at, now);
}
