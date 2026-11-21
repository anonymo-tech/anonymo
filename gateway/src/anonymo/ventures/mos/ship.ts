// WS11 · committing the venture's repo and deploying its static site (Ventures Backend PART 7, Laws 2 and 8).
//
// Law 2, "no ship without the gate": the deploy step asks a SimilarityGate first. The full gate (code, text, layout,
// visual, logo/name signals) is a later milestone, so the gate shipped here is deliberately strict: anything built
// from a target is BLOCKED outright, and for target-free ventures (Idea to Live, Fork & Flip) every page is checked for
// password and wallet-seed fields, which are blocked always (the brand-login rule, without needing a brand list).

import { eq } from "drizzle-orm";
import { uid } from "../../../lib/util.ts";
import { arweaveUploaderFor, deployConfigFromEnv, deployStatic, type Deployment } from "../deploy/index.ts";
import type { RoleHandler, StepContext, VentureRow } from "../orchestrator.ts";
import { commitFiles } from "../repo.ts";
import { deployCostUsd } from "../pricing.ts";
import { ventureDeployments, ventures } from "../store/schema.ts";
import type { ArtifactRef } from "../types.ts";
import type { FileMap } from "./build.ts";
import type { VenturePlan } from "./strategist.ts";

export type GateVerdict = { verdict: "PASS" | "BLOCK"; reasons: string[] };
export type SimilarityGate = (v: Pick<VentureRow, "id" | "targetCommit" | "mode">, site: FileMap) => Promise<GateVerdict>;

const CREDENTIAL_FIELD = /<input[^>]*type\s*=\s*["']?password|\b(?:seed phrase|recovery phrase|mnemonic|private key|secret recovery)\b/i;

/** The strict pre-gate (see the file comment). */
export const strictGate: SimilarityGate = async (v, site) => {
  const reasons: string[] = [];
  if (v.targetCommit) reasons.push("built from a target: the Similarity Gate (code, text, layout, visual, logo and name signals) must pass first, and it is not built yet");
  for (const [p, body] of Object.entries(site)) if (/\.html?$/.test(p) && CREDENTIAL_FIELD.test(body)) reasons.push(`${p} has a password or wallet-seed field (brand-login rule: always blocked)`);
  return { verdict: reasons.length ? "BLOCK" : "PASS", reasons };
};

/** Adds a visible "Source code" link before </body> (or at the end). */
export function injectSourceLink(html: string, url: string): string {
  const esc = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const link = `<p style="text-align:center;margin:24px 0;font:14px system-ui"><a href="${esc}" rel="noopener">Source code</a> (this app's licence requires it)</p>`;
  return html.includes("</body>") ? html.replace("</body>", `${link}</body>`) : html + link;
}

export type ShipServices = { repoRoot?: string; deployEnv?: Record<string, string | undefined>; deployFetch?: typeof fetch; gate?: SimilarityGate; sleep?: (ms: number) => Promise<unknown> };

const MIT = (year: number, holder: string) =>
  `MIT License\n\nCopyright (c) ${year} ${holder}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n`;

/** Which artifact goes where in the repo. Pages land under site/, everything for people under docs/ and marketing/. */
const PLACES: Record<string, string> = {
  landing: "site/index.html",
  comparison: "site/compare.html",
  alternative: "site/alternative.html",
  preview: "design/preview.html",
  css: "design/tokens.css",
  design: "design/system.json",
  brand: "design/brand.json",
  plan: "docs/plan.json",
  launch: "docs/launch-plan.json",
  research: "docs/research.json",
  "test-report": "docs/test-report.json",
  redteam: "docs/red-team.json",
  licence: "docs/licence-report.json",
  notice: "NOTICE",
  adkit: "marketing/ad-kit.json",
  ads: "marketing/ads.json",
  switch: "marketing/switch-offer.json",
  "comparison-claims": "marketing/comparison-claims.json",
  "landing-copy": "marketing/landing-copy.json",
};

async function collect(s: StepContext, refs: ArtifactRef[]): Promise<FileMap> {
  const files: FileMap = {};
  for (const r of refs) {
    if (r.zone !== "CLEAN" || !r.name) continue;
    if (r.name === "code") Object.assign(files, await s.json<FileMap>(r));
    else if (PLACES[r.name]) files[PLACES[r.name]!] = await s.text(r);
  }
  return files;
}

export const commitRepo: RoleHandler = async (s) => {
  const refs = Object.values(s.needs).flat();
  const files = await collect(s, refs);
  const planRef = refs.find((r) => r.name === "plan");
  const plan = planRef ? await s.json<VenturePlan>(planRef) : null;
  const brand = s.input.brand || plan?.name || "venture";
  if (!Object.keys(files).some((p) => /^(?:LICENSE|LICENCE|COPYING)/i.test(p))) files.LICENSE = MIT(s.now().getUTCFullYear(), `${brand} contributors`);
  files["README.md"] ??= [`# ${brand}`, "", plan?.positioning ?? s.input.brief, "", "## What's here", "", ...Object.keys(files).sort().map((p) => `- \`${p}\``), "", "Built by the Anonymo Ventures crew. Every step's models, routes and costs are in the run's receipts."].join("\n") + "\n";
  files["package.json"] ??= JSON.stringify({ name: brand.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "venture", private: true, type: "module", license: "MIT", scripts: { test: "bun test" } }, null, 2) + "\n";
  const sha = await commitFiles((s.deps.services as ShipServices).repoRoot, s.venture.id, files, `${s.venture.mode.toLowerCase().replaceAll("_", " ")}: ${brand}`);
  await s.ctx.db.update(ventures).set({ repoUrl: `/v1/ventures/${s.venture.id}/export` }).where(eq(ventures.id, s.venture.id));
  await s.put({ kind: "repo", name: "repo", mime: "application/json", body: JSON.stringify({ commit: sha, files: Object.keys(files).sort() }) });
  s.log(`repo commit ${sha.slice(0, 10)} with ${Object.keys(files).length} files`);
};

export const deploySite: RoleHandler = async (s) => {
  const svc = s.deps.services as ShipServices;
  const refs = Object.values(s.needs).flat();
  const all = await collect(s, refs);
  const site: FileMap = Object.fromEntries(Object.entries(all).filter(([p]) => p.startsWith("site/")).map(([p, b]) => [p.slice(5), b]));
  if (!site["index.html"]) throw new Error("no site/index.html to deploy");
  // AGPL/SSPL forks (Backend PART 6): the deployed app must link to its source. No public source url, no deploy.
  const forkRef = refs.find((r) => r.name === "fork");
  const sourceLinkRequired = forkRef ? !!(await s.json<{ plan?: { sourceLinkRequired?: boolean } }>(forkRef)).plan?.sourceLinkRequired : false;
  if (sourceLinkRequired) {
    const url = typeof s.input.sourceUrl === "string" ? s.input.sourceUrl : "";
    if (!/^https:\/\/[^\s"'<>]+$/.test(url)) throw new Error("this fork's licence requires a public source link: start the run with source_url (the public repo)");
    for (const [p, body] of Object.entries(site)) if (/\.html?$/.test(p)) site[p] = injectSourceLink(body, url);
  }
  const gate = await (svc.gate ?? strictGate)(s.venture, site);
  await s.put({ kind: "report", name: "gate", mime: "application/json", body: JSON.stringify(gate) });
  if (gate.verdict !== "PASS") throw new Error(`Similarity Gate: BLOCK (${gate.reasons.join("; ")})`);
  const cfg = deployConfigFromEnv(svc.deployEnv ?? process.env);
  const [a, b] = cfg.pinners;
  if (!a || !b || !cfg.gateways?.length) throw new Error("deploys are not configured on this gateway (two IPFS pinning services and a gateway are needed)");
  // Two pins and an Arweave copy cost real money: they come out of the run's budget, or the deploy doesn't happen.
  if (!(await s.charge(deployCostUsd(svc.deployEnv ?? process.env), "deploy"))) throw new Error("not enough budget left in this run to pay for the deploy");
  const [prev] = await s.ctx.db.select().from(ventureDeployments).where(eq(ventureDeployments.ventureId, s.venture.id));
  const d: Deployment = await deployStatic({
    ventureId: s.venture.id,
    files: site,
    pinners: [a, b],
    arweave: arweaveUploaderFor(cfg, { fetch: svc.deployFetch }),
    names: { ...(s.input.deploy?.domain ? { dnslink: { domain: s.input.deploy.domain } } : {}), ...(s.input.deploy?.ens ? { ens: { name: s.input.deploy.ens, resolver: String(s.input.deploy.ensResolver ?? "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63") } } : {}), ...(s.input.deploy?.arns ? { arns: { name: s.input.deploy.arns } } : {}) },
    gateways: cfg.gateways,
    previous: prev ? (prev.details as Deployment) : undefined,
    fetch: svc.deployFetch,
    now: s.now,
    sleep: svc.sleep,
  });
  await s.ctx.db.insert(ventureDeployments).values({ id: uid("dep_"), ventureId: s.venture.id, target: "ipfs", cid: d.cid, url: d.urls[0] ?? null, status: d.status, details: d });
  await s.put({ kind: "report", name: "deployment", mime: "application/json", body: JSON.stringify(d) });
  s.log(`deploy ${d.status}: ${d.cid}`);
  if (d.status === "failed") throw new Error(`deploy failed: ${d.problems.join("; ")}`);
};
