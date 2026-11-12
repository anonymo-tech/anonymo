// Sign-In with Ethereum (EIP-4361) for wallet-minted keys. The server issues a one-time nonce; the wallet signs a SIWE
// message for our domain with it; we check domain, nonce, time window and the signature, then mint a key bound to that
// wallet. Nonces are single-use (deleted on use) and expire after ten minutes. Only the wallet address is kept.

import { and, eq, like, lt } from "drizzle-orm";
import { recoverMessageAddress, type Hex } from "viem";
import { generateSiweNonce, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import type { Db } from "../../db/client.ts";
import { kv } from "../../db/schema.ts";
import { fail } from "../../lib/errors.ts";

const TTL_MS = 10 * 60_000;
const nonceKey = (n: string) => `anonymo:siwe:${n}`;

export async function issueSiweNonce(db: Db, now = new Date()) {
  await db.delete(kv).where(and(like(kv.key, "anonymo:siwe:%"), lt(kv.updatedAt, new Date(now.getTime() - TTL_MS))));
  const nonce = generateSiweNonce();
  await db.insert(kv).values({ key: nonceKey(nonce), value: { issued_at: now.toISOString() }, updatedAt: now });
  return { nonce, expires_at: new Date(now.getTime() + TTL_MS).toISOString() };
}

/** Verify a signed SIWE message for `domain`; consumes its nonce. Returns the lowercase wallet address. */
export async function verifySiwe(db: Db, o: { domain: string; message: string; signature: string; now?: Date }): Promise<string> {
  const now = o.now ?? new Date();
  if (typeof o.message !== "string" || o.message.length > 4096 || !/^0x[0-9a-fA-F]{130}$/.test(o.signature ?? "")) fail(400, "Send the SIWE `message` and its 65-byte `signature`.", "invalid_siwe");
  const parsed = parseSiweMessage(o.message);
  if (!parsed.address || !parsed.nonce || !parsed.domain || parsed.version !== "1" || !parsed.issuedAt) fail(400, "The SIWE message is incomplete (address, domain, nonce, version 1 and issued-at are required).", "invalid_siwe");
  if (Math.abs(now.getTime() - parsed.issuedAt.getTime()) > TTL_MS) fail(401, "The SIWE message is too old or from the future.", "invalid_siwe");
  if (!validateSiweMessage({ message: parsed, domain: o.domain, nonce: parsed.nonce, time: now })) fail(401, "The SIWE message is not for this site, or it has expired.", "invalid_siwe");
  const recovered = await recoverMessageAddress({ message: o.message, signature: o.signature as Hex }).catch(() => null);
  if (!recovered || recovered.toLowerCase() !== parsed.address.toLowerCase()) fail(401, "The SIWE signature does not match the address in the message.", "invalid_siwe");
  // Consume the nonce last, so a malformed attempt cannot burn someone else's nonce; exactly one use succeeds.
  const used = await db.delete(kv).where(and(eq(kv.key, nonceKey(parsed.nonce)), lt(kv.updatedAt, new Date(now.getTime() + 1)))).returning({ updatedAt: kv.updatedAt });
  if (!used.length || now.getTime() - used[0].updatedAt.getTime() > TTL_MS) fail(401, "Unknown, used or expired SIWE nonce. Ask for a new one.", "invalid_siwe");
  return parsed.address.toLowerCase();
}
