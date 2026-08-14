import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

export const DEPOSIT_TOKEN_PROGRAM =
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const DEPOSIT_TRANSACTION_BYTES = 312;
export type DepositTransactionTerms = {
  sourceWallet: string;
  sourceTokenAccount: string;
  recipientTokenAccount: string;
  mint: string;
  reference: string;
  amountUsd6: string;
  recentBlockhash: string;
};

/** Static errors contain no wallet addresses, transaction bytes or signatures. */
export class DepositTransactionError extends Error {
  constructor() {
    super('INVALID_DEPOSIT_TRANSACTION');
    this.name = 'DepositTransactionError';
  }
}
function requireTransaction(value: unknown): asserts value {
  if (!value) throw new DepositTransactionError();
}
function publicKey(value: unknown): Uint8Array {
  requireTransaction(
    typeof value === 'string' && value.length >= 32 && value.length <= 44,
  );
  try {
    const decoded = bs58.decode(value);
    requireTransaction(decoded.length === 32 && bs58.encode(decoded) === value);
    return decoded;
  } catch {
    throw new DepositTransactionError();
  }
}
function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

/** Exactly one legacy SPL TransferChecked, six inline accounts and one signer.
 * No ATA creation, delegate, memo, priority fee, lookup table or extra instruction.
 * The reference is an additional readonly, non-signing transfer account. */
export function buildDepositTransaction(terms: DepositTransactionTerms) {
  const keys = [
    terms.sourceWallet,
    terms.sourceTokenAccount,
    terms.recipientTokenAccount,
    terms.mint,
    terms.reference,
    DEPOSIT_TOKEN_PROGRAM,
  ];
  requireTransaction(new Set(keys).size === keys.length);
  const decoded = keys.map(publicKey),
    blockhash = publicKey(terms.recentBlockhash);
  requireTransaction(
    typeof terms.amountUsd6 === 'string' &&
      /^[1-9][0-9]{0,19}$/.test(terms.amountUsd6),
  );
  const amount = BigInt(terms.amountUsd6);
  requireTransaction(amount <= (1n << 64n) - 1n);
  // All compact-u16 counts are below 128 and therefore canonical one-byte values.
  const message = new Uint8Array(247);
  message.set([1, 0, 3, 6]);
  decoded.forEach((key, index) => message.set(key, 4 + index * 32));
  message.set(blockhash, 196);
  message.set([1, 5, 5, 1, 3, 2, 0, 4, 10, 12], 228);
  new DataView(message.buffer).setBigUint64(238, amount, true);
  message[246] = 6;
  const unsignedTransaction = new Uint8Array(DEPOSIT_TRANSACTION_BYTES);
  unsignedTransaction[0] = 1;
  unsignedTransaction.set(message, 65);
  return { message, unsignedTransaction };
}

export function validateUnsignedDepositTransaction(
  bytes: Uint8Array,
  terms: DepositTransactionTerms,
): void {
  requireTransaction(
    bytes instanceof Uint8Array &&
      sameBytes(bytes, buildDepositTransaction(terms).unsignedTransaction),
  );
}

/** Verify the wallet signed the exact canonical message, without wallet edits.
 * This does not prove broadcast, confirmation, payment or available balance. */
export function validateSignedDepositTransaction(
  bytes: Uint8Array,
  terms: DepositTransactionTerms,
) {
  requireTransaction(
    bytes instanceof Uint8Array && bytes.length === DEPOSIT_TRANSACTION_BYTES,
  );
  const snapshot = new Uint8Array(bytes);
  const expected = buildDepositTransaction(terms);
  requireTransaction(
    snapshot[0] === 1 && sameBytes(snapshot.subarray(65), expected.message),
  );
  const signature = snapshot.slice(1, 65);
  let valid = false;
  try {
    valid = ed25519.verify(
      signature,
      expected.message,
      publicKey(terms.sourceWallet),
      { zip215: false },
    );
  } catch {
    throw new DepositTransactionError();
  }
  requireTransaction(valid);
  return { signature: bs58.encode(signature), signedTransaction: snapshot };
}

/** Canonical padded base64, bounded for one legacy transaction or its message. */
export function encodeTransactionBase64(bytes: Uint8Array): string {
  requireTransaction(
    bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= 1232,
  );
  return btoa(String.fromCharCode(...bytes));
}
export function decodeTransactionBase64(value: unknown): Uint8Array {
  requireTransaction(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 1644 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        value,
      ),
  );
  try {
    const bytes = Uint8Array.from(atob(value), (character) =>
      character.charCodeAt(0),
    );
    requireTransaction(
      bytes.length <= 1232 && encodeTransactionBase64(bytes) === value,
    );
    return bytes;
  } catch {
    throw new DepositTransactionError();
  }
}
