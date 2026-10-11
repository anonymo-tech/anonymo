import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { createDatabase } from '../server/db/database.ts';
import {
  generateSessionToken,
  hashToken,
  SESSION_COOKIE_NAME,
} from '../server/auth/index.ts';
import { creditVerifiedDeposit, settleHold } from '../server/ledger/ledger.ts';
import { dispatch } from '../server/routes/dispatch.ts';
import { migrate } from './migrate.mjs';
import { configuredKeyring, encryptText } from '../server/core/encryption.ts';

const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
if (!connection)
  throw new Error(
    'Set CONCLAVE_TEST_DATABASE_URL to an isolated local test database.',
  );
const url = new URL(connection);
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
  !url.pathname.endsWith('_test')
)
  throw new Error('An isolated loopback test database is required.');
Object.assign(process.env, {
  CONCLAVE_MODE: 'service',
  CONCLAVE_APP_ORIGIN: 'https://conclave.test',
  CONCLAVE_DATABASE_URL: connection,
  CONCLAVE_DATA_KEYS: JSON.stringify({
    test: randomBytes(32).toString('base64'),
  }),
  CONCLAVE_ACTIVE_DATA_KEY: 'test',
  GATEWAY_API_KEY: 'fixture-not-a-provider-key',
  GATEWAY_API_ORIGIN: 'https://api.inference.invalid',
  GATEWAY_EVIDENCE_ORIGINS: '["https://inference.invalid","https://www.inference.invalid"]',
  CONCLAVE_INFERENCE_ENABLED: 'true',
});
const pool = createDatabase(connection, 12);
before(async () => {
  await migrate(pool);
});
after(async () => {
  await pool.end();
});
async function owner(balance = '1000000', distinctPrices = false) {
  const id = randomUUID(),
    token = generateSessionToken(),
    projectId = randomUUID();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [id]);
  await pool.query(
    "INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [await hashToken(token), id],
  );
  await pool.query(
    "INSERT INTO projects(id,account_id,title) VALUES($1,$2,'Owned comparison')",
    [projectId, id],
  );
  if (balance !== '0')
    await creditVerifiedDeposit(pool, {
      accountId: id,
      reference: `fixture_${randomUUID()}`,
      amountUsd6: balance,
    });
  const items = [];
  for (const [family, model] of [
    ['claude', 'claude-opus-5.5'],
    ['gemini', 'google/gemini-3.1-pro-preview'],
    ['gpt', 'gpt-6.1-sol'],
    ['grok', 'x-ai/grok-4.7'],
  ]) {
    const routeVersionId = randomUUID();
    await pool.query(
      `INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,card,pricing,expires_at)
      VALUES($1,$2,1,$3,$4,'chat',true,$5,$6,now()+interval '1 hour')`,
      [
        routeVersionId,
        randomUUID(),
        model,
        family,
        {
          reviewed: true,
          retentionDisclosure: 'Test only.',
          evidenceUrl: 'https://example.test/terms',
          evidenceDate: '2026-10-09',
        },
        {
          inputPerMillionUsd6: String(
            1000000 * (distinctPrices ? items.length + 1 : 1),
          ),
          outputPerMillionUsd6: '1000000',
          markupBps: 0,
          maxInputBytes: 32768,
          maxOutputTokens: 2048,
        },
      ],
    );
    items.push({
      routeVersionId,
      messages: [{ role: 'user', content: 'Compare the tradeoffs.' }],
      maxOutputTokens: 128,
      privacy: 'standard',
    });
  }
  return { id, projectId, items, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}
async function api(
  user,
  path,
  body,
  method = body === undefined ? 'GET' : 'POST',
) {
  const response = await dispatch(
    new Request(`https://conclave.test/api/${path}`, {
      method,
      headers: {
        origin: 'https://conclave.test',
        cookie: user.cookie,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: await response.json() };
}
async function quoted(user, blind = false) {
  const response = await api(user, 'comparison-quotes', {
    projectId: user.projectId,
    items: user.items,
    blind,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return {
    projectId: user.projectId,
    blind,
    idempotencyKey: randomUUID(),
    items: user.items.map((item, index) => ({
      ...item,
      quoteId: response.body.quotes[index].id,
    })),
    maximum: response.body.maximumUsd6,
  };
}

async function setup({
  blind = false,
  complete = true,
  text = 'A synthetic response.',
} = {}) {
  const user = await owner();
  user.items = user.items.slice(0, 2);
  const quote = await quoted(user, blind);
  const created = await api(user, 'comparisons', quote);
  assert.equal(created.status, 202);
  const comparison = created.body.comparison;
  if (complete)
    for (const call of comparison.calls) {
      const row = (
        await pool.query('SELECT hold_id FROM calls WHERE id=$1', [call.id])
      ).rows[0];
      await settleHold(pool, {
        accountId: user.id,
        holdId: row.hold_id,
        actualUsd6: '100',
        providerReference: null,
      });
      await pool.query(
        "UPDATE calls SET state='succeeded',output_ciphertext=$2 WHERE id=$1",
        [
          call.id,
          await encryptText(
            text,
            `${user.id}:call-output:${call.id}`,
            configuredKeyring(),
          ),
        ],
      );
    }
  return {
    user,
    comparison,
    body: {
      projectId: user.projectId,
      title: 'Saved comparison',
      callIds: comparison.calls.map((c) => c.id),
      idempotencyKey: randomUUID(),
    },
  };
}

void test('structured Brief is created from owned evidence with exact cost and encrypted records', async () => {
  const { user, body } = await setup();
  const result = await api(user, 'briefs/from-calls', body);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const brief = result.body.brief;
  assert.equal(brief.document.evidence.length, 2);
  assert.equal(brief.document.evidence[0].actualUsd6, '100');
  assert.equal(brief.document.evidence[0].answer, 'A synthetic response.');
  assert.match(brief.body, /\$0\.000100/);
  const saved = (
    await pool.query('SELECT * FROM brief_documents WHERE brief_id=$1', [
      brief.id,
    ])
  ).rows[0];
  assert.ok(!saved.evidence_ciphertext.includes('synthetic'));
  assert.ok(!saved.analysis_ciphertext.includes('decision'));
  assert.deepEqual(
    (await api(user, `briefs/${brief.id}`)).body.brief.document,
    brief.document,
  );
});

void test('racing Brief creation keys return one saved record and reject changed intent', async () => {
  const { user, body } = await setup();
  const replies = await Promise.all(
    Array.from({ length: 5 }, () => api(user, 'briefs/from-calls', body)),
  );
  assert.ok(
    replies.every((r) => [200, 201].includes(r.status)),
    JSON.stringify(replies),
  );
  assert.equal(new Set(replies.map((r) => r.body.brief.id)).size, 1);
  assert.equal(
    (await api(user, 'briefs/from-calls', { ...body, title: 'Changed' }))
      .status,
    409,
  );
});

void test('foreign project and call selections cannot be copied into a Brief', async () => {
  const { user, body } = await setup(),
    stranger = await owner();
  assert.equal((await api(stranger, 'briefs/from-calls', body)).status, 404);
  assert.equal(
    (
      await api(stranger, 'briefs/from-calls', {
        ...body,
        projectId: stranger.projectId,
      })
    ).status,
    404,
  );
  const saved = (await api(user, 'briefs/from-calls', body)).body.brief;
  assert.equal((await api(stranger, `briefs/${saved.id}`)).status, 404);
  assert.equal(
    (
      await api(
        stranger,
        `briefs/${saved.id}/document`,
        { title: saved.title, revision: 1, analysis: saved.document.analysis },
        'PATCH',
      )
    ).status,
    404,
  );
});

void test('unrevealed blind responses remain unavailable to Brief provenance', async () => {
  const { user, body, comparison } = await setup({ blind: true });
  assert.equal((await api(user, 'briefs/from-calls', body)).status, 409);
  assert.equal(
    (await api(user, `comparisons/${comparison.id}/reveal`, {})).status,
    200,
  );
  assert.equal((await api(user, 'briefs/from-calls', body)).status, 201);
});

void test('incomplete duplicate and oversized responses fail without partial saved evidence', async () => {
  const pending = await setup({ complete: false });
  assert.equal(
    (await api(pending.user, 'briefs/from-calls', pending.body)).status,
    409,
  );
  const large = await setup({ text: 'x'.repeat(13000) });
  assert.equal(
    (await api(large.user, 'briefs/from-calls', large.body)).status,
    413,
  );
  assert.equal(
    (
      await api(large.user, 'briefs/from-calls', {
        ...large.body,
        callIds: [large.body.callIds[0], large.body.callIds[0]],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await pool.query(
        'SELECT id FROM briefs WHERE account_id=ANY($1::uuid[])',
        [[pending.user.id, large.user.id]],
      )
    ).rowCount,
    0,
  );
});

void test('assessment edits keep original evidence immutable and revisions reject stale writers', async () => {
  const { user, body } = await setup();
  const original = (await api(user, 'briefs/from-calls', body)).body.brief;
  const analysis = {
    decision: 'Use the smaller plan.',
    notes: [{ callId: body.callIds[0], text: 'My summary.' }],
    matrix: [
      {
        topic: 'Start small',
        positions: body.callIds.map((callId, i) => ({
          callId,
          position: i ? 'unclear' : 'agrees',
        })),
      },
    ],
  };
  const edit = {
    title: 'My edited title',
    revision: 1,
    analysis,
    document: { evidence: [] },
  };
  const updated = await api(
    user,
    `briefs/${original.id}/document`,
    edit,
    'PATCH',
  );
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.brief.revision, 2);
  assert.deepEqual(
    updated.body.brief.document.evidence,
    original.document.evidence,
  );
  assert.equal(
    updated.body.brief.document.evidenceHash,
    original.document.evidenceHash,
  );
  assert.match(updated.body.brief.body, /Use the smaller plan/);
  assert.equal(
    (await api(user, `briefs/${original.id}/document`, edit, 'PATCH')).status,
    409,
  );
  assert.equal(
    (
      await api(
        user,
        `briefs/${original.id}`,
        { revision: 2, title: 'Forgery', body: 'Replaced original' },
        'PATCH',
      )
    ).status,
    409,
  );
  await assert.rejects(
    pool.query(
      "UPDATE brief_documents SET evidence_hash=repeat('a',64) WHERE brief_id=$1",
      [original.id],
    ),
    /immutable/,
  );
});

void test('invalid assessment ownership and secret notes fail without changing the saved revision', async () => {
  const { user, body } = await setup();
  const brief = (await api(user, 'briefs/from-calls', body)).body.brief;
  const edit = {
    title: brief.title,
    revision: 1,
    analysis: {
      decision: '',
      notes: [{ callId: randomUUID(), text: 'Wrong owner' }],
      matrix: [],
    },
  };
  assert.equal(
    (await api(user, `briefs/${brief.id}/document`, edit, 'PATCH')).status,
    400,
  );
  edit.analysis.notes = [];
  edit.analysis.decision =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  assert.equal(
    (await api(user, `briefs/${brief.id}/document`, edit, 'PATCH')).status,
    422,
  );
  assert.equal((await api(user, `briefs/${brief.id}`)).body.brief.revision, 1);
});

void test('removed Brief creation replay never resurrects deleted content', async () => {
  const { user, body } = await setup();
  const brief = (await api(user, 'briefs/from-calls', body)).body.brief;
  assert.equal(
    (await api(user, `briefs/${brief.id}`, { revision: 1 }, 'DELETE')).status,
    200,
  );
  assert.equal((await api(user, 'briefs/from-calls', body)).status, 410);
  assert.equal(
    (
      await pool.query(
        'SELECT brief_id FROM brief_documents WHERE brief_id=$1',
        [brief.id],
      )
    ).rowCount,
    0,
  );
});
