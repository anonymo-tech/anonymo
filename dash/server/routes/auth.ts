import type { Pool } from 'pg';
import {
  createWalletChallenge,
  verifyWalletChallenge,
  generateSessionToken,
  hashToken,
  serializeSessionCookie,
  serializeExpiredSessionCookie,
  AuthError,
  type WalletChallenge,
  type WalletAuthResponse,
} from '../auth/index.ts';
import { one, transaction } from '../db/database.ts';
import { readJson, stringField, jsonResponse } from '../core/http.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';
import { clientBucket, rateLimit } from '../core/rate-limit.ts';
import { getSession } from './session.ts';
import { digestText } from '../core/digest.ts';
import { browserBinding } from '../auth/security.ts';
import { grantSignInTestCredit } from '../ledger/test-credits.ts';
import { grantWalletWelcomeCreditInTransaction } from '../ledger/welcome-credit.ts';

export async function authRoute(
  pool: Pool,
  request: Request,
  path: string,
  origin: string,
): Promise<Response | null> {
  const local = origin.startsWith('http://');
  try {
    if (path === 'auth/challenge' && request.method === 'POST') {
      // One client is throttled before the shared bucket so a single caller
      // cannot exhaust sign-in for everyone. The client key is the edge's
      // connecting-IP header in production (the Worker always has it) and the
      // browser cookie elsewhere; a cookieless flood only reaches the shared
      // bucket, which is sized as a database-protection ceiling, not a lockout.
      const browser = await browserBinding(request, true);
      await rateLimit(
        pool,
        `auth:challenge:client:${await clientBucket(request, browser.hash)}`,
        60,
      );
      await rateLimit(pool, 'auth:challenges:global', 30000);
      const body = await readJson(request, 2048);
      const address = stringField(body, 'address', 44);
      await rateLimit(
        pool,
        `auth:challenge:${await digestText('wallet-rate-limit', address)}`,
        10,
      );
      const challenge = createWalletChallenge({
        address,
        origin,
        allowInsecureLocalhost: local,
      });
      await pool.query(
        'INSERT INTO auth_challenges(id,payload,expires_at) VALUES($1,$2,$3)',
        [
          challenge.id,
          { ...challenge, browserHash: browser.hash },
          new Date(challenge.expiresAt),
        ],
      );
      return jsonResponse(
        { challenge },
        201,
        browser.cookie ? { 'Set-Cookie': browser.cookie } : undefined,
      );
    }
    if (path === 'auth/verify' && request.method === 'POST') {
      const browser = await browserBinding(request);
      await rateLimit(
        pool,
        `auth:verify:client:${await clientBucket(request, browser.hash)}`,
        60,
      );
      await rateLimit(pool, 'auth:verifications:global', 30000);
      const body = await readJson(request, 8192);
      const challengeId = stringField(body, 'challengeId', 80);
      requireCondition(
        /^[0-9a-f-]{36}$/i.test(challengeId),
        400,
        'INVALID_CHALLENGE',
        'The sign-in challenge is invalid.',
      );
      // A wallet that offers Sign In With Solana must use it, so the wallet
      // checks the requesting domain; exact-message signing is the fallback.
      requireCondition(
        (body.method === 'signIn' || body.method === 'signMessage') &&
          typeof body.signInSupported === 'boolean' &&
          (body.method === 'signMessage' || body.signInSupported),
        400,
        'INVALID_REQUEST',
        'The wallet sign-in method is invalid.',
      );
      requireCondition(
        !(body.method === 'signMessage' && body.signInSupported),
        400,
        'SIGN_IN_METHOD_REQUIRED',
        'This wallet supports Sign In With Solana. Use it to sign in.',
      );
      const sessionToken = generateSessionToken();
      const tokenHash = await hashToken(sessionToken);
      const result = await transaction(pool, async (client) => {
        const stored = await one<{
          payload: WalletChallenge & { browserHash?: string };
          consumed_at: Date | null;
          expired: boolean;
        }>(
          client,
          'SELECT payload,consumed_at,expires_at<=now() AS expired FROM auth_challenges WHERE id=$1 FOR UPDATE',
          [challengeId],
        );
        requireCondition(
          stored &&
            !stored.expired &&
            !stored.consumed_at &&
            stored.payload.browserHash === browser.hash,
          401,
          'CHALLENGE_UNAVAILABLE',
          'Request a new sign-in challenge.',
        );
        const verified = await verifyWalletChallenge({
          challenge: stored.payload,
          response: body as WalletAuthResponse,
          expectedOrigin: origin,
          requestOrigin: request.headers.get('origin'),
          allowInsecureLocalhost: local,
        });
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [`auth-browser:${browser.hash}`],
        );
        // Serialize first sign-ins of the same identity without coupling unrelated accounts.
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [`identity:solana:${verified.address}`],
        );
        let identity = await one<{
          id: string;
          account_id: string;
          revoked_at: Date | null;
        }>(
          client,
          "SELECT id,account_id,revoked_at FROM identities WHERE kind='solana' AND subject=$1",
          [verified.address],
        );
        let welcomeCredit: Awaited<
          ReturnType<typeof grantWalletWelcomeCreditInTransaction>
        > = null;
        if (!identity) {
          const accountId = crypto.randomUUID();
          await client.query('INSERT INTO accounts(id) VALUES($1)', [
            accountId,
          ]);
          const identityId = crypto.randomUUID();
          await client.query(
            "INSERT INTO identities(id,account_id,kind,subject) VALUES($1,$2,'solana',$3)",
            [identityId, accountId, verified.address],
          );
          identity = {
            id: identityId,
            account_id: accountId,
            revoked_at: null,
          };
          welcomeCredit = await grantWalletWelcomeCreditInTransaction(client, {
            accountId,
            identityId,
            walletAddress: verified.address,
          });
        }
        const available = await one(
          client,
          'SELECT id FROM accounts WHERE id=$1 AND disabled_at IS NULL FOR UPDATE',
          [identity.account_id],
        );
        requireCondition(
          available,
          403,
          'ACCOUNT_UNAVAILABLE',
          'This account is unavailable.',
        );
        requireCondition(
          await one(
            client,
            'SELECT id FROM identities WHERE id=$1 AND revoked_at IS NULL',
            [identity.id],
          ),
          401,
          'SIGN_IN_REJECTED',
          'The wallet sign-in proof could not be verified.',
        );
        const consumed = await client.query(
          'UPDATE auth_challenges SET consumed_at=clock_timestamp() WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp()',
          [challengeId],
        );
        requireCondition(
          consumed.rowCount === 1,
          401,
          'CHALLENGE_UNAVAILABLE',
          'Request a new sign-in challenge.',
        );
        await client.query(
          'UPDATE sessions SET revoked_at=clock_timestamp() WHERE browser_hash=$1 AND revoked_at IS NULL',
          [browser.hash],
        );
        await client.query(
          "INSERT INTO sessions(token_hash,account_id,identity_id,browser_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 day')",
          [tokenHash, identity.account_id, identity.id, browser.hash],
        );
        return {
          accountId: identity.account_id,
          method: verified.method,
          ...(welcomeCredit ? { welcomeCredit } : {}),
        };
      });
      await grantSignInTestCredit(pool, result.accountId, origin);
      const headers = new Headers();
      headers.append('Set-Cookie', serializeSessionCookie(sessionToken));
      if (browser.cookie) headers.append('Set-Cookie', browser.cookie);
      return jsonResponse(result, 200, headers);
    }
    if (path === 'auth/session' && request.method === 'GET') {
      const session = await getSession(pool, request);
      const identities = await pool.query(
        'SELECT kind,subject FROM identities WHERE account_id=$1 AND revoked_at IS NULL ORDER BY created_at',
        [session.accountId],
      );
      return jsonResponse({
        accountId: session.accountId,
        identities: identities.rows,
      });
    }
    if (path === 'auth/logout' && request.method === 'POST') {
      const session = await getSession(pool, request);
      await pool.query(
        'UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',
        [session.tokenHash],
      );
      return jsonResponse({ signedOut: true }, 200, {
        'Set-Cookie': serializeExpiredSessionCookie(),
      });
    }
    return null;
  } catch (error) {
    if (error instanceof AuthError)
      throw new ServiceError(
        401,
        'SIGN_IN_REJECTED',
        'The wallet sign-in proof could not be verified.',
      );
    throw error;
  }
}
