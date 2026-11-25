// Keep the dash's browser validation in sync with this wire format.
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// CRC-5 (x^5 + x^2 + 1) over the first 15 symbols. A symbol carries five bits.
export function codeChecksum(payload: string): string {
  let crc = 0;
  for (const char of payload) {
    crc ^= CODE_ALPHABET.indexOf(char);
    for (let bit = 0; bit < 5; bit++) crc = ((crc << 1) & 31) ^ (crc & 16 ? 5 : 0);
  }
  return CODE_ALPHABET[crc];
}

export function formatCode(symbols: string): string {
  return symbols.match(/.{1,4}/g)?.join("-") ?? "";
}

export function canonicalCode(value: string): string | null {
  const symbols = value.replace(/[\s-]/g, "").replace(/[a-z]/g, (c) => c.toUpperCase()).replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!/^[0-9A-HJKMNP-TV-Z]{16}$/.test(symbols) || symbols[15] !== codeChecksum(symbols.slice(0, 15))) return null;
  return formatCode(symbols);
}
