import { gatewayApiOrigin, parseGatewayOrigin } from '../gateway/origin.ts';
import type { Pool, PoolClient } from 'pg';
import { one, transaction } from '../db/database.ts';
import { decryptText, type DataKeyring } from '../core/encryption.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';
import type { GatewayMedia } from '../gateway/index.ts';
import { encryptMedia } from './asset-crypto.ts';
import {
  finalizeMediaAssetInTransaction,
  releaseFailedMediaIngestStorageInTransaction,
} from './assets.ts';
import { downloadGatewayMedia, MediaDownloadError } from './download.ts';
import { sanitizeMedia, MediaSanitizeError } from './sanitize.ts';
import { lockMediaOwner } from './store.ts';

type ImportLease = {
  job_id: string;
  account_id: string;
  project_id: string;
  asset_id: string;
  modality: 'image' | 'video';
  model_id: string;
  result_ciphertext: string;
  provider_reference_ciphertext: string | null;
  lease_token: string;
  attempts: number;
};
export type MediaIngestOptions = {
  /** Trusted worker/test dependencies only. No browser-supplied URL or processor. */
  fetch?: typeof globalThis.fetch;
  apiOrigin?: string;
  signal?: AbortSignal;
  sanitize?: typeof sanitizeMedia;
};

async function claim(pool: Pool): Promise<ImportLease | null> {
  return transaction(pool, async (db) => {
    const row = await one<Omit<ImportLease, 'lease_token'>>(
      db,
      `SELECT i.job_id,i.attempts,j.account_id,j.project_id,j.modality,j.result_ciphertext,
        j.provider_reference_ciphertext,a.id AS asset_id,r.model_id
       FROM media_ingests i JOIN media_jobs j ON j.id=i.job_id
       JOIN media_assets a ON a.job_id=j.id JOIN route_versions r ON r.id=j.route_version_id
       WHERE i.state IN ('queued','retry') AND i.next_attempt_at<=now() AND i.attempts<10
         AND j.state='completed' AND a.state='reserved'
       ORDER BY i.next_attempt_at,i.job_id FOR UPDATE OF i SKIP LOCKED LIMIT 1`,
    );
    if (!row) return null;
    const token = crypto.randomUUID();
    await db.query(
      `UPDATE media_ingests SET state='processing',attempts=attempts+1,lease_token=$2,
        lease_expires_at=now()+interval '180 seconds',error_code=NULL,updated_at=now() WHERE job_id=$1`,
      [row.job_id, token],
    );
    return { ...row, lease_token: token, attempts: row.attempts + 1 };
  });
}
async function ownLease(db: PoolClient, job: ImportLease) {
  // Account first: asset finalization/deletion and generation settlement use it too.
  await lockMediaOwner(db, job.account_id, false);
  requireCondition(
    await one(
      db,
      `SELECT job_id FROM media_ingests WHERE job_id=$1 AND state='processing'
       AND lease_token=$2 AND lease_expires_at>now() FOR UPDATE`,
      [job.job_id, job.lease_token],
    ),
    409,
    'MEDIA_INGEST_LEASE_LOST',
    'This worker no longer owns the media import.',
  );
}
async function savedMedia(
  job: ImportLease,
  keyring: DataKeyring,
): Promise<GatewayMedia> {
  const value: unknown = JSON.parse(
    await decryptText(
      job.result_ciphertext,
      `${job.account_id}:media-result:${job.job_id}`,
      keyring,
    ),
  );
  requireCondition(
    value && typeof value === 'object' && !Array.isArray(value),
    409,
    'MEDIA_RESULT_MISMATCH',
    'The saved media result is unavailable.',
  );
  const result = value as Record<string, unknown>;
  requireCondition(
    result.status === 'completed' && result.modelId === job.model_id,
    409,
    'MEDIA_RESULT_MISMATCH',
    'The saved media result does not match this job.',
  );
  let media: unknown;
  if (job.modality === 'image') {
    requireCondition(
      result.clientRequestId === job.job_id &&
        Array.isArray(result.media) &&
        result.media.length === 1,
      409,
      'MEDIA_RESULT_MISMATCH',
      'The image result does not match this job.',
    );
    media = result.media[0];
  } else {
    requireCondition(
      job.provider_reference_ciphertext,
      409,
      'MEDIA_RESULT_MISMATCH',
      'The video reference is unavailable.',
    );
    const reference = await decryptText(
      job.provider_reference_ciphertext,
      `${job.account_id}:media-reference:${job.job_id}`,
      keyring,
    );
    requireCondition(
      typeof result.id === 'string' &&
        /^[A-Za-z0-9_-]{1,128}$/.test(result.id) &&
        reference === `video:${result.id}`,
      409,
      'MEDIA_RESULT_MISMATCH',
      'The video result does not match this job.',
    );
    media = result.media;
  }
  requireCondition(
    media && typeof media === 'object' && !Array.isArray(media),
    409,
    'MEDIA_RESULT_MISMATCH',
    'The saved result has no supported media.',
  );
  const item = media as Record<string, unknown>;
  requireCondition(
    typeof item.url === 'string' &&
      typeof item.contentType === 'string' &&
      (job.modality === 'video'
        ? item.contentType === 'video/mp4'
        : ['image/png', 'image/jpeg', 'image/webp'].includes(item.contentType)),
    409,
    'MEDIA_RESULT_MISMATCH',
    'The saved media type does not match this job.',
  );
  // downloadGatewayMedia independently verifies the complete signed provider URL.
  return {
    url: item.url,
    contentType: item.contentType as GatewayMedia['contentType'],
  };
}

/** GET acquisition, canonical processing and encrypted storage only. No provider
 * generation/submission and no ledger mutation are possible in this worker. */
export async function runNextMediaIngest(
  pool: Pool,
  keyring: DataKeyring,
  options: MediaIngestOptions = {},
): Promise<boolean> {
  if (options.signal?.aborted) return false;
  const apiOrigin =
    options.apiOrigin === undefined
      ? gatewayApiOrigin()
      : parseGatewayOrigin(options.apiOrigin);
  requireCondition(
    apiOrigin,
    503,
    'MEDIA_CONFIGURATION_REQUIRED',
    'The media acquisition origin is not configured.',
  );
  const job = await claim(pool);
  if (!job) return false;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let beating = false;
  const heartbeat = setInterval(() => {
    if (beating) return;
    beating = true;
    void pool
      .query(
        `UPDATE media_ingests SET lease_expires_at=now()+interval '180 seconds'
      WHERE job_id=$1 AND state='processing' AND lease_token=$2 AND lease_expires_at>now()`,
        [job.job_id, job.lease_token],
      )
      .then((r) => {
        if (r.rowCount !== 1) controller.abort();
      })
      .catch(abort)
      .finally(() => {
        beating = false;
      });
  }, 2000);
  try {
    const media = await savedMedia(job, keyring);
    const acquired = await downloadGatewayMedia(media, {
      fetch: options.fetch,
      apiOrigin,
      signal: controller.signal,
    });
    const processed = await (options.sanitize ?? sanitizeMedia)(acquired, {
      signal: controller.signal,
    });
    requireCondition(
      !controller.signal.aborted,
      409,
      'MEDIA_INGEST_INTERRUPTED',
      'Media processing was interrupted.',
    );
    requireCondition(
      processed.sanitizerVersion === 'media-canonical-v1' &&
        (job.modality === 'video'
          ? processed.contentType === 'video/mp4'
          : processed.contentType.startsWith('image/')),
      409,
      'MEDIA_SANITIZATION_FAILED',
      'Media processing did not produce a supported asset.',
    );
    const encrypted = await encryptMedia(
      processed.bytes,
      processed.contentType,
      {
        accountId: job.account_id,
        projectId: job.project_id,
        assetId: job.asset_id,
      },
      keyring,
    );
    await transaction(pool, async (db) => {
      await ownLease(db, job);
      requireCondition(
        !controller.signal.aborted,
        409,
        'MEDIA_INGEST_INTERRUPTED',
        'Media processing was interrupted.',
      );
      await finalizeMediaAssetInTransaction(
        db,
        job.account_id,
        job.job_id,
        encrypted,
        keyring,
      );
      await db.query(
        `UPDATE media_ingests SET state='completed',lease_token=NULL,
        lease_expires_at=NULL,error_code=NULL,updated_at=now() WHERE job_id=$1`,
        [job.job_id],
      );
    });
  } catch (error) {
    if (
      error instanceof ServiceError &&
      error.code === 'MEDIA_INGEST_LEASE_LOST'
    )
      return true;
    const invalidDownload =
      error instanceof MediaDownloadError &&
      [
        'invalid_url',
        'invalid_request',
        'invalid_response',
        'too_large',
      ].includes(error.code);
    const invalidMedia =
      error instanceof MediaSanitizeError &&
      ['invalid', 'unsupported', 'too_large'].includes(error.code);
    const terminal =
      invalidMedia ||
      invalidDownload ||
      (error instanceof ServiceError &&
        ['MEDIA_RESULT_MISMATCH', 'MEDIA_SANITIZATION_FAILED'].includes(
          error.code,
        ));
    const code = invalidMedia
      ? 'MEDIA_SANITIZATION_FAILED'
      : invalidDownload
        ? 'MEDIA_ACQUISITION_REJECTED'
        : terminal
          ? 'MEDIA_RESULT_UNAVAILABLE'
          : 'MEDIA_INGEST_RETRY';
    try {
      await transaction(pool, async (db) => {
        await ownLease(db, job);
        await db.query(
          `UPDATE media_ingests SET state=$2,error_code=$3,lease_token=NULL,
          lease_expires_at=NULL,next_attempt_at=now()+make_interval(secs=>$4),updated_at=now() WHERE job_id=$1`,
          [
            job.job_id,
            terminal || job.attempts >= 10 ? 'failed' : 'retry',
            code,
            Math.min(3600, 30 * 2 ** job.attempts),
          ],
        );
        if (terminal || job.attempts >= 10)
          await releaseFailedMediaIngestStorageInTransaction(db, {
            accountId: job.account_id,
            jobId: job.job_id,
          });
      });
    } catch (failure) {
      if (
        !(
          failure instanceof ServiceError &&
          failure.code === 'MEDIA_INGEST_LEASE_LOST'
        )
      )
        throw failure;
    }
  } finally {
    clearInterval(heartbeat);
    controller.abort();
    options.signal?.removeEventListener('abort', abort);
  }
  return true;
}

/** Expiry permits another GET/processing attempt, never another paid generation. */
export async function recoverExpiredMediaIngests(pool: Pool): Promise<number> {
  const rows = await pool.query<{ job_id: string; account_id: string }>(
    `SELECT i.job_id,j.account_id FROM media_ingests i JOIN media_jobs j ON j.id=i.job_id
     WHERE i.state='processing' AND i.lease_expires_at<=now()
     ORDER BY i.lease_expires_at,i.job_id LIMIT 100`,
  );
  let count = 0;
  for (const row of rows.rows)
    await transaction(pool, async (db) => {
      await lockMediaOwner(db, row.account_id, false);
      const expired = await one<{ attempts: number }>(
        db,
        `SELECT attempts FROM media_ingests WHERE job_id=$1 AND state='processing'
       AND lease_expires_at<=now() FOR UPDATE SKIP LOCKED`,
        [row.job_id],
      );
      if (!expired) return;
      const terminal = expired.attempts >= 10;
      await db.query(
        `UPDATE media_ingests SET state=$2,lease_token=NULL,lease_expires_at=NULL,
      error_code='MEDIA_INGEST_INTERRUPTED',next_attempt_at=now(),updated_at=now() WHERE job_id=$1`,
        [row.job_id, terminal ? 'failed' : 'retry'],
      );
      if (terminal)
        await releaseFailedMediaIngestStorageInTransaction(db, {
          accountId: row.account_id,
          jobId: row.job_id,
        });
      count++;
    });
  return count;
}
