import type { Pool, PoolClient } from 'pg';
import { one, transaction } from '../db/database.ts';
import { requireCondition } from '../core/errors.ts';
import {
  decryptText,
  encryptText,
  type DataKeyring,
} from '../core/encryption.ts';
import { uuidField } from '../core/http.ts';
import { nextCursor, readCursor } from '../core/pagination.ts';
import {
  reserveQuoteInTransaction,
  settleHoldInTransaction,
} from '../ledger/ledger.ts';
import { usd6 } from '../ledger/money.ts';
import {
  getMediaAssetForJob,
  reserveMediaStorageInTransaction,
  releaseUnusedMediaStorageInTransaction,
} from './assets.ts';
import {
  assertUsableMediaRoute,
  mediaCapability,
  mediaQuoteAmount,
  mediaRequestHash,
  parseMediaInput,
  type MediaRoute,
  type MediaRuntimeOptions,
} from './contract.ts';

export type MediaJobRecord = {
  id: string;
  account_id: string;
  project_id: string;
  route_version_id: string;
  hold_id: string;
  input_ciphertext: string;
  request_hash: string;
  modality: 'image' | 'video';
  state:
    | 'queued'
    | 'dispatching'
    | 'polling'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'reconciliation_pending';
  provider_reference_ciphertext: string | null;
  provider_reference_hash: string | null;
  result_ciphertext: string | null;
  dispatched_at: Date | null;
  cancel_requested_at: Date | null;
  next_poll_at: Date | null;
  poll_attempts: number;
  recovery_deadline: Date;
  lease_token: string | null;
  lease_expires_at: Date | null;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
};
type Billing = {
  maximum_usd6: string;
  captured_usd6: string | null;
  billing_state: string;
};
export async function lockMediaOwner(
  db: PoolClient,
  accountId: string,
  active = true,
) {
  requireCondition(
    await one(
      db,
      `SELECT id FROM accounts WHERE id=$1 AND ($2::boolean=false OR disabled_at IS NULL) FOR UPDATE`,
      [accountId, active],
    ),
    401,
    'SESSION_REQUIRED',
    'This account is unavailable.',
  );
}
async function ownedProject(
  db: PoolClient,
  accountId: string,
  projectId: string,
  active = true,
) {
  requireCondition(
    await one(
      db,
      `SELECT id FROM projects WHERE id=$1 AND account_id=$2 AND ($3::boolean=false OR archived_at IS NULL) FOR SHARE`,
      [projectId, accountId, active],
    ),
    404,
    'PROJECT_NOT_FOUND',
    'This project is unavailable.',
  );
}
function requireMedia(options: MediaRuntimeOptions) {
  const capability = mediaCapability(options.env, options.storageReady);
  requireCondition(
    capability.configured,
    503,
    capability.reason,
    'Media generation requires configured inference and durable asset storage.',
  );
}
export async function mediaView(
  db: PoolClient,
  job: MediaJobRecord,
  keyring: DataKeyring,
) {
  const billing = await one<Billing>(
    db,
    'SELECT maximum_usd6::text,captured_usd6::text,state AS billing_state FROM holds WHERE id=$1 AND account_id=$2',
    [job.hold_id, job.account_id],
  );
  requireCondition(
    billing,
    503,
    'MEDIA_INTEGRITY_FAILED',
    'This media record is unavailable.',
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
    503,
    'MEDIA_INTEGRITY_FAILED',
    'This media record is unavailable.',
  );
  const asset = await getMediaAssetForJob(db, job.account_id, job.id);
  const route = await one<{ model_id: string }>(
    db,
    'SELECT model_id FROM route_versions WHERE id=$1',
    [job.route_version_id],
  );
  requireCondition(
    route,
    503,
    'MEDIA_INTEGRITY_FAILED',
    'This media record is unavailable.',
  );
  const ingest = await one<{ state: string; error_code: string | null }>(
    db,
    'SELECT state,error_code FROM media_ingests WHERE job_id=$1',
    [job.id],
  );
  return {
    id: job.id,
    projectId: job.project_id,
    routeVersionId: job.route_version_id,
    modelId: route.model_id,
    modality: job.modality,
    input,
    state: job.state,
    cancelRequested: job.cancel_requested_at !== null,
    errorCode: job.error_code,
    mediaAssetState:
      asset?.state === 'ready'
        ? 'stored'
        : asset?.state === 'deleted'
          ? 'deleted'
          : asset?.state === 'released' && job.result_ciphertext
            ? 'unavailable'
            : job.result_ciphertext
              ? 'pending_storage'
              : 'none',
    processingState: ingest?.state ?? null,
    processingErrorCode: ingest?.error_code ?? null,
    deliveryReady: asset?.state === 'ready',
    asset:
      asset?.state === 'ready'
        ? {
            id: asset.id,
            contentType: asset.contentType,
            byteLength: asset.byteLength,
          }
        : null,
    billing: {
      maximumUsd6: billing.maximum_usd6,
      actualUsd6: billing.captured_usd6,
      state: billing.billing_state,
    },
    createdAt: job.created_at.toISOString(),
    updatedAt: job.updated_at.toISOString(),
    canRecover:
      job.state === 'reconciliation_pending' &&
      job.recovery_deadline.getTime() > Date.now() &&
      job.poll_attempts < 2000 &&
      (job.modality === 'image' || !!job.provider_reference_ciphertext),
  };
}
export async function getOwnedMedia(
  pool: Pool,
  accountId: string,
  id: string,
  keyring: DataKeyring,
) {
  id = uuidField(id).toLowerCase();
  return transaction(pool, async (db) => {
    await lockMediaOwner(db, accountId);
    const job = await one<MediaJobRecord>(
      db,
      'SELECT * FROM media_jobs WHERE id=$1 AND account_id=$2',
      [id, accountId],
    );
    requireCondition(
      job,
      404,
      'MEDIA_NOT_FOUND',
      'This media job is unavailable.',
    );
    return mediaView(db, job, keyring);
  });
}
export async function listOwnedMedia(
  pool: Pool,
  accountId: string,
  projectId: string,
  cursor: string | null,
  keyring: DataKeyring,
) {
  projectId = uuidField(projectId).toLowerCase();
  const scope = `${accountId}:media:${projectId}`,
    after = readCursor(cursor, scope);
  return transaction(pool, async (db) => {
    await lockMediaOwner(db, accountId);
    await ownedProject(db, accountId, projectId, false);
    const result = await db.query<MediaJobRecord & { cursorTime: string }>(
      `SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime" FROM media_jobs WHERE account_id=$1 AND project_id=$2 AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT 21`,
      [accountId, projectId, after?.time ?? null, after?.id ?? null],
    );
    const jobs = [];
    for (const job of result.rows.slice(0, 20))
      jobs.push(await mediaView(db, job, keyring));
    return { jobs, nextCursor: nextCursor(result.rows, 20, scope) };
  });
}
export async function listMediaRoutes(pool: Pool, accountId: string) {
  return transaction(pool, async (db) => {
    await lockMediaOwner(db, accountId);
    const rows = await db.query<MediaRoute>(
      `SELECT * FROM (SELECT DISTINCT ON(route_id) * FROM route_versions WHERE modality IN ('image','video') ORDER BY route_id,version DESC) latest WHERE enabled AND expires_at>now() ORDER BY route_id LIMIT 256`,
    );
    const routes = [];
    for (const route of rows.rows) {
      try {
        assertUsableMediaRoute(route);
      } catch {
        continue;
      }
      routes.push({
        versionId: route.id,
        routeId: route.route_id,
        version: route.version,
        modelId: route.model_id,
        family: route.family,
        modality: route.modality,
        expiresAt: route.expires_at.toISOString(),
        privacy: {
          level: 'unverified',
          provider: 'gateway',
          plaintextVisibility: 'gateway_and_upstream',
          retentionDisclosure: route.card.retentionDisclosure,
        },
        pricing: route.pricing,
      });
    }
    return { routes };
  });
}
export async function createMediaQuote(
  pool: Pool,
  accountId: string,
  projectId: string,
  routeVersionId: string,
  raw: unknown,
  keyring: DataKeyring,
  options: MediaRuntimeOptions = {},
) {
  requireMedia(options);
  const input = parseMediaInput(raw);
  projectId = uuidField(projectId).toLowerCase();
  routeVersionId = uuidField(routeVersionId).toLowerCase();
  const id = crypto.randomUUID(),
    requestHash = await mediaRequestHash(projectId, routeVersionId, input);
  const ciphertext = await encryptText(
    JSON.stringify(input),
    `${accountId}:media-quote:${id}`,
    keyring,
  );
  return transaction(pool, async (db) => {
    await lockMediaOwner(db, accountId);
    await ownedProject(db, accountId, projectId);
    const route = await one<MediaRoute>(
      db,
      'SELECT * FROM route_versions WHERE id=$1 FOR SHARE',
      [routeVersionId],
    );
    assertUsableMediaRoute(route);
    const price = mediaQuoteAmount(route, input);
    const expiresAt = new Date(
      Math.min(Date.now() + 120000, route.expires_at.getTime()),
    );
    await db.query(
      `INSERT INTO quotes(id,account_id,project_id,route_version_id,request_hash,max_usd6,max_output_tokens,expires_at) VALUES($1,$2,$3,$4,$5,$6,1,$7)`,
      [
        id,
        accountId,
        projectId,
        routeVersionId,
        requestHash,
        price.maximumUsd6,
        expiresAt,
      ],
    );
    await db.query(
      'INSERT INTO media_quote_inputs(quote_id,input_ciphertext) VALUES($1,$2)',
      [id, ciphertext],
    );
    return {
      id,
      projectId,
      routeVersionId,
      modelId: route.model_id,
      input,
      maximumUsd6: price.maximumUsd6,
      providerMaximumUsd6: price.providerUsd6,
      expiresAt: expiresAt.toISOString(),
      privacy: {
        level: 'unverified',
        provider: 'gateway',
        plaintextVisibility: 'gateway_and_upstream',
        retentionDisclosure: route.card.retentionDisclosure,
      },
      mediaAssetState: 'pending_storage',
      deliveryReady: false,
    };
  });
}
export async function createMediaJob(
  pool: Pool,
  accountId: string,
  quoteId: string,
  idempotencyKey: string,
  approvedMaximumUsd6: string,
  keyring: DataKeyring,
  options: MediaRuntimeOptions = {},
) {
  quoteId = uuidField(quoteId).toLowerCase();
  const approved = usd6(approvedMaximumUsd6).toString();
  requireCondition(
    /^[a-zA-Z0-9_-]{16,128}$/.test(idempotencyKey),
    400,
    'INVALID_IDEMPOTENCY_KEY',
    'Use a random request key.',
  );
  return transaction(pool, async (db) => {
    await lockMediaOwner(db, accountId);
    const previous = await one<
      MediaJobRecord & { quote_id: string; maximum_usd6: string }
    >(
      db,
      `SELECT m.*,h.quote_id,h.maximum_usd6::text FROM media_jobs m JOIN holds h ON h.id=m.hold_id WHERE h.account_id=$1 AND h.idempotency_key=$2`,
      [accountId, idempotencyKey],
    );
    if (previous) {
      requireCondition(
        previous.quote_id === quoteId && previous.maximum_usd6 === approved,
        409,
        'IDEMPOTENCY_CONFLICT',
        'This request key has different accepted terms.',
      );
      return { job: await mediaView(db, previous, keyring), replayed: true };
    }
    requireMedia(options);
    const quote = await one<{
      project_id: string;
      route_version_id: string;
      input_ciphertext: string;
      request_hash: string;
      max_usd6: string;
    }>(
      db,
      `SELECT q.*,m.input_ciphertext,q.max_usd6::text FROM quotes q JOIN media_quote_inputs m ON m.quote_id=q.id WHERE q.id=$1 AND q.account_id=$2`,
      [quoteId, accountId],
    );
    requireCondition(
      quote,
      404,
      'QUOTE_NOT_FOUND',
      'This media quote is unavailable.',
    );
    requireCondition(
      quote.max_usd6 === approved,
      409,
      'MEDIA_APPROVAL_MISMATCH',
      'Approve the exact quoted maximum.',
    );
    await ownedProject(db, accountId, quote.project_id);
    const route = await one<MediaRoute>(
      db,
      'SELECT * FROM route_versions WHERE id=$1 FOR UPDATE',
      [quote.route_version_id],
    );
    assertUsableMediaRoute(route);
    const input = parseMediaInput(
      JSON.parse(
        await decryptText(
          quote.input_ciphertext,
          `${accountId}:media-quote:${quoteId}`,
          keyring,
        ),
      ),
    );
    requireCondition(
      (await mediaRequestHash(
        quote.project_id,
        quote.route_version_id,
        input,
      )) === quote.request_hash &&
        mediaQuoteAmount(route, input).maximumUsd6 === approved,
      409,
      'MEDIA_INTEGRITY_FAILED',
      'The quote no longer matches its reviewed request.',
    );
    const open = await one<{ count: string }>(
      db,
      `SELECT count(*)::text FROM media_jobs WHERE account_id=$1 AND state IN ('queued','dispatching','polling','reconciliation_pending')`,
      [accountId],
    );
    requireCondition(
      Number(open?.count) < 20,
      429,
      'MEDIA_JOB_LIMIT',
      'Finish or reconcile existing media jobs before starting more.',
    );
    const id = crypto.randomUUID(),
      encrypted = await encryptText(
        JSON.stringify(input),
        `${accountId}:media-input:${id}`,
        keyring,
      );
    const reserved = await reserveQuoteInTransaction(
      db,
      { accountId, quoteId, idempotencyKey, requestHash: quote.request_hash },
      async (client, hold) => {
        await client.query(
          `INSERT INTO media_jobs(id,account_id,project_id,route_version_id,hold_id,input_ciphertext,request_hash,modality) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            accountId,
            quote.project_id,
            quote.route_version_id,
            hold.id,
            encrypted,
            quote.request_hash,
            input.options.kind,
          ],
        );
        await reserveMediaStorageInTransaction(
          client,
          { accountId, jobId: id },
          options.storagePolicy,
        );
        await client.query('INSERT INTO media_ingests(job_id) VALUES($1)', [
          id,
        ]);
      },
    );
    requireCondition(
      !reserved.replayed,
      409,
      'IDEMPOTENCY_CONFLICT',
      'This key is already used by another request.',
    );
    const job = await one<MediaJobRecord>(
      db,
      'SELECT * FROM media_jobs WHERE id=$1',
      [id],
    );
    requireCondition(
      job,
      500,
      'MEDIA_INTEGRITY_FAILED',
      'The job could not be saved.',
    );
    return { job: await mediaView(db, job, keyring), replayed: false };
  });
}
export async function cancelOwnedMedia(
  pool: Pool,
  accountId: string,
  id: string,
  keyring: DataKeyring,
) {
  id = uuidField(id).toLowerCase();
  return transaction(pool, async (db) => {
    await lockMediaOwner(db, accountId);
    const job = await one<MediaJobRecord>(
      db,
      'SELECT * FROM media_jobs WHERE id=$1 AND account_id=$2 FOR UPDATE',
      [id, accountId],
    );
    requireCondition(
      job,
      404,
      'MEDIA_NOT_FOUND',
      'This media job is unavailable.',
    );
    if (job.state === 'queued' && !job.dispatched_at) {
      await settleHoldInTransaction(db, {
        accountId,
        holdId: job.hold_id,
        actualUsd6: '0',
        providerReference: null,
      });
      await db.query(
        `UPDATE media_jobs SET state='cancelled',cancel_requested_at=COALESCE(cancel_requested_at,now()),lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1`,
        [id],
      );
      await releaseUnusedMediaStorageInTransaction(db, {
        accountId,
        jobId: id,
      });
    } else if (!['completed', 'failed', 'cancelled'].includes(job.state)) {
      await db.query(
        `UPDATE media_jobs SET cancel_requested_at=COALESCE(cancel_requested_at,now()),updated_at=now() WHERE id=$1`,
        [id],
      );
    }
    const updated = await one<MediaJobRecord>(
      db,
      'SELECT * FROM media_jobs WHERE id=$1',
      [id],
    );
    return {
      job: await mediaView(db, updated!, keyring),
      providerCancellation: false,
    };
  });
}
export async function recoverOwnedMedia(
  pool: Pool,
  accountId: string,
  id: string,
  keyring: DataKeyring,
) {
  id = uuidField(id).toLowerCase();
  return transaction(pool, async (db) => {
    await lockMediaOwner(db, accountId);
    const job = await one<MediaJobRecord>(
      db,
      'SELECT * FROM media_jobs WHERE id=$1 AND account_id=$2 FOR UPDATE',
      [id, accountId],
    );
    requireCondition(
      job,
      404,
      'MEDIA_NOT_FOUND',
      'This media job is unavailable.',
    );
    requireCondition(
      job.state === 'reconciliation_pending' &&
        job.dispatched_at &&
        job.recovery_deadline.getTime() > Date.now() &&
        job.poll_attempts < 2000 &&
        (job.modality === 'image' || !!job.provider_reference_ciphertext),
      409,
      'MEDIA_RECOVERY_UNAVAILABLE',
      'No safe automatic lookup remains for this job. Operator reconciliation is required.',
    );
    await db.query(
      'UPDATE media_jobs SET next_poll_at=COALESCE(next_poll_at,now()),updated_at=now() WHERE id=$1',
      [id],
    );
    return {
      job: await mediaView(db, job, keyring),
      scheduled: true,
      paidResubmission: false,
    };
  });
}
