import type { Pool, PoolClient } from 'pg';
import { one } from '../db/database.ts';
import {
  configuredKeyring,
  decryptText,
  type DataKeyring,
} from '../core/encryption.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';
import { nextCursor, readCursor } from '../core/pagination.ts';
import {
  parseBriefDocument,
  parseBriefGeneratedSynthesis,
  type BriefEvidence,
  type BriefGeneratedSynthesis,
} from '../../lib/brief-document.ts';
import {
  parseSynthesisAnalysis,
  type BriefSynthesisAnalysis,
} from '../../lib/brief-synthesis.ts';
import { hashSynthesisText } from './protocol.ts';

export type SynthesisQuote = {
  id: string;
  maximumUsd6: string;
  expiresAt: string;
  maxOutputTokens: number;
  inputBytes: number;
  requestHash: string;
  routeVersionId: string;
  modelId: string;
  family: string;
  card: Record<string, unknown>;
  markupBps: number;
};
export type SynthesisPlan = {
  id: string;
  account_id: string;
  project_id: string;
  brief_id: string | null;
  source_brief_id: string;
  quote_id: string;
  evidence_hash: string;
  prompt_version: 1;
  output_version: 1;
  snapshot_ciphertext: string;
  terms: SynthesisQuote;
  created_at: Date;
};
type Joined = SynthesisPlan & {
  call_id: string | null;
  call_state: string | null;
  error_code: string | null;
  billing_state: BriefGeneratedSynthesis['billingState'] | null;
  maximum_usd6: string | null;
  actual_usd6: string | null;
  result_status: 'valid' | 'invalid' | 'failed' | 'cancelled' | null;
  result_ciphertext: string | null;
  invalid_reason: string | null;
  output_hash: string | null;
  result_created_at: Date | null;
};
const joined = `SELECT p.*,e.call_id,c.state AS call_state,c.error_code,h.state AS billing_state,h.maximum_usd6,h.captured_usd6 AS actual_usd6,
  r.status AS result_status,r.result_ciphertext,r.invalid_reason,r.output_hash,r.created_at AS result_created_at
  FROM brief_synthesis_plans p LEFT JOIN brief_synthesis_executions e ON e.plan_id=p.id
  LEFT JOIN calls c ON c.id=e.call_id LEFT JOIN holds h ON h.id=c.hold_id
  LEFT JOIN brief_synthesis_results r ON r.plan_id=p.id`;

export async function ownedSynthesisPlan(
  db: Pool | PoolClient,
  accountId: string,
  id: string,
) {
  const row = await one<SynthesisPlan>(
    db,
    'SELECT * FROM brief_synthesis_plans WHERE id=$1 AND account_id=$2',
    [id, accountId],
  );
  requireCondition(
    row,
    404,
    'SYNTHESIS_NOT_FOUND',
    'This analysis is unavailable.',
  );
  return row;
}

export async function readSynthesisSnapshot(
  row: SynthesisPlan,
  keyring: DataKeyring,
) {
  try {
    const text = await decryptText(
      row.snapshot_ciphertext,
      `${row.account_id}:brief-synthesis-snapshot:${row.id}`,
      keyring,
    );
    const snapshot: unknown = JSON.parse(text);
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
      throw new Error();
    const data = snapshot as { savedAt: unknown; evidence: unknown };
    const document = parseBriefDocument({
      version: 1,
      savedAt: data.savedAt,
      evidenceHash: row.evidence_hash,
      evidence: data.evidence,
      analysis: { decision: '', notes: [], matrix: [] },
    });
    if (
      (await hashSynthesisText(JSON.stringify(document.evidence))) !==
      row.evidence_hash
    )
      throw new Error();
    for (const evidence of document.evidence)
      if ((await hashSynthesisText(evidence.answer)) !== evidence.answerHash)
        throw new Error();
    return document;
  } catch {
    throw new ServiceError(
      503,
      'CONTENT_UNAVAILABLE',
      'This saved analysis source is unavailable.',
    );
  }
}

async function view(row: Joined, keyring: DataKeyring, metadataOnly = false) {
  let analysis: BriefSynthesisAnalysis | null = null;
  if (row.result_status === 'valid' && !metadataOnly) {
    const source = await readSynthesisSnapshot(row, keyring);
    try {
      analysis = parseSynthesisAnalysis(
        JSON.parse(
          await decryptText(
            row.result_ciphertext!,
            `${row.account_id}:brief-synthesis-result:${row.id}`,
            keyring,
          ),
        ),
        source.evidence,
      );
    } catch {
      throw new ServiceError(
        503,
        'CONTENT_UNAVAILABLE',
        'This saved analysis is unavailable.',
      );
    }
  }
  const state =
    row.result_status ??
    (!row.call_id
      ? 'quoted'
      : row.call_state === 'reconciliation_pending' ||
          row.billing_state === 'reconciliation_pending'
        ? 'reconciliation_pending'
        : ['succeeded', 'failed', 'cancelled'].includes(row.call_state!)
          ? 'awaiting_evaluation'
          : row.call_state!);
  return {
    id: row.id,
    briefId: row.brief_id,
    sourceBriefId: row.source_brief_id,
    projectId: row.project_id,
    evidenceHash: row.evidence_hash,
    promptVersion: row.prompt_version,
    outputVersion: row.output_version,
    createdAt: row.created_at.toISOString(),
    approvalKey: `bs_${row.id}`,
    state,
    quote: row.terms,
    callId: row.call_id,
    errorCode: row.error_code,
    billing: row.call_id
      ? {
          state: row.billing_state!,
          maximumUsd6: row.maximum_usd6!,
          actualUsd6: row.actual_usd6,
        }
      : null,
    result: row.result_status
      ? {
          status: row.result_status,
          analysis,
          invalidReason: row.invalid_reason,
          outputHash: row.output_hash,
          createdAt: row.result_created_at!.toISOString(),
        }
      : null,
    metadataOnly,
  };
}

export async function getBriefSynthesis(
  db: Pool | PoolClient,
  accountId: string,
  id: string,
  keyring: DataKeyring,
) {
  const row = await one<Joined>(
    db,
    `${joined} WHERE p.id=$1 AND p.account_id=$2`,
    [id, accountId],
  );
  requireCondition(
    row,
    404,
    'SYNTHESIS_NOT_FOUND',
    'This analysis is unavailable.',
  );
  return view(row, keyring);
}

export async function listBriefSyntheses(
  db: Pool | PoolClient,
  accountId: string,
  briefId: string,
  cursorValue: string | null,
  keyring: DataKeyring,
) {
  const scope = `brief-synthesis:${briefId}`,
    cursor = readCursor(cursorValue, scope);
  const rows = await db.query<Joined & { cursorTime: string }>(
    `${joined.replace('SELECT p.*,', 'SELECT to_char(p.created_at AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS "cursorTime",p.*,')}
    WHERE p.account_id=$1 AND p.source_brief_id=$2 AND ($3::timestamptz IS NULL OR (p.created_at,p.id)<($3::timestamptz,$4::uuid)) ORDER BY p.created_at DESC,p.id DESC LIMIT 21`,
    [accountId, briefId, cursor?.time ?? null, cursor?.id ?? null],
  );
  const selection = await one<{ plan_id: string }>(
    db,
    'SELECT s.plan_id FROM brief_synthesis_selection s JOIN briefs b ON b.id=s.brief_id WHERE b.id=$1 AND b.account_id=$2',
    [briefId, accountId],
  );
  return {
    runs: await Promise.all(
      rows.rows.slice(0, 20).map((row) => view(row, keyring, true)),
    ),
    nextCursor: nextCursor(rows.rows, 20, scope),
    selectedRunId: selection?.plan_id ?? null,
  };
}

export async function readSelectedBriefSynthesis(
  db: Pool | PoolClient,
  accountId: string,
  briefId: string,
  evidence: readonly BriefEvidence[],
): Promise<BriefGeneratedSynthesis | null> {
  const row = await one<Joined>(
    db,
    `${joined} JOIN brief_synthesis_selection s ON s.plan_id=p.id WHERE s.brief_id=$1 AND p.brief_id=$1 AND p.account_id=$2`,
    [briefId, accountId],
  );
  if (!row) return null;
  const run = await view(row, configuredKeyring());
  requireCondition(
    run.result?.status === 'valid' &&
      run.result.analysis &&
      row.call_id &&
      row.billing_state &&
      row.maximum_usd6 &&
      row.output_hash,
    503,
    'CONTENT_UNAVAILABLE',
    'This saved analysis is unavailable.',
  );
  try {
    return parseBriefGeneratedSynthesis(
      {
        runId: row.id,
        callId: row.call_id,
        routeVersionId: row.terms.routeVersionId,
        modelId: row.terms.modelId,
        evidenceHash: row.evidence_hash,
        promptVersion: 1,
        outputVersion: 1,
        createdAt: row.result_created_at!.toISOString(),
        outputHash: row.output_hash,
        maximumUsd6: row.maximum_usd6,
        actualUsd6: row.actual_usd6,
        billingState: row.billing_state,
        analysis: run.result.analysis,
      },
      evidence,
      row.evidence_hash,
    );
  } catch {
    throw new ServiceError(
      503,
      'CONTENT_UNAVAILABLE',
      'This saved analysis is unavailable.',
    );
  }
}

/** Caller holds the owner account and Brief locks, also used by paid approval. */
export async function assertBriefSynthesisDeletable(
  db: PoolClient,
  accountId: string,
  briefId: string,
) {
  const pending = await one(
    db,
    `SELECT p.id FROM brief_synthesis_plans p JOIN brief_synthesis_executions e ON e.plan_id=p.id LEFT JOIN brief_synthesis_results r ON r.plan_id=p.id WHERE p.account_id=$1 AND p.brief_id=$2 AND r.plan_id IS NULL LIMIT 1`,
    [accountId, briefId],
  );
  requireCondition(
    !pending,
    409,
    'BRIEF_ANALYSIS_PENDING',
    'Finish, cancel or reconcile this Brief analysis before removing its source.',
  );
}
