// WS11 · Licence engine: the Fork & Flip policy (Ventures Backend spec, PART 6).
//
//   permissive (MIT, BSD, Apache-2.0, ISC, Unlicense, 0BSD, Zlib, CC0)  allow; keep notices; NOTICE generated
//   MPL-2.0, LGPL-2.1 / 3.0                                               allow with file / library obligations
//   GPL-2.0 / 3.0                                                         only if the venture repo is GPL
//   AGPL-3.0, SSPL                                                        only with publishSource; "source" link
//   BUSL, Elastic-2.0, Commons Clause, PolyForm, non-commercial, none     not forkable: clean-room rebuild
//   known or detected dual-licence projects                               manual choice
//
// `decide` is pure. An OR picks the most permissive option the venture may use; an AND takes the strictest part; the
// overall decision is the AND of every component and of every file whose own licence its component does not cover.

import { LINKING_EXCEPTIONS, RESTRICTING_EXCEPTIONS, licenceClass, type LicenceClass } from "./catalog.ts";
import { LICENCE_FILE } from "./detect.ts";
import { formatSpdx, spdxLeaves, tryParseSpdx, type SpdxLicence, type SpdxNode } from "./spdx.ts";
import type { ComponentDecision, Decision, DecisionInput, LicenceComponent, LicenceDecision, LicenceReport, Verdict } from "./types.ts";

export const VERDICT_RANK: Readonly<Record<Verdict, number>> = {
  allow: 0,
  "allow-with-obligations": 1,
  "needs-gpl-repo": 2,
  "needs-publish-source": 3,
  manual: 4,
  "clean-room": 5,
};

const stricter = (a: Verdict, b: Verdict) => (VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b);
const uniq = (xs: string[]) => [...new Set(xs)];

/** Whether a GPL component may go into a repo published under repoLicence (version compatibility included). */
export function gplRepoAccepts(componentId: string, repoLicence: string): boolean {
  const repo = tryParseSpdx(repoLicence);
  if (!repo) return false;
  const ids = spdxLeaves(repo).map((l) => l.id);
  const any = (...accepted: string[]) => ids.some((id) => accepted.includes(id));
  switch (componentId) {
    // GPL-2.0-only code pins the whole repo to version 2: a repo declared "or later" could not honour that.
    case "GPL-2.0-only":
      return any("GPL-2.0-only");
    case "GPL-2.0-or-later":
      return any("GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later", "AGPL-3.0-only", "AGPL-3.0-or-later");
    case "GPL-3.0-only":
    case "GPL-3.0-or-later":
      return any("GPL-3.0-only", "GPL-3.0-or-later", "AGPL-3.0-only", "AGPL-3.0-or-later");
    default:
      return false;
  }
}

type Evaluated = Decision & { effective: SpdxNode | null };

const result = (verdict: Verdict, effective: SpdxNode | null, parts: Partial<Decision> = {}): Evaluated => ({
  verdict,
  obligations: parts.obligations ?? [],
  sourceLinkRequired: parts.sourceLinkRequired ?? false,
  reasons: parts.reasons ?? [],
  effective,
});

function leaf(node: SpdxLicence, input: DecisionInput): Evaluated {
  const label = formatSpdx(node);
  let cls: LicenceClass = licenceClass(node.id);
  if (node.exception) {
    if (RESTRICTING_EXCEPTIONS.includes(node.exception)) return result("clean-room", null, { reasons: [`${label}: the exception restricts commercial use, so it is not forkable`] });
    if (!LINKING_EXCEPTIONS.includes(node.exception)) return result("manual", node, { reasons: [`${label}: unknown licence exception, needs a manual reading`] });
    if (cls === "gpl") cls = "weak-copyleft";
  }
  switch (cls) {
    case "permissive": {
      const obligations = [`${label}: keep the copyright and licence notices (NOTICE)`];
      if (node.id === "Apache-2.0") obligations.push(`${label}: carry the upstream NOTICE file and mark files you change`);
      return result("allow", node, { obligations, reasons: [`${label} is permissive`] });
    }
    case "weak-copyleft": {
      const obligation = node.id === "MPL-2.0"
        ? `${label}: file-level copyleft, modified MPL files stay MPL-2.0 and their source is published`
        : node.exception
          ? `${label}: linking exception, keep the library's source and licence available and changes to it under its licence`
          : `${label}: library-level copyleft, ship it as a separately replaceable library and provide its source and licence text`;
      return result("allow-with-obligations", node, { obligations: [obligation], reasons: [`${label} is weak copyleft`] });
    }
    case "gpl":
      if (gplRepoAccepts(node.id, input.repoLicence))
        return result("allow-with-obligations", node, {
          obligations: [`${label}: publish the venture repo's complete source under ${input.repoLicence} and keep the GPL notices`],
          reasons: [`${label} fits the venture repo licence ${input.repoLicence}`],
        });
      return result("needs-gpl-repo", node, { reasons: [`${label} needs the venture repo published under a compatible GPL (it is ${input.repoLicence || "unset"})`] });
    case "network-copyleft":
      if (input.publishSource)
        return result("allow-with-obligations", node, {
          obligations: [`${label}: publish the complete corresponding source of the deployed app under ${node.id} terms`, `${label}: the deployed app links to that source ("source")`],
          sourceLinkRequired: true,
          reasons: [`${label} is network copyleft and the venture publishes its source`],
        });
      return result("needs-publish-source", node, { reasons: [`${label} is network copyleft: allowed only with publishSource`] });
    case "unforkable":
      return result("clean-room", null, { reasons: [`${label} is not forkable (source-available, non-commercial, proprietary or unknown)`] });
  }
}

function evaluate(node: SpdxNode, input: DecisionInput): Evaluated {
  if (node.type === "licence") return leaf(node, input);
  const parts = node.args.map((a) => evaluate(a, input));
  if (node.type === "or") {
    let best = parts[0];
    for (const p of parts.slice(1)) if (VERDICT_RANK[p.verdict] < VERDICT_RANK[best.verdict]) best = p;
    const chosen = best.effective ? formatSpdx(best.effective) : null;
    return { ...best, reasons: uniq([...(chosen ? [`chose ${chosen} from ${formatSpdx(node)}`] : []), ...best.reasons]) };
  }
  const verdict = parts.map((p) => p.verdict).reduce(stricter);
  const effective = verdict === "clean-room" || parts.some((p) => !p.effective) ? null : ({ type: "and", args: parts.map((p) => p.effective!) } as SpdxNode);
  return {
    verdict,
    obligations: uniq(parts.flatMap((p) => p.obligations)),
    sourceLinkRequired: parts.some((p) => p.sourceLinkRequired),
    reasons: uniq(parts.flatMap((p) => p.reasons)),
    effective,
  };
}

/** The decision for one licence expression (null means no licence at all). */
export function decideExpression(spdx: string | null, input: DecisionInput): Decision & { effective: string | null } {
  if (!spdx) return { verdict: "clean-room", obligations: [], sourceLinkRequired: false, reasons: ["no licence: all rights reserved by default"], effective: null };
  const node = tryParseSpdx(spdx);
  if (!node) return { verdict: "clean-room", obligations: [], sourceLinkRequired: false, reasons: [`unreadable licence expression "${spdx}"`], effective: null };
  const e = evaluate(node, input);
  return { verdict: e.verdict, obligations: e.obligations, sourceLinkRequired: e.sourceLinkRequired, reasons: e.reasons, effective: e.effective ? formatSpdx(e.effective) : null };
}

function decideComponent(c: Pick<LicenceComponent, "name" | "path" | "spdx">, input: DecisionInput, dual: string | undefined): ComponentDecision {
  const d = decideExpression(c.spdx, input);
  if (dual && VERDICT_RANK[d.verdict] < VERDICT_RANK.manual) {
    return { ...d, verdict: "manual", reasons: [`dual licence, pick one deliberately: ${dual}`, ...d.reasons], name: c.name, path: c.path, spdx: c.spdx };
  }
  return { ...d, name: c.name, path: c.path, spdx: c.spdx };
}

const covers = (component: string | null, file: string) => {
  const c = tryParseSpdx(component);
  const f = tryParseSpdx(file);
  if (!c || !f) return false;
  const ids = new Set(spdxLeaves(c).map((l) => formatSpdx(l)));
  return spdxLeaves(f).every((l) => ids.has(formatSpdx(l)));
};

/** The Fork & Flip decision for a scanned repo: per component (and per stray file licence), then overall. */
export function decide(report: Pick<LicenceReport, "components" | "files" | "dualLicence">, input: DecisionInput): LicenceDecision {
  const dualOf = new Map<string, string>();
  for (const d of report.dualLicence) dualOf.set(d.name, dualOf.has(d.name) ? `${dualOf.get(d.name)}; ${d.reason}` : d.reason);
  const components = report.components.map((c) => decideComponent(c, input, dualOf.get(c.name)));

  // A file whose own SPDX header names a licence its component does not (a GPL file vendored into an MIT tree).
  const byDepth = [...report.components].sort((a, b) => b.path.length - a.path.length);
  const owner = (path: string) => byDepth.find((c) => c.path === "." || path === c.path || path.startsWith(`${c.path}/`));
  for (const f of report.files) {
    if (!f.spdx || LICENCE_FILE.test(f.path.split("/").pop() ?? "")) continue;
    const c = owner(f.path);
    if (c && covers(c.spdx, f.spdx)) continue;
    components.push(decideComponent({ name: `${c?.name ?? "."}:${f.path}`, path: f.path, spdx: f.spdx }, input, undefined));
  }

  if (!components.length) return { verdict: "clean-room", obligations: [], sourceLinkRequired: false, reasons: ["nothing was scanned"], components };
  const verdict = components.map((c) => c.verdict).reduce(stricter);
  const deciding = components.filter((c) => c.verdict === verdict);
  return {
    verdict,
    obligations: uniq(components.flatMap((c) => c.obligations.map((o) => `${c.name}: ${o}`))),
    sourceLinkRequired: components.some((c) => c.sourceLinkRequired),
    reasons: uniq(deciding.flatMap((c) => c.reasons.map((r) => `${c.name}: ${r}`))),
    components,
  };
}
