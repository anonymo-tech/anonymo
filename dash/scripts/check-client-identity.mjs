import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import bs58 from 'bs58';
import { walletChoices } from '../components/dashboard/wallet-options.ts';
import {
  connectIdentityWallet,
  getAccountSession,
  getIdentityCapabilities,
  IdentityError,
  preferredSignInMethod,
  requestWalletChallenge,
  signIdentityChallenge,
  signOutAccount,
  validateWalletChallenge,
  verifyWalletProof,
} from '../lib/client/service.ts';
import {
  createWalletChallenge,
  verifyWalletChallenge,
} from '../server/auth/wallet.ts';

const origin = 'https://conclave.test';

void test('wallet picker resolves installed brands and preserves other compatible wallets', () => {
  const installed = [
    'Phantom',
    'Solflare',
    'Backpack',
    'MetaMask',
    'Trust',
    'OKX',
  ].map((name) => ({ name, icon: 'data:image/png;base64,dGVzdA==' }));
  const extra = {
    name: 'Another compatible wallet',
    icon: 'data:image/png;base64,dGVzdA==',
  };
  const options = walletChoices([...installed, extra]);
  assert.equal(options.length, 7);
  for (let i = 0; i < installed.length; i++)
    assert.equal(options[i].wallet, installed[i]);
  assert.equal(options[6].wallet, extra);
  assert.equal(options[6].logo, extra.icon);
  assert.equal(walletChoices([]).filter((option) => option.wallet).length, 0);
});

void test('wallet picker uses local brand assets and rejects remote or executable image sources', () => {
  const brand = { name: 'Phantom', icon: 'https://untrusted.example/track' };
  assert.equal(walletChoices([brand])[0].logo, '/brand/wallets/phantom.svg');
  for (const icon of [
    'https://untrusted.example/track',
    'javascript:alert(1)',
    'data:text/html;base64,dGVzdA==',
  ]) {
    assert.equal(walletChoices([{ name: 'Other wallet', icon }])[6].logo, null);
  }
});
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicBytes = new Uint8Array(
  Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url'),
);
const address = bs58.encode(publicBytes);
const account = {
  address,
  publicKey: publicBytes,
  chains: ['solana:mainnet'],
  features: ['solana:signMessage'],
};
const accountId = randomUUID();
const session = {
  accountId,
  identities: [{ kind: 'solana', subject: address }],
};
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const challenge = () => createWalletChallenge({ address, origin });
function walletFor(challengeValue, overrides = {}) {
  const signedMessage = new TextEncoder().encode(challengeValue.message);
  const output = {
    account,
    signedMessage,
    signature: new Uint8Array(sign(null, signedMessage, privateKey)),
    signatureType: 'ed25519',
  };
  return {
    version: '1.0.0',
    name: 'Synthetic test wallet',
    chains: ['solana:mainnet'],
    accounts: [account],
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async () => ({ accounts: [account] }),
      },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signIn': { version: '1.0.0', signIn: async () => [output] },
      'solana:signMessage': {
        version: '1.0.0',
        signMessage: async () => [output],
      },
      ...overrides,
    },
  };
}

void test('capabilities fail closed and every request uses the fixed same-origin transport', async () => {
  const controller = new AbortController();
  const result = await getIdentityCapabilities({
    signal: controller.signal,
    fetch: async (path, options) => {
      assert.equal(path, '/api/capabilities');
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.mode, 'same-origin');
      assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.signal, controller.signal);
      assert.equal(options.method, 'GET');
      return json({
        mode: 'preview',
        walletSignIn: {
          configured: false,
          format: 'siws',
          formats: ['siws', 'siws-plain-v1'],
        },
      });
    },
  });
  assert.deepEqual(result, { configured: false });
  assert.deepEqual(
    await getIdentityCapabilities({
      fetch: async () =>
        json({
          mode: 'service',
          walletSignIn: {
            configured: true,
            format: 'siws',
            formats: ['siws', 'siws-plain-v1'],
          },
        }),
    }),
    { configured: true },
  );
  // A server that still advertises only plain signing is refused.
  await assert.rejects(
    getIdentityCapabilities({
      fetch: async () =>
        json({
          mode: 'service',
          walletSignIn: { configured: true, format: 'siws-plain-v1' },
        }),
    }),
    { code: 'INVALID_RESPONSE' },
  );
  await assert.rejects(
    getIdentityCapabilities({
      fetch: async () =>
        json({
          mode: 'service',
          walletSignIn: { configured: true, format: 'unexpected' },
        }),
    }),
    { code: 'INVALID_RESPONSE' },
  );
});

void test('challenge is bound to the selected public account, origin and exact sign-in statement', async () => {
  const c = challenge();
  assert.equal(validateWalletChallenge(c, address, origin).message, c.message);
  const result = await requestWalletChallenge(address, origin, {
    fetch: async (path, options) => {
      assert.equal(path, '/api/auth/challenge');
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { address });
      return json({ challenge: c });
    },
  });
  assert.equal(result.id, c.id);
  for (const altered of [
    { ...c, origin: 'https://other.test' },
    { ...c, expiresAt: Date.now() - 1 },
    { ...c, message: 'Authorize a transaction.' },
    { ...c, input: { ...c.input, statement: 'Authorize a transaction.' } },
    {
      ...c,
      input: { ...c.input, address: '11111111111111111111111111111111' },
    },
  ])
    assert.throws(() => validateWalletChallenge(altered, address, origin), {
      code: 'INVALID_RESPONSE',
    });
});

void test('native SIWS and the exact-message fallback produce proofs the server accepts', async () => {
  for (const method of ['signIn', 'signMessage']) {
    const c = challenge(),
      wallet =
        method === 'signIn'
          ? walletFor(c)
          : walletFor(c, { 'solana:signIn': undefined });
    assert.deepEqual(await connectIdentityWallet(wallet), [account]);
    assert.equal(preferredSignInMethod(wallet), method);
    const proof = await signIdentityChallenge(wallet, account, c, method);
    assert.equal(proof.method, method);
    assert.equal(proof.signInSupported, method === 'signIn');
    const verified = await verifyWalletChallenge({
      challenge: c,
      response: proof,
      expectedOrigin: origin,
      requestOrigin: origin,
    });
    assert.equal(verified.address, address);
    assert.equal(
      proof.publicKeyBase64,
      Buffer.from(publicBytes).toString('base64'),
    );
  }
});

void test('the client picks signIn when the wallet offers it and signMessage otherwise', async () => {
  const c = challenge();
  let signInInput = null,
    plainCalls = 0;
  const offered = walletFor(c, {
    'solana:signIn': {
      version: '1.0.0',
      signIn: async (input) => {
        signInInput = input;
        const signedMessage = new TextEncoder().encode(c.message);
        return [
          {
            account,
            signedMessage,
            signature: new Uint8Array(sign(null, signedMessage, privateKey)),
          },
        ];
      },
    },
    'solana:signMessage': {
      version: '1.0.0',
      signMessage: async () => {
        plainCalls++;
        return [];
      },
    },
  });
  assert.equal(preferredSignInMethod(offered), 'signIn');
  const proof = await signIdentityChallenge(
    offered,
    account,
    c,
    preferredSignInMethod(offered),
  );
  assert.deepEqual(signInInput, c.input);
  assert.equal(plainCalls, 0);
  assert.deepEqual(
    { method: proof.method, signInSupported: proof.signInSupported },
    { method: 'signIn', signInSupported: true },
  );
  // Plain signing is refused before the wallet is asked when signIn exists.
  await assert.rejects(
    signIdentityChallenge(offered, account, c, 'signMessage'),
    { code: 'UNSUPPORTED_WALLET' },
  );
  assert.equal(plainCalls, 0);
  const plainOnly = walletFor(c, { 'solana:signIn': undefined });
  assert.equal(preferredSignInMethod(plainOnly), 'signMessage');
  const fallback = await signIdentityChallenge(
    plainOnly,
    account,
    c,
    preferredSignInMethod(plainOnly),
  );
  assert.deepEqual(
    { method: fallback.method, signInSupported: fallback.signInSupported },
    { method: 'signMessage', signInSupported: false },
  );
  await assert.rejects(signIdentityChallenge(plainOnly, account, c, 'signIn'), {
    code: 'UNSUPPORTED_WALLET',
  });
});

void test('wallet rejection never automatically attempts the fallback signature', async () => {
  const c = challenge();
  let fallbackCalls = 0;
  const wallet = walletFor(c, {
    'solana:signIn': {
      signIn: async () => {
        throw new Error('User rejected');
      },
    },
    'solana:signMessage': {
      signMessage: async () => {
        fallbackCalls++;
        return [];
      },
    },
  });
  await assert.rejects(signIdentityChallenge(wallet, account, c, 'signIn'));
  assert.equal(fallbackCalls, 0);
});

void test('modified, offchain, wrong-account and malformed signature outputs are rejected', async () => {
  const c = challenge(),
    validWallet = walletFor(c);
  const [valid] = await validWallet.features['solana:signIn'].signIn();
  for (const output of [
    { ...valid, signedMessage: new TextEncoder().encode(`prefix${c.message}`) },
    {
      ...valid,
      signedMessageFormat: { kind: 'offchainMessage', messageVersion: 1 },
    },
    { ...valid, signature: new Uint8Array(63) },
    { ...valid, signatureType: 'unsupported' },
    {
      ...valid,
      account: { ...account, address: '11111111111111111111111111111111' },
    },
  ]) {
    const wallet = walletFor(c, {
      'solana:signIn': { signIn: async () => [output] },
    });
    await assert.rejects(signIdentityChallenge(wallet, account, c, 'signIn'), {
      code: 'WALLET_PROOF_MISMATCH',
    });
  }
});

void test('a verified proof requires a matching server session before success is returned', async () => {
  const c = challenge(),
    proof = await signIdentityChallenge(walletFor(c), account, c, 'signIn');
  const paths = [];
  const result = await verifyWalletProof(proof, {
    fetch: async (path, options) => {
      paths.push(path);
      if (path === '/api/auth/verify') {
        assert.deepEqual(JSON.parse(options.body), proof);
        return json({ accountId });
      }
      return json(session);
    },
  });
  assert.deepEqual(paths, ['/api/auth/verify', '/api/auth/session']);
  assert.deepEqual(result, session);
  await assert.rejects(
    verifyWalletProof(proof, {
      fetch: async (path) =>
        path === '/api/auth/verify'
          ? json({ accountId })
          : json({ ...session, accountId: randomUUID() }),
    }),
    { code: 'SESSION_NOT_CONFIRMED' },
  );
});

void test('session absence is distinct from network or configuration failure; logout is idempotent', async () => {
  assert.equal(
    await getAccountSession({
      fetch: async () => json({ error: { code: 'SIGN_IN_REQUIRED' } }, 401),
    }),
    null,
  );
  await assert.rejects(
    getAccountSession({
      fetch: async () =>
        json(
          {
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: 'private provider detail',
            },
          },
          503,
        ),
    }),
    (error) =>
      error instanceof IdentityError &&
      !error.message.includes('private provider detail'),
  );
  await assert.rejects(
    getAccountSession({
      fetch: async () => {
        throw new Error('private network detail');
      },
    }),
    { code: 'NETWORK_ERROR' },
  );
  await signOutAccount({
    fetch: async (path, options) => {
      assert.equal(path, '/api/auth/logout');
      assert.equal(options.method, 'POST');
      return json({ signedOut: true });
    },
  });
  await signOutAccount({
    fetch: async () => json({ error: { code: 'SIGN_IN_REQUIRED' } }, 401),
  });
});

void test('malformed and oversized API responses fail closed; abort is preserved', async () => {
  await assert.rejects(
    getAccountSession({
      fetch: async () => new Response('<html>error</html>'),
    }),
    { code: 'INVALID_RESPONSE' },
  );
  await assert.rejects(
    getAccountSession({
      fetch: async () => json({ text: 'x'.repeat(65_537) }),
    }),
    { code: 'INVALID_RESPONSE' },
  );
  await assert.rejects(
    getAccountSession({
      fetch: async () =>
        json({
          accountId,
          identities: [{ kind: 'solana', subject: 'invalid' }],
        }),
    }),
    { code: 'INVALID_RESPONSE' },
  );
  const aborted = new DOMException('Stopped', 'AbortError');
  await assert.rejects(
    getAccountSession({
      fetch: async () => {
        throw aborted;
      },
    }),
    (error) => error === aborted,
  );
});
