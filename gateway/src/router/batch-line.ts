import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { assertKeyPolicy, isSealedRequest, readKeyPolicy } from "../anonymo/keys/caps.ts";
import type { Ctx } from "../context.ts";
import { keys } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";

// A batch line is run through the normal chat handler, in process: the batch runner (services/batches.ts)
// calls app.request(path, init, env) with this marker in `env`. Nothing on the network can set it: a served request's env
// is the Bun server. The marker names the key that submitted the batch (so the line is billed, budgeted and rate-limited as
// that key) and the discount the line is priced at.

export const BATCH_LINE = Symbol("anonymo.batch-line");
export type BatchLine = { batchId: string; idx: number; keyHash: string; discountBps: number; generationId: string; submitterIp: string | null };

export function batchLineOf(c: Context): BatchLine | null {
  const env = c.env as Record<symbol, unknown> | null | undefined;
  const v = env && typeof env === "object" ? env[BATCH_LINE] : undefined;
  return v && typeof v === "object" ? (v as BatchLine) : null;
}

/** Recheck the submitting key and its current policy before each queued line runs. */
export async function batchKey(ctx: Ctx, { keyHash, submitterIp }: BatchLine, model: unknown) {
  const [row] = await ctx.db.select().from(keys).where(eq(keys.keyHash, keyHash));
  if (!row) fail(401, "The key that submitted this batch no longer exists.", "invalid_key");
  if (row.disabled) fail(401, "This API key is disabled.", "key_disabled");
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) fail(401, "This API key has expired.", "key_expired");
  await assertKeyPolicy(ctx.db, await readKeyPolicy(ctx.db, keyHash), { ip: submitterIp, sealed: isSealedRequest(model, undefined) });
  return row;
}
