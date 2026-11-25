import { createVaultKey, decryptRecord, encryptRecord, unlockVaultKey, type EncryptedRecord } from '../vault-crypto.ts';

export type MemoryKind = 'fact' | 'pref' | 'event' | 'summary';
export type MemoryItem = {
  id: string;
  characterId: string | null;
  kind: MemoryKind;
  text: string;
  createdAt: string;
  weight: number;
};

export type MemoryBlob = { id: string; version: number; ciphertext: string; deleted: boolean };

export const utf8 = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const maxBlob = 8192;
export const MAX_RECOVERY_BYTES = 64 * 1024 * 1024;
export const KINDS: readonly MemoryKind[] = ['fact', 'pref', 'event', 'summary'];
export const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const maxVersion = 2_147_483_647;

export function encode(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decode(value: string) {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('Invalid vault encoding.');
  const result = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  if (encode(result) !== value) throw new Error('Invalid vault encoding.');
  return result;
}

export const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export function concat(...values: Uint8Array[]) {
  const output = new Uint8Array(values.reduce((size, value) => size + value.length, 0));
  let offset = 0;
  for (const value of values) { output.set(value, offset); offset += value.length; }
  return output;
}

async function hkdf(secret: Uint8Array, label: string) {
  const material = await crypto.subtle.importKey('raw', new Uint8Array(secret), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8.encode(label),
  }, material, 256));
}

const aes = (key: Uint8Array) => crypto.subtle.importKey('raw', new Uint8Array(key), 'AES-GCM', false, ['encrypt', 'decrypt']);

export async function memoryKeys(secret: Uint8Array) {
  if (secret.length !== 32) throw new Error('A memory secret is 32 bytes.');
  const [key, id, auth] = await Promise.all([
    hkdf(secret, 'vault-memory-v1').then(aes),
    hkdf(secret, 'vault-id-v1').then(hex),
    hkdf(secret, 'vault-sync-auth-v1'),
  ]);
  const verifier = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', auth)));
  return { key, id, verifier, authorization: `Vault ${id}.${hex(auth)}` };
}

export type MemoryKeys = Awaited<ReturnType<typeof memoryKeys>>;
const aad = (keys: MemoryKeys, id: string, version: number) => `vault-memory-v1/${keys.id}/${id}/${version}`;

export function validItem(value: unknown): value is MemoryItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as MemoryItem;
  return typeof item.id === 'string' && uuid.test(item.id) &&
    (item.characterId === null || (typeof item.characterId === 'string' && item.characterId.length <= 256)) &&
    KINDS.includes(item.kind) && typeof item.text === 'string' && item.text.trim().length > 0 &&
    typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt)) &&
    Number.isFinite(item.weight) && item.weight >= 0 && item.weight <= 2;
}

export function validBlob(value: unknown): value is MemoryBlob {
  if (!value || typeof value !== 'object') return false;
  const row = value as MemoryBlob;
  return typeof row.id === 'string' && uuid.test(row.id) &&
    Number.isInteger(row.version) && row.version >= 1 && row.version <= maxVersion &&
    typeof row.deleted === 'boolean' && typeof row.ciphertext === 'string' &&
    row.ciphertext.length <= Math.ceil(maxBlob * 4 / 3) &&
    (row.deleted ? row.ciphertext === '' : row.ciphertext.length >= 39);
}

export async function sealItem(keys: MemoryKeys, item: MemoryItem, version: number): Promise<MemoryBlob> {
  const record = await encryptRecord(keys.key, aad(keys, item.id, version), utf8.encode(JSON.stringify(item)));
  const bytes = concat(record.iv, new Uint8Array(record.ciphertext));
  if (!validItem(item) || bytes.length > maxBlob || version > maxVersion) throw new Error('This memory is too large or invalid.');
  return { id: item.id, version, ciphertext: encode(bytes), deleted: false };
}

function readRecord(encoded: string): EncryptedRecord {
  const bytes = decode(encoded);
  if (bytes.length < 29) throw new Error('Invalid encrypted vault record.');
  return { iv: bytes.slice(0, 12), ciphertext: bytes.slice(12).buffer };
}

export async function openItem(keys: MemoryKeys, row: MemoryBlob): Promise<MemoryItem | null> {
  if (!validBlob(row)) throw new Error('Invalid memory record.');
  if (row.deleted) return null;
  const item: unknown = JSON.parse(decoder.decode(await decryptRecord(keys.key, aad(keys, row.id, row.version), readRecord(row.ciphertext))));
  if (!validItem(item) || item.id !== row.id) throw new Error('Invalid memory item.');
  return item;
}

export function blobWins(incoming: MemoryBlob, current?: MemoryBlob) {
  if (!current) return true;
  if (incoming.deleted !== current.deleted) return incoming.deleted;
  if (incoming.version !== current.version) return incoming.version > current.version;
  return incoming.ciphertext > current.ciphertext;
}

const pack = (record: EncryptedRecord) => encode(concat(record.iv, new Uint8Array(record.ciphertext)));
const recoveryLabel = 'anovault-memory-v1';

export async function exportRecovery(secret: Uint8Array, rows: readonly MemoryBlob[], passphrase: string) {
  const { key, config } = await createVaultKey(passphrase);
  const data = utf8.encode(JSON.stringify({ secret: encode(secret), rows }));
  const payload = await encryptRecord(key, recoveryLabel, data);
  const file = JSON.stringify({ format: recoveryLabel, salt: encode(config.salt), check: pack(config.check), data: pack(payload) });
  if (file.length > MAX_RECOVERY_BYTES) throw new Error('This vault is too large for a recovery file.');
  return file;
}

export async function importRecovery(file: string, passphrase: string) {
  if (file.length > MAX_RECOVERY_BYTES) throw new Error('This recovery file is too large.');
  const { format, salt, check, data } = JSON.parse(file);
  if (format !== recoveryLabel || typeof salt !== 'string' || salt.length !== 22 ||
    typeof check !== 'string' || check.length > 128 || typeof data !== 'string') throw new Error('Choose a Vault Memory recovery file.');
  const key = await unlockVaultKey(passphrase, { salt: decode(salt), check: readRecord(check) });
  const payload = JSON.parse(decoder.decode(await decryptRecord(key, recoveryLabel, readRecord(data))));
  if (typeof payload.secret !== 'string' || !Array.isArray(payload.rows) || !payload.rows.every(validBlob) ||
    new Set(payload.rows.map((row: MemoryBlob) => row.id)).size !== payload.rows.length) throw new Error('Invalid recovery file.');
  const secret = decode(payload.secret);
  const keys = await memoryKeys(secret);
  const rows: MemoryBlob[] = payload.rows;
  await Promise.all(rows.map((row) => openItem(keys, row)));
  return { secret, rows };
}

const pairingLifetime = 5 * 60_000;
const curve = { name: 'ECDH', namedCurve: 'P-256' };
const pairRequest = 'anopair1';
const pairResponse = 'anojoin1';

function parsePairingRequest(code: string, now: number) {
  const result = new RegExp(`^${pairRequest}\\.([0-9]{13})\\.([A-Za-z0-9_-]{87})$`).exec(code);
  if (!result || Number(result[1]) <= now || Number(result[1]) > now + pairingLifetime + 60_000)
    throw new Error('The pairing request is invalid or has expired.');
  return decode(result[2]!);
}

async function pairKey(privateKey: CryptoKey, publicBytes: Uint8Array, request: string) {
  const publicKey = await crypto.subtle.importKey('raw', new Uint8Array(publicBytes), curve, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  return aes(await hkdf(new Uint8Array(shared), `vault-memory-pair-v1:${request}`));
}

export async function newPairing(now = Date.now()) {
  let receiver: CryptoKeyPair | null = await crypto.subtle.generateKey(curve, false, ['deriveBits']);
  const code = `${pairRequest}.${now + pairingLifetime}.${encode(new Uint8Array(await crypto.subtle.exportKey('raw', receiver.publicKey)))}`;
  let busy = false;
  return {
    code,
    async accept(response: string, currentTime = Date.now()) {
      parsePairingRequest(code, currentTime);
      if (!receiver || busy) throw new Error('This pairing request was already used.');
      const fields = new RegExp(`^${pairResponse}\\.([A-Za-z0-9_-]{87})\\.([A-Za-z0-9_-]{80})$`).exec(response.trim());
      if (!fields) throw new Error('Enter the response from your other device.');
      busy = true;
      try {
        const key = await pairKey(receiver.privateKey, decode(fields[1]!), code);
        const secret = new Uint8Array(await decryptRecord(key, code, readRecord(fields[2]!)));
        if (secret.length !== 32) throw new Error('Invalid pairing response.');
        receiver = null;
        return secret;
      } catch {
        throw new Error('This response could not be opened with your pairing request.');
      } finally {
        busy = false;
      }
    },
  };
}

export async function answerPairing(code: string, secret: Uint8Array, now = Date.now()) {
  const request = code.trim();
  const publicBytes = parsePairingRequest(request, now);
  const sender = await crypto.subtle.generateKey(curve, false, ['deriveBits']);
  const key = await pairKey(sender.privateKey, publicBytes, request);
  const record = await encryptRecord(key, request, new Uint8Array(secret));
  return `${pairResponse}.${encode(new Uint8Array(await crypto.subtle.exportKey('raw', sender.publicKey)))}.${pack(record)}`;
}
