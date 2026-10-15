import type { Pool, PoolClient } from "pg";
import { one, transaction, type Queryable } from "../db/database.ts";
import { requireCondition } from "../core/errors.ts";
import { jsonResponse, readJson, stringField, uuidField } from "../core/http.ts";
import { rateLimit } from "../core/rate-limit.ts";
import {
  maturedBurnReserveUsd6,
  nextBurnPeriodStart,
  recordBurnExecution,
} from "../token/burn-ledger.ts";
import { platformFeeConfig } from "../ledger/platform-fee.ts";
import type { Session } from "../routes/session.ts";
import {
  OWNER,
  MINT,
  TOKEN_PROGRAM,
  ATA,
  USDC,
  rpc,
  mainnet,
  finalized,
  checkedSignature,
  verifySwap,
  unsignedBurn,
  verifyBurn,
} from "./chain.ts";
import { parseSerializedTransaction } from "../solana/serialized.ts";

type Batch = {
  id: string;
  state: "reserved" | "bought" | "burned" | "cancelled";
  amount_usd6: string;
  period_start: Date;
  period_end: Date;
  matured_usd6: string;
  swap_signature: string | null;
  bought_raw: string | null;
  burn_signature: string | null;
  burn_record: string | null;
  created_at: Date;
};
type Plan = {
  id: string;
  batch_id: string;
  message_base64: string;
  unsigned_transaction: string;
  context_slot: string;
  last_valid_block_height: string;
  created_at: Date;
};
const LOCK = "SELECT pg_advisory_xact_lock(734962310)";
const batchColumns =
  "id,state,amount_usd6::text,period_start,period_end,matured_usd6::text,swap_signature,bought_raw::text,burn_signature,burn_record,created_at";
async function eligible(db: Queryable, end: Date) {
  const row = await one<{ accrued: string; spent: string; starts_at: Date }>(
    db,
    `SELECT a.starts_at,
    COALESCE((SELECT sum(e.amount_usd6) FROM ledger_entries e JOIN ledger_accounts l ON l.id=e.ledger_account_id WHERE l.kind='burn_reserve' AND l.owner_id IS NULL AND e.amount_usd6>0 AND e.created_at>=a.starts_at AND e.created_at<$1),0)::text AS accrued,
    COALESCE((SELECT sum(amount_usd6) FROM flywheel_batches WHERE state='burned'),0)::text AS spent FROM flywheel_activation a`,
    [end],
  );
  requireCondition(row, 503, "FLYWHEEL_UNAVAILABLE", "Flywheel activation is not configured.");
  const amount = BigInt(row.accrued) - BigInt(row.spent);
  requireCondition(amount >= 0n, 503, "FLYWHEEL_UNAVAILABLE", "The reserve needs reconciliation.");
  return { ...row, available: amount };
}
export async function publicFlywheel(db: Queryable) {
  const end = new Date(Math.floor(Date.now() / 3600000) * 3600000);
  const totals = await eligible(db, end);
  const active = await one<{ amount: string }>(
    db,
    "SELECT amount_usd6::text AS amount FROM flywheel_batches WHERE state IN ('reserved','bought')",
  );
  const records = await db.query(
    `SELECT b.id,b.spent_usd6::text AS "spentUsd6",b.tokens_burned_raw::text AS "tokensBurnedRaw",b.swap_signature AS "swapSignature",b.burn_signature AS "burnSignature",b.finalized_slot::text AS "finalizedSlot",b.created_at AS "createdAt",b.record_hash AS "recordHash" FROM token_burns b JOIN flywheel_batches f ON f.burn_record=b.id WHERE f.state='burned' AND b.cluster='mainnet-beta' AND b.token_mint=$1 ORDER BY b.created_at DESC LIMIT 50`,
    [MINT],
  );
  const count = await one<{ count: number; tokens: string }>(
    db,
    `SELECT count(*)::int AS count,COALESCE(sum(b.tokens_burned_raw),0)::text AS tokens FROM token_burns b JOIN flywheel_batches f ON f.burn_record=b.id WHERE f.state='burned'`,
  );
  return {
    live:
      process.env.CONCLAVE_PLATFORM_FEE_BPS === "500" &&
      process.env.CONCLAVE_BURN_SHARE_BPS === "5000",
    owner: OWNER,
    mint: MINT,
    cluster: "mainnet-beta",
    decimals: 6,
    startsAt: totals.starts_at,
    asOf: end.toISOString(),
    terms: platformFeeConfig(),
    accruedUsd6: totals.accrued,
    spentUsd6: totals.spent,
    availableUsd6: totals.available.toString(),
    reservedUsd6: active?.amount ?? "0",
    burnCount: count!.count,
    tokensBurnedRaw: count!.tokens,
    burns: records.rows,
    mode: "owner-signed",
    scope: "Chat, comparisons, and Model routes",
    reserveKind: "Accounting allocation; wallet funding and gas are separate.",
  };
}
let summaryCache: { at: number; value: ReturnType<typeof publicFlywheel> } | null = null;
export async function cachedPublicFlywheel(db: Queryable) {
  if (!summaryCache || Date.now() - summaryCache.at > 15000) {
    const value = publicFlywheel(db);
    summaryCache = { at: Date.now(), value };
    value.catch(() => {
      summaryCache = null;
    });
  }
  return summaryCache.value;
}
export async function requireOwner(db: Queryable, session: Session) {
  // A passkey or a different wallet linked to the same account cannot operate the flywheel.
  const owner = await one(
    db,
    `SELECT s.token_hash FROM sessions s JOIN identities i ON i.id=s.identity_id AND i.account_id=s.account_id
    WHERE s.token_hash=$1 AND s.account_id=$2 AND s.expires_at>now() AND s.revoked_at IS NULL
    AND i.kind='solana' AND i.subject=$3 AND i.revoked_at IS NULL`,
    [session.tokenHash, session.accountId, OWNER],
  );
  requireCondition(
    owner,
    403,
    "OWNER_WALLET_REQUIRED",
    "Sign in using the flywheel wallet to manage burns.",
  );
}
async function current(db: Queryable) {
  return one<Batch>(
    db,
    `SELECT ${batchColumns} FROM flywheel_batches WHERE state IN ('reserved','bought')`,
  );
}
async function latestPlan(db: Queryable, batchId: string) {
  return one<Plan>(
    db,
    "SELECT * FROM flywheel_burn_plans WHERE batch_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
    [batchId],
  );
}
async function lockedBatch(client: PoolClient, id: string) {
  await client.query(LOCK);
  const batch = await one<Batch>(
    client,
    `SELECT ${batchColumns} FROM flywheel_batches WHERE id=$1 FOR UPDATE`,
    [id],
  );
  requireCondition(batch, 404, "BATCH_NOT_FOUND", "This batch was not found.");
  return batch;
}
export async function reserveBatch(pool: Pool, amount: string) {
  requireCondition(
    /^[1-9][0-9]{0,11}$/.test(amount),
    400,
    "INVALID_AMOUNT",
    "Enter a positive amount in USDC, with at most six decimal places.",
  );
  return transaction(pool, async (c) => {
    await c.query(LOCK);
    requireCondition(
      !(await current(c)),
      409,
      "BATCH_ACTIVE",
      "Complete or cancel the current reservation first.",
    );
    const end = new Date(Math.floor(Date.now() / 3600000) * 3600000),
      start = await nextBurnPeriodStart(c);
    const totals = await eligible(c, end),
      matured = await maturedBurnReserveUsd6(c, end);
    requireCondition(
      start && start < end && BigInt(amount) <= totals.available && BigInt(amount) <= matured,
      409,
      "INSUFFICIENT_RESERVE",
      "This amount exceeds the new release’s matured reserve. Allocations mature at the next UTC hour.",
    );
    const id = crypto.randomUUID();
    await c.query(
      "INSERT INTO flywheel_batches(id,amount_usd6,period_start,period_end,matured_usd6) VALUES($1,$2,$3,$4,$5)",
      [id, amount, start, end, matured.toString()],
    );
    return current(c);
  });
}
async function recordFinalBurn(c: PoolClient, b: Batch, signature: string, plan: Plan, tx: any) {
  const slot = verifyBurn(tx, signature, plan.message_base64);
  const spent = BigInt(b.amount_usd6),
    bought = BigInt(b.bought_raw!);
  const record = await recordBurnExecution(c, {
    periodStart: b.period_start,
    periodEnd: b.period_end,
    maturedUsd6: BigInt(b.matured_usd6),
    spentUsd6: spent,
    funding: "jupiter",
    cluster: "mainnet-beta",
    tokenMint: MINT,
    tokenProgram: "token-2022",
    tokenDecimals: 6,
    priceUsd6PerToken: (spent * 1000000n + bought - 1n) / bought,
    priceSource: "verified-swap",
    tokensBoughtRaw: bought,
    tokensBurnedRaw: bought,
    swapSignature: b.swap_signature,
    burnSignature: signature,
    finalizedSlot: slot,
  });
  await c.query(
    "UPDATE flywheel_batches SET state='burned',burn_signature=$2,burn_record=$3 WHERE id=$1",
    [b.id, signature, record.id],
  );
  return record;
}
/** Refresh only once the old blockhash cannot land and finalized history proves
 * the old message was not executed. Unknown/truncated history fails closed. */
async function recoverExpired(c: PoolClient, b: Batch, plan: Plan) {
  const height = await rpc("getBlockHeight", [{ commitment: "finalized" }]);
  requireCondition(
    Number.isSafeInteger(height) && BigInt(height) > BigInt(plan.last_valid_block_height),
    409,
    "PLAN_STILL_VALID",
    "Use the existing plan, or wait for its blockhash to expire. Do not submit twice.",
  );
  const history = await rpc("getSignaturesForAddress", [
    OWNER,
    { limit: 100, commitment: "finalized", minContextSlot: Number(plan.context_slot) },
  ]);
  requireCondition(
    Array.isArray(history) &&
      (history.length < 100 || history.at(-1).slot < Number(plan.context_slot)),
    409,
    "MANUAL_RECOVERY_REQUIRED",
    "Wallet history is too long to prove a safe refresh. Recover using the original burn signature.",
  );
  for (const item of history.filter((x: any) => x.slot >= Number(plan.context_slot))) {
    const tx = await rpc("getTransaction", [
      item.signature,
      { encoding: "base64", commitment: "finalized", maxSupportedTransactionVersion: 0 },
    ]);
    requireCondition(
      tx && Array.isArray(tx.transaction),
      409,
      "MANUAL_RECOVERY_REQUIRED",
      "Transaction history is incomplete. Recover using the original burn signature.",
    );
    if (
      parseSerializedTransaction(tx.transaction[0]).messageBase64 === plan.message_base64 &&
      tx.meta?.err === null
    ) {
      await recordFinalBurn(c, b, item.signature, plan, tx);
      return true;
    }
  }
  return false;
}
export async function ownerFlywheel(
  pool: Pool,
  request: Request,
  path: string,
  session: Session,
): Promise<Response | null> {
  if (!path.startsWith("flywheel/")) return null;
  await requireOwner(pool, session);
  if (request.method === "GET" && path === "flywheel/owner") {
    const batch = await current(pool);
    return jsonResponse({
      batch,
      plan: batch ? await latestPlan(pool, batch.id) : null,
      owner: OWNER,
      tokenAccount: ATA,
    });
  }
  if (request.method !== "POST") return null;
  await rateLimit(pool, `flywheel:${session.accountId}`, 12);
  const body = await readJson(request);
  summaryCache = null;
  if (path === "flywheel/batches")
    return jsonResponse(
      { batch: await reserveBatch(pool, stringField(body, "amountUsd6", 12)) },
      201,
    );
  const match = /^flywheel\/batches\/([^/]+)\/(swap|burn-plan|burn|cancel)$/.exec(path);
  if (!match) return null;
  const id = uuidField(match[1]),
    action = match[2];
  return transaction(pool, async (c) => {
    const b = await lockedBatch(c, id);
    if (action === "cancel") {
      requireCondition(
        b.state === "reserved",
        409,
        "BATCH_LOCKED",
        "A verified purchase must be burned before another batch can begin.",
      );
      await c.query("UPDATE flywheel_batches SET state='cancelled' WHERE id=$1", [id]);
      return jsonResponse({ cancelled: true });
    }
    if (action === "swap") {
      const signature = checkedSignature(body.signature);
      if (b.swap_signature === signature) return jsonResponse({ batch: b });
      requireCondition(
        b.state === "reserved",
        409,
        "BATCH_LOCKED",
        "This batch already has a verified purchase.",
      );
      await mainnet();
      const tx = await finalized(signature);
      const bought = verifySwap(tx, { signature, amount: b.amount_usd6, createdAt: b.created_at });
      const used = await one(c, "SELECT id FROM flywheel_batches WHERE swap_signature=$1", [
        signature,
      ]);
      requireCondition(!used, 409, "SWAP_ALREADY_RECORDED", "That purchase is already recorded.");
      await c.query(
        "UPDATE flywheel_batches SET state='bought',swap_signature=$2,bought_raw=$3 WHERE id=$1",
        [id, signature, bought.toString()],
      );
      return jsonResponse({ batch: await current(c) });
    }
    if (action === "burn" && b.state === "burned" && b.burn_signature === body.signature)
      return jsonResponse({ recorded: true });
    requireCondition(
      b.state === "bought",
      409,
      "PURCHASE_REQUIRED",
      "Verify this batch’s finalized purchase first.",
    );
    await mainnet();
    if (action === "burn-plan") {
      const old = await latestPlan(c, id);
      if (old && body.refresh !== true) return jsonResponse({ plan: old });
      if (old && (await recoverExpired(c, b, old))) return jsonResponse({ recorded: true });
      const balance = await rpc("getTokenAccountBalance", [ATA, { commitment: "finalized" }]);
      requireCondition(
        balance?.value?.decimals === 6 && BigInt(balance.value.amount) >= BigInt(b.bought_raw!),
        409,
        "TOKEN_BALANCE_REQUIRED",
        "The purchased CLVE must remain in the flywheel wallet.",
      );
      const block = await rpc("getLatestBlockhash", [{ commitment: "finalized" }]);
      const wire = unsignedBurn(BigInt(b.bought_raw!), block.value.blockhash),
        planId = crypto.randomUUID();
      await c.query(
        "INSERT INTO flywheel_burn_plans(id,batch_id,message_base64,unsigned_transaction,context_slot,last_valid_block_height) VALUES($1,$2,$3,$4,$5,$6)",
        [planId, id, wire.message, wire.wire, block.context.slot, block.value.lastValidBlockHeight],
      );
      return jsonResponse({ plan: await latestPlan(c, id) });
    }
    const signature = checkedSignature(body.signature),
      tx = await finalized(signature, "base64");
    const parsed = parseSerializedTransaction(tx.transaction[0]);
    const plan = await one<Plan>(
      c,
      "SELECT * FROM flywheel_burn_plans WHERE batch_id=$1 AND message_base64=$2",
      [id, parsed.messageBase64],
    );
    requireCondition(
      plan,
      400,
      "BURN_PROOF_REJECTED",
      "The burn does not match a saved plan for this batch.",
    );
    return jsonResponse({
      recorded: true,
      record: await recordFinalBurn(c, b, signature, plan, tx),
    });
  });
}
