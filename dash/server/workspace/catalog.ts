import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { featureOn } from "../../components/dashboard/feature-switches.ts";
import { installReviewedRosters } from "../crosscheck/registry.ts";
import { fetchMediaCatalog, installReviewedMediaRoutes } from "../media/registry.ts";
import { PPQ_MODEL_ALLOWLIST } from "../ppq/catalog.ts";

export async function refreshWorkspaceCatalog(pool: Pool) {
  const now = new Date().toISOString();
  if (featureOn("crosscheck")) {
    const existing = await pool.query(
      "SELECT id FROM crosscheck_rosters WHERE enabled AND expires_at>now()+interval '4 hours'",
    );
    if (!existing.rowCount) {
      const families = ["gpt", "deepseek", "llama"];
      const routes = (
        await pool.query(
          "SELECT DISTINCT ON(route_id) id,family,model_id,expires_at FROM route_versions WHERE family=ANY($1::text[]) AND modality='chat' AND enabled AND expires_at>now() ORDER BY route_id,version DESC",
          [families],
        )
      ).rows;
      const chosen = families.map((f) => routes.find((r) => r.family === f));
      if (chosen.some((r) => !r)) throw Error("CROSSCHECK_ROUTES_UNAVAILABLE");
      const version = Number(
        (
          await pool.query(
            "SELECT COALESCE(max(version),0)+1 AS version FROM crosscheck_rosters WHERE label='Conclave three-model review'",
          )
        ).rows[0].version,
      );
      await installReviewedRosters(
        pool,
        {
          version: 1,
          rosters: [
            {
              id: randomUUID(),
              label: "Conclave three-model review",
              version,
              reviewed: true,
              reviewedAt: now,
              expiresAt: new Date(
                Math.min(Date.now() + 23 * 3600000, ...chosen.map((r) => r.expires_at.getTime())),
              ).toISOString(),
              enabled: true,
              reviewers: chosen.map((r) => ({
                routeVersionId: r.id,
                family: r.family,
                modelId: r.model_id,
                modelVersion: r.model_id,
                distribution: r.family === "gpt" ? "proprietary" : "open-weight",
              })),
            },
          ],
        },
        { enableReviewed: true },
      );
    }
  }
  if (featureOn("studio")) {
    const existing = (
      await pool.query(
        "SELECT DISTINCT ON(route_id) family,version,expires_at,pricing FROM route_versions WHERE route_id LIKE 'studio-%' ORDER BY route_id,version DESC",
      )
    ).rows;
    if (
      ["runway", "veo", "image"].every((f) =>
        existing.some((r) => r.family === f && r.expires_at.getTime() > Date.now() + 8 * 3600000 &&
          (f === "image" || r.pricing?.variants?.length === (f === "runway" ? 1 : 2))),
      )
    )
      return;
    const catalog = await fetchMediaCatalog();
    const definitions = [
      {
        family: "runway",
        origin: "https://help.runwayml.com",
        terms:
          "https://help.runwayml.com/hc/en-us/articles/21668707517587-Can-I-use-the-content-I-made-in-Runway-for-commercial-purposes",
        // Verified live output: other advertised formats currently default to
        // this format upstream. Restore them only after exact output verification.
        variants: [{ kind: "video", duration: 5, quality: "720p", aspectRatio: "16:9" }],
      },
      {
        family: "veo",
        origin: "https://cloud.google.com",
        terms: "https://cloud.google.com/terms/service-terms",
        variants: ["16:9", "9:16"].map((aspectRatio) => (
          { kind: "video", duration: 8, quality: "standard", aspectRatio }
        )),
      },
      {
        family: "image",
        origin: "https://cloud.google.com",
        terms: "https://cloud.google.com/terms/service-terms",
        variants: [{ kind: "image", count: 1, resolution: "1K", aspectRatio: "1:1" }],
      },
    ];
    const at = catalog.fetchedAt;
    const routes = definitions.map((d) => {
      const model = catalog.models.find((m) => m.family === d.family);
      if (!model) throw Error("MEDIA_PRICE_UNAVAILABLE");
      const variants = d.variants.map((options) => {
        const quality = "quality" in options ? options.quality : "standard";
        const size = "resolution" in options ? options.resolution : `${options.aspectRatio}_${options.duration}`;
        const price = model.pricing.variants.find((p) => p.quality === quality && p.size === size);
        if (!price) throw Error("MEDIA_PRICE_UNAVAILABLE");
        return { options, providerUsd6: String(price.usd6), catalogQuality: quality, catalogSize: size };
      });
      return {
        id: randomUUID(),
        routeId: `studio-${d.family}`,
        version: (existing.find((r) => r.family === d.family)?.version ?? 0) + 1,
        modelId: PPQ_MODEL_ALLOWLIST[d.family as keyof typeof PPQ_MODEL_ALLOWLIST].id,
        family: d.family,
        modality: model.modality,
        enabled: true,
        expiresAt: new Date(Date.parse(at) + 23 * 3600000).toISOString(),
        card: {
          level: "unverified",
          reviewed: true,
          provider: "ppq",
          upstreamProviders: ["Model host"],
          plaintextVisibility: "gateway_and_upstream",
          retentionDays: null,
          trainingUse: "unknown",
          jurisdiction: null,
          legalHold: "unknown",
          retentionDisclosure:
            "The inference gateway and model host receive the prompt in plaintext. Retention, training use and jurisdiction have not been independently verified.",
          evidenceUrl: "https://ppq.ai/terms",
          upstreamEvidenceUrls: [d.terms],
          evidenceDate: at.slice(0, 10),
          lastVerifiedAt: at,
          mediaTerms: {
            reviewed: true,
            commercialUse: "allowed",
            evidenceUrls: ["https://ppq.ai/terms", d.terms],
            reviewedAt: at,
          },
        },
        pricing: {
          kind: "media-fixed-v1",
          maxInputBytes: 16000,
          markupBps: 0,
          variants,
        },
      };
    });
    await installReviewedMediaRoutes(
      pool,
      { version: 1, routes },
      { enableReviewed: true, catalog },
    );
  }
}
