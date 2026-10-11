import assert from 'node:assert/strict';
import {
  randomUUID,
  randomBytes,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import test, { before, after } from 'node:test';
import bs58 from 'bs58';
import { createDatabase, transaction } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import { dispatch } from '../server/routes/dispatch.ts';
import {
  claimJob,
  enqueue,
  failJob,
  finishJob,
  recoverExpiredJobs,
} from '../server/db/jobs.ts';
import {
  configuredKeyring,
  encryptText,
  decryptText,
} from '../server/core/encryption.ts';
import { runNextCall } from '../server/routes/call-worker.ts';
import { creditVerifiedDeposit, getBalance } from '../server/ledger/ledger.ts';
import { GatewayError } from '../server/gateway/index.ts';

const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
if (!connection)
  throw new Error(
    'Set CONCLAVE_TEST_DATABASE_URL to an isolated PostgreSQL test database.',
  );
const url = new URL(connection);
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
  !url.pathname.endsWith('_test')
)
  throw new Error('Tests require an isolated local test database.');
process.env.CONCLAVE_MODE = 'service';
process.env.CONCLAVE_APP_ORIGIN = 'https://conclave.test';
process.env.CONCLAVE_DATABASE_URL = connection;
process.env.CONCLAVE_DATA_KEYS = JSON.stringify({
  test: randomBytes(32).toString('base64'),
});
process.env.CONCLAVE_ACTIVE_DATA_KEY = 'test';
const pool = createDatabase(connection, 8);
before(async () => {
  await migrate(pool);
});
after(async () => {
  await pool.end();
});

function request(
  path,
  { method = 'GET', body, cookie, origin = 'https://conclave.test' } = {},
) {
  return new Request(`https://conclave.test/api/${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      origin,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function signIn(
  method = { method: 'signIn', signInSupported: true },
  expectedStatus = 200,
) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const bytes = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const address = bs58.encode(bytes);
  const challengeResponse = await dispatch(
    request('auth/challenge', { method: 'POST', body: { address } }),
  );
  assert.equal(
    challengeResponse.status,
    201,
    await challengeResponse.clone().text(),
  );
  const { challenge } = await challengeResponse.json();
  const browserCookie = challengeResponse.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const payload = {
    challengeId: challenge.id,
    address,
    signatureType: 'ed25519',
    signedMessageBase64: Buffer.from(challenge.message).toString('base64'),
    signatureBase64: sign(
      null,
      Buffer.from(challenge.message),
      privateKey,
    ).toString('base64'),
    ...method,
  };
  const verify = await dispatch(
    request('auth/verify', {
      method: 'POST',
      body: payload,
      cookie: browserCookie,
    }),
  );
  assert.equal(verify.status, expectedStatus, await verify.clone().text());
  const cookie = verify.headers.get('set-cookie');
  const account = await verify.json();
  return { cookie, account, payload, browserCookie };
}

void test('wallet proof creates a secure owned session and nonce replay fails', async () => {
  const { cookie, account, payload } = await signIn();
  assert.match(cookie, /^__Host-conclave_session=/);
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/'])
    assert.ok(cookie.includes(flag));
  const replay = await dispatch(
    request('auth/verify', { method: 'POST', body: payload }),
  );
  assert.equal(replay.status, 401);
  const me = await dispatch(request('auth/session', { cookie }));
  assert.equal(me.status, 200);
  assert.equal((await me.json()).accountId, account.accountId);
  const anonymous = await dispatch(request('balance'));
  assert.equal(anonymous.status, 401);
  const balance = await dispatch(request('balance', { cookie }));
  assert.deepEqual(await balance.json(), {
    availableUsd6: '0',
    reservedUsd6: '0',
    currency: 'USD6',
  });
  await dispatch(request('auth/logout', { method: 'POST', cookie }));
  assert.equal(
    (await dispatch(request('auth/session', { cookie }))).status,
    401,
  );
});

void test('a plain signMessage proof is rejected with SIGN_IN_METHOD_REQUIRED when the wallet reports signIn support', async () => {
  const sessionsBefore = Number(
    (await pool.query('SELECT count(*) FROM sessions')).rows[0].count,
  );
  const rejected = await signIn(
    { method: 'signMessage', signInSupported: true },
    400,
  );
  assert.equal(rejected.account.error.code, 'SIGN_IN_METHOD_REQUIRED');
  assert.equal(rejected.cookie, null);
  assert.equal(
    Number((await pool.query('SELECT count(*) FROM sessions')).rows[0].count),
    sessionsBefore,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM identities WHERE kind='solana' AND subject=$1",
        [rejected.payload.address],
      )
    ).rows[0].count,
    '0',
  );
  // The challenge stays unconsumed; it simply expires.
  assert.equal(
    (
      await pool.query(
        'SELECT consumed_at FROM auth_challenges WHERE id=$1',
        [rejected.payload.challengeId],
      )
    ).rows[0].consumed_at,
    null,
  );
  for (const method of [
    {},
    { method: 'signIn', signInSupported: false },
    { method: 'signMessage' },
  ]) {
    const invalid = await signIn(method, 400);
    assert.equal(invalid.account.error.code, 'INVALID_REQUEST');
    assert.equal(invalid.cookie, null);
  }
  const signedIn = await signIn({ method: 'signIn', signInSupported: true });
  assert.match(signedIn.cookie, /^__Host-conclave_session=/);
  assert.equal(signedIn.account.method, 'signIn');
  const me = await dispatch(
    request('auth/session', { cookie: signedIn.cookie }),
  );
  assert.equal((await me.json()).accountId, signedIn.account.accountId);
  const fallback = await signIn({
    method: 'signMessage',
    signInSupported: false,
  });
  assert.match(fallback.cookie, /^__Host-conclave_session=/);
  assert.equal(fallback.account.method, 'signMessage');
});

void test('capabilities advertise Sign In With Solana with the exact-message fallback', async () => {
  const response = await dispatch(request('capabilities'));
  const { walletSignIn } = await response.json();
  assert.equal(walletSignIn.format, 'siws');
  assert.deepEqual(walletSignIn.formats, ['siws', 'siws-plain-v1']);
});

void test('cross-origin mutations, tampered cookies and disabled accounts are rejected', async () => {
  const { cookie, account } = await signIn();
  assert.equal(
    (
      await dispatch(
        request('projects', {
          method: 'POST',
          cookie,
          origin: 'https://other.test',
          body: { title: 'No' },
        }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await dispatch(
        request('balance', {
          cookie: `${cookie}; __Host-conclave_session=duplicate`,
        }),
      )
    ).status,
    401,
  );
  await pool.query('UPDATE accounts SET disabled_at=now() WHERE id=$1', [
    account.accountId,
  ]);
  assert.equal((await dispatch(request('balance', { cookie }))).status, 401);
});

void test('project and encrypted Brief ownership survive reload; stale saves cannot overwrite', async () => {
  const owner = await signIn(),
    other = await signIn();
  const response = await dispatch(
    request('projects', {
      method: 'POST',
      cookie: owner.cookie,
      body: { title: 'Owned project' },
    }),
  );
  const { project } = await response.json();
  assert.equal(response.status, 201);
  const otherUpdate = await dispatch(
    request(`projects/${project.id}`, {
      method: 'PATCH',
      cookie: other.cookie,
      body: { title: 'No', revision: 1 },
    }),
  );
  assert.equal(otherUpdate.status, 404);
  const body = {
    projectId: project.id,
    title: 'Decision',
    body: 'Private project decision.',
  };
  const created = await dispatch(
    request('briefs', { method: 'POST', cookie: owner.cookie, body }),
  );
  assert.equal(created.status, 201, await created.clone().text());
  const { brief } = await created.json();
  const row = (
    await pool.query('SELECT body_ciphertext FROM briefs WHERE id=$1', [
      brief.id,
    ])
  ).rows[0];
  assert.ok(!row.body_ciphertext.includes(body.body));
  assert.equal(
    (await dispatch(request(`briefs/${brief.id}`, { cookie: other.cookie })))
      .status,
    404,
  );
  const loaded = await dispatch(
    request(`briefs/${brief.id}`, { cookie: owner.cookie }),
  );
  assert.equal((await loaded.json()).brief.body, body.body);
  const edit = {
    title: 'Updated decision',
    body: 'Updated private decision.',
    revision: 1,
  };
  assert.equal(
    (
      await dispatch(
        request(`briefs/${brief.id}`, {
          method: 'PATCH',
          cookie: owner.cookie,
          body: edit,
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await dispatch(
        request(`briefs/${brief.id}`, {
          method: 'PATCH',
          cookie: owner.cookie,
          body: edit,
        }),
      )
    ).status,
    409,
  );
});

void test('authenticated encryption rejects swapped owners, tampering and missing keys; rotated keys read old data', async () => {
  const old = configuredKeyring();
  const encrypted = await encryptText('private', 'owner-a:brief:one', old);
  const rotated = {
    active: 'next',
    keys: { ...old.keys, next: randomBytes(32).toString('base64') },
  };
  assert.equal(
    await decryptText(encrypted, 'owner-a:brief:one', rotated),
    'private',
  );
  await assert.rejects(decryptText(encrypted, 'owner-b:brief:one', rotated), {
    code: 'CONTENT_UNAVAILABLE',
  });
  await assert.rejects(
    decryptText(
      encrypted.slice(0, -8) + 'AAAAAAAA',
      'owner-a:brief:one',
      rotated,
    ),
    { code: 'CONTENT_UNAVAILABLE' },
  );
  await assert.rejects(
    decryptText(encrypted, 'owner-a:brief:one', {
      active: 'next',
      keys: { next: rotated.keys.next },
    }),
    { code: 'CONTENT_UNAVAILABLE' },
  );
});

void test('durable jobs are claimed once; fencing blocks stale workers; paid jobs never retry blindly', async () => {
  const kind = `fixture-${randomUUID()}`;
  const id = await transaction(pool, (client) =>
    enqueue(client, {
      kind,
      reference: randomUUID(),
      payload: { fixture: true },
    }),
  );
  const claims = await Promise.all(
    Array.from({ length: 6 }, () => claimJob(pool, [kind])),
  );
  assert.equal(claims.filter(Boolean).length, 1);
  const job = claims.find(Boolean);
  assert.equal(job.id, id);
  await pool.query(
    "UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [id],
  );
  await assert.rejects(finishJob(pool, job), { code: 'JOB_LEASE_LOST' });
  await recoverExpiredJobs(pool);
  const resumed = await claimJob(pool, [kind]);
  assert.notEqual(resumed.lease_token, job.lease_token);
  await assert.rejects(failJob(pool, job, 'STALE', true), {
    code: 'JOB_LEASE_LOST',
  });
  await finishJob(pool, resumed);
  const paidId = await transaction(pool, (client) =>
    enqueue(client, {
      kind: 'inference',
      reference: randomUUID(),
      payload: {},
      maxAttempts: 5,
    }),
  );
  const paid = await claimJob(pool, ['inference']);
  assert.equal(paid.id, paidId);
  await failJob(pool, paid, 'UNKNOWN_OUTCOME', true);
  assert.equal(
    (await pool.query('SELECT state FROM jobs WHERE id=$1', [paidId])).rows[0]
      .state,
    'dead',
  );
});

void test('missing configuration returns honest capabilities without exposing credentials', async () => {
  const mode = process.env.CONCLAVE_MODE;
  process.env.CONCLAVE_MODE = 'preview';
  try {
    const capabilities = await dispatch(request('capabilities'));
    const text = await capabilities.text();
    assert.ok(!text.includes(connection));
    assert.equal(JSON.parse(text).walletSignIn.configured, false);
    assert.equal(JSON.parse(text).chat.configured, false);
    assert.equal((await dispatch(request('balance'))).status, 503);
  } finally {
    process.env.CONCLAVE_MODE = mode;
  }
});

async function quotedCall(options = {}) {
  process.env.GATEWAY_API_KEY = 'fixture-not-a-provider-key';
  process.env.CONCLAVE_INFERENCE_ENABLED = 'true';
  const user = await signIn();
  const projectId = randomUUID(),
    routeVersionId = randomUUID();
  await pool.query(
    'INSERT INTO projects(id,account_id,title) VALUES($1,$2,$3)',
    [projectId, user.account.accountId, 'Provider test'],
  );
  await creditVerifiedDeposit(pool, {
    accountId: user.account.accountId,
    reference: `test_${randomUUID()}`,
    amountUsd6: '1000000',
  });
  const card = {
    level: 'UNVERIFIED',
    reviewed: true,
    retentionDisclosure: 'Test fixture only.',
    evidenceUrl: 'https://example.test/terms',
    evidenceDate: '2026-10-09',
  };
  const pricing = {
    inputPerMillionUsd6: '1000000',
    outputPerMillionUsd6: '1000000',
    markupBps: 0,
    maxOutputTokens: 2048,
    maxInputBytes: 32768,
    // A non-reasoning fixture route: exact amounts below assume no reasoning reserve.
    maxReasoningTokens: 0,
  };
  await pool.query(
    `INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,card,pricing,expires_at)
    VALUES($1,$2,1,'gpt-6.1-sol','gpt','chat',true,$3,$4,now()+interval '1 hour')`,
    [routeVersionId, randomUUID(), card, pricing],
  );
  const body = {
    projectId,
    routeVersionId,
    messages: [{ role: 'user', content: 'Explain a binary search.' }],
    privacy: 'standard',
    maxOutputTokens: 1000,
  };
  const quoteResponse = await dispatch(
    request('quotes', { method: 'POST', cookie: user.cookie, body }),
  );
  if (options.quoteOnly)
    return { status: quoteResponse.status, body: await quoteResponse.json() };
  assert.equal(quoteResponse.status, 201, await quoteResponse.clone().text());
  const { quote } = await quoteResponse.json();
  const callBody = { ...body, quoteId: quote.id, idempotencyKey: randomUUID() };
  const response = await dispatch(
    request('calls', { method: 'POST', cookie: user.cookie, body: callBody }),
  );
  assert.equal(response.status, 202, await response.clone().text());
  const { call } = await response.json();
  return { ...user, call, callBody, quote, routeVersionId };
}

void test('media API preserves account isolation and rejects incomplete configuration or injected capability fields', async () => {
  const user = await signIn();
  const other = await signIn();
  const projectId = randomUUID(),
    mediaRouteId = randomUUID();
  await pool.query(
    'INSERT INTO projects(id,account_id,title) VALUES($1,$2,$3)',
    [projectId, user.account.accountId, 'Media isolation fixture'],
  );
  await pool.query(
    `INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,card,pricing,expires_at)
    VALUES($1,$2,1,'runway-gen4','runway','video',false,'{}','{}',now()+interval '1 hour')`,
    [mediaRouteId, randomUUID()],
  );
  const catalog = await dispatch(request('routes', { cookie: user.cookie }));
  assert.equal(catalog.status, 200);
  assert.ok(
    (await catalog.json()).routes.every(
      (route) => route.modality === 'chat' && route.versionId !== mediaRouteId,
    ),
  );
  const path = `media/jobs?projectId=${projectId}`;
  assert.equal((await dispatch(request(path))).status, 401);
  assert.equal(
    (await dispatch(request(path, { cookie: other.cookie }))).status,
    404,
  );
  const own = await dispatch(request(path, { cookie: user.cookie }));
  assert.equal(own.status, 200);
  assert.deepEqual((await own.json()).jobs, []);
  const changed = request(path, { cookie: user.cookie });
  changed.headers.set('x-conclave-account-id', other.account.accountId);
  assert.equal((await dispatch(changed)).status, 401);
  const body = {
    projectId,
    routeVersionId: mediaRouteId,
    input: {
      privacy: 'standard',
      prompt: 'A quiet sea at sunrise.',
      options: {
        kind: 'video',
        aspectRatio: '16:9',
        duration: 5,
        quality: '720p',
      },
    },
  };
  assert.equal(
    (
      await dispatch(
        request('media/quotes', {
          method: 'POST',
          cookie: user.cookie,
          origin: 'https://foreign.test',
          body,
        }),
      )
    ).status,
    403,
  );
  const before = process.env.CONCLAVE_MEDIA_ENABLED;
  try {
    process.env.CONCLAVE_MEDIA_ENABLED = 'true';
    const blocked = await dispatch(
      request('media/quotes', { method: 'POST', cookie: user.cookie, body }),
    );
    assert.equal(blocked.status, 503);
    assert.equal(
      (await blocked.json()).error.code,
      'MEDIA_CONFIGURATION_REQUIRED',
    );
    const injected = await dispatch(
      request('media/quotes', {
        method: 'POST',
        cookie: user.cookie,
        body: { ...body, storageReady: true },
      }),
    );
    assert.equal(injected.status, 400);
    const counts = await pool.query(
      'SELECT (SELECT count(*) FROM quotes WHERE account_id=$1)::int AS quotes,(SELECT count(*) FROM holds WHERE account_id=$1)::int AS holds',
      [user.account.accountId],
    );
    assert.deepEqual(counts.rows[0], { quotes: 0, holds: 0 });
  } finally {
    if (before === undefined) delete process.env.CONCLAVE_MEDIA_ENABLED;
    else process.env.CONCLAVE_MEDIA_ENABLED = before;
  }
});

void test('paid request is durably queued once and streams to an owned result with exact settlement', async () => {
  const f = await quotedCall();
  const before = await getBalance(pool, f.account.accountId);
  assert.equal(before.reservedUsd6, f.quote.maximumUsd6);
  const repeated = await dispatch(
    request('calls', { method: 'POST', cookie: f.cookie, body: f.callBody }),
  );
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).call.id, f.call.id);
  let dispatches = 0;
  const provider = {
    async *chat(input) {
      dispatches++;
      assert.equal(input.modelId, 'gpt-6.1-sol');
      assert.equal(input.messages[0].content, f.callBody.messages[0].content);
      yield {
        type: 'text',
        text: 'Binary search divides the search range in half.',
      };
      yield { type: 'done', finishReason: 'stop', usage: null, costUsd6: 250 };
    },
  };
  await runNextCall(pool, provider, configuredKeyring());
  assert.equal(dispatches, 1);
  const result = await dispatch(
    request(`calls/${f.call.id}`, { cookie: f.cookie }),
  );
  const { call } = await result.json();
  assert.equal(call.state, 'succeeded');
  assert.equal(call.output, 'Binary search divides the search range in half.');
  assert.equal(call.billing.actualUsd6, '250');
  assert.deepEqual(await getBalance(pool, f.account.accountId), {
    availableUsd6: '999750',
    reservedUsd6: '0',
    currency: 'USD6',
  });
  const other = await signIn();
  assert.equal(
    (await dispatch(request(`calls/${f.call.id}`, { cookie: other.cookie })))
      .status,
    404,
  );
  const stored = (
    await pool.query(
      'SELECT input_ciphertext,output_ciphertext FROM calls WHERE id=$1',
      [f.call.id],
    )
  ).rows[0];
  assert.ok(!stored.input_ciphertext.includes('binary search'));
  assert.ok(!stored.output_ciphertext.includes('Binary search'));
});

void test('interrupted or unpriced provider output retains funds and never dispatches twice', async () => {
  for (const failure of ['interrupt', 'missing-cost']) {
    const f = await quotedCall();
    let calls = 0;
    const provider = {
      async *chat() {
        calls++;
        yield { type: 'text', text: 'Partial answer.' };
        if (failure === 'interrupt')
          throw new GatewayError('stream_interrupted', true);
        yield {
          type: 'done',
          finishReason: 'stop',
          usage: null,
          costUsd6: failure === 'missing-cost' ? null : 2000000,
        };
      },
    };
    await runNextCall(pool, provider, configuredKeyring());
    const result = await dispatch(
      request(`calls/${f.call.id}`, { cookie: f.cookie }),
    );
    const { call } = await result.json();
    assert.equal(call.state, 'reconciliation_pending');
    assert.equal(call.billing.actualUsd6, null);
    assert.equal(
      (await getBalance(pool, f.account.accountId)).reservedUsd6,
      f.quote.maximumUsd6,
    );
    assert.equal(await runNextCall(pool, provider, configuredKeyring()), false);
    assert.equal(calls, 1);
  }
});

void test('an excess provider cost captures exactly the reservation and never more', async () => {
  const f = await quotedCall();
  let calls = 0;
  const provider = {
    async *chat() {
      calls++;
      yield { type: 'text', text: 'Partial answer.' };
      yield {
        type: 'done',
        finishReason: 'stop',
        usage: null,
        costUsd6: 2000000,
      };
    },
  };
  await runNextCall(pool, provider, configuredKeyring());
  const { call } = await (
    await dispatch(request(`calls/${f.call.id}`, { cookie: f.cookie }))
  ).json();
  assert.equal(call.state, 'succeeded');
  assert.equal(call.billing.state, 'captured');
  assert.equal(call.billing.actualUsd6, f.quote.maximumUsd6);
  assert.deepEqual(await getBalance(pool, f.account.accountId), {
    availableUsd6: (1000000n - BigInt(f.quote.maximumUsd6)).toString(),
    reservedUsd6: '0',
    currency: 'USD6',
  });
  const overage = (
    await pool.query(
      'SELECT reason_code,overage_usd6::text AS overage,resolution FROM hold_reconciliations h JOIN calls c ON c.hold_id=h.hold_id WHERE c.id=$1',
      [f.call.id],
    )
  ).rows[0];
  assert.deepEqual(overage, {
    reason_code: 'COST_EXCEEDS_RESERVATION',
    overage: (2000000n - BigInt(f.quote.maximumUsd6)).toString(),
    resolution: 'capped',
  });
  assert.equal(await runNextCall(pool, provider, configuredKeyring()), false);
  assert.equal(calls, 1);
});

void test('a configured hold buffer widens the reservation, absorbs a pricier upstream and releases the rest', async () => {
  process.env.CONCLAVE_HOLD_BUFFER_BPS = '1000';
  try {
    // 2304 at listed prices; a 10% buffer reserves 2304 + ceil(230.4) = 2535.
    const f = await quotedCall();
    assert.equal(f.quote.maximumUsd6, '2535');
    assert.deepEqual(f.quote.reservation, {
      bufferBps: 1000,
      baseMaximumUsd6: '2304',
      bufferedBaseMaximumUsd6: '2535',
    });
    assert.equal(f.quote.platformFee, undefined);
    assert.equal(
      (await getBalance(pool, f.account.accountId)).reservedUsd6,
      '2535',
    );
    // The gateway bills above the listed price but within the buffer: the
    // charge is exact, the remainder is released and nothing is reconciled.
    const provider = (costUsd6) => ({
      async *chat() {
        yield { type: 'text', text: 'Answer.' };
        yield { type: 'done', finishReason: 'stop', usage: null, costUsd6 };
      },
    });
    await runNextCall(pool, provider(2400), configuredKeyring());
    const { call } = await (
      await dispatch(request(`calls/${f.call.id}`, { cookie: f.cookie }))
    ).json();
    assert.equal(call.state, 'succeeded');
    assert.equal(call.billing.state, 'captured');
    assert.equal(call.billing.maximumUsd6, '2535');
    assert.equal(call.billing.actualUsd6, '2400');
    assert.deepEqual(await getBalance(pool, f.account.accountId), {
      availableUsd6: '997600',
      reservedUsd6: '0',
      currency: 'USD6',
    });
    assert.equal(
      (
        await pool.query(
          'SELECT 1 FROM hold_reconciliations h JOIN calls c ON c.hold_id=h.hold_id WHERE c.id=$1',
          [f.call.id],
        )
      ).rowCount,
      0,
    );
    // Beyond the buffer the capture still caps at the buffered reservation.
    const g = await quotedCall();
    await runNextCall(pool, provider(2000000), configuredKeyring());
    const excess = (
      await (
        await dispatch(request(`calls/${g.call.id}`, { cookie: g.cookie }))
      ).json()
    ).call;
    assert.equal(excess.billing.actualUsd6, '2535');
    assert.deepEqual(
      (
        await pool.query(
          'SELECT reason_code,overage_usd6::text AS overage,resolution FROM hold_reconciliations h JOIN calls c ON c.hold_id=h.hold_id WHERE c.id=$1',
          [g.call.id],
        )
      ).rows[0],
      {
        reason_code: 'COST_EXCEEDS_RESERVATION',
        overage: (2000000n - 2535n).toString(),
        resolution: 'capped',
      },
    );
  } finally {
    delete process.env.CONCLAVE_HOLD_BUFFER_BPS;
  }
  // An invalid buffer fails closed before a quote exists.
  process.env.CONCLAVE_HOLD_BUFFER_BPS = '10%';
  try {
    const refused = await quotedCall({ quoteOnly: true });
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error.code, 'CONFIGURATION_REQUIRED');
  } finally {
    delete process.env.CONCLAVE_HOLD_BUFFER_BPS;
  }
});

void test('cancelling a finished call reports that nothing was cancelled', async () => {
  const f = await quotedCall();
  await runNextCall(
    pool,
    {
      async *chat() {
        yield { type: 'text', text: 'Done.' };
        yield {
          type: 'done',
          finishReason: 'stop',
          usage: null,
          costUsd6: 250,
        };
      },
    },
    configuredKeyring(),
  );
  const response = await dispatch(
    request(`calls/${f.call.id}/cancel`, { method: 'POST', cookie: f.cookie }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    cancellationRequested: false,
    code: 'ALREADY_FINISHED',
    state: 'succeeded',
    message: 'This request has already finished; nothing was cancelled.',
  });
  const hold = (
    await pool.query(
      'SELECT h.state,h.captured_usd6::text AS captured,h.cancel_requested_at FROM holds h JOIN calls c ON c.hold_id=h.id WHERE c.id=$1',
      [f.call.id],
    )
  ).rows[0];
  assert.deepEqual(hold, {
    state: 'captured',
    captured: '250',
    cancel_requested_at: null,
  });
  const { call } = await (
    await dispatch(request(`calls/${f.call.id}`, { cookie: f.cookie }))
  ).json();
  assert.equal(call.state, 'succeeded');
  assert.equal(call.cancelRequested, false);
});

void test('cancel before dispatch and provider rejection safely release the full hold', async () => {
  const f = await quotedCall();
  const cancelled = await dispatch(
    request(`calls/${f.call.id}/cancel`, { method: 'POST', cookie: f.cookie }),
  );
  assert.equal(cancelled.status, 202);
  let dispatches = 0;
  const provider = {
    async *chat() {
      dispatches++;
      if (dispatches > 0) throw new GatewayError('authentication', false);
      yield { type: 'text', text: '' };
    },
  };
  await runNextCall(pool, provider, configuredKeyring());
  assert.equal(dispatches, 0);
  assert.equal(
    (await getBalance(pool, f.account.accountId)).availableUsd6,
    '1000000',
  );
  const second = await quotedCall();
  await runNextCall(pool, provider, configuredKeyring());
  assert.equal(dispatches, 1);
  assert.equal(
    (await getBalance(pool, second.account.accountId)).availableUsd6,
    '1000000',
  );
});

void test('strict policy and detected secrets fail before reservation; route terms cannot be rewritten', async () => {
  const f = await quotedCall();
  for (const change of [
    { privacy: 'strict' },
    {
      messages: [
        { role: 'user', content: `api_key=${'sk_live_' + 'x'.repeat(40)}` },
      ],
    },
  ]) {
    const result = await dispatch(
      request('quotes', {
        method: 'POST',
        cookie: f.cookie,
        body: { ...f.callBody, ...change },
      }),
    );
    assert.ok([409, 422].includes(result.status), await result.text());
  }
  await assert.rejects(
    pool.query("UPDATE route_versions SET pricing='{}' WHERE id=$1", [
      f.routeVersionId,
    ]),
    { code: '23514' },
  );
  await pool.query('UPDATE route_versions SET enabled=false WHERE id=$1', [
    f.routeVersionId,
  ]);
  let dispatches = 0;
  await runNextCall(
    pool,
    {
      async *chat() {
        dispatches++;
        yield undefined;
      },
    },
    configuredKeyring(),
  );
  assert.equal(dispatches, 0);
  assert.equal(
    (await getBalance(pool, f.account.accountId)).availableUsd6,
    '1000000',
  );
});

void test('accepted idempotent retries survive route shutdown and expired quotes', async () => {
  const f = await quotedCall();
  await pool.query('UPDATE route_versions SET enabled=false WHERE id=$1', [
    f.routeVersionId,
  ]);
  await pool.query(
    "UPDATE quotes SET expires_at=now()-interval '1 minute' WHERE id=$1",
    [f.quote.id],
  );
  process.env.CONCLAVE_INFERENCE_ENABLED = 'false';
  const response = await dispatch(
    request('calls', { method: 'POST', cookie: f.cookie, body: f.callBody }),
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).call.id, f.call.id);
  await runNextCall(
    pool,
    {
      async *chat() {
        yield { type: 'text', text: 'must not dispatch' };
      },
    },
    configuredKeyring(),
  );
  assert.equal((await getBalance(pool, f.account.accountId)).reservedUsd6, '0');
});

void test('disabled owners cannot dispatch queued work, but in-flight settled charges remain accountable', async () => {
  const before = await quotedCall();
  await pool.query('UPDATE accounts SET disabled_at=now() WHERE id=$1', [
    before.account.accountId,
  ]);
  let dispatched = 0;
  await runNextCall(
    pool,
    {
      async *chat() {
        dispatched++;
        yield { type: 'text', text: 'must not dispatch' };
      },
    },
    configuredKeyring(),
  );
  assert.equal(dispatched, 0);
  assert.equal(
    (await getBalance(pool, before.account.accountId)).availableUsd6,
    '1000000',
  );
  const during = await quotedCall();
  await runNextCall(
    pool,
    {
      async *chat() {
        await pool.query('UPDATE accounts SET disabled_at=now() WHERE id=$1', [
          during.account.accountId,
        ]);
        yield { type: 'text', text: 'An answer already in progress.' };
        yield {
          type: 'done',
          finishReason: 'stop',
          usage: null,
          costUsd6: 250,
        };
      },
    },
    configuredKeyring(),
  );
  assert.deepEqual(await getBalance(pool, during.account.accountId), {
    availableUsd6: '999750',
    reservedUsd6: '0',
    currency: 'USD6',
  });
});

void test('recovery releases provably undispatched holds; stale workers cannot overwrite recovery', async () => {
  const before = await quotedCall();
  const job = await claimJob(pool, ['inference']);
  await pool.query(
    "UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [job.id],
  );
  await recoverExpiredJobs(pool);
  assert.equal(
    (await getBalance(pool, before.account.accountId)).reservedUsd6,
    '0',
  );
  assert.equal(
    (
      await pool.query('SELECT error_code FROM calls WHERE id=$1', [
        before.call.id,
      ])
    ).rows[0].error_code,
    'WORKER_INTERRUPTED_BEFORE_DISPATCH',
  );
  const during = await quotedCall();
  await runNextCall(
    pool,
    {
      async *chat() {
        yield { type: 'text', text: 'Partial output' };
        await pool.query(
          "UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE reference=$1",
          [`inference:${during.call.id}`],
        );
        await recoverExpiredJobs(pool);
        throw new GatewayError('cancelled', true);
      },
    },
    configuredKeyring(),
  );
  assert.equal(
    (await getBalance(pool, during.account.accountId)).reservedUsd6,
    during.quote.maximumUsd6,
  );
  assert.equal(
    (
      await pool.query('SELECT error_code FROM calls WHERE id=$1', [
        during.call.id,
      ])
    ).rows[0].error_code,
    'WORKER_INTERRUPTED',
  );
});

void test('project pagination reaches all saved projects with equal timestamps and rejects cross-account cursors', async () => {
  const owner = await signIn(),
    other = await signIn();
  const ids = Array.from({ length: 103 }, () => randomUUID());
  await pool.query(
    `INSERT INTO projects(id,account_id,title,updated_at)
    SELECT value,$2,'Paged project','2026-10-09T00:00:00.123456Z' FROM unnest($1::uuid[]) value`,
    [ids, owner.account.accountId],
  );
  let cursor = null;
  const seen = new Set();
  do {
    const response = await dispatch(
      request(`projects${cursor ? `?cursor=${cursor}` : ''}`, {
        cookie: owner.cookie,
      }),
    );
    assert.equal(response.status, 200);
    const page = await response.json();
    for (const project of page.projects) {
      assert.ok(!seen.has(project.id));
      seen.add(project.id);
    }
    cursor = page.nextCursor;
    if (cursor)
      assert.equal(
        (
          await dispatch(
            request(`projects?cursor=${cursor}`, { cookie: other.cookie }),
          )
        ).status,
        400,
      );
  } while (cursor);
  assert.equal(seen.size, ids.length);
});

void test('terminal events stream is owned, resumable, bounded and contains only decrypted owner output', async () => {
  const f = await quotedCall();
  await runNextCall(
    pool,
    {
      async *chat() {
        yield { type: 'text', text: 'A finished answer.' };
        yield {
          type: 'done',
          finishReason: 'stop',
          usage: null,
          costUsd6: 100,
        };
      },
    },
    configuredKeyring(),
  );
  const stream = await dispatch(
    request(`calls/${f.call.id}/events`, { cookie: f.cookie }),
  );
  assert.equal(
    stream.headers.get('content-type'),
    'text/event-stream; charset=utf-8',
  );
  const text = await stream.text();
  assert.ok(text.includes('event: snapshot'));
  assert.ok(text.includes('A finished answer.'));
  assert.ok(text.includes('event: complete'));
  assert.ok(!text.includes(process.env.CONCLAVE_DATA_KEYS));
  const other = await signIn();
  assert.equal(
    (
      await dispatch(
        request(`calls/${f.call.id}/events`, { cookie: other.cookie }),
      )
    ).status,
    404,
  );
});

void test('account-bound requests reject a cookie from another account before returning private records', async () => {
  const first = await signIn(),
    other = await signIn();
  const incoming = request('balance', { cookie: other.cookie });
  incoming.headers.set('X-Conclave-Account-Id', first.account.accountId);
  const response = await dispatch(incoming);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'ACCOUNT_CHANGED');
  const correct = request('balance', { cookie: first.cookie });
  correct.headers.set('X-Conclave-Account-Id', first.account.accountId);
  assert.equal((await dispatch(correct)).status, 200);
});

void test('ledger activity is scoped and project/Brief writes reject detected secrets before persistence', async () => {
  const user = await signIn(),
    other = await signIn();
  await creditVerifiedDeposit(pool, {
    accountId: user.account.accountId,
    reference: `fixture_${randomUUID()}`,
    amountUsd6: '1234567',
  });
  const entries = await (
    await dispatch(request('ledger', { cookie: user.cookie }))
  ).json();
  assert.equal(entries.entries.length, 1);
  assert.equal(entries.entries[0].kind, 'deposit');
  assert.equal(entries.entries[0].availableDeltaUsd6, '1234567');
  assert.equal(
    (await (await dispatch(request('ledger', { cookie: other.cookie }))).json())
      .entries.length,
    0,
  );
  const secret = 'sk-' + 'x'.repeat(40);
  assert.equal(
    (
      await dispatch(
        request('projects', {
          method: 'POST',
          cookie: user.cookie,
          body: { title: secret },
        }),
      )
    ).status,
    422,
  );
  const created = await (
    await dispatch(
      request('projects', {
        method: 'POST',
        cookie: user.cookie,
        body: { title: 'Owned records' },
      }),
    )
  ).json();
  assert.equal(
    (
      await dispatch(
        request('briefs', {
          method: 'POST',
          cookie: user.cookie,
          body: {
            projectId: created.project.id,
            title: 'Secret guard',
            body: secret,
          },
        }),
      )
    ).status,
    422,
  );
  assert.equal(
    (
      await pool.query('SELECT id FROM briefs WHERE account_id=$1', [
        user.account.accountId,
      ])
    ).rowCount,
    0,
  );
});

void test('one browser cannot exhaust sign-in challenges for everyone: the per-client bucket trips first and another browser still succeeds', async () => {
  const address = () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    return bs58.encode(
      Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url'),
    );
  };
  const first = await dispatch(
    request('auth/challenge', { method: 'POST', body: { address: address() } }),
  );
  assert.equal(first.status, 201, await first.clone().text());
  const browserCookie = first.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  let limited = null;
  for (let attempt = 2; attempt <= 61 && !limited; attempt += 1) {
    const response = await dispatch(
      request('auth/challenge', {
        method: 'POST',
        body: { address: address() },
        cookie: browserCookie,
      }),
    );
    if (response.status === 429) limited = await response.json();
    else assert.equal(response.status, 201, await response.clone().text());
  }
  assert.equal(limited?.error?.code, 'RATE_LIMITED');
  const other = await dispatch(
    request('auth/challenge', { method: 'POST', body: { address: address() } }),
  );
  assert.equal(other.status, 201, await other.clone().text());
});

void test('RPC-spending routes stop at the shared RPC ceiling before any network call is made', async () => {
  const { cookie } = await signIn();
  await pool.query(
    `INSERT INTO rate_limits(bucket,window_start,hits)
     VALUES('solana-rpc:global',to_timestamp(floor(extract(epoch FROM now())/60)*60),600)
     ON CONFLICT(bucket,window_start) DO UPDATE SET hits=600`,
  );
  const originalFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => {
    fetched += 1;
    throw new Error('no network call expected');
  };
  try {
    const response = await dispatch(
      request('explanations', {
        method: 'POST',
        cookie,
        body: { signature: '5'.repeat(87) },
      }),
    );
    assert.equal(response.status, 429, await response.clone().text());
    assert.equal((await response.json()).error.code, 'RATE_LIMITED');
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await pool.query("DELETE FROM rate_limits WHERE bucket='solana-rpc:global'");
  }
});
