import type { PoolClient } from "pg";
import { one } from "../db/database.ts";
import { requireCondition } from "../core/errors.ts";
import { configuredKeyring, encryptText } from "../core/encryption.ts";
import {
  assertUsableRoute,
  parseChatInput,
  callRequestHash,
  quoteMaximum,
  CHAT_REQUEST_BUDGET_USD6,
  type RouteVersion,
} from "../routes/call-contract.ts";
import { priceQuoteMaximum, recordQuotePlatformFee } from "../ledger/platform-fee.ts";
import { reserveQuoteInTransaction } from "../ledger/ledger.ts";
import { enqueue } from "../db/jobs.ts";
import { scanPrompt } from "../../lib/guards/index.ts";

export async function taskQuote(
  db: PoolClient,
  accountId: string,
  projectId: string,
  family: string,
  prompt: string,
) {
  requireCondition(
    await one(db, "SELECT id FROM projects WHERE id=$1 AND account_id=$2 AND archived_at IS NULL", [
      projectId,
      accountId,
    ]),
    404,
    "PROJECT_NOT_FOUND",
    "Choose an available project.",
  );
  requireCondition(
    !scanPrompt(prompt).findings.some((f) => f.severity === "block"),
    422,
    "SENSITIVE_CONTENT",
    "Remove detected secrets before sending.",
  );
  const route = await one<RouteVersion>(
    db,
    "SELECT *,expires_at>now() AS fresh FROM route_versions WHERE family=$1 AND modality='chat' AND enabled AND expires_at>now() ORDER BY created_at DESC LIMIT 1",
    [family],
  );
  assertUsableRoute(route);
  const input = parseChatInput({
    messages: [{ role: "user", content: prompt }],
    maxOutputTokens: 1024,
    privacy: "standard",
  });
  const hash = await callRequestHash(projectId, route.id, input);
  const price = priceQuoteMaximum(quoteMaximum(route, input), {
    limitUsd6: CHAT_REQUEST_BUDGET_USD6,
  });
  return { route, input, hash, price };
}
export async function queueTask(
  db: PoolClient,
  accountId: string,
  projectId: string,
  family: string,
  prompt: string,
  maximum: bigint,
  key: string,
) {
  const existing = await one<{ id: string }>(
    db,
    "SELECT c.id FROM calls c JOIN holds h ON h.id=c.hold_id WHERE h.account_id=$1 AND h.idempotency_key=$2",
    [accountId, key],
  );
  if (existing) return existing.id;
  const q = await taskQuote(db, accountId, projectId, family, prompt);
  requireCondition(
    BigInt(q.price.maximumUsd6) <= maximum,
    409,
    "ALLOWANCE_TOO_SMALL",
    "The current quote exceeds the approved per-run allowance.",
  );
  const quoteId = crypto.randomUUID(),
    callId = crypto.randomUUID();
  await db.query(
    "INSERT INTO quotes(id,account_id,project_id,route_version_id,request_hash,max_usd6,max_output_tokens,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '2 minutes')",
    [
      quoteId,
      accountId,
      projectId,
      q.route.id,
      q.hash,
      q.price.maximumUsd6,
      q.input.maxOutputTokens,
    ],
  );
  await recordQuotePlatformFee(db, quoteId, q.price.platformFee);
  const encrypted = await encryptText(
    JSON.stringify(q.input),
    `${accountId}:call-input:${callId}`,
    configuredKeyring(),
  );
  await reserveQuoteInTransaction(
    db,
    { accountId, quoteId, idempotencyKey: key, requestHash: q.hash },
    async (client, hold) => {
      await client.query(
        "INSERT INTO calls(id,account_id,project_id,hold_id,route_version_id,input_ciphertext,state) VALUES($1,$2,$3,$4,$5,$6,'queued')",
        [callId, accountId, projectId, hold.id, q.route.id, encrypted],
      );
      await enqueue(client, {
        kind: "inference",
        reference: `inference:${callId}`,
        payload: { callId },
        maxAttempts: 1,
      });
    },
  );
  return callId;
}
