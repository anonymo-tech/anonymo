import {
  configuredKeyring,
  decryptText,
  encryptText,
  type DataKeyring,
} from '../core/encryption.ts';
import { ServiceError } from '../core/errors.ts';

export const MEDIA_CHUNK_BYTES = 1024 * 1024;
export const MEDIA_MAX_BYTES = 100 * MEDIA_CHUNK_BYTES;
const types = ['image/png', 'image/jpeg', 'image/webp', 'video/mp4'] as const;
export type StoredMediaType = (typeof types)[number];
export type AssetIdentity = {
  accountId: string;
  projectId: string;
  assetId: string;
};
export type EncryptedMedia = { manifest: string; chunks: Uint8Array[] };
type Manifest = {
  version: 1;
  keyId: string;
  contentType: StoredMediaType;
  byteLength: number;
  chunkCount: number;
  sha256: string;
};
/** A frozen, authenticated manifest. Plain objects and deserialized copies are
 * not accepted by decryptMediaChunk; the server keeps the verified key privately. */
export type AuthenticatedMediaManifest = Readonly<Manifest>;
const authenticatedManifests = new WeakMap<
  AuthenticatedMediaManifest,
  {
    scope: string;
    key: CryptoKey;
  }
>();

function unavailable(): never {
  throw new ServiceError(
    503,
    'MEDIA_CONTENT_UNAVAILABLE',
    'This saved media could not be verified.',
  );
}

function identityScope(identity: AssetIdentity) {
  const ids = [identity.accountId, identity.projectId, identity.assetId];
  if (
    ids.some(
      (id) =>
        typeof id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          id,
        ),
    )
  )
    return unavailable();
  return ids.join(':');
}

function checkedKeyring(value: DataKeyring) {
  return configuredKeyring({
    CONCLAVE_DATA_KEYS: JSON.stringify(value.keys),
    CONCLAVE_ACTIVE_DATA_KEY: value.active,
  });
}

async function digest(bytes: Uint8Array) {
  return Buffer.from(
    await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>),
  ).toString('hex');
}

function aad(identity: string, manifest: Manifest, index: number) {
  return new TextEncoder().encode(
    JSON.stringify([
      'conclave:media-chunk:v1',
      identity,
      manifest.keyId,
      manifest.contentType,
      manifest.byteLength,
      manifest.chunkCount,
      manifest.sha256,
      index,
    ]),
  );
}

function chunkLength(manifest: Manifest, index: number) {
  return Math.min(
    MEDIA_CHUNK_BYTES,
    manifest.byteLength - index * MEDIA_CHUNK_BYTES,
  );
}

function parseManifest(text: string): Manifest {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return unavailable();
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).sort().join(',') !==
      'byteLength,chunkCount,contentType,keyId,sha256,version' ||
    data.version !== 1 ||
    typeof data.keyId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,40}$/.test(data.keyId) ||
    !types.includes(data.contentType as StoredMediaType) ||
    !Number.isSafeInteger(data.byteLength) ||
    Number(data.byteLength) < 1 ||
    Number(data.byteLength) > MEDIA_MAX_BYTES ||
    (data.contentType !== 'video/mp4' &&
      Number(data.byteLength) > 20 * MEDIA_CHUNK_BYTES) ||
    data.chunkCount !==
      Math.ceil(Number(data.byteLength) / MEDIA_CHUNK_BYTES) ||
    typeof data.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(data.sha256)
  )
    return unavailable();
  return data as Manifest;
}

/** Binary storage primitive only. This does not validate or remove media metadata.
 * The importer must canonicalize media before invoking this function. */
export async function encryptMedia(
  bytes: Uint8Array,
  contentType: StoredMediaType,
  identity: AssetIdentity,
  keys: DataKeyring,
): Promise<EncryptedMedia> {
  try {
    const scope = identityScope(identity);
    const keyring = checkedKeyring(keys);
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength < 1 ||
      bytes.byteLength > MEDIA_MAX_BYTES ||
      !types.includes(contentType) ||
      (contentType !== 'video/mp4' && bytes.byteLength > 20 * MEDIA_CHUNK_BYTES)
    )
      return unavailable();
    // Snapshot once so a mutable caller buffer cannot change after the manifest hash.
    const plaintext = new Uint8Array(bytes);
    const manifest: Manifest = {
      version: 1,
      keyId: keyring.active,
      contentType,
      byteLength: plaintext.byteLength,
      chunkCount: Math.ceil(plaintext.byteLength / MEDIA_CHUNK_BYTES),
      sha256: await digest(plaintext),
    };
    const key = await crypto.subtle.importKey(
      'raw',
      Buffer.from(keyring.keys[manifest.keyId], 'base64'),
      'AES-GCM',
      false,
      ['encrypt'],
    );
    const chunks: Uint8Array[] = [];
    for (let index = 0; index < manifest.chunkCount; index++) {
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: nonce,
          additionalData: aad(scope, manifest, index),
          tagLength: 128,
        },
        key,
        plaintext.subarray(
          index * MEDIA_CHUNK_BYTES,
          index * MEDIA_CHUNK_BYTES + chunkLength(manifest, index),
        ),
      );
      const envelope = new Uint8Array(12 + encrypted.byteLength);
      envelope.set(nonce);
      envelope.set(new Uint8Array(encrypted), 12);
      chunks.push(envelope);
    }
    return {
      manifest: await encryptText(
        JSON.stringify(manifest),
        `${scope}:media-manifest`,
        keyring,
      ),
      chunks,
    };
  } catch {
    return unavailable();
  }
}

/** Authenticates metadata and imports its retained key without reading chunks.
 * sha256 is an authenticated commitment, not a hash of any bytes read here. */
export async function authenticateMediaManifest(
  ciphertext: string,
  identity: AssetIdentity,
  keys: DataKeyring,
): Promise<AuthenticatedMediaManifest> {
  try {
    const scope = identityScope(identity);
    const keyring = checkedKeyring(keys);
    if (typeof ciphertext !== 'string' || ciphertext.length > 2048)
      return unavailable();
    const manifest = Object.freeze(
      parseManifest(
        await decryptText(ciphertext, `${scope}:media-manifest`, keyring),
      ),
    );
    if (
      !keyring.keys[manifest.keyId] ||
      ciphertext.split('.')[1] !== manifest.keyId
    )
      return unavailable();
    const key = await crypto.subtle.importKey(
      'raw',
      Buffer.from(keyring.keys[manifest.keyId], 'base64'),
      'AES-GCM',
      false,
      ['decrypt'],
    );
    authenticatedManifests.set(manifest, { scope, key });
    return manifest;
  } catch {
    return unavailable();
  }
}

/** Authenticates one indexed chunk against a previously verified manifest.
 * A partial read does not recompute or verify the complete plaintext hash. */
export async function decryptMediaChunk(
  ciphertext: Uint8Array,
  index: number,
  manifest: AuthenticatedMediaManifest,
): Promise<Uint8Array> {
  try {
    const authenticated = authenticatedManifests.get(manifest);
    if (
      !authenticated ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= manifest.chunkCount ||
      !(ciphertext instanceof Uint8Array) ||
      ciphertext.byteLength !== chunkLength(manifest, index) + 28
    )
      return unavailable();
    // Snapshot before the first await so caller mutation cannot change the AEAD input.
    const envelope = new Uint8Array(ciphertext);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: envelope.subarray(0, 12),
        additionalData: aad(authenticated.scope, manifest, index),
        tagLength: 128,
      },
      authenticated.key,
      envelope.subarray(12),
    );
    return new Uint8Array(plaintext);
  } catch {
    return unavailable();
  }
}

/** Authenticates the manifest, every ordered chunk, and the complete plaintext hash.
 * No bytes are returned on partial, substituted, or corrupt storage reads. */
export async function decryptMedia(
  stored: EncryptedMedia,
  identity: AssetIdentity,
  keys: DataKeyring,
): Promise<{
  bytes: Uint8Array;
  contentType: StoredMediaType;
  sha256: string;
}> {
  try {
    const manifest = await authenticateMediaManifest(
      stored.manifest,
      identity,
      keys,
    );
    if (
      !Array.isArray(stored.chunks) ||
      stored.chunks.length !== manifest.chunkCount
    )
      return unavailable();
    const plaintext = new Uint8Array(manifest.byteLength);
    for (let index = 0; index < manifest.chunkCount; index++) {
      plaintext.set(
        await decryptMediaChunk(stored.chunks[index], index, manifest),
        index * MEDIA_CHUNK_BYTES,
      );
    }
    if ((await digest(plaintext)) !== manifest.sha256) return unavailable();
    return {
      bytes: plaintext,
      contentType: manifest.contentType,
      sha256: manifest.sha256,
    };
  } catch {
    return unavailable();
  }
}
