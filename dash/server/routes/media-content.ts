import { createDatabase } from '../db/database.ts';
import { getSession } from './session.ts';
import { uuidField } from '../core/http.ts';
import { requireCondition } from '../core/errors.ts';
import { rateLimit } from '../core/rate-limit.ts';
import { configuredKeyring } from '../core/encryption.ts';
import { openOwnedMediaReader } from '../media/reader.ts';
import { mediaContentResponse } from '../media/content.ts';

/** Native media elements cannot set a custom header, so their URL carries an
 * expected account UUID, never a credential or provider URL. Cookie ownership
 * remains mandatory; a changed session cannot reinterpret an old media URL. */
export async function mediaContentRoute(
  request: Request,
  databaseUrl: string,
  assetId: string,
  origin: string,
) {
  const url = new URL(request.url),
    query = url.searchParams;
  requireCondition(
    url.origin === origin &&
      (!request.headers.has('origin') ||
        request.headers.get('origin') === origin) &&
      [null, 'same-origin', 'none'].includes(
        request.headers.get('sec-fetch-site'),
      ),
    403,
    'ORIGIN_REJECTED',
    'Cross-site media requests are not allowed.',
  );
  requireCondition(
    [...query.keys()].every((k) => ['accountId', 'download'].includes(k)) &&
      query.getAll('accountId').length === 1 &&
      query.getAll('download').length <= 1 &&
      (!query.has('download') || query.get('download') === '1'),
    400,
    'INVALID_MEDIA_REQUEST',
    'Use one account and an optional download flag.',
  );
  const expected = uuidField(query.get('accountId')).toLowerCase();
  const id = uuidField(assetId).toLowerCase();
  const pool = createDatabase(databaseUrl, 1);
  let closed: Promise<void> | undefined;
  const dispose = () => (closed ??= pool.end());
  try {
    const initial = await getSession(pool, request);
    requireCondition(
      initial.accountId === expected,
      401,
      'ACCOUNT_CHANGED',
      'The signed-in account changed.',
    );
    await rateLimit(pool, `media-playback:${expected}`, 120);
    const reader = await openOwnedMediaReader(
      pool,
      expected,
      id,
      configuredKeyring(),
    );
    return await mediaContentResponse(request, {
      reader,
      dispose,
      authorize: async () => {
        const session = await getSession(pool, request);
        requireCondition(
          session.accountId === expected &&
            session.tokenHash === initial.tokenHash,
          401,
          'ACCOUNT_CHANGED',
          'The signed-in account changed.',
        );
      },
    });
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }
}
