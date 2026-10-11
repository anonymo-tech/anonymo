export type AuthErrorCode =
  | 'invalid_origin'
  | 'invalid_address'
  | 'invalid_challenge'
  | 'challenge_expired'
  | 'challenge_used'
  | 'challenge_mismatch'
  | 'unsupported_message_format'
  | 'sign_in_method_required'
  | 'invalid_signature'
  | 'invalid_token'
  | 'invalid_csrf'
  | 'invalid_cookie';

/** Safe error codes never include submitted identity or credential material. */
export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode) {
    super(code);
    this.name = 'AuthError';
    this.code = code;
  }
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(length) || length < 16 || length > 64)
    throw new AuthError('invalid_token');
  return crypto.getRandomValues(new Uint8Array(length));
}

export function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export function decodeBase64(
  value: unknown,
  maxBytes: number,
): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > Math.ceil(maxBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new AuthError('invalid_signature');
  try {
    const decoded = atob(value);
    if (decoded.length > maxBytes || btoa(decoded) !== value)
      throw new AuthError('invalid_signature');
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    throw new AuthError('invalid_signature');
  }
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++)
    difference |= left[index] ^ right[index];
  return difference === 0;
}

export function generateSessionToken(): string {
  return encodeBase64(randomBytes(32))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export function assertToken(token: unknown): asserts token is string {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new AuthError('invalid_token');
  try {
    const bytes = decodeBase64(
      token.replaceAll('-', '+').replaceAll('_', '/') + '=',
      32,
    );
    if (bytes.length !== 32) throw new AuthError('invalid_token');
  } catch {
    throw new AuthError('invalid_token');
  }
}

export async function hashToken(
  token: string,
  purpose: 'session' | 'csrf' = 'session',
): Promise<string> {
  assertToken(token);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`conclave:${purpose}:v1:${token}`),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
