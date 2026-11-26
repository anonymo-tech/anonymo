// The existing job row is also the per-account claim. Only completed jobs permanently consume
// it. A failed or blocked dispatch keeps its quote in the shared budget but allows a new attempt.
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { accounts, kv } from "../../db/schema.ts";
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

export async function firstVideoOffer(db: Db, accountId?: string, comp?: CompVideoAllowance) {
  const [counter] = await db.select({ spent: sql<string>`(${kv.value} #>> '{}')` }).from(kv).where(eq(kv.key, dailySlot(!!comp)));
  const remaining = (comp?.dailyBudget ?? FIRST_VIDEO_DAILY_BUDGET) - BigInt(counter?.spent ?? 0);
  if (!accountId) return { available: true, remaining };
  await recoverFirstVideoJobs(db, accountId);
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
    const total = sql`(${kv.value} #>> '{}')::bigint + ${quote.toString()}::bigint`;
    const spent = await tx.insert(kv).values({ key: dailySlot(!!comp), value: Number(quote) })
      .onConflictDoUpdate({ target: kv.key, set: { value: sql`to_jsonb(${total})`, updatedAt: sql`now()` },
        setWhere: sql`${total} <= ${budget.toString()}::bigint` }).returning({ key: kv.key });
    if (!spent.length) videoUnavailable(!!comp);
    await tx.insert(mediaJobs).values(job);
  });
}
