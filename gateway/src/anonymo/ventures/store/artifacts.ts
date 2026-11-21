// WS11 · artifact store with zones (Ventures Backend PART 3 and PART 12).
//
// Every artifact is content-addressed (sha256 of its bytes) and stamped SCOUT or CLEAN. A read names the zone of the
// step that reads it: a CLEAN reader asking for a SCOUT artifact gets a ZoneViolation, never the bytes (Law 1). The
// sandbox mount table checks the same rule again (sandbox/policy.ts checkMounts). Postgres keeps only the hash, kind,
// zone and size; the body is encrypted in the artifact store (store/bodies.ts). purgeArtifacts() deletes bodies older
// than 30 days and keeps the hashes.

import { createHash } from "node:crypto";
import { and, eq, isNull, lt } from "drizzle-orm";
import type { Db } from "../../../db/client.ts";
import type { ArtifactKind, ArtifactRef, Zone } from "../types.ts";
import { bodiesFor } from "./bodies.ts";
import { ventureArtifacts, ventures } from "./schema.ts";

export const RETENTION_DAYS = 30;

export class ZoneViolation extends Error {
  constructor(readonly ref: ArtifactRef, readonly readerZone: Zone) {
    super(`a ${readerZone} step may not read ${ref.zone} artifact ${ref.sha256.slice(0, 12)}… (${ref.kind})`);
  }
}

export const sha256Hex = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

const BINARY_SUFFIX = ";binary";

export type PutInput = { kind: ArtifactKind; zone: Zone; name?: string; mime?: string; body: Uint8Array | string };

export async function putArtifact(db: Db, ventureId: string, a: PutInput): Promise<ArtifactRef> {
  const bytes = typeof a.body === "string" ? new TextEncoder().encode(a.body) : a.body;
  const sha = sha256Hex(bytes);
  const binary = typeof a.body !== "string";
  const [have] = await db.select({ zone: ventureArtifacts.zone, purgedAt: ventureArtifacts.purgedAt }).from(ventureArtifacts).where(and(eq(ventureArtifacts.ventureId, ventureId), eq(ventureArtifacts.sha256, sha)));
  // The same bytes may already be stored (possibly in the other zone); the stored row's zone is what counts.
  if (have && !have.purgedAt) return { sha256: sha, kind: a.kind, zone: have.zone as Zone, ...(a.name ? { name: a.name } : {}) };
  const key = await bodiesFor(db).put(ventureId, sha, bytes);
  await db
    .insert(ventureArtifacts)
    .values({ ventureId, sha256: sha, kind: a.kind, zone: a.zone, name: a.name ?? null, mime: (a.mime ?? (binary ? "application/octet-stream" : "text/plain")) + (binary ? BINARY_SUFFIX : ""), size: bytes.byteLength, s3Key: key })
    .onConflictDoNothing();
  return { sha256: sha, kind: a.kind, zone: (have?.zone as Zone) ?? a.zone, ...(a.name ? { name: a.name } : {}) };
}

export type StoredArtifact = { ref: ArtifactRef; mime: string; size: number; body: string | Uint8Array | null; purged: boolean };

/** Reads an artifact as a step of `readerZone`. CLEAN readers can never get SCOUT bytes. */
export async function getArtifact(db: Db, ventureId: string, sha: string, readerZone: Zone): Promise<StoredArtifact | null> {
  const [row] = await db.select().from(ventureArtifacts).where(and(eq(ventureArtifacts.ventureId, ventureId), eq(ventureArtifacts.sha256, sha)));
  if (!row) return null;
  const ref: ArtifactRef = { sha256: row.sha256, kind: row.kind as ArtifactKind, zone: row.zone as Zone, ...(row.name ? { name: row.name } : {}) };
  if (readerZone === "CLEAN" && ref.zone === "SCOUT") throw new ZoneViolation(ref, readerZone);
  const binary = row.mime?.endsWith(BINARY_SUFFIX) ?? false;
  const mime = binary ? row.mime!.slice(0, -BINARY_SUFFIX.length) : (row.mime ?? "text/plain");
  const bytes = row.purgedAt || !row.s3Key ? null : await bodiesFor(db).get(ventureId, row.s3Key);
  const body = bytes === null ? null : binary ? bytes : new TextDecoder().decode(bytes);
  return { ref, mime, size: row.size, body, purged: bytes === null };
}

export async function getText(db: Db, ventureId: string, ref: Pick<ArtifactRef, "sha256">, readerZone: Zone): Promise<string> {
  const a = await getArtifact(db, ventureId, ref.sha256, readerZone);
  if (!a || a.body === null) throw new Error(`artifact ${ref.sha256.slice(0, 12)}… is gone (bodies are deleted after ${RETENTION_DAYS} days)`);
  return typeof a.body === "string" ? a.body : new TextDecoder().decode(a.body);
}

export async function getJson<T>(db: Db, ventureId: string, ref: Pick<ArtifactRef, "sha256">, readerZone: Zone): Promise<T> {
  return JSON.parse(await getText(db, ventureId, ref, readerZone)) as T;
}

/** getJson, or null when the artifact is missing or purged. */
export async function tryJson<T>(db: Db, ventureId: string, sha: string | null | undefined, readerZone: Zone): Promise<T | null> {
  if (!sha) return null;
  try {
    return await getJson<T>(db, ventureId, { sha256: sha }, readerZone);
  } catch {
    return null;
  }
}

export async function listArtifacts(db: Db, ventureId: string) {
  const rows = await db.select().from(ventureArtifacts).where(eq(ventureArtifacts.ventureId, ventureId));
  return rows.map((r) => ({ sha256: r.sha256, kind: r.kind, zone: r.zone, name: r.name, mime: r.mime?.replace(BINARY_SUFFIX, "") ?? null, size: r.size, createdAt: r.createdAt, purged: !!r.purgedAt }));
}

/** Deletes artifact bodies older than the retention window from the artifact store; hashes stay. */
export async function purgeArtifacts(db: Db, now = new Date()): Promise<{ artifacts: number; ventures: number }> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
  const old = await db.select().from(ventureArtifacts).where(and(lt(ventureArtifacts.createdAt, cutoff), isNull(ventureArtifacts.purgedAt)));
  for (const a of old) {
    if (a.s3Key) await bodiesFor(db).delete(a.ventureId, a.s3Key);
    await db.update(ventureArtifacts).set({ purgedAt: now }).where(and(eq(ventureArtifacts.ventureId, a.ventureId), eq(ventureArtifacts.sha256, a.sha256)));
  }
  const v = await db.update(ventures).set({ purgedAt: now }).where(and(lt(ventures.createdAt, cutoff), isNull(ventures.purgedAt))).returning({ id: ventures.id });
  return { artifacts: old.length, ventures: v.length };
}
