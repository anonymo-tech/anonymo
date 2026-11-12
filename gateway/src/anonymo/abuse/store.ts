// Abuse inbox storage: takedown reports, the hash block list and the preservation vault.

import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { Db } from "../../db/client.ts";
import { decrypt, encrypt } from "../../lib/util.ts";
import type { FloorCategory } from "../seams.ts";
import type { HashBlocklist } from "../floor/uploads.ts";
import type { FloorHitRecord } from "../floor/hits.ts";
import { abuseHashBlocks, abuseReports, preservation } from "./schema.ts";
import type { CyberTiplineReporter } from "./tipline.ts";

export const TAKEDOWN_WINDOW_MS = 48 * 3_600_000;
export const PRESERVATION_MS = 365 * 86_400_000;
export const CLOSED_REPORT_RETENTION_MS = 365 * 86_400_000;

export type ReportKind = "ncii" | "csam" | "other";
const KIND_CATEGORY: Record<Exclude<ReportKind, "other">, FloorCategory> = { ncii: "real_person", csam: "minor" };

// Separate keys per use, derived from the app secret (util.encrypt hashes the secret with its own domain prefix).
const abuseKey = (appSecret: string) => `anonymo:abuse:${appSecret}`;
const preservationKey = (appSecret: string) => `anonymo:preservation:${appSecret}`;
const id = (prefix: string) => prefix + randomBytes(12).toString("hex");

export const dbHashBlocklist = (db: Db): HashBlocklist => ({
  async lookup(sha256) {
    const [row] = await db.select({ category: abuseHashBlocks.category }).from(abuseHashBlocks).where(eq(abuseHashBlocks.sha256, sha256)).limit(1);
    return (row?.category as FloorCategory | undefined) ?? null;
  },
});

export async function blockHashes(db: Db, hashes: string[], category: FloorCategory, source: "takedown" | "report" | "operator", reportId: string | null) {
  if (!hashes.length) return 0;
  const rows = await db
    .insert(abuseHashBlocks)
    .values(hashes.map((sha256) => ({ sha256, category, source, reportId })))
    .onConflictDoNothing()
    .returning({ sha256: abuseHashBlocks.sha256 });
  return rows.length;
}

export async function createTakedown(
  db: Db,
  appSecret: string,
  input: { kind: ReportKind; contentHashes: string[]; reference: string | null; details: string | null; contact: string | null },
  now = Date.now(),
) {
  const row = {
    id: id("tkd_"),
    kind: input.kind,
    reference: input.reference,
    contentHashes: [...new Set(input.contentHashes)],
    detailsEnc: input.details ? encrypt(abuseKey(appSecret), input.details) : null,
    contactEnc: input.contact ? encrypt(abuseKey(appSecret), input.contact) : null,
    receivedAt: new Date(now),
    dueAt: new Date(now + TAKEDOWN_WINDOW_MS),
  };
  await db.insert(abuseReports).values(row);
  return { id: row.id, dueAt: row.dueAt };
}

export async function takedownStatus(db: Db, reportId: string) {
  const [row] = await db
    .select({ id: abuseReports.id, status: abuseReports.status, receivedAt: abuseReports.receivedAt, dueAt: abuseReports.dueAt, actionedAt: abuseReports.actionedAt })
    .from(abuseReports)
    .where(eq(abuseReports.id, reportId))
    .limit(1);
  return row ?? null;
}

/** Open reports, oldest deadline first, with the operator's view of the details (decrypted). */
export async function openTakedowns(db: Db, appSecret: string, now = Date.now()) {
  const rows = await db.select().from(abuseReports).where(eq(abuseReports.status, "open")).orderBy(asc(abuseReports.dueAt)).limit(500);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as ReportKind,
    reference: r.reference,
    content_hashes: r.contentHashes,
    details: r.detailsEnc ? decrypt(abuseKey(appSecret), r.detailsEnc) : null,
    contact: r.contactEnc ? decrypt(abuseKey(appSecret), r.contactEnc) : null,
    received_at: r.receivedAt.toISOString(),
    due_at: r.dueAt.toISOString(),
    overdue: r.dueAt.getTime() < now,
  }));
}

export class AbuseFlowError extends Error {
  constructor(
    public status: 404 | 409 | 422,
    message: string,
  ) {
    super(message);
  }
}

/** Act on an open takedown: block its hashes, report it (CSAM: block, file with CyberTipline, preserve), or reject. */
export async function actOnTakedown(
  db: Db,
  appSecret: string,
  reporter: CyberTiplineReporter,
  reportId: string,
  action: "block" | "report" | "reject",
  opts: { category?: FloorCategory; now?: number } = {},
) {
  const now = opts.now ?? Date.now();
  const [r] = await db.select().from(abuseReports).where(eq(abuseReports.id, reportId)).limit(1);
  if (!r) throw new AbuseFlowError(404, "No such report.");
  if (r.status !== "open") throw new AbuseFlowError(409, "This report was already handled.");
  const kind = r.kind as ReportKind;
  if (action === "reject") {
    await db.update(abuseReports).set({ status: "rejected", action: "rejected", actionedAt: new Date(now) }).where(eq(abuseReports.id, reportId));
    return { action: "rejected" as const, blocked: 0, tipline: null };
  }
  if (action === "report" && kind !== "csam") throw new AbuseFlowError(422, "Only child-safety reports go to CyberTipline; use block.");
  const category = kind === "other" ? opts.category : KIND_CATEGORY[kind];
  if (!category) throw new AbuseFlowError(422, "Give a category to block an 'other' report under.");
  const blocked = await blockHashes(db, r.contentHashes, category, "takedown", reportId);
  let tipline: { reportId: string; filed: boolean } | null = null;
  if (action === "report") {
    tipline = await reporter.file({ source: "takedown", sourceId: r.id, category, observedAt: r.receivedAt.toISOString(), contentHashes: r.contentHashes, reference: r.reference });
    const details = r.detailsEnc ? decrypt(abuseKey(appSecret), r.detailsEnc) : null;
    await preserve(db, appSecret, { source: "takedown", sourceId: r.id, category, tiplineReportId: tipline.reportId, record: { kind, reference: r.reference, contentHashes: r.contentHashes, details, receivedAt: r.receivedAt.toISOString() } }, now);
  }
  await db
    .update(abuseReports)
    .set({ status: "actioned", action: action === "report" ? "reported" : "blocked", actionedAt: new Date(now), tiplineReportId: tipline?.reportId ?? null })
    .where(eq(abuseReports.id, reportId));
  return { action: action === "report" ? ("reported" as const) : ("blocked" as const), blocked, tipline };
}

/** Report a pending floor hit: file it, and move its minimal record into the preservation vault for one year. */
export async function reportFloorHit(db: Db, appSecret: string, reporter: CyberTiplineReporter, hit: FloorHitRecord, now = Date.now()) {
  const tipline = await reporter.file({ source: "floor_hit", sourceId: hit.id, category: hit.category, observedAt: hit.at, contentHashes: [hit.textSha256], reference: null });
  const preservationId = await preserve(db, appSecret, { source: "floor_hit", sourceId: hit.id, category: hit.category, tiplineReportId: tipline.reportId, record: hit }, now);
  return { tipline, preservationId };
}

async function preserve(
  db: Db,
  appSecret: string,
  p: { source: "floor_hit" | "takedown"; sourceId: string; category: FloorCategory; tiplineReportId: string; record: unknown },
  now: number,
) {
  const pid = id("pv_");
  await db.insert(preservation).values({
    id: pid,
    source: p.source,
    sourceId: p.sourceId,
    category: p.category,
    tiplineReportId: p.tiplineReportId,
    blobEnc: encrypt(preservationKey(appSecret), JSON.stringify(p.record)),
    createdAt: new Date(now),
    expiresAt: new Date(now + PRESERVATION_MS),
  });
  return pid;
}

/** Operator read of a preserved record (for a law-enforcement request). */
export async function readPreserved(db: Db, appSecret: string, preservationId: string) {
  const [row] = await db.select().from(preservation).where(eq(preservation.id, preservationId)).limit(1);
  if (!row) return null;
  return { id: row.id, source: row.source, category: row.category, tipline_report_id: row.tiplineReportId, expires_at: row.expiresAt.toISOString(), record: JSON.parse(decrypt(preservationKey(appSecret), row.blobEnc)) as unknown };
}

/** Drop preserved records past their year, and closed reports older than their retention. */
export async function purgeExpired(db: Db, now = Date.now()) {
  const vault = await db.delete(preservation).where(lt(preservation.expiresAt, new Date(now))).returning({ id: preservation.id });
  const reports = await db
    .delete(abuseReports)
    .where(and(inArray(abuseReports.status, ["actioned", "rejected"]), lt(abuseReports.actionedAt, new Date(now - CLOSED_REPORT_RETENTION_MS))))
    .returning({ id: abuseReports.id });
  return { preservation: vault.length, reports: reports.length };
}
