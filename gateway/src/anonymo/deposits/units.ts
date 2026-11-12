// Exact conversions into pico-USD. Stablecoins are 1:1 with USD; BTC and Lightning use the BTCPay quote.

import type { Pico } from "../../lib/money.ts";

/** Token base units of a USD stablecoin with `decimals` decimals, as pico-USD (rounded down below one pico). */
export function stableRawToPico(raw: bigint, decimals: number): Pico {
  if (raw < 0n) throw new Error("negative amount");
  return decimals <= 12 ? raw * 10n ** BigInt(12 - decimals) : raw / 10n ** BigInt(decimals - 12);
}

/** pico-USD as stablecoin base units (rounded down: a payout never sends more than was debited). */
export function picoToStableRaw(p: Pico, decimals: number): bigint {
  return decimals <= 12 ? p / 10n ** BigInt(12 - decimals) : p * 10n ** BigInt(decimals - 12);
}

const DEC = /^(\d{1,30})(?:\.(\d{1,30}))?$/;
function parseDecimal(s: string): { n: bigint; scale: number } {
  const m = DEC.exec(s.trim());
  if (!m) throw new Error(`not a non-negative decimal: ${s}`);
  const frac = m[2] ?? "";
  return { n: BigInt(m[1] + frac), scale: frac.length };
}

/** a × b, both non-negative decimal strings (e.g. BTC paid × USD/BTC rate), as pico-USD rounded down. */
export function decimalProductToPico(a: string, b: string): Pico {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  const scale = x.scale + y.scale;
  const product = x.n * y.n; // value = product / 10^scale USD
  return scale <= 12 ? product * 10n ** BigInt(12 - scale) : product / 10n ** BigInt(scale - 12);
}
