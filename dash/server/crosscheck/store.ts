import type { Pool } from 'pg';
import { one, transaction, type Queryable } from '../db/database.ts';
import {
  encryptText,
  decryptText,
  type DataKeyring,
} from '../core/encryption.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';
import { digestText } from '../core/digest.ts';
import { readCursor, nextCursor } from '../core/pagination.ts';
import { scanPrompt } from '../../lib/guards/index.ts';
import {
  CROSSCHECK_LIMITS,
  createSourceSnapshot,
  prepareCrossCheck,
  validatePlan,
  buildReviewRequests,
  isCacheUsable,
  type AccessScope,
  type SourceSnapshot,
  type Reviewer,
} from './core.ts';
import {
  evaluateCrossCheck,
  type CrossCheckResult,
  type ReviewSubmission,
} from './review.ts';

export const CROSSCHECK_STORAGE_LIMITS = Object.freeze({
  sourcesPerProject: 256,
  runsPerProject: 256,
});
export const CROSSCHECK_EXECUTION = Object.freeze({
  enabled: false,
  status: 'not_connected',
  message:
    'This endpoint prepares plans only; it does not queue or bill model calls. Sources are provided text, not remotely retrieved.',
});

type RosterMember = {
  routeVersionId: string;
  modelVersion: string;
  distribution: 'proprietary' | 'open-weight';
};
type RosterRow = {
  id: string;
  label: string;
  version: number;
  reviewers: unknown;
  reviewed_at: Date;
  expires_at: Date;
  enabled: boolean;
};
type Roster = {
  id: string;
  label: string;
  version: number;
  reviewedAt: string;
  expiresAt: string;
  reviewers: Reviewer[];
};
type SourceRow = {
  id: string;
  account_id: string;
  project_id: string;
  snapshot_hash: string;
  snapshot_ciphertext: string;
  captured_at: Date;
  source_bytes: number;
};
type RunRow = {
  id: string;
  account_id: string;
  project_id: string;
  roster_id: string;
  request_hash: string;
  scope_hash: string;
  plan_ciphertext: string;
  prepared_at: Date;
  expires_at: Date;
  result_ciphertext: string | null;
  result_hash: string | null;
  finished_at: Date | null;
};
export type ReviewCallBinding = Readonly<{
  claimId: string;
  reviewerId: string;
  callId: string;
}>;

// This scope is owner-only. Chapter membership requires a new ACL revision policy.
function scope(accountId: string, projectId: string): AccessScope {
  return { accountId, scopeId: projectId, revision: 'owner-v1' };
}
function aad(accountId: string, projectId: string, kind: string, id: string) {
  return `${accountId}:${projectId}:crosscheck-${kind}:${id}`;
}
function unavailable(): never {
  throw new ServiceError(
    503,
    'CROSSCHECK_CONTENT_UNAVAILABLE',
    'This saved Cross-Check could not be verified.',
  );
}
function exactKeys(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function guardText(values: string[]) {
  for (const value of values)
    requireCondition(
      !scanPrompt(value).findings.some(
        (finding) => finding.severity === 'block',
      ),
      422,
      'SENSITIVE_CONTENT',
      'Remove or redact the detected secret before saving this request.',
    );
}
async function ownedProject(
  db: Queryable,
  accountId: string,
  projectId: string,
  exclusive = false,
) {
  const account = await one(
    db,
    'SELECT id FROM accounts WHERE id=$1 AND disabled_at IS NULL FOR SHARE',
    [accountId],
  );
  requireCondition(
    account,
    404,
    'PROJECT_NOT_FOUND',
    'This project is unavailable.',
  );
  const project = await one(
    db,
    `SELECT id FROM projects WHERE id=$1 AND account_id=$2 AND archived_at IS NULL
    ${exclusive ? 'FOR UPDATE' : 'FOR SHARE'}`,
    [projectId, accountId],
  );
  requireCondition(
    project,
    404,
    'PROJECT_NOT_FOUND',
    'This project is unavailable.',
  );
}

async function roster(
  db: Queryable,
  id: string,
  now: number,
  current = true,
): Promise<Roster> {
  const row = await one<RosterRow>(
    db,
    'SELECT * FROM crosscheck_rosters WHERE id=$1 FOR SHARE',
    [id],
  );
  requireCondition(
    row &&
      (!current ||
        (row.enabled &&
          row.reviewed_at.getTime() <= now &&
          row.expires_at.getTime() > now)),
    409,
    'CROSSCHECK_ROSTER_UNAVAILABLE',
    'A current reviewed model roster is required.',
  );
  requireCondition(
    Array.isArray(row.reviewers) &&
      row.reviewers.length >= 3 &&
      row.reviewers.length <= CROSSCHECK_LIMITS.reviewers,
    409,
    'CROSSCHECK_ROSTER_UNAVAILABLE',
    'The reviewed model roster is incomplete.',
  );
  const reviewers: Reviewer[] = [];
  for (const value of row.reviewers) {
    requireCondition(
      exactKeys(value, ['routeVersionId', 'modelVersion', 'distribution']) &&
        typeof value.routeVersionId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          value.routeVersionId,
        ) &&
        typeof value.modelVersion === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(value.modelVersion) &&
        !['latest', 'unknown', 'auto'].includes(
          value.modelVersion.toLowerCase(),
        ) &&
        (value.distribution === 'proprietary' ||
          value.distribution === 'open-weight'),
      409,
      'CROSSCHECK_ROSTER_UNAVAILABLE',
      'The reviewed model roster is incomplete.',
    );
    const member = value as RosterMember;
    const route = await one<{
      id: string;
      version: number;
      model_id: string;
      family: string;
      enabled: boolean;
      modality: string;
      expires_at: Date;
      card: Record<string, unknown>;
    }>(db, 'SELECT * FROM route_versions WHERE id=$1 FOR SHARE', [
      member.routeVersionId,
    ]);
    requireCondition(
      route &&
        route.modality === 'chat' &&
        (!current || (route.enabled && route.expires_at.getTime() > now)) &&
        route.card.reviewed === true &&
        typeof route.card.retentionDisclosure === 'string' &&
        route.card.retentionDisclosure.trim() &&
        typeof route.card.evidenceUrl === 'string' &&
        route.card.evidenceUrl.startsWith('https://') &&
        typeof route.card.evidenceDate === 'string' &&
        /^[a-z0-9][a-z0-9-]{0,63}$/.test(route.family) &&
        /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,159}$/.test(route.model_id),
      409,
      'CROSSCHECK_ROSTER_UNAVAILABLE',
      'Each reviewer needs a current reviewed text route.',
    );
    reviewers.push({
      id: route.id,
      family: route.family,
      modelId: route.model_id,
      version: `${member.modelVersion}:route-${route.version}:roster-${row.id}`,
      distribution: member.distribution,
    });
  }
  requireCondition(
    new Set(reviewers.map((reviewer) => reviewer.id)).size ===
      reviewers.length &&
      new Set(reviewers.map((reviewer) => reviewer.family)).size ===
        reviewers.length &&
      new Set(reviewers.map((reviewer) => reviewer.modelId)).size ===
        reviewers.length &&
      new Set(reviewers.map((reviewer) => reviewer.distribution)).size === 2,
    409,
    'CROSSCHECK_ROSTER_UNAVAILABLE',
    'Use distinct model families and a reviewed proprietary/open-weight mix.',
  );
  reviewers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    id: row.id,
    label: row.label,
    version: row.version,
    reviewedAt: row.reviewed_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    reviewers,
  };
}

/** Read-only configuration. Operators publish roster rows; clients cannot declare model families. */
export async function listReviewerRosters(pool: Pool, now = Date.now()) {
  return transaction(pool, async (db) => {
    const rows = await db.query<{ id: string }>(
      `SELECT id FROM crosscheck_rosters
      WHERE enabled AND reviewed_at <= $1 AND expires_at > $1 ORDER BY created_at DESC,id LIMIT 50`,
      [new Date(now)],
    );
    const available: Roster[] = [];
    for (const row of rows.rows) {
      try {
        available.push(await roster(db, row.id, now));
      } catch (error) {
        if (
          !(
            error instanceof ServiceError &&
            error.code === 'CROSSCHECK_ROSTER_UNAVAILABLE'
          )
        )
          throw error;
      }
    }
    return available;
  });
}

export async function saveProvidedSource(
  pool: Pool,
  input: {
    accountId: string;
    projectId: string;
    title: string;
    text: string;
    uri?: string | null;
  },
  keyring: DataKeyring,
  now = Date.now(),
) {
  guardText([input.title, input.text, input.uri ?? '']);
  const snapshot = await createSourceSnapshot(
    {
      id: crypto.randomUUID(),
      title: input.title,
      text: input.text,
      uri: input.uri,
      visibility: 'private',
      scope: scope(input.accountId, input.projectId),
    },
    now,
  );
  const encrypted = await encryptText(
    JSON.stringify(snapshot),
    aad(input.accountId, input.projectId, 'source', snapshot.id),
    keyring,
  );
  await transaction(pool, async (db) => {
    await ownedProject(db, input.accountId, input.projectId, true);
    const count = await one<{ count: string }>(
      db,
      'SELECT count(*) FROM crosscheck_sources WHERE account_id=$1 AND project_id=$2',
      [input.accountId, input.projectId],
    );
    requireCondition(
      Number(count?.count) < CROSSCHECK_STORAGE_LIMITS.sourcesPerProject,
      409,
      'CROSSCHECK_STORAGE_LIMIT',
      'This project has reached its source snapshot limit.',
    );
    await db.query(
      `INSERT INTO crosscheck_sources(id,account_id,project_id,snapshot_hash,snapshot_ciphertext,source_bytes,captured_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        snapshot.id,
        input.accountId,
        input.projectId,
        snapshot.snapshotHash,
        encrypted,
        new TextEncoder().encode(snapshot.text).length,
        new Date(snapshot.capturedAtMs),
      ],
    );
  });
  return snapshot;
}

async function decodeSource(
  row: SourceRow,
  keyring: DataKeyring,
): Promise<SourceSnapshot> {
  try {
    const value: SourceSnapshot = JSON.parse(
      await decryptText(
        row.snapshot_ciphertext,
        aad(row.account_id, row.project_id, 'source', row.id),
        keyring,
      ),
    );
    const source = await createSourceSnapshot(value, row.captured_at.getTime());
    if (
      source.id !== row.id ||
      source.snapshotHash !== row.snapshot_hash ||
      value.snapshotHash !== source.snapshotHash ||
      value.contentHash !== source.contentHash ||
      value.normalizedText !== source.normalizedText ||
      value.acquisition !== source.acquisition ||
      value.schema !== source.schema ||
      source.capturedAtMs !== row.captured_at.getTime() ||
      source.visibility !== 'private' ||
      JSON.stringify(source.scope) !==
        JSON.stringify(scope(row.account_id, row.project_id)) ||
      new TextEncoder().encode(source.text).length !== row.source_bytes
    )
      unavailable();
    return source;
  } catch {
    return unavailable();
  }
}

export async function getProvidedSource(
  pool: Pool,
  accountId: string,
  id: string,
  keyring: DataKeyring,
) {
  return transaction(pool, async (db) => {
    const row = await one<SourceRow>(
      db,
      'SELECT * FROM crosscheck_sources WHERE id=$1 AND account_id=$2',
      [id, accountId],
    );
    requireCondition(
      row,
      404,
      'CROSSCHECK_SOURCE_NOT_FOUND',
      'This source snapshot is unavailable.',
    );
    await ownedProject(db, accountId, row.project_id);
    return decodeSource(row, keyring);
  });
}

export async function listOwnedCrossCheckRecords(
  pool: Pool,
  input: {
    accountId: string;
    projectId: string;
    kind: 'sources' | 'runs';
    cursor: string | null;
  },
  keyring: DataKeyring,
) {
  const cursorScope = `crosscheck:${input.kind}:${input.accountId}:${input.projectId}`;
  const cursor = readCursor(input.cursor, cursorScope);
  return transaction(pool, async (db) => {
    await ownedProject(db, input.accountId, input.projectId);
    const params = [
      input.accountId,
      input.projectId,
      cursor?.time ?? null,
      cursor?.id ?? null,
    ];
    if (input.kind === 'sources') {
      const rows = await db.query<SourceRow & { cursorTime: string }>(
        `SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime"
        FROM crosscheck_sources WHERE account_id=$1 AND project_id=$2 AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid))
        ORDER BY created_at DESC,id DESC LIMIT 21`,
        params,
      );
      const sources = [];
      for (const row of rows.rows.slice(0, 20)) {
        const value = await decodeSource(row, keyring);
        sources.push({
          id: value.id,
          title: value.title,
          uri: value.uri,
          acquisition: value.acquisition,
          capturedAtMs: value.capturedAtMs,
          contentHash: value.contentHash,
          snapshotHash: value.snapshotHash,
          sourceBytes: row.source_bytes,
        });
      }
      return { sources, nextCursor: nextCursor(rows.rows, 20, cursorScope) };
    }
    const rows = await db.query<{
      id: string;
      rosterId: string;
      preparedAt: Date;
      expiresAt: Date;
      status: string;
      cursorTime: string;
    }>(
      `SELECT r.id,r.roster_id AS "rosterId",r.prepared_at AS "preparedAt",r.expires_at AS "expiresAt",
      CASE WHEN v.run_id IS NULL THEN 'prepared' ELSE 'reviewed' END AS status,
      to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime"
      FROM crosscheck_runs r LEFT JOIN crosscheck_results v ON v.run_id=r.id
      WHERE r.account_id=$1 AND r.project_id=$2 AND ($3::timestamptz IS NULL OR (r.created_at,r.id)<($3::timestamptz,$4::uuid))
      ORDER BY r.created_at DESC,r.id DESC LIMIT 21`,
      params,
    );
    return {
      crosschecks: rows.rows
        .slice(0, 20)
        .map(({ cursorTime: _cursorTime, ...value }) => value),
      nextCursor: nextCursor(rows.rows, 20, cursorScope),
    };
  });
}

async function readRun(
  db: Queryable,
  accountId: string,
  id: string,
  exclusive = false,
): Promise<RunRow> {
  const reference = await one<{ project_id: string }>(
    db,
    'SELECT project_id FROM crosscheck_runs WHERE id=$1 AND account_id=$2',
    [id, accountId],
  );
  requireCondition(
    reference,
    404,
    'CROSSCHECK_NOT_FOUND',
    'This Cross-Check is unavailable.',
  );
  await ownedProject(db, accountId, reference.project_id);
  const row = await one<RunRow>(
    db,
    `SELECT r.*,v.result_ciphertext,v.result_hash,v.finished_at FROM crosscheck_runs r
    LEFT JOIN crosscheck_results v ON v.run_id=r.id WHERE r.id=$1 AND r.account_id=$2
    ${exclusive ? 'FOR UPDATE OF r' : 'FOR SHARE OF r'}`,
    [id, accountId],
  );
  requireCondition(
    row,
    404,
    'CROSSCHECK_NOT_FOUND',
    'This Cross-Check is unavailable.',
  );
  return row;
}

async function decodeRun(row: RunRow, keyring: DataKeyring) {
  try {
    const plan = await validatePlan(
      JSON.parse(
        await decryptText(
          row.plan_ciphertext,
          aad(row.account_id, row.project_id, 'plan', row.id),
          keyring,
        ),
      ),
    );
    if (
      plan.requestHash !== row.request_hash ||
      plan.scopeHash !== row.scope_hash ||
      plan.createdAtMs !== row.prepared_at.getTime() ||
      plan.cache.expiresAtMs !== row.expires_at.getTime() ||
      JSON.stringify(plan.scope) !==
        JSON.stringify(scope(row.account_id, row.project_id))
    )
      unavailable();
    let result: CrossCheckResult | null = null;
    if (row.result_ciphertext) {
      const stored: {
        submissions: ReviewSubmission[];
        result: Pick<
          CrossCheckResult,
          'schema' | 'resultHash' | 'requestHash' | 'verdict' | 'finishedAtMs'
        >;
      } = JSON.parse(
        await decryptText(
          row.result_ciphertext,
          aad(row.account_id, row.project_id, 'result', row.id),
          keyring,
        ),
      );
      // Recompute every verdict/quote and the result hash when reading the cache.
      result = await evaluateCrossCheck(
        plan,
        stored.submissions,
        row.finished_at!.getTime(),
      );
      if (
        result.resultHash !== row.result_hash ||
        result.resultHash !== stored.result.resultHash ||
        result.schema !== stored.result.schema ||
        result.requestHash !== stored.result.requestHash ||
        result.verdict !== stored.result.verdict ||
        result.finishedAtMs !== stored.result.finishedAtMs
      )
        unavailable();
    } else if (row.result_hash || row.finished_at) unavailable();
    return { plan, result };
  } catch {
    return unavailable();
  }
}

async function viewRun(row: RunRow, keyring: DataKeyring, now: number) {
  const { plan, result } = await decodeRun(row, keyring);
  return {
    id: row.id,
    projectId: row.project_id,
    rosterId: row.roster_id,
    status: result ? ('reviewed' as const) : ('prepared' as const),
    label: result
      ? 'Reviewed against provided source snapshots'
      : 'Prepared — not reviewed',
    plan,
    result,
    cacheUsable: Boolean(
      result &&
      (await isCacheUsable(
        result.cache,
        plan,
        scope(row.account_id, row.project_id),
        now,
      )),
    ),
    execution: CROSSCHECK_EXECUTION,
  };
}

export async function getOwnedCrossCheck(
  pool: Pool,
  accountId: string,
  id: string,
  keyring: DataKeyring,
  now = Date.now(),
) {
  return transaction(pool, async (db) =>
    viewRun(await readRun(db, accountId, id), keyring, now),
  );
}

export async function prepareOwnedCrossCheck(
  pool: Pool,
  input: {
    accountId: string;
    projectId: string;
    rosterId: string;
    sourceIds: string[];
    claims: { id: string; text: string }[];
  },
  keyring: DataKeyring,
  now = Date.now(),
) {
  requireCondition(
    Array.isArray(input.sourceIds) &&
      input.sourceIds.length >= 1 &&
      input.sourceIds.length <= CROSSCHECK_LIMITS.sources &&
      new Set(input.sourceIds).size === input.sourceIds.length,
    400,
    'INVALID_SOURCES',
    'Choose between one and eight distinct source snapshots.',
  );
  requireCondition(
    Array.isArray(input.claims) &&
      input.claims.length >= 1 &&
      input.claims.length <= CROSSCHECK_LIMITS.claims &&
      input.claims.every((claim) => typeof claim?.text === 'string'),
    400,
    'INVALID_CLAIMS',
    'Supply between one and twenty-four explicit claims.',
  );
  guardText(input.claims.map((claim) => claim.text));
  return transaction(pool, async (db) => {
    await ownedProject(db, input.accountId, input.projectId, true);
    const reviewed = await roster(db, input.rosterId, now);
    const sources: SourceSnapshot[] = [];
    for (const id of input.sourceIds) {
      const source = await one<SourceRow>(
        db,
        'SELECT * FROM crosscheck_sources WHERE id=$1 AND account_id=$2 AND project_id=$3',
        [id, input.accountId, input.projectId],
      );
      requireCondition(
        source,
        404,
        'CROSSCHECK_SOURCE_NOT_FOUND',
        'A source snapshot is unavailable in this project.',
      );
      sources.push(await decodeSource(source, keyring));
    }
    const plan = await prepareCrossCheck({
      scope: scope(input.accountId, input.projectId),
      claims: input.claims,
      sources,
      reviewers: reviewed.reviewers,
      now,
    });
    const cached = await one<{ id: string }>(
      db,
      `SELECT r.id FROM crosscheck_runs r
      WHERE r.account_id=$1 AND r.project_id=$2 AND r.roster_id=$3 AND r.request_hash=$4 AND r.prepared_at <= $5 AND r.expires_at > $5
      ORDER BY EXISTS(SELECT 1 FROM crosscheck_results v WHERE v.run_id=r.id) DESC,r.prepared_at DESC LIMIT 1`,
      [
        input.accountId,
        input.projectId,
        input.rosterId,
        plan.requestHash,
        new Date(now),
      ],
    );
    if (cached) {
      const saved = await viewRun(
        await readRun(db, input.accountId, cached.id),
        keyring,
        now,
      );
      requireCondition(
        saved.plan.requestHash === plan.requestHash &&
          saved.plan.scopeHash === plan.scopeHash &&
          (await isCacheUsable(
            saved.plan.cache,
            plan,
            scope(input.accountId, input.projectId),
            now,
          )),
        503,
        'CROSSCHECK_CONTENT_UNAVAILABLE',
        'This saved Cross-Check could not be verified.',
      );
      return {
        crosscheck: saved,
        reused: true,
        cacheHit: saved.result !== null,
      };
    }
    const count = await one<{ count: string }>(
      db,
      'SELECT count(*) FROM crosscheck_runs WHERE account_id=$1 AND project_id=$2',
      [input.accountId, input.projectId],
    );
    requireCondition(
      Number(count?.count) < CROSSCHECK_STORAGE_LIMITS.runsPerProject,
      409,
      'CROSSCHECK_STORAGE_LIMIT',
      'This project has reached its Cross-Check plan limit.',
    );
    const id = crypto.randomUUID();
    const encrypted = await encryptText(
      JSON.stringify(plan),
      aad(input.accountId, input.projectId, 'plan', id),
      keyring,
    );
    await db.query(
      `INSERT INTO crosscheck_runs(id,account_id,project_id,roster_id,request_hash,scope_hash,plan_ciphertext,prepared_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        input.accountId,
        input.projectId,
        input.rosterId,
        plan.requestHash,
        plan.scopeHash,
        encrypted,
        new Date(plan.createdAtMs),
        new Date(plan.cache.expiresAtMs),
      ],
    );
    return {
      crosscheck: await viewRun(
        await readRun(db, input.accountId, id),
        keyring,
        now,
      ),
      reused: false,
      cacheHit: false,
    };
  });
}

/** Server-only transaction seam shared by quoting, atomic reservation and worker verification. */
export async function readCrossCheckExecutionPlan(
  db: Queryable,
  accountId: string,
  runId: string,
  keyring: DataKeyring,
  now = Date.now(),
  exclusive = false,
) {
  const row = await readRun(db, accountId, runId, exclusive);
  const { plan, result } = await decodeRun(row, keyring);
  requireCondition(
    !result && now < plan.cache.expiresAtMs,
    409,
    'CROSSCHECK_NOT_DISPATCHABLE',
    'This plan is complete or expired.',
  );
  const reviewed = await roster(db, row.roster_id, now);
  requireCondition(
    JSON.stringify(reviewed.reviewers) === JSON.stringify(plan.reviewers),
    409,
    'CROSSCHECK_ROSTER_UNAVAILABLE',
    'This plan no longer matches its reviewed roster.',
  );
  const requests = (await buildReviewRequests(plan)).map((entry) => ({
    claimId: entry.claimId,
    reviewerId: entry.reviewer.id,
    routeVersionId: entry.reviewer.id,
    messages: entry.messages,
  }));
  return { row, plan, roster: reviewed, requests };
}

export async function plannedReviewCalls(
  pool: Pool,
  accountId: string,
  runId: string,
  keyring: DataKeyring,
  now = Date.now(),
) {
  return transaction(
    pool,
    async (db) =>
      (await readCrossCheckExecutionPlan(db, accountId, runId, keyring, now))
        .requests,
  );
}

/** No HTTP caller supplies review text. Only persisted call outputs can become evidence. */
export async function completeCrossCheckFromCalls(
  pool: Pool,
  input: {
    accountId: string;
    runId: string;
    calls: readonly ReviewCallBinding[];
  },
  keyring: DataKeyring,
  now = Date.now(),
) {
  return transaction(pool, async (db) => {
    const row = await readRun(db, input.accountId, input.runId, true);
    if (row.result_ciphertext) return viewRun(row, keyring, now);
    const { plan } = await decodeRun(row, keyring);
    const reviewed = await roster(db, row.roster_id, now, false);
    requireCondition(
      JSON.stringify(reviewed.reviewers) === JSON.stringify(plan.reviewers),
      409,
      'CROSSCHECK_ROSTER_UNAVAILABLE',
      'This plan does not match its reviewed roster.',
    );
    const requests = await buildReviewRequests(plan);
    requireCondition(
      Array.isArray(input.calls) &&
        input.calls.length === requests.length &&
        new Set(input.calls.map((binding) => binding.callId)).size ===
          requests.length &&
        new Set(
          input.calls.map((binding) =>
            JSON.stringify([binding.claimId, binding.reviewerId]),
          ),
        ).size === requests.length,
      409,
      'CROSSCHECK_CALL_MISMATCH',
      'Each planned review needs one distinct persisted call.',
    );
    const submissions: ReviewSubmission[] = [];
    for (const request of requests) {
      const binding = input.calls.find(
        (call) =>
          call.claimId === request.claimId &&
          call.reviewerId === request.reviewer.id,
      );
      requireCondition(
        binding,
        409,
        'CROSSCHECK_CALL_MISMATCH',
        'A planned review call is missing.',
      );
      const call = await one<{
        id: string;
        route_version_id: string;
        input_ciphertext: string;
        output_ciphertext: string | null;
        state: string;
        request_hash: string;
        billing_state: string;
      }>(
        db,
        `SELECT c.*,h.request_hash,h.state AS billing_state FROM calls c JOIN holds h ON h.id=c.hold_id
         WHERE c.id=$1 AND c.account_id=$2 AND c.project_id=$3 AND h.account_id=$2 FOR SHARE OF c,h`,
        [binding.callId, input.accountId, row.project_id],
      );
      requireCondition(
        call && call.route_version_id === request.reviewer.id,
        409,
        'CROSSCHECK_CALL_MISMATCH',
        'A review call does not match its planned route or owner.',
      );
      requireCondition(
        ['succeeded', 'failed', 'cancelled'].includes(call.state) &&
          ['captured', 'released'].includes(call.billing_state),
        409,
        'CROSSCHECK_CALL_PENDING',
        'All review calls must finish and settle before evaluation.',
      );
      let stored: unknown;
      try {
        stored = JSON.parse(
          await decryptText(
            call.input_ciphertext,
            `${input.accountId}:call-input:${call.id}`,
            keyring,
          ),
        );
      } catch {
        throw new ServiceError(
          409,
          'CROSSCHECK_CALL_MISMATCH',
          'A review request could not be verified.',
        );
      }
      requireCondition(
        exactKeys(stored, ['messages', 'maxOutputTokens', 'privacy']) &&
          Array.isArray(stored.messages) &&
          stored.messages.length === request.messages.length &&
          stored.privacy === 'standard' &&
          Number.isSafeInteger(stored.maxOutputTokens) &&
          Number(stored.maxOutputTokens) >= 1 &&
          Number(stored.maxOutputTokens) <= 8192 &&
          stored.messages.every(
            (message, index) =>
              exactKeys(message, ['role', 'content']) &&
              message.role === request.messages[index].role &&
              message.content === request.messages[index].content,
          ),
        409,
        'CROSSCHECK_CALL_MISMATCH',
        'A review request is not the independent request prepared for this claim.',
      );
      const canonicalInput = {
        messages: request.messages,
        maxOutputTokens: stored.maxOutputTokens,
        privacy: 'standard',
      };
      requireCondition(
        (await digestText(
          'call',
          JSON.stringify({
            projectId: row.project_id,
            routeVersionId: call.route_version_id,
            ...canonicalInput,
          }),
        )) === call.request_hash,
        409,
        'CROSSCHECK_CALL_MISMATCH',
        'A review request does not match its reservation.',
      );
      if (call.state === 'succeeded') {
        requireCondition(
          call.output_ciphertext,
          409,
          'CROSSCHECK_CALL_MISMATCH',
          'A completed review has no persisted output.',
        );
        const content = await decryptText(
          call.output_ciphertext,
          `${input.accountId}:call-output:${call.id}`,
          keyring,
        );
        // Oversized output remains an invalid review without retaining megabytes of provider text.
        submissions.push({
          claimId: request.claimId,
          reviewerId: request.reviewer.id,
          content:
            new TextEncoder().encode(content).length <=
              CROSSCHECK_LIMITS.reviewBytes &&
            new TextEncoder().encode(JSON.stringify(content)).length <=
              CROSSCHECK_LIMITS.reviewBytes * 2 + 2
              ? content
              : '',
        });
      }
      await db.query(
        'INSERT INTO crosscheck_review_calls(run_id,claim_id,reviewer_id,call_id) VALUES($1,$2,$3,$4) ON CONFLICT(run_id,claim_id,reviewer_id) DO NOTHING',
        [row.id, request.claimId, request.reviewer.id, call.id],
      );
      const bound = await one<{ call_id: string }>(
        db,
        'SELECT call_id FROM crosscheck_review_calls WHERE run_id=$1 AND claim_id=$2 AND reviewer_id=$3',
        [row.id, request.claimId, request.reviewer.id],
      );
      requireCondition(
        bound?.call_id === call.id,
        409,
        'CROSSCHECK_CALL_MISMATCH',
        'A review already belongs to another persisted call.',
      );
    }
    const result = await evaluateCrossCheck(plan, submissions, now);
    const encrypted = await encryptText(
      // Raw outputs plus a compact deterministic commitment retain all evidence
      // without storing every quote twice. Reads reconstruct and verify the full result.
      JSON.stringify({
        submissions,
        result: {
          schema: result.schema,
          resultHash: result.resultHash,
          requestHash: result.requestHash,
          verdict: result.verdict,
          finishedAtMs: result.finishedAtMs,
        },
      }),
      aad(input.accountId, row.project_id, 'result', row.id),
      keyring,
    );
    await db.query(
      'INSERT INTO crosscheck_results(run_id,result_hash,result_ciphertext,finished_at) VALUES($1,$2,$3,$4)',
      [row.id, result.resultHash, encrypted, new Date(result.finishedAtMs)],
    );
    return viewRun(await readRun(db, input.accountId, row.id), keyring, now);
  });
}
