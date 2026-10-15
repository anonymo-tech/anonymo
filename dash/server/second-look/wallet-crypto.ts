import { createHmac, hkdfSync } from 'node:crypto';
import {
  configuredKeyring,
  encryptText,
  decryptText,
  type DataKeyring,
} from '../core/encryption.ts';
import { ServiceError } from '../core/errors.ts';
export { configuredKeyring };
export type { DataKeyring };
export function walletDigest(
  accountId: string,
  kind: string,
  value: string,
  keyring: DataKeyring,
  keyId = keyring.active,
) {
  if (!keyring.keys[keyId])
    throw new ServiceError(
      503,
      'STORAGE_KEY_REQUIRED',
      'Encrypted wallet storage is unavailable.',
    );
  return createHmac(
    'sha256',
    Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(keyring.keys[keyId], 'base64'),
        Buffer.from(accountId),
        Buffer.from('conclave-wallet-lookup-v1'),
        32,
      ),
    ),
  )
    .update(
      JSON.stringify(['conclave-wallet-lookup-v1', accountId, kind, value]),
    )
    .digest('hex');
}
export function walletKeyId(digest: string) {
  return digest.slice(0, digest.indexOf('.'));
}
function scope(
  accountId: string,
  walletId: string,
  kind: string,
  recordId = '',
) {
  return `wallet:${accountId}:${walletId}:${kind}${recordId ? ':' + recordId : ''}`;
}
export async function sealWallet(
  value: unknown,
  accountId: string,
  walletId: string,
  kind: string,
  keyring: DataKeyring,
  recordId = '',
) {
  return encryptText(
    JSON.stringify(value),
    scope(accountId, walletId, kind, recordId),
    keyring,
  );
}
export async function openWallet<T>(
  ciphertext: string,
  accountId: string,
  walletId: string,
  kind: string,
  keyring: DataKeyring,
  recordId = '',
): Promise<T> {
  try {
    return JSON.parse(
      await decryptText(
        ciphertext,
        scope(accountId, walletId, kind, recordId),
        keyring,
      ),
    ) as T;
  } catch {
    throw new ServiceError(
      503,
      'CONTENT_UNAVAILABLE',
      'This encrypted wallet cache could not be read.',
    );
  }
}
