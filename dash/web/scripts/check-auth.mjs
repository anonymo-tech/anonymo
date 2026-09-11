import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  AuthError,
  SESSION_COOKIE_NAME,
  assertCsrfToken,
  assertSameOrigin,
  canonicalOrigin,
  createWalletChallenge,
  decodeWalletAddress,
  generateSessionToken,
  hashToken,
  parseSignInMessage,
  readSessionCookie,
  serializeExpiredSessionCookie,
  serializeSessionCookie,
  verifyWalletChallenge,
  walletSignInMethod,
} from '../server/auth/index.ts';

const origin = 'https://conclave.example';
const now = Date.UTC(2026, 0, 1);
const encode = (value) => Buffer.from(value).toString('base64');
const utf8 = (value) => new TextEncoder().encode(value);
const clone = (value) => structuredClone(value);
const error = (code) => (value) =>
  value instanceof AuthError && value.code === code;

async function makeKey() {
  const pair = await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ]);
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey('raw', pair.publicKey),
  );
  return { pair, publicKey, address: bs58.encode(publicKey) };
}

// Test identities exist only in memory; no private key fixture is committed.
const [signer, otherSigner] = await Promise.all([makeKey(), makeKey()]);
const challenge = (options = {}) =>
  createWalletChallenge({ address: signer.address, origin, now, ...options });

async function responseFor(
  value,
  message = value.message,
  key = signer,
  method = { method: 'signMessage', signInSupported: false },
) {
  const bytes = utf8(message);
  const signature = await crypto.subtle.sign(
    'Ed25519',
    key.pair.privateKey,
    bytes,
  );
  return {
    challengeId: value.id,
    address: value.address,
    publicKeyBase64: encode(key.publicKey),
    signedMessageBase64: encode(bytes),
    signatureBase64: encode(new Uint8Array(signature)),
    signatureType: 'ed25519',
    ...method,
  };
}
const signInMethod = { method: 'signIn', signInSupported: true };
const signInResponse = (value, message = value.message) =>
  responseFor(value, message, signer, signInMethod);

// Mirrors the Sign In With Solana reference `createSignInMessageText` (field
// order, LF separators, optional sections) to pin the server's byte layout.
function referenceSignInText(input) {
  let message = `${input.domain} wants you to sign in with your Solana account:\n${input.address}`;
  if (input.statement) message += `\n\n${input.statement}`;
  const fields = [];
  if (input.uri) fields.push(`URI: ${input.uri}`);
  if (input.version) fields.push(`Version: ${input.version}`);
  if (input.chainId) fields.push(`Chain ID: ${input.chainId}`);
  if (input.nonce) fields.push(`Nonce: ${input.nonce}`);
  if (input.issuedAt) fields.push(`Issued At: ${input.issuedAt}`);
  if (input.expirationTime)
    fields.push(`Expiration Time: ${input.expirationTime}`);
  if (input.notBefore) fields.push(`Not Before: ${input.notBefore}`);
  if (input.requestId) fields.push(`Request ID: ${input.requestId}`);
  if (input.resources) {
    fields.push('Resources:');
    for (const resource of input.resources) fields.push(`- ${resource}`);
  }
  if (fields.length) message += `\n\n${fields.join('\n')}`;
  return message;
}

function verify(value, response, options = {}) {
  return verifyWalletChallenge({
    challenge: value,
    response,
    expectedOrigin: origin,
    requestOrigin: origin,
    now,
    ...options,
  });
}

void test('server challenge has the fixed plain SIWS byte layout and UTC lifetime', () => {
  const value = challenge();
  assert.match(
    value.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.match(value.input.nonce, /^[a-f0-9]{32}$/);
  assert.equal(
    value.message,
    [
      'conclave.example wants you to sign in with your Solana account:',
      signer.address,
      '',
      'Sign in to Conclave. This does not authorize a transaction or payment.',
      '',
      `URI: ${origin}/`,
      'Version: 1',
      `Nonce: ${value.input.nonce}`,
      'Issued At: 2026-01-01T00:00:00.000Z',
      'Expiration Time: 2026-01-01T00:05:00.000Z',
      `Request ID: ${value.id}`,
    ].join('\n'),
  );
  assert.equal(value.input.requestId, value.id);
  assert.equal(value.expiresAt, now + 300_000);
  assert.equal(value.input.useOffchainMessage, undefined);
});

void test('challenge UUID and independent nonce change for every issuance', () => {
  const values = Array.from({ length: 64 }, () => challenge());
  assert.equal(new Set(values.map((value) => value.id)).size, values.length);
  assert.equal(
    new Set(values.map((value) => value.input.nonce)).size,
    values.length,
  );
});

void test('challenge accepts only a bounded valid clock and lifetime', () => {
  for (const ttlSeconds of [0, -1, 601, Infinity, NaN, 0.0001])
    assert.throws(() => challenge({ ttlSeconds }), error('invalid_challenge'));
  for (const time of [-1, Infinity, NaN, 1.5, 8_640_000_000_000_000])
    assert.throws(() => challenge({ now: time }), error('invalid_challenge'));
  assert.equal(challenge({ ttlSeconds: 600 }).expiresAt, now + 600_000);
});

void test('a canonical wallet signs the exact challenge and returns only the verified identity', async () => {
  const value = challenge();
  const response = await responseFor(value);
  assert.deepEqual(await verify(value, response), {
    challengeId: value.id,
    address: signer.address,
    method: 'signMessage',
  });
  delete response.publicKeyBase64;
  delete response.signatureType;
  assert.deepEqual(await verify(value, response), {
    challengeId: value.id,
    address: signer.address,
    method: 'signMessage',
  });
  assert.deepEqual(decodeWalletAddress(signer.address), signer.publicKey);
});

void test('sign-in requires the configured request origin', async () => {
  const value = challenge();
  const response = await responseFor(value);
  for (const requestOrigin of [
    null,
    'null',
    'https://other.example',
    `${origin}/`,
    `${origin}:444`,
    `${origin} https://other.example`,
  ])
    await assert.rejects(
      verify(value, response, { requestOrigin }),
      error('invalid_origin'),
    );
});

void test('signature cannot be reused for another challenge or wallet', async () => {
  const value = challenge();
  const response = await responseFor(value);
  await assert.rejects(
    verify(value, { ...response, challengeId: crypto.randomUUID() }),
    error('challenge_mismatch'),
  );
  await assert.rejects(
    verify(value, { ...response, address: otherSigner.address }),
    error('challenge_mismatch'),
  );
  await assert.rejects(
    verify(value, {
      ...response,
      publicKeyBase64: encode(otherSigner.publicKey),
    }),
    error('challenge_mismatch'),
  );
  const second = challenge();
  await assert.rejects(
    verify(second, { ...response, challengeId: second.id }),
    error('challenge_mismatch'),
  );
});

void test('changed nonce, address, URI, whitespace and newline bytes are rejected even when signed', async () => {
  const value = challenge();
  for (const message of [
    `${value.message}\n`,
    value.message.replaceAll('\n', '\r\n'),
    value.message.replace(value.input.nonce, '0'.repeat(32)),
    value.message.replace(signer.address, otherSigner.address),
    value.message.replace(`URI: ${origin}/`, 'URI: https://other.example/'),
    value.message.replace('Sign in to Conclave.', 'Sign in to Conclave. '),
  ])
    await assert.rejects(
      verify(value, await responseFor(value, message)),
      error('challenge_mismatch'),
    );
});

void test('server-record field mismatches cannot be hidden by an otherwise valid signature', async () => {
  const value = challenge();
  const response = await responseFor(value);
  const mutations = [
    (record) => {
      record.purpose = 'payment';
    },
    (record) => {
      record.id = 'unstructured-id';
    },
    (record) => {
      record.origin = 'https://other.example';
    },
    (record) => {
      record.expiresAt += 1;
    },
    (record) => {
      record.message += '\n';
    },
    (record) => {
      record.input.domain = 'other.example';
    },
    (record) => {
      record.input.uri = `${origin}/other`;
    },
    (record) => {
      record.input.version = '2';
    },
    (record) => {
      record.input.nonce = 'short';
    },
    (record) => {
      record.input.nonce = '0'.repeat(32);
    },
    (record) => {
      record.input.requestId = crypto.randomUUID();
    },
    (record) => {
      record.input.address = otherSigner.address;
    },
    (record) => {
      record.input.statement = 'Approve a transfer';
    },
    (record) => {
      record.input.issuedAt = 'not-a-date';
    },
    (record) => {
      record.input.issuedAt = '2026-01-01T00:00:00Z';
    },
    (record) => {
      record.input.expirationTime = 'not-a-date';
    },
  ];
  for (const mutate of mutations) {
    const changed = clone(value);
    mutate(changed);
    await assert.rejects(verify(changed, response), error('invalid_challenge'));
  }
});

void test('expiry is strict at its boundary and excessive future issue times are rejected', async () => {
  const value = challenge();
  const response = await responseFor(value);
  await verify(value, response, { now: value.expiresAt - 1 });
  await assert.rejects(
    verify(value, response, { now: value.expiresAt }),
    error('challenge_expired'),
  );
  await assert.rejects(
    verify(value, response, { now: value.expiresAt + 1 }),
    error('challenge_expired'),
  );
  const future = challenge({ now: now + 30_001 });
  await assert.rejects(
    verify(future, await responseFor(future)),
    error('invalid_challenge'),
  );
});

void test('consumed challenge records reject all non-null consumed timestamps', async () => {
  const value = challenge();
  const response = await responseFor(value);
  for (const consumedAt of [0, now, new Date(now), new Date(now).toISOString()])
    await assert.rejects(
      verify(value, response, { consumedAt }),
      error('challenge_used'),
    );
  await verify(value, response, { consumedAt: null });
});

void test('proof verification is pure; caller must atomically consume before session creation', async () => {
  const value = challenge();
  const response = await responseFor(value);
  // Two workers can both verify the same stale unused row. This intentionally
  // demonstrates the contract, not a production store or a database lock test.
  const proofs = await Promise.all([
    verify(value, response),
    verify(value, response),
  ]);
  let consumedAt = null;
  let sessions = 0;
  const consumeForFixture = (proof) => {
    assert.equal(proof.challengeId, value.id);
    if (consumedAt !== null) return false;
    consumedAt = now;
    sessions += 1;
    return true;
  };
  assert.deepEqual(proofs.map(consumeForFixture), [true, false]);
  assert.equal(sessions, 1);
  await assert.rejects(
    verify(value, response, { consumedAt }),
    error('challenge_used'),
  );
});

void test('OCMS and every declared unsupported message format fail explicitly', async () => {
  const value = challenge();
  const response = await responseFor(value);
  for (const signedMessageFormat of [
    { kind: 'offchainMessage', messageVersion: 1 },
    { kind: 'offchainMessage', messageVersion: 2 },
    { kind: 'plain' },
    { kind: 'unknown' },
    null,
  ])
    await assert.rejects(
      verify(value, { ...response, signedMessageFormat }),
      error('unsupported_message_format'),
    );
  await assert.rejects(
    verify(value, { ...response, signatureType: 'unknown' }),
    error('unsupported_message_format'),
  );
  const envelope = `\xffsolana offchain\x01${value.message}`;
  await assert.rejects(
    verify(value, await responseFor(value, envelope)),
    error('challenge_mismatch'),
  );
});

void test('the challenge input reproduces the server text through the SIWS reference layout', () => {
  const value = challenge();
  assert.equal(referenceSignInText(value.input), value.message);
  assert.deepEqual(parseSignInMessage(value.message), {
    domain: 'conclave.example',
    address: signer.address,
    statement: value.input.statement,
    uri: `${origin}/`,
    version: '1',
    nonce: value.input.nonce,
    issuedAt: value.input.issuedAt,
    expirationTime: value.input.expirationTime,
    requestId: value.id,
  });
  const optional = {
    ...value.input,
    chainId: 'mainnet',
    notBefore: value.input.issuedAt,
    resources: ['https://conclave.example/a', 'https://conclave.example/b'],
  };
  assert.deepEqual(
    parseSignInMessage(referenceSignInText(optional)),
    Object.fromEntries(
      Object.entries(optional).filter(([key]) => key !== 'useOffchainMessage'),
    ),
  );
  assert.deepEqual(
    parseSignInMessage(
      referenceSignInText({ domain: 'conclave.example', address: signer.address }),
    ),
    { domain: 'conclave.example', address: signer.address },
  );
});

void test('a signIn proof verifies the wallet-built text field by field', async () => {
  const value = challenge();
  assert.deepEqual(await verify(value, await signInResponse(value)), {
    challengeId: value.id,
    address: signer.address,
    method: 'signIn',
  });
  assert.deepEqual(
    await verify(
      value,
      await signInResponse(value, referenceSignInText(value.input)),
    ),
    { challengeId: value.id, address: signer.address, method: 'signIn' },
  );
});

void test('signIn rejects a mismatched domain, nonce, address, URI, statement, time or version', async () => {
  const value = challenge();
  const altered = [
    { domain: 'evil.example' },
    { domain: 'conclave.example.evil.example' },
    { nonce: '0'.repeat(32) },
    { address: otherSigner.address },
    { uri: 'https://evil.example/' },
    { statement: 'Sign in to Conclave.' },
    { issuedAt: '2026-01-01T00:00:01.000Z' },
    { expirationTime: '2026-01-01T00:10:00.000Z' },
    { version: '2' },
    { requestId: crypto.randomUUID() },
  ];
  for (const change of altered)
    await assert.rejects(
      verify(
        value,
        await signInResponse(
          value,
          referenceSignInText({ ...value.input, ...change }),
        ),
      ),
      error('challenge_mismatch'),
    );
  await assert.rejects(
    verify(value, await signInResponse(value), {
      now: Date.parse(value.input.expirationTime),
    }),
    error('challenge_expired'),
  );
});

void test('signIn rejects fields the challenge did not request', async () => {
  const value = challenge();
  for (const extra of [
    { chainId: 'mainnet' },
    { chainId: 'solana:devnet' },
    { notBefore: value.input.issuedAt },
    { resources: ['https://conclave.example/'] },
  ]) {
    const message = referenceSignInText({ ...value.input, ...extra });
    assert.notEqual(parseSignInMessage(message), null);
    await assert.rejects(
      verify(value, await signInResponse(value, message)),
      error('challenge_mismatch'),
    );
  }
  const unknownField = value.message.replace(
    `Request ID: ${value.id}`,
    `Request ID: ${value.id}\nSession: elevated`,
  );
  assert.equal(parseSignInMessage(unknownField), null);
  await assert.rejects(
    verify(value, await signInResponse(value, unknownField)),
    error('challenge_mismatch'),
  );
});

void test('signIn rejects CRLF, padding, reordering, duplicates and trailing bytes', async () => {
  const value = challenge();
  const nonceLine = `Nonce: ${value.input.nonce}`;
  const versionLine = 'Version: 1';
  const tampered = [
    `${value.message}\n`,
    `${value.message}\n\n`,
    `\n${value.message}`,
    `﻿${value.message}`,
    value.message.replaceAll('\n', '\r\n'),
    value.message.replace('\n\nURI:', '\n\n\nURI:'),
    value.message.replace(nonceLine, `${nonceLine} `),
    value.message.replace(nonceLine, `Nonce:  ${value.input.nonce}`),
    value.message.replace(nonceLine, `Nonce:\t${value.input.nonce}`),
    value.message.replace(nonceLine, ` ${nonceLine}`),
    value.message.replace('Sign in to Conclave.', ' Sign in to Conclave.'),
    value.message.replace(' wants you', '  wants you'),
    value.message.replace(nonceLine, `${nonceLine}\n${nonceLine}`),
    value.message.replace(
      `${versionLine}\n${nonceLine}`,
      `${nonceLine}\n${versionLine}`,
    ),
  ];
  for (const message of tampered) {
    assert.equal(parseSignInMessage(message), null, JSON.stringify(message));
    await assert.rejects(
      verify(value, await signInResponse(value, message)),
      error('challenge_mismatch'),
    );
  }
  // Omitting a requested field is valid SIWS syntax but still not this challenge.
  const missingNonce = value.message.replace(`\n${nonceLine}`, '');
  assert.equal(parseSignInMessage(missingNonce)?.nonce, undefined);
  await assert.rejects(
    verify(value, await signInResponse(value, missingNonce)),
    error('challenge_mismatch'),
  );
  const invalidUtf8 = await signInResponse(value);
  invalidUtf8.signedMessageBase64 = encode(
    new Uint8Array([...utf8(value.message), 0xff]),
  );
  await assert.rejects(verify(value, invalidUtf8), error('challenge_mismatch'));
});

void test('a wallet that offers signIn cannot sign in with plain signMessage', async () => {
  const value = challenge();
  const plain = await responseFor(value);
  await assert.rejects(
    verify(value, { ...plain, signInSupported: true }),
    error('sign_in_method_required'),
  );
  assert.throws(
    () => walletSignInMethod({ method: 'signMessage', signInSupported: true }),
    error('sign_in_method_required'),
  );
  assert.equal(
    walletSignInMethod({ method: 'signMessage', signInSupported: false }),
    'signMessage',
  );
  assert.equal(
    walletSignInMethod({ method: 'signIn', signInSupported: true }),
    'signIn',
  );
  for (const method of [
    {},
    { method: 'signIn' },
    { method: 'signIn', signInSupported: false },
    { method: 'signMessage' },
    { method: 'signMessage', signInSupported: 'true' },
    { method: 'signTransaction', signInSupported: false },
  ]) {
    const response = await responseFor(value);
    delete response.method;
    delete response.signInSupported;
    await assert.rejects(
      verify(value, { ...response, ...method }),
      error('unsupported_message_format'),
    );
  }
});

void test('wrong signing key, bit corruption, truncation and zero signatures fail', async () => {
  const value = challenge();
  const wrongKey = await responseFor(value, value.message, otherSigner);
  delete wrongKey.publicKeyBase64;
  await assert.rejects(verify(value, wrongKey), error('invalid_signature'));
  const response = await responseFor(value);
  const corrupted = Buffer.from(response.signatureBase64, 'base64');
  corrupted[17] ^= 1;
  for (const signature of [
    corrupted,
    corrupted.subarray(0, 63),
    new Uint8Array(64),
    new Uint8Array(65),
  ])
    await assert.rejects(
      verify(value, { ...response, signatureBase64: encode(signature) }),
      error('invalid_signature'),
    );
});

void test('binary fields require bounded canonical padded base64', async () => {
  const value = challenge();
  const response = await responseFor(value);
  for (const signatureBase64 of [
    '',
    '!',
    'A'.repeat(90_000),
    response.signatureBase64.slice(0, -1),
    `${response.signatureBase64}\n`,
    response.signatureBase64.slice(0, -3) + 'B==',
  ])
    await assert.rejects(
      verify(value, { ...response, signatureBase64 }),
      error('invalid_signature'),
    );
  await assert.rejects(
    verify(value, {
      ...response,
      signedMessageBase64: encode(new Uint8Array(2049)),
    }),
    error('invalid_signature'),
  );
  await assert.rejects(
    verify(value, { ...response, publicKeyBase64: encode(new Uint8Array(33)) }),
    error('invalid_signature'),
  );
});

void test('noncanonical signature scalar cannot authenticate', async () => {
  const value = challenge();
  const response = await responseFor(value);
  const signature = Buffer.from(response.signatureBase64, 'base64');
  let scalar = 0n;
  for (let index = 63; index >= 32; index--)
    scalar = (scalar << 8n) | BigInt(signature[index]);
  scalar += ed25519.Point.CURVE().n;
  for (let index = 32; index < 64; index++) {
    signature[index] = Number(scalar & 255n);
    scalar >>= 8n;
  }
  await assert.rejects(
    verify(value, { ...response, signatureBase64: encode(signature) }),
    error('invalid_signature'),
  );
});

void test('invalid, off-curve, small-order and noncanonical wallet encodings fail', () => {
  const identity = new Uint8Array(32);
  identity[0] = 1;
  const noncanonical = new Uint8Array(32).fill(255);
  noncanonical[0] = 237;
  noncanonical[31] = 127;
  const mixedOrder = ed25519.Point.BASE.add(
    ed25519.Point.fromBytes(new Uint8Array(32)),
  ).toBytes();
  for (const address of [
    '',
    '0'.repeat(32),
    '1'.repeat(31),
    '1'.repeat(33),
    'x'.repeat(45),
    ` ${signer.address}`,
    bs58.encode(new Uint8Array(32)),
    bs58.encode(identity),
    bs58.encode(noncanonical),
    bs58.encode(mixedOrder),
    bs58.encode(new Uint8Array(32).fill(255)),
  ]) {
    assert.throws(() => decodeWalletAddress(address), error('invalid_address'));
    assert.throws(() => challenge({ address }), error('invalid_address'));
  }
});

void test('trivial signatures for small-order keys are rejected before native verification', async () => {
  for (const firstByte of [0, 1]) {
    const publicKey = new Uint8Array(32);
    publicKey[0] = firstByte;
    const address = bs58.encode(publicKey);
    const value = challenge();
    value.message = value.message.replace(value.address, address);
    value.address = address;
    value.input.address = address;
    const signature = new Uint8Array(64);
    signature[0] = 1;
    await assert.rejects(
      verify(value, {
        challengeId: value.id,
        address,
        signedMessageBase64: encode(utf8(value.message)),
        signatureBase64: encode(signature),
        method: 'signMessage',
        signInSupported: false,
      }),
      error('invalid_address'),
    );
  }
});

void test('origin configuration requires one exact HTTPS origin, without credentials or paths', () => {
  assert.equal(canonicalOrigin(origin), origin);
  assert.equal(
    canonicalOrigin('https://conclave.example:8443'),
    'https://conclave.example:8443',
  );
  for (const invalid of [
    `${origin}/`,
    `${origin}/path`,
    `${origin}?query`,
    `${origin}#fragment`,
    'https://user:password@conclave.example',
    'https://CONCLAVE.example',
    'https://conclave.example:443',
    'http://conclave.example',
    'file:///tmp',
    'null',
    '',
  ])
    assert.throws(() => canonicalOrigin(invalid), error('invalid_origin'));
});

void test('insecure origins require explicit loopback development configuration', () => {
  for (const local of [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://[::1]:3000',
  ]) {
    assert.throws(() => canonicalOrigin(local), error('invalid_origin'));
    assert.equal(
      canonicalOrigin(local, { allowInsecureLocalhost: true }),
      local,
    );
  }
  for (const other of [
    'http://localhost.example',
    'http://192.168.1.1',
    'http://conclave.example',
  ])
    assert.throws(
      () => canonicalOrigin(other, { allowInsecureLocalhost: true }),
      error('invalid_origin'),
    );
});

void test('origin checks reject sibling domains and missing or multiple Origin values', () => {
  assertSameOrigin(origin, origin);
  for (const invalid of [
    null,
    'null',
    'https://sub.conclave.example',
    'https://conclave.example.evil',
    `${origin}:8443`,
    `${origin}, https://other.example`,
  ])
    assert.throws(
      () => assertSameOrigin(invalid, origin),
      error('invalid_origin'),
    );
});

void test('session tokens are distinct, canonical 256-bit values and purpose-separated hashes', async () => {
  const tokens = Array.from({ length: 64 }, generateSessionToken);
  assert.equal(new Set(tokens).size, tokens.length);
  for (const token of tokens) {
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    assert.equal(Buffer.from(token, 'base64url').toString('base64url'), token);
  }
  const hash = await hashToken(tokens[0]);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash, await hashToken(tokens[0]));
  assert.notEqual(hash, await hashToken(tokens[1]));
  assert.notEqual(hash, await hashToken(tokens[0], 'csrf'));
});

void test('malformed session tokens are rejected before hashing or cookie serialization', async () => {
  for (const token of [
    '',
    'x'.repeat(42),
    'x'.repeat(44),
    'A'.repeat(42) + 'B',
    'A'.repeat(41) + '\r\n',
    ' '.repeat(43),
  ]) {
    await assert.rejects(hashToken(token), error('invalid_token'));
    assert.throws(() => serializeSessionCookie(token), error('invalid_token'));
  }
});

void test('CSRF token must match the server session value exactly', () => {
  const token = generateSessionToken();
  assertCsrfToken(token, token);
  for (const invalid of [
    null,
    undefined,
    '',
    generateSessionToken(),
    `${token} `,
  ])
    assert.throws(() => assertCsrfToken(invalid, token), error('invalid_csrf'));
  assert.throws(() => assertCsrfToken(token, null), error('invalid_csrf'));
});

void test('session cookie is host-only, HttpOnly, Secure and has a bounded lifetime', () => {
  const token = generateSessionToken();
  assert.equal(
    serializeSessionCookie(token),
    `${SESSION_COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=86400`,
  );
  assert.equal(
    serializeSessionCookie(token, { maxAgeSeconds: 60 }).endsWith('Max-Age=60'),
    true,
  );
  assert.equal(serializeSessionCookie(token).includes('Domain='), false);
  for (const maxAgeSeconds of [0, -1, 2_592_001, Infinity, 1.5])
    assert.throws(
      () => serializeSessionCookie(token, { maxAgeSeconds }),
      error('invalid_cookie'),
    );
  assert.equal(
    serializeExpiredSessionCookie(),
    `${SESSION_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  );
});

void test('cookie parsing rejects ambiguity and invalid credential bytes', () => {
  const token = generateSessionToken();
  const cookie = `${SESSION_COOKIE_NAME}=${token}`;
  assert.equal(readSessionCookie(`theme=dark; ${cookie}; local=1`), token);
  assert.equal(readSessionCookie(null), null);
  assert.equal(readSessionCookie(''), null);
  assert.equal(readSessionCookie(`other_${cookie}`), null);
  assert.throws(
    () => readSessionCookie(`${cookie}; ${cookie}`),
    error('invalid_cookie'),
  );
  assert.throws(
    () => readSessionCookie('x'.repeat(16_385)),
    error('invalid_cookie'),
  );
  assert.throws(
    () => readSessionCookie(`${SESSION_COOKIE_NAME}=%41${token}`),
    error('invalid_token'),
  );
  assert.throws(
    () => readSessionCookie(`${cookie}\r\nInjected=value`),
    error('invalid_token'),
  );
});

void test('public errors disclose a stable code only', () => {
  try {
    challenge({ address: 'sensitive malformed account value' });
    assert.fail('expected rejection');
  } catch (failure) {
    assert.equal(failure.name, 'AuthError');
    assert.equal(failure.message, 'invalid_address');
    assert.equal(failure.code, 'invalid_address');
  }
});
