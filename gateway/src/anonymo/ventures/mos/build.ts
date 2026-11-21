// WS11 · Tester Mo, Builder Mos and Red Team Mo (Ventures Backend PART 7, Laws 1 and 5).
//
// The candidate loop: Tester Mo writes tests from the plan first (bun:test against a JSON HTTP app). Then N Builder Mos
// from distinct families (never the tester's family) each build the app in their own sandbox, a CLEAN microVM with no
// route to the target. Tests run in each sandbox; candidates are ranked by pass rate, then build and lint errors, then
// bundle size, and the winner is merged. Chat never picks code (Law 5). Red Team Mo then runs static rules and a
// dependency audit on the winner.

import { askOne } from "../crew/ask.ts";
import { pickFamilies, type CrewModel } from "../crew/families.ts";
import { CrewCallError, parseJsonReply, type ChatMessage } from "../llm.ts";
import type { RoleHandler, StepContext } from "../orchestrator.ts";
import { defaultBuilderPolicy, type Sandbox, type SandboxPool } from "../sandbox/index.ts";
import type { FileFormat, Spec } from "../types.ts";
import type { VenturePlan } from "./strategist.ts";

export type BuildServices = { sandboxPool?: SandboxPool; gatewayHost?: string; candidateTimeMs?: number };
export type FileMap = Record<string, string>;
export type TestBundle = { family: string; model: string; entry: string; files: FileMap; tests: number };
export type CandidateResult = { family: string; model: string; files: FileMap; passed: number; failed: number; total: number; passRate: number; buildErrors: number; lintErrors: number; bundleBytes: number; output: string; receiptId: string | null; costUsd: number; refused: boolean; error?: string };

const APP_CONTRACT = `The app is one TypeScript module, src/app.ts, for the Bun runtime, with no dependencies (only relative imports and node: built-ins). It exports
  export function createApp(): { fetch(req: Request): Promise<Response> }
Each createApp() call starts with empty in-memory state. The app speaks JSON over HTTP: request bodies are JSON, responses are JSON with a correct status code (200/201 on success, 400 on invalid input, 404 when not found). GET / returns a small HTML page that lists the features.`;

const IMPORT_CONTRACT = `The import tool is one TypeScript module, src/import.ts, for the Bun runtime, with no dependencies. It exports
  export function parseExport(format: string, content: string): Record<string, string>[]
which reads a CSV export (first line is the header; fields may be quoted with double quotes, quotes inside are doubled; commas and newlines may appear inside quotes; CRLF or LF line endings) and returns one object per row keyed by the header names, trimming nothing. Unknown format names throw an Error.`;

// ---- files from model replies ----------------------------------------------------------------------------------------

const SAFE_PATH = /^(?:src|test)\/[A-Za-z0-9_\-./]{1,120}\.(?:ts|tsx|js|json|html|css|md)$/;

/** Keeps only safe, relative source paths under src/ or test/, and refuses package imports. */
export function cleanFiles(raw: unknown, dir: "src" | "test"): FileMap {
  const files = (raw && typeof raw === "object" ? ((raw as { files?: unknown }).files ?? raw) : {}) as Record<string, unknown>;
  const out: FileMap = {};
  for (const [p, body] of Object.entries(files)) {
    const path = p.replace(/^\.\//, "");
    if (typeof body !== "string" || !SAFE_PATH.test(path) || path.includes("..") || !path.startsWith(dir + "/")) continue;
    out[path] = body.slice(0, 200_000);
  }
  return out;
}

const BARE_IMPORT = /\b(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"'./][^"']*)["']/g;
export function bareImports(files: FileMap): string[] {
  const found = new Set<string>();
  for (const body of Object.values(files)) for (const m of body.matchAll(BARE_IMPORT)) if (!m[1]!.startsWith("node:") && m[1] !== "bun:test" && m[1] !== "bun") found.add(m[1]!);
  return [...found];
}

// ---- running tests in a sandbox --------------------------------------------------------------------------------------

/** Reads bun test's summary lines (" 3 pass", " 1 fail"). */
export function parseBunTest(out: string): { passed: number; failed: number } {
  const passed = Number(/^\s*(\d+) pass\b/m.exec(out)?.[1] ?? 0);
  const failed = Number(/^\s*(\d+) fail\b/m.exec(out)?.[1] ?? 0);
  const errors = Number(/^\s*(\d+) errors?\b/m.exec(out)?.[1] ?? 0);
  return { passed, failed: failed + errors };
}

const LINT_RULES: [string, RegExp][] = [
  ["no-explicit-any", /:\s*any\b|as any\b/g],
  ["no-eval", /\beval\s*\(|new Function\s*\(/g],
  ["no-ts-ignore", /@ts-ignore|@ts-nocheck/g],
  ["no-console-log", /console\.log\(/g],
];
export function lintCount(files: FileMap): number {
  let n = 0;
  for (const [p, body] of Object.entries(files)) {
    if (!p.startsWith("src/")) continue;
    for (const [, re] of LINT_RULES) n += body.match(re)?.length ?? 0;
    n += body.split("\n").filter((l) => l.length > 220).length;
  }
  return n;
}

const PACKAGE_JSON = JSON.stringify({ name: "venture-app", private: true, type: "module", license: "MIT" }, null, 2);

async function inSandbox<T>(s: StepContext, label: string, fn: (sb: Sandbox) => Promise<T>): Promise<T> {
  const svc = s.deps.services as BuildServices;
  if (!svc.sandboxPool) throw new Error("no sandbox pool is configured");
  const policy = defaultBuilderPolicy({ gatewayHost: svc.gatewayHost ?? "anonymo.tech", targetHosts: s.denyHosts, timeMs: svc.candidateTimeMs ?? 180_000 });
  return svc.sandboxPool.run(policy, fn, {
    beforeStart: () => {
      if (s.remainingUsd() <= 0) throw new Error(`no budget left to start a sandbox for ${label}`);
    },
    onMinutes: async (u) => {
      if (!(await s.charge(u.costUsd, `sandbox:${u.sandboxId}`))) s.log(`sandbox minutes for ${label} went over the step budget`);
    },
  });
}

export async function runCandidate(sb: Sandbox, entry: string, tests: FileMap, files: FileMap): Promise<Omit<CandidateResult, "family" | "model" | "files" | "receiptId" | "costUsd" | "refused">> {
  await sb.writeFiles({ "package.json": PACKAGE_JSON, ...tests, ...files });
  const t = await sb.exec(["bun", "test"], { timeoutMs: 90_000 });
  const out = `${t.stdout}\n${t.stderr}`;
  const { passed, failed } = parseBunTest(out);
  const total = passed + failed;
  const b = await sb.exec(["bun", "build", entry, "--target=bun", "--outdir=dist"], { timeoutMs: 60_000 });
  const buildErrors = b.code === 0 ? 0 : Math.max(1, (`${b.stdout}\n${b.stderr}`.match(/\berror\b/gi) ?? []).length);
  const dist: Record<string, string> = b.code === 0 ? await sb.readFiles(["dist/" + entry.split("/").pop()!.replace(/\.tsx?$/, ".js")]).catch(() => ({})) : {};
  const bundleBytes = Object.values(dist).reduce((n: number, x: string) => n + new TextEncoder().encode(x).byteLength, 0);
  return { passed, failed, total, passRate: total ? passed / total : 0, buildErrors, lintErrors: lintCount(files), bundleBytes, output: out.slice(-6000), ...(t.timedOut ? { error: "tests timed out" } : {}) };
}

/** Ranking (Backend PART 7): pass rate, then build + lint errors, then bundle size. */
export function rankCandidates<T extends Pick<CandidateResult, "passRate" | "buildErrors" | "lintErrors" | "bundleBytes" | "refused"> & { error?: string }>(cs: T[]): T[] {
  return [...cs].sort((a, b) => Number(a.refused) - Number(b.refused) || b.passRate - a.passRate || a.buildErrors + a.lintErrors - (b.buildErrors + b.lintErrors) || (a.bundleBytes || Infinity) - (b.bundleBytes || Infinity));
}

// ---- Tester Mo ------------------------------------------------------------------------------------------------------

async function planFrom(s: StepContext): Promise<VenturePlan> {
  const ref = Object.values(s.needs).flat().find((r) => r.name === "plan");
  if (!ref) throw new Error("no plan to test against");
  return s.json<VenturePlan>(ref);
}

const STUB_APP = `export function createApp() { return { async fetch() { return new Response(JSON.stringify({ error: "not built" }), { status: 404, headers: { "content-type": "application/json" } }); } }; }\n`;

export const writeTests: RoleHandler = async (s) => {
  const plan = await planFrom(s);
  const tester = s.pool[0];
  if (!tester) throw new Error("no model family is available");
  const messages: ChatMessage[] = [
    { role: "system", content: "You are Tester Mo. You write precise, independent bun:test tests from acceptance criteria. Reply with JSON only." },
    {
      role: "user",
      content: `${APP_CONTRACT}\n\nFeatures and acceptance criteria:\n${JSON.stringify(plan.mvpFeatures, null, 1).slice(0, 8000)}\n\nWrite tests in test/app.test.ts that import { createApp } from "../src/app.ts", create a fresh app per test, and call app.fetch(new Request("http://app/<path>", { method, headers: { "content-type": "application/json" }, body })). Cover every acceptance criterion with at least one test (8 to 20 tests). Assert status codes and JSON fields; never assert exact HTML or error wording. JSON: {"files":{"test/app.test.ts":"…"}}`,
    },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await askOne(s, messages, { first: attempt === 0 ? tester : undefined, json: true, maxTokens: 5000 });
    const files = cleanFiles(parseJsonReply(r.text), "test");
    if (!Object.keys(files).length) continue;
    // The tests must load and run against an empty app (all failing, none crashing the runner).
    const probe = await inSandbox(s, "tests", (sb) => runCandidate(sb, "src/app.ts", files, { "src/app.ts": STUB_APP }));
    if (probe.total >= 3) {
      const bundle: TestBundle = { family: r.familyUsed, model: r.model, entry: "src/app.ts", files, tests: probe.total };
      await s.put({ kind: "test", name: "tests", mime: "application/json", body: JSON.stringify(bundle) });
      s.log(`${probe.total} tests from ${r.familyUsed}; ${probe.passed} pass against an empty app`);
      return;
    }
    s.log("the tests did not load; asking again");
  }
  throw new Error("Tester Mo could not write runnable tests");
};

/** Import-tool tests, written by code from the Spec's export formats (no model: the formats are facts). */
export function importTests(formats: FileFormat[]): FileMap {
  const fmts = formats.length ? formats : [{ name: "csv export", extension: "csv", fields: ["id", "name", "created_at"] }];
  const lines: string[] = ['import { expect, test } from "bun:test";', 'import { parseExport } from "../src/import.ts";', ""];
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  for (const f of fmts.slice(0, 6)) {
    const fields = f.fields.slice(0, 12);
    if (!fields.length) continue;
    const row1 = fields.map((x, i) => `${x}-${i}`);
    const row2 = fields.map((_, i) => (i === 0 ? 'Smith, "Jo"' : `v${i}\nline`));
    const csv = [fields.map(q).join(","), row1.map(q).join(","), row2.map(q).join(",")].join("\r\n");
    lines.push(`test(${JSON.stringify(`${f.name}: header keys and rows`)}, () => {`);
    lines.push(`  const rows = parseExport(${JSON.stringify(f.name)}, ${JSON.stringify(csv)});`);
    lines.push(`  expect(rows.length).toBe(2);`);
    lines.push(`  expect(Object.keys(rows[0]!)).toEqual(${JSON.stringify(fields)});`);
    lines.push(`  expect(rows[0]![${JSON.stringify(fields[0])}]).toBe(${JSON.stringify(row1[0])});`);
    lines.push(`});`);
    lines.push(`test(${JSON.stringify(`${f.name}: quoted commas, quotes and newlines`)}, () => {`);
    lines.push(`  const rows = parseExport(${JSON.stringify(f.name)}, ${JSON.stringify(csv)});`);
    lines.push(`  expect(rows[1]![${JSON.stringify(fields[0])}]).toBe(${JSON.stringify(row2[0])});`);
    if (fields.length > 1) lines.push(`  expect(rows[1]![${JSON.stringify(fields[1])}]).toBe(${JSON.stringify(row2[1])});`);
    lines.push(`});`);
    lines.push(`test(${JSON.stringify(`${f.name}: LF line endings`)}, () => {`);
    lines.push(`  expect(parseExport(${JSON.stringify(f.name)}, ${JSON.stringify(csv.replaceAll("\r\n", "\n"))}).length).toBe(2);`);
    lines.push(`});`);
  }
  lines.push('test("unknown formats throw", () => {', '  expect(() => parseExport("no-such-format", "a\\n1")).toThrow();', "});");
  return { "test/import.test.ts": lines.join("\n") + "\n" };
}

export const writeImportTests: RoleHandler = async (s) => {
  const spec = await s.json<Spec>(s.need("spec", "spec"));
  const files = importTests(spec.formats);
  const total = (files["test/import.test.ts"]!.match(/^test\(/gm) ?? []).length;
  const bundle: TestBundle = { family: "rules", model: "none", entry: "src/import.ts", files, tests: total };
  await s.put({ kind: "test", name: "tests", mime: "application/json", body: JSON.stringify(bundle) });
  s.log(`${total} import tests from ${spec.formats.length || 1} export format(s)`);
};

// ---- Builder Mos ----------------------------------------------------------------------------------------------------

async function buildOne(s: StepContext, m: CrewModel, contract: string, task: string, tests: TestBundle, exclude: string[]): Promise<CandidateResult> {
  const base = { family: m.family, model: m.model, files: {} as FileMap, passed: 0, failed: 0, total: tests.tests, passRate: 0, buildErrors: 0, lintErrors: 0, bundleBytes: 0, output: "", receiptId: null as string | null, costUsd: 0, refused: false };
  const messages: ChatMessage[] = [
    { role: "system", content: "You are a Builder Mo. You write complete, working, dependency-free TypeScript. Reply with JSON only." },
    { role: "user", content: `${contract}\n\n${task}\n\nThese tests will be run against your code:\n${Object.entries(tests.files).map(([p, b]) => `--- ${p}\n${b}`).join("\n").slice(0, 14000)}\n\nJSON: {"files":{"${tests.entry}":"…full file…"}}` },
  ];
  let reply;
  try {
    reply = await askOne(s, messages, { first: m, exclude, json: true, maxTokens: 8000 });
  } catch (e) {
    if (e instanceof CrewCallError && (e.fatal || e.code === "cancelled")) throw e;
    return { ...base, error: e instanceof Error ? e.message : String(e), refused: true };
  }
  const files = cleanFiles(parseJsonReply(reply.text), "src");
  const cand = { ...base, family: reply.familyUsed, model: reply.model, files, receiptId: reply.receiptId, costUsd: reply.costUsd };
  if (!files[tests.entry]) return { ...cand, error: `no ${tests.entry} in the reply` };
  const deps = bareImports(files);
  if (deps.length) return { ...cand, error: `uses packages (${deps.join(", ")}); candidates must be dependency-free` };
  const run = await inSandbox(s, `${reply.familyUsed} candidate`, (sb) => runCandidate(sb, tests.entry, tests.files, files));
  let best = { ...cand, ...run };
  // One repair round when tests fail: the same family sees the failures and fixes its own code.
  if (best.passRate < 1 && s.remainingUsd() > 0) {
    try {
      const fix = await askOne(s, [...messages, { role: "assistant", content: reply.text.slice(0, 12000) }, { role: "user", content: `Some tests failed:\n${run.output.slice(-4000)}\nFix the code. JSON: {"files":{"${tests.entry}":"…full file…"}}` }], { first: { ...m, family: reply.familyUsed, model: reply.model }, json: true, maxTokens: 8000 });
      const fixed = cleanFiles(parseJsonReply(fix.text), "src");
      if (fixed[tests.entry] && !bareImports(fixed).length) {
        const rerun = await inSandbox(s, `${reply.familyUsed} repair`, (sb) => runCandidate(sb, tests.entry, tests.files, fixed));
        if (rerun.passRate > best.passRate) best = { ...best, ...rerun, files: fixed, costUsd: best.costUsd + fix.costUsd };
      }
    } catch (e) {
      if (e instanceof CrewCallError && (e.fatal || e.code === "cancelled")) throw e;
    }
  }
  return best;
}

async function fanOutBuild(s: StepContext, contract: string, task: string) {
  const tests = await s.json<TestBundle>(s.need("tests", "tests"));
  const n = Math.max(1, Math.min(s.step.fanout, s.tier.builders));
  // Builders never share the tester's family (no self-grading), and no two builders share a family.
  let picks = pickFamilies(s.pool, n, { exclude: [tests.family] });
  if (!picks.length) {
    picks = pickFamilies(s.pool, 1);
    s.log("only the tester's family is available; it builds too");
  }
  s.log(`${picks.length} Builder Mo(s): ${picks.map((p) => p.family).join(", ")}`);
  const used = picks.map((p) => p.family).concat(tests.family);
  const results = await Promise.all(picks.map((p) => buildOne(s, p, contract, task, tests, used.filter((f) => f !== p.family))));
  const ranked = rankCandidates(results.filter((r) => !r.error || Object.keys(r.files).length));
  const winner = ranked.find((r) => Object.keys(r.files).length && !r.error) ?? null;
  for (const r of results) await s.candidate({ family: r.family, model: r.model, passRate: r.total ? r.passRate : null, lintErrors: r.lintErrors, typeErrors: r.buildErrors, bundleBytes: r.bundleBytes, refused: r.refused, chosen: r === winner, receiptId: r.receiptId, costUsd: r.costUsd, error: r.error });
  if (!winner) throw new Error(`no candidate produced working code (${results.map((r) => `${r.family}: ${r.error ?? `${Math.round(r.passRate * 100)}%`}`).join("; ")})`);
  await s.put({ kind: "code", name: "code", mime: "application/json", body: JSON.stringify({ ...winner.files, ...tests.files }) });
  await s.put({ kind: "report", name: "test-report", mime: "application/json", body: JSON.stringify({ winner: { family: winner.family, model: winner.model, passed: winner.passed, total: winner.total }, candidates: results.map((r) => ({ family: r.family, model: r.model, passed: r.passed, total: r.total, passRate: r.passRate, buildErrors: r.buildErrors, lintErrors: r.lintErrors, bundleBytes: r.bundleBytes, refused: r.refused, error: r.error ?? null })) }) });
  s.log(`winner: ${winner.family} with ${winner.passed}/${winner.total} tests passing`);
}

export const buildApp: RoleHandler = async (s) => {
  const plan = await planFrom(s);
  await fanOutBuild(s, APP_CONTRACT, `Build this MVP:\n${JSON.stringify({ name: plan.name, positioning: plan.positioning, features: plan.mvpFeatures }, null, 1).slice(0, 8000)}`);
};

export const buildImport: RoleHandler = async (s) => {
  const spec = await s.json<Spec>(s.need("spec", "spec"));
  await fanOutBuild(s, IMPORT_CONTRACT, `Support these export formats (format name → header fields):\n${JSON.stringify(spec.formats.length ? spec.formats : [{ name: "csv export", fields: ["id", "name", "created_at"] }])}`);
};

// ---- Red Team Mo ----------------------------------------------------------------------------------------------------

export type Finding = { rule: string; file: string; line: number; severity: "high" | "medium" | "low"; message: string };

const STATIC_RULES: { rule: string; re: RegExp; severity: Finding["severity"]; message: string }[] = [
  { rule: "eval", re: /\beval\s*\(|new Function\s*\(/, severity: "high", message: "dynamic code execution" },
  { rule: "child-process", re: /node:child_process|\bBun\.spawn\b|\bexecSync\b/, severity: "high", message: "spawns processes" },
  { rule: "hardcoded-secret", re: /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/i, severity: "high", message: "looks like a hardcoded secret" },
  { rule: "private-key", re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|\b0x[a-f0-9]{64}\b/i, severity: "high", message: "contains key material" },
  { rule: "html-injection", re: /innerHTML\s*=|dangerouslySetInnerHTML|document\.write\(/, severity: "medium", message: "writes raw HTML" },
  { rule: "unescaped-html-template", re: /`[^`]*<[a-z][^`]*\$\{(?![^}]*escape)[^}]+\}[^`]*`/i, severity: "low", message: "interpolates values into HTML without an escape helper" },
  { rule: "plain-http", re: /["']http:\/\/(?!localhost|127\.0\.0\.1|app\/)/, severity: "low", message: "plain http url" },
  { rule: "weak-random", re: /Math\.random\(\).*(?:token|id|secret|key)/i, severity: "medium", message: "Math.random used for an identifier" },
  { rule: "fs-write", re: /\bwriteFileSync\b|\bBun\.write\b|node:fs/, severity: "medium", message: "touches the filesystem" },
];

export function staticScan(files: FileMap): Finding[] {
  const out: Finding[] = [];
  for (const [file, body] of Object.entries(files)) {
    if (!file.startsWith("src/")) continue;
    body.split("\n").forEach((line, i) => {
      for (const r of STATIC_RULES) if (r.re.test(line)) out.push({ rule: r.rule, file, line: i + 1, severity: r.severity, message: r.message });
    });
  }
  return out;
}

export const redTeam: RoleHandler = async (s) => {
  const ref = Object.values(s.needs).flat().find((r) => r.name === "code");
  if (!ref) throw new Error("nothing to scan");
  const files = await s.json<FileMap>(ref);
  const findings = staticScan(files);
  const deps = bareImports(Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith("src/"))));
  // Semgrep, when the host has it and a local ruleset is configured (it is never fetched from the network).
  let semgrep: { ran: boolean; findings: number; note?: string } = { ran: false, findings: 0, note: "semgrep not configured" };
  const config = process.env.VENTURES_SEMGREP_CONFIG;
  if (config && Bun.which("semgrep")) {
    const dir = `${(await import("node:os")).tmpdir()}/anonymo-redteam-${s.venture.id}`;
    const { mkdir, writeFile, rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
    for (const [p, b] of Object.entries(files)) {
      await mkdir(`${dir}/${p.split("/").slice(0, -1).join("/")}`, { recursive: true });
      await writeFile(`${dir}/${p}`, b);
    }
    const proc = Bun.spawn(["semgrep", "--config", config, "--json", "--metrics=off", dir], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const results = (parseJsonReply<{ results?: unknown[] }>(out)?.results ?? []).length;
    semgrep = { ran: true, findings: results };
    await rm(dir, { recursive: true, force: true });
  }
  const high = findings.filter((f) => f.severity === "high").length;
  await s.put({ kind: "report", name: "redteam", mime: "application/json", body: JSON.stringify({ findings, dependencies: deps, semgrep, verdict: high ? "fix-before-ship" : "ok" }) });
  s.log(`red team: ${findings.length} finding(s), ${high} high; ${deps.length} dependencies`);
  if (high) throw new Error(`red team found ${high} high-severity issue(s)`);
};

export { APP_CONTRACT, IMPORT_CONTRACT, STUB_APP };
