// The existing job row is also the per-account claim. Only completed jobs permanently consume
// it. Daily pools also cover renders the provider may have charged for, including locally blocked output.
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db, Tx } from "../../db/client.ts";
import { accounts, holds, kv } from "../../db/schema.ts";
import { release } from "../../ledger/ledger.ts";
import { fail } from "../../lib/errors.ts";
import { usdToPico, type Pico } from "../../lib/money.ts";
import { mediaJobs } from "./schema.ts";

export const MAX_FIRST_VIDEO_PRICE = usdToPico("0.75");
export const FIRST_VIDEO_DAILY_BUDGET = usdToPico("10");
export const FIRST_VIDEO_PREFIX = "vid_w_";
export const COMP_VIDEO_PREFIX = "vid_c_";
export const isSponsoredVideo = (id: string) => id.startsWith(FIRST_VIDEO_PREFIX) || id.startsWith(COMP_VIDEO_PREFIX);
export type CompVideoAllowance = { keyCommit: string; dailyBudget: Pico };

/** Only the public deposit commitment is accepted, never the API key itself. Invalid config fails closed. */
export function compVideoConfig(env: Record<string, string | undefined>): CompVideoAllowance | undefined {
  const commit = env.ANONYMO_VIDEO_COMP_KEY_COMMIT?.trim().toLowerCase();
  const usd = env.ANONYMO_VIDEO_COMP_DAILY_USD?.trim() ?? "0.24";
  if (!commit && env.ANONYMO_VIDEO_COMP_DAILY_USD === undefined) return;
  if (!commit || !/^0x[0-9a-f]{64}$/.test(commit)) throw new Error("ANONYMO_VIDEO_COMP_KEY_COMMIT requires a full public EVM key commitment.");
  if (!/^\d{1,7}(?:\.\d{1,12})?$/.test(usd)) throw new Error("ANONYMO_VIDEO_COMP_DAILY_USD requires a nonnegative USD amount with up to 12 decimal places.");
  const dailyBudget = usdToPico(usd);
  if (dailyBudget > 9_223_372_036_854_775_807n - MAX_FIRST_VIDEO_PRICE) throw new Error("ANONYMO_VIDEO_COMP_DAILY_USD exceeds the supported budget.");
  return { keyCommit: commit, dailyBudget };
}
const sponsored = sql`starts_with(${mediaJobs.id}, ${FIRST_VIDEO_PREFIX})`;
const complimentary = sql`starts_with(${mediaJobs.id}, ${COMP_VIDEO_PREFIX})`;
const dailySlot = (comp: boolean) => sql<string>`${comp ? "complimentary-video:v1:daily:" : "first-video:v1:daily:"}::text || to_char(timezone('UTC', now()), 'YYYY-MM-DD')`;
const pending = ["queued", "running", "finishing"];
const blockingClaim = (account: string, comp: boolean) => and(comp ? complimentary : sponsored, eq(mediaJobs.accountId, account),
  inArray(mediaJobs.status, comp ? pending : [...pending, "completed"]));

export function videoUnavailable(comp = false): never {
  if (comp) return fail(409, "The complimentary clip allowance is unavailable. Nothing was charged.", "complimentary_video_unavailable");
  return fail(409, "The free clip is unavailable. Nothing was charged.", "first_video_unavailable");
}

/** Recover an abandoned provider submission or finish step. The job never resubmits its prompt.
 * Finishing workers use a status/timestamp fence so a late result cannot overwrite a recovered job. */
export async function recoverFirstVideoJobs(db: Db, accountId?: string) {
  const scope = and(or(sponsored, complimentary), accountId ? eq(mediaJobs.accountId, accountId) : undefined);
  const expired = await db.update(mediaJobs).set({ status: "failed", errorType: "job_expired", updatedAt: sql`now()` })
    .where(and(scope, inArray(mediaJobs.status, pending), or(
      sql`${mediaJobs.createdAt} <= now() - interval '1 hour'`,
      and(eq(mediaJobs.status, "queued"), sql`${mediaJobs.updatedAt} <= now() - interval '2 minutes'`),
    ))).returning({ id: mediaJobs.holdId });
  for (const row of expired) await release(db, row.id);
  await db.update(mediaJobs).set({ status: "running", lastPolledAt: null, updatedAt: sql`now()` })
    .where(and(scope, eq(mediaJobs.status, "finishing"), sql`${mediaJobs.updatedAt} <= now() - interval '10 minutes'`));
}

/** An older worker may have failed to follow the provider's signed download link. Only restore
 * the original free, undelivered NanoGPT job under the same lock as a new claim. The released
 * zero hold stays closed. Idempotent settlement reads its existing zero-charge result. */
export async function recoverVideoDownload(db: Db, job: typeof mediaJobs.$inferSelect) {
  const ref = job.upstreamRef;
  if (!isSponsoredVideo(job.id) || job.status !== "failed" || job.errorType !== "upstream_output_unavailable"
      || job.upstream !== "nanogpt" || !ref || job.pricePico !== 0n || job.mediaId || job.chargedPico != null
      || job.createdAt.getTime() <= Date.now() - 3_600_000) return;
  return db.transaction(async tx => {
    const [account] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, job.accountId)).for("update");
    if (!account) return;
    const [prior] = await tx.select({ id: mediaJobs.id }).from(mediaJobs)
      .where(blockingClaim(job.accountId, job.id.startsWith(COMP_VIDEO_PREFIX))).limit(1);
    if (prior) return;
    const [hold] = await tx.select({ id: holds.id, status: holds.status }).from(holds).where(and(
      eq(holds.id, job.holdId), eq(holds.accountId, job.accountId), eq(holds.kind, "media_video"),
      inArray(holds.status, ["held", "released"]), eq(holds.amount, 0n), sql`${holds.expiresAt} > now()`,
    )).for("update");
    if (!hold) return;
    // A finishing poll writes the terminal job before releasing its hold. Wait for that release.
    if (hold.status === "held") return { pendingRelease: true };
    const [recovered] = await tx.update(mediaJobs).set({ status: "running", lastPolledAt: null, updatedAt: sql`now()` })
      .where(and(eq(mediaJobs.id, job.id), eq(mediaJobs.status, "failed"), eq(mediaJobs.errorType, "upstream_output_unavailable"),
        eq(mediaJobs.upstreamRef, ref), isNull(mediaJobs.chargedPico), isNull(mediaJobs.mediaId),
        sql`${mediaJobs.createdAt} > now() - interval '1 hour'`)).returning();
    return { job: recovered };
  });
}

const quotePrefix = "video-sponsor:v1:quote:";

/** Gross dispatch totals remain compatible with workers predating the per-job quote snapshot.
 * Compute spend in one database snapshot; counted jobs and quotes belong to the dispatch's UTC day.
 * Old jobs had no per-job provider quote. Bound any surviving legacy spend by its grant ceiling,
 * retaining at most the actual legacy aggregate. An entirely rejected legacy day is fully restored. */
async function reservedSpend(db: Db | Tx, comp: boolean): Promise<Pico> {
  // Local post-processing failures, acknowledged timeouts and missing provider results can cost
  // real money. Only confirmed provider failures and pre-upgrade unaccepted submissions are freed.
  const refundable = sql`(${mediaJobs.status} in ('blocked', 'failed') and (
    coalesce(${mediaJobs.errorType}, '') in ('upstream_rejected', 'upstream_blocked', 'upstream_render_failed',
      'upstream_cancelled', 'upstream_submission_declined')
    or (${kv.key} is null and ${mediaJobs.upstreamRef} is null and
      coalesce(${mediaJobs.errorType}, '') in ('upstream_failed', 'upstream_unavailable'))
  ))`;
  const amount = sql`(${kv.value} #>> '{}')::numeric`;
  const dayStart = sql`(date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')`;
  const [totals] = await db.select({
    gross: sql<string>`(select value #>> '{}' from kv where key = ${dailySlot(comp)})`,
    exact: sql<string>`coalesce(sum(${amount}), 0)::text`,
    retainedExact: sql<string>`coalesce(sum(${amount}) filter (where not (${refundable})), 0)::text`,
    refundedLegacy: sql<string>`count(*) filter (where ${kv.key} is null and ${refundable})::text`,
    keptLegacy: sql<string>`count(*) filter (where ${kv.key} is null and not (${refundable}))::text`,
  }).from(mediaJobs).leftJoin(kv, eq(kv.key, sql`${quotePrefix}::text || ${mediaJobs.id}`))
    .where(and(comp ? complimentary : sponsored,
      sql`${mediaJobs.createdAt} >= ${dayStart} and ${mediaJobs.createdAt} < ${dayStart} + interval '24 hours'`));

  let legacy = BigInt(totals.gross ?? 0) - BigInt(totals.exact);
  if (legacy < 0n) legacy = 0n;
  if (BigInt(totals.refundedLegacy) > 0n) {
    const survivorCeiling = BigInt(totals.keptLegacy) * MAX_FIRST_VIDEO_PRICE;
    if (legacy > survivorCeiling) legacy = survivorCeiling;
  }
  return legacy + BigInt(totals.retainedExact);
}

export async function firstVideoOffer(db: Db, accountId?: string, comp?: CompVideoAllowance) {
  if (accountId) await recoverFirstVideoJobs(db, accountId);
  const remaining = (comp?.dailyBudget ?? FIRST_VIDEO_DAILY_BUDGET) - await reservedSpend(db, !!comp);
  if (!accountId) return { available: true, remaining };
  const [claim] = await db.select({ id: mediaJobs.id }).from(mediaJobs).where(blockingClaim(accountId, !!comp)).limit(1);
  return { available: !claim, remaining };
}

export async function startFirstVideo(db: Db, job: typeof mediaJobs.$inferInsert, quote: Pico, comp?: CompVideoAllowance) {
  const budget = comp?.dailyBudget ?? FIRST_VIDEO_DAILY_BUDGET;
  if (quote <= 0n || quote > MAX_FIRST_VIDEO_PRICE || quote > budget || !job.id.startsWith(comp ? COMP_VIDEO_PREFIX : FIRST_VIDEO_PREFIX) || job.pricePico !== 0n) videoUnavailable(!!comp);
  await db.transaction(async tx => {
    // Serializes competing job creation for the same root across workers. No extra account state.
    const [account] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, job.accountId)).for("update");
    if (!account) videoUnavailable(!!comp);
    const [prior] = await tx.select({ id: mediaJobs.id }).from(mediaJobs).where(blockingClaim(job.accountId, !!comp)).limit(1);
    if (prior) videoUnavailable(!!comp);
    // The pool lock serializes reservations across accounts. A terminal job can only decrease spend.
    const slot = dailySlot(!!comp);
    await tx.insert(kv).values({ key: slot, value: 0 }).onConflictDoNothing();
    await tx.select({ key: kv.key }).from(kv).where(eq(kv.key, slot)).for("update");
    if (await reservedSpend(tx, !!comp) + quote > budget) videoUnavailable(!!comp);
    await tx.update(kv).set({
      value: sql`to_jsonb((${kv.value} #>> '{}')::numeric + ${quote.toString()}::numeric)`,
      updatedAt: sql`now()`,
    }).where(eq(kv.key, slot));
    await tx.insert(kv).values({ key: quotePrefix + job.id, value: Number(quote) });
    await tx.insert(mediaJobs).values(job);
  });
}
