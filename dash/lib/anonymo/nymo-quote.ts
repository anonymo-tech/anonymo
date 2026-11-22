import type { AnonymoClient } from './client.ts';
import { musdToUsdString } from './money.ts';
import type { NymoQuote, PublicCoinInstructions } from './types.ts';
import { availableNymoRail } from './wallet-links.ts';

const decimal = /^(0|[1-9]\d{0,24})(?:\.(\d{1,18}))?$/;
const positiveDecimal = (value: unknown): value is string => typeof value === 'string' && decimal.test(value) && /[1-9]/.test(value);
function scaledUsd(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole + fraction.padEnd(18, '0'));
}

/** Only this endpoint quotes the actual amount against available liquidity. */
export async function readNymoQuote(client: Pick<AnonymoClient, 'nymoQuote'>, coin: PublicCoinInstructions, musd: number, signal?: AbortSignal): Promise<NymoQuote> {
  if (!Number.isSafeInteger(musd) || musd <= 0 || !availableNymoRail(coin)) throw new Error('NYMO payments are unavailable.');
  const quote = await client.nymoQuote(musdToUsdString(musd), signal);
  if (!quote || !availableNymoRail({ ...coin, chain_id: quote.chain_id, coin_pay: quote.coin_pay, token: quote.token, confirmations: quote.confirmations }) ||
      quote.coin_pay.toLowerCase() !== coin.coin_pay.toLowerCase() || quote.confirmations !== coin.confirmations || quote.confirmations < 1 ||
      typeof quote.amount_raw !== 'string' || !/^[1-9]\d{0,77}$/.test(quote.amount_raw) || BigInt(quote.amount_raw) >= 2n ** 256n ||
      !positiveDecimal(quote.estimated_credit_usd) || !positiveDecimal(quote.price_usd)) throw new Error('The gateway could not confirm this NYMO quote.');
  return quote;
}

export function sameNymoQuote(a: NymoQuote, b: NymoQuote): boolean {
  return a.chain_id === b.chain_id && a.coin_pay.toLowerCase() === b.coin_pay.toLowerCase() &&
    a.token.address.toLowerCase() === b.token.address.toLowerCase() && a.confirmations === b.confirmations &&
    a.amount_raw === b.amount_raw && scaledUsd(a.estimated_credit_usd) === scaledUsd(b.estimated_credit_usd);
}

export function nymoCreditText(quote: NymoQuote, musd: number): string {
  const credit = quote.estimated_credit_usd.includes('.') ? quote.estimated_credit_usd.replace(/0+$/, '').replace(/\.$/, '') : quote.estimated_credit_usd;
  const target = musdToUsdString(musd);
  return scaledUsd(credit) < scaledUsd(target)
    ? `This quote covers $${credit} of your $${target} request.`
    : `Estimated usage credit: $${credit}.`;
}
