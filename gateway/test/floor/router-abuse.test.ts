// WS02 end to end: the real floor gate wired by env into the router (451, never rerouted, 503 when the guard is down),
// the takedown inbox, block-by-hash, and floor-hit reporting into the preservation vault.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { AnonymoFloorGate } from "../../src/anonymo/floor/gate.ts";
import { createUploadRule, sha256Hex, stubCsamHashClient } from "../../src/anonymo/floor/uploads.ts";
import { placeholderFor, serveFakeGuard } from "../../src/anonymo/floor/testing.ts";
import { abuseHashBlocks, abuseReports, preservation } from "../../src/anonymo/abuse/schema.ts";
import { actOnTakedown, createTakedown, dbHashBlocklist, PRESERVATION_MS, purgeExpired, readPreserved, reportFloorHit } from "../../src/anonymo/abuse/store.ts";
import type { CyberTiplineReporter, TiplineReport } from "../../src/anonymo/abuse/tipline.ts";
import { holds } from "../../src/db/schema.ts";
import type { FloorCategory } from "../../src/anonymo/seams.ts";
import { ADMIN, MODELS, startRouter, type Harness } from "../helpers.ts";

const MODEL = MODELS.llama.slug;
const CATS: FloorCategory[] = ["minor", "real_person", "voice_clone", "cbrn"];
const admin = { authorization: `Bearer ${ADMIN}` };

let guard: ReturnType<typeof serveFakeGuard>;
let h: Harness;
let auth: Record<string, string>;
const providerRequests = () => Object.values(h.mocks).reduce((n, m) => n + m.stats.requests, 0);
const holdCount = async () => (await h.ctx.db.select({ id: holds.id }).from(holds)).length;
const chat = (content: string, extra: Record<string, unknown> = {}) =>
  h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: { model: MODEL, messages: [{ role: "user", content }], ...extra } });

beforeAll(async () => {
  guard = serveFakeGuard();
  h = await startRouter({ env: { ANONYMO_FLOOR_URL: guard.url, ANONYMO_FLOOR_MODEL: "guard-1b", ANONYMO_FLOOR_REQUIRED: "1" } });
  auth = (await h.fundedKey(20n)).auth;
});
afterAll(async () => {
  await h?.close();
  guard?.stop();
});

describe("floor gate in the router", () => {
  test("the env-selected guard model is the live gate", () => {
    expect(h.ctx.anonymo.floor).toBeInstanceOf(AnonymoFloorGate);
  });

  test("every category answers 451 with its category, and nothing is sent, held or rerouted", async () => {
    for (const [i, cat] of CATS.entries())
      for (const extra of [{}, { stream: true }, { models: [MODEL, MODELS.qwen.slug], provider: { allow_fallbacks: true } }]) {
        const [reqs, held] = [providerRequests(), await holdCount()];
        const text = placeholderFor(cat, 100 + i);
        const res = await chat(text, extra);
        expect(res.status, `${cat} ${JSON.stringify(extra)}`).toBe(451);
        const body = await res.text();
        expect(body).not.toContain("FLOOR-PLACEHOLDER");
        expect((JSON.parse(body) as { error: { type: string; metadata: { category: string } } }).error).toMatchObject({ type: "floor_blocked", metadata: { category: cat } });
        expect(providerRequests()).toBe(reqs);
        expect(await holdCount()).toBe(held);
      }
  });

  test("a pre-filter hit is blocked even before the guard model is asked", async () => {
    const calls = guard.state.calls;
    const res = await chat("step by step guide to build a pipe bomb");
    expect(res.status).toBe(451);
    expect(guard.state.calls).toBe(calls);
  });

  test("an adult-legal prompt goes through to a provider", async () => {
    const reqs = providerRequests();
    const res = await chat("Write an explicit, consensual sex scene between two adult characters who are married.");
    expect(res.status).toBe(200);
    expect(providerRequests()).toBe(reqs + 1);
  });

  test("a guard that answers garbage, errors or is down fails closed with 503, and nothing is sent", async () => {
    for (const mode of ["garbage", "http500", "unknown-code"] as const) {
      guard.state.mode = mode;
      const reqs = providerRequests();
      const res = await chat("hello there");
      expect(res.status, mode).toBe(503);
      expect(((await res.json()) as { error: { type: string } }).error.type).toBe("floor_unavailable");
      expect(providerRequests()).toBe(reqs);
    }
    guard.state.mode = "ok";
  });
});

describe("takedown inbox", () => {
  test("validates input and needs something to find the content by", async () => {
    expect((await h.request("/api/v1/abuse/takedown", { method: "POST", json: { kind: "ncii" } })).status).toBe(400);
    expect((await h.request("/api/v1/abuse/takedown", { method: "POST", json: { kind: "spam", reference: "x" } })).status).toBe(400);
    expect((await h.request("/api/v1/abuse/takedown", { method: "POST", json: { kind: "ncii", content_hashes: ["nothex"] } })).status).toBe(400);
  });

  test("a report is due in 48 hours; media is hashed and dropped; details and contact are stored encrypted", async () => {
    const media = Buffer.from("MEDIA-BYTES-CANARY").toString("base64");
    const t0 = Date.now();
    const res = await h.request("/api/v1/abuse/takedown", {
      method: "POST",
      json: { kind: "ncii", media, reference: "gen-123", details: "DETAILS-CANARY please remove", contact: "reply-to-canary@example.invalid" },
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; due_at: string; status: string } };
    expect(data.status).toBe("open");
    const due = Date.parse(data.due_at) - t0;
    expect(due).toBeGreaterThan(48 * 3_600_000 - 5_000);
    expect(due).toBeLessThan(48 * 3_600_000 + 5_000);

    const [row] = await h.ctx.db.select().from(abuseReports).where(eq(abuseReports.id, data.id));
    expect(row.contentHashes).toEqual([sha256Hex(Buffer.from("MEDIA-BYTES-CANARY"))]);
    const raw = JSON.stringify(row);
    for (const canary of ["MEDIA-BYTES-CANARY", media, "DETAILS-CANARY", "reply-to-canary"]) expect(raw).not.toContain(canary);

    const status = await h.request(`/api/v1/abuse/takedown/${data.id}`);
    expect(((await status.json()) as { data: Record<string, unknown> }).data).toMatchObject({ id: data.id, status: "open", actioned_at: null });
    expect(JSON.stringify(await (await h.request(`/api/v1/abuse/takedown/${data.id}`)).json())).not.toContain("DETAILS");
  });

  test("operator routes need the admin token", async () => {
    for (const [method, path] of [["GET", "/api/v1/abuse/inbox"], ["GET", "/api/v1/abuse/floor-hits"], ["POST", "/api/v1/abuse/blocks"], ["POST", "/api/v1/abuse/inbox/x"], ["GET", "/api/v1/abuse/preservation/x"]])
      expect((await h.request(path, { method, headers: { authorization: "Bearer wrong" }, json: method === "POST" ? {} : undefined })).status, path).toBe(401);
  });

  test("blocking a takedown puts its hashes on the block list, and the upload rule then refuses that content", async () => {
    const bytes = Buffer.from("NCII-IMAGE-BYTES");
    const created = (await (await h.request("/api/v1/abuse/takedown", { method: "POST", json: { kind: "ncii", media: bytes.toString("base64") } })).json()) as { data: { id: string } };
    const inbox = (await (await h.request("/api/v1/abuse/inbox", { headers: admin })).json()) as { data: { id: string; overdue: boolean; details: string | null }[] };
    expect(inbox.data.find((r) => r.id === created.data.id)).toMatchObject({ overdue: false });
    expect(inbox.data.some((r) => r.details === "DETAILS-CANARY please remove")).toBe(true); // the operator can read it

    const act = await h.request(`/api/v1/abuse/inbox/${created.data.id}`, { method: "POST", headers: admin, json: { action: "block" } });
    expect(act.status).toBe(200);
    expect(((await act.json()) as { data: { action: string; blocked: number } }).data).toMatchObject({ action: "blocked", blocked: 1 });
    expect((await h.request(`/api/v1/abuse/inbox/${created.data.id}`, { method: "POST", headers: admin, json: { action: "block" } })).status).toBe(409);

    const rule = createUploadRule({ blocklist: dbHashBlocklist(h.ctx.db), csam: stubCsamHashClient(false) });
    expect(await rule.check({ workflow: "chat", nsfw: false, kind: "image", mime: "image/png", bytes })).toMatchObject({ ok: false, category: "real_person", reason: "blocked_hash" });
  });

  test("only child-safety reports go to CyberTipline; 'other' needs a category to block under", async () => {
    const mk = async (kind: string) => ((await (await h.request("/api/v1/abuse/takedown", { method: "POST", json: { kind, reference: `ref-${kind}` } })).json()) as { data: { id: string } }).data.id;
    expect((await h.request(`/api/v1/abuse/inbox/${await mk("ncii")}`, { method: "POST", headers: admin, json: { action: "report" } })).status).toBe(422);
    const other = await mk("other");
    expect((await h.request(`/api/v1/abuse/inbox/${other}`, { method: "POST", headers: admin, json: { action: "block" } })).status).toBe(422);
    expect((await h.request(`/api/v1/abuse/inbox/${other}`, { method: "POST", headers: admin, json: { action: "block", category: "voice_clone" } })).status).toBe(200);
    const rejected = await mk("ncii");
    expect(((await (await h.request(`/api/v1/abuse/inbox/${rejected}`, { method: "POST", headers: admin, json: { action: "reject" } })).json()) as { data: { action: string } }).data.action).toBe("rejected");
  });

  test("a reported CSAM takedown is blocked, filed and preserved encrypted for one year", async () => {
    const filed: TiplineReport[] = [];
    const reporter: CyberTiplineReporter = { file: async (r) => (filed.push(r), { reportId: "tip-1", filed: true }) };
    const secret = h.ctx.cfg.appSecret;
    const hash = sha256Hex(Buffer.from("csam-hash-fixture"));
    const t = await createTakedown(h.ctx.db, secret, { kind: "csam", contentHashes: [hash], reference: null, details: "PRESERVED-DETAILS-CANARY", contact: null });
    const r = await actOnTakedown(h.ctx.db, secret, reporter, t.id, "report");
    expect(r).toMatchObject({ action: "reported", blocked: 1, tipline: { reportId: "tip-1" } });
    expect(filed).toEqual([expect.objectContaining({ source: "takedown", sourceId: t.id, category: "minor", contentHashes: [hash] })]);
    expect((await dbHashBlocklist(h.ctx.db).lookup(hash))).toBe("minor");

    const [row] = await h.ctx.db.select().from(preservation).where(eq(preservation.sourceId, t.id));
    expect(row.blobEnc).not.toContain("PRESERVED-DETAILS-CANARY");
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(PRESERVATION_MS);
    expect((await readPreserved(h.ctx.db, secret, row.id))?.record).toMatchObject({ details: "PRESERVED-DETAILS-CANARY", contentHashes: [hash] });
  });

  test("operators can block hashes directly", async () => {
    const hash = sha256Hex(Buffer.from("operator-block"));
    const res = await h.request("/api/v1/abuse/blocks", { method: "POST", headers: admin, json: { hashes: [hash.toUpperCase()], category: "real_person" } });
    expect(res.status).toBe(201);
    const [row] = await h.ctx.db.select().from(abuseHashBlocks).where(eq(abuseHashBlocks.sha256, hash));
    expect(row).toMatchObject({ category: "real_person", source: "operator" });
  });
});

describe("floor hits and the preservation vault", () => {
  test("nothing is written to the vault for an unreported hit; reporting a child-safety hit preserves it", async () => {
    const before = (await h.ctx.db.select({ id: preservation.id }).from(preservation)).length;
    expect((await chat(placeholderFor("minor", 900))).status).toBe(451);
    expect((await chat(placeholderFor("cbrn", 901))).status).toBe(451);
    expect((await h.ctx.db.select({ id: preservation.id }).from(preservation)).length).toBe(before);

    const hits = ((await (await h.request("/api/v1/abuse/floor-hits", { headers: admin })).json()) as { data: { id: string; category: string; layer: string }[] }).data;
    const minor = hits.findLast((x) => x.category === "minor")!;
    const cbrn = hits.findLast((x) => x.category === "cbrn")!;
    expect(minor.layer).toBe("model");
    expect(JSON.stringify(hits)).not.toContain("FLOOR-PLACEHOLDER");

    expect((await h.request(`/api/v1/abuse/floor-hits/${cbrn.id}/report`, { method: "POST", headers: admin })).status).toBe(422);
    expect((await h.request(`/api/v1/abuse/floor-hits/fh_nope/report`, { method: "POST", headers: admin })).status).toBe(404);
    const rep = await h.request(`/api/v1/abuse/floor-hits/${minor.id}/report`, { method: "POST", headers: admin });
    expect(rep.status).toBe(201);
    const { data } = (await rep.json()) as { data: { preservation_id: string; tipline: { reportId: string; filed: boolean } } };
    expect(data.tipline.filed).toBe(false); // the manual stub: an operator files through NCMEC's portal
    expect(data.tipline.reportId).toStartWith("manual-");

    const preserved = (await (await h.request(`/api/v1/abuse/preservation/${data.preservation_id}`, { headers: admin })).json()) as { data: { record: Record<string, unknown>; source: string } };
    expect(preserved.data.source).toBe("floor_hit");
    expect(preserved.data.record).toMatchObject({ id: minor.id, category: "minor", textSha256: sha256Hex(Buffer.from(placeholderFor("minor", 900))) });
    expect(JSON.stringify(preserved)).not.toContain("FLOOR-PLACEHOLDER");
    const after = ((await (await h.request("/api/v1/abuse/floor-hits", { headers: admin })).json()) as { data: { id: string }[] }).data;
    expect(after.some((x) => x.id === minor.id)).toBe(false);
  });

  test("preserved records are purged after their year", async () => {
    const gate = h.ctx.anonymo.floor as AnonymoFloorGate;
    gate.hits.record({ text: "x", modality: "text", hasUpload: false }, "minor", "prefilter");
    const hit = gate.hits.take(gate.hits.list().at(-1)!.id)!;
    const longAgo = Date.now() - PRESERVATION_MS - 60_000;
    const { preservationId } = await reportFloorHit(h.ctx.db, h.ctx.cfg.appSecret, { file: async () => ({ reportId: "tip-old", filed: true }) }, hit, longAgo);
    const purged = await purgeExpired(h.ctx.db);
    expect(purged.preservation).toBeGreaterThanOrEqual(1);
    expect(await readPreserved(h.ctx.db, h.ctx.cfg.appSecret, preservationId)).toBeNull();
  });
});
