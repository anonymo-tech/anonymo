// Base58 (Bitcoin alphabet) and Base58Check, for Solana and Tron addresses. Small and dependency-free on purpose:
// the gateway does not carry bs58, and an address codec is not worth a new dependency.

import { createHash } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function base58Decode(text: string): Uint8Array {
  if (!text.length || text.length > 128) throw new Error("invalid base58");
  let n = 0n;
  for (const c of text) {
    const v = INDEX.get(c);
    if (v === undefined) throw new Error("invalid base58");
    n = n * 58n + v;
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  while (text[zeros] === "1") zeros++;
  return Uint8Array.from([...new Array(zeros).fill(0), ...body]);
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest();

export function base58CheckEncode(payload: Uint8Array): string {
  const sum = sha(sha(payload)).subarray(0, 4);
  return base58Encode(Uint8Array.from([...payload, ...sum]));
}

/** Decode a Base58Check string, returning null when the checksum or alphabet is wrong. */
export function base58CheckDecode(text: string): Uint8Array | null {
  let raw: Uint8Array;
  try {
    raw = base58Decode(text);
  } catch {
    return null;
  }
  if (raw.length < 5) return null;
  const payload = raw.subarray(0, -4);
  const sum = sha(sha(payload)).subarray(0, 4);
  return Buffer.compare(Buffer.from(sum), Buffer.from(raw.subarray(-4))) === 0 ? payload : null;
}

/** A canonical base58 string of exactly `length` bytes (Solana: 32 for an address, 64 for a signature). */
export function isBase58Of(text: unknown, length: number): text is string {
  if (typeof text !== "string" || text.length < length || text.length > Math.ceil(length * 1.38)) return false;
  try {
    const bytes = base58Decode(text);
    return bytes.length === length && base58Encode(bytes) === text;
  } catch {
    return false;
  }
}
