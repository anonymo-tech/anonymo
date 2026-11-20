// The iteration count is part of this storage format. Changing it requires a new format.
export const VAULT_ITERATIONS = 600_000;
export type EncryptedRecord = { iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer };
export type VaultConfig = { salt: Uint8Array<ArrayBuffer>; check: EncryptedRecord };

const utf8 = new TextEncoder();
const checkText = 'anonymo.vault.v1/key-check';

export class WrongPassphrase extends Error {
  constructor() {
    super('Incorrect passphrase.');
  }
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>) {
  const material = await crypto.subtle.importKey('raw', utf8.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: VAULT_ITERATIONS },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

const params = (iv: Uint8Array<ArrayBuffer>, record: string) => ({
  name: 'AES-GCM', iv, additionalData: utf8.encode(record),
});

export async function encryptRecord(key: CryptoKey, record: string, bytes: BufferSource): Promise<EncryptedRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv, ciphertext: await crypto.subtle.encrypt(params(iv, record), key, bytes) };
}

export function decryptRecord(key: CryptoKey, record: string, value: EncryptedRecord) {
  return crypto.subtle.decrypt(params(value.iv, record), key, value.ciphertext);
}

export async function createVaultKey(passphrase: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt);
  const check = await encryptRecord(key, checkText, utf8.encode(checkText));
  return { key, config: { salt, check } };
}

export async function unlockVaultKey(passphrase: string, config: VaultConfig) {
  const key = await deriveKey(passphrase, config.salt);
  try {
    const text = new TextDecoder().decode(await decryptRecord(key, checkText, config.check));
    if (text === checkText) return key;
  } catch {
    // Authentication failed; the same message covers an unreadable key check.
  }
  throw new WrongPassphrase();
}
