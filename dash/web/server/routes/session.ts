import type { Pool } from 'pg';
import { readSessionCookie, hashToken } from '../auth/index.ts';
import { one } from '../db/database.ts';
import { ServiceError } from '../core/errors.ts';

export type Session = { accountId: string; tokenHash: string };

export async function getSession(
  pool: Pool,
  request: Request,
): Promise<Session> {
  let token: string | null;
  try {
    token = readSessionCookie(request.headers.get('cookie'));
  } catch {
    token = null;
  }
  if (!token)
    throw new ServiceError(401, 'SIGN_IN_REQUIRED', 'Sign in to continue.');
  const tokenHash = await hashToken(token);
  const session = await one<{ account_id: string }>(
    pool,
    `SELECT s.account_id FROM sessions s JOIN accounts a ON a.id=s.account_id
     WHERE s.token_hash=$1 AND s.expires_at>now() AND s.revoked_at IS NULL AND a.disabled_at IS NULL
       AND (s.identity_id IS NULL OR EXISTS (SELECT 1 FROM identities i WHERE i.id=s.identity_id AND i.account_id=s.account_id AND i.revoked_at IS NULL))`,
    [tokenHash],
  );
  if (!session)
    throw new ServiceError(
      401,
      'SIGN_IN_REQUIRED',
      'Your session has expired. Sign in again.',
    );
  const expected = request.headers.get('x-conclave-account-id');
  if (expected !== null && expected !== session.account_id)
    throw new ServiceError(
      401,
      'ACCOUNT_CHANGED',
      'The signed-in account changed. Refresh before continuing.',
    );
  return { accountId: session.account_id, tokenHash };
}
