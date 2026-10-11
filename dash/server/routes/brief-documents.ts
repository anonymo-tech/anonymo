import type { Pool, PoolClient } from 'pg';
import { one, transaction } from '../db/database.ts';
import {
  configuredKeyring,
  decryptText,
  encryptText,
} from '../core/encryption.ts';
import { digestText } from '../core/digest.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';
import {
  jsonResponse,
  readJson,
  stringField,
  uuidField,
} from '../core/http.ts';
import { scanPrompt } from '../../lib/guards/index.ts';
import {
  parseBriefAnalysis,
  parseBriefDocument,
  renderBriefMarkdown,
  type BriefDocument,
  type BriefEvidence,
} from '../../lib/brief-document.ts';
import type { ChatInput } from './call-contract.ts';
import { readSelectedBriefSynthesis } from '../briefs/store.ts';

async function sha256(value: string) {
  return Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  ).toString('hex');
}

function guard(...values: string[]) {
  requireCondition(
    values.every(
      (value) =>
        !scanPrompt(value).findings.some((f) => f.severity === 'block'),
    ),
    422,
    'SENSITIVE_CONTENT',
    'Remove or redact the detected secret before saving.',
  );
}

export async function readBriefDocument(
  db: Pool | PoolClient,
  accountId: string,
  briefId: string,
): Promise<BriefDocument | null> {
  const row = await one<{
    evidence_ciphertext: string;
    evidence_hash: string;
    analysis_ciphertext: string;
    saved_at: Date;
  }>(
    db,
    `SELECT d.* FROM brief_documents d JOIN briefs b ON b.id=d.brief_id WHERE b.id=$1 AND b.account_id=$2`,
    [briefId, accountId],
  );
  if (!row) return null;
  const keys = configuredKeyring();
  const evidenceText = await decryptText(
    row.evidence_ciphertext,
    `${accountId}:brief-evidence:${briefId}`,
    keys,
  );
  requireCondition(
    (await sha256(evidenceText)) === row.evidence_hash,
    503,
    'CONTENT_UNAVAILABLE',
    'This saved content is unavailable.',
  );
  try {
    const document = parseBriefDocument({
      version: 1,
      savedAt: row.saved_at.toISOString(),
      evidenceHash: row.evidence_hash,
      evidence: JSON.parse(evidenceText),
      analysis: JSON.parse(
        await decryptText(
          row.analysis_ciphertext,
          `${accountId}:brief-analysis:${briefId}`,
          keys,
        ),
      ),
    });
    const synthesis = await readSelectedBriefSynthesis(
      db,
      accountId,
      briefId,
      document.evidence,
    );
    return synthesis
      ? parseBriefDocument({ ...document, synthesis })
      : document;
  } catch {
    throw new ServiceError(
      503,
      'CONTENT_UNAVAILABLE',
      'This saved content is unavailable.',
    );
  }
}

export async function briefDocumentResponse(
  db: Pool | PoolClient,
  accountId: string,
  id: string,
  status = 200,
) {
  const brief = await one<{
    title: string;
    project_id: string;
    revision: number;
    created_at: Date;
    updated_at: Date;
  }>(db, 'SELECT * FROM briefs WHERE id=$1 AND account_id=$2 FOR SHARE', [
    id,
    accountId,
  ]);
  requireCondition(brief, 404, 'BRIEF_NOT_FOUND', 'This Brief is unavailable.');
  const document = await readBriefDocument(db, accountId, id);
  requireCondition(
    document,
    404,
    'BRIEF_NOT_FOUND',
    'This Brief is unavailable.',
  );
  return jsonResponse(
    {
      brief: {
        id,
        title: brief.title,
        projectId: brief.project_id,
        revision: brief.revision,
        createdAt: brief.created_at,
        updatedAt: brief.updated_at,
        body: renderBriefMarkdown(brief.title, document),
        document,
      },
    },
    status,
  );
}

export async function briefDocumentRoutes(
  pool: Pool,
  request: Request,
  path: string,
  accountId: string,
): Promise<Response | null> {
  const readMatch = /^briefs\/([^/]+)$/.exec(path);
  if (readMatch && request.method === 'GET') {
    const id = uuidField(readMatch[1]);
    if (
      await one(
        pool,
        'SELECT d.brief_id FROM brief_documents d JOIN briefs b ON b.id=d.brief_id WHERE b.id=$1 AND b.account_id=$2',
        [id, accountId],
      )
    )
      return transaction(pool, (db) =>
        briefDocumentResponse(db, accountId, id),
      );
  }
  if (path === 'briefs/from-calls' && request.method === 'POST') {
    const body = await readJson(request, 4096),
      projectId = uuidField(body.projectId),
      idempotencyKey = uuidField(body.idempotencyKey),
      title = stringField(body, 'title', 160).trim();
    guard(title);
    requireCondition(
      Array.isArray(body.callIds) &&
        body.callIds.length >= 1 &&
        body.callIds.length <= 4,
      400,
      'INVALID_BRIEF_SELECTION',
      'Choose between one and four completed responses.',
    );
    const callIds = body.callIds.map(uuidField);
    requireCondition(
      new Set(callIds).size === callIds.length,
      400,
      'INVALID_BRIEF_SELECTION',
      'Choose each response once.',
    );
    const requestHash = await digestText(
      'brief-create',
      JSON.stringify({ projectId, title, callIds }),
    );
    return transaction(pool, async (db) => {
      await db.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [
        accountId,
      ]);
      const previous = await one<{
        request_hash: string;
        brief_id: string | null;
      }>(
        db,
        'SELECT * FROM brief_creation_keys WHERE account_id=$1 AND idempotency_key=$2',
        [accountId, idempotencyKey],
      );
      if (previous) {
        requireCondition(
          previous.request_hash === requestHash,
          409,
          'IDEMPOTENCY_CONFLICT',
          'This request key was already used for a different Brief.',
        );
        requireCondition(
          previous.brief_id,
          410,
          'BRIEF_REMOVED',
          'This Brief was already removed.',
        );
        return briefDocumentResponse(db, accountId, previous.brief_id);
      }
      const project = await one(
        db,
        'SELECT id FROM projects WHERE id=$1 AND account_id=$2 AND archived_at IS NULL FOR SHARE',
        [projectId, accountId],
      );
      requireCondition(
        project,
        404,
        'PROJECT_NOT_FOUND',
        'This project is unavailable.',
      );
      type Row = {
        id: string;
        state: string;
        comparison_id: string;
        blind: boolean;
        revealed_at: Date | null;
        route_version_id: string;
        model_id: string;
        input_ciphertext: string;
        output_ciphertext: string | null;
        actual_usd6: string | null;
        billing_state: BriefEvidence['billingState'];
      };
      const selected = await db.query<Row>(
        `SELECT c.id,c.state,cc.comparison_id,co.blind,co.revealed_at,c.route_version_id,r.model_id,c.input_ciphertext,c.output_ciphertext,h.captured_usd6 AS actual_usd6,h.state AS billing_state
        FROM calls c JOIN comparison_calls cc ON cc.call_id=c.id JOIN comparisons co ON co.id=cc.comparison_id
        JOIN route_versions r ON r.id=c.route_version_id JOIN holds h ON h.id=c.hold_id
        WHERE c.id=ANY($1::uuid[]) AND c.account_id=$2 AND c.project_id=$3 AND co.account_id=$2 AND co.project_id=$3 FOR SHARE OF c,co,h`,
        [callIds, accountId, projectId],
      );
      requireCondition(
        selected.rows.length === callIds.length,
        404,
        'BRIEF_SELECTION_UNAVAILABLE',
        'A selected response is unavailable.',
      );
      const keys = configuredKeyring(),
        evidence: BriefEvidence[] = [];
      let length = 0;
      for (const callId of callIds) {
        const row = selected.rows.find((r) => r.id === callId)!;
        requireCondition(
          !row.blind || row.revealed_at,
          409,
          'BLIND_REVEAL_REQUIRED',
          'Reveal the model names before saving their provenance.',
        );
        requireCondition(
          row.state === 'succeeded' && row.output_ciphertext,
          409,
          'BRIEF_RESPONSE_INCOMPLETE',
          'Wait for each selected response to complete.',
        );
        const input = JSON.parse(
          await decryptText(
            row.input_ciphertext,
            `${accountId}:call-input:${callId}`,
            keys,
          ),
        ) as ChatInput;
        const question = input.messages.at(-1)?.content ?? '',
          answer = await decryptText(
            row.output_ciphertext,
            `${accountId}:call-output:${callId}`,
            keys,
          );
        length += question.length + answer.length;
        requireCondition(
          length <= 24000 && answer.trim(),
          413,
          'BRIEF_TOO_LARGE',
          'Select fewer or shorter responses for this Brief.',
        );
        guard(question, answer);
        evidence.push({
          callId,
          comparisonId: row.comparison_id,
          routeVersionId: row.route_version_id,
          modelId: row.model_id,
          question,
          answer,
          answerHash: await sha256(answer),
          actualUsd6: row.actual_usd6,
          billingState: row.billing_state,
        });
      }
      const id = crypto.randomUUID(),
        evidenceText = JSON.stringify(evidence),
        savedAt = new Date().toISOString();
      const document = parseBriefDocument({
        version: 1,
        savedAt,
        evidenceHash: await sha256(evidenceText),
        evidence,
        analysis: { decision: '', notes: [], matrix: [] },
      });
      const markdown = renderBriefMarkdown(title, document);
      await db.query(
        'INSERT INTO briefs(id,account_id,project_id,title,body_ciphertext) VALUES($1,$2,$3,$4,$5)',
        [
          id,
          accountId,
          projectId,
          title,
          await encryptText(markdown, `${accountId}:brief:${id}`, keys),
        ],
      );
      await db.query(
        'INSERT INTO brief_documents(brief_id,evidence_ciphertext,evidence_hash,analysis_ciphertext,saved_at) VALUES($1,$2,$3,$4,$5)',
        [
          id,
          await encryptText(
            evidenceText,
            `${accountId}:brief-evidence:${id}`,
            keys,
          ),
          document.evidenceHash,
          await encryptText(
            JSON.stringify(document.analysis),
            `${accountId}:brief-analysis:${id}`,
            keys,
          ),
          savedAt,
        ],
      );
      await db.query(
        'INSERT INTO brief_creation_keys(account_id,idempotency_key,request_hash,brief_id) VALUES($1,$2,$3,$4)',
        [accountId, idempotencyKey, requestHash, id],
      );
      return briefDocumentResponse(db, accountId, id, 201);
    });
  }
  const match = /^briefs\/([^/]+)\/document$/.exec(path);
  if (match && request.method === 'PATCH') {
    const id = uuidField(match[1]),
      body = await readJson(request, 65536),
      title = stringField(body, 'title', 160).trim();
    requireCondition(
      Number.isSafeInteger(body.revision) && Number(body.revision) > 0,
      400,
      'REVISION_REQUIRED',
      'Send the Brief revision.',
    );
    return transaction(pool, async (db) => {
      const row = await one<{ revision: number }>(
        db,
        'SELECT revision FROM briefs WHERE id=$1 AND account_id=$2 FOR UPDATE',
        [id, accountId],
      );
      requireCondition(
        row,
        404,
        'BRIEF_NOT_FOUND',
        'This Brief is unavailable.',
      );
      requireCondition(
        row.revision === body.revision,
        409,
        'REVISION_CONFLICT',
        'This Brief changed. Reload before saving.',
      );
      const document = await readBriefDocument(db, accountId, id);
      requireCondition(
        document,
        409,
        'STRUCTURED_BRIEF_REQUIRED',
        'This Brief does not have structured source records.',
      );
      try {
        document.analysis = parseBriefAnalysis(
          body.analysis,
          document.evidence.map((e) => e.callId),
        );
      } catch {
        throw new ServiceError(
          400,
          'INVALID_BRIEF_ANALYSIS',
          'Check your decision, notes and agreement matrix.',
        );
      }
      guard(
        title,
        document.analysis.decision,
        ...document.analysis.notes.map((n) => n.text),
        ...document.analysis.matrix.map((r) => r.topic),
      );
      const keys = configuredKeyring();
      await db.query(
        'UPDATE brief_documents SET analysis_ciphertext=$2 WHERE brief_id=$1',
        [
          id,
          await encryptText(
            JSON.stringify(document.analysis),
            `${accountId}:brief-analysis:${id}`,
            keys,
          ),
        ],
      );
      await db.query(
        'UPDATE briefs SET title=$3,body_ciphertext=$4,revision=revision+1,updated_at=now() WHERE id=$1 AND account_id=$2',
        [
          id,
          accountId,
          title,
          await encryptText(
            renderBriefMarkdown(title, document),
            `${accountId}:brief:${id}`,
            keys,
          ),
        ],
      );
      return briefDocumentResponse(db, accountId, id);
    });
  }
  return null;
}
