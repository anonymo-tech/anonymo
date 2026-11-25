import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnonymoClient } from './client.ts';
import { loadKey, saveKey } from './key-store.ts';
import { createDemoKeySafe } from './mock/key-safe.ts';
import { localKeySafe, removeKeySafe, restoreFromKeySafe, saveToPasskey, unlockWithPasskey, unwrapKeySafe, wrapKeySafe } from './key-safe.ts';
import { toBase64Url } from './share.ts';
import { parseUpdates, updateOn } from './updates.ts';

const key = 'anm_test_fixture_key_1234567890'; // gitleaks:allow
const prf = new Uint8Array(32).fill(17);
const memorySecret = new Uint8Array(32).fill(23);
const rawId = new Uint8Array(64).fill(12).buffer;
const credentialId = toBase64Url(new Uint8Array(rawId));

test('key safe is a build opt-in and visible in demo mode', () => {
  assert.equal(parseUpdates(undefined).has('keysafe'), false);
  assert.equal(parseUpdates('keysafe').has('keysafe'), true);
  assert.equal(updateOn('keysafe', true), true);
});

test('a fixed PRF output round-trips the key, optional memory secret and random safe ID', async () => {
  const wrapped = await wrapKeySafe(prf, credentialId, { key, memorySecret });
  const another = await wrapKeySafe(prf, credentialId, { key });
  assert.notEqual(wrapped.safeId, another.safeId);
  assert.notEqual(wrapped.nonce, another.nonce);
  assert.deepEqual(await unwrapKeySafe(prf, credentialId, wrapped), { safeId: wrapped.safeId, credentialId, key, memorySecret });
  assert.equal((await unwrapKeySafe(prf, credentialId, another)).memorySecret, undefined);
});

test('the wrong PRF output or credential cannot decrypt a wrapped safe', async () => {
  const wrapped = await wrapKeySafe(prf, credentialId, { key, memorySecret });
  await assert.rejects(unwrapKeySafe(new Uint8Array(32), credentialId, wrapped), /could not open/);
  const otherId = toBase64Url(new Uint8Array(64).fill(19));
  await assert.rejects(unwrapKeySafe(prf, otherId, { ...wrapped, credentialId: otherId }), /could not open/);
});

function useGlobals(t, globals) {
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name]);
  }
}

function storage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => values.set(name, value),
    removeItem: (name) => values.delete(name),
    clear: () => values.clear(),
  };
}

class Passkey {
  rawId = rawId;
  constructor(prfResult) { this.prfResult = prfResult; }
  getClientExtensionResults() { return this.prfResult ? { prf: this.prfResult } : {}; }
}

test('save and discoverable restore send only the encrypted fixture to the gateway', async (t) => {
  const requests = [];
  const browserStore = storage();
  const keySafe = createDemoKeySafe(null);
  const client = createAnonymoClient({ baseUrl: 'https://gateway.example', key, fetch: async (input, init) => {
    const request = new Request(input, init);
    requests.push({ headers: request.headers, body: await request.clone().json(), method: request.method });
    return keySafe(request, new URL(request.url).pathname.endsWith('/lookup'));
  } });
  const gets = [];
  let first;
  useGlobals(t, {
    isSecureContext: true, PublicKeyCredential: Passkey, localStorage: browserStore, sessionStorage: storage(),
    navigator: { credentials: {
      async create({ publicKey }) {
        assert.equal(publicKey.authenticatorSelection.residentKey, 'required');
        assert.equal(publicKey.authenticatorSelection.userVerification, 'required');
        assert.equal(publicKey.user.name, 'Anonymo key');
        first = publicKey.extensions.prf.eval.first;
        return new Passkey({ enabled: true }); // This authenticator only evaluates PRF on get.
      },
      async get({ publicKey }) {
        gets.push(publicKey);
        assert.equal(publicKey.userVerification, 'required');
        assert.deepEqual(publicKey.extensions.prf.eval.first, first);
        return new Passkey({ results: { first: prf.buffer } });
      },
    } },
  });

  const { signal } = new AbortController();
  // The browser keeps the memory secret in the IndexedDB vault; Node has none, so the test holds it in memory.
  let held = null;
  const secrets = { read: async () => held, replace: async (bytes) => { held = bytes.slice(); } };
  await secrets.replace(memorySecret);
  const ids = await saveToPasskey(client, false, key, signal, secrets);
  assert.deepEqual(localKeySafe(false), ids);
  assert.deepEqual(gets[0].allowCredentials, [{ id: rawId, type: 'public-key' }]);
  assert.deepEqual(Object.keys(requests[0].body).sort(), ['ciphertext', 'credentialId', 'nonce', 'safeId']);
  for (const secret of [key, toBase64Url(memorySecret), toBase64Url(prf)])
    assert.ok(!JSON.stringify(requests[0].body).includes(secret));

  // Discard the saving device's identifiers and start with an unrelated memory secret.
  browserStore.clear();
  await secrets.replace(new Uint8Array(32));
  assert.equal(localKeySafe(false), null);
  const opened = await unlockWithPasskey(client, signal);
  assert.equal(gets[1].allowCredentials, undefined);
  assert.deepEqual(requests[1].body, { credentialId });
  await restoreFromKeySafe(false, opened, (restored) => saveKey(false, restored, false), secrets);
  assert.equal(loadKey(false), key);
  assert.deepEqual(await secrets.read(), memorySecret);
  assert.deepEqual(localKeySafe(false), ids);

  await removeKeySafe(client, false, ids, signal);
  assert.equal(localKeySafe(false), null);
  assert.equal(loadKey(false), key);
  assert.deepEqual(requests[2].body, ids);
  assert.equal(requests[2].method, 'DELETE');
  await assert.rejects(unlockWithPasskey(client, signal), /No key safe was found/);
  assert.ok(requests.every(({ headers }) => !headers.has('authorization')));
});

test('missing PRF support leads to the copy fallback before any gateway request', async (t) => {
  useGlobals(t, {
    isSecureContext: true, PublicKeyCredential: Passkey,
    navigator: { credentials: { create: async () => new Passkey(), get: async () => new Passkey() } },
  });
  const client = createAnonymoClient({ baseUrl: 'https://gateway.example', fetch: () => assert.fail('unexpected request') });
  const { signal } = new AbortController();
  await assert.rejects(saveToPasskey(client, false, key, signal), /PRF.*copied key/);
  await assert.rejects(unlockWithPasskey(client, signal), /PRF.*copied key/);
});
