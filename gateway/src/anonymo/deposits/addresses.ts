// The deposit identifier each key gets, per chain family, and where a deposit to it is credited:
//   evm    — a key commitment, keccak256("anonymo-deposit-v1:" + keyHash). The payer calls
//            DepositRouter.deposit(token, amount, keyCommit) on Base, Arbitrum or Robinhood Chain (same address on all three).
//   solana — a Solana Pay reference account, base58(sha256("anonymo-solana-ref-v1:" + keyHash)), attached read-only to a
//            TransferChecked into the treasury token account.
//   tron   — a unique TRC-20 address per key, derived from the operator's xpub (m/…/0/i). Only the public key is here;
//            sweeping happens off this server.
// The commitment and the reference reveal nothing about the key: both are one-way hashes of its sha256.

import { and, eq, sql } from "drizzle-orm";
import { keccak256, toBytes, type Hex } from "viem";
import { HDKey } from "viem/accounts";
import { createHash } from "node:crypto";
import type { Db } from "../../db/client.ts";
import { anonymoDepositAddresses } from "./schema.ts";
import { base58CheckDecode, base58CheckEncode, base58Encode } from "./base58.ts";

export const evmKeyCommit = (keyHash: string): Hex => keccak256(toBytes(`anonymo-deposit-v1:${keyHash}`));

export const solanaReference = (keyHash: string): string =>
  base58Encode(createHash("sha256").update(`anonymo-solana-ref-v1:${keyHash}`).digest());

// secp256k1: decompress a 33-byte public key so its Tron/EVM address can be computed (keccak of the 64-byte point).
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
function modPow(b: bigint, e: bigint, m: bigint) {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}
function decompress(pub: Uint8Array): Uint8Array {
  if (pub.length !== 33 || (pub[0] !== 2 && pub[0] !== 3)) throw new Error("expected a compressed secp256k1 public key");
  const x = BigInt("0x" + Buffer.from(pub.subarray(1)).toString("hex"));
  let y = modPow((x * x * x + 7n) % P, (P + 1n) / 4n, P);
  if ((y & 1n) !== BigInt(pub[0] & 1)) y = P - y;
  const hex = (n: bigint) => n.toString(16).padStart(64, "0");
  return Buffer.from(hex(x) + hex(y), "hex");
}

/** Tron address (base58check of 0x41 + last 20 bytes of keccak256(uncompressed point)) for a compressed public key. */
export function tronAddressOfPublicKey(pub: Uint8Array): string {
  const h = keccak256(decompress(pub));
  return base58CheckEncode(Buffer.from("41" + h.slice(-40), "hex"));
}

export const isTronAddress = (a: string) => {
  const p = base58CheckDecode(a);
  return !!p && p.length === 21 && p[0] === 0x41;
};

/** The Tron deposit address at `index` under an xpub (external chain 0). */
export function tronAddressAt(xpub: string, index: number): string {
  const child = HDKey.fromExtendedKey(xpub).deriveChild(0).deriveChild(index);
  if (!child.publicKey) throw new Error("xpub derivation gave no public key");
  return tronAddressOfPublicKey(child.publicKey);
}

/** Get or create the key's identifier on one chain family. Tron allocates the next free child index. */
export async function ensureDepositAddress(db: Db, keyHash: string, chain: "evm" | "solana" | "tron", tronXpub?: string): Promise<string> {
  const [have] = await db
    .select({ address: anonymoDepositAddresses.address })
    .from(anonymoDepositAddresses)
    .where(and(eq(anonymoDepositAddresses.keyHash, keyHash), eq(anonymoDepositAddresses.chain, chain)));
  if (have) return have.address;
  if (chain !== "tron") {
    const address = chain === "evm" ? evmKeyCommit(keyHash) : solanaReference(keyHash);
    await db.insert(anonymoDepositAddresses).values({ keyHash, chain, address }).onConflictDoNothing();
    return address;
  }
  if (!tronXpub) throw new Error("Tron deposits need a configured xpub");
  for (let attempt = 0; attempt < 5; attempt++) {
    const [{ next }] = await db
      .select({ next: sql<number>`coalesce(max(${anonymoDepositAddresses.derivationIndex}), -1)::int + 1` })
      .from(anonymoDepositAddresses)
      .where(eq(anonymoDepositAddresses.chain, "tron"));
    const address = tronAddressAt(tronXpub, next);
    const inserted = await db
      .insert(anonymoDepositAddresses)
      .values({ keyHash, chain, address, derivationIndex: next })
      .onConflictDoNothing()
      .returning({ address: anonymoDepositAddresses.address });
    if (inserted.length) return address;
    const [mine] = await db
      .select({ address: anonymoDepositAddresses.address })
      .from(anonymoDepositAddresses)
      .where(and(eq(anonymoDepositAddresses.keyHash, keyHash), eq(anonymoDepositAddresses.chain, chain)));
    if (mine) return mine.address; // a concurrent request for the same key won
  }
  throw new Error("could not allocate a Tron deposit address");
}

/** Which key a chain identifier belongs to, or null. */
export async function keyForDepositAddress(db: Db, chain: "evm" | "solana" | "tron", address: string): Promise<string | null> {
  const [row] = await db
    .select({ keyHash: anonymoDepositAddresses.keyHash })
    .from(anonymoDepositAddresses)
    .where(and(eq(anonymoDepositAddresses.chain, chain), eq(anonymoDepositAddresses.address, chain === "evm" ? address.toLowerCase() : address)));
  return row?.keyHash ?? null;
}
