import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { passkeyRoutes } from '../../server/routes/passkeys.ts';
import { handleApi } from '../../server/core/http.ts';

const encode = (value) => Buffer.from(value).toString('base64url');
const hash = (value) => createHash('sha256').update(value).digest();
export const passkeyOrigin = 'https://passkeys.example';
/** Synthetic cryptographic authenticator; never invokes a device or network. */
export function syntheticPasskey({
  algorithm = 'Ed25519',
  backupEligible = false,
  backedUp = false,
} = {}) {
  const pair =
    algorithm === 'ES256'
      ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      : algorithm === 'RS256'
        ? generateKeyPairSync('rsa', { modulusLength: 2048 })
        : generateKeyPairSync('ed25519');
  const jwk = pair.publicKey.export({ format: 'jwk' }),
    id = encode(randomBytes(32));
  const cose =
    algorithm === 'ES256'
      ? new Map([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x, 'base64url')],
          [-3, Buffer.from(jwk.y, 'base64url')],
        ])
      : algorithm === 'RS256'
        ? new Map([
            [1, 3],
            [3, -257],
            [-1, Buffer.from(jwk.n, 'base64url')],
            [-2, Buffer.from(jwk.e, 'base64url')],
          ])
        : new Map([
            [1, 1],
            [3, -8],
            [-1, 6],
            [-2, Buffer.from(jwk.x, 'base64url')],
          ]);
  let userHandle = null;
  function data(options, registration, overrides = {}) {
    const raw = Buffer.from(
      JSON.stringify({
        type: registration ? 'webauthn.create' : 'webauthn.get',
        challenge: options.challenge,
        origin: passkeyOrigin,
        crossOrigin: false,
        ...overrides.clientData,
      }),
    );
    const flags =
      overrides.flags ??
      5 |
        (registration ? 64 : 0) |
        (backupEligible ? 8 : 0) |
        (backedUp ? 16 : 0);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(overrides.counter ?? 0);
    const authData = Buffer.concat([
      hash(overrides.rpId ?? options.rp?.id ?? options.rpId),
      Buffer.from([flags]),
      counter,
    ]);
    return { raw, authData };
  }
  return {
    id,
    get userHandle() {
      return userHandle;
    },
    publicKey: isoCBOR.encode(cose),
    registration(options, overrides = {}) {
      userHandle = options.user.id;
      const { raw, authData } = data(options, true, overrides),
        credentialId = Buffer.from(overrides.attestedId ?? id, 'base64url'),
        length = Buffer.alloc(2);
      length.writeUInt16BE(credentialId.length);
      const attested = Buffer.concat([
        authData,
        Buffer.alloc(16),
        length,
        credentialId,
        isoCBOR.encode(cose),
      ]);
      const attestation = isoCBOR.encode(
        new Map([
          ['fmt', overrides.fmt ?? 'none'],
          ['attStmt', new Map()],
          ['authData', attested],
        ]),
      );
      return {
        id,
        rawId: id,
        type: 'public-key',
        clientExtensionResults: { credProps: { rk: true } },
        response: {
          clientDataJSON: encode(raw),
          attestationObject: encode(attestation),
          transports: ['internal'],
        },
      };
    },
    authentication(options, overrides = {}) {
      const { raw, authData } = data(options, false, overrides),
        signature = sign(
          algorithm === 'Ed25519' ? null : 'sha256',
          Buffer.concat([authData, hash(raw)]),
          pair.privateKey,
        );
      return {
        id,
        rawId: id,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: encode(raw),
          authenticatorData: encode(authData),
          signature: encode(signature),
          userHandle:
            overrides.userHandle === undefined
              ? userHandle
              : overrides.userHandle,
        },
      };
    },
  };
}
export function configurePasskeys(databaseUrl) {
  process.env.CONCLAVE_MODE = 'service';
  process.env.CONCLAVE_APP_ORIGIN = passkeyOrigin;
  process.env.CONCLAVE_DATABASE_URL = databaseUrl;
  process.env.CONCLAVE_PASSKEYS_ENABLED = 'true';
}
export function passkeyClient(pool, { cookies = {}, accountId = null } = {}) {
  const jar = { ...cookies };
  const client = {
    jar,
    accountId,
    cookieHeader() {
      return Object.entries(jar)
        .map(([key, value]) => `${key}=${value}`)
        .join('; ');
    },
    async post(path, body, overrides = {}) {
      const headers = {
        'content-type': 'application/json',
        origin: passkeyOrigin,
        cookie: client.cookieHeader(),
        ...(client.accountId
          ? { 'x-conclave-account-id': client.accountId }
          : {}),
        ...overrides.headers,
      };
      const request = new Request(`${passkeyOrigin}/api/${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: overrides.signal,
      });
      const response = await handleApi(
        async () =>
          (await passkeyRoutes(pool, request, path, passkeyOrigin)) ??
          new Response(null, { status: 404 }),
      );
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';'),
          index = pair.indexOf('=');
        jar[pair.slice(0, index)] = pair.slice(index + 1);
      }
      return { status: response.status, body: await response.json(), response };
    },
    async options(purpose, body = {}) {
      return client.post(`auth/passkeys/${purpose}/options`, body);
    },
    async verify(purpose, challengeId, credential) {
      return client.post(`auth/passkeys/${purpose}/verify`, {
        challengeId,
        credential,
      });
    },
  };
  return client;
}
export async function signedUpPasskey(pool, options = {}) {
  const client = passkeyClient(pool),
    device = syntheticPasskey(options),
    challenge = await client.options('signup');
  if (challenge.status !== 201)
    throw new Error('Synthetic signup options failed.');
  const result = await client.verify(
    'signup',
    challenge.body.challengeId,
    device.registration(challenge.body.options),
  );
  if (result.status !== 200)
    throw new Error(`Synthetic signup failed: ${result.body.error?.code}.`);
  client.accountId = result.body.accountId;
  return {
    client,
    device,
    accountId: client.accountId,
    challenge: challenge.body,
  };
}
