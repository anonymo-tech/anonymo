export type CallReceiptPayload = {
  version: 1;
  receiptId: string;
  callId: string;
  holdId: string;
  routeVersion: string;
  signerKeyId: string;
  signerEpoch: number;
  issuedAt: string;
  actualUsd6: string;
  requestDigest: string;
};
export type MediaReceiptPayload = {
  version: 2;
  kind: 'media';
  receiptId: string;
  mediaJobId: string;
  holdId: string;
  accountCommitment: string;
  routeVersion: string;
  modelId: string;
  modality: 'image' | 'video';
  signerKeyId: string;
  signerEpoch: number;
  issuedAt: string;
  actualUsd6: string;
  settlement: 'captured' | 'released';
  generationState: 'completed' | 'failed' | 'cancelled';
  requestDigest: string;
  providerReferenceDigest: string | null;
  assetDelivery: 'not_attested';
};
export type ReceiptPayload = CallReceiptPayload | MediaReceiptPayload;
export type SignedReceipt = { payload: ReceiptPayload; signature: string };

export type ReceiptErrorCode =
  | 'invalid_receipt'
  | 'invalid_key'
  | 'empty_tree'
  | 'duplicate_receipt'
  | 'invalid_tree';
export class ReceiptError extends Error {
  readonly code: ReceiptErrorCode;
  constructor(code: ReceiptErrorCode) {
    super('The receipt data is not valid.');
    this.name = 'ReceiptError';
    this.code = code;
  }
}

export function exactObject(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ReceiptError('invalid_receipt');
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== 'string' || !fields.includes(key))
  )
    throw new ReceiptError('invalid_receipt');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => !('value' in descriptors[key as string])))
    throw new ReceiptError('invalid_receipt');
  return value as Record<string, unknown>;
}

export function identifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  )
    throw new ReceiptError('invalid_receipt');
  return value;
}

export function utcTime(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  )
    throw new ReceiptError('invalid_receipt');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
    throw new ReceiptError('invalid_receipt');
  return value;
}

export function epoch(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 2_147_483_647
  )
    throw new ReceiptError('invalid_receipt');
  return value;
}

export function hex(value: unknown, length: number): string {
  if (
    typeof value !== 'string' ||
    value.length !== length * 2 ||
    !/^[0-9a-f]+$/.test(value)
  )
    throw new ReceiptError('invalid_receipt');
  return value;
}

export function toBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
}

function normalizeCallPayload(value: unknown): CallReceiptPayload {
  const item = exactObject(value, [
    'version',
    'receiptId',
    'callId',
    'holdId',
    'routeVersion',
    'signerKeyId',
    'signerEpoch',
    'issuedAt',
    'actualUsd6',
    'requestDigest',
  ]);
  if (
    item.version !== 1 ||
    typeof item.actualUsd6 !== 'string' ||
    !/^(0|[1-9][0-9]{0,15})$/.test(item.actualUsd6) ||
    BigInt(item.actualUsd6) > BigInt('9000000000000000')
  )
    throw new ReceiptError('invalid_receipt');
  return Object.freeze({
    version: 1,
    receiptId: identifier(item.receiptId),
    callId: identifier(item.callId),
    holdId: identifier(item.holdId),
    routeVersion: identifier(item.routeVersion),
    signerKeyId: identifier(item.signerKeyId),
    signerEpoch: epoch(item.signerEpoch),
    issuedAt: utcTime(item.issuedAt),
    actualUsd6: item.actualUsd6,
    requestDigest: hex(item.requestDigest, 32),
  });
}

function normalizeMediaPayload(value: unknown): MediaReceiptPayload {
  const item = exactObject(value, [
    'version',
    'kind',
    'receiptId',
    'mediaJobId',
    'holdId',
    'accountCommitment',
    'routeVersion',
    'modelId',
    'modality',
    'signerKeyId',
    'signerEpoch',
    'issuedAt',
    'actualUsd6',
    'settlement',
    'generationState',
    'requestDigest',
    'providerReferenceDigest',
    'assetDelivery',
  ]);
  if (
    item.version !== 2 ||
    item.kind !== 'media' ||
    typeof item.actualUsd6 !== 'string' ||
    !/^(0|[1-9][0-9]{0,15})$/.test(item.actualUsd6) ||
    BigInt(item.actualUsd6) > BigInt('9000000000000000') ||
    item.settlement !== (item.actualUsd6 === '0' ? 'released' : 'captured') ||
    typeof item.generationState !== 'string' ||
    !['completed', 'failed', 'cancelled'].includes(item.generationState) ||
    (item.modality !== 'image' && item.modality !== 'video') ||
    typeof item.modelId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/.test(item.modelId) ||
    item.assetDelivery !== 'not_attested' ||
    ((item.actualUsd6 !== '0' || item.generationState === 'completed') &&
      item.providerReferenceDigest === null) ||
    (item.generationState === 'cancelled' &&
      (item.actualUsd6 !== '0' || item.providerReferenceDigest !== null))
  )
    throw new ReceiptError('invalid_receipt');
  return Object.freeze({
    version: 2,
    kind: 'media',
    receiptId: identifier(item.receiptId),
    mediaJobId: identifier(item.mediaJobId),
    holdId: identifier(item.holdId),
    accountCommitment: hex(item.accountCommitment, 32),
    routeVersion: identifier(item.routeVersion),
    modelId: item.modelId,
    modality: item.modality,
    signerKeyId: identifier(item.signerKeyId),
    signerEpoch: epoch(item.signerEpoch),
    issuedAt: utcTime(item.issuedAt),
    actualUsd6: item.actualUsd6,
    settlement: item.settlement as MediaReceiptPayload['settlement'],
    generationState:
      item.generationState as MediaReceiptPayload['generationState'],
    requestDigest: hex(item.requestDigest, 32),
    providerReferenceDigest:
      item.providerReferenceDigest === null
        ? null
        : hex(item.providerReferenceDigest, 32),
    assetDelivery: 'not_attested',
  });
}

export function normalizePayload(value: unknown): ReceiptPayload {
  // Read the data descriptor, never execute a submitted version getter.
  const version =
    value && typeof value === 'object'
      ? Object.getOwnPropertyDescriptor(value, 'version')?.value
      : undefined;
  return version === 2
    ? normalizeMediaPayload(value)
    : normalizeCallPayload(value);
}

/** Per-hold commitment avoids exposing a stable owner identifier in portable receipts. */
export async function receiptAccountCommitment(
  accountId: string,
  holdId: string,
): Promise<string> {
  for (const id of [accountId, holdId])
    if (
      typeof id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        id,
      )
    )
      throw new ReceiptError('invalid_receipt');
  return sha256(
    new TextEncoder().encode(
      `conclave:receipt-account:v2\0${accountId}\0${holdId}`,
    ),
  );
}

export function normalizeSignedReceipt(value: unknown): SignedReceipt {
  const item = exactObject(value, ['payload', 'signature']);
  return Object.freeze({
    payload: normalizePayload(item.payload),
    signature: hex(item.signature, 64),
  });
}

/** Versioned ASCII fields, fixed insertion order, compact UTF-8 JSON. v1 bytes remain unchanged. */
export function canonicalReceiptBytes(value: unknown): Uint8Array {
  const payload = normalizePayload(value);
  return new TextEncoder().encode(
    `conclave:receipt:v${payload.version}\0${JSON.stringify(payload)}`,
  );
}

export function concatenate(
  ...parts: readonly Uint8Array[]
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

export async function sha256(...parts: readonly Uint8Array[]): Promise<string> {
  return toHex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', concatenate(...parts)),
    ),
  );
}
