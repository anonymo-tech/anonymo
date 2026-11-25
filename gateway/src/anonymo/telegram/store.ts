import { and, eq, gt, lte, sql } from "drizzle-orm";
import type { Ctx } from "../../context.ts";
import type { Db, Tx } from "../../db/client.ts";
import { keys } from "../../db/schema.ts";
import { sha256 } from "../../lib/util.ts";
import { tokenHex, telegramDigest } from "./identity.ts";
import { telegramLinks, telegramTokens } from "./schema.ts";

const MINUTE = 60_000;
const expiresIn = (minutes: number) => new Date(Date.now() + minutes * MINUTE);
const active = (now: Date) => gt(telegramTokens.expiresAt, now);

export async function createLinkCode(db: Db, keyHash: string) {
  const code = `tgl_${tokenHex(16)}`;
  await db.insert(telegramTokens).values({ tokenHash: sha256(code), kind: "link", keyHash, expiresAt: expiresIn(5) });
  return code;
}

export function linkedKey(db: Db | Tx, telegramHash: string) {
  return db.select({ key: keys }).from(telegramLinks)
    .innerJoin(keys, eq(keys.keyHash, telegramLinks.keyHash))
    .where(eq(telegramLinks.telegramHash, telegramHash)).then(([row]) =>
      row && !row.key.disabled && (!row.key.expiresAt || row.key.expiresAt > new Date()) ? row.key : null);
}

async function clearAccess(tx: Tx, telegramHash: string) {
  await tx.delete(telegramTokens).where(eq(telegramTokens.telegramHash, telegramHash));
}

export async function linkKey(db: Db, telegramHash: string, code: string) {
  return db.transaction(async (tx) => {
    const [link] = await tx.delete(telegramTokens).where(and(
      eq(telegramTokens.tokenHash, sha256(code)), eq(telegramTokens.kind, "link"), active(new Date()),
    )).returning({ keyHash: telegramTokens.keyHash });
    if (!link?.keyHash) return false;
    const [key] = await tx.select({ hash: keys.keyHash }).from(keys).where(and(
      eq(keys.keyHash, link.keyHash), eq(keys.disabled, false), sql`(${keys.expiresAt} is null or ${keys.expiresAt} > now())`,
    ));
    if (!key) return false;
    await tx.insert(telegramLinks).values({ telegramHash, keyHash: key.hash })
      .onConflictDoUpdate({ target: telegramLinks.telegramHash, set: { keyHash: key.hash } });
    await clearAccess(tx, telegramHash);
    return true;
  });
}

export async function unlinkKey(db: Db, telegramHash: string) {
  await db.transaction(async (tx) => {
    await tx.delete(telegramLinks).where(eq(telegramLinks.telegramHash, telegramHash));
    await clearAccess(tx, telegramHash);
  });
}

export async function createHandoff(db: Db, telegramHash: string) {
  return db.transaction(async (tx) => {
    const [link] = await tx.select().from(telegramLinks).where(eq(telegramLinks.telegramHash, telegramHash)).for("update");
    if (!link || !await linkedKey(tx, telegramHash)) return null;
    const token = tokenHex();
    await tx.insert(telegramTokens).values({
      tokenHash: sha256(token), kind: "handoff", telegramHash, keyHash: link.keyHash, expiresAt: expiresIn(2),
    });
    return token;
  });
}

export async function exchangeHandoff(db: Db, token: string) {
  return db.transaction(async (tx) => {
    // Take the link lock before changing access tokens, in the same order as relinking.
    const [pending] = await tx.select().from(telegramTokens).where(and(
      eq(telegramTokens.tokenHash, sha256(token)), eq(telegramTokens.kind, "handoff"), active(new Date()),
    ));
    if (!pending?.telegramHash || !pending.keyHash) return null;
    const [link] = await tx.select().from(telegramLinks)
      .where(eq(telegramLinks.telegramHash, pending.telegramHash)).for("update");
    if (link?.keyHash !== pending.keyHash || !await linkedKey(tx, link.telegramHash)) return null;
    const [used] = await tx.delete(telegramTokens).where(and(
      eq(telegramTokens.tokenHash, pending.tokenHash), active(new Date()),
    )).returning({ tokenHash: telegramTokens.tokenHash });
    if (!used) return null;
    const key = `anm_tg_${tokenHex()}`;
    const expiresAt = expiresIn(60);
    await tx.insert(telegramTokens).values({
      tokenHash: sha256(key), kind: "session", telegramHash: link.telegramHash, keyHash: link.keyHash, expiresAt,
    });
    return { key, key_hash: link.keyHash, expires_at: expiresAt.toISOString() };
  });
}

export async function resolveTelegramKey(db: Db, secret: string) {
  const [row] = await db.select({ key: keys }).from(telegramTokens)
    .innerJoin(telegramLinks, and(eq(telegramLinks.telegramHash, telegramTokens.telegramHash),
      eq(telegramLinks.keyHash, telegramTokens.keyHash)))
    .innerJoin(keys, eq(keys.keyHash, telegramLinks.keyHash))
    .where(and(eq(telegramTokens.tokenHash, sha256(secret)), eq(telegramTokens.kind, "session"), active(new Date())));
  if (!row || row.key.disabled || (row.key.expiresAt && row.key.expiresAt <= new Date())) return null;
  return { ...row.key, management: false, tracing: null, routing: null };
}

const trialToken = (salt: string, telegramHash: string) => telegramDigest(salt, "bot-trial", telegramHash);

export async function armTrial(ctx: Ctx, salt: string, telegramHash: string, proof: string, expiresAt: Date) {
  await ctx.db.insert(telegramTokens).values({
    tokenHash: trialToken(salt, telegramHash), kind: "trial", telegramHash, proof, expiresAt,
  }).onConflictDoUpdate({ target: telegramTokens.tokenHash, set: { proof, expiresAt } });
}

export async function takeTrial(ctx: Ctx, salt: string, telegramHash: string) {
  const [row] = await ctx.db.delete(telegramTokens).where(and(
    eq(telegramTokens.tokenHash, trialToken(salt, telegramHash)), eq(telegramTokens.kind, "trial"), active(new Date()),
  )).returning({ proof: telegramTokens.proof });
  return row?.proof ?? null;
}

export async function purgeTelegramTokens(db: Db) {
  return db.delete(telegramTokens).where(lte(telegramTokens.expiresAt, new Date()));
}
