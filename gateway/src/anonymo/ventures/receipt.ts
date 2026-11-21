// WS11 · the run's receipt bundle (Ventures Overview §4 "Clean-Room Receipts", Backend PART 10 CleanRoomRegistry).
//
// Every run returns a receipt showing every model route, every candidate, every sandbox charge and the hashes of what
// each zone saw. The clean-room root is the Merkle root (sorted-pair keccak256, as the hourly receipt roots) of
//   {scoutArtifactHashes, specHash, sandboxPolicyHash, builderArtifactHashes, gateReportHash, licenceReportHash}.
// Anchoring that root on chain (CleanRoomRegistry) is a later milestone; the root and the bundle are computed now, so
// anyone can re-derive the root from an exported bundle.

import { eq } from "drizzle-orm";
import { keccak256, toBytes, type Hex } from "viem";
import type { Ctx } from "../../context.ts";
import { MerkleTree } from "../../receipts/merkle.ts";
import { defaultBuilderPolicy, policyHash } from "./sandbox/index.ts";
import { ventureArtifacts, ventureCandidates, ventureLicenceReports, ventureSpecs, ventureSteps, ventures } from "./store/schema.ts";

export type CleanRoomParts = { scoutArtifactHashes: string[]; specHash: string | null; sandboxPolicyHash: string; builderArtifactHashes: string[]; gateReportHash: string | null; licenceReportHash: string | null };

const leaf = (label: string, value: string) => keccak256(toBytes(`${label}:${value}`));

export function cleanRoomLeaves(p: CleanRoomParts): Hex[] {
  return [
    leaf("scout", [...p.scoutArtifactHashes].sort().join(",")),
    leaf("spec", p.specHash ?? ""),
    leaf("sandbox", p.sandboxPolicyHash),
    leaf("builder", [...p.builderArtifactHashes].sort().join(",")),
    leaf("gate", p.gateReportHash ?? ""),
    leaf("licence", p.licenceReportHash ?? ""),
  ];
}

export const cleanRoomRoot = (p: CleanRoomParts): Hex => new MerkleTree(cleanRoomLeaves(p)).root;

export async function receiptBundle(ctx: Ctx, ventureId: string) {
  const [v] = await ctx.db.select().from(ventures).where(eq(ventures.id, ventureId));
  if (!v) return null;
  const steps = await ctx.db.select().from(ventureSteps).where(eq(ventureSteps.ventureId, ventureId)).orderBy(ventureSteps.position);
  const arts = await ctx.db.select({ sha: ventureArtifacts.sha256, zone: ventureArtifacts.zone, kind: ventureArtifacts.kind, name: ventureArtifacts.name }).from(ventureArtifacts).where(eq(ventureArtifacts.ventureId, ventureId));
  const cands = await ctx.db.select().from(ventureCandidates).where(eq(ventureCandidates.ventureId, ventureId));
  const [spec] = await ctx.db.select({ sha: ventureSpecs.sha256 }).from(ventureSpecs).where(eq(ventureSpecs.ventureId, ventureId));
  const lic = await ctx.db.select({ sha: ventureLicenceReports.buildSha }).from(ventureLicenceReports).where(eq(ventureLicenceReports.ventureId, ventureId));
  const gate = arts.find((a) => a.name === "gate");
  const builderSteps = new Set(steps.filter((s) => s.role === "builder" || s.role === "tester").map((s) => s.key));
  const builderHashes = steps.filter((s) => builderSteps.has(s.key)).flatMap((s) => ((s.outputs as { sha256: string }[]) ?? []).map((o) => o.sha256));
  const parts: CleanRoomParts = {
    scoutArtifactHashes: arts.filter((a) => a.zone === "SCOUT").map((a) => a.sha),
    specHash: spec?.sha ?? null,
    // The policy every builder sandbox ran under, minus the deny list (which names the target's hosts).
    sandboxPolicyHash: policyHash({ ...defaultBuilderPolicy({ gatewayHost: process.env.VENTURES_GATEWAY_HOST ?? "anonymo.tech", targetHosts: [] }) }),
    builderArtifactHashes: builderHashes,
    gateReportHash: gate?.sha ?? null,
    licenceReportHash: lic.at(-1)?.sha ?? null,
  };
  const usd = (p: bigint) => Number(p) / 1e12;
  return {
    venture: { id: v.id, mode: v.mode, status: v.status, target_commit: v.targetCommit, price_usd: usd(v.priceUsd), cost_usd: usd(v.costUsd) },
    steps: steps.map((s) => ({ key: s.key, role: s.role, zone: s.zone, state: s.state, cost_usd: usd(s.costUsd), receipts: s.receiptIds, outputs: s.outputs })),
    candidates: cands.map((c) => ({ step: steps.find((s) => s.id === c.stepId)?.key ?? null, family: c.family, model: c.model, pass_rate: c.passRate, chosen: c.chosen, refused: c.refused, receipt_id: c.receiptId, cost_usd: usd(c.costUsd) })),
    clean_room: { ...parts, root: cleanRoomRoot(parts), anchored: false, note: "Anchoring on CleanRoomRegistry is a later milestone; recompute the root from these parts with cleanRoomRoot()." },
    receipts_api: "/v1/receipts/{id}",
  };
}
