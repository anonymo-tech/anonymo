import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createDatabase } from "../server/db/database.ts";
import { migrate } from "./migrate.mjs";
import { dispatch } from "../server/routes/dispatch.ts";
import { generateSessionToken, hashToken, SESSION_COOKIE_NAME } from "../server/auth/index.ts";
import { creditVerifiedDeposit, settleHold } from "../server/ledger/ledger.ts";
import { PPQ_MODEL_ALLOWLIST } from "../server/ppq/catalog.ts";
import { runScheduledAgents, fetchSource, sourceAddress } from "../server/workspace/services.ts";
import { weeklySigner } from "../server/receipts/runtime-signer.ts";
const url = process.env.CONCLAVE_TEST_DATABASE_URL;
assert.equal(new URL(url).hostname, "127.0.0.1");
assert.match(new URL(url).pathname, /_test$/);
Object.assign(process.env, {
  CONCLAVE_MODE: "service",
  CONCLAVE_APP_ORIGIN: "https://conclave.test",
  CONCLAVE_DATABASE_URL: url,
  CONCLAVE_DATA_KEYS: JSON.stringify({ test: randomBytes(32).toString("base64") }),
  CONCLAVE_ACTIVE_DATA_KEY: "test",
  PPQ_API_KEY: "synthetic-fixture",
  CONCLAVE_INFERENCE_ENABLED: "true",
});
const pool = createDatabase(url, 8);
before(() => migrate(pool));
after(() => pool.end());
async function person() {
  const id = randomUUID(),
    token = generateSessionToken();
  await pool.query("INSERT INTO accounts(id) VALUES($1)", [id]);
  await pool.query(
    "INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [await hashToken(token), id],
  );
  await creditVerifiedDeposit(pool, {
    accountId: id,
    reference: `test_${randomUUID()}`,
    amountUsd6: "10000000",
  });
  return { id, token };
}
async function request(who, path, body, method = body === undefined ? "GET" : "POST") {
  const r = await dispatch(
    new Request(`https://conclave.test/api/${path}`, {
      method,
      headers: {
        origin: "https://conclave.test",
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE_NAME}=${who.token}`,
        "x-conclave-account-id": who.id,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: r.status, body: await r.json() };
}
async function route() {
  await pool.query(
    "INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,card,pricing,expires_at) VALUES($1,$2,1,$3,'gpt','chat',true,$4,$5,now()+interval '1 day')",
    [
      randomUUID(),
      randomUUID(),
      PPQ_MODEL_ALLOWLIST.gpt.id,
      {
        reviewed: true,
        level: "unverified",
        retentionDisclosure: "Synthetic route fixture.",
        evidenceUrl: "https://example.test/terms",
        evidenceDate: "2026-10-14",
      },
      {
        inputPerMillionUsd6: "1000000",
        outputPerMillionUsd6: "1000000",
        maxOutputTokens: 8192,
        maxInputBytes: 32768,
        maxReasoningTokens: 0,
        markupBps: 0,
      },
    ],
  );
}
async function settle(call) {
  const c = (await pool.query("SELECT account_id,hold_id FROM calls WHERE id=$1", [call])).rows[0];
  await settleHold(pool, { accountId: c.account_id, holdId: c.hold_id, actualUsd6: "100" });
  await pool.query("UPDATE calls SET state='succeeded' WHERE id=$1", [call]);
}

test("Chapters enforce invitations, isolation, shared billing, replay and concurrent allowance", async () => {
  await route();
  const owner = await person(),
    guest = await person(),
    outsider = await person();
  let r = await request(owner, "chapters", {
    name: "Team",
    displayName: "Owner",
    monthlyUsd6: "1000000",
  });
  assert.equal(r.status, 201);
  const id = r.body.id;
  assert.equal((await request(outsider, `chapters/${id}`)).status, 404);
  const invite = (await request(owner, `chapters/${id}/invite`, {})).body.token;
  assert.equal(
    (await request(guest, "chapters/join", { token: invite, displayName: "Member" })).status,
    200,
  );
  assert.equal(
    (await request(outsider, "chapters/join", { token: invite, displayName: "Outsider" })).status,
    404,
  );
  assert.equal((await request(guest, `chapters/${id}/invite`, {})).status, 404);
  const q = await request(guest, `chapters/${id}/quote`, {
    family: "gpt",
    prompt: "A short answer.",
  });
  assert.equal(q.status, 200);
  await request(owner, `chapters/${id}`, { monthlyUsd6: q.body.maximumUsd6 }, "PATCH");
  const b = {
    family: "gpt",
    prompt: "A short answer.",
    maximumUsd6: q.body.maximumUsd6,
    idempotencyKey: randomUUID(),
  };
  const results = await Promise.all([
    request(guest, `chapters/${id}/messages`, b),
    request(owner, `chapters/${id}/messages`, { ...b, idempotencyKey: randomUUID() }),
  ]);
  assert.equal(results.filter((x) => x.status === 202).length, 1);
  assert.equal(results.filter((x) => x.status === 402).length, 1);
  const sent =
    results[0].status === 202 ? { who: guest, r: results[0], b } : { who: owner, r: results[1] };
  if (sent.b)
    assert.equal(
      (await request(sent.who, `chapters/${id}/messages`, sent.b)).body.callId,
      sent.r.body.callId,
    );
  const billing = (
    await pool.query("SELECT account_id FROM calls WHERE id=$1", [sent.r.body.callId])
  ).rows[0];
  assert.equal(billing.account_id, owner.id);
  assert.equal((await request(outsider, `calls/${sent.r.body.callId}`)).status, 404);
  assert.equal(
    (await request(owner, `chapters/${id}/members/${guest.id}`, undefined, "DELETE")).status,
    200,
  );
  assert.equal((await request(guest, `chapters/${id}`)).status, 404);
});

test("Agents run with real reservations, one due job, lifetime cap, pause and ownership checks", async () => {
  const owner = await person(),
    other = await person();
  const project = randomUUID();
  await pool.query("INSERT INTO projects(id,account_id,title) VALUES($1,$2,'Agent project')", [
    project,
    owner.id,
  ]);
  const body = {
    name: "Watch brief",
    instructions: "Summarize the supplied project information.",
    projectId: project,
    family: "gpt",
    connectionIds: [],
    intervalHours: 1,
    perRunUsd6: "5000",
    totalUsd6: "5000",
  };
  const created = await request(owner, "agents", body);
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal((await request(other, `agents/${id}/run`, {})).status, 404);
  const first = await request(owner, `agents/${id}/schedule`, {});
  assert.equal(first.status, 202);
  assert.equal((await request(owner, `agents/${id}/run`, {})).status, 409);
  await settle(first.body.callId);
  await pool.query(
    "UPDATE workspace_agents SET next_run_at=now()-interval '1 minute' WHERE id=$1",
    [id],
  );
  await Promise.all([runScheduledAgents(pool), runScheduledAgents(pool)]);
  assert.equal(
    Number(
      (await pool.query("SELECT count(*) AS n FROM workspace_agent_runs WHERE agent_id=$1", [id]))
        .rows[0].n,
    ),
    2,
  );
  assert.equal((await request(owner, `agents/${id}/pause`, {})).status, 200);
  const active = (await pool.query("SELECT enabled FROM workspace_agents WHERE id=$1", [id]))
    .rows[0];
  assert.equal(active.enabled, false);
  const paused = (
    await pool.query(
      "SELECT h.cancel_requested_at FROM workspace_agent_runs r JOIN calls c ON c.id=r.call_id JOIN holds h ON h.id=c.hold_id WHERE r.agent_id=$1 ORDER BY r.created_at DESC",
      [id],
    )
  ).rows[0];
  assert.ok(paused.cancel_requested_at);
  assert.equal((await request(owner, `agents/${id}`, undefined, "DELETE")).status, 200);
  assert.equal((await request(owner, `agents/${id}`)).status, 404);
});

test("Connections allow only bounded GitHub text and revocation prevents future agent use", async () => {
  for (const args of [
    ["../etc", "a.md", "main"],
    ["owner/..", "a.md", "main"],
    ["owner/repo", "a.md", "../main"],
    ["https://127.0.0.1/private", "x", "main"],
    ["owner/repo", "../secrets", "main"],
    ["owner/repo", "a", "x?url=http://localhost"],
  ])
    assert.throws(() => sourceAddress(...args));
  const content = "Project release notes.",
    fake = async () => new Response(content);
  assert.equal((await fetchSource("owner/repo", "README.md", "main", fake)).content, content);
  await assert.rejects(
    () =>
      fetchSource(
        "owner/repo",
        "README.md",
        "main",
        async () => new Response("", { status: 429, headers: { "retry-after": "120" } }),
      ),
    (e) => e.code === "GITHUB_RATE_LIMITED" && e.message.includes("2 minutes"),
  );
  process.env.CONCLAVE_GITHUB_PUBLIC_READ_TOKEN = "test-public-read";
  try {
    await fetchSource("owner/repo", "README.md", "main", async (url, init) => {
      assert.ok(url.startsWith("https://api.github.com/repos/owner/repo/contents/"));
      assert.equal(init.headers.Authorization, "Bearer test-public-read");
      return new Response(
        JSON.stringify({
          type: "file",
          encoding: "base64",
          size: Buffer.byteLength(content),
          content: Buffer.from(content).toString("base64"),
          sha: "a".repeat(40),
        }),
      );
    });
  } finally {
    delete process.env.CONCLAVE_GITHUB_PUBLIC_READ_TOKEN;
  }
  await assert.rejects(() =>
    fetchSource("owner/repo", "README.md", "main", async () => new Response("x".repeat(400001))),
  );
  const owner = await person(),
    other = await person(),
    project = randomUUID();
  await pool.query("INSERT INTO projects(id,account_id,title) VALUES($1,$2,'Source project')", [
    project,
    owner.id,
  ]);
  const old = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    const created = await request(owner, "connections", {
      projectId: project,
      name: "Notes",
      repository: "owner/repo",
      path: "README.md",
      ref: "main",
    });
    assert.equal(created.status, 201);
    const id = created.body.id;
    assert.equal((await request(other, `connections/${id}`)).status, 404);
    assert.equal((await request(owner, `connections/${id}`)).body.content, content);
    const a = await request(owner, "agents", {
      name: "Reader",
      instructions: "Summarize the source.",
      projectId: project,
      family: "gpt",
      connectionIds: [id],
      intervalHours: 1,
      perRunUsd6: "5000",
      totalUsd6: "10000",
    });
    assert.equal(a.status, 201);
    assert.equal((await request(owner, `connections/${id}`, undefined, "DELETE")).status, 200);
    assert.equal((await request(owner, `agents/${a.body.id}/run`, {})).status, 409);
    assert.equal(
      (await pool.query("SELECT content_ciphertext FROM workspace_connections WHERE id=$1", [id]))
        .rows[0].content_ciphertext,
      null,
    );
  } finally {
    globalThis.fetch = old;
  }
});

test("Receipt keys rotate deterministically without exposing the master secret", () => {
  const master = "ab".repeat(32),
    a = weeklySigner(master, Date.parse("2026-10-14T00:00:00Z")),
    same = weeklySigner(master, Date.parse("2026-10-14T01:00:00Z")),
    later = weeklySigner(master, Date.parse("2026-10-22T00:00:00Z"));
  assert.equal(a.record.publicKey, same.record.publicKey);
  assert.notEqual(a.record.publicKey, later.record.publicKey);
  assert.equal(Date.parse(a.record.validUntil) - Date.parse(a.record.validFrom), 7 * 86400000);
  assert.ok(!JSON.stringify(a.record).includes(master));
});
