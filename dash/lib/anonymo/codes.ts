// The gateway's wire format (gateway/src/anonymo/codes/format.ts).
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function normalize(value: string) {
  return value.replace(/[\s-]/g, '').replace(/[a-z]/g, (c) => c.toUpperCase()).replace(/O/g, '0').replace(/[IL]/g, '1');
}

// CRC-5 (x^5 + x^2 + 1) over the first 15 symbols.
function checksum(payload: string) {
  let crc = 0;
  for (const char of payload) {
    crc ^= alphabet.indexOf(char);
    for (let bit = 0; bit < 5; bit++) crc = ((crc << 1) & 31) ^ (crc & 16 ? 5 : 0);
  }
  return alphabet[crc];
}

const format = (symbols: string) => symbols.match(/.{1,4}/g)?.join('-') ?? '';

export const formatCodeInput = (value: string) => format(normalize(value));

export function canonicalCode(value: string): string | null {
  const symbols = normalize(value);
  if (!/^[0-9A-HJKMNP-TV-Z]{16}$/.test(symbols) || symbols[15] !== checksum(symbols.slice(0, 15))) return null;
  return format(symbols);
}

/** Voucher QR links use /redeem#code=… so the code stays out of URL requests. */
export function codeFromFragment(fragment: string) {
  return canonicalCode(new URLSearchParams(fragment.replace(/^#/, '')).get('code') ?? '');
}

export type CodeRedemption = { added_usd: number; key_hash: string; key?: string };

const demoPayload = '7DM4K2QX9CW6VN8';
export const DEMO_CODE = format(demoPayload + checksum(demoPayload));
