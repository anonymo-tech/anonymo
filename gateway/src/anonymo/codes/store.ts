import { randomBytes, randomUUID } from "node:crypto";
import { and, count, eq, gt } from "drizzle-orm";
import { insertRootKey } from "../../api/auth.ts";
import { generateApiKey } from "../../chain/keys.ts";
import type { Ctx } from "../../context.ts";
import type { Db } from "../../db/client.ts";
import { fail } from "../../lib/errors.ts";
import { usdToPico } from "../../lib/money.ts";
import { sha256 } from "../../lib/util.ts";
import { post } from "../../ledger/ledger.ts";
import { CODE_ALPHABET, codeChecksum, formatCode } from "./format.ts";
import { codes } from "./schema.ts";

export const MAX_BATCH_COUNT = 100;
export const MAX_BATCH_USD = 2_500;
const PAGE_SIZE = 50;

function generateCode() {
  // Each byte contributes five unbiased bits. The final symbol is the checksum.
  const payload = Array.from(randomBytes(15), (byte) => CODE_ALPHABET[byte & 31]).join("");
  return formatCode(payload + codeChecksum(payload));
}

export async function issueBatch(db: Db, resellerId: string, faceUsd: number, size: number) {
  if (size > MAX_BATCH_COUNT || faceUsd * size > MAX_BATCH_USD) {
    fail(400, `A batch can hold at most ${MAX_BATCH_COUNT} codes and $${MAX_BATCH_USD} in face value.`, "batch_cap_exceeded");
  }
  const batchId = randomUUID();
  const issued = new Map<string, string>();
  while (issued.size < size) {
    const code = generateCode();
    issued.set(sha256(code), code);
  }
  // A single insert either issues the entire batch or issues nothing.
  await db.insert(codes).values(Array.from(issued.keys(), (codeHash) => ({ codeHash, faceUsd, batchId, resellerId })));
  return { batch_id: batchId, face_usd: faceUsd, count: size, codes: [...issued.values()] };
}

export async function listBatches(db: Db, resellerId: string, after?: string) {
  const rows = await db.select({
    batch_id: codes.batchId, face_usd: codes.faceUsd, count: count(), redeemed_count: count(codes.redeemedAt),
  }).from(codes)
    .where(and(eq(codes.resellerId, resellerId), after ? gt(codes.batchId, after) : undefined))
    .groupBy(codes.batchId, codes.faceUsd).orderBy(codes.batchId).limit(PAGE_SIZE + 1);
  const data = rows.slice(0, PAGE_SIZE);
  return { data, next_cursor: rows.length > PAGE_SIZE ? data[PAGE_SIZE - 1].batch_id : null };
}

export async function redeemCode(
  ctx: Pick<Ctx, "db" | "cfg">,
  code: string,
  key: { keyHash: string; accountId: string } | null,
  now = new Date(),
) {
  const codeHash = sha256(code);
  return ctx.db.transaction(async (tx) => {
    const [voucher] = await tx.select().from(codes).where(eq(codes.codeHash, codeHash)).for("update");
    if (!voucher) fail(404, "This Anonymo Code was not found.", "code_not_found");
    if (voucher.redeemedAt) fail(409, "This Anonymo Code has already been redeemed.", "code_already_redeemed");

    const secret = key ? null : generateApiKey();
    const minted = secret ? await insertRootKey(tx, ctx.cfg, secret) : null;
    if (minted && !minted.inserted) fail(503, "Could not create a key. Try again.", "key_creation_failed");
    const recipient = (key ?? minted)!;
    const credited = await post(tx, {
      accountId: recipient.accountId, keyHash: recipient.keyHash, amount: usdToPico(voucher.faceUsd),
      kind: "code", ref: `code:${codeHash}`, description: "Anonymo Code",
    });
    if (!credited) fail(409, "This Anonymo Code has already been redeemed.", "code_already_redeemed");

    await tx.update(codes).set({ redeemedBy: recipient.keyHash, redeemedAt: now }).where(eq(codes.codeHash, codeHash));
    return { added_usd: voucher.faceUsd, key_hash: recipient.keyHash, ...(secret ? { key: secret } : {}) };
  });
}
