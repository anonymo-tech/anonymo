import { AuthError, assertToken, equalBytes } from './primitives.ts';

export type OriginOptions = { allowInsecureLocalhost?: boolean };

export function canonicalOrigin(
  origin: string,
  options: OriginOptions = {},
): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new AuthError('invalid_origin');
  }
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    origin !== url.origin ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(
        options.allowInsecureLocalhost &&
        isLoopback &&
        url.protocol === 'http:'
      ))
  )
    throw new AuthError('invalid_origin');
  return url.origin;
}

/** Apply to every cookie-authenticated state-changing request, including login. */
export function assertSameOrigin(
  requestOrigin: string | null,
  expectedOrigin: string,
  options: OriginOptions = {},
): void {
  const expected = canonicalOrigin(expectedOrigin, options);
  if (requestOrigin !== expected) throw new AuthError('invalid_origin');
}

/** The expected token must belong to the authenticated session, not a request cookie. */
export function assertCsrfToken(provided: unknown, expected: unknown): void {
  try {
    assertToken(provided);
    assertToken(expected);
    const encode = new TextEncoder();
    if (!equalBytes(encode.encode(provided), encode.encode(expected)))
      throw new AuthError('invalid_csrf');
  } catch {
    throw new AuthError('invalid_csrf');
  }
}

export const SESSION_COOKIE_NAME = '__Host-conclave_session';

export function serializeSessionCookie(
  token: string,
  options: { maxAgeSeconds?: number } = {},
): string {
  assertToken(token);
  const maxAge = options.maxAgeSeconds ?? 86_400;
  if (!Number.isSafeInteger(maxAge) || maxAge < 1 || maxAge > 2_592_000)
    throw new AuthError('invalid_cookie');
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function serializeExpiredSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export function readSessionCookie(header: string | null): string | null {
  if (!header) return null;
  if (header.length > 16_384) throw new AuthError('invalid_cookie');
  const matches = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!matches.length) return null;
  if (matches.length !== 1) throw new AuthError('invalid_cookie');
  const token = matches[0].slice(SESSION_COOKIE_NAME.length + 1);
  assertToken(token);
  return token;
}
