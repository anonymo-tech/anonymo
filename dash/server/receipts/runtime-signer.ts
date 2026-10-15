import { createHmac } from "node:crypto";
import type { Pool } from "pg";
import { receiptPublicKey } from "./index.ts";
import { receiptTrustFromValues, type ReceiptSigner } from "./service.ts";
import { requireCondition } from "../core/errors.ts";
const WEEK = 7 * 24 * 60 * 60 * 1000;
export function weeklySigner(master: string, at = Date.now()) {
  requireCondition(
    /^[a-f0-9]{64}$/.test(master),
    503,
    "RECEIPT_SIGNER_UNAVAILABLE",
    "Receipt signing is unavailable.",
  );
  const epoch = Math.floor(at / WEEK),
    seed = new Uint8Array(
      createHmac("sha256", Buffer.from(master, "hex"))
        .update(`conclave-receipt-v1:${epoch}`)
        .digest(),
    );
  const record = {
    keyId: "conclave-usage-v1",
    epoch,
    publicKey: receiptPublicKey(seed),
    validFrom: new Date(epoch * WEEK).toISOString(),
    validUntil: new Date((epoch + 1) * WEEK).toISOString(),
    revoked: false,
  };
  return { seed, record };
}
export async function runtimeSigner(pool: Pool): Promise<ReceiptSigner> {
  const { seed, record } = weeklySigner(process.env.CONCLAVE_RECEIPT_MASTER_SEED_HEX ?? "");
  await pool.query(
    "INSERT INTO receipt_signer_keys(key_id,epoch,public_key,valid_from,valid_until) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [record.keyId, record.epoch, record.publicKey, record.validFrom, record.validUntil],
  );
  const trust = receiptTrustFromValues(await publicSignerKeys(pool));
  requireCondition(
    trust.get(`${record.keyId}#${record.epoch}`)?.publicKey === record.publicKey,
    503,
    "RECEIPT_SIGNER_UNAVAILABLE",
    "Receipt signing is unavailable.",
  );
  return { keyId: record.keyId, epoch: record.epoch, seed, trust };
}
export async function publicSignerKeys(pool: Pool) {
  const r = await pool.query(
    'SELECT key_id AS "keyId",epoch,public_key AS "publicKey",valid_from AS "validFrom",valid_until AS "validUntil",revoked FROM receipt_signer_keys ORDER BY epoch DESC LIMIT 128',
  );
  return r.rows.map((r) => ({
    ...r,
    validFrom: r.validFrom.toISOString(),
    validUntil: r.validUntil.toISOString(),
  }));
}
