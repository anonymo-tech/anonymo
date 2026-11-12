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
