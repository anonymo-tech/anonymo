// WS04 · Failover load test (M3: "a load test with Venice disabled mid-run shows zero failed requests").
//
// `runLoad` fires `requests` calls with `concurrency` in flight and runs each scheduled action once the given share of
// calls has started, while the others are still in flight (for example: switch the Venice-tier mock off). It reports
// every non-2xx status and which upstream served each call. `mockUpstreamsDoc` is the mock topology the test and
// scripts/load-failover.ts use: a T0 Venice mock with two families, self-hosted backups of the same families, an
// attested Chutes-style route and a NanoGPT-style overflow route.

import type { UpstreamsDoc } from "../providers/tiers.ts";
import { DEFAULT_SCORING } from "./score.ts";

export type LoadCall = { status: number; servedBy: string | null; ms: number };
export type LoadAction = { at: number; name: string; run: () => Promise<void> | void };
export type LoadReport = {
  total: number;
  ok: number;
  failed: number;
  statuses: Record<string, number>;
  servedBy: Record<string, number>;
  /** Who served the calls that started after each action ran. */
  servedAfter: Record<string, Record<string, number>>;
  p50Ms: number;
  p99Ms: number;
};

export async function runLoad(o: { requests: number; concurrency: number; send: (i: number) => Promise<LoadCall>; actions?: LoadAction[] }): Promise<LoadReport> {
  const actions = [...(o.actions ?? [])].sort((a, b) => a.at - b.at);
  const fired = new Set<string>();
  const results: (LoadCall & { after: string[] })[] = [];
  let started = 0;
  const worker = async () => {
    while (started < o.requests) {
      const i = started++;
      for (const a of actions)
        if (!fired.has(a.name) && i >= Math.floor(a.at * o.requests)) {
          fired.add(a.name);
          await a.run();
        }
      const after = [...fired];
      const t = performance.now();
      let call: LoadCall;
      try {
        call = await o.send(i);
      } catch {
        call = { status: 0, servedBy: null, ms: performance.now() - t };
      }
      results.push({ ...call, after });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency, o.requests)) }, worker));
  const count = (xs: (string | null)[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x ?? "none"] = (m[x ?? "none"] ?? 0) + 1), m), {});
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const pick = (p: number) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))] : 0);
  const servedAfter: LoadReport["servedAfter"] = {};
  for (const a of actions) servedAfter[a.name] = count(results.filter((r) => r.after.includes(a.name)).map((r) => r.servedBy));
  const ok = results.filter((r) => r.status >= 200 && r.status < 300).length;
  return {
    total: results.length,
    ok,
    failed: results.length - ok,
    statuses: count(results.map((r) => String(r.status))),
    servedBy: count(results.map((r) => r.servedBy)),
    servedAfter,
    p50Ms: Math.round(pick(50)),
    p99Ms: Math.round(pick(99)),
  };
}

/** Mock upstream names: the mock provider answers "Hello from <name>.", which is how a call's server is read back. */
export const MOCK_UPSTREAMS = {
  venice: "Venice mock",
  selfhostMistral: "Selfhost mistral mock",
  selfhostDeepseek: "Selfhost deepseek mock",
  chutes: "Chutes TEE mock",
  nanogpt: "NanoGPT mock",
} as const;
export type MockUpstream = keyof typeof MOCK_UPSTREAMS;

export const servedByOf = (text: string): string | null => /Hello from ([^.]+)\./.exec(text)?.[1] ?? null;

const policy = { training: false, retains_prompts: false, retention_days: 0, zdr: true };

/** The mock topology, pointed at the given base URLs (one per mock upstream). */
export function mockUpstreamsDoc(urls: Record<MockUpstream, string>, opts: { timeoutMs?: number } = {}): UpstreamsDoc {
  // Every mock upstream reads its key from MOCK_UPSTREAM_KEY (seed with env { MOCK_UPSTREAM_KEY: "..." }).
  const t = { api_key_env: "MOCK_UPSTREAM_KEY", ...(opts.timeoutMs ? { timeout_ms: opts.timeoutMs } : {}) };
  return {
    version: 1,
    scoring: { ...DEFAULT_SCORING },
    canaries: { interval_s: 30, timeout_s: 5, concurrency: 4 },
    upstreams: [
      { id: "venice", name: "Venice", kind: "venice", tier: 0, base_url: urls.venice, data_policy: { training: false, retains_prompts: false, zdr: false }, prepaid: true, balance: { warn_usd: 50, drain_usd: 5 }, ...t },
      { id: "sh-mistral", name: "Self-hosted mistral", kind: "selfhost", tier: 1, base_url: urls.selfhostMistral, data_policy: policy, prepaid: false, ...t },
      { id: "sh-deepseek", name: "Self-hosted deepseek", kind: "selfhost", tier: 1, base_url: urls.selfhostDeepseek, data_policy: policy, prepaid: false, ...t },
      { id: "chutes", name: "Chutes TEE", kind: "chutes", tier: 2, base_url: urls.chutes, data_policy: policy, tee: { kind: "dev", attestation_url: urls.chutes + "/attestation" }, prepaid: false, ...t },
      { id: "nanogpt", name: "NanoGPT", kind: "nanogpt", tier: 2, base_url: urls.nanogpt, data_policy: { training: false, retains_prompts: true, zdr: false }, prepaid: true, balance: { warn_usd: 20, drain_usd: 1 }, ...t },
    ],
    routes: [
      { id: "venice-uncensored", upstream: "venice", model: "venice-uncensored", family: "mistral", quant: "fp8", ctx: 32768, price: { in: 0.2, out: 0.9 }, quality: 82, serves: ["anonymo-1", "anonymo-council"], features: [], enabled: true },
      { id: "venice-deepseek", upstream: "venice", model: "deepseek-v4.1-flash-abliterated", family: "deepseek", quant: "fp8", ctx: 131072, price: { in: 0.3, out: 1.1 }, quality: 86, serves: ["anonymo-1", "anonymo-council"], features: [], enabled: true },
      { id: "sh-dolphin-24b", upstream: "sh-mistral", model: "dolphin-venice-24b", family: "mistral", quant: "fp8", ctx: 32768, price: { in: 0.1, out: 0.3 }, quality: 80, serves: ["anonymo-1", "anonymo-rp"], direct_id: "dolphin-venice-24b", weights_hash: "ab".repeat(32), features: [], enabled: true },
      { id: "sh-deepseek-flash", upstream: "sh-deepseek", model: "deepseek-v4.1-flash-abliterated", family: "deepseek", quant: "fp8", ctx: 131072, price: { in: 0.25, out: 0.8 }, quality: 84, serves: ["anonymo-1", "anonymo-council"], direct_id: "deepseek-v4.1-flash-abliterated", features: [], enabled: true },
      { id: "chutes-glm", upstream: "chutes", model: "glm-5.2-abliterated", family: "glm", quant: "fp8", ctx: 131072, price: { in: 0.3, out: 1.2 }, quality: 83, serves: ["anonymo-1", "anonymo-sealed", "anonymo-council"], direct_id: "glm-5.2-abliterated", features: [], enabled: true },
      { id: "nanogpt-kimi", upstream: "nanogpt", model: "kimi-k2.7-code-abliterated", family: "kimi", quant: "fp8", ctx: 131072, price: { in: 0.5, out: 2 }, quality: 81, serves: ["anonymo-council"], features: [], enabled: true },
    ],
  };
}
