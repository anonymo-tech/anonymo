import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from '@simplewebauthn/server';
import {
  decodeAttestationObject,
  parseAuthenticatorData,
} from '@simplewebauthn/server/helpers';
import { serviceConfig } from '../core/config.ts';
import { ServiceError, requireCondition } from '../core/errors.ts';

export const passkeyAlgorithms = [-7, -8, -257];
const transports = new Set([
  'ble',
  'cable',
  'hybrid',
  'internal',
  'nfc',
  'smart-card',
  'usb',
]);
export function passkeyCapability(
  env: Record<string, string | undefined> = process.env,
) {
  const unavailable = {
    configured: false,
    reason: 'Passkey sign-in is not configured.',
    rpId: null,
  };
  if (env.CONCLAVE_PASSKEYS_ENABLED !== 'true') return unavailable;
  try {
    const config = serviceConfig(env);
    if (config.mode !== 'service' || !config.origin || !config.databaseUrl)
      return unavailable;
    const hostname = new URL(config.origin).hostname;
    if (
      hostname !== 'localhost' &&
      (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
        hostname,
      ) ||
        /^\d+(?:\.\d+){3}$/.test(hostname))
    )
      return unavailable;
    return {
      configured: true,
      reason: 'Passkeys use device verification for this workspace.',
      rpId: hostname,
    };
  } catch {
    return unavailable;
  }
}
export function proofRejected(): never {
  throw new ServiceError(
    401,
    'PASSKEY_PROOF_REJECTED',
    'The passkey could not be verified. Start a new passkey request.',
  );
}
export function passkeyBytes(
  value: unknown,
  maxBytes: number,
): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > Math.ceil((maxBytes * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    proofRejected();
  try {
    const standard = value.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(standard), (c) => c.charCodeAt(0));
    if (
      bytes.length > maxBytes ||
      btoa(String.fromCharCode(...bytes))
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_') !== value
    )
      proofRejected();
    return bytes;
  } catch {
    return proofRejected();
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    proofRejected();
  return value as Record<string, unknown>;
}
function clientData(
  value: unknown,
  type: string,
  challenge: string,
  origin: string,
) {
  const data = record(
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        passkeyBytes(value, 4096),
      ),
    ),
  );
  if (
    data.type !== type ||
    data.challenge !== challenge ||
    data.origin !== origin ||
    (Object.hasOwn(data, 'crossOrigin') && data.crossOrigin !== false) ||
    Object.hasOwn(data, 'topOrigin')
  )
    proofRejected();
}
function common(
  value: unknown,
  type: string,
  challenge: string,
  origin: string,
) {
  const credential = record(value),
    response = record(credential.response);
  passkeyBytes(credential.id, 1024);
  if (credential.id !== credential.rawId || credential.type !== 'public-key')
    proofRejected();
  const extensions = record(credential.clientExtensionResults);
  if (JSON.stringify(extensions).length > 2048) proofRejected();
  if (
    credential.authenticatorAttachment !== undefined &&
    (typeof credential.authenticatorAttachment !== 'string' ||
      !['platform', 'cross-platform'].includes(
        credential.authenticatorAttachment,
      ))
  )
    proofRejected();
  clientData(response.clientDataJSON, type, challenge, origin);
  return { credential, response };
}
export async function verifyPasskeyRegistration(
  value: unknown,
  expected: { challenge: string; origin: string; rpId: string },
) {
  try {
    const { credential, response } = common(
      value,
      'webauthn.create',
      expected.challenge,
      expected.origin,
    );
    const attestation = decodeAttestationObject(
      passkeyBytes(response.attestationObject, 16384),
    );
    if (
      attestation.get('fmt') !== 'none' ||
      attestation.get('attStmt').size !== 0
    )
      proofRejected();
    const parsed = parseAuthenticatorData(attestation.get('authData'));
    if (!parsed.flags.up || !parsed.flags.uv || !parsed.flags.at)
      proofRejected();
    if (
      response.transports !== undefined &&
      (!Array.isArray(response.transports) ||
        response.transports.length > 8 ||
        response.transports.some(
          (t) => typeof t !== 'string' || !transports.has(t),
        ) ||
        new Set(response.transports).size !== response.transports.length)
    )
      proofRejected();
    const result = await verifyRegistrationResponse({
      response: credential as unknown as RegistrationResponseJSON,
      expectedChallenge: expected.challenge,
      expectedOrigin: expected.origin,
      expectedRPID: expected.rpId,
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: passkeyAlgorithms,
    });
    if (
      !result.verified ||
      !result.registrationInfo ||
      result.registrationInfo.credential.id !== credential.id ||
      result.registrationInfo.fmt !== 'none'
    )
      proofRejected();
    passkeyBytes(result.registrationInfo.credential.id, 1024);
    requireCondition(
      result.registrationInfo.credential.publicKey.length <= 4096,
      401,
      'PASSKEY_PROOF_REJECTED',
      'The passkey could not be verified.',
    );
    return result.registrationInfo;
  } catch {
    return proofRejected();
  }
}
export async function verifyPasskeyAuthentication(
  value: unknown,
  expected: {
    challenge: string;
    origin: string;
    rpId: string;
    userHandle: string;
    requireUserHandle: boolean;
    deviceType: string;
    credential: WebAuthnCredential;
  },
) {
  try {
    const { credential, response } = common(
      value,
      'webauthn.get',
      expected.challenge,
      expected.origin,
    );
    if (credential.id !== expected.credential.id) proofRejected();
    if (response.userHandle === undefined || response.userHandle === null) {
      if (expected.requireUserHandle) proofRejected();
    } else {
      passkeyBytes(response.userHandle, 64);
      if (response.userHandle !== expected.userHandle) proofRejected();
    }
    const parsed = parseAuthenticatorData(
      passkeyBytes(response.authenticatorData, 4096),
    );
    passkeyBytes(response.signature, 4096);
    if (
      !parsed.flags.up ||
      !parsed.flags.uv ||
      (parsed.flags.be ? 'multiDevice' : 'singleDevice') !== expected.deviceType
    )
      proofRejected();
    const result = await verifyAuthenticationResponse({
      response: credential as unknown as AuthenticationResponseJSON,
      expectedChallenge: expected.challenge,
      expectedOrigin: expected.origin,
      expectedRPID: expected.rpId,
      credential: expected.credential,
      requireUserVerification: true,
    });
    if (
      !result.verified ||
      result.authenticationInfo.credentialID !== credential.id ||
      result.authenticationInfo.credentialDeviceType !== expected.deviceType
    )
      proofRejected();
    return result.authenticationInfo;
  } catch {
    return proofRejected();
  }
}
