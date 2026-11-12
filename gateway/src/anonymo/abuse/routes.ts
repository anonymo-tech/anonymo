// Abuse routes (Backend §2 "abuse", §10 "Takedown").
//
// Public, no key needed:
//   POST /api/v1/abuse/takedown        file a takedown; answered within 48 hours. Media sent here is hashed and dropped.
//   GET  /api/v1/abuse/takedown/:id    status of a takedown (no details)
// Operator only (Authorization: Bearer ADMIN_TOKEN):
//   GET  /api/v1/abuse/inbox                  open takedowns, oldest deadline first, plus pending floor hits
//   POST /api/v1/abuse/inbox/:id              { action: block | report | reject, category? }
//   POST /api/v1/abuse/blocks                 { hashes, category } block content by SHA-256
//   GET  /api/v1/abuse/floor-hits             pending floor hits (metadata only)
//   POST /api/v1/abuse/floor-hits/:id/report  file a child-safety hit with CyberTipline and preserve it for a year
//   GET  /api/v1/abuse/preservation/:id       read a preserved record

import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Ctx } from "../../context.ts";
import { ApiError } from "../../lib/errors.ts";
import { safeEqual } from "../../lib/util.ts";
import { floorHitsOf } from "../floor/gate.ts";
import { sha256Hex } from "../floor/uploads.ts";
import { AbuseFlowError, actOnTakedown, blockHashes, createTakedown, openTakedowns, purgeExpired, readPreserved, reportFloorHit, takedownStatus } from "./store.ts";
import { manualTiplineReporter, type CyberTiplineReporter } from "./tipline.ts";

const CATEGORIES = ["minor", "real_person", "voice_clone", "cbrn"] as const;
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/i).transform((s) => s.toLowerCase());
export const MAX_TAKEDOWN_MEDIA_BYTES = 4 * 1024 * 1024;

const takedownSchema = z
  .object({
    kind: z.enum(["ncii", "csam", "other"]),
    content_hashes: z.array(SHA256).max(20).optional(),
    media: z.string().max(Math.ceil((MAX_TAKEDOWN_MEDIA_BYTES * 4) / 3) + 4).optional(), // base64; hashed, never stored
    reference: z.string().trim().min(1).max(200).optional(),
    details: z.string().trim().max(4000).optional(),
    contact: z.string().trim().max(254).optional(),
  })
  .strict();

const actionSchema = z.object({ action: z.enum(["block", "report", "reject"]), category: z.enum(CATEGORIES).optional() }).strict();
const blockSchema = z.object({ hashes: z.array(SHA256).min(1).max(500), category: z.enum(CATEGORIES) }).strict();

export type AbuseDeps = { reporter?: CyberTiplineReporter };

export function abuseRoutes(app: Hono, ctx: Ctx, deps: AbuseDeps = {}) {
  const reporter = deps.reporter ?? manualTiplineReporter;
  const secret = ctx.cfg.appSecret;
  const operator = (c: Context) => {
    const token = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (!ctx.cfg.adminToken || !token || !safeEqual(token, ctx.cfg.adminToken)) throw new ApiError(401, "Operator token required.", "unauthorized");
  };
  const flow = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AbuseFlowError) throw new ApiError(e.status, e.message, "abuse_flow");
      throw e;
    }
  };

  app.post("/api/v1/abuse/takedown", async (c) => {
    const body = takedownSchema.parse(await c.req.json().catch(() => ({})));
    const hashes = [...(body.content_hashes ?? [])];
    if (body.media) {
      const bytes = Buffer.from(body.media, "base64");
      if (!bytes.length || bytes.length > MAX_TAKEDOWN_MEDIA_BYTES) throw new ApiError(400, "media must be base64 of at most 4 MB.", "invalid_request");
      hashes.push(sha256Hex(bytes));
    }
    if (!hashes.length && !body.reference) throw new ApiError(400, "Send content_hashes, media or a reference so we can find the content.", "invalid_request");
    // Rate limits for this public route live at the edge (Backend §2), which sees the address; the gateway never does.
    const r = await createTakedown(ctx.db, secret, { kind: body.kind, contentHashes: hashes, reference: body.reference ?? null, details: body.details || null, contact: body.contact || null });
    return c.json({ data: { id: r.id, status: "open", due_at: r.dueAt.toISOString() } }, 201);
  });

  app.get("/api/v1/abuse/takedown/:id", async (c) => {
    const r = await takedownStatus(ctx.db, c.req.param("id"));
    if (!r) throw new ApiError(404, "No such report.", "not_found");
    return c.json({ data: { id: r.id, status: r.status, received_at: r.receivedAt.toISOString(), due_at: r.dueAt.toISOString(), actioned_at: r.actionedAt?.toISOString() ?? null } });
  });

  app.get("/api/v1/abuse/inbox", async (c) => {
    operator(c);
    await purgeExpired(ctx.db);
    return c.json({ data: await openTakedowns(ctx.db, secret), floor_hits: floorHitsOf(ctx.anonymo.floor)?.list() ?? [] });
  });

  app.post("/api/v1/abuse/inbox/:id", async (c) => {
    operator(c);
    const body = actionSchema.parse(await c.req.json().catch(() => ({})));
    const r = await flow(() => actOnTakedown(ctx.db, secret, reporter, c.req.param("id"), body.action, { category: body.category }));
    return c.json({ data: r });
  });

  app.post("/api/v1/abuse/blocks", async (c) => {
    operator(c);
    const body = blockSchema.parse(await c.req.json().catch(() => ({})));
    return c.json({ data: { added: await blockHashes(ctx.db, body.hashes, body.category, "operator", null) } }, 201);
  });

  app.get("/api/v1/abuse/floor-hits", (c) => {
    operator(c);
    return c.json({ data: floorHitsOf(ctx.anonymo.floor)?.list() ?? [] });
  });

  app.post("/api/v1/abuse/floor-hits/:id/report", async (c) => {
    operator(c);
    const hits = floorHitsOf(ctx.anonymo.floor);
    const pending = hits?.list().find((h) => h.id === c.req.param("id"));
    if (!hits || !pending) throw new ApiError(404, "No such pending floor hit (it may have expired).", "not_found");
    if (pending.category !== "minor") throw new ApiError(422, "Only child-safety hits go to CyberTipline.", "abuse_flow");
    const hit = hits.take(pending.id)!;
    const r = await reportFloorHit(ctx.db, secret, reporter, hit);
    return c.json({ data: { preservation_id: r.preservationId, tipline: r.tipline } }, 201);
  });

  app.get("/api/v1/abuse/preservation/:id", async (c) => {
    operator(c);
    const r = await readPreserved(ctx.db, secret, c.req.param("id"));
    if (!r) throw new ApiError(404, "No such preserved record.", "not_found");
    return c.json({ data: r });
  });
}
