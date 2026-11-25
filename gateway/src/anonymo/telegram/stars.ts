import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { keys } from "../../db/schema.ts";
import { post } from "../../ledger/ledger.ts";
import { starsOrders } from "./schema.ts";

export type StarsPack = { stars: number; credit: bigint };
type Quote = StarsPack & { keyHash: string; expires: number };

const algorithm = "aes-256-gcm";
const invoiceKey = (salt: string) => createHmac("sha256", salt).update("telegram-stars-invoice-v1").digest();

export function issueInvoice(salt: string, telegramHash: string, keyHash: string, pack: StarsPack) {
  // Telegram limits payloads to 128 bytes. Bind the quote to the payer and hide the key hash.
  const data = Buffer.alloc(48);
  Buffer.from(keyHash, "hex").copy(data);
  data.writeUInt32BE(pack.stars, 32);
  data.writeBigUInt64BE(pack.credit, 36);
  data.writeUInt32BE(Math.floor(Date.now() / 1000) + 30 * 60, 44);
  const nonce = randomBytes(12);
  const cipher = createCipheriv(algorithm, invoiceKey(salt), nonce);
  cipher.setAAD(Buffer.from(telegramHash, "hex"));
  return Buffer.concat([nonce, cipher.update(data), cipher.final(), cipher.getAuthTag()]).toString("base64url");
}

export function readInvoice(salt: string, telegramHash: string, payload: string): Quote | null {
  if (!/^[A-Za-z0-9_-]{102}$/.test(payload)) return null;
  const raw = Buffer.from(payload, "base64url");
  try {
    const cipher = createDecipheriv(algorithm, invoiceKey(salt), raw.subarray(0, 12));
    cipher.setAAD(Buffer.from(telegramHash, "hex"));
    cipher.setAuthTag(raw.subarray(60));
    const data = Buffer.concat([cipher.update(raw.subarray(12, 60)), cipher.final()]);
    return { keyHash: data.subarray(0, 32).toString("hex"), stars: data.readUInt32BE(32),
      credit: data.readBigUInt64BE(36), expires: data.readUInt32BE(44) };
  } catch {
    return null;
  }
}

export async function recordStars(db: Db, chargeId: string, quote: Quote, refund: boolean) {
  return db.transaction(async (tx) => {
    const [recipient] = await tx.select({ accountId: keys.accountId }).from(keys).where(eq(keys.keyHash, quote.keyHash));
    if (!recipient) throw new Error("Stars recipient unavailable");
    const now = new Date();
    const [inserted] = await tx.insert(starsOrders).values({
      chargeId, keyHash: quote.keyHash, stars: quote.stars, creditedPico: refund ? 0n : quote.credit, refundedAt: refund ? now : null,
    }).onConflictDoNothing().returning({ chargeId: starsOrders.chargeId });
    if (inserted && refund) return "refunded"; // A refund may arrive before its payment update.
    if (!inserted && !refund) return "duplicate";
    const amount = refund ? await tx.update(starsOrders).set({ refundedAt: now })
      .where(and(eq(starsOrders.chargeId, chargeId), eq(starsOrders.keyHash, quote.keyHash),
        eq(starsOrders.stars, quote.stars), eq(starsOrders.creditedPico, quote.credit), isNull(starsOrders.refundedAt)))
      .returning({ credited: starsOrders.creditedPico }).then(([row]) => row ? -row.credited : 0n)
      : quote.credit;
    if (amount === 0n) return "duplicate";
    const posted = await post(tx, {
      ...recipient, keyHash: quote.keyHash, amount, kind: refund ? "stars_refund" : "stars_credit",
      ref: `stars:${refund ? "refund" : "payment"}:${chargeId}`, description: refund ? "Telegram Stars refund" : "Telegram Stars top-up",
    });
    if (!posted) throw new Error("Stars ledger reference already used");
    return refund ? "refunded" : "credited";
  });
}
