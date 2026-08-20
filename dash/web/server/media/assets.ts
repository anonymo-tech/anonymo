import type { Pool, PoolClient } from 'pg';
import { one, transaction } from '../db/database.ts';
import { requireCondition } from '../core/errors.ts';
import { uuidField } from '../core/http.ts';
import type { DataKeyring } from '../core/encryption.ts';
import {
  decryptMedia,
  MEDIA_CHUNK_BYTES,
  MEDIA_MAX_BYTES,
  type EncryptedMedia,
  type StoredMediaType,
} from './asset-crypto.ts';

/** Logical encrypted payload limits. PostgreSQL indexes, row overhead, WAL and
 * backups require additional capacity; these are not a provider spending cap. */
export type MediaStoragePolicy = Readonly<{
  accountBytes: number;
  globalBytes: number;
}>;
export const DEFAULT_MEDIA_STORAGE_POLICY: MediaStoragePolicy = Object.freeze({
  // Three supported video models can reserve their worst-case output together.
  // The shared allocation ceiling is unchanged; individual admission is atomic.
  accountBytes: 384 * MEDIA_CHUNK_BYTES,
  globalBytes: 512 * MEDIA_CHUNK_BYTES,
});
export type MediaAssetState = 'reserved' | 'ready' | 'released' | 'deleted';
type AssetRow = {
  id: string;
  account_id: string;
  project_id: string;
  job_id: string;
  modality: 'image' | 'video';
  state: MediaAssetState;
  max_plaintext_bytes: number;
  reservation_bytes: number;
  allocated_bytes: number;
  manifest_ciphertext: string | null;
  chunk_count: number | null;
  byte_length: number | null;
  content_type: StoredMediaType | null;
  sha256: string | null;
  created_at: Date;
  ready_at: Date | null;
  removed_at: Date | null;
};
export type MediaAsset = ReturnType<typeof assetView>;
function assetView(row: AssetRow) {
  return {
    id: row.id,
    accountId: row.account_id,
    projectId: row.project_id,
    jobId: row.job_id,
    modality: row.modality,
    state: row.state,
    maxPlaintextBytes: row.max_plaintext_bytes,
    allocatedBytes: row.allocated_bytes,
    contentType: row.content_type,
    byteLength: row.byte_length,
    createdAt: row.created_at.toISOString(),
    readyAt: row.ready_at?.toISOString() ?? null,
    removedAt: row.removed_at?.toISOString() ?? null,
  };
}
export function mediaStoragePolicy(
  value: unknown = DEFAULT_MEDIA_STORAGE_POLICY,
): MediaStoragePolicy {
  requireCondition(
    value && typeof value === 'object' && !Array.isArray(value),
    503,
    'MEDIA_STORAGE_CONFIGURATION_REQUIRED',
    'Media storage limits require a valid server configuration.',
  );
  const data = value as Record<string, unknown>;
  requireCondition(
    Object.keys(data).sort().join(',') === 'accountBytes,globalBytes' &&
      Number.isSafeInteger(data.accountBytes) &&
      Number.isSafeInteger(data.globalBytes) &&
      Number(data.accountBytes) > 0 &&
      Number(data.globalBytes) >= Number(data.accountBytes) &&
      Number(data.globalBytes) <= 1024 * 1024 * MEDIA_CHUNK_BYTES,
    503,
    'MEDIA_STORAGE_CONFIGURATION_REQUIRED',
    'Media storage limits require a valid server configuration.',
  );
  return Object.freeze({
    accountBytes: Number(data.accountBytes),
    globalBytes: Number(data.globalBytes),
  });
}
export function mediaStorageReservationBytes(modality: 'image' | 'video') {
  requireCondition(
    modality === 'image' || modality === 'video',
    400,
    'INVALID_MEDIA_MODALITY',
    'Choose an image or video media route.',
  );
  const maximum =
    modality === 'image' ? 20 * MEDIA_CHUNK_BYTES : MEDIA_MAX_BYTES;
  return maximum + 28 * Math.ceil(maximum / MEDIA_CHUNK_BYTES) + 2048;
}
function canonical(value: string) {
  return uuidField(value).toLowerCase();
}
async function owner(db: PoolClient, accountId: string, active: boolean) {
  requireCondition(
    await one(
      db,
      'SELECT id FROM accounts WHERE id=$1 AND ($2::boolean=false OR disabled_at IS NULL) FOR UPDATE',
      [accountId, active],
    ),
    401,
    'SESSION_REQUIRED',
    'This account is unavailable.',
  );
}
async function quotaLock(db: PoolClient) {
  // All capacity writers lock their account first, then this common lock. No
  // transaction holding this lock subsequently locks another account or job.
  await db.query(
    "SELECT pg_advisory_xact_lock(hashtext('conclave_media_storage_v1'))",
  );
}
async function rowForJob(db: PoolClient, accountId: string, jobId: string) {
  return one<AssetRow>(
    db,
    'SELECT * FROM media_assets WHERE account_id=$1 AND job_id=$2',
    [accountId, jobId],
  );
}
function requireAsset(row: AssetRow | null): asserts row is AssetRow {
  requireCondition(
    row,
    404,
    'MEDIA_ASSET_NOT_FOUND',
    'This saved media is unavailable.',
  );
}

/** Trusted importer lookup, including disabled accounts whose obligations must
 * still finish. HTTP readers must use the owned read/delete functions below. */
export async function getMediaAssetForJob(
  db: PoolClient,
  accountId: string,
  jobId: string,
): Promise<MediaAsset | null> {
  const row = await rowForJob(db, canonical(accountId), canonical(jobId));
  return row ? assetView(row) : null;
}

/** Invoke in the same transaction as the job/hold insertion, before commit.
 * Failure rolls back enqueue and money reservation together. */
export async function reserveMediaStorageInTransaction(
  db: PoolClient,
  input: { accountId: string; jobId: string },
  policy: MediaStoragePolicy = DEFAULT_MEDIA_STORAGE_POLICY,
): Promise<MediaAsset> {
  const accountId = canonical(input.accountId),
    jobId = canonical(input.jobId);
  await owner(db, accountId, true);
  await quotaLock(db);
  const existing = await rowForJob(db, accountId, jobId);
  if (existing) return assetView(existing);
  const limits = mediaStoragePolicy(policy);
  const job = await one<{
    id: string;
    project_id: string;
    modality: 'image' | 'video';
  }>(
    db,
    `SELECT j.id,j.project_id,j.modality FROM media_jobs j JOIN projects p ON p.id=j.project_id AND p.account_id=j.account_id WHERE j.id=$1 AND j.account_id=$2 AND j.state='queued' AND j.dispatched_at IS NULL AND p.archived_at IS NULL`,
    [jobId, accountId],
  );
  requireCondition(
    job,
    409,
    'MEDIA_STORAGE_RESERVATION_REQUIRED',
    'Storage must be reserved before generation.',
  );
  const requested = mediaStorageReservationBytes(job.modality);
  const usage = await one<{ total: string; owned: string }>(
    db,
    'SELECT COALESCE(sum(allocated_bytes),0)::text AS total,COALESCE(sum(allocated_bytes) FILTER (WHERE account_id=$1),0)::text AS owned FROM media_assets WHERE allocated_bytes>0',
    [accountId],
  );
  requireCondition(
    usage,
    503,
    'MEDIA_STORAGE_UNAVAILABLE',
    'Media storage is unavailable.',
  );
  requireCondition(
    BigInt(usage.owned) + BigInt(requested) <= BigInt(limits.accountBytes),
    409,
    'MEDIA_ACCOUNT_STORAGE_LIMIT',
    'This account has insufficient media storage.',
  );
  requireCondition(
    BigInt(usage.total) + BigInt(requested) <= BigInt(limits.globalBytes),
    503,
    'MEDIA_STORAGE_CAPACITY',
    'Media storage is currently full.',
  );
  const row = await one<AssetRow>(
    db,
    `INSERT INTO media_assets(id,account_id,project_id,job_id,modality,max_plaintext_bytes,reservation_bytes,allocated_bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`,
    [
      crypto.randomUUID(),
      accountId,
      job.project_id,
      jobId,
      job.modality,
      job.modality === 'image' ? 20 * MEDIA_CHUNK_BYTES : MEDIA_MAX_BYTES,
      requested,
    ],
  );
  requireAsset(row);
  return assetView(row);
}

/** No billing writes. An import error retains its capacity for a later retry;
 * only terminal generation without a deliverable may release the reservation. */
export async function releaseUnusedMediaStorageInTransaction(
  db: PoolClient,
  input: { accountId: string; jobId: string },
): Promise<MediaAsset | null> {
  const accountId = canonical(input.accountId),
    jobId = canonical(input.jobId);
  await owner(db, accountId, false);
  await quotaLock(db);
  const existing = await rowForJob(db, accountId, jobId);
  if (!existing || existing.state !== 'reserved')
    return existing ? assetView(existing) : null;
  const terminal = await one(
    db,
    "SELECT id FROM media_jobs WHERE id=$1 AND account_id=$2 AND state IN ('failed','cancelled') AND result_ciphertext IS NULL",
    [jobId, accountId],
  );
  requireCondition(
    terminal,
    409,
    'MEDIA_STORAGE_STILL_REQUIRED',
    'This generation still requires its storage reservation.',
  );
  const row = await one<AssetRow>(
    db,
    "UPDATE media_assets SET state='released',allocated_bytes=0,removed_at=now() WHERE id=$1 RETURNING *",
    [existing.id],
  );
  requireAsset(row);
  return assetView(row);
}

/** Terminal import failure cannot be retried. Release only unused capacity;
 * completed generation and its settled monetary charge remain unchanged. */
export async function releaseFailedMediaIngestStorageInTransaction(
  db: PoolClient,
  input: { accountId: string; jobId: string },
): Promise<MediaAsset | null> {
  const accountId = canonical(input.accountId),
    jobId = canonical(input.jobId);
  await owner(db, accountId, false);
  await quotaLock(db);
  const existing = await rowForJob(db, accountId, jobId);
  if (!existing || existing.state !== 'reserved')
    return existing ? assetView(existing) : null;
  const terminal = await one(
    db,
    `SELECT j.id FROM media_jobs j JOIN media_ingests i ON i.job_id=j.id
     WHERE j.id=$1 AND j.account_id=$2 AND j.state='completed' AND j.result_ciphertext IS NOT NULL
       AND i.state='failed' AND i.lease_token IS NULL AND i.lease_expires_at IS NULL`,
    [jobId, accountId],
  );
  requireCondition(
    terminal,
    409,
    'MEDIA_STORAGE_STILL_REQUIRED',
    'This import still requires its storage reservation.',
  );
  const row = await one<AssetRow>(
    db,
    "UPDATE media_assets SET state='released',allocated_bytes=0,removed_at=now() WHERE id=$1 RETURNING *",
    [existing.id],
  );
  requireAsset(row);
  return assetView(row);
}

function snapshotEncrypted(stored: EncryptedMedia): EncryptedMedia {
  requireCondition(
    stored &&
      typeof stored.manifest === 'string' &&
      Buffer.byteLength(stored.manifest) <= 2048 &&
      Array.isArray(stored.chunks) &&
      stored.chunks.length >= 1 &&
      stored.chunks.length <= 100 &&
      stored.chunks.every(
        (chunk) =>
          chunk instanceof Uint8Array &&
          chunk.byteLength >= 29 &&
          chunk.byteLength <= MEDIA_CHUNK_BYTES + 28,
      ),
    503,
    'MEDIA_CONTENT_UNAVAILABLE',
    'This saved media could not be verified.',
  );
  return {
    manifest: stored.manifest,
    chunks: stored.chunks.map((chunk) => new Uint8Array(chunk)),
  };
}

/** Only the trusted sanitizer/importer may call this function. Encryption alone
 * does not prove media safety. Authenticating precedes an atomic immutable save. */
export async function finalizeMediaAsset(
  pool: Pool,
  accountId: string,
  jobId: string,
  encrypted: EncryptedMedia,
  keyring: DataKeyring,
): Promise<MediaAsset> {
  return transaction(pool, (db) =>
    finalizeMediaAssetInTransaction(db, accountId, jobId, encrypted, keyring),
  );
}

/** Allows a caller to commit its fenced import lease in this same transaction. */
export async function finalizeMediaAssetInTransaction(
  db: PoolClient,
  accountId: string,
  jobId: string,
  encrypted: EncryptedMedia,
  keyring: DataKeyring,
): Promise<MediaAsset> {
  accountId = canonical(accountId);
  jobId = canonical(jobId);
  await owner(db, accountId, false);
  await quotaLock(db);
  const initial = await rowForJob(db, accountId, jobId);
  requireAsset(initial);
  const stored = snapshotEncrypted(encrypted);
  const verified = await decryptMedia(
    stored,
    { accountId, projectId: initial.project_id, assetId: initial.id },
    keyring,
  );
  requireCondition(
    (initial.modality === 'video') === (verified.contentType === 'video/mp4') &&
      verified.bytes.byteLength <= initial.max_plaintext_bytes,
    409,
    'MEDIA_ASSET_MISMATCH',
    'The saved media does not match its reservation.',
  );
  const bytes = verified.bytes.byteLength;
  const allocated =
    Buffer.byteLength(stored.manifest) +
    stored.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const row = initial;
  requireAsset(row);
  if (row.state === 'ready') {
    requireCondition(
      row.sha256 === verified.sha256 &&
        row.byte_length === bytes &&
        row.content_type === verified.contentType,
      409,
      'MEDIA_ASSET_CONFLICT',
      'This asset already contains different media.',
    );
    return assetView(row);
  }
  requireCondition(
    row.state === 'reserved',
    409,
    'MEDIA_ASSET_REMOVED',
    'This media reservation is no longer available.',
  );
  const complete = await one(
    db,
    "SELECT id FROM media_jobs WHERE id=$1 AND account_id=$2 AND state='completed' AND result_ciphertext IS NOT NULL",
    [jobId, accountId],
  );
  requireCondition(
    complete,
    409,
    'MEDIA_GENERATION_INCOMPLETE',
    'The generation must complete before delivery.',
  );
  requireCondition(
    allocated <= row.reservation_bytes,
    409,
    'MEDIA_ASSET_TOO_LARGE',
    'This media exceeds its storage reservation.',
  );
  for (let ordinal = 0; ordinal < stored.chunks.length; ordinal++)
    await db.query(
      'INSERT INTO media_asset_chunks(asset_id,ordinal,ciphertext) VALUES($1,$2,$3)',
      [row.id, ordinal, Buffer.from(stored.chunks[ordinal])],
    );
  const ready = await one<AssetRow>(
    db,
    `UPDATE media_assets SET state='ready',allocated_bytes=$2,manifest_ciphertext=$3,chunk_count=$4,byte_length=$5,content_type=$6,sha256=$7,ready_at=now() WHERE id=$1 RETURNING *`,
    [
      row.id,
      allocated,
      stored.manifest,
      stored.chunks.length,
      bytes,
      verified.contentType,
      verified.sha256,
    ],
  );
  requireAsset(ready);
  return assetView(ready);
}

/** Reads all ordered chunks in one account-locked transaction, then verifies the
 * complete authenticated envelope before exposing any plaintext bytes. */
export async function readOwnedMediaAsset(
  pool: Pool,
  accountId: string,
  assetId: string,
  keyring: DataKeyring,
) {
  accountId = canonical(accountId);
  assetId = canonical(assetId);
  const saved = await transaction(pool, async (db) => {
    await owner(db, accountId, true);
    const row = await one<AssetRow>(
      db,
      'SELECT * FROM media_assets WHERE id=$1 AND account_id=$2',
      [assetId, accountId],
    );
    requireAsset(row);
    requireCondition(
      row.state === 'ready',
      404,
      'MEDIA_ASSET_NOT_FOUND',
      'This saved media is unavailable.',
    );
    const chunks = await db.query<{ ordinal: number; ciphertext: Buffer }>(
      'SELECT ordinal,ciphertext FROM media_asset_chunks WHERE asset_id=$1 ORDER BY ordinal',
      [assetId],
    );
    requireCondition(
      chunks.rows.length === row.chunk_count &&
        chunks.rows.every((chunk, index) => chunk.ordinal === index),
      503,
      'MEDIA_CONTENT_UNAVAILABLE',
      'This saved media could not be verified.',
    );
    return {
      row,
      stored: {
        manifest: row.manifest_ciphertext!,
        chunks: chunks.rows.map((chunk) => chunk.ciphertext),
      },
    };
  });
  const result = await decryptMedia(
    saved.stored,
    { accountId, projectId: saved.row.project_id, assetId },
    keyring,
  );
  requireCondition(
    result.sha256 === saved.row.sha256 &&
      result.bytes.byteLength === saved.row.byte_length &&
      result.contentType === saved.row.content_type,
    503,
    'MEDIA_CONTENT_UNAVAILABLE',
    'This saved media could not be verified.',
  );
  return { ...result, asset: assetView(saved.row) };
}

/** Deletes logical live ciphertext, not provider copies or retained DB backups.
 * There is no billing adjustment, and a deleted identity can never be reused. */
export async function deleteOwnedMediaAsset(
  pool: Pool,
  accountId: string,
  assetId: string,
): Promise<MediaAsset> {
  accountId = canonical(accountId);
  assetId = canonical(assetId);
  return transaction(pool, async (db) => {
    await owner(db, accountId, true);
    await quotaLock(db);
    const row = await one<AssetRow>(
      db,
      'SELECT * FROM media_assets WHERE id=$1 AND account_id=$2',
      [assetId, accountId],
    );
    requireAsset(row);
    if (row.state === 'deleted') return assetView(row);
    requireCondition(
      row.state === 'ready',
      409,
      'MEDIA_ASSET_NOT_READY',
      'Only saved media can be deleted.',
    );
    const deleted = await one<AssetRow>(
      db,
      "UPDATE media_assets SET state='deleted',allocated_bytes=0,manifest_ciphertext=NULL,removed_at=now() WHERE id=$1 RETURNING *",
      [assetId],
    );
    await db.query('DELETE FROM media_asset_chunks WHERE asset_id=$1', [
      assetId,
    ]);
    requireAsset(deleted);
    return assetView(deleted);
  });
}
