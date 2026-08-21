import type { Pool, PoolClient } from 'pg';
import { one, transaction } from '../db/database.ts';
import { requireCondition } from '../core/errors.ts';
import { uuidField } from '../core/http.ts';
import type { DataKeyring } from '../core/encryption.ts';
import {
  authenticateMediaManifest,
  decryptMediaChunk,
  type AuthenticatedMediaManifest,
  type StoredMediaType,
} from './asset-crypto.ts';

type ReadRow = {
  id: string;
  account_id: string;
  project_id: string;
  job_id: string;
  manifest_ciphertext: string;
  content_type: StoredMediaType;
  byte_length: number;
  chunk_count: number;
  sha256: string;
};
export type OwnedMediaReader = Readonly<{
  id: string;
  accountId: string;
  projectId: string;
  jobId: string;
  byteLength: number;
  contentType: StoredMediaType;
  sha256: string;
  chunkCount: number;
  readChunk: (index: number) => Promise<Uint8Array>;
}>;

function verified(condition: unknown): asserts condition {
  requireCondition(
    condition,
    503,
    'MEDIA_CONTENT_UNAVAILABLE',
    'This saved media could not be verified.',
  );
}

async function readRow(db: PoolClient, accountId: string, assetId: string) {
  // All supported delete/finalization paths acquire this same account lock.
  // It is held only for this metadata/chunk read, never across network delivery.
  requireCondition(
    await one(
      db,
      'SELECT id FROM accounts WHERE id=$1 AND disabled_at IS NULL FOR UPDATE',
      [accountId],
    ),
    401,
    'SESSION_REQUIRED',
    'This account is unavailable.',
  );
  const row = await one<ReadRow>(
    db,
    `SELECT id,account_id,project_id,job_id,manifest_ciphertext,content_type,byte_length,chunk_count,sha256
     FROM media_assets WHERE id=$1 AND account_id=$2 AND state='ready' FOR SHARE`,
    [assetId, accountId],
  );
  requireCondition(
    row,
    404,
    'MEDIA_ASSET_NOT_FOUND',
    'This saved media is unavailable.',
  );
  verified(row.id === assetId && row.account_id === accountId);
  return row;
}

function matchesManifest(row: ReadRow, manifest: AuthenticatedMediaManifest) {
  verified(
    row.byte_length === manifest.byteLength &&
      row.chunk_count === manifest.chunkCount &&
      row.content_type === manifest.contentType &&
      row.sha256 === manifest.sha256,
  );
}

/** Opens authenticated immutable metadata without selecting encrypted chunks.
 * Each read fetches and authenticates at most one 1 MiB chunk in its own short
 * transaction. A returned chunk linearizes before a concurrent deletion; later
 * reads fail after deletion. The caller owns stream/session/range lifecycles.
 * sha256 is the authenticated manifest commitment; partial reads do not recompute
 * the complete plaintext hash. No database connection is retained by this object. */
export async function openOwnedMediaReader(
  pool: Pool,
  accountId: string,
  assetId: string,
  keyring: DataKeyring,
): Promise<OwnedMediaReader> {
  accountId = uuidField(accountId).toLowerCase();
  assetId = uuidField(assetId).toLowerCase();
  const opened = await transaction(pool, async (db) => {
    const row = await readRow(db, accountId, assetId);
    const manifest = await authenticateMediaManifest(
      row.manifest_ciphertext,
      { accountId, projectId: row.project_id, assetId },
      keyring,
    );
    matchesManifest(row, manifest);
    return { row: Object.freeze({ ...row }), manifest };
  });
  return Object.freeze({
    id: assetId,
    accountId,
    projectId: opened.row.project_id,
    jobId: opened.row.job_id,
    byteLength: opened.manifest.byteLength,
    contentType: opened.manifest.contentType,
    sha256: opened.manifest.sha256,
    chunkCount: opened.manifest.chunkCount,
    async readChunk(index: number) {
      verified(
        Number.isSafeInteger(index) &&
          index >= 0 &&
          index < opened.manifest.chunkCount,
      );
      return transaction(pool, async (db) => {
        const current = await readRow(db, accountId, assetId);
        // Exact ciphertext equality identifies the original authenticated version.
        // No unchecked or replacement manifest is used to interpret a chunk.
        verified(
          current.id === opened.row.id &&
            current.account_id === opened.row.account_id &&
            current.project_id === opened.row.project_id &&
            current.job_id === opened.row.job_id &&
            current.manifest_ciphertext === opened.row.manifest_ciphertext,
        );
        matchesManifest(current, opened.manifest);
        // Immutable chunk reads need only SELECT privileges. The account and
        // asset locks above serialize the state change required for deletion.
        const chunk = await one<{ ordinal: number; ciphertext: Buffer }>(
          db,
          'SELECT ordinal,ciphertext FROM media_asset_chunks WHERE asset_id=$1 AND ordinal=$2',
          [assetId, index],
        );
        verified(chunk && chunk.ordinal === index);
        return decryptMediaChunk(chunk.ciphertext, index, opened.manifest);
      });
    },
  });
}
