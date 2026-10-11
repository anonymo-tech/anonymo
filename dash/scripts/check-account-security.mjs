import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import test, { before, after } from 'node:test';
import bs58 from 'bs58';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import { dispatch } from '../server/routes/dispatch.ts';
import {
  createSecurityWalletChallenge,
  verifySecurityWalletChallenge,
} from '../server/auth/security-wallet.ts';

const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
if (!connection) throw new Error('Use an isolated local test database.');
const endpoint = new URL(connection);
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
  !endpoint.pathname.endsWith('_test')
)
  throw new Error('Use an isolated local test database.');
const origin = 'https://conclave.test';
Object.assign(process.env, {
  CONCLAVE_MODE: 'service',
  CONCLAVE_APP_ORIGIN: origin,
  CONCLAVE_DATABASE_URL: connection,
});
const pool = createDatabase(connection, 12);
before(() => migrate(pool));
after(() => pool.end());

function wallet() {
  const pair = generateKeyPairSync('ed25519');
  const bytes = Buffer.from(
    pair.publicKey.export({ format: 'jwk' }).x,
    'base64url',
  );
  return { ...pair, address: bs58.encode(bytes), bytes };
}
function proof(w, challenge) {
  return {
    challengeId: challenge.id,
    address: w.address,
    signatureType: 'ed25519',
    publicKeyBase64: w.bytes.toString('base64'),
    signedMessageBase64: Buffer.from(challenge.message).toString('base64'),
    signatureBase64: sign(
      null,
      Buffer.from(challenge.message),
      w.privateKey,
    ).toString('base64'),
    // The client reports Sign In With Solana when the wallet offers it.
    method: 'signIn',
    signInSupported: true,
  };
}
function jar() {
  return { cookies: new Map(), accountId: null };
}
async function request(client, path, body, extra = {}) {
  const response = await dispatch(
    new Request(`${origin}/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        origin,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(client.accountId
          ? { 'x-conclave-account-id': client.accountId }
          : {}),
        cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  for (const cookie of response.headers.getSetCookie()) {
    const first = cookie.split(';')[0],
      i = first.indexOf('=');
    client.cookies.set(first.slice(0, i), first.slice(i + 1));
  }
  return { status: response.status, body: await response.json() };
}
async function login(w = wallet()) {
  const client = jar();
  const options = await request(client, 'auth/challenge', {
    address: w.address,
  });
  assert.equal(options.status, 201);
  const result = await request(
    client,
    'auth/verify',
    proof(w, options.body.challenge),
  );
  assert.equal(result.status, 200);
  client.accountId = result.body.accountId;
  return { client, wallet: w };
}
async function details(client) {
  const result = await request(client, 'auth/security');
  assert.equal(result.status, 200);
  return result.body;
}
async function authorize(client, w, action) {
  const state = await details(client),
    identity = state.identities.find((x) => x.subject === w.address);
  assert.ok(identity);
  const options = await request(client, 'auth/security/wallet/options', {
    identityId: identity.id,
    action,
  });
  assert.equal(options.status, 201);
  const result = await request(client, 'auth/security/wallet/verify', {
    challengeId: options.body.challenge.id,
    proof: proof(w, options.body.challenge),
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.action, action);
  return result.body.grantToken;
}
async function link(owner, target = wallet()) {
  const grantToken = await authorize(owner.client, owner.wallet, {
    kind: 'link-wallet',
    target: target.address,
  });
  const options = await request(
    owner.client,
    'auth/security/wallet/link/options',
    { address: target.address, grantToken },
  );
  assert.equal(options.status, 201);
  const payload = {
    challengeId: options.body.challenge.id,
    proof: proof(target, options.body.challenge),
  };
  const result = await request(
    owner.client,
    'auth/security/wallet/link/verify',
    payload,
  );
  assert.equal(result.status, 200);
  return { target, payload, grantToken };
}

void test('security wallet proof binds exact action account origin and bytes', () => {
  const w = wallet(),
    accountId = randomUUID();
  const challenge = createSecurityWalletChallenge({
    address: w.address,
    accountId,
    origin,
    purpose: 'reauthenticate',
    action: { kind: 'add-passkey', target: null },
  });
  const response = proof(w, challenge);
  const verify = (c = challenge, r = response, requestOrigin = origin) =>
    verifySecurityWalletChallenge({
      challenge: c,
      response: r,
      requestOrigin,
      expectedOrigin: origin,
    });
  verify();
  assert.throws(() => verify({ ...challenge, accountId: randomUUID() }));
  assert.throws(() =>
    verify({
      ...challenge,
      action: { kind: 'revoke-sessions', target: 'others' },
    }),
  );
  assert.throws(() =>
    verify(challenge, {
      ...response,
      signatureBase64: Buffer.alloc(64).toString('base64'),
    }),
  );
  assert.throws(() => verify(challenge, response, 'https://other.test'));
  assert.throws(() =>
    verifySecurityWalletChallenge({
      challenge,
      response,
      requestOrigin: origin,
      expectedOrigin: origin,
      now: challenge.expiresAt,
    }),
  );
});

void test('ordinary wallet sign-in binds its one-use proof to the initiating browser', async () => {
  const w = wallet(),
    first = jar(),
    second = jar();
  const options = await request(first, 'auth/challenge', {
    address: w.address,
  });
  assert.equal(options.status, 201);
  assert.equal(Object.hasOwn(options.body.challenge, 'browserHash'), false);
  const payload = proof(w, options.body.challenge);
  assert.equal((await request(second, 'auth/verify', payload)).status, 401);
  await request(second, 'auth/challenge', { address: w.address });
  assert.equal((await request(second, 'auth/verify', payload)).status, 401);
  assert.equal((await request(first, 'auth/verify', payload)).status, 200);
  assert.equal((await request(first, 'auth/verify', payload)).status, 401);
});

void test('account security lists only owned active identities and opaque session identifiers', async () => {
  const owner = await login(),
    other = await login();
  const state = await details(owner.client);
  assert.equal(state.identities.length, 1);
  assert.equal(state.identities[0].subject, owner.wallet.address);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].current, true);
  assert.deepEqual(Object.keys(state.sessions[0]).sort(), [
    'createdAt',
    'current',
    'expiresAt',
    'id',
  ]);
  assert.equal(
    (
      await request(owner.client, 'auth/security', undefined, {
        'x-conclave-account-id': other.client.accountId,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request(owner.client, 'auth/security', undefined, {
        'x-conclave-account-id': '',
      })
    ).status,
    401,
  );
});

void test('one session alone cannot add or remove a sign-in method', async () => {
  const owner = await login(),
    state = await details(owner.client),
    target = wallet();
  const unknown = 'a'.repeat(43);
  assert.notEqual(
    (
      await request(owner.client, 'auth/security/wallet/link/options', {
        address: target.address,
        grantToken: unknown,
      })
    ).status,
    201,
  );
  assert.notEqual(
    (
      await request(
        owner.client,
        `auth/security/identities/${state.identities[0].id}/remove`,
        { grantToken: unknown },
      )
    ).status,
    200,
  );
  assert.equal((await details(owner.client)).identities.length, 1);
});

void test('linking requires both proofs consumes the challenge and revokes other sessions', async () => {
  const owner = await login(),
    second = await login(owner.wallet);
  const { target, payload, grantToken } = await link(owner);
  const state = await details(owner.client);
  assert.equal(state.identities.length, 2);
  assert.ok(state.identities.some((x) => x.subject === target.address));
  assert.equal((await request(second.client, 'auth/session')).status, 401);
  assert.equal(
    (await request(owner.client, 'auth/security/wallet/link/verify', payload))
      .status,
    401,
  );
  assert.notEqual(
    (
      await request(owner.client, 'auth/security/wallet/link/options', {
        address: wallet().address,
        grantToken,
      })
    ).status,
    201,
  );
});

void test('grant cannot authorize another action or target wallet', async () => {
  const owner = await login(),
    target = wallet();
  const grantToken = await authorize(owner.client, owner.wallet, {
    kind: 'add-passkey',
    target: null,
  });
  assert.notEqual(
    (
      await request(owner.client, 'auth/security/wallet/link/options', {
        address: target.address,
        grantToken,
      })
    ).status,
    201,
  );
  assert.notEqual(
    (
      await request(owner.client, 'auth/security/sessions/revoke', {
        target: 'others',
        grantToken,
      })
    ).status,
    200,
  );
  assert.equal((await details(owner.client)).identities.length, 1);
});

void test('wallet reauthentication is bound to the requesting browser', async () => {
  const owner = await login(),
    state = await details(owner.client);
  const options = await request(owner.client, 'auth/security/wallet/options', {
    identityId: state.identities[0].id,
    action: { kind: 'add-passkey', target: null },
  });
  assert.equal(options.status, 201);
  const copied = {
    accountId: owner.client.accountId,
    cookies: new Map(
      [...owner.client.cookies].filter(([key]) => key.includes('session')),
    ),
  };
  assert.equal(
    (
      await request(copied, 'auth/security/wallet/verify', {
        challengeId: options.body.challenge.id,
        proof: proof(owner.wallet, options.body.challenge),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request(owner.client, 'auth/security/wallet/verify', {
        challengeId: options.body.challenge.id,
        proof: proof(owner.wallet, options.body.challenge),
      })
    ).status,
    200,
  );
});

void test('revoked sessions cannot finish an earlier authorization', async () => {
  const owner = await login(),
    state = await details(owner.client);
  const options = await request(owner.client, 'auth/security/wallet/options', {
    identityId: state.identities[0].id,
    action: { kind: 'add-passkey', target: null },
  });
  await pool.query('UPDATE sessions SET revoked_at=now() WHERE account_id=$1', [
    owner.client.accountId,
  ]);
  assert.equal(
    (
      await request(owner.client, 'auth/security/wallet/verify', {
        challengeId: options.body.challenge.id,
        proof: proof(owner.wallet, options.body.challenge),
      })
    ).status,
    401,
  );
});

void test('the last identity and self-authorized removal are refused', async () => {
  const owner = await login();
  let state = await details(owner.client);
  const first = state.identities[0];
  assert.notEqual(
    (
      await request(owner.client, 'auth/security/wallet/options', {
        identityId: first.id,
        action: { kind: 'remove-identity', target: first.id },
      })
    ).status,
    201,
  );
  await link(owner);
  state = await details(owner.client);
  assert.notEqual(
    (
      await request(owner.client, 'auth/security/wallet/options', {
        identityId: first.id,
        action: { kind: 'remove-identity', target: first.id },
      })
    ).status,
    201,
  );
  assert.equal(state.identities.length, 2);
});

void test('removal retains the proven remaining identity and tombstones wallet login', async () => {
  const owner = await login(),
    { target } = await link(owner),
    otherSession = await login(owner.wallet);
  const state = await details(owner.client),
    original = state.identities.find((x) => x.subject === owner.wallet.address);
  const grantToken = await authorize(owner.client, target, {
    kind: 'remove-identity',
    target: original.id,
  });
  assert.equal(
    (
      await request(
        owner.client,
        `auth/security/identities/${original.id}/remove`,
        { grantToken },
      )
    ).status,
    200,
  );
  assert.equal(
    (await request(otherSession.client, 'auth/session')).status,
    401,
  );
  const remaining = await details(owner.client);
  assert.equal(remaining.identities.length, 1);
  assert.equal(remaining.identities[0].subject, target.address);
  const fresh = jar(),
    options = await request(fresh, 'auth/challenge', {
      address: owner.wallet.address,
    });
  assert.equal(
    (
      await request(
        fresh,
        'auth/verify',
        proof(owner.wallet, options.body.challenge),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM identities WHERE kind='solana' AND subject=$1",
        [owner.wallet.address],
      )
    ).rows[0].count,
    '1',
  );
});

void test('revoked authorization identity invalidates outstanding grants', async () => {
  const owner = await login(),
    { target } = await link(owner);
  const state = await details(owner.client),
    second = state.identities.find((x) => x.subject === target.address);
  const grantToken = await authorize(owner.client, target, {
    kind: 'revoke-sessions',
    target: 'others',
  });
  await pool.query('UPDATE identities SET revoked_at=now() WHERE id=$1', [
    second.id,
  ]);
  assert.notEqual(
    (
      await request(owner.client, 'auth/security/sessions/revoke', {
        target: 'others',
        grantToken,
      })
    ).status,
    200,
  );
});

void test('session revocation is scoped and can explicitly end the current session', async () => {
  const owner = await login(),
    other = await login(owner.wallet),
    unrelated = await login();
  let grantToken = await authorize(owner.client, owner.wallet, {
    kind: 'revoke-sessions',
    target: 'others',
  });
  let result = await request(owner.client, 'auth/security/sessions/revoke', {
    target: 'others',
    grantToken,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.signedOut, false);
  assert.equal(result.body.revoked, 1);
  assert.equal((await request(other.client, 'auth/session')).status, 401);
  assert.equal((await request(unrelated.client, 'auth/session')).status, 200);
  const state = await details(owner.client),
    current = state.sessions.find((x) => x.current);
  grantToken = await authorize(owner.client, owner.wallet, {
    kind: 'revoke-sessions',
    target: current.id,
  });
  result = await request(owner.client, 'auth/security/sessions/revoke', {
    target: current.id,
    grantToken,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.signedOut, true);
  assert.equal((await request(owner.client, 'auth/session')).status, 401);
});

void test('a wallet belonging to another account cannot be merged through linking', async () => {
  const owner = await login(),
    other = await login(),
    state = await details(owner.client);
  const result = await request(owner.client, 'auth/security/wallet/options', {
    identityId: state.identities[0].id,
    action: { kind: 'link-wallet', target: other.wallet.address },
  });
  assert.equal(result.status, 409);
  assert.equal((await details(owner.client)).identities.length, 1);
  assert.equal((await details(other.client)).identities.length, 1);
});

void test('concurrent removals retain one proven sign-in method', async () => {
  const owner = await login(),
    { target } = await link(owner);
  const state = await details(owner.client);
  const first = state.identities.find(
    (x) => x.subject === owner.wallet.address,
  );
  const second = state.identities.find((x) => x.subject === target.address);
  const firstGrant = await authorize(owner.client, target, {
    kind: 'remove-identity',
    target: first.id,
  });
  const secondGrant = await authorize(owner.client, owner.wallet, {
    kind: 'remove-identity',
    target: second.id,
  });
  const results = await Promise.all([
    request(owner.client, `auth/security/identities/${first.id}/remove`, {
      grantToken: firstGrant,
    }),
    request(owner.client, `auth/security/identities/${second.id}/remove`, {
      grantToken: secondGrant,
    }),
  ]);
  assert.equal(results.filter((result) => result.status === 200).length, 1);
  assert.equal((await details(owner.client)).identities.length, 1);
});
