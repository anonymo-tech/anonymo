import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  canonicalOrigin,
  assertSameOrigin,
  type OriginOptions,
} from './http.ts';
import {
  AuthError,
  decodeBase64,
  equalBytes,
  randomBytes,
} from './primitives.ts';

const STATEMENT =
  'Sign in to Conclave. This does not authorize a transaction or payment.';
const MAX_CHALLENGE_MS = 600_000;
const CLOCK_SKEW_MS = 30_000;

export type WalletSignInInput = {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: '1';
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  requestId: string;
};

export type WalletChallenge = {
  id: string;
  purpose: 'sign-in';
  address: string;
  origin: string;
  input: WalletSignInInput;
  message: string;
  expiresAt: number;
};

/**
 * `signIn` is the Wallet Standard `solana:signIn` feature: the wallet builds the
 * SIWS text from the challenge input and checks the domain against the page that
 * asked. `signMessage` signs the server's exact text with no wallet-side domain
 * check, so it is only a fallback for wallets that do not offer `signIn`.
 */
export type WalletSignInMethod = 'signIn' | 'signMessage';

export type WalletAuthResponse = {
  challengeId: string;
  address: string;
  signatureBase64: string;
  signedMessageBase64: string;
  publicKeyBase64?: string;
  signatureType?: string;
  signedMessageFormat?: { kind: string; messageVersion?: number };
  method?: WalletSignInMethod;
  signInSupported?: boolean;
};

/** Fields of a SIWS message in ABNF order, as Sign In With Solana defines them. */
export type SignInMessageFields = {
  domain: string;
  address: string;
  statement?: string;
  uri?: string;
  version?: string;
  chainId?: string;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources?: string[];
};

/** Only canonical, nonidentity, prime-order Ed25519 signing keys can authenticate. */
export function decodeWalletAddress(address: string): Uint8Array<ArrayBuffer> {
  if (
    typeof address !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
  )
    throw new AuthError('invalid_address');
  try {
    const bytes = new Uint8Array(bs58.decode(address));
    if (bytes.length !== 32 || bs58.encode(bytes) !== address)
      throw new AuthError('invalid_address');
    const point = ed25519.Point.fromBytes(bytes, false);
    if (point.isSmallOrder() || !point.isTorsionFree())
      throw new AuthError('invalid_address');
    return bytes;
  } catch {
    throw new AuthError('invalid_address');
  }
}

// Same bytes as the SIWS reference `createSignInMessageText` for this input, so a
// wallet's `solana:signIn` output and the `signMessage` fallback sign one text.
function messageFor(input: WalletSignInInput): string {
  return `${input.domain} wants you to sign in with your Solana account:\n${input.address}\n\n${input.statement}\n\nURI: ${input.uri}\nVersion: ${input.version}\nNonce: ${input.nonce}\nIssued At: ${input.issuedAt}\nExpiration Time: ${input.expirationTime}\nRequest ID: ${input.requestId}`;
}

const HEADER = / wants you to sign in with your Solana account:$/;
const FIELD_LABELS = [
  ['uri', 'URI'],
  ['version', 'Version'],
  ['chainId', 'Chain ID'],
  ['nonce', 'Nonce'],
  ['issuedAt', 'Issued At'],
  ['expirationTime', 'Expiration Time'],
  ['notBefore', 'Not Before'],
  ['requestId', 'Request ID'],
] as const;

function fieldLine(line: string) {
  for (const [key, label] of FIELD_LABELS)
    if (line.startsWith(`${label}: `))
      return { key, value: line.slice(label.length + 2) };
  return null;
}
function cleanValue(value: string) {
  return value.length > 0 && value.trim() === value;
}

/**
 * Strict SIWS text parser. It accepts only the canonical layout (LF line breaks,
 * fields once each and in ABNF order, no blank or trailing lines, no padding)
 * and returns null for anything else. Callers still compare every field.
 */
export function parseSignInMessage(text: string): SignInMessageFields | null {
  if (
    typeof text !== 'string' ||
    text.length > 2048 ||
    // Only LF separates lines; CR, tabs and other control bytes never appear.
    Array.from(text).some((character) => {
      const code = character.charCodeAt(0);
      return (code < 0x20 && code !== 0x0a) || code === 0x7f;
    })
  )
    return null;
  const lines = text.split('\n');
  const header = lines[0] ?? '';
  if (!HEADER.test(header)) return null;
  const domain = header.replace(HEADER, '');
  const address = lines[1];
  if (!domain || /\s/.test(domain) || !address || !cleanValue(address))
    return null;
  const parsed: SignInMessageFields = { domain, address };
  let index = 2;
  if (index === lines.length) return parsed;
  if (lines[index] !== '' || index + 1 >= lines.length) return null;
  index++;
  const first = lines[index];
  if (!fieldLine(first) && first !== 'Resources:') {
    if (!cleanValue(first)) return null;
    parsed.statement = first;
    index++;
    if (index === lines.length) return parsed;
    if (lines[index] !== '' || index + 1 >= lines.length) return null;
    index++;
  }
  let order = 0;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (line === 'Resources:') {
      const resources = lines.slice(index + 1);
      if (
        !resources.length ||
        resources.some(
          (resource) =>
            !resource.startsWith('- ') || !cleanValue(resource.slice(2)),
        )
      )
        return null;
      parsed.resources = resources.map((resource) => resource.slice(2));
      return parsed;
    }
    const field = fieldLine(line);
    if (!field || !cleanValue(field.value)) return null;
    const position = FIELD_LABELS.findIndex(([key]) => key === field.key);
    if (position < order) return null;
    order = position + 1;
    parsed[field.key] = field.value;
  }
  return parsed;
}

function signInMessageText(fields: SignInMessageFields): string {
  let text = `${fields.domain} wants you to sign in with your Solana account:\n${fields.address}`;
  if (fields.statement !== undefined) text += `\n\n${fields.statement}`;
  const lines: string[] = [];
  for (const [key, label] of FIELD_LABELS)
    if (fields[key] !== undefined) lines.push(`${label}: ${fields[key]}`);
  if (fields.resources !== undefined)
    lines.push('Resources:', ...fields.resources.map((value) => `- ${value}`));
  if (lines.length) text += `\n\n${lines.join('\n')}`;
  return text;
}

/**
 * `solana:signIn` returns the text the wallet actually signed. Every SIWS field
 * must equal the stored challenge, fields the challenge did not request (Chain
 * ID, Not Before, Resources) must be absent, and the text must re-serialize to
 * the same bytes, so no unparsed content can ride along with the signature.
 */
function assertSignInMessage(message: Uint8Array, input: WalletSignInInput) {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      message,
    );
  } catch {
    throw new AuthError('challenge_mismatch');
  }
  const parsed = parseSignInMessage(text);
  if (!parsed || signInMessageText(parsed) !== text)
    throw new AuthError('challenge_mismatch');
  const expected: SignInMessageFields = {
    domain: input.domain,
    address: input.address,
    statement: input.statement,
    uri: input.uri,
    version: input.version,
    nonce: input.nonce,
    issuedAt: input.issuedAt,
    expirationTime: input.expirationTime,
    requestId: input.requestId,
  };
  const keys = new Set([...Object.keys(expected), ...Object.keys(parsed)]);
  for (const key of keys) {
    const field = key as keyof SignInMessageFields;
    if (parsed[field] !== expected[field])
      throw new AuthError('challenge_mismatch');
  }
}

/**
 * A wallet that offers `solana:signIn` must use it; the exact-text fallback is
 * accepted only when the client reports the wallet has no `signIn` feature.
 * The report comes from the client, so this keeps the product on the
 * domain-checked path; it cannot stop a caller that lies about support.
 */
export function walletSignInMethod(
  response: Pick<WalletAuthResponse, 'method' | 'signInSupported'>,
): WalletSignInMethod {
  if (
    (response.method !== 'signIn' && response.method !== 'signMessage') ||
    typeof response.signInSupported !== 'boolean' ||
    (response.method === 'signIn' && !response.signInSupported)
  )
    throw new AuthError('unsupported_message_format');
  if (response.method === 'signMessage' && response.signInSupported)
    throw new AuthError('sign_in_method_required');
  return response.method;
}

function validTime(time: number): boolean {
  return (
    Number.isSafeInteger(time) &&
    time >= 0 &&
    time <= 8_640_000_000_000_000 - MAX_CHALLENGE_MS
  );
}

export function createWalletChallenge(
  options: {
    address: string;
    origin: string;
    now?: number;
    ttlSeconds?: number;
  } & OriginOptions,
): WalletChallenge {
  const origin = canonicalOrigin(options.origin, options);
  decodeWalletAddress(options.address);
  const now = options.now ?? Date.now();
  const ttl = (options.ttlSeconds ?? 300) * 1000;
  if (
    !validTime(now) ||
    !Number.isSafeInteger(ttl) ||
    ttl < 1000 ||
    ttl > MAX_CHALLENGE_MS
  )
    throw new AuthError('invalid_challenge');
  const id = crypto.randomUUID();
  const nonce = Array.from(randomBytes(16), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const input: WalletSignInInput = {
    domain: new URL(origin).host,
    address: options.address,
    statement: STATEMENT,
    uri: `${origin}/`,
    version: '1',
    nonce,
    issuedAt: new Date(now).toISOString(),
    expirationTime: new Date(now + ttl).toISOString(),
    requestId: id,
  };
  return {
    id,
    purpose: 'sign-in',
    address: options.address,
    origin,
    input,
    message: messageFor(input),
    expiresAt: now + ttl,
  };
}

/**
 * Verifies proof only. The caller must reload/check unused + expiry and consume
 * this challenge atomically with session creation. Reusing a stale DB snapshot
 * is not replay protection, even if this function has already returned once.
 */
export async function verifyWalletChallenge(
  options: {
    challenge: WalletChallenge;
    response: WalletAuthResponse;
    expectedOrigin: string;
    requestOrigin: string | null;
    now?: number;
    consumedAt?: number | string | Date | null;
  } & OriginOptions,
): Promise<{
  challengeId: string;
  address: string;
  method: WalletSignInMethod;
}> {
  const { challenge, response } = options;
  assertSameOrigin(options.requestOrigin, options.expectedOrigin, options);
  if (options.consumedAt !== undefined && options.consumedAt !== null)
    throw new AuthError('challenge_used');
  if (!challenge || !response || !challenge.input)
    throw new AuthError('invalid_challenge');
  const now = options.now ?? Date.now();
  const input = challenge.input;
  const issued = Date.parse(input.issuedAt);
  const expiry = Date.parse(input.expirationTime);
  if (
    !validTime(now) ||
    !validTime(issued) ||
    !validTime(expiry) ||
    new Date(issued).toISOString() !== input.issuedAt ||
    new Date(expiry).toISOString() !== input.expirationTime ||
    expiry !== challenge.expiresAt ||
    expiry <= issued ||
    expiry - issued > MAX_CHALLENGE_MS ||
    issued > now + CLOCK_SKEW_MS ||
    challenge.purpose !== 'sign-in' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      challenge.id,
    ) ||
    !/^[a-f0-9]{32}$/.test(input.nonce) ||
    input.requestId !== challenge.id ||
    challenge.origin !== options.expectedOrigin ||
    input.domain !== new URL(options.expectedOrigin).host ||
    input.uri !== `${options.expectedOrigin}/` ||
    input.address !== challenge.address ||
    input.statement !== STATEMENT ||
    input.version !== '1' ||
    challenge.message !== messageFor(input)
  )
    throw new AuthError('invalid_challenge');
  if (expiry <= now) throw new AuthError('challenge_expired');
  if (
    response.challengeId !== challenge.id ||
    response.address !== challenge.address
  )
    throw new AuthError('challenge_mismatch');
  const method = walletSignInMethod(response);
  // OCMS envelopes require a different verifier. Never unwrap or treat them as plain SIWS.
  if (
    response.signedMessageFormat !== undefined ||
    (response.signatureType !== undefined &&
      response.signatureType !== 'ed25519')
  )
    throw new AuthError('unsupported_message_format');
  const publicKey = decodeWalletAddress(challenge.address);
  if (
    response.publicKeyBase64 !== undefined &&
    !equalBytes(decodeBase64(response.publicKeyBase64, 32), publicKey)
  )
    throw new AuthError('challenge_mismatch');
  const expected = new TextEncoder().encode(challenge.message);
  const message = decodeBase64(response.signedMessageBase64, 2048);
  // signIn: the wallet-built text is parsed and every field compared.
  // signMessage: the wallet must have signed the server's exact bytes.
  if (method === 'signIn') assertSignInMessage(message, input);
  if (!equalBytes(message, expected)) throw new AuthError('challenge_mismatch');
  const signature = decodeBase64(response.signatureBase64, 64);
  if (signature.length !== 64) throw new AuthError('invalid_signature');
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      publicKey,
      'Ed25519',
      false,
      ['verify'],
    );
    if (!(await crypto.subtle.verify('Ed25519', key, signature, message)))
      throw new AuthError('invalid_signature');
  } catch {
    throw new AuthError('invalid_signature');
  }
  return { challengeId: challenge.id, address: challenge.address, method };
}
