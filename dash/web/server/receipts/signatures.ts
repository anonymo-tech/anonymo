import { ed25519 } from '@noble/curves/ed25519.js';
import {
  canonicalReceiptBytes,
  epoch,
  exactObject,
  hex,
  identifier,
  normalizePayload,
  normalizeSignedReceipt,
  ReceiptError,
  toBytes,
  toHex,
  utcTime,
  type SignedReceipt,
} from './canonical.ts';

export type TrustedSigner = {
  keyId: string;
  epoch: number;
  publicKey: string;
  validFrom: string;
  validUntil: string | null;
  /** Revocation invalidates this epoch, including historical signatures. */
  revoked: boolean;
};
export type TrustedSignerMap = ReadonlyMap<string, TrustedSigner>;
export type SignatureVerification =
  | { valid: true; receipt: SignedReceipt }
  | {
      valid: false;
      reason:
        | 'malformed'
        | 'unknown_signer'
        | 'invalid_signer'
        | 'revoked'
        | 'outside_signer_window'
        | 'future_receipt'
        | 'invalid_signature';
    };

export function signerMapKey(keyId: string, signerEpoch: number): string {
  return `${identifier(keyId)}#${epoch(signerEpoch)}`;
}

function publicKeyBytes(value: unknown) {
  try {
    const bytes = toBytes(hex(value, 32));
    const point = ed25519.Point.fromBytes(bytes, false);
    point.assertValidity();
    if (point.isSmallOrder() || !point.isTorsionFree())
      throw new ReceiptError('invalid_key');
    return bytes;
  } catch {
    throw new ReceiptError('invalid_key');
  }
}

export function receiptPublicKey(secretSeed: Uint8Array): string {
  if (!(secretSeed instanceof Uint8Array) || secretSeed.length !== 32)
    throw new ReceiptError('invalid_key');
  try {
    return toHex(ed25519.getPublicKey(secretSeed));
  } catch {
    throw new ReceiptError('invalid_key');
  }
}

export function signReceipt(
  value: unknown,
  secretSeed: Uint8Array,
): SignedReceipt {
  const payload = normalizePayload(value);
  if (!(secretSeed instanceof Uint8Array) || secretSeed.length !== 32)
    throw new ReceiptError('invalid_key');
  try {
    return Object.freeze({
      payload,
      signature: toHex(
        ed25519.sign(canonicalReceiptBytes(payload), secretSeed),
      ),
    });
  } catch {
    throw new ReceiptError('invalid_key');
  }
}

export function verifyReceiptSignature(
  value: unknown,
  signers: TrustedSignerMap,
  now: string,
): SignatureVerification {
  let receipt: SignedReceipt;
  let checkedNow: string;
  try {
    receipt = normalizeSignedReceipt(value);
    checkedNow = utcTime(now);
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (receipt.payload.issuedAt > checkedNow)
    return { valid: false, reason: 'future_receipt' };
  const payload = receipt.payload;
  const signer = signers.get(
    signerMapKey(payload.signerKeyId, payload.signerEpoch),
  );
  if (!signer) return { valid: false, reason: 'unknown_signer' };
  let key: Uint8Array;
  try {
    exactObject(signer, [
      'keyId',
      'epoch',
      'publicKey',
      'validFrom',
      'validUntil',
      'revoked',
    ]);
    if (
      signer.keyId !== payload.signerKeyId ||
      signer.epoch !== payload.signerEpoch ||
      typeof signer.revoked !== 'boolean'
    )
      return { valid: false, reason: 'invalid_signer' };
    utcTime(signer.validFrom);
    if (
      signer.validUntil !== null &&
      utcTime(signer.validUntil) <= signer.validFrom
    )
      return { valid: false, reason: 'invalid_signer' };
    key = publicKeyBytes(signer.publicKey);
  } catch {
    return { valid: false, reason: 'invalid_signer' };
  }
  if (signer.revoked) return { valid: false, reason: 'revoked' };
  if (
    payload.issuedAt < signer.validFrom ||
    (signer.validUntil !== null && payload.issuedAt >= signer.validUntil)
  )
    return { valid: false, reason: 'outside_signer_window' };
  try {
    if (
      !ed25519.verify(
        toBytes(receipt.signature),
        canonicalReceiptBytes(payload),
        key,
        { zip215: false },
      )
    )
      return { valid: false, reason: 'invalid_signature' };
  } catch {
    return { valid: false, reason: 'invalid_signature' };
  }
  return { valid: true, receipt };
}
