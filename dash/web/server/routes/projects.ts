import type { Pool, PoolClient } from 'pg';
import { one, transaction } from '../db/database.ts';
import {
  jsonResponse,
  readJson,
  stringField,
  uuidField,
} from '../core/http.ts';
import { requireCondition } from '../core/errors.ts';
import {
  configuredKeyring,
  encryptText,
  decryptText,
} from '../core/encryption.ts';
import { scanPrompt } from '../../lib/guards/index.ts';
import { nextCursor, readCursor } from '../core/pagination.ts';
import { readBriefDocument } from './brief-documents.ts';
import { assertBriefSynthesisDeletable } from '../briefs/store.ts';

function guardContent(...values: string[]) {
  for (const value of values)
    requireCondition(
      !scanPrompt(value).findings.some(
        (finding) => finding.severity === 'block',
      ),
      422,
      'SENSITIVE_CONTENT',
      'Remove or redact the detected secret before saving.',
    );
}

export async function requireProject(
  pool: Pool | PoolClient,
  accountId: string,
  projectId: string,
) {
  const project = await one(
    pool,
    'SELECT id FROM projects WHERE id=$1 AND account_id=$2 AND archived_at IS NULL',
    [projectId, accountId],
  );
  requireCondition(
    project,
    404,
    'PROJECT_NOT_FOUND',
    'This project is unavailable.',
  );
}

export async function projectRoutes(
  pool: Pool,
  request: Request,
  path: string,
  accountId: string,
): Promise<Response | null> {
  if (path === 'projects' && request.method === 'GET') {
    const scope = `${accountId}:projects`,
      cursor = readCursor(
        new URL(request.url).searchParams.get('cursor'),
        scope,
      );
    const result = await pool.query(
      `SELECT id,title,revision,created_at AS "createdAt",updated_at AS "updatedAt",
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime"
      FROM projects WHERE account_id=$1 AND archived_at IS NULL AND ($2::timestamptz IS NULL OR (updated_at,id)<($2::timestamptz,$3::uuid))
      ORDER BY updated_at DESC,id DESC LIMIT 51`,
      [accountId, cursor?.time ?? null, cursor?.id ?? null],
    );
    return jsonResponse({
      projects: result.rows
        .slice(0, 50)
        .map(({ cursorTime: _cursorTime, ...project }) => project),
      nextCursor: nextCursor(result.rows, 50, scope),
    });
  }
  if (path === 'projects' && request.method === 'POST') {
    const body = await readJson(request, 2048);
    const title = stringField(body, 'title', 80).trim();
    guardContent(title);
    const result = await one(
      pool,
      `INSERT INTO projects(id,account_id,title) VALUES($1,$2,$3)
      RETURNING id,title,revision,created_at AS "createdAt",updated_at AS "updatedAt"`,
      [crypto.randomUUID(), accountId, title],
    );
    return jsonResponse({ project: result }, 201);
  }
  const projectMatch = /^projects\/([^/]+)$/.exec(path);
  if (projectMatch && request.method === 'PATCH') {
    const id = uuidField(projectMatch[1]);
    const body = await readJson(request, 2048);
    const title = stringField(body, 'title', 80).trim();
    guardContent(title);
    requireCondition(
      Number.isSafeInteger(body.revision) && Number(body.revision) > 0,
      400,
      'REVISION_REQUIRED',
      'Send the project revision.',
    );
    await requireProject(pool, accountId, id);
    const project = await one(
      pool,
      `UPDATE projects SET title=$3,revision=revision+1,updated_at=now()
      WHERE id=$1 AND account_id=$2 AND revision=$4 AND archived_at IS NULL RETURNING id,title,revision`,
      [id, accountId, title, body.revision],
    );
    requireCondition(
      project,
      409,
      'REVISION_CONFLICT',
      'The project changed. Reload before saving.',
    );
    return jsonResponse({ project });
  }
  if (projectMatch && request.method === 'DELETE') {
    const id = uuidField(projectMatch[1]),
      body = await readJson(request, 2048);
    requireCondition(
      Number.isSafeInteger(body.revision) && Number(body.revision) > 0,
      400,
      'REVISION_REQUIRED',
      'Send the project revision.',
    );
    const project = await one<{ revision: number; archived_at: Date | null }>(
      pool,
      'SELECT revision,archived_at FROM projects WHERE id=$1 AND account_id=$2',
      [id, accountId],
    );
    requireCondition(
      project,
      404,
      'PROJECT_NOT_FOUND',
      'This project is unavailable.',
    );
    if (project.archived_at) return jsonResponse({ archived: true });
    const updated = await one(
      pool,
      `UPDATE projects SET archived_at=now(),updated_at=now(),revision=revision+1
      WHERE id=$1 AND account_id=$2 AND revision=$3 AND archived_at IS NULL RETURNING id`,
      [id, accountId, body.revision],
    );
    requireCondition(
      updated,
      409,
      'REVISION_CONFLICT',
      'The project changed. Reload before archiving.',
    );
    return jsonResponse({
      archived: true,
      message:
        'Archived projects are hidden from the project list. Existing requests and accounting records are retained.',
    });
  }
  if (path === 'briefs' && request.method === 'POST') {
    const keyring = configuredKeyring();
    const body = await readJson(request, 131072);
    const projectId = uuidField(body.projectId);
    await requireProject(pool, accountId, projectId);
    const title = stringField(body, 'title', 160);
    const content = stringField(body, 'body', 24000);
    guardContent(title, content);
    const id = crypto.randomUUID();
    const ciphertext = await encryptText(
      content,
      `${accountId}:brief:${id}`,
      keyring,
    );
    await pool.query(
      'INSERT INTO briefs(id,account_id,project_id,title,body_ciphertext) VALUES($1,$2,$3,$4,$5)',
      [id, accountId, projectId, title, ciphertext],
    );
    return jsonResponse(
      { brief: { id, projectId, title, body: content, revision: 1 } },
      201,
    );
  }
  if (path === 'briefs' && request.method === 'GET') {
    const url = new URL(request.url),
      projectId = url.searchParams.get('projectId');
    if (projectId) await requireProject(pool, accountId, uuidField(projectId));
    const scope = `${accountId}:briefs:${projectId ?? 'all'}`,
      cursor = readCursor(url.searchParams.get('cursor'), scope);
    const result = await pool.query(
      `SELECT id,project_id AS "projectId",title,revision,created_at AS "createdAt",updated_at AS "updatedAt",
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime" FROM briefs
      WHERE account_id=$1 AND ($2::uuid IS NULL OR project_id=$2) AND ($3::timestamptz IS NULL OR (updated_at,id)<($3::timestamptz,$4::uuid))
      ORDER BY updated_at DESC,id DESC LIMIT 51`,
      [accountId, projectId, cursor?.time ?? null, cursor?.id ?? null],
    );
    return jsonResponse({
      briefs: result.rows
        .slice(0, 50)
        .map(({ cursorTime: _cursorTime, ...brief }) => brief),
      nextCursor: nextCursor(result.rows, 50, scope),
    });
  }
  const briefMatch = /^briefs\/([^/]+)$/.exec(path);
  if (briefMatch && request.method === 'DELETE') {
    const id = uuidField(briefMatch[1]),
      body = await readJson(request, 2048);
    requireCondition(
      Number.isSafeInteger(body.revision) && Number(body.revision) > 0,
      400,
      'REVISION_REQUIRED',
      'Send the Brief revision.',
    );
    return transaction(pool, async (db) => {
      await db.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [
        accountId,
      ]);
      const brief = await one<{ revision: number }>(
        db,
        'SELECT revision FROM briefs WHERE id=$1 AND account_id=$2 FOR UPDATE',
        [id, accountId],
      );
      requireCondition(
        brief,
        404,
        'BRIEF_NOT_FOUND',
        'This Brief is unavailable.',
      );
      requireCondition(
        brief.revision === body.revision,
        409,
        'REVISION_CONFLICT',
        'This Brief changed. Reload before deleting.',
      );
      await assertBriefSynthesisDeletable(db, accountId, id);
      await db.query('DELETE FROM briefs WHERE id=$1 AND account_id=$2', [
        id,
        accountId,
      ]);
      return jsonResponse({ deleted: true });
    });
  }
  if (briefMatch && ['GET', 'PATCH'].includes(request.method)) {
    const id = uuidField(briefMatch[1]);
    const keyring = configuredKeyring();
    const brief = await one<{
      id: string;
      project_id: string;
      title: string;
      body_ciphertext: string;
      revision: number;
    }>(
      pool,
      'SELECT id,project_id,title,body_ciphertext,revision FROM briefs WHERE id=$1 AND account_id=$2',
      [id, accountId],
    );
    requireCondition(
      brief,
      404,
      'BRIEF_NOT_FOUND',
      'This Brief is unavailable.',
    );
    if (request.method === 'GET')
      return jsonResponse({
        brief: {
          id,
          projectId: brief.project_id,
          title: brief.title,
          revision: brief.revision,
          document: await readBriefDocument(pool, accountId, id),
          body: await decryptText(
            brief.body_ciphertext,
            `${accountId}:brief:${id}`,
            keyring,
          ),
        },
      });
    requireCondition(
      !(await one(
        pool,
        'SELECT brief_id FROM brief_documents WHERE brief_id=$1',
        [id],
      )),
      409,
      'STRUCTURED_BRIEF_EDIT_REQUIRED',
      'Edit the notes and decision to preserve the saved source records.',
    );
    const body = await readJson(request, 131072);
    const title = stringField(body, 'title', 160),
      content = stringField(body, 'body', 24000);
    guardContent(title, content);
    requireCondition(
      Number.isSafeInteger(body.revision) && Number(body.revision) > 0,
      400,
      'REVISION_REQUIRED',
      'Send the Brief revision.',
    );
    const encrypted = await encryptText(
      content,
      `${accountId}:brief:${id}`,
      keyring,
    );
    const updated = await one<{ revision: number }>(
      pool,
      `UPDATE briefs SET title=$3,body_ciphertext=$4,revision=revision+1,updated_at=now()
      WHERE id=$1 AND account_id=$2 AND revision=$5 RETURNING revision`,
      [id, accountId, title, encrypted, body.revision],
    );
    requireCondition(
      updated,
      409,
      'REVISION_CONFLICT',
      'This Brief changed. Reload before saving.',
    );
    return jsonResponse({
      brief: {
        id,
        projectId: brief.project_id,
        title,
        body: content,
        revision: updated.revision,
      },
    });
  }
  return null;
}
