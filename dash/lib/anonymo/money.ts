import type { MicroUsd } from './types.ts';

export const MUSD_PER_USD = 1_000_000;

/** Formats integer micro-USD as dollars. Small amounts keep enough digits to stay visible (a call can cost $0.0008). */
export function formatUsd(musd: MicroUsd, opts: { sign?: boolean } = {}): string {
  if (!Number.isSafeInteger(musd)) return '—';
  const abs = Math.abs(musd);
  const whole = Math.floor(abs / MUSD_PER_USD);
  const frac = String(abs % MUSD_PER_USD).padStart(6, '0');
  let shown: string;
  if (abs === 0 || abs >= MUSD_PER_USD / 100) shown = frac.slice(0, 2);
  else shown = frac.replace(/0+$/, '').padEnd(2, '0');
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = musd < 0 ? '−' : opts.sign && musd > 0 ? '+' : '';
  return `${sign}$${grouped}.${shown}`;
}

/** Parses a dollar amount typed by a person into micro-USD. Returns null for anything that is not a plain amount. */
export function parseUsd(input: string): MicroUsd | null {
  const m = /^\s*\$?\s*(\d{1,9})(?:\.(\d{0,6}))?\s*$/.exec(input);
  if (!m) return null;
  return Number(m[1]) * MUSD_PER_USD + Number((m[2] ?? '').padEnd(6, '0'));
}

/**
 * Converts a USD amount as the gateway sends it (a JSON number like 10 or 0.0000154, or a decimal string on receipts)
 * to integer micro-USD, rounded to the nearest micro-USD. Anything that is not a finite amount becomes NaN.
 */
export function usdToMusd(usd: number | string | null | undefined): MicroUsd {
  if (usd === null || usd === undefined) return Number.NaN;
  if (typeof usd === 'number') return Number.isFinite(usd) ? Math.round(usd * MUSD_PER_USD) : Number.NaN;
  const m = /^\s*(-)?(\d{1,15})(?:\.(\d*))?\s*$/.exec(usd);
  if (!m) return Number.NaN;
  const frac = (m[3] ?? '').padEnd(7, '0');
  const value = Number(m[2]) * MUSD_PER_USD + Number(frac.slice(0, 6)) + (Number(frac[6]) >= 5 ? 1 : 0);
  return m[1] ? -value : value;
}

/** Micro-USD as the decimal string the gateway accepts for `amount_usd` (no float rounding). */
export function musdToUsdString(musd: MicroUsd): string {
  const abs = Math.abs(Math.trunc(musd));
  const whole = Math.floor(abs / MUSD_PER_USD);
  const frac = String(abs % MUSD_PER_USD).padStart(6, '0').replace(/0+$/, '');
  return `${musd < 0 ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Formats a gateway USD amount (number or decimal string). */
export const formatUsdAmount = (usd: number | string | null | undefined, opts: { sign?: boolean } = {}) => formatUsd(usdToMusd(usd), opts);
