// WS11 · Strategist Mo (cape): research, plan, the Parity+ matrix, pricing and the launch plan (Ventures Overview §2–3).
//
// Plans are merged by the council (select "council-merge"); the Strategist never sees the target, only the Spec.
// Every plan carries `mvpFeatures`, each with acceptance criteria: those criteria are what Tester Mo turns into tests.

import { askJson } from "../crew/ask.ts";
import type { ChatMessage } from "../llm.ts";
import type { RoleHandler, StepContext } from "../orchestrator.ts";
import { COPY_RULES_PROMPT } from "../copy.ts";
import type { Spec } from "../types.ts";

export type MvpFeature = { id: string; title: string; description: string; acceptance: string[] };
export type VenturePlan = {
  name?: string;
  positioning: string;
  audience: string;
  problem: string;
  mvpFeatures: MvpFeature[];
  pricing: { name: string; priceUsdMonthly: number | null; features: string[] }[];
  launch?: string[];
  /** Build Better / Takeover: the Parity+ matrix. */
  parity?: { feature: string; theirs: boolean; ours: "parity" | "better" | "new"; note: string }[];
  gaps?: string[];
  priceUnder?: { theirTopUsd: number | null; ourTopUsd: number | null; note: string };
  /** Fork & Flip: what the fork changes. */
  improvements?: string[];
};

const SYSTEM = `You are Strategist Mo on a crew that builds businesses. You write plans a small crew can ship this week: concrete, short, testable. ${COPY_RULES_PROMPT} Reply with JSON only.`;

const MVP_SHAPE = `"mvpFeatures":[{"id":"kebab-id","title":"…","description":"…","acceptance":["Given/when/then sentence a test can check through an HTTP JSON API", "…"]}] (3 to 5 features, each with 2 to 4 acceptance criteria about a JSON HTTP API: method, path, status code, JSON fields)`;

function clampPlan(p: VenturePlan): VenturePlan {
  const mvp = (Array.isArray(p.mvpFeatures) ? p.mvpFeatures : []).slice(0, 5).map((f, i) => ({
    id: String(f?.id ?? `feature-${i + 1}`)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .slice(0, 40),
    title: String(f?.title ?? `Feature ${i + 1}`).slice(0, 80),
    description: String(f?.description ?? "").slice(0, 400),
    acceptance: (Array.isArray(f?.acceptance) ? f.acceptance : []).slice(0, 4).map((a) => String(a).slice(0, 300)),
  }));
  if (!mvp.length) throw new Error("the plan has no MVP features");
  return {
    ...p,
    positioning: String(p.positioning ?? "").slice(0, 600),
    audience: String(p.audience ?? "").slice(0, 300),
    problem: String(p.problem ?? "").slice(0, 400),
    mvpFeatures: mvp,
    pricing: (Array.isArray(p.pricing) ? p.pricing : []).slice(0, 4).map((x) => ({ name: String(x?.name ?? "Plan").slice(0, 40), priceUsdMonthly: typeof x?.priceUsdMonthly === "number" ? x.priceUsdMonthly : null, features: (Array.isArray(x?.features) ? x.features : []).slice(0, 8).map(String) })),
  };
}

const ask = (s: StepContext, user: string) => askJson<VenturePlan & Record<string, unknown>>(s, [{ role: "system", content: SYSTEM }, { role: "user", content: user }] as ChatMessage[], { maxTokens: 2200 });

export const research: RoleHandler = async (s) => {
  const { value } = await askJson<Record<string, unknown>>(
    s,
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `Idea: ${s.input.brief}\n\nGive demand checks and a competitor map from what you know (say when you are unsure). JSON: {"audience":"…","demand":[{"signal":"…","how_to_check":"…"}],"competitors":[{"name":"…","angle":"…","weakness":"…"}],"risks":["…"],"wedge":"the one thing to win on first"}`,
      },
    ],
    { maxTokens: 1600 },
  );
  await s.put({ kind: "report", name: "research", mime: "application/json", body: JSON.stringify(value) });
};

export const plan: RoleHandler = async (s) => {
  const research = await s.text(s.need("research", "research"));
  const { value } = await ask(
    s,
    `Idea: ${s.input.brief}\nResearch (JSON):\n${research.slice(0, 6000)}\n\nWrite the venture plan. JSON: {"name":"a short brand name","positioning":"…","audience":"…","problem":"…",${MVP_SHAPE},"pricing":[{"name":"…","priceUsdMonthly":number|null,"features":["…"]}],"launch":["day-by-day launch steps"]}`,
  );
  const p = clampPlan(value);
  await s.put({ kind: "plan", name: "plan", mime: "application/json", body: JSON.stringify(p) });
  s.log(`plan: ${p.mvpFeatures.length} MVP features`);
};

/** Parity+: every feature they have, every feature their users ask for, and a price under theirs. Reads the Spec only. */
export const parity: RoleHandler = async (s) => {
  const spec = await s.json<Spec>(s.need("spec", "spec"));
  const top = spec.pricing.plans.map((p) => p.priceUsdMonthly).filter((x): x is number => typeof x === "number");
  const theirTop = top.length ? Math.max(...top) : null;
  const { value } = await ask(
    s,
    `Brief: ${s.input.brief || "Build the better version of this product."}\nFunctional spec of the product we are beating (features, flows, data models, API shapes, plan grid, complaint themes):\n${JSON.stringify(spec).slice(0, 12000)}\n\nWrite the Parity+ plan. JSON: {"name":"a new brand name that sounds nothing like theirs","positioning":"…","audience":"…","problem":"…","parity":[{"feature":"…","theirs":true|false,"ours":"parity"|"better"|"new","note":"…"}],"gaps":["what their users ask for that they lack"],${MVP_SHAPE} (rebuild their core flows plus the most-asked gap),"pricing":[{"name":"…","priceUsdMonthly":number|null,"features":["…"]}] (priced under theirs),"priceUnder":{"theirTopUsd":${theirTop},"ourTopUsd":number|null,"note":"…"}}`,
  );
  const p = clampPlan(value);
  p.parity = (Array.isArray(value.parity) ? value.parity : []).slice(0, 40).map((r) => ({ feature: String(r?.feature ?? "").slice(0, 80), theirs: !!r?.theirs, ours: r?.ours === "better" || r?.ours === "new" ? r.ours : "parity", note: String(r?.note ?? "").slice(0, 200) }));
  p.gaps = (Array.isArray(value.gaps) ? value.gaps : []).slice(0, 12).map(String);
  // Price under theirs: if the plan priced anything at or above their top plan, bring it under.
  if (theirTop !== null) p.pricing = p.pricing.map((x) => (x.priceUsdMonthly !== null && x.priceUsdMonthly >= theirTop ? { ...x, priceUsdMonthly: Math.max(0, Math.floor(theirTop * 0.8)) } : x));
  const ourTop = p.pricing.map((x) => x.priceUsdMonthly).filter((x): x is number => typeof x === "number");
  p.priceUnder = { theirTopUsd: theirTop, ourTopUsd: ourTop.length ? Math.max(...ourTop) : null, note: String((value.priceUnder as { note?: unknown })?.note ?? "") };
  await s.put({ kind: "plan", name: "plan", mime: "application/json", body: JSON.stringify(p) });
  s.log(`Parity+: ${p.parity.length} rows, ${p.gaps.length} gaps`);
};

export const launch: RoleHandler = async (s) => {
  const p = await s.text(s.need("plan", "plan"));
  const { value } = await askJson<{ days: { day: number; tasks: string[] }[]; channels: string[]; metrics: string[] }>(
    s,
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: `Plan:\n${p.slice(0, 6000)}\n\nWrite a 14-day launch plan. JSON: {"days":[{"day":1,"tasks":["…"]}],"channels":["…"],"metrics":["what to measure"]}` },
    ],
    { maxTokens: 1500, select: "single" },
  );
  await s.put({ kind: "plan", name: "launch", mime: "application/json", body: JSON.stringify(value) });
};

export const forkPlan: RoleHandler = async (s) => {
  const fork = await s.json<{ plan: { action: string; obligations: string[] }; project: { name: string; summary: string; spdx: string | null } }>(s.need("fork", "fork"));
  const { value } = await ask(
    s,
    `We are forking an open-source project (${fork.project.name}, licence ${fork.project.spdx ?? "unknown"}, action: ${fork.plan.action}). Its summary: ${fork.project.summary.slice(0, 2000)}\nBrief: ${s.input.brief}\n\nPlan the rebrand and the first improvements. JSON: {"name":"a new brand name","positioning":"…","audience":"…","problem":"…","improvements":["…"],${MVP_SHAPE},"pricing":[{"name":"…","priceUsdMonthly":number|null,"features":["…"]}]}`,
  );
  const p = clampPlan(value);
  p.improvements = (Array.isArray(value.improvements) ? value.improvements : []).slice(0, 10).map(String);
  await s.put({ kind: "plan", name: "plan", mime: "application/json", body: JSON.stringify(p) });
};
