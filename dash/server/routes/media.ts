import type { Pool } from 'pg';
import {
  jsonResponse,
  readJson,
  stringField,
  uuidField,
} from '../core/http.ts';
import type { DataKeyring } from '../core/encryption.ts';
import { requireCondition } from '../core/errors.ts';
import { rateLimit } from '../core/rate-limit.ts';
import { deleteOwnedMediaAsset } from '../media/assets.ts';
import {
  exactMediaObject,
  mediaCapability,
  type MediaRuntimeOptions,
} from '../media/contract.ts';
import {
  cancelOwnedMedia,
  createMediaJob,
  createMediaQuote,
  getOwnedMedia,
  listMediaRoutes,
  listOwnedMedia,
  recoverOwnedMedia,
} from '../media/store.ts';

export async function mediaRoutes(
  pool: Pool,
  request: Request,
  path: string,
  accountId: string,
  keyring: DataKeyring,
  options: MediaRuntimeOptions = {},
): Promise<Response | null> {
  if (!path.startsWith('media/')) return null;
  const asset = /^media\/assets\/([^/]+)$/.exec(path);
  if (asset && request.method === 'DELETE') {
    await rateLimit(pool, `media-action:${accountId}`, 10);
    const removed = await deleteOwnedMediaAsset(
      pool,
      accountId,
      uuidField(asset[1]).toLowerCase(),
    );
    return jsonResponse({ asset: { id: removed.id, state: removed.state } });
  }
  if (path === 'media/capabilities' && request.method === 'GET')
    return jsonResponse(mediaCapability(options.env, options.storageReady));
  if (path === 'media/routes' && request.method === 'GET') {
    await rateLimit(pool, `media-read:${accountId}`, 60);
    return jsonResponse(await listMediaRoutes(pool, accountId));
  }
  if (path === 'media/quotes' && request.method === 'POST') {
    await rateLimit(pool, `media-quote:${accountId}`, 10);
    const body = exactMediaObject(await readJson(request, 100000), [
      'projectId',
      'routeVersionId',
      'input',
    ]);
    return jsonResponse(
      {
        quote: await createMediaQuote(
          pool,
          accountId,
          uuidField(body.projectId).toLowerCase(),
          uuidField(body.routeVersionId).toLowerCase(),
          body.input,
          keyring,
          options,
        ),
      },
      201,
    );
  }
  if (path === 'media/jobs' && request.method === 'POST') {
    await rateLimit(pool, `media-create:${accountId}`, 10);
    const body = exactMediaObject(await readJson(request, 2048), [
      'quoteId',
      'idempotencyKey',
      'approvedMaximumUsd6',
    ]);
    const result = await createMediaJob(
      pool,
      accountId,
      uuidField(body.quoteId).toLowerCase(),
      stringField(body, 'idempotencyKey', 128),
      stringField(body, 'approvedMaximumUsd6', 16),
      keyring,
      options,
    );
    return jsonResponse(result, result.replayed ? 200 : 201);
  }
  if (path === 'media/jobs' && request.method === 'GET') {
    await rateLimit(pool, `media-read:${accountId}`, 60);
    const query = new URL(request.url).searchParams;
    requireCondition(
      [...query.keys()].every((key) => ['projectId', 'cursor'].includes(key)) &&
        query.getAll('projectId').length === 1 &&
        query.getAll('cursor').length <= 1,
      400,
      'INVALID_MEDIA_REQUEST',
      'Only one project and optional cursor are accepted.',
    );
    return jsonResponse(
      await listOwnedMedia(
        pool,
        accountId,
        uuidField(query.get('projectId')).toLowerCase(),
        query.get('cursor'),
        keyring,
      ),
    );
  }
  const match = /^media\/jobs\/([^/]+)(?:\/(cancel|recover))?$/.exec(path);
  if (match && request.method === 'GET' && !match[2]) {
    await rateLimit(pool, `media-read:${accountId}`, 60);
    return jsonResponse({
      job: await getOwnedMedia(
        pool,
        accountId,
        uuidField(match[1]).toLowerCase(),
        keyring,
      ),
    });
  }
  if (match && request.method === 'POST' && match[2]) {
    await rateLimit(pool, `media-action:${accountId}`, 10);
    exactMediaObject(await readJson(request, 1024), []);
    const id = uuidField(match[1]).toLowerCase();
    return jsonResponse(
      match[2] === 'cancel'
        ? await cancelOwnedMedia(pool, accountId, id, keyring)
        : await recoverOwnedMedia(pool, accountId, id, keyring),
    );
  }
  return null;
}
