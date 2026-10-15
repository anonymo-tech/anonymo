import { CHAT_LIMITS } from '../../lib/chat-limits.ts';
import { ServiceError } from './errors.ts';

export type DataKeyring = { active: string; keys: Record<string, string> };

export function configuredKeyring(env: Record<string, string | undefined> = process.env): DataKeyring {
  try {
    const value: unknown = JSON.parse(env.CONCLAVE_DATA_KEYS ?? 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value) || !env.CONCLAVE_ACTIVE_DATA_KEY) throw new Error();
    const keys = value as Record<string, string>;
    if (Object.keys(keys).length < 1 || Object.keys(keys).length > 8 || !keys[env.CONCLAVE_ACTIVE_DATA_KEY]) throw new Error();
    for (const [id, key] of Object.entries(keys)) {
      if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id) || typeof key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, 'base64').length !== 32) throw new Error();
    }
    return { active: env.CONCLAVE_ACTIVE_DATA_KEY, keys };
  } catch {
    throw new ServiceError(503, 'STORAGE_KEY_REQUIRED', 'Encrypted storage is not configured.');
  }
}

function aad(scope: string) {
  if (!scope || scope.length > 256) throw new Error('Invalid encryption scope.');
  return new TextEncoder().encode(`conclave:data:v1:${scope}`);
}

export async function encryptText(text: string, scope: string, keyring: DataKeyring) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > Math.max(CHAT_LIMITS.requestBytes, CHAT_LIMITS.outputBytes)) throw new ServiceError(413, 'CONTENT_TOO_LARGE', 'This content is too large to save.');
  const key = await crypto.subtle.importKey('raw', Buffer.from(keyring.keys[keyring.active], 'base64'), 'AES-GCM', false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(scope) }, key, bytes);
  return `v1.${keyring.active}.${Buffer.from(nonce).toString('base64url')}.${Buffer.from(encrypted).toString('base64url')}`;
}

export async function decryptText(value: string, scope: string, keyring: DataKeyring) {
  try {
    if (value.length > Math.ceil(Math.max(CHAT_LIMITS.requestBytes, CHAT_LIMITS.outputBytes) * 4 / 3) + 256) throw new Error();
    const parts = value.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1' || !keyring.keys[parts[1]] || !/^[\w-]{16}$/.test(parts[2]) || !/^[\w-]{22,}$/.test(parts[3])) throw new Error();
    const key = await crypto.subtle.importKey('raw', Buffer.from(keyring.keys[parts[1]], 'base64'), 'AES-GCM', false, ['decrypt']);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(parts[2], 'base64url'), additionalData: aad(scope) }, key, Buffer.from(parts[3], 'base64url'));
    return new TextDecoder('utf-8', { fatal: true }).decode(decrypted);
  } catch {
    throw new ServiceError(503, 'CONTENT_UNAVAILABLE', 'This saved content could not be decrypted.');
  }
}
