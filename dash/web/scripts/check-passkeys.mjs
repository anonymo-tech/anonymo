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
