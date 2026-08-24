import type { Pool } from 'pg';
import { one, transaction, type Queryable } from '../db/database.ts';
import { getSession } from './session.ts';
import {
  jsonResponse,
  readJson,
  stringField,
  uuidField,
} from '../core/http.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';
import { rateLimit } from '../core/rate-limit.ts';
import { AuthError, serializeExpiredSessionCookie } from '../auth/index.ts';
import {
  decodeWalletAddress,
  type WalletAuthResponse,
} from '../auth/wallet.ts';
import {
  createSecurityWalletChallenge,
  verifySecurityWalletChallenge,
  type SecurityWalletChallenge,
} from '../auth/security-wallet.ts';
import {
  browserBinding,
  lockSecuritySession,
  createSecurityGrant,
  consumeSecurityGrant,
  revokeOtherSessions,
} from '../auth/security.ts';
import {
  parseSecurityAction,
  type SecurityAction,
} from '../../lib/auth/security.ts';

function exact(body: Record<string, unknown>, fields: string[]) {
  requireCondition(
    Object.keys(body).length === fields.length &&
      fields.every((key) => Object.hasOwn(body, key)),
    400,
    'INVALID_REQUEST',
    'Only the required account fields are accepted.',
  );
}
function actionField(value: unknown): SecurityAction {
  try {
    return parseSecurityAction(value);
  } catch {
    throw new ServiceError(
      400,
      'INVALID_REQUEST',
      'The account action is invalid.',
    );
  }
}
function proofField(value: unknown): WalletAuthResponse {
  requireCondition(
    value && typeof value === 'object' && !Array.isArray(value),
    400,
    'INVALID_REQUEST',
    'Provide the wallet proof.',
  );
  return value as WalletAuthResponse;
}
async function activeIdentity(db: Queryable, accountId: string, id: string) {
  const identity = await one<{ id: string; kind: string; subject: string }>(
    db,
    'SELECT id,kind,subject FROM identities WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL',
    [id, accountId],
  );
  requireCondition(
    identity,
    404,
    'IDENTITY_UNAVAILABLE',
    'This sign-in identity is unavailable.',
  );
  return identity;
}
async function validateActionTarget(
  db: Queryable,
  accountId: string,
  tokenHash: string,
  action: SecurityAction,
) {
  if (action.kind === 'link-wallet') {
    decodeWalletAddress(action.target!);
    const identity = await one<{ account_id: string; revoked_at: Date | null }>(
      db,
      "SELECT account_id,revoked_at FROM identities WHERE kind='solana' AND subject=$1",
      [action.target],
    );
    requireCondition(
      !identity ||
        (identity.account_id === accountId && identity.revoked_at !== null),
      409,
      'IDENTITY_UNAVAILABLE',
      'This wallet cannot be linked to this account.',
    );
  }
  if (action.kind === 'remove-identity') {
    await activeIdentity(db, accountId, action.target!);
    const count = await one<{ count: string }>(
      db,
      'SELECT count(*) FROM identities WHERE account_id=$1 AND revoked_at IS NULL',
      [accountId],
    );
    requireCondition(
      Number(count?.count) > 1,
      409,
      'LAST_IDENTITY',
      'Add another sign-in method before removing this one.',
    );
  }
  if (action.kind === 'revoke-sessions' && action.target !== 'others') {
    requireCondition(
      await one(
        db,
        'SELECT id FROM sessions WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL AND expires_at>now()',
        [action.target, accountId],
      ),
      404,
      'SESSION_UNAVAILABLE',
      'This session is unavailable.',
    );
  }
  if (action.kind === 'add-passkey' || action.kind === 'link-wallet') {
    const count = await one<{ count: string }>(
      db,
      'SELECT count(*) FROM identities WHERE account_id=$1 AND revoked_at IS NULL',
      [accountId],
    );
    requireCondition(
      Number(count?.count) < 16,
      409,
      'IDENTITY_LIMIT',
      'Remove an unused sign-in method before adding another.',
    );
  }
  // The session lock is established by each caller before invoking this check.
  void tokenHash;
}

type StoredChallenge = {
  id: string;
  purpose: string;
  action: SecurityAction['kind'];
  target: string | null;
  identity_id: string;
  payload: SecurityWalletChallenge;
  expires_at: Date;
};

/** All mutations require an authenticated, account-bound request and explicit proof. */
export async function accountSecurityRoutes(
  pool: Pool,
  request: Request,
  path: string,
  origin: string,
): Promise<Response | null> {
  if (path !== 'auth/security' && !path.startsWith('auth/security/'))
    return null;
  const session = await getSession(pool, request);
  requireCondition(
    request.headers.get('x-conclave-account-id') === session.accountId,
    401,
    'ACCOUNT_CHANGED',
    'Refresh the signed-in account before continuing.',
  );
  requireCondition(
    !new URL(request.url).search,
    400,
    'INVALID_REQUEST',
    'Account endpoints do not accept URL parameters.',
  );
  await rateLimit(
    pool,
    `account-security:${session.accountId}`,
    request.method === 'GET' ? 60 : 20,
  );
  try {
    if (path === 'auth/security' && request.method === 'GET') {
      const identities = await pool.query<{
        id: string;
        kind: string;
        subject: string;
        createdAt: Date;
      }>(
        'SELECT id,kind,subject,created_at AS "createdAt" FROM identities WHERE account_id=$1 AND revoked_at IS NULL ORDER BY created_at,id',
        [session.accountId],
      );
      const sessions = await pool.query<{
        id: string;
        createdAt: Date;
        expiresAt: Date;
        current: boolean;
      }>(
        'SELECT id,created_at AS "createdAt",expires_at AS "expiresAt",token_hash=$2 AS current FROM sessions WHERE account_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY (token_hash=$2) DESC,created_at DESC,id LIMIT 51',
        [session.accountId, session.tokenHash],
      );
      return jsonResponse({
        accountId: session.accountId,
        identities: identities.rows,
        sessions: sessions.rows.slice(0, 50),
        moreSessions: sessions.rows.length > 50,
      });
    }
    if (request.method !== 'POST') return null;
    const body = await readJson(request, 16_384);
    if (path === 'auth/security/wallet/options') {
      exact(body, ['identityId', 'action']);
      const identityId = uuidField(body.identityId).toLowerCase(),
        action = actionField(body.action);
      const binding = await browserBinding(request, true);
      const challenge = await transaction(pool, async (db) => {
        await lockSecuritySession(db, session);
        const identity = await activeIdentity(
          db,
          session.accountId,
          identityId,
        );
        requireCondition(
          identity.kind === 'solana' &&
            !(
              action.kind === 'remove-identity' && action.target === identityId
            ),
          403,
          'REAUTHENTICATION_REQUIRED',
          'Use a remaining sign-in method to authorize this action.',
        );
        await validateActionTarget(
          db,
          session.accountId,
          session.tokenHash,
          action,
        );
        const challenge = createSecurityWalletChallenge({
          address: identity.subject,
          origin,
          accountId: session.accountId,
          purpose: 'reauthenticate',
          action,
        });
        await db.query(
          `INSERT INTO auth_security_challenges(id,account_id,session_token_hash,purpose,action,target,identity_id,payload,browser_hash,expires_at)
          VALUES($1,$2,$3,'wallet-reauth',$4,$5,$6,$7,$8,$9)`,
          [
            challenge.id,
            session.accountId,
            session.tokenHash,
            action.kind,
            action.target,
            identity.id,
            challenge,
            binding.hash,
            new Date(challenge.expiresAt),
          ],
        );
        return challenge;
      });
      return jsonResponse(
        { challenge },
        201,
        binding.cookie ? { 'Set-Cookie': binding.cookie } : undefined,
      );
    }
    if (path === 'auth/security/wallet/link/options') {
      exact(body, ['address', 'grantToken']);
      const address = stringField(body, 'address', 44);
      decodeWalletAddress(address);
      const grantToken = stringField(body, 'grantToken', 43),
        action: SecurityAction = { kind: 'link-wallet', target: address };
      const binding = await browserBinding(request);
      const challenge = await transaction(pool, async (db) => {
        await lockSecuritySession(db, session);
        await validateActionTarget(
          db,
          session.accountId,
          session.tokenHash,
          action,
        );
        const grant = await consumeSecurityGrant(db, {
          accountId: session.accountId,
          sessionTokenHash: session.tokenHash,
          action,
          grantToken,
        });
        const challenge = createSecurityWalletChallenge({
          address,
          origin,
          accountId: session.accountId,
          purpose: 'link-wallet',
          action,
          expiresAt: Date.parse(grant.expiresAt),
        });
        await db.query(
          `INSERT INTO auth_security_challenges(id,account_id,session_token_hash,purpose,action,target,identity_id,payload,browser_hash,expires_at)
          VALUES($1,$2,$3,'link-wallet',$4,$5,$6,$7,$8,$9)`,
          [
            challenge.id,
            session.accountId,
            session.tokenHash,
            action.kind,
            action.target,
            grant.identityId,
            challenge,
            binding.hash,
            new Date(challenge.expiresAt),
          ],
        );
        return challenge;
      });
      return jsonResponse({ challenge }, 201);
    }
    if (
      path === 'auth/security/wallet/verify' ||
      path === 'auth/security/wallet/link/verify'
    ) {
      exact(body, ['challengeId', 'proof']);
      const challengeId = uuidField(body.challengeId).toLowerCase(),
        proof = proofField(body.proof);
      const binding = await browserBinding(request),
        linking = path.endsWith('/link/verify');
      const linkTarget = linking
        ? await one<{ target: string }>(
            pool,
            "SELECT target FROM auth_security_challenges WHERE id=$1 AND account_id=$2 AND session_token_hash=$3 AND browser_hash=$4 AND purpose='link-wallet'",
            [challengeId, session.accountId, session.tokenHash, binding.hash],
          )
        : null;
      if (linking)
        requireCondition(
          linkTarget,
          401,
          'CHALLENGE_UNAVAILABLE',
          'Start a new account authorization.',
        );
      const result = await transaction(pool, async (db) => {
        // Wallet sign-in uses this lock before the account lock too.
        if (linkTarget)
          await db.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
            [`identity:solana:${linkTarget.target}`],
          );
        await lockSecuritySession(db, session);
        const stored = await one<StoredChallenge>(
          db,
          `SELECT id,purpose,action,target,identity_id,payload,expires_at FROM auth_security_challenges
          WHERE id=$1 AND account_id=$2 AND session_token_hash=$3 AND browser_hash=$4 AND expires_at>clock_timestamp() AND consumed_at IS NULL FOR UPDATE`,
          [challengeId, session.accountId, session.tokenHash, binding.hash],
        );
        requireCondition(
          stored &&
            stored.purpose === (linking ? 'link-wallet' : 'wallet-reauth'),
          401,
          'CHALLENGE_UNAVAILABLE',
          'Start a new account authorization.',
        );
        const authorizer = await activeIdentity(
          db,
          session.accountId,
          stored.identity_id,
        );
        const action: SecurityAction = {
          kind: stored.action,
          target: stored.target,
        };
        requireCondition(
          stored.payload.accountId === session.accountId &&
            stored.payload.action.kind === action.kind &&
            stored.payload.action.target === action.target &&
            stored.payload.id === challengeId &&
            stored.payload.expiresAt === stored.expires_at.getTime() &&
            stored.payload.purpose ===
              (linking ? 'link-wallet' : 'reauthenticate') &&
            (linking || stored.payload.address === authorizer.subject),
          401,
          'CHALLENGE_UNAVAILABLE',
          'Start a new account authorization.',
        );
        verifySecurityWalletChallenge({
          challenge: stored.payload,
          response: proof,
          expectedOrigin: origin,
          requestOrigin: request.headers.get('origin'),
        });
        await validateActionTarget(
          db,
          session.accountId,
          session.tokenHash,
          action,
        );
        await lockSecuritySession(db, session);
        const consumed = await db.query(
          'UPDATE auth_security_challenges SET consumed_at=clock_timestamp() WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp()',
          [challengeId],
        );
        requireCondition(
          consumed.rowCount === 1,
          401,
          'CHALLENGE_UNAVAILABLE',
          'Start a new account authorization.',
        );
        if (!linking)
          return createSecurityGrant(db, {
            accountId: session.accountId,
            sessionTokenHash: session.tokenHash,
            action,
            identityId: authorizer.id,
          });
        requireCondition(
          action.kind === 'link-wallet' &&
            stored.payload.address === action.target,
          401,
          'CHALLENGE_UNAVAILABLE',
          'Start a new account authorization.',
        );
        requireCondition(
          action.target === linkTarget?.target,
          401,
          'CHALLENGE_UNAVAILABLE',
          'Start a new account authorization.',
        );
        const existing = await one<{
          id: string;
          account_id: string;
          revoked_at: Date | null;
        }>(
          db,
          "SELECT id,account_id,revoked_at FROM identities WHERE kind='solana' AND subject=$1 FOR UPDATE",
          [action.target],
        );
        requireCondition(
          !existing ||
            (existing.account_id === session.accountId &&
              existing.revoked_at !== null),
          409,
          'IDENTITY_UNAVAILABLE',
          'This wallet cannot be linked to this account.',
        );
        if (existing)
          await db.query('UPDATE identities SET revoked_at=NULL WHERE id=$1', [
            existing.id,
          ]);
        else
          await db.query(
            "INSERT INTO identities(id,account_id,kind,subject) VALUES($1,$2,'solana',$3)",
            [crypto.randomUUID(), session.accountId, action.target],
          );
        await revokeOtherSessions(db, session.accountId, session.tokenHash);
        return { linked: true };
      });
      return jsonResponse(result);
    }
    const remove = /^auth\/security\/identities\/([^/]+)\/remove$/.exec(path);
    if (remove) {
      exact(body, ['grantToken']);
      const target = uuidField(remove[1]).toLowerCase(),
        grantToken = stringField(body, 'grantToken', 43);
      await transaction(pool, async (db) => {
        await lockSecuritySession(db, session);
        const action: SecurityAction = { kind: 'remove-identity', target };
        await validateActionTarget(
          db,
          session.accountId,
          session.tokenHash,
          action,
        );
        const grant = await consumeSecurityGrant(db, {
          accountId: session.accountId,
          sessionTokenHash: session.tokenHash,
          action,
          grantToken,
        });
        requireCondition(
          grant.identityId !== target,
          403,
          'REAUTHENTICATION_REQUIRED',
          'Authorize removal with a different remaining sign-in method.',
        );
        await activeIdentity(db, session.accountId, grant.identityId);
        await db.query(
          'UPDATE sessions SET identity_id=$2 WHERE token_hash=$1',
          [session.tokenHash, grant.identityId],
        );
        await db.query(
          'UPDATE identities SET revoked_at=clock_timestamp() WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL',
          [target, session.accountId],
        );
        await revokeOtherSessions(db, session.accountId, session.tokenHash);
      });
      return jsonResponse({ removed: true });
    }
    if (path === 'auth/security/sessions/revoke') {
      exact(body, ['target', 'grantToken']);
      const action = actionField({
          kind: 'revoke-sessions',
          target: body.target,
        }),
        grantToken = stringField(body, 'grantToken', 43);
      const result = await transaction(pool, async (db) => {
        const locked = await lockSecuritySession(db, session);
        await validateActionTarget(
          db,
          session.accountId,
          session.tokenHash,
          action,
        );
        await consumeSecurityGrant(db, {
          accountId: session.accountId,
          sessionTokenHash: session.tokenHash,
          action,
          grantToken,
        });
        const result =
          action.target === 'others'
            ? await db.query(
                'UPDATE sessions SET revoked_at=clock_timestamp() WHERE account_id=$1 AND token_hash<>$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()',
                [session.accountId, session.tokenHash],
              )
            : await db.query(
                'UPDATE sessions SET revoked_at=clock_timestamp() WHERE account_id=$1 AND id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()',
                [session.accountId, action.target],
              );
        return {
          revoked: result.rowCount ?? 0,
          signedOut: action.target === locked.sessionId,
        };
      });
      return jsonResponse(
        result,
        200,
        result.signedOut
          ? { 'Set-Cookie': serializeExpiredSessionCookie() }
          : undefined,
      );
    }
    return null;
  } catch (error) {
    if (error instanceof AuthError)
      throw new ServiceError(
        401,
        'ACCOUNT_PROOF_REJECTED',
        'The account authorization could not be verified. Start again.',
      );
    throw error;
  }
}
