import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { bearer, requireKey } from "../../api/auth.ts";
import { readJson } from "../../api/common.ts";
import { KEY_RE } from "../../chain/keys.ts";
import type { Ctx } from "../../context.ts";
import { fail } from "../../lib/errors.ts";
import { sha256 } from "../../lib/util.ts";
import { batchLineOf } from "../../router/batch-line.ts";
import { regionCodeOf } from "./middleware.ts";
import { createRegionPolicy } from "./policy.ts";
import { parseRegion } from "./rules.ts";
import { ageProofs } from "./schema.ts";

const REGION = "/v1/compliance/region";
const PROOF = "/v1/compliance/age-proof";
const DECLARED = "x-anonymo-declared-region";
const EXIT = new Set([
  "/health", "/ready", "/balance", "/withdraw", "/withdrawals", "/keys/me", "/api/v1/key", "/api/v1/credits",
  "/api/v1/credits/withdraw-request", "/api/v1/credits/withdrawal-proof", "/api/v1/credits/withdraw-cancel",
  "/api/v1/creators/claim",
]);
const proofSetup = new Set(["/keys", "/api/v1/keys", "/v1/models", "/api/v1/models", "/v1/media/models"]);

export const isComplianceRoute = (method: string, path: string) =>
  (method === "GET" && path === REGION) || (method === "POST" && path === PROOF);

function ungated(c: Context) {
  const path = c.req.path;
  return EXIT.has(path) || /^\/api\/v1\/creators\/claims(?:\/[^/]+(?:\/verify)?)?$/.test(path) ||
    (["GET", "DELETE"].includes(c.req.method) && /^\/api\/v1\/memory(?:\/[^/]+)?$/.test(path));
}

// In-process API adapters carry the same region signals into the normal chat handler.
export function forwardComplianceRegion(c: Context, headers: Headers) {
  for (const name of ["cf-ipcountry", "cf-region-code", "x-anonymo-region", DECLARED]) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
}

function credential(c: Context) {
  const auth = bearer(c.req.header("authorization"));
  if (!/^\/(?:api\/)?v1\/messages(?:\/|$)/.test(c.req.path)) return auth;
  return [c.req.header("x-api-key")?.trim(), auth].find((key) => key && KEY_RE.test(key)) ?? auth;
}

function regionPage(c: Context, proofRequired: boolean) {
  const title = proofRequired ? "Age proof required" : "Anonymo is unavailable in this region";
  const message = proofRequired
    ? "Submit an over-18 proof for your Anonymo key through the workspace to continue."
    : "Model access is unavailable in this region. You can still withdraw eligible credit.";
  const headers = { "Cache-Control": "no-store" };
  if (c.req.header("accept")?.includes("text/html")) return c.html(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><main><h1>${title}</h1><p>${message}</p></main></html>`, 451, headers,
  );
  return c.json({ error: { code: 451, type: proofRequired ? "age_proof_required" : "region_blocked", message, metadata: { region_page: REGION } } }, 451, headers);
}

const proofBody = z.object({ proof: z.string().min(1).max(64 * 1024) }).strict();

export function mountRegionGate(app: Hono, ctx: Ctx, env: Record<string, unknown>) {
  const policyFor = createRegionPolicy(ctx.db, env);
  const access = async (c: Context) => {
    const declared = c.req.header(DECLARED)?.trim() || null;
    if (declared && !parseRegion(declared)) fail(400, "Use an ISO country or subdivision code for the declared region.", "invalid_region");
    try {
      const policy = await policyFor(regionCodeOf(c.req.raw.headers), declared);
      const secret = policy.mode === "proof_required" ? credential(c) : null;
      const verified = !!secret && KEY_RE.test(secret) && (await ctx.db.select({ nullifier: ageProofs.nullifier })
        .from(ageProofs).where(eq(ageProofs.keyHash, Buffer.from(sha256(secret), "hex"))).limit(1)).length > 0;
      return { ...policy, access: policy.mode === "allowed" || verified };
    } catch {
      fail(503, "Region policy is temporarily unavailable.", "region_policy_unavailable");
    }
  };

  app.use("*", async (c, next) => {
    if (ungated(c) || c.req.path === REGION || c.req.path === PROOF) return next();
    const policy = await access(c);
    if (!policy.access && !(policy.mode === "proof_required" && proofSetup.has(c.req.path))) {
      return regionPage(c, policy.mode === "proof_required");
    }
    // Queued batches retain their prompts and lack a live region signal on dispatch.
    if (batchLineOf(c) || (c.req.method === "POST" && /^\/(?:api\/)?v1\/batches$/.test(c.req.path))) {
      fail(403, "Batch inference is unavailable with region compliance enabled.", "batches_unavailable");
    }
    await next();
  });
  return access;
}

export function complianceRoutes(app: Hono, ctx: Ctx, access: ReturnType<typeof mountRegionGate>) {
  app.get(REGION, async (c) => {
    const policy = await access(c);
    if (!policy.access && c.req.header("accept")?.includes("text/html")) return regionPage(c, policy.mode === "proof_required");
    return c.json(policy, 200, { "Cache-Control": "no-store" });
  });

  app.post(PROOF, async (c) => {
    c.header("Cache-Control", "no-store");
    const key = await requireKey(ctx, c.req.header("authorization"));
    const verifier = ctx.anonymo.ageProofVerifier;
    if (!verifier) fail(503, "Age proof verification is temporarily unavailable.", "age_proof_unavailable");
    const limit = await ctx.limiter.take(`age-proof:${key.keyHash}`, 1, 5, 60_000);
    if (!limit.ok) fail(429, "Too many age proof attempts. Try again shortly.", "rate_limited");
    const submitted = proofBody.safeParse(await readJson(c));
    if (!submitted.success) fail(400, "Submit a single age proof.", "invalid_age_proof");
    const { proof } = submitted.data;
    let nullifier: Uint8Array | null;
    try {
      nullifier = await verifier.verify(proof, key.keyHash);
    } catch {
      fail(503, "Age proof verification is temporarily unavailable.", "age_proof_unavailable");
    }
    if (!nullifier || nullifier.length !== 32) fail(422, "The proof could not verify an over-18 claim for this key.", "invalid_age_proof");

    const keyHash = Buffer.from(key.keyHash, "hex");
    const value = Buffer.from(nullifier);
    const owner = await (async () => {
      const [created] = await ctx.db.insert(ageProofs).values({ nullifier: value, keyHash }).onConflictDoNothing()
        .returning({ keyHash: ageProofs.keyHash });
      if (created) return created;
      const [existing] = await ctx.db.select({ keyHash: ageProofs.keyHash }).from(ageProofs).where(eq(ageProofs.nullifier, value));
      return existing;
    })().catch(() => fail(503, "Age proof verification is temporarily unavailable.", "age_proof_unavailable"));
    if (!owner || !Buffer.from(owner.keyHash).equals(keyHash)) fail(409, "This proof is already used with another key.", "age_proof_used");
    return c.json({ verified: true });
  });
}
