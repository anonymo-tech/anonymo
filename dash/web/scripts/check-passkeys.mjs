import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createDatabase, transaction } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import { testEndpoint } from './check-database.mjs';
import {
  configurePasskeys,
  passkeyClient,
  syntheticPasskey,
  signedUpPasskey,
} from './fixtures/passkeys.mjs';
import {
  createSecurityGrant,
  consumeSecurityGrant,
} from '../server/auth/security.ts';
import { hashToken } from '../server/auth/index.ts';
import { passkeyCapability } from '../server/auth/passkey.ts';

const url = testEndpoint(process.env.CONCLAVE_TEST_DATABASE_URL).href,
  pool = createDatabase(url, 8);
before(async () => {
  await migrate(pool);
  configurePasskeys(url);
});
after(() => pool.end());
const login = async (f, overrides = {}) => {
  const client = passkeyClient(pool),
    challenge = await client.options('login');
  return client.verify(
    'login',
    challenge.body.challengeId,
    f.device.authentication(challenge.body.options, overrides),
  );
};
const tokenHash = (f) =>
  hashToken(
    f.client.jar.__Host_conclave_session ??
      f.client.jar['__Host-conclave_session'],
  );
async function reauth(
  f,
  action = { kind: 'add-passkey', target: null },
  overrides = {},
) {
  const options = await f.client.options('reauth', { action });
  assert.equal(options.status, 201);
  return f.client.verify(
    'reauth',
    options.body.challengeId,
    f.device.authentication(options.body.options, overrides),
  );
}
void test('anonymous discoverable signup and login verify real Ed25519 credentials', async () => {
  const f = await signedUpPasskey(pool),
    result = await login(f);
  assert.equal(result.status, 200);
  assert.equal(result.body.accountId, f.accountId);
  assert.equal(f.challenge.accountId, null);
  assert.equal(f.challenge.options.attestation, 'none');
  assert.equal(
    f.challenge.options.authenticatorSelection.residentKey,
    'required',
  );
  assert.equal(
    (
      await pool.query('SELECT count(*) FROM passkeys WHERE account_id=$1', [
        f.accountId,
      ])
    ).rows[0].count,
    '1',
  );
});
void test('ES256 and RS256 credentials verify through maintained library implementations', async () => {
  for (const algorithm of ['ES256', 'RS256']) {
    const f = await signedUpPasskey(pool, { algorithm });
    assert.equal((await login(f)).status, 200);
  }
});
void test('passkeys are gated and IP relying party identifiers are unavailable', () => {
  const env = {
    CONCLAVE_MODE: 'service',
    CONCLAVE_DATABASE_URL: url,
    CONCLAVE_APP_ORIGIN: 'https://127.0.0.1',
    CONCLAVE_PASSKEYS_ENABLED: 'true',
  };
  assert.equal(passkeyCapability(env).configured, false);
  assert.equal(
    passkeyCapability({ ...env, CONCLAVE_APP_ORIGIN: 'http://localhost' }).rpId,
    'localhost',
  );
  assert.equal(
    passkeyCapability({
      ...env,
      CONCLAVE_APP_ORIGIN: 'https://passkeys.example',
      CONCLAVE_PASSKEYS_ENABLED: 'false',
    }).configured,
    false,
  );
});
void test('wrong browser and cross-site requests cannot consume registration ceremonies', async () => {
  const client = passkeyClient(pool),
    challenge = await client.options('signup'),
    device = syntheticPasskey(),
    credential = device.registration(challenge.body.options);
  assert.equal(
    (
      await passkeyClient(pool).verify(
        'signup',
        challenge.body.challengeId,
        credential,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await client.post(
        'auth/passkeys/signup/verify',
        { challengeId: challenge.body.challengeId, credential },
        { headers: { origin: 'https://other.example' } },
      )
    ).status,
    403,
  );
  assert.equal(
    (await client.verify('signup', challenge.body.challengeId, credential))
      .status,
    200,
  );
});
void test('registration rejects crossOrigin and topOrigin even when attestation is none', async () => {
  for (const clientData of [
    { crossOrigin: true },
    { topOrigin: 'https://passkeys.example' },
    { topOrigin: null },
  ]) {
    const client = passkeyClient(pool),
      challenge = await client.options('signup');
    assert.equal(
      (
        await client.verify(
          'signup',
          challenge.body.challengeId,
          syntheticPasskey().registration(challenge.body.options, {
            clientData,
          }),
        )
      ).body.error.code,
      'PASSKEY_PROOF_REJECTED',
    );
  }
});
void test('assertions reject crossOrigin and topOrigin regardless of valid signature', async () => {
  const f = await signedUpPasskey(pool);
  for (const clientData of [
    { crossOrigin: true },
    { topOrigin: 'https://passkeys.example' },
  ])
    assert.equal((await login(f, { clientData })).status, 401);
});
void test('registration binds canonical outer IDs to the attested credential ID', async () => {
  const client = passkeyClient(pool),
    challenge = await client.options('signup'),
    device = syntheticPasskey();
  const mismatch = device.registration(challenge.body.options, {
    attestedId: syntheticPasskey().id,
  });
  assert.equal(
    (await client.verify('signup', challenge.body.challengeId, mismatch))
      .status,
    401,
  );
  const noncanonical = device.registration(challenge.body.options);
  noncanonical.id += '=';
  noncanonical.rawId = noncanonical.id;
  assert.equal(
    (await client.verify('signup', challenge.body.challengeId, noncanonical))
      .status,
    401,
  );
});
void test('user presence and verification are required for registration and authentication', async () => {
  for (const flags of [0x41, 0x44]) {
    const client = passkeyClient(pool),
      challenge = await client.options('signup');
    assert.equal(
      (
        await client.verify(
          'signup',
          challenge.body.challengeId,
          syntheticPasskey().registration(challenge.body.options, { flags }),
        )
      ).status,
      401,
    );
  }
  const f = await signedUpPasskey(pool);
  for (const flags of [1, 4])
    assert.equal((await login(f, { flags })).status, 401);
});
void test('discoverable login requires the exact credential owner user handle', async () => {
  const f = await signedUpPasskey(pool);
  for (const userHandle of [null, Buffer.alloc(32, 7).toString('base64url')])
    assert.equal((await login(f, { userHandle })).status, 401);
});
void test('zero counters remain valid while nonzero counter replay is rejected', async () => {
  const f = await signedUpPasskey(pool);
  assert.equal((await login(f)).status, 200);
  assert.equal((await login(f)).status, 200);
  assert.equal((await login(f, { counter: 1 })).status, 200);
  assert.equal((await login(f, { counter: 1 })).status, 401);
  assert.equal((await login(f, { counter: 0 })).status, 401);
  assert.equal((await login(f, { counter: 2 })).status, 200);
});
void test('concurrent assertions serialize the counter and consume exactly one equal update', async () => {
  const f = await signedUpPasskey(pool),
    a = passkeyClient(pool),
    b = passkeyClient(pool),
    ca = await a.options('login'),
    cb = await b.options('login');
  const results = await Promise.all([
    a.verify(
      'login',
      ca.body.challengeId,
      f.device.authentication(ca.body.options, { counter: 1 }),
    ),
    b.verify(
      'login',
      cb.body.challengeId,
      f.device.authentication(cb.body.options, { counter: 1 }),
    ),
  ]);
  assert.deepEqual(
    results.map((r) => r.status).sort((a, b) => a - b),
    [200, 401],
  );
});
void test('backup eligibility cannot change while backup state can change on synced credentials', async () => {
  const single = await signedUpPasskey(pool);
  assert.equal((await login(single, { flags: 13 })).status, 401);
  const multi = await signedUpPasskey(pool, { backupEligible: true });
  assert.equal((await login(multi, { flags: 29 })).status, 200);
  assert.equal((await login(multi, { flags: 5 })).status, 401);
});
void test('signed-in and stale-cookie concurrent ceremonies cannot create a second account', async () => {
  const client = passkeyClient(pool),
    first = await client.options('signup'),
    second = await client.options('signup'),
    stale = passkeyClient(pool, { cookies: client.jar });
  assert.equal(
    (
      await client.verify(
        'signup',
        first.body.challengeId,
        syntheticPasskey().registration(first.body.options),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await stale.verify(
        'signup',
        second.body.challengeId,
        syntheticPasskey().registration(second.body.options),
      )
    ).body.error.code,
    'SIGN_OUT_REQUIRED',
  );
  assert.equal(
    (await client.options('login')).body.error.code,
    'SIGN_OUT_REQUIRED',
  );
});
void test('reauthentication issues one operation and session bound grant', async () => {
  const f = await signedUpPasskey(pool),
    proof = await reauth(f);
  assert.equal(proof.status, 200);
  assert.equal(proof.body.accountId, f.accountId);
  assert.deepEqual(proof.body.action, { kind: 'add-passkey', target: null });
  const token = await tokenHash(f);
  await assert.rejects(
    () =>
      transaction(pool, (db) =>
        consumeSecurityGrant(db, {
          accountId: f.accountId,
          sessionTokenHash: token,
          action: { kind: 'revoke-sessions', target: 'others' },
          grantToken: proof.body.grantToken,
        }),
      ),
    (error) => error.code === 'REAUTHENTICATION_REQUIRED',
  );
  await transaction(pool, (db) =>
    consumeSecurityGrant(db, {
      accountId: f.accountId,
      sessionTokenHash: token,
      action: proof.body.action,
      grantToken: proof.body.grantToken,
    }),
  );
  await assert.rejects(
    () =>
      transaction(pool, (db) =>
        consumeSecurityGrant(db, {
          accountId: f.accountId,
          sessionTokenHash: token,
          action: proof.body.action,
          grantToken: proof.body.grantToken,
        }),
      ),
    (error) => error.code === 'REAUTHENTICATION_REQUIRED',
  );
});
void test('adding a passkey consumes the grant and revokes other account sessions', async () => {
  const f = await signedUpPasskey(pool);
  await login(f);
  const proof = await reauth(f),
    options = await f.client.options('add', {
      grantToken: proof.body.grantToken,
    });
  assert.equal(options.status, 201);
  assert.ok(
    Date.parse(options.body.expiresAt) <= Date.parse(proof.body.expiresAt),
  );
  assert.equal(
    (await f.client.options('add', { grantToken: proof.body.grantToken }))
      .status,
    401,
  );
  const device = syntheticPasskey(),
    result = await f.client.verify(
      'add',
      options.body.challengeId,
      device.registration(options.body.options),
    );
  assert.equal(result.status, 200);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) FROM sessions WHERE account_id=$1 AND revoked_at IS NULL',
        [f.accountId],
      )
    ).rows[0].count,
    '1',
  );
  assert.equal(
    (
      await pool.query('SELECT count(*) FROM passkeys WHERE account_id=$1', [
        f.accountId,
      ])
    ).rows[0].count,
    '2',
  );
});
void test('revoked authorizer invalidates an outstanding add ceremony', async () => {
  const f = await signedUpPasskey(pool),
    proof = await reauth(f),
    options = await f.client.options('add', {
      grantToken: proof.body.grantToken,
    });
  await pool.query(
    'UPDATE identities SET revoked_at=clock_timestamp() WHERE account_id=$1',
    [f.accountId],
  );
  assert.equal(
    (
      await f.client.verify(
        'add',
        options.body.challengeId,
        syntheticPasskey().registration(options.body.options),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await pool.query('SELECT count(*) FROM passkeys WHERE account_id=$1', [
        f.accountId,
      ])
    ).rows[0].count,
    '1',
  );
});
void test('removal proof cannot use the identity being removed or the last credential', async () => {
  const f = await signedUpPasskey(pool),
    identity = (
      await pool.query('SELECT id FROM identities WHERE account_id=$1', [
        f.accountId,
      ])
    ).rows[0].id;
  assert.equal(
    (
      await f.client.options('reauth', {
        action: { kind: 'remove-identity', target: identity },
      })
    ).body.error.code,
    'LAST_IDENTITY',
  );
  await pool.query(
    "INSERT INTO identities(id,account_id,kind,subject) VALUES($1,$2,'solana',$3)",
    [randomUUID(), f.accountId, randomUUID()],
  );
  assert.equal(
    (
      await f.client.options('reauth', {
        action: { kind: 'remove-identity', target: identity },
      })
    ).body.error.code,
    'PASSKEY_UNAVAILABLE',
  );
  await assert.rejects(
    () =>
      transaction(pool, async (db) =>
        createSecurityGrant(db, {
          accountId: f.accountId,
          sessionTokenHash: await tokenHash(f),
          action: { kind: 'remove-identity', target: identity },
          identityId: identity,
        }),
      ),
    (error) => error.code === 'REAUTHENTICATION_REQUIRED',
  );
});
void test('disabled accounts and revoked credentials cannot authenticate', async () => {
  const disabled = await signedUpPasskey(pool);
  await pool.query(
    'UPDATE accounts SET disabled_at=clock_timestamp() WHERE id=$1',
    [disabled.accountId],
  );
  assert.equal((await login(disabled)).status, 401);
  const revoked = await signedUpPasskey(pool);
  await pool.query(
    'UPDATE identities SET revoked_at=clock_timestamp() WHERE account_id=$1',
    [revoked.accountId],
  );
  assert.equal((await login(revoked)).status, 401);
});
void test('challenge replay and corrupted signatures leave credentials unchanged', async () => {
  const f = await signedUpPasskey(pool),
    client = passkeyClient(pool),
    options = await client.options('login'),
    credential = f.device.authentication(options.body.options, { counter: 8 });
  credential.response.signature = Buffer.alloc(64, 1).toString('base64url');
  assert.equal(
    (await client.verify('login', options.body.challengeId, credential)).status,
    401,
  );
  const valid = f.device.authentication(options.body.options, { counter: 8 });
  assert.equal(
    (await client.verify('login', options.body.challengeId, valid)).status,
    200,
  );
  delete client.jar['__Host-conclave_session'];
  assert.notEqual(
    (await client.verify('login', options.body.challengeId, valid)).status,
    200,
  );
});
void test('immutable public key and backup eligibility are protected by database constraints', async () => {
  const f = await signedUpPasskey(pool);
  await assert.rejects(() =>
    pool.query(
      "UPDATE passkeys SET device_type='multiDevice' WHERE account_id=$1",
      [f.accountId],
    ),
  );
  await assert.rejects(() =>
    pool.query('UPDATE passkey_users SET user_handle=$2 WHERE account_id=$1', [
      f.accountId,
      Buffer.alloc(32, 3).toString('base64url'),
    ]),
  );
});

void test('expired ceremonies cannot insert a credential or create a session', async () => {
  const client = passkeyClient(pool),
    options = await client.options('signup'),
    expiredId = randomUUID();
  await pool.query(
    `INSERT INTO passkey_challenges(id,purpose,browser_hash,challenge,account_id,user_handle,session_token_hash,authorizer_identity_id,action,target,origin,rp_id,allowed_credentials,created_at,expires_at)
    SELECT $2,purpose,browser_hash,challenge,account_id,user_handle,session_token_hash,authorizer_identity_id,action,target,origin,rp_id,allowed_credentials,clock_timestamp()-interval '5 minutes',clock_timestamp()-interval '1 second' FROM passkey_challenges WHERE id=$1`,
    [options.body.challengeId, expiredId],
  );
  const result = await client.verify(
    'signup',
    expiredId,
    syntheticPasskey().registration(options.body.options),
  );
  assert.equal(result.body.error.code, 'CHALLENGE_UNAVAILABLE');
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) FROM identities WHERE account_id=(SELECT account_id FROM passkey_challenges WHERE id=$1)',
        [expiredId],
      )
    ).rows[0].count,
    '0',
  );
});
void test('grants cannot move across sessions or accounts', async () => {
  const f = await signedUpPasskey(pool),
    proof = await reauth(f),
    other = await signedUpPasskey(pool),
    secondLogin = await login(f);
  const secondCookie = secondLogin.response.headers
    .getSetCookie()
    .find((value) => value.startsWith('__Host-conclave_session='));
  const sessionToken = secondCookie.split(';')[0].split('=')[1];
  for (const [accountId, sessionTokenHash] of [
    [f.accountId, await hashToken(sessionToken)],
    [other.accountId, await tokenHash(other)],
  ]) {
    await assert.rejects(
      () =>
        transaction(pool, (db) =>
          consumeSecurityGrant(db, {
            accountId,
            sessionTokenHash,
            action: proof.body.action,
            grantToken: proof.body.grantToken,
          }),
        ),
      (error) => error.code === 'REAUTHENTICATION_REQUIRED',
    );
  }
  assert.equal(
    (await f.client.options('add', { grantToken: proof.body.grantToken }))
      .status,
    201,
  );
});
void test('add finalization rejects a revoked proof identity even when the session survives', async () => {
  const f = await signedUpPasskey(pool),
    proof = await reauth(f),
    options = await f.client.options('add', {
      grantToken: proof.body.grantToken,
    }),
    survivor = randomUUID();
  await pool.query(
    "INSERT INTO identities(id,account_id,kind,subject) VALUES($1,$2,'solana',$3)",
    [survivor, f.accountId, randomUUID()],
  );
  await pool.query('UPDATE sessions SET identity_id=$2 WHERE token_hash=$1', [
    await tokenHash(f),
    survivor,
  ]);
  await pool.query(
    "UPDATE identities SET revoked_at=clock_timestamp() WHERE account_id=$1 AND kind='passkey'",
    [f.accountId],
  );
  assert.equal(
    (
      await f.client.verify(
        'add',
        options.body.challengeId,
        syntheticPasskey().registration(options.body.options),
      )
    ).body.error.code,
    'REAUTHENTICATION_REQUIRED',
  );
});
void test('registration and assertion sizes are bounded before native verification', async () => {
  const client = passkeyClient(pool),
    options = await client.options('signup'),
    credential = syntheticPasskey().registration(options.body.options);
  credential.response.attestationObject =
    Buffer.alloc(16385).toString('base64url');
  assert.equal(
    (await client.verify('signup', options.body.challengeId, credential)).body
      .error.code,
    'PASSKEY_PROOF_REJECTED',
  );
  credential.response.attestationObject = 'x'.repeat(60000);
  assert.equal(
    (await client.verify('signup', options.body.challengeId, credential))
      .status,
    413,
  );
});
void test('reauthentication rejects another account credential and mismatched account headers', async () => {
  const a = await signedUpPasskey(pool),
    b = await signedUpPasskey(pool),
    options = await a.client.options('reauth', {
      action: { kind: 'add-passkey', target: null },
    });
  assert.equal(
    (
      await a.client.verify(
        'reauth',
        options.body.challengeId,
        b.device.authentication(options.body.options),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await a.client.post(
        'auth/passkeys/reauth/options',
        { action: { kind: 'add-passkey', target: null } },
        { headers: { 'x-conclave-account-id': b.accountId } },
      )
    ).body.error.code,
    'ACCOUNT_CHANGED',
  );
});
