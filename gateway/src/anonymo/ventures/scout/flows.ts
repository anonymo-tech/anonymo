// WS11 · Scout: the state machine of each flow (Ventures Backend spec, PART 4: "maps the state machine of each flow
// (onboarding, checkout, settings) from links, buttons and forms structure").
//
// States are pages Scout read plus guarded targets it only saw linked (never requested). Transitions are the links and
// buttons between them. A flow is the shortest public path from the entry page to the first state of its kind, then
// the remaining states of that kind in breadth-first order.

import type { FlowGraph, FlowState, FormField, FormInfo, PageInfo } from "./types.ts";

export const FLOW_KINDS: Record<string, RegExp> = {
  onboarding: /sign-?up|register|get-?started|onboard|welcome|trial|\bjoin\b/i,
  checkout: /pricing|\bplans?\b|checkout|cart|billing|upgrade|\bbuy\b|subscribe|payment|choose/i,
  settings: /settings|preferences|profile|account/i,
  contact: /contact|demo|talk to sales|\bsales\b/i,
};

const nodeId = (url: string, guarded: boolean) => {
  const u = new URL(url);
  return guarded ? u.pathname : u.pathname + u.search;
};

/** A form field as a functional descriptor: name plus its validation rules ("email (email, required)"). */
export function fieldDescriptor(f: FormField): string {
  const rules: string[] = [];
  if (/^(email|url|tel|number|date|datetime-local|time|month|checkbox|radio|select)$/.test(f.type)) rules.push(f.type);
  if (f.required) rules.push("required");
  if (f.minLength !== undefined) rules.push(`min ${f.minLength}`);
  if (f.maxLength !== undefined) rules.push(`max ${f.maxLength}`);
  if (f.min !== undefined) rules.push(`min ${f.min}`);
  if (f.max !== undefined) rules.push(`max ${f.max}`);
  if (f.pattern !== undefined) rules.push("pattern");
  return rules.length ? `${f.name} (${rules.join(", ")})` : f.name;
}

const mainForm = (p: PageInfo): FormInfo | undefined => p.forms.find((f) => f.role !== "search");

export function mapFlows(pages: PageInfo[], start: string): FlowGraph[] {
  const states = new Map<string, FlowState>();
  const edges: { from: string; to: string; label: string }[] = [];
  const byUrl = new Map(pages.map((p) => [nodeId(p.url, false), p]));
  /** For a choice page (several CTAs to one guarded target, like plan buttons), that target. */
  const choiceTarget = new Map<string, string>();
  for (const p of pages) {
    const form = mainForm(p);
    const ctaCounts = new Map<string, number>();
    for (const l of p.links.filter((x) => x.guard)) ctaCounts.set(nodeId(l.url, true), (ctaCounts.get(nodeId(l.url, true)) ?? 0) + 1);
    const top = [...ctaCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const choice = !!top && top[1] >= 2 && p.buttons.length >= 2;
    if (choice) choiceTarget.set(nodeId(p.url, false), top[0]);
    states.set(nodeId(p.url, false), {
      id: nodeId(p.url, false),
      label: p.headings.find((h) => h.level === 1)?.text ?? p.title ?? p.path,
      kind: form ? "form" : choice ? "choice" : "page",
      visited: true,
      guard: null,
      ...(form ? { fields: form.fields.map(fieldDescriptor) } : {}),
    });
  }
  for (const p of pages) {
    const from = nodeId(p.url, false);
    for (const l of p.links) {
      if (!sameOrigin(l.url, start)) continue;
      const to = nodeId(l.url, !!l.guard);
      if (to === from) continue;
      if (!states.has(to)) {
        if (!l.guard) continue;
        states.set(to, { id: to, label: l.label || to, kind: "action", visited: false, guard: l.guard });
      }
      if (!edges.some((e) => e.from === from && e.to === to)) edges.push({ from, to, label: l.label });
    }
  }
  const entry = nodeId(start, false);
  if (!states.has(entry)) return [];
  const dist = new Map<string, number>([[entry, 0]]);
  const parent = new Map<string, string>();
  const order: string[] = [entry];
  for (let i = 0; i < order.length; i++) {
    for (const e of edges.filter((x) => x.from === order[i])) {
      if (dist.has(e.to)) continue;
      dist.set(e.to, dist.get(order[i])! + 1);
      parent.set(e.to, order[i]);
      order.push(e.to);
    }
  }
  const flows: FlowGraph[] = [];
  for (const [name, re] of Object.entries(FLOW_KINDS)) {
    const matched = order.filter((id) => id !== entry && (re.test(id) || re.test(states.get(id)!.label) || edges.some((e) => e.to === id && re.test(e.label))));
    if (!matched.length) continue;
    const path: string[] = [];
    for (let n: string | undefined = matched[0]; n; n = parent.get(n)) path.unshift(n);
    for (const m of matched.slice(1)) if (!path.includes(m)) path.push(m);
    const last = states.get(path[path.length - 1])!;
    const next = last.kind === "choice" ? choiceTarget.get(last.id) : undefined;
    if (next && states.has(next) && !path.includes(next)) path.push(next);
    const ids = path.slice(0, 8);
    flows.push({
      name,
      states: ids.map((id) => states.get(id)!),
      transitions: ids.slice(1).map((to, i) => ({ from: ids[i], to, label: edges.find((e) => e.from === ids[i] && e.to === to)?.label ?? "" })),
    });
  }
  const searchForm = pages.flatMap((p) => p.forms).find((f) => f.role === "search");
  if (searchForm) {
    const results = byUrl.get(nodeId(searchForm.action, false)) ?? pages.find((p) => p.url.startsWith(searchForm.action.split("?")[0]));
    flows.push({
      name: "search",
      states: [
        { id: "search-form", label: searchForm.submitLabel ?? "Search", kind: "form", visited: true, guard: null, fields: searchForm.fields.map(fieldDescriptor) },
        { id: "search-results", label: results?.headings[0]?.text ?? "Results", kind: "page", visited: !!results, guard: null },
      ],
      transitions: [{ from: "search-form", to: "search-results", label: searchForm.submitLabel ?? "Search" }],
    });
  }
  return flows;
}

function sameOrigin(a: string, b: string) {
  try {
    return new URL(a).host.replace(/^www\./, "") === new URL(b).host.replace(/^www\./, "");
  } catch {
    return false;
  }
}
