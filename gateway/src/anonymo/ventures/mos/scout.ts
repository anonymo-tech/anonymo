// WS11 · Scout Mo (fedora) and the Spec Filter, as crew steps (Ventures Backend PART 4).
//
// scout.site runs in the SCOUT zone: it is the only step that gets the target url, it crawls logged-out, and everything
// it keeps is a SCOUT artifact. spec.filter reads those artifacts and writes exactly one thing across the firewall: the
// functional Spec (CLEAN), whose hash is the only link between what the scouts saw and what the builders build.

import { getArtifact } from "../store/artifacts.ts";
import { scoutSite, type BrowserDriver, type FetchLike, type ScoutAnalysis, type ScoutArtifact, type ScoutLimits } from "../scout/index.ts";
import { canonicalJson, filterSpec } from "../spec/index.ts";
import { ventureSpecs } from "../store/schema.ts";
import type { RoleHandler } from "../orchestrator.ts";
import type { ArtifactRef } from "../types.ts";

export type ScoutServices = { scoutFetch?: FetchLike; scoutLimits?: Partial<ScoutLimits>; scoutBrowser?: BrowserDriver | "auto" | null; scoutArchive?: boolean; sleep?: (ms: number) => Promise<void> };

type ManifestEntry = { ref: ArtifactRef; meta: Record<string, unknown> };

export const scout: RoleHandler = async (s) => {
  if (s.step.zone !== "SCOUT") throw new Error("scout.site must run in the SCOUT zone");
  if (!s.target) throw new Error("this venture has no target url");
  const svc = s.deps.services as ScoutServices;
  const res = await scoutSite({ url: s.target, fetch: svc.scoutFetch ?? (fetch as FetchLike), now: s.now, limits: svc.scoutLimits, browser: svc.scoutBrowser ?? null, archive: svc.scoutArchive ?? true, sleep: svc.sleep });
  const manifest: ManifestEntry[] = [];
  for (const a of res.artifacts) {
    const ref = await s.put({ kind: a.ref.kind, name: a.ref.name, mime: typeof a.meta.mime === "string" ? a.meta.mime : undefined, body: a.body });
    manifest.push({ ref, meta: a.meta });
  }
  await s.put({ kind: "report", name: "manifest", mime: "application/json", body: JSON.stringify(manifest) });
  await s.put({ kind: "report", name: "analysis", mime: "application/json", body: JSON.stringify(res.analysis) });
  await s.put({ kind: "report", name: "stops", mime: "application/json", body: JSON.stringify(res.stops) });
  s.log(`scouted ${res.analysis.pages.length} pages, ${res.analysis.bundles.length} bundles, ${res.analysis.apis.length} API calls; ${res.stops.length} stop(s)`);
};

export const specFilter: RoleHandler = async (s) => {
  const refs = Object.values(s.needs).flat();
  const manifestRef = refs.find((r) => r.name === "manifest");
  const analysisRef = refs.find((r) => r.name === "analysis");
  if (!manifestRef || !analysisRef) throw new Error("spec.filter needs a scout step's manifest and analysis");
  const manifest = await s.json<ManifestEntry[]>(manifestRef);
  const analysis = await s.json<ScoutAnalysis>(analysisRef);
  const artifacts: ScoutArtifact[] = [];
  for (const m of manifest) {
    const a = await getArtifact(s.ctx.db, s.venture.id, m.ref.sha256, "SCOUT");
    if (a?.body != null) artifacts.push({ ref: m.ref, body: a.body, meta: m.meta });
  }
  const out = await filterSpec(analysis, artifacts, { now: s.now });
  const body = canonicalJson(out.spec);
  const ref = await s.put({ kind: "spec", name: "spec", mime: "application/json", body, zone: "CLEAN" });
  if (ref.sha256 !== out.specHash) s.log("note: stored spec bytes hash differently from specHash; the stored hash is the one that crosses");
  await s.put({ kind: "report", name: "leakage", mime: "application/json", body: JSON.stringify(out.leakageScan), zone: "CLEAN" });
  await s.ctx.db.insert(ventureSpecs).values({ sha256: ref.sha256, ventureId: s.venture.id, leakageScan: out.leakageScan }).onConflictDoNothing();
  s.log(`spec ${ref.sha256.slice(0, 12)}…: ${out.spec.features.length} features, ${out.spec.apis.length} API shapes, leakage scan clean (${out.leakageScan.spans} span(s) removed)`);
};
