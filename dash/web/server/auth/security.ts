import { generateSessionToken, hashToken, readSessionCookie } from './index.ts';
import { one, type Queryable } from '../db/database.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';
import {
  parseSecurityAction,
  type SecurityAction,
} from '../../lib/auth/security.ts';

const browserCookie = '__Host-conclave_auth';
async function proofHash(token: string, purpose: 'browser' | 'grant') {
  requireCondition(
    /^[A-Za-z0-9_-]{43}$/.test(token),
    401,
    'REAUTHENTICATION_REQUIRED',
    'Start a new account authorization.',
  );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`conclave:auth-${purpose}:v1:${token}`),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
export async function browserBinding(
  request: Request,
  create = false,
): Promise<{ hash: string; cookie?: string }> {
  const header = request.headers.get('cookie') ?? '';
  requireCondition(
    header.length <= 16384,
    400,
    'INVALID_REQUEST',
    'The browser authorization is invalid.',
  );
  const matches = header
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.split('=')[0] === browserCookie);
  requireCondition(
    matches.length <= 1,
    400,
    'INVALID_REQUEST',
    'The browser authorization is invalid.',
  );
  const existing = matches[0]?.slice(browserCookie.length + 1);
  if (existing !== undefined)
    return { hash: await proofHash(existing, 'browser') };
  requireCondition(
    create,
    401,
    'CHALLENGE_UNAVAILABLE',
    'Start a new account authorization in this browser.',
  );
  const token = generateSessionToken();
  return {
    hash: await proofHash(token, 'browser'),
    cookie: `${browserCookie}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600`,
  };
}
export async function lockSecuritySession(
  db: Queryable,
  input: { accountId: string; tokenHash: string },
) {
  const account = await one(
    db,
    'SELECT id FROM accounts WHERE id=$1 AND disabled_at IS NULL FOR UPDATE',
    [input.accountId],
  );
  requireCondition(account, 401, 'SIGN_IN_REQUIRED', 'Sign in to continue.');
  const session = await one<{ id: string; identity_id: string | null }>(
    db,
    `SELECT s.id,s.identity_id FROM sessions s
    WHERE s.token_hash=$1 AND s.account_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
    AND (s.identity_id IS NULL OR EXISTS(SELECT 1 FROM identities i WHERE i.id=s.identity_id AND i.account_id=s.account_id AND i.revoked_at IS NULL)) FOR UPDATE`,
    [input.tokenHash, input.accountId],
  );
  requireCondition(session, 401, 'SIGN_IN_REQUIRED', 'Sign in to continue.');
  return { sessionId: session.id, identityId: session.identity_id };
}
async function activeProof(
  db: Queryable,
  accountId: string,
  identityId: string,
  action: SecurityAction,
) {
  requireCondition(
    await one(
      db,
      'SELECT id FROM identities WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL',
      [identityId, accountId],
    ),
    401,
    'REAUTHENTICATION_REQUIRED',
    'Authorize this action again with an active sign-in method.',
  );
  requireCondition(
    !(action.kind === 'remove-identity' && action.target === identityId),
    403,
    'REAUTHENTICATION_REQUIRED',
    'Use a different remaining sign-in method to authorize removal.',
  );
}
export async function createSecurityGrant(
  db: Queryable,
  input: {
    accountId: string;
    sessionTokenHash: string;
    action: SecurityAction;
    identityId: string;
  },
) {
  const action = parseSecurityAction(input.action);
  await lockSecuritySession(db, {
    accountId: input.accountId,
    tokenHash: input.sessionTokenHash,
  });
  await activeProof(db, input.accountId, input.identityId, action);
  const grantToken = generateSessionToken(),
    hash = await proofHash(grantToken, 'grant');
  const result = await one<{ expires_at: Date }>(
    db,
    `INSERT INTO auth_security_grants(token_hash,account_id,session_token_hash,action,target,identity_id,created_at,expires_at)
    SELECT $1,$2,$3,$4,$5,$6,clock_timestamp(),clock_timestamp()+interval '119 seconds' RETURNING expires_at`,
    [
      hash,
      input.accountId,
      input.sessionTokenHash,
      action.kind,
      action.target,
      input.identityId,
    ],
  );
  return { grantToken, expiresAt: result!.expires_at.toISOString(), action };
}
export async function consumeSecurityGrant(
  db: Queryable,
  input: {
    accountId: string;
    sessionTokenHash: string;
    action: SecurityAction;
    grantToken: string;
  },
) {
  const action = parseSecurityAction(input.action);
  await lockSecuritySession(db, {
    accountId: input.accountId,
    tokenHash: input.sessionTokenHash,
  });
  const grant = await one<{ identity_id: string; expires_at: Date }>(
    db,
    `SELECT identity_id,expires_at FROM auth_security_grants
    WHERE token_hash=$1 AND account_id=$2 AND session_token_hash=$3 AND action=$4 AND target IS NOT DISTINCT FROM $5
    AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`,
    [
      await proofHash(input.grantToken, 'grant'),
      input.accountId,
      input.sessionTokenHash,
      action.kind,
      action.target,
    ],
  );
  requireCondition(
    grant,
    401,
    'REAUTHENTICATION_REQUIRED',
    'Authorize this action again with an active sign-in method.',
  );
  await activeProof(db, input.accountId, grant.identity_id, action);
  await lockSecuritySession(db, {
    accountId: input.accountId,
    tokenHash: input.sessionTokenHash,
  });
  const consumed = await db.query(
    'UPDATE auth_security_grants SET consumed_at=clock_timestamp() WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp()',
    [await proofHash(input.grantToken, 'grant')],
  );
  requireCondition(
    consumed.rowCount === 1,
    401,
    'REAUTHENTICATION_REQUIRED',
    'Authorize this action again with an active sign-in method.',
  );
  return {
    identityId: grant.identity_id,
    expiresAt: grant.expires_at.toISOString(),
  };
}
export async function revokeOtherSessions(
  db: Queryable,
  accountId: string,
  tokenHash: string,
) {
  await db.query(
    'UPDATE sessions SET revoked_at=clock_timestamp() WHERE account_id=$1 AND token_hash<>$2 AND revoked_at IS NULL',
    [accountId, tokenHash],
  );
}
export async function assertSignedOut(db: Queryable, request: Request) {
  let token: string | null;
  try {
    token = readSessionCookie(request.headers.get('cookie'));
  } catch {
    throw new ServiceError(
      400,
      'INVALID_REQUEST',
      'The session cookie is invalid.',
    );
  }
  if (!token) return;
  const active = await one(
    db,
    `SELECT s.token_hash FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=$1
    AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND a.disabled_at IS NULL
    AND (s.identity_id IS NULL OR EXISTS(SELECT 1 FROM identities i WHERE i.id=s.identity_id AND i.account_id=s.account_id AND i.revoked_at IS NULL))`,
    [await hashToken(token)],
  );
  requireCondition(
    !active,
    409,
    'SIGN_OUT_REQUIRED',
    'Sign out before using a different sign-in method.',
  );
}
