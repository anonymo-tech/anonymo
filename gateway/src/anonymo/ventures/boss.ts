// WS11 · Boss Mo, the planner (Ventures Backend PART 1 and PART 14).
//
// Boss Mo turns a brief into a DAG of steps and splits the budget between them. The DAGs are fixed per mode, not
// improvised by a model: a plan that a model writes can't be trusted to keep the firewall (Scout → Spec Filter →
// everything else), and a fixed plan can be tested. The tier sets the fan-out (how many Builder Mos and families).
//
// Law 2 ("no ship without the gate") holds here: modes with a target (Build Better, Takeover Kit) have no deploy step,
// because the Similarity Gate is not built yet. Idea to Live and Fork & Flip have no target, and their deploy step
// still asks the gate (mos/deployer.ts), which checks every page for brand-login look-alikes.

import { TIER_RULES } from "./pricing.ts";
import type { StepTemplate } from "./orchestrator.ts";
import type { Tier, VentureMode } from "./types.ts";

const t = (s: Omit<StepTemplate, "fanout" | "select" | "zone" | "share"> & Partial<Pick<StepTemplate, "fanout" | "select" | "zone" | "share">>): StepTemplate => ({
  fanout: 1,
  select: "single",
  zone: "CLEAN",
  share: 0.08,
  ...s,
});

export type PlanOptions = { tier: Tier; deploy: boolean; hasTests?: boolean };

export function planVenture(mode: VentureMode, o: PlanOptions): StepTemplate[] {
  const rules = TIER_RULES[o.tier];
  const council = Math.min(3, rules.families);
  const builders = rules.builders;
  const mergeOrSingle = council > 1 ? "council-merge" : "single";
  const selectOrSingle = council > 1 ? "council-select" : "single";

  // The build loop every code-producing mode shares: tests first, then N builders, then the red team and licences.
  const buildLoop = (needs: string[], brief: "plan" | "parity"): StepTemplate[] => [
    t({ key: "tests", task: "tester.tests", role: "tester", kind: "code", needs, share: 0.1 }),
    t({ key: "build", task: "builder.app", role: "builder", kind: "code", fanout: builders, select: "tests", needs: ["tests", brief], share: 0.3 }),
    t({ key: "redteam", task: "redteam.scan", role: "red-team", kind: "scan", needs: ["build"], share: 0.05 }),
    t({ key: "licence", task: "licence.scan", role: "licence", kind: "scan", needs: ["build"], share: 0.01 }),
  ];

  switch (mode) {
    case "IDEA_TO_LIVE":
      return [
        t({ key: "research", task: "strategist.research", role: "strategist", kind: "research", fanout: council, select: mergeOrSingle, needs: [], share: 0.08 }),
        t({ key: "plan", task: "strategist.plan", role: "strategist", kind: "plan", fanout: council, select: mergeOrSingle, needs: ["research"], share: 0.08 }),
        t({ key: "design", task: "designer.system", role: "designer", kind: "design", needs: ["plan"], share: 0.03 }),
        t({ key: "copy", task: "adman.landing", role: "adman", kind: "copy", fanout: council, select: selectOrSingle, needs: ["plan"], share: 0.06 }),
        t({ key: "landing", task: "designer.landing", role: "designer", kind: "design", needs: ["design", "copy"], share: 0.01 }),
        t({ key: "ads", task: "adman.adkit", role: "adman", kind: "copy", fanout: council, select: selectOrSingle, needs: ["plan"], share: 0.06 }),
        t({ key: "launch", task: "strategist.launch", role: "strategist", kind: "plan", needs: ["plan", "ads"], share: 0.04, optional: true }),
        ...buildLoop(["plan"], "plan"),
        t({ key: "repo", task: "repo.commit", role: "boss", kind: "code", needs: ["build", "redteam", "landing", "licence", "design", "plan", "ads"], share: 0.01 }),
        ...(o.deploy ? [t({ key: "deploy", task: "deployer.static", role: "deployer", kind: "deploy", needs: ["repo", "landing"], share: 0.02, optional: true })] : []),
      ];
    case "BUILD_BETTER":
      return [
        t({ key: "scout", task: "scout.site", role: "scout", kind: "research", zone: "SCOUT", needs: [], share: 0.06 }),
        t({ key: "spec", task: "spec.filter", role: "spec-filter", kind: "spec", zone: "SCOUT", needs: ["scout"], share: 0.04 }),
        t({ key: "parity", task: "strategist.parity", role: "strategist", kind: "plan", fanout: council, select: mergeOrSingle, needs: ["spec"], share: 0.1 }),
        t({ key: "design", task: "designer.system", role: "designer", kind: "design", needs: ["parity"], share: 0.03 }),
        t({ key: "copy", task: "adman.landing", role: "adman", kind: "copy", fanout: council, select: selectOrSingle, needs: ["parity"], share: 0.05 }),
        t({ key: "landing", task: "designer.landing", role: "designer", kind: "design", needs: ["design", "copy"], share: 0.01 }),
        t({ key: "comparison", task: "adman.comparison", role: "adman", kind: "copy", fanout: council, select: selectOrSingle, needs: ["spec", "parity", "design"], share: 0.05 }),
        ...buildLoop(["parity"], "parity"),
        t({ key: "repo", task: "repo.commit", role: "boss", kind: "code", needs: ["build", "redteam", "landing", "licence", "design", "comparison", "parity"], share: 0.01 }),
      ];
    case "TAKEOVER":
      return [
        t({ key: "scout", task: "scout.site", role: "scout", kind: "research", zone: "SCOUT", needs: [], share: 0.08 }),
        t({ key: "spec", task: "spec.filter", role: "spec-filter", kind: "spec", zone: "SCOUT", needs: ["scout"], share: 0.04 }),
        t({ key: "parity", task: "strategist.parity", role: "strategist", kind: "plan", fanout: council, select: mergeOrSingle, needs: ["spec"], share: 0.1 }),
        t({ key: "design", task: "designer.system", role: "designer", kind: "design", needs: ["parity"], share: 0.03 }),
        t({ key: "comparison", task: "adman.comparison", role: "adman", kind: "copy", fanout: council, select: selectOrSingle, needs: ["spec", "parity", "design"], share: 0.08 }),
        t({ key: "switch", task: "adman.switch", role: "adman", kind: "copy", fanout: council, select: selectOrSingle, needs: ["spec", "parity", "design"], share: 0.08 }),
        t({ key: "ads", task: "adman.takeover-ads", role: "adman", kind: "copy", fanout: council, select: selectOrSingle, needs: ["spec", "parity"], share: 0.12 }),
        t({ key: "tests", task: "tester.import", role: "tester", kind: "code", needs: ["spec"], share: 0.08 }),
        t({ key: "build", task: "builder.import", role: "builder", kind: "code", fanout: builders, select: "tests", needs: ["tests", "spec"], share: 0.25 }),
        t({ key: "redteam", task: "redteam.scan", role: "red-team", kind: "scan", needs: ["build"], share: 0.03 }),
        t({ key: "licence", task: "licence.scan", role: "licence", kind: "scan", needs: ["build"], share: 0.01 }),
        t({ key: "repo", task: "repo.commit", role: "boss", kind: "code", needs: ["build", "redteam", "licence", "comparison", "switch", "ads", "design", "parity"], share: 0.01 }),
      ];
    case "FORK_FLIP":
      return [
        t({ key: "fork", task: "licence.fork", role: "licence", kind: "scan", needs: [], share: 0.02 }),
        t({ key: "plan", task: "strategist.fork-plan", role: "strategist", kind: "plan", fanout: council, select: mergeOrSingle, needs: ["fork"], share: 0.15 }),
        t({ key: "design", task: "designer.system", role: "designer", kind: "design", needs: ["plan"], share: 0.03 }),
        t({ key: "copy", task: "adman.landing", role: "adman", kind: "copy", fanout: council, select: selectOrSingle, needs: ["plan"], share: 0.06 }),
        t({ key: "landing", task: "designer.landing", role: "designer", kind: "design", needs: ["design", "copy"], share: 0.01 }),
        t({ key: "rebrand", task: "builder.rebrand", role: "builder", kind: "code", needs: ["fork", "design", "plan"], share: 0.05 }),
        t({ key: "redteam", task: "redteam.scan", role: "red-team", kind: "scan", needs: ["rebrand"], share: 0.03 }),
        t({ key: "repo", task: "repo.commit", role: "boss", kind: "code", needs: ["rebrand", "redteam", "landing", "design", "plan"], share: 0.01 }),
        ...(o.deploy ? [t({ key: "deploy", task: "deployer.static", role: "deployer", kind: "deploy", needs: ["repo", "landing", "fork"], share: 0.02, optional: true })] : []),
      ];
    case "DUPE_DROP":
      throw new Error("Dupe Drop is not built yet");
    case "RUN":
      return [];
  }
}

/** The Run Mode tasks a tick can run, and the step each one becomes. */
export const RUN_TASKS = ["watch", "improve", "ads", "brief"] as const;
export type RunTask = (typeof RUN_TASKS)[number];

export function runTickPlan(tick: number, tasks: readonly RunTask[], o: { hasTarget: boolean }): StepTemplate[] {
  const p = `t${tick}-`;
  const out: StepTemplate[] = [];
  if (tasks.includes("watch") && o.hasTarget) {
    out.push(t({ key: `${p}scout`, task: "scout.site", role: "scout", kind: "research", zone: "SCOUT", needs: [], share: 0.3 }));
    out.push(t({ key: `${p}spec`, task: "spec.filter", role: "spec-filter", kind: "spec", zone: "SCOUT", needs: [`${p}scout`], share: 0.1 }));
    out.push(t({ key: `${p}watch`, task: "run.watch", role: "strategist", kind: "plan", needs: [`${p}spec`], share: 0.1 }));
  }
  if (tasks.includes("improve")) out.push(t({ key: `${p}improve`, task: "run.improve", role: "strategist", kind: "plan", needs: [], share: 0.2, optional: true }));
  if (tasks.includes("ads")) out.push(t({ key: `${p}ads`, task: "run.ads", role: "adman", kind: "copy", needs: [], share: 0.15, optional: true }));
  if (tasks.includes("brief")) out.push(t({ key: `${p}brief`, task: "run.brief", role: "boss", kind: "plan", needs: out.filter((s) => s.key.endsWith("watch")).map((s) => s.key), share: 0.1, optional: true }));
  return out;
}
