import bs58 from 'bs58';
import {
  parseSecurityAction,
  securityWalletMessage,
  securityWalletStatement,
  type SecurityAction,
} from '../auth/security.ts';
import type { WalletChallenge, WalletProof } from './service.ts';

export type { SecurityAction };
export type SecurityOptions = {
  accountId?: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
};
export type SecurityIdentity = {
  id: string;
  kind: 'solana' | 'passkey';
  subject: string;
  createdAt: string;
};
export type SecuritySession = {
  id: string;
  createdAt: string;
  expiresAt: string;
  current: boolean;
};
export type SecurityOverview = {
  accountId: string;
  identities: SecurityIdentity[];
  sessions: SecuritySession[];
  moreSessions: boolean;
};
export type SecurityGrant = {
  grantToken: string;
  expiresAt: number;
  action: SecurityAction;
  accountId: string;
};
export type SecurityWalletChallenge = Omit<WalletChallenge, 'purpose'> & {
  purpose: 'reauthenticate' | 'link-wallet';
  accountId: string;
  action: SecurityAction;
};
export class AccountSecurityError extends Error {
  readonly code: string;
  readonly status: number;
  readonly outcomeUnknown: boolean;
  constructor(
    code: string,
    message: string,
    status = 0,
    outcomeUnknown = false,
  ) {
    super(message);
    this.name = 'AccountSecurityError';
    this.code = code;
    this.status = status;
    this.outcomeUnknown = outcomeUnknown;
  }
}
export function securityErrorMessage(error: unknown) {
  return error instanceof AccountSecurityError
    ? error.message
    : 'Account security could not be checked. Refresh the saved account status before continuing.';
}
export function invalidSecurityResponse(): never {
  throw new AccountSecurityError(
    'INVALID_RESPONSE',
    'The account response could not be verified. Refresh the saved account status before continuing.',
  );
}
export const securityRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : invalidSecurityResponse();
export function securityId(v: unknown): string {
  if (
    typeof v !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      v,
    )
  )
    return invalidSecurityResponse();
  return v;
}
export function securityTimestamp(v: unknown): string {
  if (
    typeof v !== 'string' ||
    v.length > 30 ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(Date.parse(v)).toISOString() !== v
  )
    return invalidSecurityResponse();
  return v;
}
export function securityExpiry(
  v: unknown,
  now = Date.now(),
  maxMs = 300_000,
): number {
  const expiry = typeof v === 'string' ? Date.parse(securityTimestamp(v)) : v;
  if (
    typeof expiry !== 'number' ||
    !Number.isSafeInteger(expiry) ||
    expiry <= now ||
    expiry > now + maxMs + 30_000
  )
    return invalidSecurityResponse();
  return expiry;
}
export function securityAddress(v: unknown): string {
  if (typeof v !== 'string' || v.length > 44) return invalidSecurityResponse();
  try {
    const decoded = bs58.decode(v);
    if (decoded.length !== 32 || bs58.encode(decoded) !== v)
      return invalidSecurityResponse();
  } catch {
    return invalidSecurityResponse();
  }
  return v;
}
export function sameSecurityAction(a: SecurityAction, b: SecurityAction) {
  return a.kind === b.kind && a.target === b.target;
}
function checkedAction(v: unknown): SecurityAction {
  try {
    return parseSecurityAction(v);
  } catch {
    return invalidSecurityResponse();
  }
}
function boolean(v: unknown) {
  return typeof v === 'boolean' ? v : invalidSecurityResponse();
}
export function parseSecurityOverview(
  value: unknown,
  owner: string,
): SecurityOverview {
  const v = securityRecord(value);
  if (
    securityId(v.accountId) !== securityId(owner) ||
    !Array.isArray(v.identities) ||
    v.identities.length < 1 ||
    v.identities.length > 64 ||
    !Array.isArray(v.sessions) ||
    v.sessions.length > 100
  )
    return invalidSecurityResponse();
  const identities = v.identities.map((item) => {
    const row = securityRecord(item);
    if (row.kind !== 'solana' && row.kind !== 'passkey')
      return invalidSecurityResponse();
    const subject =
      row.kind === 'solana'
        ? securityAddress(row.subject)
        : typeof row.subject === 'string' &&
            /^[A-Za-z0-9_-]{1,2048}$/.test(row.subject)
          ? row.subject
          : invalidSecurityResponse();
    return {
      id: securityId(row.id),
      kind: row.kind,
      subject,
      createdAt: securityTimestamp(row.createdAt),
    } as SecurityIdentity;
  });
  const sessions = v.sessions.map((item) => {
    const row = securityRecord(item);
    const createdAt = securityTimestamp(row.createdAt),
      expiresAt = securityTimestamp(row.expiresAt);
    if (Date.parse(expiresAt) <= Date.parse(createdAt))
      return invalidSecurityResponse();
    return {
      id: securityId(row.id),
      createdAt,
      expiresAt,
      current: boolean(row.current),
    };
  });
  if (
    new Set(identities.map((v) => v.id)).size !== identities.length ||
    new Set(sessions.map((v) => v.id)).size !== sessions.length ||
    sessions.filter((v) => v.current).length > 1
  )
    return invalidSecurityResponse();
  return {
    accountId: owner,
    identities,
    sessions,
    moreSessions: boolean(v.moreSessions),
  };
}
export function parseSecurityGrant(
  value: unknown,
  owner: string,
  action: SecurityAction,
  now = Date.now(),
): SecurityGrant {
  const v = securityRecord(value),
    parsed = checkedAction(v.action);
  if (
    !sameSecurityAction(parsed, action) ||
    (v.accountId !== undefined && securityId(v.accountId) !== owner) ||
    typeof v.grantToken !== 'string' ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(v.grantToken)
  )
    return invalidSecurityResponse();
  return {
    accountId: securityId(owner),
    action: parsed,
    grantToken: v.grantToken,
    expiresAt: securityExpiry(securityTimestamp(v.expiresAt), now, 120_000),
  };
}
export function validateSecurityWalletChallenge(
  value: unknown,
  expected: {
    accountId: string;
    action: SecurityAction;
    address: string;
    purpose: 'reauthenticate' | 'link-wallet';
    origin: string;
  },
  now = Date.now(),
): SecurityWalletChallenge {
  const v = securityRecord(value),
    input = securityRecord(v.input),
    action = checkedAction(v.action);
  const issuedAt = securityTimestamp(input.issuedAt),
    expirationTime = securityTimestamp(input.expirationTime);
  if (
    securityId(v.accountId) !== expected.accountId ||
    v.purpose !== expected.purpose ||
    !sameSecurityAction(action, expected.action) ||
    securityAddress(v.address) !== expected.address ||
    v.origin !== expected.origin ||
    input.domain !== new URL(expected.origin).host ||
    input.uri !== `${expected.origin}/` ||
    input.address !== expected.address ||
    input.version !== '1' ||
    typeof input.nonce !== 'string' ||
    !/^[a-f0-9]{32}$/.test(input.nonce) ||
    input.requestId !== securityId(v.id) ||
    input.statement !==
      securityWalletStatement(expected.purpose, expected.accountId, action) ||
    Date.parse(issuedAt) > now + 30_000 ||
    Date.parse(expirationTime) <= Date.parse(issuedAt) ||
    Date.parse(expirationTime) - Date.parse(issuedAt) > 120_000 ||
    securityExpiry(v.expiresAt, now, 120_000) !== Date.parse(expirationTime) ||
    (expected.purpose === 'link-wallet' && action.target !== expected.address)
  )
    return invalidSecurityResponse();
  const parsedInput = input as WalletChallenge['input'];
  if (v.message !== securityWalletMessage(parsedInput))
    return invalidSecurityResponse();
  return {
    id: securityId(v.id),
    purpose: expected.purpose,
    accountId: expected.accountId,
    action,
    address: expected.address,
    origin: expected.origin,
    input: parsedInput,
    message: v.message as string,
    expiresAt: Date.parse(expirationTime),
  };
}
const userMessages: Record<string, string> = {
  AUTHENTICATION_REQUIRED:
    'Your session changed or expired. Refresh account status to sign in again.',
  ACCOUNT_MISMATCH:
    'Your account changed. Refresh account status before continuing.',
  LAST_IDENTITY: 'Keep at least one sign-in identity on this account.',
  REAUTHENTICATION_REQUIRED:
    'Confirm this action again with an existing sign-in identity.',
  PASSKEY_UNAVAILABLE: 'Passkey sign-in is not configured for this service.',
};
export function createSecurityRequest(options: SecurityOptions = {}) {
  const accountId =
    options.accountId === undefined ? undefined : securityId(options.accountId);
  return async function request(
    path: string,
    body?: unknown,
    mutation = false,
  ): Promise<unknown> {
    if (!/^\/api\/(?:auth\/[a-z0-9/-]+|capabilities)$/.test(path))
      return invalidSecurityResponse();
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (
      encoded !== undefined &&
      new TextEncoder().encode(encoded).length > 262_144
    )
      return invalidSecurityResponse();
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, 30_000);
    let dispatched = false;
    try {
      controller.signal.throwIfAborted();
      dispatched = true;
      const response = await (options.fetch ?? fetch)(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Accept: 'application/json',
          ...(encoded === undefined
            ? {}
            : { 'Content-Type': 'application/json' }),
          ...(accountId ? { 'X-Conclave-Account-Id': accountId } : {}),
        },
        body: encoded,
        credentials: 'same-origin',
        mode: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      });
      if (
        response.headers
          .get('content-type')
          ?.split(';')[0]
          .trim()
          .toLowerCase() !== 'application/json'
      )
        return invalidSecurityResponse();
      const reader = response.body?.getReader();
      if (!reader) return invalidSecurityResponse();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let size = 0,
        raw = '';
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 131_072) {
            await reader.cancel();
            return invalidSecurityResponse();
          }
          raw += decoder.decode(part.value, { stream: true });
        }
        raw += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      controller.signal.throwIfAborted();
      const value = JSON.parse(raw) as unknown;
      if (!response.ok) {
        const error = securityRecord(securityRecord(value).error);
        const code =
          typeof error.code === 'string' && /^[A-Za-z_]{1,80}$/.test(error.code)
            ? error.code.toUpperCase()
            : 'REQUEST_FAILED';
        throw new AccountSecurityError(
          code,
          userMessages[code] ??
            'The account action was not confirmed. Refresh saved account status before trying again.',
          response.status,
          mutation && response.status >= 500,
        );
      }
      return value;
    } catch (error) {
      if (options.signal?.aborted)
        throw new DOMException('Account action cancelled.', 'AbortError');
      if (error instanceof AccountSecurityError && error.status) throw error;
      throw new AccountSecurityError(
        'UNCONFIRMED_RESPONSE',
        mutation
          ? 'The account action may have completed. Refresh saved account status before starting another action.'
          : 'Account status could not be checked. Refresh to try again.',
        0,
        mutation && dispatched,
      );
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    }
  };
}
export function createAccountSecurityClient(
  options: SecurityOptions & { accountId: string },
) {
  const owner = securityId(options.accountId),
    request = createSecurityRequest(options);
  const grantToken = (grant: SecurityGrant, action: SecurityAction) => {
    if (
      grant.accountId !== owner ||
      !sameSecurityAction(grant.action, action) ||
      grant.expiresAt <= Date.now()
    )
      throw new AccountSecurityError(
        'GRANT_EXPIRED',
        'Confirm this action again; the previous approval expired.',
      );
    return grant.grantToken;
  };
  return {
    async overview() {
      return parseSecurityOverview(await request('/api/auth/security'), owner);
    },
    async walletOptions(
      identity: SecurityIdentity,
      action: SecurityAction,
      origin: string,
    ) {
      if (
        identity.kind !== 'solana' ||
        (action.kind === 'remove-identity' && action.target === identity.id)
      )
        return invalidSecurityResponse();
      const data = securityRecord(
        await request('/api/auth/security/wallet/options', {
          identityId: securityId(identity.id),
          action: checkedAction(action),
        }),
      );
      return validateSecurityWalletChallenge(data.challenge, {
        accountId: owner,
        action,
        address: identity.subject,
        purpose: 'reauthenticate',
        origin,
      });
    },
    async verifyWallet(challenge: SecurityWalletChallenge, proof: WalletProof) {
      const data = await request(
        '/api/auth/security/wallet/verify',
        { challengeId: challenge.id, proof },
        true,
      );
      return parseSecurityGrant(data, owner, challenge.action);
    },
    async linkOptions(grant: SecurityGrant, origin: string) {
      const action = grant.action;
      if (action.kind !== 'link-wallet') return invalidSecurityResponse();
      const address = securityAddress(action.target);
      const data = securityRecord(
        await request('/api/auth/security/wallet/link/options', {
          address,
          grantToken: grantToken(grant, action),
        }),
      );
      return validateSecurityWalletChallenge(data.challenge, {
        accountId: owner,
        action,
        address,
        purpose: 'link-wallet',
        origin,
      });
    },
    async linkWallet(challenge: SecurityWalletChallenge, proof: WalletProof) {
      const v = securityRecord(
        await request(
          '/api/auth/security/wallet/link/verify',
          { challengeId: challenge.id, proof },
          true,
        ),
      );
      if (v.linked !== true) return invalidSecurityResponse();
    },
    async removeIdentity(grant: SecurityGrant) {
      const action = grant.action;
      if (action.kind !== 'remove-identity') return invalidSecurityResponse();
      const v = securityRecord(
        await request(
          `/api/auth/security/identities/${securityId(action.target)}/remove`,
          { grantToken: grantToken(grant, action) },
          true,
        ),
      );
      if (v.removed !== true) return invalidSecurityResponse();
    },
    async revokeSessions(grant: SecurityGrant) {
      const action = grant.action;
      if (action.kind !== 'revoke-sessions') return invalidSecurityResponse();
      const v = securityRecord(
        await request(
          '/api/auth/security/sessions/revoke',
          { target: action.target, grantToken: grantToken(grant, action) },
          true,
        ),
      );
      if (
        !Number.isSafeInteger(v.revoked) ||
        (v.revoked as number) < 0 ||
        (v.revoked as number) > 100_000
      )
        return invalidSecurityResponse();
      return { revoked: v.revoked as number, signedOut: boolean(v.signedOut) };
    },
  };
}
