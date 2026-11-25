import { and, eq, sql } from "drizzle-orm";
import { recoverMessageAddress, type Hex } from "viem";
import type { Ctx } from "../context.ts";
import type { Config } from "../config.ts";
import type { Tx } from "../db/client.ts";
import { accounts, chainEvents, keys } from "../db/schema.ts";
import { deriveKey, KEY_RE } from "../chain/keys.ts";
import { fail } from "../lib/errors.ts";
import { ensureAccount } from "../ledger/ledger.ts";
import { sha256 } from "../lib/util.ts";
import { processEvents } from "../chain/indexer.ts";

export type KeyRow = typeof keys.$inferSelect;
/**
 * Team roles. owner > admin > dev > viewer; agent is API-only. `member` is the older default for a key in a team: it may call
 * the API and read settings. A management key acts as owner. See roleAllowed for how the newer roles map onto route lists.
 */
export type Role = "owner" | "admin" | "dev" | "member" | "viewer" | "agent";
export const ROLE_RANK: Record<Role, number> = { agent: 0, viewer: 0, member: 1, dev: 1, admin: 2, owner: 3 };

/**
 * Whether `role` may use a route that allows `allowed`. Route lists predate dev and agent, so: a dev may do what a member or a
 * viewer may (call the API, read settings and usage, plus create keys where a route lists dev); an agent may only use routes
 * that make calls (they list member but not viewer), never the ones that read or manage the account.
 */
export function roleAllowed(role: Role, allowed: readonly Role[]) {
  if (allowed.includes(role)) return true;
  if (role === "dev") return allowed.includes("member") || allowed.includes("viewer");
  if (role === "agent") return allowed.includes("member") && !allowed.includes("viewer");
  return false;
}

export const accountIdFor = (chainKeyHash: string) => `k_${chainKeyHash.slice(2, 34)}`;
export const walletAccountId = (address: string) => `w_${address.toLowerCase().slice(2)}`;

export function bearer(header: string | undefined | null) {
  const m = header?.match(/^Bearer\s+(\S+)$/i);
  return m?.[1] ?? null;
}

/** Provision a root key in the caller's transaction. Fresh voucher keys are credited before becoming visible. */
export async function insertRootKey(tx: Tx, cfg: Pick<Config, "limits">, secret: string, name = "") {
  const d = deriveKey(secret);
  const accountId = accountIdFor(d.chainKeyHash);
  await ensureAccount(tx, accountId, "key");
  const inserted = await tx
    .insert(keys)
    .values({
      keyHash: d.keyHash,
      chainKeyHash: d.chainKeyHash,
      keyAddress: d.keyAddress,
      accountId,
      name,
      label: d.label,
      management: true,
      rpm: cfg.limits.defaultRpm || null,
      tpm: cfg.limits.defaultTpm || null,
    })
    .onConflictDoNothing()
    .returning({ keyHash: keys.keyHash });
  return { accountId, keyHash: d.keyHash, chainKeyHash: d.chainKeyHash, inserted: inserted.length > 0 };
}

/** Register a root key (its own account). Idempotent. Claims any deposits already made to it. */
export async function registerRootKey(ctx: Ctx, secret: string, name = "") {
  const { chainKeyHash, keyHash } = await ctx.db.transaction((tx) => insertRootKey(tx, ctx.cfg, secret, name));
  await processEvents(ctx, { chainKeyHash });
  const [row] = await ctx.db.select().from(keys).where(eq(keys.keyHash, keyHash));
  return row;
}

/** Look up a presented API key. Unknown but well-formed keys that already have on-chain deposits
 *  are registered on the spot: deposit first, call immediately, no account needed. */
export async function resolveKey(ctx: Ctx, secret: string): Promise<KeyRow | null> {
  if (!KEY_RE.test(secret)) return null;
  const keyHash = sha256(secret);
  const [row] = await ctx.db.select().from(keys).where(eq(keys.keyHash, keyHash));
  if (row) {
    if (row.disabled) fail(401, "This API key is disabled.", "key_disabled");
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) fail(401, "This API key has expired.", "key_expired");
    return row;
  }
  const d = deriveKey(secret);
  const pending = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(chainEvents)
    .where(and(eq(chainEvents.processed, false), sql`${chainEvents.args}->>'keyHash' = ${d.chainKeyHash}`));
  if (!pending[0]?.n) return null;
  return registerRootKey(ctx, secret);
}

export async function requireKey(ctx: Ctx, authorization: string | undefined | null) {
  const secret = bearer(authorization);
  if (!secret) fail(401, "Provide an API key as `Authorization: Bearer anm_live_...`.", "missing_key");
  const key = await resolveKey(ctx, secret);
  if (!key) fail(401, "Unknown API key. Create one (POST /api/v1/keys) or deposit USDG to its key hash first.", "invalid_key");
  return key;
}

/** A management key acts as owner; every other key is a member of its own account (there are no teams). */
export async function roleOf(_ctx: Ctx, key: KeyRow): Promise<Role> {
  return key.management ? "owner" : "member";
}

export async function requireRole(ctx: Ctx, key: KeyRow, allowed: Role[]) {
  const role = await roleOf(ctx, key);
  if (!roleAllowed(role, allowed)) fail(403, `This key's role (${role}) cannot do that.`, "forbidden");
  return role;
}

// Wallet authentication for per-call payers spending their change balance:
//   X-Wallet-Auth: <address>:<unixSeconds>:<signature>
// where signature = personal_sign("anonymo:<unixSeconds>:<sha256(request body)>").
// Replay protection keys on what the signature authorizes (address, timestamp, body) — not on the
// signature bytes, which can be re-encoded (v 27/28 vs 0/1, high-s) to recover the same address.
// Shared across replicas through Redis when configured (SET NX), else per process.
const seen = new Map<string, number>();
async function firstUse(ctx: Ctx, id: string) {
  const redis = (ctx.cache as unknown as { redis?: import("ioredis").Redis }).redis;
  if (redis) return (await redis.set(`walletauth:${id}`, "1", "PX", 600_000, "NX")) === "OK";
  if (seen.has(id)) return false;
  seen.set(id, Date.now());
  if (seen.size > 50_000) for (const [k, t] of seen) if (Date.now() - t > 600_000) seen.delete(k);
  return true;
}
/** X-Wallet-Auth signs `${WALLET_AUTH_PREFIX}:<unixSeconds>:<sha256 of the body>` (EIP-191 personal_sign). */
export const WALLET_AUTH_PREFIX = "anonymo";
const LEGACY_WALLET_AUTH_PREFIX = "anonymo";
export async function walletAuth(ctx: Ctx, header: string, bodySha: string) {
  const [address, ts, sig] = header.split(":");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "") || !/^\d+$/.test(ts ?? "") || !/^0x[0-9a-fA-F]+$/.test(sig ?? ""))
    fail(401, "X-Wallet-Auth must be <address>:<unixSeconds>:<signature>.", "invalid_wallet_auth");
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (age > 300) fail(401, "X-Wallet-Auth timestamp is outside the 5-minute window.", "invalid_wallet_auth");
  // The signed message is `anonymo:<ts>:<bodySha>`; `anonymo:` (before the WS01 rename) is accepted for one release.
  // Either way the replay guard below is keyed on address, timestamp and body, so one signature is usable once.
  const signer = async (prefix: string) => (await recoverMessageAddress({ message: `${prefix}:${ts}:${bodySha}`, signature: sig as Hex }).catch(() => null))?.toLowerCase();
  const matches = async (prefix: string) => (await signer(prefix)) === address!.toLowerCase();
  if (!(await matches(WALLET_AUTH_PREFIX)) && !(await matches(LEGACY_WALLET_AUTH_PREFIX))) fail(401, "X-Wallet-Auth signature does not match the address.", "invalid_wallet_auth");
  if (!(await firstUse(ctx, sha256(`${address!.toLowerCase()}|${ts}|${bodySha}`)))) fail(401, "X-Wallet-Auth signature was already used.", "invalid_wallet_auth");
  const accountId = walletAccountId(address!);
  const [acct] = await ctx.db.select().from(accounts).where(eq(accounts.id, accountId));
  return { accountId, wallet: address!.toLowerCase(), exists: !!acct };
}
