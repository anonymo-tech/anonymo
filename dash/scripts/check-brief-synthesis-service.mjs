import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import { testEndpoint } from './check-database.mjs';
import {
  generateSessionToken,
  hashToken,
  SESSION_COOKIE_NAME,
} from '../server/auth/index.ts';
import {
  configuredKeyring,
  encryptText,
  decryptText,
} from '../server/core/encryption.ts';
import {
  creditVerifiedDeposit,
  getBalance,
  settleHold,
} from '../server/ledger/ledger.ts';
import { dispatch } from '../server/routes/dispatch.ts';
import { runNextCall } from '../server/routes/call-worker.ts';
import {
  quoteBriefSynthesis,
  approveBriefSynthesis,
  evaluateBriefSynthesisForCall,
  runBriefSynthesisSweep,
  trustedBriefSynthesisInput,
} from '../server/briefs/execution.ts';
import {
  getBriefSynthesis,
  assertBriefSynthesisDeletable,
} from '../server/briefs/store.ts';
import { hashSynthesisText } from '../server/briefs/protocol.ts';

const connection = testEndpoint(process.env.CONCLAVE_TEST_DATABASE_URL).href;
Object.assign(process.env, {
  CONCLAVE_MODE: 'service',
  CONCLAVE_APP_ORIGIN: 'https://conclave.test',
  CONCLAVE_DATABASE_URL: connection,
  CONCLAVE_DATA_KEYS: JSON.stringify({
    test: randomBytes(32).toString('base64'),
  }),
  CONCLAVE_ACTIVE_DATA_KEY: 'test',
  GATEWAY_API_KEY: 'synthetic-provider-fixture',
  GATEWAY_API_ORIGIN: 'https://api.inference.invalid',
  GATEWAY_EVIDENCE_ORIGINS: '["https://inference.invalid","https://www.inference.invalid"]',
  CONCLAVE_INFERENCE_ENABLED: 'true',
  CONCLAVE_BRIEF_SYNTHESIS_ENABLED: 'true',
});
const pool = createDatabase(connection, 12),
  keys = configuredKeyring();
before(() => migrate(pool));
after(() => pool.end());
const code = (value) => (error) => error.code === value;
async function fixture(
  answers = [
    'A narrow beta tests the core workflow.',
    'A narrow beta may miss onboarding problems.',
  ],
) {
  const accountId = randomUUID(),
    projectId = randomUUID(),
    briefId = randomUUID(),
    routeVersionId = randomUUID(),
    token = generateSessionToken(),
    savedAt = new Date().toISOString();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
  await pool.query(
    "INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [await hashToken(token), accountId],
  );
  await pool.query(
    "INSERT INTO projects(id,account_id,title) VALUES($1,$2,'Synthetic project')",
    [projectId, accountId],
  );
  await creditVerifiedDeposit(pool, {
    accountId,
    reference: `fixture_${randomUUID()}`,
    amountUsd6: '1000000',
  });
  await pool.query(
    `INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,card,pricing,expires_at) VALUES($1,$2,1,'claude-opus-5.5','claude','chat',true,$3,$4,now()+interval '1 hour')`,
    [
      routeVersionId,
      randomUUID(),
      {
        reviewed: true,
        retentionDisclosure: 'Synthetic reviewed terms.',
        evidenceUrl: 'https://example.test/terms',
        evidenceDate: '2026-10-09',
      },
      {
        inputPerMillionUsd6: '1000000',
        outputPerMillionUsd6: '1000000',
        markupBps: 0,
        maxInputBytes: 32768,
        maxOutputTokens: 8192,
      },
    ],
  );
  const evidence = [];
  for (const answer of answers)
    evidence.push({
      callId: randomUUID(),
      comparisonId: randomUUID(),
      routeVersionId: randomUUID(),
      modelId: 'duplicate-model-label',
      question: 'What should the beta test?',
      answer,
      answerHash: await hashSynthesisText(answer),
      actualUsd6: '10',
      billingState: 'captured',
    });
  const evidenceHash = await hashSynthesisText(JSON.stringify(evidence));
  await pool.query(
    "INSERT INTO briefs(id,account_id,project_id,title,body_ciphertext) VALUES($1,$2,$3,'Synthetic Brief',$4)",
    [
      briefId,
      accountId,
      projectId,
      await encryptText(
        'Synthetic Brief',
        `${accountId}:brief:${briefId}`,
        keys,
      ),
    ],
  );
  await pool.query(
    'INSERT INTO brief_documents(brief_id,evidence_ciphertext,evidence_hash,analysis_ciphertext,saved_at) VALUES($1,$2,$3,$4,$5)',
    [
      briefId,
      await encryptText(
        JSON.stringify(evidence),
        `${accountId}:brief-evidence:${briefId}`,
        keys,
      ),
      evidenceHash,
      await encryptText(
        JSON.stringify({ decision: '', notes: [], matrix: [] }),
        `${accountId}:brief-analysis:${briefId}`,
        keys,
      ),
      savedAt,
    ],
  );
  return {
    accountId,
    projectId,
    briefId,
    routeVersionId,
    evidenceHash,
    evidence,
    cookie: `${SESSION_COOKIE_NAME}=${token}`,
  };
}
const quote = (f) =>
  quoteBriefSynthesis(pool, { ...f, maxOutputTokens: 1024 }, keys);
const approval = (f, q) => ({
  accountId: f.accountId,
  runId: q.plan.id,
  quoteId: q.quote.id,
  idempotencyKey: q.plan.approvalKey,
  approveMaximumUsd6: q.quote.maximumUsd6,
});
const approve = (f, q) => approveBriefSynthesis(pool, approval(f, q), keys);
async function api(
  f,
  path,
  body,
  method = body === undefined ? 'GET' : 'POST',
) {
  const response = await dispatch(
    new Request(`https://conclave.test/api/${path}`, {
      method,
      headers: {
        origin: 'https://conclave.test',
        cookie: f.cookie,
        'content-type': 'application/json',
        'X-Conclave-Account-Id': f.accountId,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: await response.json() };
}
function provider(mode = 'valid') {
  return {
    async *chat(input) {
      const sources = JSON.parse(input.messages[1].content).sources;
      const output = {
        version: 1,
        summaries: sources.map((s) => ({
          callId: s.callId,
          text: 'A model assessment of this saved response.',
          quotes: [
            mode === 'invalid' ? 'Absent quotation.' : s.answer.slice(0, 100),
          ],
        })),
        matrix: [
          {
            topic: 'Beta scope',
            positions: sources.map((s, i) => ({
              callId: s.callId,
              position: i ? 'disagrees' : 'agrees',
              quote: s.answer.slice(0, 100),
            })),
          },
        ],
      };
      yield { type: 'text', text: JSON.stringify(output) };
      yield {
        type: 'done',
        costUsd6: mode === 'unknown' ? null : '100',
        providerId: 'synthetic-result',
      };
    },
  };
}
async function drain(mode = 'valid') {
  while (await runNextCall(pool, provider(mode), keys)) {}
  await runBriefSynthesisSweep(pool, keys);
}
async function count(table, where, params) {
  return (
    await pool.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
      params,
    )
  ).rows[0].n;
}

void test('quote freezes server evidence without creating a call or reservation', async () => {
  const f = await fixture(),
    q = await quote(f);
  assert.equal(q.plan.state, 'quoted');
  assert.equal(q.plan.approvalKey, `bs_${q.plan.id}`);
  assert.equal(q.quote.inputBytes > 1000, true);
  assert.equal(await count('calls', 'account_id=$1', [f.accountId]), 0);
  assert.equal((await getBalance(pool, f.accountId)).reservedUsd6, '0');
  assert.equal(
    (await api(f, `brief-syntheses/${q.plan.id}`)).body.run.evidenceHash,
    f.evidenceHash,
  );
});
void test('concurrent approvals and response-loss recovery reuse one call and one hold', async () => {
  const f = await fixture(),
    q = await quote(f),
    runs = await Promise.all([approve(f, q), approve(f, q)]);
  assert.equal(runs.filter((r) => !r.replayed).length, 1);
  assert.equal(runs[0].run.callId, runs[1].run.callId);
  assert.equal(await count('calls', 'account_id=$1', [f.accountId]), 1);
  assert.equal(await count('holds', 'account_id=$1', [f.accountId]), 1);
  await pool.query(
    "UPDATE quotes SET expires_at=now()-interval '1 minute' WHERE id=$1",
    [q.quote.id],
  );
  process.env.CONCLAVE_BRIEF_SYNTHESIS_ENABLED = 'false';
  try {
    assert.equal((await approve(f, q)).replayed, true);
  } finally {
    process.env.CONCLAVE_BRIEF_SYNTHESIS_ENABLED = 'true';
  }
  await drain();
});
void test('exact maximum and approval key are required before reservation', async () => {
  const f = await fixture(),
    q = await quote(f);
  for (const extra of [
    { approveMaximumUsd6: '1' },
    { idempotencyKey: `bs_${randomUUID()}` },
    { quoteId: randomUUID() },
  ])
    await assert.rejects(
      approveBriefSynthesis(pool, { ...approval(f, q), ...extra }, keys),
      code('SYNTHESIS_APPROVAL_MISMATCH'),
    );
  assert.equal(await count('holds', 'account_id=$1', [f.accountId]), 0);
});
void test('stale evidence and unsupported source controls fail before quote insertion', async () => {
  const f = await fixture();
  await assert.rejects(
    quoteBriefSynthesis(
      pool,
      { ...f, evidenceHash: '0'.repeat(64), maxOutputTokens: 1024 },
      keys,
    ),
    code('EVIDENCE_CHANGED'),
  );
  const bad = await fixture(['A response with\u0081 unsupported control.']);
  await assert.rejects(quote(bad), code('UNSUPPORTED_SYNTHESIS_SOURCE'));
  assert.equal(
    await count('quotes', 'account_id=ANY($1::uuid[])', [
      [f.accountId, bad.accountId],
    ]),
    0,
  );
});
void test('wrapped UTF8 source overflow is rejected without truncation or charge', async () => {
  const f = await fixture(['文'.repeat(15000)]);
  await assert.rejects(quote(f), code('SYNTHESIS_INPUT_TOO_LARGE'));
  assert.equal(await count('quotes', 'account_id=$1', [f.accountId]), 0);
});
void test('generic calls cannot consume synthesis quotes or accept privileged system messages', async () => {
  const f = await fixture(),
    q = await quote(f);
  for (const role of ['system', 'user']) {
    const r = await api(f, 'calls', {
      projectId: f.projectId,
      routeVersionId: f.routeVersionId,
      quoteId: q.quote.id,
      idempotencyKey: randomUUID(),
      messages: [{ role, content: 'Client substitute' }],
      maxOutputTokens: 1024,
      privacy: 'standard',
    });
    assert.equal(r.status >= 400, true);
  }
  assert.equal(await count('holds', 'account_id=$1', [f.accountId]), 0);
});
void test('trusted source input rejects substitution and never trusts unbound system messages', async () => {
  const f = await fixture(),
    q = await quote(f),
    accepted = await approve(f, q),
    call = (
      await pool.query('SELECT * FROM calls WHERE id=$1', [accepted.run.callId])
    ).rows[0];
  const input = JSON.parse(
    await decryptText(
      call.input_ciphertext,
      `${f.accountId}:call-input:${call.id}`,
      keys,
    ),
  );
  assert.deepEqual(
    await trustedBriefSynthesisInput(pool, call, input, keys),
    input,
  );
  input.messages[1].content = 'Substituted evidence';
  await assert.rejects(
    trustedBriefSynthesisInput(pool, call, input, keys),
    code('SYNTHESIS_INPUT_MISMATCH'),
  );
  assert.equal(
    await trustedBriefSynthesisInput(
      pool,
      { ...call, id: randomUUID() },
      input,
      keys,
    ),
    null,
  );
  await drain();
});
void test('valid output retains every duplicate-model source and exact quote offsets', async () => {
  const f = await fixture(),
    q = await quote(f);
  await approve(f, q);
  await drain();
  const run = await getBriefSynthesis(pool, f.accountId, q.plan.id, keys);
  assert.equal(run.state, 'valid');
  assert.equal(run.billing.actualUsd6, '100');
  assert.equal(run.result.analysis.summaries.length, 2);
  for (const summary of run.result.analysis.summaries) {
    const source = f.evidence.find((s) => s.callId === summary.callId);
    assert.equal(
      summary.quotes[0].text,
      source.answer.slice(summary.quotes[0].start, summary.quotes[0].end),
    );
  }
});
void test('invalid paid output remains charged and is never silently repaired or selected', async () => {
  const f = await fixture(),
    q = await quote(f);
  await approve(f, q);
  await drain('invalid');
  const run = await getBriefSynthesis(pool, f.accountId, q.plan.id, keys);
  assert.equal(run.state, 'invalid');
  assert.equal(run.billing.actualUsd6, '100');
  assert.equal(run.result.analysis, null);
  assert.equal((await getBalance(pool, f.accountId)).availableUsd6, '999900');
  assert.equal(
    (
      await api(
        f,
        `briefs/${f.briefId}/synthesis/selection`,
        { revision: 1, runId: run.id },
        'PATCH',
      )
    ).status,
    409,
  );
  await evaluateBriefSynthesisForCall(pool, run.callId, keys);
  assert.equal(await count('calls', 'account_id=$1', [f.accountId]), 1);
});
void test('unknown cost retains reservation and blocks deletion without paid retry', async () => {
  const f = await fixture(),
    q = await quote(f);
  await approve(f, q);
  await drain('unknown');
  const run = await getBriefSynthesis(pool, f.accountId, q.plan.id, keys);
  assert.equal(run.state, 'reconciliation_pending');
  assert.equal(run.billing.actualUsd6, null);
  assert.equal(
    (await getBalance(pool, f.accountId)).reservedUsd6,
    q.quote.maximumUsd6,
  );
  assert.equal(
    (await api(f, `briefs/${f.briefId}`, { revision: 1 }, 'DELETE')).status,
    409,
  );
  assert.equal((await approve(f, q)).run.callId, run.callId);
  assert.equal(
    await count('brief_synthesis_results', 'plan_id=$1', [run.id]),
    0,
  );
});
void test('owner selection enriches the Brief and uses revision CAS without changing evidence', async () => {
  const f = await fixture(),
    q = await quote(f);
  await approve(f, q);
  await drain();
  const selected = await api(
    f,
    `briefs/${f.briefId}/synthesis/selection`,
    { revision: 1, runId: q.plan.id },
    'PATCH',
  );
  assert.equal(selected.status, 200);
  assert.equal(selected.body.brief.revision, 2);
  assert.equal(selected.body.brief.document.synthesis.runId, q.plan.id);
  assert.deepEqual(selected.body.brief.document.evidence, f.evidence);
  assert.equal(
    (
      await api(
        f,
        `briefs/${f.briefId}/synthesis/selection`,
        { revision: 1, runId: null },
        'PATCH',
      )
    ).status,
    409,
  );
  const cleared = await api(
    f,
    `briefs/${f.briefId}/synthesis/selection`,
    { revision: 2, runId: null },
    'PATCH',
  );
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.brief.document.synthesis, undefined);
});
void test('foreign account reads approvals and selection cannot reach another source', async () => {
  const a = await fixture(),
    b = await fixture(),
    q = await quote(a);
  assert.equal((await api(b, `brief-syntheses/${q.plan.id}`)).status, 404);
  await assert.rejects(
    approveBriefSynthesis(
      pool,
      { ...approval(a, q), accountId: b.accountId },
      keys,
    ),
    code('SYNTHESIS_NOT_FOUND'),
  );
  assert.equal(
    (
      await api(
        b,
        `briefs/${b.briefId}/synthesis/selection`,
        { revision: 1, runId: q.plan.id },
        'PATCH',
      )
    ).status,
    404,
  );
});
void test('terminal deletion detaches source but preserves paid immutable provenance', async () => {
  const f = await fixture(),
    q = await quote(f);
  await approve(f, q);
  await drain();
  assert.equal(
    (await api(f, `briefs/${f.briefId}`, { revision: 1 }, 'DELETE')).status,
    200,
  );
  const run = await getBriefSynthesis(pool, f.accountId, q.plan.id, keys);
  assert.equal(run.briefId, null);
  assert.equal(run.sourceBriefId, f.briefId);
  assert.equal(run.state, 'valid');
  assert.equal((await approve(f, q)).replayed, true);
  await assert.rejects(
    pool.query('UPDATE brief_synthesis_plans SET brief_id=$2 WHERE id=$1', [
      q.plan.id,
      randomUUID(),
    ]),
  );
  await assert.rejects(
    pool.query('DELETE FROM brief_synthesis_results WHERE plan_id=$1', [
      q.plan.id,
    ]),
  );
});
void test('deletion and approval serialize so no call begins after source removal', async () => {
  const f = await fixture(),
    q = await quote(f);
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [
    f.accountId,
  ]);
  await client.query('SELECT id FROM briefs WHERE id=$1 FOR UPDATE', [
    f.briefId,
  ]);
  const pending = approve(f, q).then(
    () => ({ accepted: true }),
    (error) => ({ error }),
  );
  await assertBriefSynthesisDeletable(client, f.accountId, f.briefId);
  await client.query('DELETE FROM briefs WHERE id=$1', [f.briefId]);
  await client.query('COMMIT');
  client.release();
  assert.equal((await pending).error.code, 'BRIEF_REMOVED');
  assert.equal(await count('calls', 'account_id=$1', [f.accountId]), 0);
});
void test('cancellation before dispatch releases funds and deterministic sweep records cancellation', async () => {
  const f = await fixture(),
    q = await quote(f);
  await approve(f, q);
  assert.equal(
    (await api(f, `brief-syntheses/${q.plan.id}/cancel`, {})).status,
    202,
  );
  await drain();
  const run = await getBriefSynthesis(pool, f.accountId, q.plan.id, keys);
  assert.equal(run.state, 'cancelled');
  assert.equal(run.billing.actualUsd6, '0');
  assert.equal((await getBalance(pool, f.accountId)).availableUsd6, '1000000');
});
void test('gate-off queued execution fails before provider dispatch and releases its reservation', async () => {
  const f = await fixture(),
    q = await quote(f);
  await approve(f, q);
  process.env.CONCLAVE_BRIEF_SYNTHESIS_ENABLED = 'false';
  let dispatched = 0;
  try {
    while (
      await runNextCall(
        pool,
        {
          async *chat() {
            dispatched++;
            yield { type: 'done', costUsd6: '100' };
          },
        },
        keys,
      )
    ) {}
    await runBriefSynthesisSweep(pool, keys);
  } finally {
    process.env.CONCLAVE_BRIEF_SYNTHESIS_ENABLED = 'true';
  }
  assert.equal(dispatched, 0);
  const run = await getBriefSynthesis(pool, f.accountId, q.plan.id, keys);
  assert.equal(run.state, 'failed');
  assert.equal(run.billing.actualUsd6, '0');
});
void test('metadata pages omit full generated analysis and full reads restore it', async () => {
  const f = await fixture(),
    q = await quote(f);
  await approve(f, q);
  await drain();
  const list = await api(f, `briefs/${f.briefId}/syntheses`);
  assert.equal(list.status, 200);
  assert.equal(list.body.runs[0].metadataOnly, true);
  assert.equal(list.body.runs[0].result.analysis, null);
  const full = await api(f, `brief-syntheses/${q.plan.id}`);
  assert.equal(full.body.run.metadataOnly, false);
  assert.ok(full.body.run.result.analysis);
});

void test('evaluation storage failures preserve the paid response for bounded deterministic recovery', async () => {
  const f = await fixture(),
    q = await quote(f),
    accepted = await approve(f, q),
    callId = accepted.run.callId;
  const call = (await pool.query('SELECT * FROM calls WHERE id=$1', [callId]))
      .rows[0],
    input = JSON.parse(
      await decryptText(
        call.input_ciphertext,
        `${f.accountId}:call-input:${callId}`,
        keys,
      ),
    );
  let output = '';
  for await (const event of provider().chat(input))
    if (event.type === 'text') output += event.text;
  await settleHold(pool, {
    accountId: f.accountId,
    holdId: call.hold_id,
    actualUsd6: '100',
    providerReference: 'synthetic-result',
  });
  await pool.query(
    "UPDATE calls SET state='succeeded',output_ciphertext=$2 WHERE id=$1",
    [
      callId,
      await encryptText(output, `${f.accountId}:call-output:${callId}`, keys),
    ],
  );
  await pool.query("UPDATE jobs SET state='succeeded' WHERE reference=$1", [
    `inference:${callId}`,
  ]);
  const unavailableActiveKey = {
    active: 'unavailable',
    keys: { ...keys.keys, unavailable: 'AQ==' },
  };
  const sweep = await runBriefSynthesisSweep(pool, unavailableActiveKey);
  assert.equal(sweep.failed, 1);
  assert.equal(
    await count('brief_synthesis_results', 'plan_id=$1', [q.plan.id]),
    0,
  );
  assert.equal(
    (await getBriefSynthesis(pool, f.accountId, q.plan.id, keys)).state,
    'awaiting_evaluation',
  );
  const progress = (
    await pool.query(
      'SELECT attempts,next_attempt_at>now() AS delayed FROM brief_synthesis_evaluation_progress WHERE plan_id=$1',
      [q.plan.id],
    )
  ).rows[0];
  assert.equal(progress.attempts, 1);
  assert.equal(progress.delayed, true);
  assert.deepEqual(await runBriefSynthesisSweep(pool, keys), {
    evaluated: 0,
    failed: 0,
  });
  process.env.CONCLAVE_BRIEF_SYNTHESIS_ENABLED = 'false';
  try {
    const recovered = await evaluateBriefSynthesisForCall(pool, callId, keys);
    assert.equal(recovered.state, 'valid');
    assert.equal(recovered.billing.actualUsd6, '100');
  } finally {
    process.env.CONCLAVE_BRIEF_SYNTHESIS_ENABLED = 'true';
  }
  assert.equal(await count('calls', 'account_id=$1', [f.accountId]), 1);
});

void test('source plan and settled result constraints reject detached and premature records', async () => {
  const f = await fixture(),
    q = await quote(f);
  await approve(f, q);
  await assert.rejects(
    pool.query('UPDATE brief_synthesis_plans SET brief_id=NULL WHERE id=$1', [
      q.plan.id,
    ]),
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO brief_synthesis_results(plan_id,status,invalid_reason) VALUES($1,'failed','CALL_FAILED')",
      [q.plan.id],
    ),
  );
  await assert.rejects(
    pool.query(
      'UPDATE brief_synthesis_executions SET approved_maximum_usd6=1 WHERE plan_id=$1',
      [q.plan.id],
    ),
  );
  await drain();
});

void test('quote expiry is checked after a waiting approval acquires its account lock', async () => {
  const f = await fixture(),
    q = await quote(f),
    client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [
    f.accountId,
  ]);
  await pool.query(
    "UPDATE quotes SET expires_at=clock_timestamp()+interval '400 milliseconds' WHERE id=$1",
    [q.quote.id],
  );
  const pending = approve(f, q).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  let waiting = false;
  for (let i = 0; i < 10 && !waiting; i++) {
    waiting = (
      await pool.query(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM accounts WHERE id=$1 AND%') AS waiting",
      )
    ).rows[0].waiting;
    if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  try {
    assert.equal(waiting, true);
    await new Promise((resolve) => setTimeout(resolve, 450));
  } finally {
    await client.query('COMMIT');
    client.release();
  }
  assert.equal((await pending).error?.code, 'QUOTE_EXPIRED');
  assert.equal(await count('holds', 'account_id=$1', [f.accountId]), 0);
});
