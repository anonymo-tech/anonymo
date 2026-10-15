import { publicInferenceErrorCode, publicRouteCard } from "../routes/public-inference.ts";
import type { Pool } from "pg";
import { one, transaction } from "../db/database.ts";
import { configuredKeyring } from "../core/encryption.ts";
import { requireCondition } from "../core/errors.ts";
import { jsonResponse as response, readJson, uuidField } from "../core/http.ts";
import { briefDocumentResponse } from "../routes/brief-documents.ts";
import {
  approveBriefSynthesis,
  briefSynthesisCapability,
  evaluateBriefSynthesisForCall,
  quoteBriefSynthesis,
} from "./execution.ts";
import { getBriefSynthesis, listBriefSyntheses, ownedSynthesisPlan } from "./store.ts";

function jsonResponse(value: unknown, status = 200): Response {
  const project = (v: unknown): unknown => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    const r = { ...v } as Record<string, unknown>;
    if (r.card) r.card = publicRouteCard(r.card);
    if (typeof r.errorCode === "string" || r.errorCode === null)
      r.errorCode = publicInferenceErrorCode(r.errorCode);
    for (const key of ["plan", "run", "quote"]) if (r[key]) r[key] = project(r[key]);
    if (Array.isArray(r.runs)) r.runs = r.runs.map(project);
    return r;
  };
  return response(project(value), status);
}

function exact(body: Record<string, unknown>, fields: string[]) {
  requireCondition(
    Object.keys(body).length === fields.length && fields.every((key) => Object.hasOwn(body, key)),
    400,
    "INVALID_REQUEST",
    "Check the analysis request fields.",
  );
}
const id = (value: unknown) => uuidField(value).toLowerCase();

export async function briefSynthesisRoutes(
  pool: Pool,
  request: Request,
  path: string,
  accountId: string,
): Promise<Response | null> {
  if (path === "briefs/synthesis/capabilities" && request.method === "GET")
    return jsonResponse(await briefSynthesisCapability(pool));
  const quoteMatch = /^briefs\/([^/]+)\/synthesis\/quote$/.exec(path);
  if (quoteMatch && request.method === "POST") {
    const body = await readJson(request, 4096);
    exact(body, ["evidenceHash", "routeVersionId", "maxOutputTokens"]);
    requireCondition(
      typeof body.evidenceHash === "string" && /^[0-9a-f]{64}$/.test(body.evidenceHash),
      400,
      "INVALID_EVIDENCE_HASH",
      "Reload this Brief before analysis.",
    );
    requireCondition(
      Number.isInteger(body.maxOutputTokens) &&
        Number(body.maxOutputTokens) >= 1 &&
        Number(body.maxOutputTokens) <= 8192,
      400,
      "INVALID_OUTPUT_LIMIT",
      "Choose an output limit between one and 8192 tokens.",
    );
    return jsonResponse(
      await quoteBriefSynthesis(
        pool,
        {
          accountId,
          briefId: id(quoteMatch[1]),
          evidenceHash: body.evidenceHash,
          routeVersionId: id(body.routeVersionId),
          maxOutputTokens: Number(body.maxOutputTokens),
        },
        configuredKeyring(),
      ),
      201,
    );
  }
  const listMatch = /^briefs\/([^/]+)\/syntheses$/.exec(path);
  if (listMatch && request.method === "GET")
    return jsonResponse(
      await listBriefSyntheses(
        pool,
        accountId,
        id(listMatch[1]),
        new URL(request.url).searchParams.get("cursor"),
        configuredKeyring(),
      ),
    );
  const runMatch = /^brief-syntheses\/([^/]+)(?:\/(approve|cancel|evaluate))?$/.exec(path);
  if (runMatch) {
    const runId = id(runMatch[1]),
      action = runMatch[2],
      keys = configuredKeyring();
    if (!action && request.method === "GET")
      return jsonResponse({
        run: await getBriefSynthesis(pool, accountId, runId, keys),
      });
    if (action && request.method === "POST") {
      const body = await readJson(request, 4096);
      if (action === "approve") {
        exact(body, ["quoteId", "idempotencyKey", "approveMaximumUsd6"]);
        requireCondition(
          typeof body.idempotencyKey === "string" &&
            /^bs_[0-9a-f-]{36}$/.test(body.idempotencyKey) &&
            typeof body.approveMaximumUsd6 === "string" &&
            /^[1-9][0-9]{0,7}$/.test(body.approveMaximumUsd6),
          400,
          "INVALID_APPROVAL",
          "Review the exact saved maximum before approving.",
        );
        const result = await approveBriefSynthesis(
          pool,
          {
            accountId,
            runId,
            quoteId: id(body.quoteId),
            idempotencyKey: body.idempotencyKey,
            approveMaximumUsd6: body.approveMaximumUsd6,
          },
          keys,
        );
        return jsonResponse(result, result.replayed ? 200 : 202);
      }
      exact(body, []);
      const plan = await ownedSynthesisPlan(pool, accountId, runId),
        execution = await one<{ call_id: string }>(
          pool,
          "SELECT call_id FROM brief_synthesis_executions WHERE plan_id=$1",
          [plan.id],
        );
      requireCondition(
        execution,
        409,
        "SYNTHESIS_NOT_STARTED",
        "This analysis has not been approved.",
      );
      if (action === "evaluate") {
        await evaluateBriefSynthesisForCall(pool, execution.call_id, keys);
        return jsonResponse({
          run: await getBriefSynthesis(pool, accountId, runId, keys),
        });
      }
      await transaction(pool, async (db) => {
        await db.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [accountId]);
        await db.query(
          `UPDATE holds SET cancel_requested_at=COALESCE(cancel_requested_at,now()) WHERE id=(SELECT hold_id FROM calls WHERE id=$1 AND account_id=$2) AND state IN ('held','running','reconciliation_pending')`,
          [execution.call_id, accountId],
        );
      });
      return jsonResponse(
        {
          cancellationRequested: true,
          message:
            "Cancellation is requested. A running request may still complete and incur its actual cost; unknown charges require reconciliation.",
        },
        202,
      );
    }
  }
  const selectionMatch = /^briefs\/([^/]+)\/synthesis\/selection$/.exec(path);
  if (selectionMatch && request.method === "PATCH") {
    const briefId = id(selectionMatch[1]),
      body = await readJson(request, 4096);
    exact(body, ["revision", "runId"]);
    requireCondition(
      Number.isSafeInteger(body.revision) && Number(body.revision) > 0,
      400,
      "REVISION_REQUIRED",
      "Send the current Brief revision.",
    );
    const runId = body.runId === null ? null : id(body.runId);
    return transaction(pool, async (db) => {
      requireCondition(
        await one(db, "SELECT id FROM accounts WHERE id=$1 AND disabled_at IS NULL FOR UPDATE", [
          accountId,
        ]),
        401,
        "ACCOUNT_UNAVAILABLE",
        "This account is unavailable.",
      );
      const brief = await one<{
        revision: number;
        project_id: string;
        evidence_hash: string;
      }>(
        db,
        "SELECT b.revision,b.project_id,d.evidence_hash FROM briefs b JOIN brief_documents d ON d.brief_id=b.id WHERE b.id=$1 AND b.account_id=$2 FOR UPDATE OF b",
        [briefId, accountId],
      );
      requireCondition(brief, 404, "BRIEF_NOT_FOUND", "This Brief is unavailable.");
      requireCondition(
        brief.revision === body.revision,
        409,
        "REVISION_CONFLICT",
        "This Brief changed. Reload before selecting analysis.",
      );
      if (runId) {
        const plan = await ownedSynthesisPlan(db, accountId, runId),
          run = await getBriefSynthesis(db, accountId, runId, configuredKeyring());
        requireCondition(
          plan.brief_id === briefId &&
            plan.source_brief_id === briefId &&
            plan.project_id === brief.project_id &&
            plan.evidence_hash === brief.evidence_hash &&
            run.result?.status === "valid",
          409,
          "INVALID_SYNTHESIS_SELECTION",
          "Choose a completed valid analysis for this exact Brief.",
        );
        await db.query(
          "INSERT INTO brief_synthesis_selection(brief_id,plan_id) VALUES($1,$2) ON CONFLICT(brief_id) DO UPDATE SET plan_id=EXCLUDED.plan_id",
          [briefId, runId],
        );
      } else await db.query("DELETE FROM brief_synthesis_selection WHERE brief_id=$1", [briefId]);
      await db.query("UPDATE briefs SET revision=revision+1,updated_at=now() WHERE id=$1", [
        briefId,
      ]);
      return briefDocumentResponse(db, accountId, briefId);
    });
  }
  return null;
}
