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
