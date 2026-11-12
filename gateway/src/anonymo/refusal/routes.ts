// WS03 · a key's own default for the refusal catch. The `x-anonymo-refusal-catch: on|off` request header wins over it.
//
//   GET /api/v1/keys/:hash/refusal-catch            → { data: { key: hash, refusal_catch: "on" | "off" } }
//   PUT /api/v1/keys/:hash/refusal-catch  {enabled} → the same, after the change
//
// `:hash` is a key hash or `self`. A key may always read and change its own setting; a management key may change any
// key of its account, and a team owner or admin any key of its team.

import { and, eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import type { Ctx } from "../../context.ts";
import { keys } from "../../db/schema.ts";
import { requireKey, requireRole, type KeyRow } from "../../api/auth.ts";
import { readJson } from "../../api/common.ts";
import { fail } from "../../lib/errors.ts";
import { refusalCatchEnabled, setKeyRefusalCatch } from "./store.ts";

async function target(ctx: Ctx, c: Context): Promise<KeyRow> {
  const caller = await requireKey(ctx, c.req.header("authorization"));
  const hash = c.req.param("hash");
  if (!hash || hash === "self" || hash === caller.keyHash) return caller;
  await requireRole(ctx, caller, ["owner", "admin"]);
  const [k] = await ctx.db.select().from(keys).where(and(eq(keys.keyHash, hash), eq(keys.accountId, caller.accountId)));
  if (!k) fail(404, "Key not found.", "not_found");
  if (!caller.management && (!caller.teamId || k.teamId !== caller.teamId)) fail(403, "This key cannot manage that key.", "forbidden");
  return k;
}

const view = (keyHash: string, on: boolean) => ({ data: { key: keyHash, refusal_catch: on ? "on" : "off" } });

export function refusalRoutes(app: Hono, ctx: Ctx) {
  for (const base of ["/api/v1", "/v1"]) {
    app.get(`${base}/keys/:hash/refusal-catch`, async (c) => {
      const k = await target(ctx, c);
      return c.json(view(k.keyHash, await refusalCatchEnabled(ctx.db, undefined, k.keyHash)));
    });
    app.put(`${base}/keys/:hash/refusal-catch`, async (c) => {
      const k = await target(ctx, c);
      const body = await readJson(c);
      const v = body.enabled ?? body.refusal_catch;
      const enabled = v === true || v === "on" ? true : v === false || v === "off" ? false : fail(400, '`enabled` must be true or false (or "on"/"off").', "invalid_request");
      await setKeyRefusalCatch(ctx.db, k.keyHash, enabled);
      return c.json(view(k.keyHash, enabled));
    });
  }
}
