// Anonymo signals as Prometheus gauges (WS10). Read-only: it SELECTs from a fixed list of tables and sends one GET
// to each guard model's /models. It never reads or exports prompt text, output text, keys, addresses or IPs: labels
// are route, upstream, job or chain identifiers from config, each checked against a strict pattern.
//
//   EXPORTER_DATABASE_URL=postgres://... ANONYMO_FLOOR_URL=... bun monitoring/anonymo-exporter.ts   # :9798/metrics
//
// Signals (alert rules in monitoring/anonymo-alerts.yml):
//   canaries          health rows with source='canary' (written by the worker's health-flush job), last 10 minutes
//   wallet balances   kv anonymo:balance:<upstream> (written by the anonymo-balances job)
//   refusal rate      refusal_stats, today and yesterday (counts only)
//   sealed freshness  providers with a TEE: attested flag and age of the last verified attestation
//   deposit watchers  kv job-health:anonymo-deposits (last success) and kv anonymo:cursor:* (last cursor write)
//   withdrawals       anonymo_withdrawals pending count and the oldest pending age
//   floor             the guard model's /models answers (the edge's 503 rate is scraped from Caddy)
//   jobs              kv job-health:<job> for every anonymo-* job and health-flush
//
// kv is read through the anonymo_monitor_kv view (deploy/anonymo/monitor-role.sql), which exposes only those rows.
// EXPORTER_KV_RELATION=kv reads the table directly (for a role that may read all of kv).

export type Query = (text: string) => Promise<Record<string, unknown>[]>;
export type Probe = { name: "floor" | "refusal"; url?: string; key?: string };
export type Sample = { name: string; labels?: Record<string, string>; value: number };

const LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const JOBS = ["anonymo-canaries", "anonymo-balances", "anonymo-deposits", "anonymo-sanctions", "health-flush"];
const LEVELS: Record<string, number> = { ok: 0, warn: 1, drain: 2, unknown: 3 };

const HELP: Record<string, string> = {
  anonymo_exporter_db_up: "1 when the exporter's read queries succeeded on this scrape.",
  anonymo_canary_runs: "Upstream canary runs per route in the last 10 minutes.",
  anonymo_canary_failures: "Failed upstream canary runs per route in the last 10 minutes.",
  anonymo_canary_last_age_seconds: "Seconds since the last canary run per route.",
  anonymo_upstream_balance_usd: "Last read wallet balance per prepaid upstream (USD).",
  anonymo_upstream_balance_level: "Balance level per upstream: 0 ok, 1 warn, 2 drain, 3 unknown.",
  anonymo_upstream_balance_read_age_seconds: "Seconds since the balance was last read successfully.",
  anonymo_refusal_requests: "Requests seen by the refusal catch, today and yesterday (UTC).",
  anonymo_refusal_refused: "Of those, refused attempts.",
  anonymo_sealed_attested: "1 when a TEE provider's last attestation verified.",
  anonymo_sealed_attestation_age_seconds: "Seconds since a TEE provider's last verified attestation.",
  anonymo_job_last_success_age_seconds: "Seconds since an Anonymo worker job last succeeded.",
  anonymo_job_interval_seconds: "The job's configured interval.",
  anonymo_job_failing: "1 when the job's last run failed.",
  anonymo_deposit_cursor_age_seconds: "Seconds since a deposit watcher last wrote its chain cursor.",
  anonymo_withdrawals_pending: "Withdrawals not yet sent.",
  anonymo_withdrawals_oldest_pending_seconds: "Age of the oldest pending withdrawal (0 when none).",
  anonymo_guard_up: "1 when the guard model server answers GET /models.",
  anonymo_guard_configured: "1 when the guard model URL is set.",
};

const num = (v: unknown) => (v == null ? NaN : Number(v));
const ageS = (now: number, v: unknown) => {
  if (v == null) return NaN;
  const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 1000)) : NaN;
};
const json = (v: unknown): Record<string, unknown> => (typeof v === "string" ? JSON.parse(v) : (v as Record<string, unknown>) ?? {});

/** Every gauge for one scrape. Each block fails on its own; a failing block sets anonymo_exporter_db_up 0. */
export async function collect(q: Query, probes: Probe[], now = Date.now(), fetchImpl: typeof fetch = fetch, kv = "anonymo_monitor_kv"): Promise<Sample[]> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(kv)) throw new Error("invalid kv relation name");
  const out: Sample[] = [];
  let dbOk = 1;
  const push = (name: string, labels: Record<string, string>, value: number) => {
    if (Object.values(labels).every((v) => LABEL.test(v)) && Number.isFinite(value)) out.push({ name, labels, value });
  };
  const block = async (fn: () => Promise<void>) => {
    try { await fn(); } catch { dbOk = 0; }
  };

  await block(async () => {
    const rows = await q(
      `SELECT provider_id AS route, count(*)::int AS runs, count(*) FILTER (WHERE NOT ok)::int AS failures, max(ts) AS last
       FROM health WHERE source = 'canary' AND ts > now() - interval '10 minutes'
         AND provider_id IN (SELECT provider_id FROM offers WHERE tier IS NOT NULL)
       GROUP BY provider_id`,
    );
    for (const r of rows) {
      const route = String(r.route);
      push("anonymo_canary_runs", { route }, num(r.runs));
      push("anonymo_canary_failures", { route }, num(r.failures));
      push("anonymo_canary_last_age_seconds", { route }, ageS(now, r.last));
    }
  });

  await block(async () => {
    const rows = await q(`SELECT key, value FROM ${kv} WHERE key LIKE 'anonymo:balance:%'`);
    for (const r of rows) {
      const upstream = String(r.key).slice("anonymo:balance:".length);
      const v = json(r.value);
      push("anonymo_upstream_balance_usd", { upstream }, num(v.usd));
      push("anonymo_upstream_balance_level", { upstream }, LEVELS[String(v.level)] ?? 3);
      push("anonymo_upstream_balance_read_age_seconds", { upstream }, v.read_at == null ? 1e9 : ageS(now, v.read_at));
    }
  });

  await block(async () => {
    const [r] = await q(`SELECT coalesce(sum(total), 0)::int AS total, coalesce(sum(refused), 0)::int AS refused FROM refusal_stats WHERE day >= (now() AT TIME ZONE 'UTC')::date - 1`);
    push("anonymo_refusal_requests", {}, num(r?.total ?? 0));
    push("anonymo_refusal_refused", {}, num(r?.refused ?? 0));
  });

  await block(async () => {
    const rows = await q(`SELECT id, attested, attested_at FROM providers WHERE tee_kind IS NOT NULL AND tee_kind <> 'dev' AND status = 'live'`);
    for (const r of rows) {
      const provider = String(r.id);
      push("anonymo_sealed_attested", { provider }, r.attested ? 1 : 0);
      push("anonymo_sealed_attestation_age_seconds", { provider }, r.attested_at == null ? 1e9 : ageS(now, r.attested_at));
    }
  });

  await block(async () => {
    const rows = await q(`SELECT key, value FROM ${kv} WHERE key IN (${JOBS.map((j) => `'job-health:${j}'`).join(", ")})`);
    for (const r of rows) {
      const job_name = String(r.key).slice("job-health:".length);
      const v = json(r.value);
      push("anonymo_job_last_success_age_seconds", { job_name }, v.last_success == null ? 1e9 : ageS(now, v.last_success));
      push("anonymo_job_interval_seconds", { job_name }, num(v.every_ms) / 1000);
      push("anonymo_job_failing", { job_name }, v.last_error ? 1 : 0);
    }
  });

  await block(async () => {
    const rows = await q(`SELECT key, updated_at FROM ${kv} WHERE key LIKE 'anonymo:cursor:%'`);
    // anonymo:cursor:evm:<chain> | anonymo:cursor:tron | anonymo:cursor:solana:<account> -> chain label only.
    const byChain = new Map<string, number>();
    for (const r of rows) {
      const parts = String(r.key).split(":").slice(2);
      const chain = parts[0] === "evm" ? parts[1] ?? "evm" : parts[0];
      const age = ageS(now, r.updated_at);
      if (chain && Number.isFinite(age)) byChain.set(chain, Math.min(byChain.get(chain) ?? Infinity, age));
    }
    for (const [chain, age] of byChain) push("anonymo_deposit_cursor_age_seconds", { chain }, age);
  });

  await block(async () => {
    const [r] = await q(`SELECT count(*)::int AS pending, min(created_at) AS oldest FROM anonymo_withdrawals WHERE status = 'pending'`);
    push("anonymo_withdrawals_pending", {}, num(r?.pending ?? 0));
    push("anonymo_withdrawals_oldest_pending_seconds", {}, r?.oldest == null ? 0 : ageS(now, r.oldest));
  });

  for (const p of probes) {
    push("anonymo_guard_configured", { service: p.name }, p.url ? 1 : 0);
    if (!p.url) continue;
    let up = 0;
    try {
      const res = await fetchImpl(p.url.replace(/\/+$/, "") + "/models", { headers: p.key ? { authorization: `Bearer ${p.key}` } : {}, signal: AbortSignal.timeout(3_000) });
      up = res.ok ? 1 : 0;
      await res.body?.cancel();
    } catch {
      up = 0;
    }
    push("anonymo_guard_up", { service: p.name }, up);
  }

  out.push({ name: "anonymo_exporter_db_up", value: dbOk });
  return out;
}

/** Prometheus text format. */
export function render(samples: Sample[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const s of [...samples].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!seen.has(s.name)) {
      seen.add(s.name);
      lines.push(`# HELP ${s.name} ${HELP[s.name] ?? s.name}`, `# TYPE ${s.name} gauge`);
    }
    const l = Object.entries(s.labels ?? {}).map(([k, v]) => `${k}="${v}"`).join(",");
    lines.push(`${s.name}${l ? `{${l}}` : ""} ${s.value}`);
  }
  return lines.join("\n") + "\n";
}

if (import.meta.main) {
  const url = process.env.EXPORTER_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set EXPORTER_DATABASE_URL");
  const postgres = (await import("postgres")).default;
  const sql = postgres(url, { max: 2, idle_timeout: 30, connect_timeout: 5, onnotice: () => {}, connection: { statement_timeout: 5_000, application_name: "anonymo-exporter" } });
  const q: Query = async (text) => [...(await sql.unsafe(text))] as Record<string, unknown>[];
  const probes: Probe[] = [
    { name: "floor", url: process.env.ANONYMO_FLOOR_URL, key: process.env.ANONYMO_FLOOR_KEY },
    { name: "refusal", url: process.env.ANONYMO_REFUSAL_URL, key: process.env.ANONYMO_REFUSAL_KEY },
  ];
  const port = Number(process.env.EXPORTER_PORT ?? 9798);
  Bun.serve({
    port,
    hostname: process.env.EXPORTER_HOST ?? "0.0.0.0",
    async fetch(req) {
      if (new URL(req.url).pathname !== "/metrics") return new Response("not found", { status: 404 });
      return new Response(render(await collect(q, probes, Date.now(), fetch, process.env.EXPORTER_KV_RELATION ?? "anonymo_monitor_kv")), { headers: { "content-type": "text/plain; version=0.0.4" } });
    },
  });
  console.log(JSON.stringify({ msg: "anonymo-exporter listening", port }));
}
