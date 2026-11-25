import { isApiKey } from './key-store.ts';
import { readMemorySecret, replaceMemorySecret } from './memory-secret.ts';
import { fromBase64Url, toBase64Url } from './share.ts';
import type { AnonymoClient } from './client.ts';

export type KeySafeIds = { safeId: string; credentialId: string };
export type WrappedKeySafe = { credentialId: string; ciphertext: string; nonce: string };
export type KeySafeUpload = WrappedKeySafe & KeySafeIds;
type Contents = { key: string; memorySecret?: Uint8Array };

const text = new TextEncoder();
const prfInput = text.encode('anonymo-key-safe-prf-v1');
const wrapInfo = text.encode('anonymo-key-safe-wrap-v1');
const random = (size: number) => crypto.getRandomValues(new Uint8Array(size));
const unsupported = () => new Error('This browser or passkey provider does not support passkey encryption (PRF). Use a copied key instead.');

async function wrappingKey(prf: BufferSource, credentialId: string, usage: KeyUsage) {
  if (prf.byteLength !== 32) throw unsupported();
  const input = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: fromBase64Url(credentialId), info: wrapInfo },
    input, { name: 'AES-GCM', length: 256 }, false, [usage],
  );
}

export async function wrapKeySafe(prf: BufferSource, credentialId: string, contents: Contents): Promise<KeySafeUpload> {
  const safeId = toBase64Url(random(16));
  const nonce = random(12);
  const key = await wrappingKey(prf, credentialId, 'encrypt');
  // The encrypted copy of the safe ID lets a new device manage the backup after unlocking it.
  const payload = text.encode(JSON.stringify({
    safeId, key: contents.key, memorySecret: contents.memorySecret && toBase64Url(contents.memorySecret),
  }));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, payload);
  return { safeId, credentialId, ciphertext: toBase64Url(new Uint8Array(ciphertext)), nonce: toBase64Url(nonce) };
}

export async function unwrapKeySafe(prf: BufferSource, credentialId: string, blob: WrappedKeySafe): Promise<Contents & KeySafeIds> {
  try {
    if (blob.credentialId !== credentialId) throw new Error();
    const nonce = fromBase64Url(blob.nonce);
    if (nonce.length !== 12) throw new Error();
    const key = await wrappingKey(prf, credentialId, 'decrypt');
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, fromBase64Url(blob.ciphertext));
    const payload = JSON.parse(new TextDecoder().decode(clear));
    if (typeof payload.key !== 'string' || !isApiKey(payload.key) ||
        typeof payload.safeId !== 'string' || fromBase64Url(payload.safeId).length !== 16) throw new Error();
    const memorySecret = payload.memorySecret === undefined ? undefined : fromBase64Url(payload.memorySecret);
    if (memorySecret && memorySecret.length !== 32) throw new Error();
    return { safeId: payload.safeId, credentialId, key: payload.key, memorySecret };
  } catch {
    throw new Error('This passkey could not open the backup. Try the original passkey or paste your copied key.');
  }
}

function passkeys() {
  if (!globalThis.isSecureContext || !globalThis.PublicKeyCredential || !navigator.credentials) throw unsupported();
  return navigator.credentials;
}

function publicKeyCredential(credential: Credential | null): PublicKeyCredential {
  if (!(credential instanceof PublicKeyCredential)) throw new Error('No passkey was selected.');
  return credential;
}

async function evaluatePasskey(signal: AbortSignal, id?: ArrayBuffer) {
  const credential = publicKeyCredential(await passkeys().get({
    signal,
    publicKey: {
      challenge: random(32),
      userVerification: 'required',
      extensions: { prf: { eval: { first: prfInput } } },
      ...(id ? { allowCredentials: [{ id, type: 'public-key' }] } : {}),
    },
  }));
  const prf = credential.getClientExtensionResults().prf?.results?.first;
  if (prf?.byteLength !== 32) throw unsupported();
  return { prf, credentialId: toBase64Url(new Uint8Array(credential.rawId)) };
}

async function createPasskey(signal: AbortSignal) {
  const credential = publicKeyCredential(await passkeys().create({
    signal,
    publicKey: {
      challenge: random(32),
      rp: { name: 'Anonymo' },
      user: { id: random(32), name: 'Anonymo key', displayName: 'Anonymo key' },
      pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none',
      extensions: { prf: { eval: { first: prfInput } } },
    },
  }));
  const extension = credential.getClientExtensionResults().prf;
  const credentialId = toBase64Url(new Uint8Array(credential.rawId));
  const prf = extension?.results?.first;
  if (prf?.byteLength === 32) return { prf, credentialId };
  if (!extension?.enabled) throw unsupported();
  // Some authenticators can evaluate PRF only during an assertion.
  const evaluated = await evaluatePasskey(signal, credential.rawId);
  if (evaluated.credentialId !== credentialId) throw new Error('Select the passkey you just created.');
  return evaluated;
}

const slot = (demo: boolean) => demo ? 'anonymo.demo.key-safe.v1' : 'anonymo.key-safe.v1'; // gitleaks:allow (a local storage slot name, not a key)

export function localKeySafe(demo: boolean): KeySafeIds | null {
  try {
    const saved = JSON.parse(localStorage.getItem(slot(demo)) ?? 'null');
    if (saved && typeof saved.safeId === 'string' && typeof saved.credentialId === 'string')
      return { safeId: saved.safeId, credentialId: saved.credentialId };
  } catch {
    // Storage may be unavailable. Discoverable unlock still works.
  }
  return null;
}

function rememberSafe(demo: boolean, ids: KeySafeIds) {
  try {
    localStorage.setItem(slot(demo), JSON.stringify({ safeId: ids.safeId, credentialId: ids.credentialId }));
  } catch {
    // Storage may be unavailable. Discoverable unlock still works.
  }
}

/** Where the memory secret is read and installed: the passphrase vault in the browser, a stand-in in tests. */
export type SecretStore = { read: (demo: boolean) => Promise<Uint8Array | null>; replace: (bytes: Uint8Array, demo: boolean) => Promise<void> };
const vaultSecrets: SecretStore = { read: readMemorySecret, replace: replaceMemorySecret };

export async function saveToPasskey(client: AnonymoClient, demo: boolean, key: string, signal: AbortSignal, secrets: SecretStore = vaultSecrets): Promise<KeySafeIds> {
  const { prf, credentialId } = await createPasskey(signal);
  // A locked passphrase vault can't hand over the memory secret; the key is still worth saving on its own.
  const memorySecret = await secrets.read(demo).catch(() => null);
  const blob = await wrapKeySafe(prf, credentialId, { key, memorySecret: memorySecret ?? undefined });
  await client.saveKeySafe(blob, signal);
  const ids = { safeId: blob.safeId, credentialId };
  rememberSafe(demo, ids);
  return ids;
}

export async function unlockWithPasskey(client: AnonymoClient, signal: AbortSignal) {
  const { prf, credentialId } = await evaluatePasskey(signal);
  const blob = await client.findKeySafe(credentialId, signal);
  return unwrapKeySafe(prf, credentialId, blob);
}

export async function restoreFromKeySafe(demo: boolean, opened: Contents & KeySafeIds, save: (key: string) => void, secrets: SecretStore = vaultSecrets) {
  if (opened.memorySecret) await secrets.replace(opened.memorySecret, demo);
  rememberSafe(demo, opened);
  save(opened.key);
}

export async function removeKeySafe(client: AnonymoClient, demo: boolean, ids: KeySafeIds, signal: AbortSignal) {
  await client.deleteKeySafe(ids, signal);
  try {
    if (localKeySafe(demo)?.safeId === ids.safeId) localStorage.removeItem(slot(demo));
  } catch {
    // The backup is already gone from the gateway.
  }
}
