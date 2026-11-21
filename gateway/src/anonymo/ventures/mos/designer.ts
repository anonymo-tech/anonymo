// WS11 · Designer Mo (beanie): a fresh design system for every venture, measurably different from every earlier one
// (Ventures Backend PART 11 "uniqueness check vs gallery"), and the pages rendered with it.

import { desc } from "drizzle-orm";
import { designVenture, renderLanding, type DesignSystem, type LandingContent } from "../design/index.ts";
import type { RoleHandler } from "../orchestrator.ts";
import { ventureDesigns } from "../store/schema.ts";
import type { VenturePlan } from "./strategist.ts";

const GALLERY = 200;

export const designSystem: RoleHandler = async (s) => {
  const planRef = s.needs.plan?.find((r) => r.name === "plan") ?? s.needs.parity?.find((r) => r.name === "plan");
  const plan = planRef ? await s.json<VenturePlan>(planRef) : null;
  const gallery = (await s.ctx.db.select({ system: ventureDesigns.system }).from(ventureDesigns).orderBy(desc(ventureDesigns.createdAt)).limit(GALLERY)).map((r) => r.system as DesignSystem);
  const avoid = [s.input.rival].filter((x): x is string => typeof x === "string" && !!x.trim());
  const result = await designVenture({ seed: s.venture.id, brief: [s.input.brief, plan?.positioning].filter(Boolean).join("\n"), avoidNames: avoid, gallery, llm: s.llm, model: s.pool[0]?.model });
  await s.ctx.db.insert(ventureDesigns).values({ ventureId: s.venture.id, system: result.system }).onConflictDoNothing();
  await s.put({ kind: "design", name: "design", mime: "application/json", body: JSON.stringify(result.system) });
  await s.put({ kind: "design", name: "css", mime: "text/css", body: result.css });
  await s.put({ kind: "design", name: "preview", mime: "text/html", body: result.preview });
  await s.put({ kind: "design", name: "brand", mime: "application/json", body: JSON.stringify(result.brand) });
  s.log(`design system ${result.system.name}: ${result.uniqueness.attempts} attempt(s), distance ${result.uniqueness.distance.toFixed(1)} from the gallery`);
};

export const landingPage: RoleHandler = async (s) => {
  const ds = await s.json<DesignSystem>(s.need("design", "design"));
  const copy = await s.json<LandingContent>(s.need("copy", "landing-copy"));
  await s.put({ kind: "page", name: "landing", mime: "text/html", body: renderLanding(ds, copy) });
};
