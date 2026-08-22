import type { Pool, PoolClient } from 'pg';
import { one, transaction } from '../db/database.ts';
import {
  decryptText,
  encryptText,
  type DataKeyring,
} from '../core/encryption.ts';
import { digestText } from '../core/digest.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';
import { settleHoldInTransaction } from '../ledger/ledger.ts';
import { ceilRatio } from '../ledger/money.ts';
import {
  GatewayError,
  type GatewayClient,
  type GatewayImageResult,
  type GatewayVideoJob,
} from '../gateway/index.ts';
import {
  assertUsableMediaRoute,
  mediaCapability,
  mediaQuoteAmount,
  mediaRequestHash,
  parseMediaInput,
  type MediaRoute,
  type MediaRuntimeOptions,
} from './contract.ts';
import { lockMediaOwner, type MediaJobRecord } from './store.ts';
import {
  getMediaAssetForJob,
  releaseUnusedMediaStorageInTransaction,
} from './assets.ts';

type Lease = MediaJobRecord & { lease_token: string };
export type MediaProvider = Pick<
  GatewayClient,
  | 'configured'
  | 'generateImage'
  | 'recoverImage'
  | 'submitVideo'
  | 'videoStatus'
>;
const maxPolls = 2000;
async function ownLease(db: PoolClient, job: Lease) {
  await lockMediaOwner(db, job.account_id, false);
  const current = await one<MediaJobRecord>(
    db,
    `SELECT * FROM media_jobs WHERE id=$1 AND lease_token=$2 AND lease_expires_at>now() FOR UPDATE`,
    [job.id, job.lease_token],
  );
  requireCondition(
    current,
    409,
    'MEDIA_LEASE_LOST',
    'This worker no longer owns the media job.',
  );
  return current;
}
async function claim(pool: Pool): Promise<Lease | null> {
  return transaction(pool, async (db) => {
    const row = await one<{ id: string }>(
      db,
      `SELECT id FROM media_jobs WHERE lease_token IS NULL AND (state='queued' OR (state IN ('polling','reconciliation_pending') AND next_poll_at<=now() AND recovery_deadline>now() AND poll_attempts<$1)) ORDER BY COALESCE(next_poll_at,created_at),id FOR UPDATE SKIP LOCKED LIMIT 1`,
      [maxPolls],
    );
    if (!row) return null;
    return one<Lease>(
      db,
      `UPDATE media_jobs SET lease_token=$2,lease_expires_at=now()+interval '120 seconds',updated_at=now() WHERE id=$1 RETURNING *`,
      [row.id, crypto.randomUUID()],
    );
  });
}
async function pending(
  db: PoolClient,
  job: Lease,
  errorCode: string,
  recoverable: boolean,
) {
  await db.query(
    `UPDATE holds SET state='reconciliation_pending',updated_at=now() WHERE id=$1 AND state IN ('held','running')`,
    [job.hold_id],
  );
  await db.query(
    `UPDATE media_jobs SET state='reconciliation_pending',error_code=$2,lease_token=NULL,lease_expires_at=NULL,next_poll_at=CASE WHEN $3::boolean AND recovery_deadline>now() AND poll_attempts<$4 THEN now()+make_interval(secs=>$5) ELSE NULL END,updated_at=now() WHERE id=$1`,
    [
      job.id,
      errorCode,
      recoverable,
      maxPolls,
      Math.min(300, 5 * 2 ** Math.min(job.poll_attempts, 6)),
    ],
  );
}
async function zero(
  pool: Pool,
  job: Lease,
  state: 'failed' | 'cancelled',
  errorCode: string | null,
) {
  await transaction(pool, async (db) => {
    await ownLease(db, job);
    await settleHoldInTransaction(db, {
      accountId: job.account_id,
      holdId: job.hold_id,
      actualUsd6: '0',
      providerReference: null,
    });
    await db.query(
      `UPDATE media_jobs SET state=$2,error_code=$3,lease_token=NULL,lease_expires_at=NULL,next_poll_at=NULL,updated_at=now() WHERE id=$1`,
      [job.id, state, errorCode],
    );
    await releaseUnusedMediaStorageInTransaction(db, {
      accountId: job.account_id,
      jobId: job.id,
    });
  });
}
async function saveResult(
  pool: Pool,
  job: Lease,
  route: MediaRoute,
  result: GatewayImageResult | GatewayVideoJob,
  keyring: DataKeyring,
) {
  requireCondition(
    result.modelId === route.model_id,
    409,
    'MEDIA_RESULT_MISMATCH',
    'The media result does not match the selected model.',
  );
  const reference =
    job.modality === 'image'
      ? `image:${job.id}`
      : `video:${(result as GatewayVideoJob).id}`;
  if (job.modality === 'image')
    requireCondition(
      (result as GatewayImageResult).clientRequestId === job.id,
      409,
      'MEDIA_RESULT_MISMATCH',
      'The image result does not match its saved request.',
    );
  const refCipher = await encryptText(
      reference,
      `${job.account_id}:media-reference:${job.id}`,
      keyring,
    ),
    refHash = await digestText('media-provider-reference-v1', reference);
  const complete = result.status === 'completed',
    failed = result.status === 'failed';
  if (complete)
    requireCondition(
      job.modality === 'image'
        ? (result as GatewayImageResult).media.length === 1
        : !!(result as GatewayVideoJob).media,
      409,
      'MEDIA_RESULT_MISMATCH',
      'The result has an unexpected number of assets.',
    );
  const cipher = complete
    ? await encryptText(
        JSON.stringify(result),
        `${job.account_id}:media-result:${job.id}`,
        keyring,
      )
    : null;
  await transaction(pool, async (db) => {
    const current = await ownLease(db, job);
    requireCondition(
      !current.provider_reference_hash ||
        current.provider_reference_hash === refHash,
      409,
      'MEDIA_RESULT_MISMATCH',
      'The provider operation changed unexpectedly.',
    );
    const duplicate = await one(
      db,
      'SELECT id FROM media_jobs WHERE provider_reference_hash=$1 AND id<>$2',
      [refHash, job.id],
    );
    requireCondition(
      !duplicate,
      409,
      'MEDIA_RESULT_MISMATCH',
      'The provider operation belongs to another saved request.',
    );
    await db.query(
      `UPDATE media_jobs SET provider_reference_ciphertext=COALESCE(provider_reference_ciphertext,$2),provider_reference_hash=COALESCE(provider_reference_hash,$3),result_ciphertext=COALESCE(result_ciphertext,$4),updated_at=now() WHERE id=$1`,
      [job.id, refCipher, refHash, cipher],
    );
    if (!complete && !failed) {
      await db.query(
        `UPDATE media_jobs SET state='polling',next_poll_at=now()+interval '5 seconds',lease_token=NULL,lease_expires_at=NULL,error_code=NULL,updated_at=now() WHERE id=$1`,
        [job.id],
      );
      return;
    }
    if (result.costUsd6 === null) {
      await pending(db, job, 'MEDIA_COST_UNCONFIRMED', true);
      return;
    }
    requireCondition(
      Number.isSafeInteger(result.costUsd6) && result.costUsd6 >= 0,
      409,
      'MEDIA_COST_UNCONFIRMED',
      'The actual generation cost could not be verified.',
    );
    const actual = ceilRatio(
      BigInt(result.costUsd6) * BigInt(10000 + route.pricing.markupBps),
      10000n,
    ).toString();
    const hold = await one<{ maximum_usd6: string }>(
      db,
      'SELECT maximum_usd6::text FROM holds WHERE id=$1',
      [job.hold_id],
    );
    if (!hold || BigInt(actual) > BigInt(hold.maximum_usd6)) {
      await pending(db, job, 'MEDIA_COST_EXCEEDS_RESERVATION', false);
      return;
    }
    await settleHoldInTransaction(db, {
      accountId: job.account_id,
      holdId: job.hold_id,
      actualUsd6: actual,
      providerReference: refHash,
    });
    await db.query(
      `UPDATE media_jobs SET state=$2,error_code=$3,lease_token=NULL,lease_expires_at=NULL,next_poll_at=NULL,updated_at=now() WHERE id=$1`,
      [
        job.id,
        complete ? 'completed' : 'failed',
        failed ? 'MEDIA_GENERATION_FAILED' : null,
      ],
    );
    if (failed)
      await releaseUnusedMediaStorageInTransaction(db, {
        accountId: job.account_id,
        jobId: job.id,
      });
  });
}

/** Exactly one paid submission per persisted dispatch marker. All later attempts are read-only lookups. */
export async function runNextMediaJob(
  pool: Pool,
  provider: MediaProvider,
  keyring: DataKeyring,
  options: MediaRuntimeOptions = {},
): Promise<boolean> {
  if (!provider.configured) return false;
  const job = await claim(pool);
  if (!job) return false;
  let dispatched = job.dispatched_at !== null,
    heartbeat: ReturnType<typeof setInterval> | undefined;
  const lookup = dispatched;
  const controller = new AbortController();
  let beating = false;
  try {
    const route = await one<MediaRoute>(
      pool,
      'SELECT * FROM route_versions WHERE id=$1',
      [job.route_version_id],
    );
    requireCondition(
      route,
      409,
      'MEDIA_ROUTE_UNAVAILABLE',
      'The media route is unavailable.',
    );
    const input = parseMediaInput(
      JSON.parse(
        await decryptText(
          job.input_ciphertext,
          `${job.account_id}:media-input:${job.id}`,
          keyring,
        ),
      ),
    );
    requireCondition(
      (await mediaRequestHash(job.project_id, job.route_version_id, input)) ===
        job.request_hash,
      409,
      'MEDIA_INTEGRITY_FAILED',
      'The saved media input changed.',
    );
    if (!dispatched) {
      if (job.cancel_requested_at) {
        await zero(pool, job, 'cancelled', null);
        return true;
      }
      requireCondition(
        mediaCapability(options.env, options.storageReady).configured,
        503,
        'MEDIA_DISPATCH_DISABLED',
        'New media generation is disabled.',
      );
      assertUsableMediaRoute(route);
      mediaQuoteAmount(route, input);
      await transaction(pool, async (db) => {
        const current = await ownLease(db, job);
        requireCondition(
          current.state === 'queued' &&
            !current.dispatched_at &&
            !current.cancel_requested_at,
          409,
          'MEDIA_NOT_DISPATCHABLE',
          'This job cannot be dispatched.',
        );
        const asset = await getMediaAssetForJob(db, job.account_id, job.id);
        requireCondition(
          asset?.state === 'reserved',
          409,
          'MEDIA_STORAGE_RESERVATION_REQUIRED',
          'Storage must be reserved before generation.',
        );
        const eligible = await one(
          db,
          `SELECT a.id FROM accounts a JOIN projects p ON p.account_id=a.id JOIN route_versions r ON r.id=$3 WHERE a.id=$1 AND p.id=$2 AND a.disabled_at IS NULL AND p.archived_at IS NULL AND r.enabled AND r.expires_at>now() FOR SHARE OF p,r`,
          [job.account_id, job.project_id, route.id],
        );
        requireCondition(
          eligible,
          409,
          'MEDIA_NOT_DISPATCHABLE',
          'This account, project or route cannot dispatch.',
        );
        const hold = await one(
          db,
          `UPDATE holds SET state='running',updated_at=now() WHERE id=$1 AND state='held' AND cancel_requested_at IS NULL RETURNING id`,
          [job.hold_id],
        );
        requireCondition(
          hold,
          409,
          'MEDIA_NOT_DISPATCHABLE',
          'This reservation cannot dispatch.',
        );
        await db.query(
          `UPDATE media_jobs SET state='dispatching',dispatched_at=now(),updated_at=now() WHERE id=$1`,
          [job.id],
        );
      });
      dispatched = true;
    } else {
      requireCondition(
        job.modality === 'image' || job.provider_reference_ciphertext,
        409,
        'MEDIA_RECOVERY_UNAVAILABLE',
        'No safe provider lookup is available.',
      );
      await transaction(pool, async (db) => {
        await ownLease(db, job);
        await db.query(
          'UPDATE media_jobs SET poll_attempts=poll_attempts+1 WHERE id=$1',
          [job.id],
        );
      });
      job.poll_attempts++;
    }
    heartbeat = setInterval(() => {
      if (beating) return;
      beating = true;
      void pool
        .query(
          `UPDATE media_jobs SET lease_expires_at=now()+interval '120 seconds' WHERE id=$1 AND lease_token=$2 AND lease_expires_at>now()`,
          [job.id, job.lease_token],
        )
        .then((r) => {
          if (r.rowCount !== 1) controller.abort();
        })
        .catch(() => controller.abort())
        .finally(() => {
          beating = false;
        });
    }, 2000);
    let result: GatewayImageResult | GatewayVideoJob;
    if (lookup) {
      if (job.modality === 'image')
        result = await provider.recoverImage(job.id, controller.signal);
      else {
        const reference = await decryptText(
          job.provider_reference_ciphertext!,
          `${job.account_id}:media-reference:${job.id}`,
          keyring,
        );
        requireCondition(
          /^video:[A-Za-z0-9_-]{1,128}$/.test(reference),
          409,
          'MEDIA_INTEGRITY_FAILED',
          'The saved provider reference is unavailable.',
        );
        result = await provider.videoStatus(
          reference.slice(6),
          controller.signal,
        );
        requireCondition(
          (result as GatewayVideoJob).id === reference.slice(6),
          409,
          'MEDIA_RESULT_MISMATCH',
          'The provider returned another operation.',
        );
      }
    } else if (input.options.kind === 'image') {
      result = await provider.generateImage({
        modelId: route.model_id,
        prompt: input.prompt,
        privacy: 'standard',
        clientRequestId: job.id,
        count: 1,
        resolution: input.options.resolution,
        aspectRatio: input.options.aspectRatio,
        requestId: job.id,
        signal: controller.signal,
      });
    } else {
      result = await provider.submitVideo({
        modelId: route.model_id,
        prompt: input.prompt,
        privacy: 'standard',
        duration: input.options.duration,
        quality: input.options.quality,
        aspectRatio: input.options.aspectRatio,
        requestId: job.id,
        signal: controller.signal,
      });
    }
    await saveResult(pool, job, route, result, keyring);
  } catch (error) {
    if (error instanceof ServiceError && error.code === 'MEDIA_LEASE_LOST')
      return true;
    try {
      if (
        !dispatched ||
        (!lookup && error instanceof GatewayError && !error.billingAmbiguous)
      )
        await zero(
          pool,
          job,
          'failed',
          error instanceof ServiceError
            ? error.code
            : 'MEDIA_SUBMISSION_REJECTED',
        );
      else
        await transaction(pool, async (db) => {
          const current = await ownLease(db, job);
          const code =
            error instanceof ServiceError && /^MEDIA_[A-Z_]+$/.test(error.code)
              ? error.code
              : 'MEDIA_PROVIDER_OUTCOME_UNKNOWN';
          const safe =
            code !== 'MEDIA_RESULT_MISMATCH' &&
            code !== 'MEDIA_INTEGRITY_FAILED' &&
            (job.modality === 'image' ||
              !!current.provider_reference_ciphertext);
          await pending(db, job, code, safe);
        });
    } catch (failure) {
      if (
        !(
          failure instanceof ServiceError && failure.code === 'MEDIA_LEASE_LOST'
        )
      )
        throw failure;
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    controller.abort();
  }
  return true;
}

/** Lease loss never transitions a dispatched job back to the paid submission queue. */
export async function recoverExpiredMediaJobs(
  pool: Pool,
  limit = 100,
): Promise<number> {
  requireCondition(
    Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
    500,
    'INVALID_WORKER_CONFIGURATION',
    'Invalid media recovery bound.',
  );
  let count = 0;
  const rows = await pool.query<{ id: string; account_id: string }>(
    `SELECT id,account_id FROM media_jobs WHERE (lease_expires_at<=now()) OR (lease_token IS NULL AND state IN ('polling','reconciliation_pending') AND next_poll_at IS NOT NULL AND (recovery_deadline<=now() OR poll_attempts>=$1)) ORDER BY created_at,id LIMIT $2`,
    [maxPolls, limit],
  );
  for (const row of rows.rows)
    await transaction(pool, async (db) => {
      await lockMediaOwner(db, row.account_id, false);
      const job = await one<MediaJobRecord>(
        db,
        `SELECT * FROM media_jobs WHERE id=$1 AND (lease_expires_at<=now() OR (lease_token IS NULL AND next_poll_at IS NOT NULL AND (recovery_deadline<=now() OR poll_attempts>=$2))) FOR UPDATE SKIP LOCKED`,
        [row.id, maxPolls],
      );
      if (!job) return;
      if (!job.dispatched_at) {
        await settleHoldInTransaction(db, {
          accountId: job.account_id,
          holdId: job.hold_id,
          actualUsd6: '0',
          providerReference: null,
        });
        await db.query(
          `UPDATE media_jobs SET state='failed',error_code='MEDIA_INTERRUPTED_BEFORE_DISPATCH',lease_token=NULL,lease_expires_at=NULL,next_poll_at=NULL,updated_at=now() WHERE id=$1`,
          [job.id],
        );
        await releaseUnusedMediaStorageInTransaction(db, {
          accountId: job.account_id,
          jobId: job.id,
        });
      } else {
        await db.query(
          `UPDATE holds SET state='reconciliation_pending',updated_at=now() WHERE id=$1 AND state IN ('held','running')`,
          [job.hold_id],
        );
        await db.query(
          `UPDATE media_jobs SET state='reconciliation_pending',error_code='MEDIA_WORKER_INTERRUPTED',lease_token=NULL,lease_expires_at=NULL,next_poll_at=CASE WHEN recovery_deadline>now() AND poll_attempts<$2 AND (modality='image' OR provider_reference_ciphertext IS NOT NULL) THEN now() ELSE NULL END,updated_at=now() WHERE id=$1`,
          [job.id, maxPolls],
        );
      }
      count++;
    });
  return count;
}
