import type { Context, Hono } from "hono";
import { cors } from "hono/cors";
import type { Hex } from "viem";
import type { Ctx } from "../../context.ts";
import { fail } from "../../lib/errors.ts";
import { servable } from "../../api/models.ts";
import { fundedOffers } from "../../rush/availability.ts";
import { loadAnonymoReceipt, receiptHeader, verifyAnonymoReceipt, type AnonymoReceipt } from "../../receipts/anonymo.ts";
import { inclusionProof, verifyInclusion } from "../../receipts/roots.ts";
import { anonymoModelFields, rate, refusalStats30d, routeFacts } from "./stats.ts";
import { familyOf } from "./families.ts";

// WS09 public endpoints (Backend §8, §11):
//   GET /v1/receipts/{id}         the signed Anonymo receipt, whether its signature verifies, and its Merkle anchor
//   GET /v1/receipts/{id}/proof   the Merkle path from its leaf to the hourly root posted to ReceiptRoots
//   GET /manifest                 every listed model and route: upstream, family, quant, weights hash, attested now
//   GET /leaderboard              refusal counts and rates per route and per family over 30 days
// Receipts carry only ids, routes, hashes, counts and amounts, so they are public by id like the existing receipts.
// /manifest and /leaderboard are JSON, or a minimal HTML page for a browser (Accept: text/html, or ?format=html).

export function trustRoutes(app: Hono, ctx: Ctx) {
  // The dashboard (dash/, its own origin) reads /manifest and /leaderboard from the browser. Both are public, read-only
  // and cookie-free, so any origin may read them. (/v1/receipts/* already gets the /v1/* CORS from app.ts.)
  const publicCors = cors({ origin: "*", allowMethods: ["GET", "HEAD", "OPTIONS"], allowHeaders: ["accept"] });
  app.use("/manifest", publicCors);
  app.use("/leaderboard", publicCors);

  const receipt = async (id: string) => {
    const row = await loadAnonymoReceipt(ctx, id);
    if (!row) fail(404, "Receipt not found. Per-call receipts are at GET /api/v1/receipts/{id}.", "not_found");
    return row!;
  };

  app.get("/v1/receipts/:id", async (c) => {
    const row = await receipt(c.req.param("id"));
    const signed = { payload: row.payload as AnonymoReceipt, sig: row.sig, key_id: row.keyId, alg: "Ed25519" as const, leaf: row.leaf as Hex };
    const anchor = await inclusionProof(ctx, row);
    return c.json({
      data: {
        id: row.id,
        receipt: signed.payload,
        sig: signed.sig,
        key_id: signed.key_id,
        alg: signed.alg,
        leaf: signed.leaf,
        header: receiptHeader(signed),
        signature_valid: await verifyAnonymoReceipt(ctx, signed),
        keys: "/api/v1/receipts/keys",
        anchor: anchor ? { ...anchor, valid: verifyInclusion(anchor.leaf, anchor.proof, anchor.root) } : null,
      },
    });
  });

  app.get("/v1/receipts/:id/proof", async (c) => {
    const row = await receipt(c.req.param("id"));
    const p = await inclusionProof(ctx, row);
    if (!p) return c.json({ data: { id: row.id, leaf: row.leaf, rooted: false, status: "pending", hint: "Receipts are rooted once their hour closes. Ask again after the next hourly root." } });
    return c.json({
      data: {
        id: row.id,
        rooted: true,
        posted: p.status === "posted",
        ...p,
        valid: verifyInclusion(p.leaf, p.proof, p.root),
        // How to check it yourself: OpenZeppelin MerkleProof.verify(proof, root, leaf) with sorted-pair keccak256,
        // and ReceiptRoots.rootOf(hour) on chain once `posted` is true.
        verify: { leaf: "keccak256(canonical_json(receipt))", tree: "sorted-pair keccak256 (OpenZeppelin MerkleProof)", contract: "ReceiptRoots.rootOf(hour)" },
      },
    });
  });

  app.get("/manifest", async (c) => {
    await ctx.catalog.ensureFresh();
    const stats = await refusalStats30d(ctx);
    const models = [...ctx.catalog.models.values()]
      .filter((m) => !m.hidden)
      .map((m) => ({ m, offers: fundedOffers(ctx, servable(ctx, m)) }))
      .filter((x) => x.offers.length > 0)
      .sort((a, b) => a.m.id.localeCompare(b.m.id))
      .map(({ m, offers }) => ({ id: m.id, ...anonymoModelFields(ctx, m, offers, stats), routes: offers.map((o) => routeFacts(ctx, m, o)).sort((a, b) => a.route.localeCompare(b.route)) }));
    const routes = models.flatMap((m) => m.routes);
    const doc = {
      generated_at: new Date().toISOString(),
      counts: { models: models.length, routes: routes.length, attested_routes: routes.filter((r) => r.attested).length, families: new Set(routes.map((r) => r.family)).size },
      notes: [
        "attested is true only while the router holds a fresh, verified enclave attestation for the route; only anonymo-sealed runs exclusively on such routes.",
        "weights_hash is null when the route record states none.",
      ],
      models,
    };
    if (!wantsHtml(c)) return c.json(doc, 200, { "cache-control": "public, max-age=60" });
    const rows = models.flatMap((m) => m.routes.map((r) => [m.id, r.upstream, r.family, r.quant ?? "", r.weights_hash ?? "", r.attested ? "yes" : "no"]));
    return c.html(page("Anonymo model manifest", `${doc.counts.models} models, ${doc.counts.routes} routes, ${doc.counts.attested_routes} attested now.`, ["Model", "Upstream", "Family", "Quant", "Weights hash", "Attested"], rows), 200, { "cache-control": "public, max-age=60" });
  });

  app.get("/leaderboard", async (c) => {
    await ctx.catalog.ensureFresh();
    const stats = await refusalStats30d(ctx);
    const familyOfModel = (id: string) => {
      const m = ctx.catalog.models.get(id);
      return m ? familyOf(m, ctx.catalog.offers(id)[0] as unknown as Record<string, unknown> | undefined) : familyOf({ id });
    };
    const routes = stats.routes
      .map((r) => ({ route: r.route, model: r.model, family: familyOfModel(r.model), total_30d: r.total, refused_30d: r.refused, refusal_rate_30d: rate(r) }))
      .sort((a, b) => (a.refusal_rate_30d ?? 1) - (b.refusal_rate_30d ?? 1) || b.total_30d - a.total_30d || a.route.localeCompare(b.route));
    const fam = new Map<string, { total: number; refused: number }>();
    for (const r of routes) {
      const f = fam.get(r.family) ?? { total: 0, refused: 0 };
      f.total += r.total_30d;
      f.refused += r.refused_30d;
      fam.set(r.family, f);
    }
    const families = [...fam.entries()].map(([family, x]) => ({ family, total_30d: x.total, refused_30d: x.refused, refusal_rate_30d: rate(x) })).sort((a, b) => (a.refusal_rate_30d ?? 1) - (b.refusal_rate_30d ?? 1) || a.family.localeCompare(b.family));
    const doc = { generated_at: new Date().toISOString(), window_days: 30, available: stats.available, routes, families };
    if (!wantsHtml(c)) return c.json(doc, 200, { "cache-control": "public, max-age=60" });
    const pct = (x: number | null) => (x == null ? "" : `${(x * 100).toFixed(2)}%`);
    return c.html(
      page("Anonymo refusal leaderboard", stats.available ? "Refused requests per route over the last 30 days. Counts only; no prompt or answer text is kept." : "No refusal counts yet.", ["Route", "Family", "Requests", "Refused", "Refusal rate"], routes.map((r) => [r.route, r.family, String(r.total_30d), String(r.refused_30d), pct(r.refusal_rate_30d)])),
      200,
      { "cache-control": "public, max-age=60" },
    );
  });
}

function wantsHtml(c: Context): boolean {
  const f = c.req.query("format");
  if (f === "json") return false;
  if (f === "html") return true;
  const accept = c.req.header("accept") ?? "";
  return accept.includes("text/html") && !accept.includes("application/json");
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** A minimal, script-free page: a heading, one line and a table. Every cell is escaped. */
function page(title: string, intro: string, head: string[], rows: string[][]): string {
  const th = head.map((h) => `<th>${esc(h)}</th>`).join("");
  const tr = rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:16px;color:#111;background:#fff}table{border-collapse:collapse;width:100%;overflow-x:auto;display:block}th,td{border-bottom:1px solid #ddd;padding:4px 8px;text-align:left;white-space:nowrap}code{font-size:12px}@media (prefers-color-scheme:dark){body{color:#eee;background:#111}th,td{border-color:#333}}</style></head>
<body><h1>${esc(title)}</h1><p>${esc(intro)} Adults only. <a href="?format=json">JSON</a></p><table><thead><tr>${th}</tr></thead><tbody>
${tr}
</tbody></table></body></html>`;
}
