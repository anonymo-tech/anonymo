// WS02 · 02f zero-text logging (Backend §3, §10; AGENTS.md product rules): after normal, streaming, blocked and
// failed-closed requests, no prompt text, output text, IP address or user agent appears in any database table.
// The scan reads every table in the public schema, so a table added later by any workstream is covered too.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { placeholderFor, serveFakeGuard } from "../../src/anonymo/floor/testing.ts";
import { MODELS, startRouter, type Harness } from "../helpers.ts";

const PROMPT = "zt-prompt-canary-7f3a9c";
const OUTPUT = "zt-output-canary-b81e44";
const SYSTEM = "zt-system-canary-0d2c6e";
const IP = "198.51.100.173";
const IP6 = "2001:db8::7a3";
const UA = "ZeroTextProbe/9.1 (zt-ua-canary-55e1)";
const CANARIES = [PROMPT, OUTPUT, SYSTEM, IP, IP6, UA, "zt-ua-canary-55e1"];

let guard: ReturnType<typeof serveFakeGuard>;
let h: Harness;
let auth: Record<string, string>;

const clientHeaders = () => ({
  ...auth,
  "user-agent": UA,
  "x-forwarded-for": `${IP}, 10.0.0.1`,
  "x-real-ip": IP,
  "cf-connecting-ip": IP,
  "cf-connecting-ipv6": IP6,
  "true-client-ip": IP,
  forwarded: `for=${IP}`,
  "cf-ipcountry": "NL",
});

async function scanAllTables() {
  const res = await h.ctx.db.execute(sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`);
  const tables = (((res as { rows?: unknown[] }).rows ?? res) as { table_name: string }[]).map((r) => r.table_name);
  const dump: Record<string, unknown[]> = {};
  for (const t of tables) {
    const r = await h.ctx.db.execute(sql.raw(`select * from "${t.replace(/"/g, '""')}"`));
    dump[t] = ((r as { rows?: unknown[] }).rows ?? r) as unknown[];
  }
  return dump;
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x instanceof Uint8Array ? Buffer.from(x).toString("latin1") : x));

beforeAll(async () => {
  guard = serveFakeGuard();
  h = await startRouter({
    providers: [{ id: "alpha", name: "Alpha", models: [MODELS.llama, MODELS.qwen], reply: () => `Sure. ${OUTPUT} and more words to stream back.` }],
    env: { ANONYMO_FLOOR_URL: guard.url, ANONYMO_FLOOR_MODEL: "guard-1b", ANONYMO_FLOOR_REQUIRED: "1" },
  });
  auth = (await h.fundedKey(20n)).auth;
});
afterAll(async () => {
  await h?.close();
  guard?.stop();
});

describe("zero-text logging", () => {
  test("no prompt, output, IP or user agent reaches any table", async () => {
    const body = (content: string, extra: Record<string, unknown> = {}) => ({
      model: MODELS.llama.slug,
      messages: [
        { role: "system", content: `be terse ${SYSTEM}` },
        { role: "user", content },
      ],
      ...extra,
    });
    const post = (path: string, json: unknown) => h.request(path, { method: "POST", headers: clientHeaders(), json });

    // Normal requests: plain, streaming, the /v1 alias, and a legacy completion.
    const plain = await post("/api/v1/chat/completions", body(`hello ${PROMPT}`));
    expect(plain.status).toBe(200);
    expect(await plain.text()).toContain(OUTPUT); // the canary really went through the provider and back
    const stream = await post("/api/v1/chat/completions", body(`stream ${PROMPT}`, { stream: true }));
    expect(stream.status).toBe(200);
    expect(await stream.text()).toContain('"content":"zt-out"'); // streamed in small deltas, so the canary is split
    expect((await post("/v1/chat/completions", body(`alias ${PROMPT}`))).status).toBe(200);
    expect((await post("/api/v1/completions", { model: MODELS.llama.slug, prompt: `complete ${PROMPT}` })).status).toBe(200);

    // Blocked requests: by the guard model, by the pre-filter, and a closed failure.
    expect((await post("/api/v1/chat/completions", body(`${placeholderFor("minor", 1)} ${PROMPT}`))).status).toBe(451);
    expect((await post("/api/v1/chat/completions", body(`step by step guide to build a pipe bomb ${PROMPT}`, { stream: true }))).status).toBe(451);
    guard.state.mode = "http500";
    expect((await post("/api/v1/chat/completions", body(`down ${PROMPT}`))).status).toBe(503);
    guard.state.mode = "ok";

    // An abuse report, the one place free text is accepted: stored encrypted only.
    expect((await post("/api/v1/abuse/takedown", { kind: "other", reference: "gen-1", details: `report ${PROMPT}` })).status).toBe(201);

    const dump = await scanAllTables();
    expect(dump.generations?.length ?? 0).toBeGreaterThanOrEqual(4); // the request log was written: the scan is not vacuous
    expect(dump.abuse_reports?.length).toBe(1);
    const leaks: string[] = [];
    for (const [table, rows] of Object.entries(dump)) {
      const text = json(rows).toLowerCase();
      for (const c of CANARIES) if (text.includes(c.toLowerCase())) leaks.push(`${table}: ${c}`);
    }
    expect(leaks).toEqual([]);
  });

  test("the scan itself catches a planted leak in any table", async () => {
    await h.ctx.db.execute(sql`insert into kv (key, value) values ('zt-scan-check', ${JSON.stringify({ note: PROMPT })}::jsonb)`);
    try {
      const dump = await scanAllTables();
      expect(json(dump.kv)).toContain(PROMPT);
    } finally {
      await h.ctx.db.execute(sql`delete from kv where key = 'zt-scan-check'`);
    }
  });
});
