import { ed25519 } from '@noble/curves/ed25519.js';
import {
  createWalletChallenge,
  decodeWalletAddress,
  type WalletAuthResponse,
  type WalletSignInInput,
} from './wallet.ts';
import { AuthError, decodeBase64, equalBytes } from './primitives.ts';
import { assertSameOrigin } from './http.ts';
import {
  parseSecurityAction,
  securityWalletMessage,
  securityWalletStatement,
  type SecurityAction,
} from '../../lib/auth/security.ts';

export type SecurityWalletChallenge = {
  id: string;
  purpose: 'reauthenticate' | 'link-wallet';
  accountId: string;
  action: SecurityAction;
  address: string;
  origin: string;
  input: WalletSignInInput;
  message: string;
  expiresAt: number;
};

export function createSecurityWalletChallenge(options: {
  address: string;
  origin: string;
  accountId: string;
  purpose: 'reauthenticate' | 'link-wallet';
  action: SecurityAction;
  now?: number;
  expiresAt?: number;
}): SecurityWalletChallenge {
  const now = options.now ?? Date.now();
  const base = createWalletChallenge({
    address: options.address,
    origin: options.origin,
    now,
    ttlSeconds: 120,
    allowInsecureLocalhost: true,
  });
  const action = parseSecurityAction(options.action);
  if (options.purpose === 'link-wallet' && action.target !== options.address)
    throw new AuthError('challenge_mismatch');
  const expiresAt = Math.min(
    base.expiresAt,
    options.expiresAt ?? base.expiresAt,
  );
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now)
    throw new AuthError('challenge_expired');
  const input = {
    ...base.input,
    expirationTime: new Date(expiresAt).toISOString(),
    statement: securityWalletStatement(
      options.purpose,
      options.accountId,
      action,
    ),
  };
  return {
    ...base,
    purpose: options.purpose,
    accountId: options.accountId,
    action,
    input,
    expiresAt,
    message: securityWalletMessage(input),
  };
}

export function verifySecurityWalletChallenge(options: {
  challenge: SecurityWalletChallenge;
  response: WalletAuthResponse;
  expectedOrigin: string;
  requestOrigin: string | null;
  now?: number;
}): void {
  const { challenge, response } = options;
  assertSameOrigin(options.requestOrigin, options.expectedOrigin, {
    allowInsecureLocalhost: true,
  });
  try {
    const input = challenge.input,
      now = options.now ?? Date.now();
    const issued = Date.parse(input.issuedAt),
      expiry = Date.parse(input.expirationTime);
    const action = parseSecurityAction(challenge.action);
    if (
      !['reauthenticate', 'link-wallet'].includes(challenge.purpose) ||
      challenge.origin !== options.expectedOrigin ||
      input.domain !== new URL(options.expectedOrigin).host ||
      input.uri !== `${options.expectedOrigin}/` ||
      input.address !== challenge.address ||
      input.version !== '1' ||
      !/^[a-f0-9]{32}$/.test(input.nonce) ||
      input.requestId !== challenge.id ||
      input.statement !==
        securityWalletStatement(
          challenge.purpose,
          challenge.accountId,
          action,
        ) ||
      challenge.message !== securityWalletMessage(input) ||
      !Number.isSafeInteger(issued) ||
      !Number.isSafeInteger(expiry) ||
      new Date(issued).toISOString() !== input.issuedAt ||
      new Date(expiry).toISOString() !== input.expirationTime ||
      expiry !== challenge.expiresAt ||
      expiry <= now ||
      issued > now + 30_000 ||
      expiry <= issued ||
      expiry - issued > 120_000 ||
      (challenge.purpose === 'link-wallet' &&
        action.target !== challenge.address) ||
      response.challengeId !== challenge.id ||
      response.address !== challenge.address ||
      response.signedMessageFormat !== undefined ||
      response.signatureType !== 'ed25519'
    )
      throw new Error();
    const publicKey = decodeWalletAddress(challenge.address);
    if (
      response.publicKeyBase64 !== undefined &&
      !equalBytes(decodeBase64(response.publicKeyBase64, 32), publicKey)
    )
      throw new Error();
    const message = decodeBase64(response.signedMessageBase64, 2048);
    if (!equalBytes(message, new TextEncoder().encode(challenge.message)))
      throw new Error();
    const signature = decodeBase64(response.signatureBase64, 64);
    if (
      signature.length !== 64 ||
      !ed25519.verify(signature, message, publicKey, { zip215: false })
    )
      throw new Error();
  } catch {
    throw new AuthError('invalid_signature');
  }
}
