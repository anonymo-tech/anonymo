import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';

export const DEPOSIT_TOKEN_PROGRAM =
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const DEPOSIT_TRANSACTION_BYTES = 312;
export const DEPOSIT_ATA_TRANSACTION_BYTES = 418;
export const DEPOSIT_ASSOCIATED_TOKEN_PROGRAM =
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const DEPOSIT_SYSTEM_PROGRAM = '11111111111111111111111111111111';
export type DepositTransactionTerms = {
  sourceWallet: string;
  sourceTokenAccount: string;
  recipientTokenAccount: string;
  mint: string;
  reference: string;
  amountUsd6: string;
  recentBlockhash: string;
  /** Explicit permission for the payer to fund only the recipient's derived ATA. */
  createRecipientAccount?: boolean;
  recipientWallet?: string;
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

/** Browser-safe offline PDA derivation; it does not assert onchain existence. */
export function depositRecipientTokenAddress(
  owner: string,
  mint: string,
): string {
  const marker = new TextEncoder().encode('ProgramDerivedAddress');
  const input = new Uint8Array(129 + marker.length);
  input.set(publicKey(owner), 0);
  input.set(publicKey(DEPOSIT_TOKEN_PROGRAM), 32);
  input.set(publicKey(mint), 64);
  input.set(publicKey(DEPOSIT_ASSOCIATED_TOKEN_PROGRAM), 97);
  input.set(marker, 129);
  for (let bump = 255; bump >= 0; bump--) {
    input[96] = bump;
    const digest = sha256(input);
    try {
      ed25519.Point.fromBytes(digest, true);
    } catch {
      return bs58.encode(digest);
    }
  }
  throw new DepositTransactionError();
}

/** One exact SPL TransferChecked, optionally preceded by one exact ATA
 * CreateIdempotent. The source remains the sole signer and fee/rent payer.
 * No delegate, memo, priority fee, lookup table or arbitrary instruction. */
export function buildDepositTransaction(terms: DepositTransactionTerms) {
  requireTransaction(
    terms.createRecipientAccount === undefined ||
      typeof terms.createRecipientAccount === 'boolean',
  );
  const createRecipientAccount = terms.createRecipientAccount === true;
  if (terms.recipientWallet !== undefined) publicKey(terms.recipientWallet);
  if (createRecipientAccount) {
    requireTransaction(typeof terms.recipientWallet === 'string');
    requireTransaction(
      depositRecipientTokenAddress(terms.recipientWallet, terms.mint) ===
        terms.recipientTokenAccount,
    );
  }
  const keys = [
    terms.sourceWallet,
    terms.sourceTokenAccount,
    terms.recipientTokenAccount,
    terms.mint,
    terms.reference,
    DEPOSIT_TOKEN_PROGRAM,
    ...(createRecipientAccount
      ? [
          terms.recipientWallet!,
          DEPOSIT_SYSTEM_PROGRAM,
          DEPOSIT_ASSOCIATED_TOKEN_PROGRAM,
        ]
      : []),
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
  const transactionSize = createRecipientAccount
    ? DEPOSIT_ATA_TRANSACTION_BYTES
    : DEPOSIT_TRANSACTION_BYTES;
  const message = new Uint8Array(transactionSize - 65);
  message.set([1, 0, keys.length - 3, keys.length]);
  decoded.forEach((key, index) => message.set(key, 4 + index * 32));
  let offset = 4 + keys.length * 32;
  message.set(blockhash, offset);
  offset += 32;
  message[offset++] = createRecipientAccount ? 2 : 1;
  if (createRecipientAccount) {
    // ATA program: payer, derived ATA, owner, mint, System, legacy Token; discriminator1.
    message.set([8, 6, 0, 2, 6, 3, 7, 5, 1, 1], offset);
    offset += 10;
  }
  message.set([5, 5, 1, 3, 2, 0, 4, 10, 12], offset);
  offset += 9;
  new DataView(message.buffer).setBigUint64(offset, amount, true);
  message[offset + 8] = 6;
  const unsignedTransaction = new Uint8Array(transactionSize);
  unsignedTransaction[0] = 1;
  unsignedTransaction.set(message, 65);
  return { message, unsignedTransaction };
}

/** Recover the persisted creation flag only when all bytes match immutable terms. */
export function depositTransactionCreatesRecipientAccount(
  bytes: Uint8Array,
  terms: Omit<DepositTransactionTerms, 'createRecipientAccount'>,
): boolean {
  requireTransaction(bytes instanceof Uint8Array);
  if (
    sameBytes(
      bytes,
      buildDepositTransaction({ ...terms, createRecipientAccount: false })
        .unsignedTransaction,
    )
  )
    return false;
  requireTransaction(
    sameBytes(
      bytes,
      buildDepositTransaction({ ...terms, createRecipientAccount: true })
        .unsignedTransaction,
    ),
  );
  return true;
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
    bytes instanceof Uint8Array &&
      (bytes.length === DEPOSIT_TRANSACTION_BYTES ||
        bytes.length === DEPOSIT_ATA_TRANSACTION_BYTES),
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
