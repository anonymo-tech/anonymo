import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPasskeyClient,
  parsePasskeyChallenge,
  performPasskeyCeremony,
  validatePasskeyCredential,
  getAuthCapabilities,
} from '../lib/client/passkeys.ts';
import {
  AccountSecurityError,
  createAccountSecurityClient,
  createSecurityRequest,
  parseSecurityOverview,
  parseSecurityGrant,
  validateSecurityWalletChallenge,
} from '../lib/client/auth-security.ts';
import {
  securityWalletStatement,
  securityWalletMessage,
} from '../lib/auth/security.ts';
import bs58 from 'bs58';
import { getAccountSession } from '../lib/client/service.ts';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const origin = 'https://conclave.example';
const owner = uuid(1),
  now = Date.now(),
  iso = (n) => new Date(n).toISOString();
const b64 = (v) =>
  Buffer.from(typeof v === 'string' ? v : v).toString('base64url');
const bytes = (n) => b64(new Uint8Array(32).fill(n));
const action = { kind: 'add-passkey', target: null };
function envelope(purpose = 'signup') {
  const registration = ['signup', 'add'].includes(purpose);
  return {
    challengeId: uuid(2),
    purpose,
    accountId: ['signup', 'login'].includes(purpose) ? null : owner,
    action: ['add', 'reauth'].includes(purpose) ? action : null,
    expiresAt: iso(now + (purpose === 'add' ? 100_000 : 240_000)),
    rpId: 'conclave.example',
    options: registration
      ? {
          rp: { id: 'conclave.example', name: 'Conclave' },
          user: {
            id: bytes(2),
            name: 'Conclave account',
            displayName: 'Conclave account',
          },
          challenge: bytes(3),
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          timeout: 300000,
          authenticatorSelection: {
            residentKey: 'required',
            userVerification: 'required',
          },
          attestation: 'none',
        }
      : {
          challenge: bytes(3),
          rpId: 'conclave.example',
          timeout: 300000,
          userVerification: 'required',
          ...(purpose === 'reauth'
            ? { allowCredentials: [{ type: 'public-key', id: bytes(4) }] }
            : {}),
        },
  };
}
function challenge(purpose = 'signup') {
  return parsePasskeyChallenge(
    envelope(purpose),
    {
      origin,
      purpose,
      ...(['add', 'reauth'].includes(purpose) ? { accountId: owner } : {}),
      ...(purpose === 'reauth' ? { action } : {}),
    },
    now,
  );
}
function credential(ch = challenge()) {
  const registration = ['signup', 'add'].includes(ch.purpose);
  return {
    id: bytes(4),
    rawId: bytes(4),
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: b64(
        JSON.stringify({
          type: registration ? 'webauthn.create' : 'webauthn.get',
          challenge: ch.options.challenge,
          origin,
          crossOrigin: false,
        }),
      ),
      ...(registration
        ? { attestationObject: bytes(5) }
        : {
            authenticatorData: bytes(6),
            signature: bytes(7),
            userHandle: bytes(2),
          }),
    },
  };
}
const response = (value) => Response.json(value);
const overview = () => ({
  accountId: owner,
  identities: [
    {
      id: uuid(5),
      kind: 'passkey',
      subject: bytes(4),
      createdAt: iso(now - 1000),
    },
  ],
  sessions: [
    {
      id: uuid(6),
      createdAt: iso(now - 1000),
      expiresAt: iso(now + 86400000),
      current: true,
    },
  ],
  moreSessions: false,
});

void test('registration and discoverable login options retain privacy and operation bindings', () => {
  assert.equal(challenge().options.attestation, 'none');
  assert.equal(challenge('login').options.allowCredentials, undefined);
  assert.deepEqual(challenge('add').action, action);
  assert.equal(challenge('reauth').accountId, owner);
});
void test('wrong origin, RP, purpose, owner, action, expired options and weak verification fail before ceremony', () => {
  const cases = [
    (v) => {
      v.rpId = 'other.example';
    },
    (v) => {
      v.purpose = 'login';
    },
    (v) => {
      v.accountId = owner;
    },
    (v) => {
      v.options.rp.id = 'example';
    },
    (v) => {
      v.options.attestation = 'direct';
    },
    (v) => {
      v.options.authenticatorSelection.userVerification = 'preferred';
    },
    (v) => {
      v.options.authenticatorSelection.residentKey = 'preferred';
    },
    (v) => {
      v.options.user.id = bytes(2) + '=';
    },
    (v) => {
      v.expiresAt = iso(now - 1);
    },
    (v) => {
      v.options.extensions = { appid: origin };
    },
  ];
  for (const mutate of cases) {
    const v = envelope();
    mutate(v);
    assert.throws(() =>
      parsePasskeyChallenge(v, { origin, purpose: 'signup' }, now),
    );
  }
  const add = envelope('add');
  add.action = { kind: 'revoke-sessions', target: 'others' };
  assert.throws(() =>
    parsePasskeyChallenge(
      add,
      { origin, purpose: 'add', accountId: owner },
      now,
    ),
  );
});
void test('discoverable login rejects credential allowlist and missing user handle', () => {
  const login = envelope('login');
  login.options.allowCredentials = [{ type: 'public-key', id: bytes(4) }];
  assert.throws(() =>
    parsePasskeyChallenge(login, { origin, purpose: 'login' }, now),
  );
  const ch = challenge('login'),
    result = credential(ch);
  delete result.response.userHandle;
  assert.throws(() => validatePasskeyCredential(result, ch, origin));
});
void test('native return must match challenge, origin, credential ID and reauth allowlist', () => {
  const ch = challenge('reauth');
  for (const mutate of [
    (v) => {
      v.rawId = bytes(9);
    },
    (v) => {
      v.id = v.rawId = bytes(9);
    },
    (v) => {
      v.response.clientDataJSON = b64(
        JSON.stringify({ type: 'webauthn.get', challenge: bytes(8), origin }),
      );
    },
    (v) => {
      v.response.clientDataJSON = b64(
        JSON.stringify({
          type: 'webauthn.get',
          challenge: ch.options.challenge,
          origin,
          crossOrigin: 'false',
        }),
      );
    },
  ]) {
    const v = credential(ch);
    mutate(v);
    assert.throws(() => validatePasskeyCredential(v, ch, origin));
  }
});
void test('synthetic native ceremony may return while hidden but never starts hidden', async () => {
  let visible = true,
    calls = 0;
  const ch = challenge();
  const adapter = {
    register: async () => {
      calls++;
      visible = false;
      return credential(ch);
    },
    authenticate: async () => {
      throw Error('unexpected');
    },
    cancel() {},
  };
  assert.equal(
    (
      await performPasskeyCeremony(ch, {
        origin,
        visible: () => visible,
        adapter,
        now: () => now,
      })
    ).id,
    bytes(4),
  );
  await assert.rejects(
    performPasskeyCeremony(ch, { origin, visible: () => false, adapter }),
    (e) => e.code === 'PAGE_HIDDEN',
  );
  assert.equal(calls, 1);
});
void test('account abort discards late native proof and cancels only its own ceremony', async () => {
  const controller = new AbortController(),
    ch = challenge();
  let resolve,
    cancelled = 0;
  const promise = performPasskeyCeremony(ch, {
    origin,
    signal: controller.signal,
    visible: () => true,
    adapter: {
      register: () =>
        new Promise((r) => {
          resolve = r;
        }),
      authenticate: async () => credential(ch),
      cancel() {
        cancelled++;
      },
    },
  });
  controller.abort();
  resolve(credential(ch));
  await assert.rejects(promise, (e) => e.name === 'AbortError');
  assert.equal(cancelled, 1);
});
void test('simultaneous native ceremonies are refused rather than replacing another prompt', async () => {
  const ch = challenge();
  let resolve;
  const adapter = {
    register: () =>
      new Promise((r) => {
        resolve = r;
      }),
    authenticate: async () => credential(ch),
    cancel() {},
  };
  const pending = performPasskeyCeremony(ch, {
    origin,
    visible: () => true,
    adapter,
  });
  await assert.rejects(
    performPasskeyCeremony(ch, { origin, visible: () => true, adapter }),
    (e) => e.code === 'CEREMONY_BUSY',
  );
  resolve(credential(ch));
  await pending;
});
void test('passkey verification includes cookie/account fence and malformed success remains uncertain', async () => {
  const ch = challenge('add');
  let calls = 0;
  const client = createPasskeyClient({
    origin,
    accountId: owner,
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, '/api/auth/passkeys/add/verify');
      assert.equal(init.credentials, 'same-origin');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers['X-Conclave-Account-Id'], owner);
      assert.equal(JSON.parse(init.body).challengeId, ch.challengeId);
      return response({
        added: true,
        accountId: uuid(99),
        identityId: uuid(8),
      });
    },
  });
  await assert.rejects(
    client.verify(ch, credential(ch)),
    (e) => e instanceof AccountSecurityError && e.outcomeUnknown,
  );
  assert.equal(calls, 1);
});
void test('lost verification response is uncertain and never automatically retried', async () => {
  let calls = 0;
  const client = createPasskeyClient({
    origin,
    fetch: async () => {
      calls++;
      throw Error('synthetic transport failure');
    },
  });
  await assert.rejects(
    client.verify(challenge(), credential()),
    (e) => e.outcomeUnknown,
  );
  assert.equal(calls, 1);
});
void test('security overview rejects foreign account, duplicate sessions and bearer-shaped timestamp data', () => {
  assert.equal(parseSecurityOverview(overview(), owner).identities.length, 1);
  const v = overview();
  v.accountId = uuid(99);
  assert.throws(() => parseSecurityOverview(v, owner));
  const duplicate = overview();
  duplicate.sessions.push(duplicate.sessions[0]);
  assert.throws(() => parseSecurityOverview(duplicate, owner));
  const invalid = overview();
  invalid.sessions[0].createdAt = 'not a UTC timestamp';
  assert.throws(() => parseSecurityOverview(invalid, owner));
});
void test('reauthentication grants cannot cross accounts or operations and expired grants never dispatch', async () => {
  const value = {
    accountId: owner,
    action,
    expiresAt: iso(now + 100000),
    grantToken: bytes(9),
  };
  const grant = parseSecurityGrant(value, owner, action, now);
  assert.throws(() =>
    parseSecurityGrant({ ...value, accountId: uuid(99) }, owner, action, now),
  );
  assert.throws(() =>
    parseSecurityGrant(
      value,
      owner,
      { kind: 'remove-identity', target: uuid(3) },
      now,
    ),
  );
  let calls = 0;
  const client = createAccountSecurityClient({
    accountId: owner,
    fetch: async () => {
      calls++;
      return response({});
    },
  });
  await assert.rejects(
    client.removeIdentity({
      ...grant,
      action: { kind: 'remove-identity', target: uuid(3) },
      expiresAt: now - 1,
    }),
    (e) => e.code === 'GRANT_EXPIRED',
  );
  assert.equal(calls, 0);
});
void test('wallet reauthentication reconstructs exact operation-specific statement and rejects substitution', () => {
  const address = bs58.encode(new Uint8Array(32).fill(7)),
    purpose = 'reauthenticate';
  const input = {
    domain: 'conclave.example',
    address,
    statement: securityWalletStatement(purpose, owner, action),
    uri: `${origin}/`,
    version: '1',
    nonce: 'a'.repeat(32),
    issuedAt: iso(now),
    expirationTime: iso(now + 100000),
    requestId: uuid(2),
  };
  const value = {
    id: uuid(2),
    purpose,
    accountId: owner,
    action,
    address,
    origin,
    input,
    message: securityWalletMessage(input),
    expiresAt: now + 100000,
  };
  const expected = { accountId: owner, action, address, purpose, origin };
  assert.equal(
    validateSecurityWalletChallenge(value, expected, now).message,
    value.message,
  );
  assert.throws(() =>
    validateSecurityWalletChallenge(
      { ...value, message: 'Sign in instead' },
      expected,
      now,
    ),
  );
  assert.throws(() =>
    validateSecurityWalletChallenge(
      { ...value, accountId: uuid(99) },
      expected,
      now,
    ),
  );
});
void test('bounded transport sanitizes errors and refuses arbitrary URLs', async () => {
  let calls = 0;
  const request = createSecurityRequest({
    accountId: owner,
    fetch: async () => {
      calls++;
      return new Response('x'.repeat(132000), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  await assert.rejects(request('https://other.example/api/auth/security'));
  assert.equal(calls, 0);
  await assert.rejects(
    request('/api/auth/security/wallet/verify', {}, true),
    (e) => e.outcomeUnknown && !e.message.includes('xxxx'),
  );
  assert.equal(calls, 1);
});
void test('passkey-only capabilities retain account availability', async () => {
  const value = await getAuthCapabilities({
    fetch: async () =>
      response({
        walletSignIn: { configured: false },
        passkeys: { configured: true, rpId: 'conclave.example' },
      }),
  });
  assert.equal(value.passkeys, true);
  assert.equal(value.wallet, false);
});

void test('session hydration accepts maximum canonical passkey IDs and rejects oversized or ambiguous encodings', async () => {
  const longId = Buffer.alloc(1024, 17).toString('base64url');
  assert.equal(longId.length, 1366);
  const fetchSession = (subject) => async () =>
    Response.json({
      accountId: owner,
      identities: [{ kind: 'passkey', subject }],
    });
  const session = await getAccountSession({ fetch: fetchSession(longId) });
  assert.equal(session.identities[0].subject, longId);
  for (const invalid of [
    Buffer.alloc(1025, 17).toString('base64url'),
    longId + '=',
    'AB',
    'a',
    'invalid!',
  ])
    await assert.rejects(getAccountSession({ fetch: fetchSession(invalid) }));
});
