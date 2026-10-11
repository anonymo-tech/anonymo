import type { Pool } from 'pg';
import { configuredKeyring } from '../core/encryption.ts';
import {
  jsonResponse,
  readJson,
  stringField,
  uuidField,
} from '../core/http.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';
import { rateLimit } from '../core/rate-limit.ts';
import { CROSSCHECK_LIMITS, CrossCheckError } from '../crosscheck/index.ts';
import { crosscheckExecutionRoutes } from './crosscheck-execution.ts';
import { crossCheckExecutionStatus } from '../crosscheck/execution.ts';
import {
  CROSSCHECK_EXECUTION,
  saveProvidedSource,
  getProvidedSource,
  prepareOwnedCrossCheck,
  getOwnedCrossCheck,
  listReviewerRosters,
  listOwnedCrossCheckRecords,
} from '../crosscheck/store.ts';

function keys(
  body: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) {
  requireCondition(
    required.every((key) => Object.hasOwn(body, key)) &&
      Object.keys(body).every(
        (key) => required.includes(key) || optional.includes(key),
      ),
    400,
    'INVALID_REQUEST',
    'This request contains missing or unsupported fields.',
  );
}
function id(value: unknown) {
  return uuidField(value).toLowerCase();
}

/** Called only after dispatch authenticates the session and checks mutation origins. */
export async function crosscheckRoutes(
  pool: Pool,
  request: Request,
  path: string,
  accountId: string,
): Promise<Response | null> {
  if (path !== 'crosscheck' && !path.startsWith('crosscheck/')) return null;
  try {
    const execution = await crosscheckExecutionRoutes(
      pool,
      request,
      path,
      accountId,
    );
    if (execution) return execution;
    if (path === 'crosscheck/rosters' && request.method === 'GET') {
      await rateLimit(pool, `crosscheck:read:${accountId}`, 60);
      return jsonResponse({
        rosters: await listReviewerRosters(pool),
        execution: CROSSCHECK_EXECUTION,
      });
    }
    if (
      (path === 'crosscheck/sources' || path === 'crosscheck') &&
      request.method === 'GET'
    ) {
      await rateLimit(pool, `crosscheck:read:${accountId}`, 60);
      const params = new URL(request.url).searchParams;
      const projectId = id(params.get('projectId'));
      return jsonResponse({
        ...(await listOwnedCrossCheckRecords(
          pool,
          {
            accountId,
            projectId,
            kind: path === 'crosscheck/sources' ? 'sources' : 'runs',
            cursor: params.get('cursor'),
          },
          configuredKeyring(),
        )),
        execution: CROSSCHECK_EXECUTION,
      });
    }
    if (path === 'crosscheck/sources' && request.method === 'POST') {
      await rateLimit(pool, `crosscheck:source:${accountId}`, 10);
      // JSON escaping may expand otherwise valid 64 KiB text.
      const body = await readJson(request, 458752);
      keys(body, ['projectId', 'title', 'text'], ['uri']);
      requireCondition(
        body.uri === undefined ||
          body.uri === null ||
          typeof body.uri === 'string',
        400,
        'INVALID_REQUEST',
        'Source URI must be text.',
      );
      const source = await saveProvidedSource(
        pool,
        {
          accountId,
          projectId: id(body.projectId),
          title: stringField(body, 'title', 300),
          text: stringField(body, 'text', CROSSCHECK_LIMITS.sourceBytes),
          uri: body.uri as string | null | undefined,
        },
        configuredKeyring(),
      );
      return jsonResponse({ source, execution: CROSSCHECK_EXECUTION }, 201);
    }
    if (path === 'crosscheck' && request.method === 'POST') {
      await rateLimit(pool, `crosscheck:prepare:${accountId}`, 10);
      const body = await readJson(request, 327680);
      keys(body, ['projectId', 'rosterId', 'sourceIds', 'claims']);
      requireCondition(
        Array.isArray(body.sourceIds) &&
          body.sourceIds.length >= 1 &&
          body.sourceIds.length <= CROSSCHECK_LIMITS.sources,
        400,
        'INVALID_SOURCES',
        'Choose between one and eight source snapshots.',
      );
      requireCondition(
        Array.isArray(body.claims) &&
          body.claims.length >= 1 &&
          body.claims.length <= CROSSCHECK_LIMITS.claims,
        400,
        'INVALID_CLAIMS',
        'Supply between one and twenty-four explicit claims.',
      );
      const claims = body.claims.map((claim: unknown) => {
        requireCondition(
          claim !== null && typeof claim === 'object' && !Array.isArray(claim),
          400,
          'INVALID_CLAIMS',
          'Each claim needs an ID and text.',
        );
        const value = claim as Record<string, unknown>;
        keys(value, ['id', 'text']);
        return {
          id: stringField(value, 'id', 160),
          text: stringField(value, 'text', 2000),
        };
      });
      const result = await prepareOwnedCrossCheck(
        pool,
        {
          accountId,
          projectId: id(body.projectId),
          rosterId: id(body.rosterId),
          sourceIds: body.sourceIds.map(id),
          claims,
        },
        configuredKeyring(),
      );
      return jsonResponse(result, result.reused ? 200 : 201);
    }
    const sourceMatch = /^crosscheck\/sources\/([^/]+)$/.exec(path);
    if (sourceMatch && request.method === 'GET') {
      await rateLimit(pool, `crosscheck:read:${accountId}`, 60);
      return jsonResponse({
        source: await getProvidedSource(
          pool,
          accountId,
          id(sourceMatch[1]),
          configuredKeyring(),
        ),
      });
    }
    const runMatch = /^crosscheck\/([^/]+)$/.exec(path);
    if (runMatch && request.method === 'GET') {
      await rateLimit(pool, `crosscheck:read:${accountId}`, 60);
      const runId = id(runMatch[1]);
      const crosscheck = await getOwnedCrossCheck(
        pool,
        accountId,
        runId,
        configuredKeyring(),
      );
      return jsonResponse({
        crosscheck: {
          ...crosscheck,
          execution: await crossCheckExecutionStatus(pool, accountId, runId),
        },
      });
    }
    // There is deliberately no client endpoint for reviews, completion or roster administration.
    return null;
  } catch (error) {
    if (error instanceof CrossCheckError)
      throw new ServiceError(
        400,
        'INVALID_CROSSCHECK',
        'Check the claim text, source sizes and source reference fields.',
      );
    throw error;
  }
}
