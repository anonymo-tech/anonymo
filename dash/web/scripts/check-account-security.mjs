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
