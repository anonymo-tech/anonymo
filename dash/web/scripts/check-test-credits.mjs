import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import test, { after, before } from 'node:test';
import bs58 from 'bs58';
import { createDatabase, transaction } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import { testEndpoint } from './check-database.mjs';
import { dispatch } from '../server/routes/dispatch.ts';
import { passkeyRoutes } from '../server/routes/passkeys.ts';
import { handleApi } from '../server/core/http.ts';
import { getBalance, reserveQuote, settleHold, creditVerifiedDeposit } from '../server/ledger/ledger.ts';
import {
  INTERNAL_TEST_CREDIT_LABEL,
  SIGN_IN_TEST_CREDIT_REFERENCE,
  grantInternalTestCredit,
  internalTestingAllowed,
  productionEnvironment,
  signInTestCreditUsd6,
} from '../server/ledger/test-credits.ts';
import { createAccountRecordsClient } from '../lib/client/account-records.ts';
import { syntheticPasskey } from './fixtures/passkeys.mjs';
import { grantFromCli } from './grant-test-credits.mjs';

const connection = testEndpoint(process.env.CONCLAVE_TEST_DATABASE_URL).href;
const pool = createDatabase(connection, 12);
const local = 'http://localhost';
const remote = 'postgresql://conclave_api.ref:secret@db.example:5432/postgres';
const baseEnv = {
  CONCLAVE_MODE: 'service',
  CONCLAVE_APP_ORIGIN: local,
  CONCLAVE_DATABASE_URL: connection,
  CONCLAVE_INTERNAL_TESTING: 'true',
  CONCLAVE_INTERNAL_TEST_CREDIT_USD: '5',
};
const managed = [
  'CONCLAVE_MODE',
  'CONCLAVE_APP_ORIGIN',
  'CONCLAVE_DATABASE_URL',
  'CONCLAVE_INTERNAL_TESTING',
  'CONCLAVE_INTERNAL_TEST_CREDIT_USD',
  'CONCLAVE_PASSKEYS_ENABLED',
  'CONCLAVE_ENVIRONMENT',
  'NODE_ENV',
];
function useEnv(values) {
  for (const key of managed) delete process.env[key];
  Object.assign(process.env, values);
}
before(async () => {
  await migrate(pool);
  await migrate(pool);
});
after(async () => {
  await pool.end();
});

async function account() {
  const id = randomUUID();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [id]);
  return id;
}
async function invariants() {
  const row = (
    await pool.query(`SELECT
      (SELECT count(*) FROM (SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(amount_usd6)<>0 OR count(*)<2) t)::int AS imbalanced,
      (SELECT count(*) FROM ledger_accounts a WHERE a.balance_usd6<>COALESCE((SELECT sum(e.amount_usd6) FROM ledger_entries e WHERE e.ledger_account_id=a.id),0))::int AS drift,
      (SELECT COALESCE(sum(balance_usd6),0) FROM ledger_accounts WHERE kind='internal_test_funding')::text AS funding,
      (SELECT COALESCE(sum(amount_usd6),0) FROM internal_test_credit_grants)::text AS granted,
      (SELECT count(*) FROM ledger_transactions t WHERE t.kind='internal_test_credit' AND NOT EXISTS (SELECT 1 FROM internal_test_credit_grants g WHERE g.ledger_transaction_id=t.id))::int AS ungranted,
      (SELECT count(*) FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.ledger_account_id JOIN ledger_transactions t ON t.id=e.transaction_id
        WHERE a.kind='internal_test_funding' AND t.kind<>'internal_test_credit')::int AS foreign_funding`)
  ).rows[0];
  assert.equal(row.imbalanced, 0);
  assert.equal(row.drift, 0);
  assert.equal(row.funding, row.granted === '0' ? '0' : `-${row.granted}`);
  assert.equal(row.ungranted, 0);
  assert.equal(row.foreign_funding, 0);
}

function request(origin, path, { method = 'GET', body, cookie } = {}) {
  return new Request(`${origin}/api/${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      origin,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
function walletKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const address = bs58.encode(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url'));
  return { address, privateKey };
}
async function walletSignIn(key, origin = local) {
  const challengeResponse = await dispatch(
    request(origin, 'auth/challenge', { method: 'POST', body: { address: key.address } }),
  );
  assert.equal(challengeResponse.status, 201, await challengeResponse.clone().text());
  const { challenge } = await challengeResponse.json();
  const browserCookie = challengeResponse.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const verify = await dispatch(
    request(origin, 'auth/verify', {
      method: 'POST',
      cookie: browserCookie,
      body: {
        challengeId: challenge.id,
        address: key.address,
        signatureType: 'ed25519',
        signedMessageBase64: Buffer.from(challenge.message).toString('base64'),
        signatureBase64: sign(null, Buffer.from(challenge.message), key.privateKey).toString('base64'),
        method: 'signIn',
        signInSupported: true,
      },
    }),
  );
  assert.equal(verify.status, 200, await verify.clone().text());
  const session = verify.headers.getSetCookie().find((value) => value.includes('conclave_session='));
  return { accountId: (await verify.json()).accountId, cookie: session.split(';')[0] };
}

void test('gating is inert by default and outside loopback internal testing', () => {
  assert.equal(signInTestCreditUsd6(local, {}), null);
  assert.equal(internalTestingAllowed({}), false);
  assert.equal(signInTestCreditUsd6(local, baseEnv), 5_000_000n);
  for (const host of ['localhost', '127.0.0.1', '[::1]'])
    assert.equal(
      signInTestCreditUsd6(`http://${host}:3000`, { ...baseEnv, CONCLAVE_APP_ORIGIN: `http://${host}:3000` }),
      5_000_000n,
    );
  const inert = [
    { ...baseEnv, CONCLAVE_INTERNAL_TESTING: undefined },
    { ...baseEnv, CONCLAVE_INTERNAL_TESTING: 'TRUE' },
    { ...baseEnv, CONCLAVE_INTERNAL_TESTING: '1' },
    { ...baseEnv, CONCLAVE_MODE: 'preview' },
    { ...baseEnv, CONCLAVE_APP_ORIGIN: 'https://conclave.example' },
    { ...baseEnv, CONCLAVE_APP_ORIGIN: 'http://localhost.example.com' },
    { ...baseEnv, CONCLAVE_DATABASE_URL: 'postgresql://user@db.example/conclave' },
    { ...baseEnv, CONCLAVE_DATABASE_URL: `${remote}?sslmode=require` },
    { ...baseEnv, CONCLAVE_DATABASE_URL: `${remote}?sslmode=verify-full&application_name=x` },
    { ...baseEnv, CONCLAVE_DATABASE_URL: `https://db.example/conclave?sslmode=verify-full` },
    { ...baseEnv, CONCLAVE_DATABASE_URL: undefined },
    { ...baseEnv, NODE_ENV: 'production' },
    { ...baseEnv, CONCLAVE_ENVIRONMENT: 'production' },
    { ...baseEnv, CONCLAVE_SOLANA_CLUSTER: 'mainnet-beta', CONCLAVE_DEPOSITS_ENABLED: 'true' },
    { ...baseEnv, CONCLAVE_INTERNAL_TEST_CREDIT_USD: undefined },
    { ...baseEnv, CONCLAVE_INTERNAL_TEST_CREDIT_USD: '0' },
    { ...baseEnv, CONCLAVE_INTERNAL_TEST_CREDIT_USD: '-5' },
    { ...baseEnv, CONCLAVE_INTERNAL_TEST_CREDIT_USD: '100.000001' },
    { ...baseEnv, CONCLAVE_INTERNAL_TEST_CREDIT_USD: '5e2' },
  ];
  for (const env of inert) assert.equal(signInTestCreditUsd6(local, env), null);
  // A hosted database qualifies only with verified TLS, and only while the app
  // origin stays loopback and no production marker is set.
  const hosted = { ...baseEnv, CONCLAVE_DATABASE_URL: `${remote}?sslmode=verify-full` };
  assert.equal(internalTestingAllowed(hosted), true);
  assert.equal(signInTestCreditUsd6(local, hosted), 5_000_000n);
  assert.equal(internalTestingAllowed({ ...hosted, CONCLAVE_INTERNAL_TESTING: undefined }), false);
  assert.equal(internalTestingAllowed({ ...hosted, CONCLAVE_APP_ORIGIN: 'https://conclave.example' }), false);
  assert.equal(internalTestingAllowed({ ...hosted, NODE_ENV: 'production' }), false);
  assert.equal(internalTestingAllowed({ ...hosted, CONCLAVE_ENVIRONMENT: 'production' }), false);
  assert.equal(
    internalTestingAllowed({ ...hosted, CONCLAVE_SOLANA_CLUSTER: 'mainnet-beta', CONCLAVE_DEPOSITS_ENABLED: 'true' }),
    false,
  );
  // The request origin itself must also be loopback.
  assert.equal(signInTestCreditUsd6('https://conclave.example', baseEnv), null);
  assert.equal(productionEnvironment({ CONCLAVE_SOLANA_CLUSTER: 'devnet', CONCLAVE_DEPOSITS_ENABLED: 'true' }), false);
});

void test('grants are idempotent per account reference and reject conflicts', async () => {
  const owner = await account();
  const first = await grantInternalTestCredit(pool, owner, '2500000', 'fixture-grant');
  const again = await grantInternalTestCredit(pool, owner, '2500000', 'fixture-grant');
  assert.equal(first.replayed, false);
  assert.equal(again.replayed, true);
  assert.equal(again.transactionId, first.transactionId);
  await assert.rejects(grantInternalTestCredit(pool, owner, '2500001', 'fixture-grant'), { code: 'REFERENCE_CONFLICT' });
  assert.equal((await getBalance(pool, owner)).availableUsd6, '2500000');
  // The same reference is independent for another account; a new reference adds.
  const other = await account();
  assert.equal((await grantInternalTestCredit(pool, other, '1000000', 'fixture-grant')).replayed, false);
  await grantInternalTestCredit(pool, owner, '500000', 'fixture-second');
  assert.equal((await getBalance(pool, owner)).availableUsd6, '3000000');
  assert.equal((await getBalance(pool, other)).availableUsd6, '1000000');
  for (const [amount, reference, code] of [
    ['0', 'fixture-zero', 'INVALID_AMOUNT'],
    ['100000001', 'fixture-cap', 'INVALID_AMOUNT'],
    ['1.5', 'fixture-decimal', 'INVALID_AMOUNT'],
    ['1000000', 'x', 'INVALID_REFERENCE'],
    ['1000000', 'bad reference', 'INVALID_REFERENCE'],
  ])
    await assert.rejects(grantInternalTestCredit(pool, owner, amount, reference), { code });
  await assert.rejects(grantInternalTestCredit(pool, 'not-a-uuid', '1', 'fixture-grant'), { code: 'INVALID_ACCOUNT' });
  await assert.rejects(grantInternalTestCredit(pool, randomUUID(), '1', 'fixture-grant'), { code: 'ACCOUNT_UNAVAILABLE' });
  const disabled = await account();
  await pool.query('UPDATE accounts SET disabled_at=now() WHERE id=$1', [disabled]);
  await assert.rejects(grantInternalTestCredit(pool, disabled, '1', 'fixture-grant'), { code: 'ACCOUNT_UNAVAILABLE' });
  await invariants();
});

void test('concurrent duplicate grants credit exactly once', async () => {
  const owner = await account();
  const results = await Promise.all(
    Array.from({ length: 10 }, () => grantInternalTestCredit(pool, owner, '5000000', SIGN_IN_TEST_CREDIT_REFERENCE)),
  );
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  assert.equal(new Set(results.map((result) => result.transactionId)).size, 1);
  assert.equal((await getBalance(pool, owner)).availableUsd6, '5000000');
  // Different accounts granting concurrently share the funding account safely.
  const owners = await Promise.all(Array.from({ length: 6 }, account));
  await Promise.all(owners.map((id) => grantInternalTestCredit(pool, id, '1000000', 'fixture-parallel')));
  for (const id of owners) assert.equal((await getBalance(pool, id)).availableUsd6, '1000000');
  await invariants();
});

void test('database rejects test credit outside its dedicated grant shape', async () => {
  const owner = await account();
  const grant = await grantInternalTestCredit(pool, owner, '1000000', 'fixture-shape');
  const funding = (await pool.query("SELECT id FROM ledger_accounts WHERE kind='internal_test_funding'")).rows[0].id;
  const available = (await pool.query("SELECT id FROM ledger_accounts WHERE owner_id=$1 AND kind='available'", [owner])).rows[0].id;
  await pool.query("INSERT INTO ledger_accounts(id,owner_id,kind) VALUES($1,$2,'reserved') ON CONFLICT DO NOTHING", [randomUUID(), owner]);
  const reserved = (await pool.query("SELECT id FROM ledger_accounts WHERE owner_id=$1 AND kind='reserved'", [owner])).rows[0].id;
  const attempt = (kind, debit, credit, withGrant, amount = 1000) =>
    transaction(pool, async (client) => {
      const id = randomUUID(), reference = `fixture-${randomUUID()}`;
      await client.query('INSERT INTO ledger_transactions(id,reference,kind) VALUES($1,$2,$3)', [
        id,
        kind === 'internal_test_credit' ? `internal-test-credit:${owner}:${reference}` : `invalid:${id}`,
        kind,
      ]);
      await client.query('INSERT INTO ledger_entries(transaction_id,ledger_account_id,amount_usd6) VALUES($1,$2,$3)', [id, debit, -amount]);
      await client.query('INSERT INTO ledger_entries(transaction_id,ledger_account_id,amount_usd6) VALUES($1,$2,$3)', [id, credit, amount]);
      if (withGrant)
        await client.query('INSERT INTO internal_test_credit_grants(account_id,reference,amount_usd6,ledger_transaction_id) VALUES($1,$2,$3,$4)', [
          owner,
          reference,
          withGrant === 'mismatch' ? amount + 1 : amount,
          id,
        ]);
    });
  // The funding account cannot back a deposit, and a test credit cannot lack a grant.
  await assert.rejects(attempt('deposit', funding, available, false), { code: '23514' });
  await assert.rejects(attempt('internal_test_credit', funding, available, false), { code: '23514' });
  await assert.rejects(attempt('internal_test_credit', funding, available, 'mismatch'), { code: '23514' });
  // Test credit cannot land in reserved funds or be returned to the funding account.
  await assert.rejects(attempt('internal_test_credit', funding, reserved, true), { code: '23514' });
  await assert.rejects(attempt('internal_test_credit', available, funding, true), { code: '23514' });
  // The fully matching shape is accepted, proving the rejections above are specific.
  await attempt('internal_test_credit', funding, available, true);
  // Grant records and their ledger rows are immutable.
  await assert.rejects(pool.query('UPDATE internal_test_credit_grants SET amount_usd6=2 WHERE ledger_transaction_id=$1', [grant.transactionId]), { code: '23514' });
  await assert.rejects(pool.query('DELETE FROM internal_test_credit_grants WHERE ledger_transaction_id=$1', [grant.transactionId]), { code: '23514' });
  await assert.rejects(pool.query('DELETE FROM ledger_transactions WHERE id=$1', [grant.transactionId]), { code: '23514' });
  await assert.rejects(pool.query("UPDATE ledger_accounts SET balance_usd6=1 WHERE kind='internal_test_funding'"), { code: '23514' });
  // A deposit is still recorded as a deposit, separately from test credit.
  await creditVerifiedDeposit(pool, { accountId: owner, reference: `fixture_${randomUUID()}`, amountUsd6: '7' });
  await invariants();
});

void test('test credit funds an ordinary reservation and settlement', async () => {
  const owner = await account(), project = randomUUID(), route = randomUUID(), quote = randomUUID();
  await grantInternalTestCredit(pool, owner, '1000000', 'fixture-spend');
  await pool.query('INSERT INTO projects(id,account_id,title) VALUES($1,$2,$3)', [project, owner, 'Credit test']);
  await pool.query(`INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,card,pricing,expires_at)
    VALUES($1,$2,1,'fixture','fixture','chat',true,'{}','{}',now()+interval '1 hour')`, [route, `fixture-${route}`]);
  await pool.query(`INSERT INTO quotes(id,account_id,project_id,route_version_id,request_hash,max_usd6,max_output_tokens,expires_at)
    VALUES($1,$2,$3,$4,'hash',600000,1000,now()+interval '5 minutes')`, [quote, owner, project, route]);
  const { hold } = await reserveQuote(pool, { accountId: owner, quoteId: quote, idempotencyKey: randomUUID(), requestHash: 'hash' });
  await settleHold(pool, { accountId: owner, holdId: hold.id, actualUsd6: '250000', providerReference: null });
  assert.deepEqual(await getBalance(pool, owner), { availableUsd6: '750000', reservedUsd6: '0', currency: 'USD6' });
  await invariants();
});

void test('wallet sign-in grants once on loopback and history labels the credit', async () => {
  useEnv(baseEnv);
  const key = walletKey();
  const first = await walletSignIn(key);
  const second = await walletSignIn(key);
  const concurrent = await Promise.all([walletSignIn(key), walletSignIn(key), walletSignIn(key)]);
  for (const result of [second, ...concurrent]) assert.equal(result.accountId, first.accountId);
  assert.equal((await getBalance(pool, first.accountId)).availableUsd6, '5000000');
  const grants = await pool.query('SELECT reference,amount_usd6::text AS amount FROM internal_test_credit_grants WHERE account_id=$1', [first.accountId]);
  assert.deepEqual(grants.rows, [{ reference: SIGN_IN_TEST_CREDIT_REFERENCE, amount: '5000000' }]);
  // A changed configured amount never grants a second sign-in credit.
  useEnv({ ...baseEnv, CONCLAVE_INTERNAL_TEST_CREDIT_USD: '9' });
  await walletSignIn(key);
  assert.equal((await getBalance(pool, first.accountId)).availableUsd6, '5000000');
  const balance = await (await dispatch(request(local, 'balance', { cookie: first.cookie }))).json();
  assert.deepEqual(balance, {
    availableUsd6: '5000000',
    reservedUsd6: '0',
    currency: 'USD6',
    internalTestCredit: { grantedUsd6: '5000000', label: INTERNAL_TEST_CREDIT_LABEL },
  });
  const history = await (await dispatch(request(local, 'ledger', { cookie: first.cookie }))).json();
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].kind, 'internal_test_credit');
  assert.notEqual(history.entries[0].kind, 'deposit');
  assert.equal(history.entries[0].availableDeltaUsd6, '5000000');
  assert.ok(!JSON.stringify(history).includes('USDC') && !JSON.stringify(history).includes('deposit'));
  // The client records parser accepts and preserves the distinct kind.
  const parsed = await createAccountRecordsClient(first.accountId, new AbortController().signal, async () =>
    new Response(JSON.stringify(history), { headers: { 'content-type': 'application/json' } }),
  ).ledger();
  assert.equal(parsed.entries[0].kind, 'internal_test_credit');
  await invariants();
});

void test('wallet sign-in stays inert when disabled, non-loopback or production', async () => {
  for (const env of [
    { ...baseEnv, CONCLAVE_INTERNAL_TESTING: undefined },
    { ...baseEnv, NODE_ENV: 'production' },
    { ...baseEnv, CONCLAVE_ENVIRONMENT: 'production' },
  ]) {
    useEnv(env);
    const result = await walletSignIn(walletKey());
    assert.equal((await getBalance(pool, result.accountId)).availableUsd6, '0');
    const balance = await (await dispatch(request(local, 'balance', { cookie: result.cookie }))).json();
    assert.deepEqual(balance, { availableUsd6: '0', reservedUsd6: '0', currency: 'USD6' });
  }
  useEnv({ ...baseEnv, CONCLAVE_APP_ORIGIN: 'https://conclave.test' });
  const remote = await walletSignIn(walletKey(), 'https://conclave.test');
  assert.equal((await getBalance(pool, remote.accountId)).availableUsd6, '0');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM internal_test_credit_grants WHERE account_id=$1', [remote.accountId])).rows[0].n, 0);
});

void test('passkey signup grants once on loopback; login does not grant again', async () => {
  useEnv({ ...baseEnv, CONCLAVE_PASSKEYS_ENABLED: 'true' });
  const jar = {};
  const post = async (path, body) => {
    const response = await handleApi(async () =>
      (await passkeyRoutes(pool, new Request(`${local}/api/${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: local,
          cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
        },
        body: JSON.stringify(body),
      }), path, local)) ?? new Response(null, { status: 404 }),
    );
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';'), index = pair.indexOf('=');
      jar[pair.slice(0, index)] = pair.slice(index + 1);
    }
    return { status: response.status, body: await response.json() };
  };
  const device = syntheticPasskey(), clientData = { clientData: { origin: local } };
  const signup = await post('auth/passkeys/signup/options', {});
  assert.equal(signup.status, 201, JSON.stringify(signup.body));
  const created = await post('auth/passkeys/signup/verify', {
    challengeId: signup.body.challengeId,
    credential: device.registration(signup.body.options, clientData),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const accountId = created.body.accountId;
  assert.equal((await getBalance(pool, accountId)).availableUsd6, '5000000');
  // A fresh browser: the signup browser still holds an active session.
  for (const key of Object.keys(jar)) delete jar[key];
  const login = await post('auth/passkeys/login/options', {});
  assert.equal(login.status, 201, JSON.stringify(login.body));
  const signedIn = await post('auth/passkeys/login/verify', {
    challengeId: login.body.challengeId,
    credential: device.authentication(login.body.options, clientData),
  });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  assert.equal(signedIn.body.accountId, accountId);
  assert.equal((await getBalance(pool, accountId)).availableUsd6, '5000000');
  await invariants();
});

void test('operator grant tool refuses unsafe environments and grants by account or wallet', async () => {
  const env = { CONCLAVE_INTERNAL_TESTING: 'true', CONCLAVE_DATABASE_URL: connection };
  const owner = await account();
  for (const unsafe of [
    {},
    { ...env, CONCLAVE_INTERNAL_TESTING: 'false' },
    { ...env, CONCLAVE_DATABASE_URL: 'postgresql://user@db.example/conclave' },
    { ...env, CONCLAVE_DATABASE_URL: `${remote}?sslmode=require` },
    { ...env, CONCLAVE_DATABASE_URL: `${remote}?sslmode=verify-full`, NODE_ENV: 'production' },
    { ...env, CONCLAVE_DATABASE_URL: `${remote}?sslmode=verify-full`, CONCLAVE_ENVIRONMENT: 'production' },
    { ...env, CONCLAVE_DATABASE_URL: `${remote}?sslmode=verify-full`, CONCLAVE_APP_ORIGIN: 'https://conclave.example' },
    { ...env, CONCLAVE_APP_ORIGIN: 'https://conclave.example' },
    { ...env, NODE_ENV: 'production' },
  ])
    await assert.rejects(grantFromCli(['--account', owner, '--usd', '1'], unsafe), /Refused/);
  // A verify-full remote passes the gate; the tool then tries to connect rather than refusing.
  await assert.rejects(
    grantFromCli(['--account', owner, '--usd', '1'], { ...env, CONCLAVE_DATABASE_URL: `${remote}?sslmode=verify-full` }),
    (error) => !/Refused/.test(error.message),
  );
  await assert.rejects(grantFromCli(['--account', owner], env), /Usage/);
  await assert.rejects(grantFromCli(['--account', owner, '--usd', '101'], env), /at most 100/);
  await assert.rejects(grantFromCli(['--account', owner, '--usd=-1'], env), /positive/);
  await assert.rejects(grantFromCli(['--account', 'nobody', '--usd', '1'], env), /UUID or a Solana/);
  await assert.rejects(grantFromCli(['--account', randomUUID(), '--usd', '1'], env), /No account/);
  const byId = await grantFromCli(['--account', owner, '--usd', '2.5', '--reference', 'operator-fixture'], env);
  assert.equal(byId.amountUsd6, '2500000');
  assert.equal(byId.replayed, false);
  assert.equal(byId.label, INTERNAL_TEST_CREDIT_LABEL);
  const replay = await grantFromCli(['--account', owner, '--usd', '2.5', '--reference', 'operator-fixture'], env);
  assert.equal(replay.replayed, true);
  assert.equal(replay.availableUsd6, '2500000');
  useEnv(baseEnv);
  const key = walletKey(), wallet = await walletSignIn(key);
  const byWallet = await grantFromCli(['--account', key.address, '--usd', '3'], env);
  assert.equal(byWallet.accountId, wallet.accountId);
  assert.equal(byWallet.availableUsd6, '8000000');
  await assert.rejects(grantFromCli(['--account', walletKey().address, '--usd', '1'], env), /No active account/);
  await invariants();
});
