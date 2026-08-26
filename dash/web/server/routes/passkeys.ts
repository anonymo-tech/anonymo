import type { Pool } from 'pg';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
} from '@simplewebauthn/server';
import { one, transaction, type Queryable } from '../db/database.ts';
import {
  assertSameOrigin,
  jsonResponse,
  readJson,
  uuidField,
} from '../core/http.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';
import { clientBucket, rateLimit } from '../core/rate-limit.ts';
import { getSession, type Session } from './session.ts';
import {
  generateSessionToken,
  hashToken,
  serializeSessionCookie,
} from '../auth/index.ts';
import {
  assertSignedOut,
  browserBinding,
  consumeSecurityGrant,
  createSecurityGrant,
  lockSecuritySession,
  revokeOtherSessions,
} from '../auth/security.ts';
import {
  passkeyAlgorithms,
  passkeyBytes,
  passkeyCapability,
  proofRejected,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from '../auth/passkey.ts';
import {
  parseSecurityAction,
  type SecurityAction,
} from '../../lib/auth/security.ts';
import { grantSignInTestCredit } from '../ledger/test-credits.ts';

type Purpose = 'signup' | 'login' | 'add' | 'reauth';
type Challenge = {
  id: string;
  purpose: Purpose;
  browser_hash: string;
  challenge: string;
  account_id: string | null;
  user_handle: string | null;
  session_token_hash: string | null;
  authorizer_identity_id: string | null;
  action: SecurityAction['kind'] | null;
  target: string | null;
  origin: string;
  rp_id: string;
  allowed_credentials: string[];
  expires_at: Date;
  consumed_at: Date | null;
};
type Credential = {
  credential_id: string;
  identity_id: string;
  account_id: string;
  user_handle: string;
  public_key: Uint8Array;
  counter: string;
  device_type: 'singleDevice' | 'multiDevice';
  backed_up: boolean;
  transports: string[];
};
function exact(body: Record<string, unknown>, fields: string[]) {
  requireCondition(
    Object.keys(body).length === fields.length &&
      fields.every((key) => Object.hasOwn(body, key)),
    400,
    'INVALID_REQUEST',
    'Only the required passkey fields are accepted.',
  );
}
function actionField(value: unknown) {
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
async function signedOutBrowser(
  db: Queryable,
  request: Request,
  browserHash: string,
) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `auth-browser:${browserHash}`,
  ]);
  await assertSignedOut(db, request);
  const existing = await one(
    db,
    `SELECT s.id FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.browser_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND a.disabled_at IS NULL
    AND (s.identity_id IS NULL OR EXISTS(SELECT 1 FROM identities i WHERE i.id=s.identity_id AND i.account_id=s.account_id AND i.revoked_at IS NULL))`,
    [browserHash],
  );
  requireCondition(
    !existing,
    409,
    'SIGN_OUT_REQUIRED',
    'Sign out before using a different sign-in method.',
  );
}
async function identityLimit(db: Queryable, accountId: string) {
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
async function validateAction(
  db: Queryable,
  accountId: string,
  action: SecurityAction,
) {
  if (action.kind === 'remove-identity') {
    requireCondition(
      await one(
        db,
        'SELECT id FROM identities WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL',
        [action.target, accountId],
      ),
      404,
      'IDENTITY_UNAVAILABLE',
      'This sign-in method is unavailable.',
    );
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
  if (action.kind === 'revoke-sessions' && action.target !== 'others')
    requireCondition(
      await one(
        db,
        'SELECT id FROM sessions WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()',
        [action.target, accountId],
      ),
      404,
      'SESSION_UNAVAILABLE',
      'This session is unavailable.',
    );
  if (action.kind === 'add-passkey' || action.kind === 'link-wallet')
    await identityLimit(db, accountId);
}
async function ownedCredentials(
  db: Queryable,
  accountId: string,
  excludeIdentity?: string | null,
) {
  const result = await db.query<Credential>(
    `SELECT p.* FROM passkeys p JOIN identities i ON i.id=p.identity_id AND i.account_id=p.account_id WHERE p.account_id=$1 AND i.revoked_at IS NULL AND ($2::uuid IS NULL OR i.id<>$2) ORDER BY p.created_at,p.credential_id LIMIT 17`,
    [accountId, excludeIdentity ?? null],
  );
  requireCondition(
    result.rows.length <= 16,
    409,
    'IDENTITY_LIMIT',
    'This account has too many sign-in methods.',
  );
  return result.rows;
}
async function newSession(
  db: Queryable,
  accountId: string,
  identityId: string,
  browserHash: string,
) {
  const token = generateSessionToken();
  await db.query(
    "INSERT INTO sessions(token_hash,account_id,identity_id,browser_hash,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '24 hours')",
    [await hashToken(token), accountId, identityId, browserHash],
  );
  return serializeSessionCookie(token);
}
async function activeAuthorizer(
  db: Queryable,
  accountId: string,
  identityId: string | null,
) {
  requireCondition(
    identityId &&
      (await one(
        db,
        'SELECT id FROM identities WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL',
        [identityId, accountId],
      )),
    401,
    'REAUTHENTICATION_REQUIRED',
    'Authorize this action again with an active sign-in method.',
  );
}

async function finishChallenge(
  db: Queryable,
  id: string,
  session: Session | null,
) {
  if (session) await lockSecuritySession(db, session);
  const result = await db.query(
    'UPDATE passkey_challenges SET consumed_at=clock_timestamp() WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp()',
    [id],
  );
  requireCondition(
    result.rowCount === 1,
    401,
    'CHALLENGE_UNAVAILABLE',
    'Start a new passkey request.',
  );
}

/** Explicit, bounded ceremonies only. Native authenticator work happens in the requesting browser. */
export async function passkeyRoutes(
  pool: Pool,
  request: Request,
  path: string,
  origin: string,
): Promise<Response | null> {
  const match =
    /^auth\/passkeys\/(signup|login|add|reauth)\/(options|verify)$/.exec(path);
  if (!match) return null;
  requireCondition(
    request.method === 'POST',
    405,
    'METHOD_NOT_ALLOWED',
    'Use POST for a passkey ceremony.',
  );
  requireCondition(
    !new URL(request.url).search,
    400,
    'INVALID_REQUEST',
    'Passkey endpoints do not accept URL parameters.',
  );
  assertSameOrigin(request, origin);
  const capability = passkeyCapability();
  requireCondition(
    capability.configured &&
      capability.rpId &&
      new URL(origin).hostname === capability.rpId,
    503,
    'PASSKEYS_UNAVAILABLE',
    'Passkey sign-in is not configured for this workspace.',
  );
  const rpId = capability.rpId,
    purpose = match[1] as Purpose,
    optionsRequest = match[2] === 'options';
  const body = await readJson(request, 49_152);
  const binding = await browserBinding(request, optionsRequest);
  await rateLimit(
    pool,
    `passkey:client:${await clientBucket(request, binding.hash)}`,
    40,
  );
  await rateLimit(pool, `passkey:browser:${binding.hash}`, 20);
  await rateLimit(pool, 'passkey:global', 12000); // ceiling, not the control
  let session: Session | null = null;
  if (purpose === 'add' || purpose === 'reauth') {
    session = await getSession(pool, request);
    requireCondition(
      request.headers.get('x-conclave-account-id') === session.accountId,
      401,
      'ACCOUNT_CHANGED',
      'Refresh the signed-in account before continuing.',
    );
    await rateLimit(pool, `passkey:account:${session.accountId}`, 20);
  }
  if (optionsRequest) {
    exact(
      body,
      purpose === 'add'
        ? ['grantToken']
        : purpose === 'reauth'
          ? ['action']
          : [],
    );
    const envelope = await transaction(pool, async (db) => {
      if (session) await lockSecuritySession(db, session);
      else await signedOutBrowser(db, request, binding.hash);
      const now = (await one<{ now: Date }>(
        db,
        'SELECT clock_timestamp() AS now',
      ))!.now;
      const accountId =
        session?.accountId ??
        (purpose === 'signup' ? crypto.randomUUID() : null);
      let expiresAt = new Date(now.getTime() + 299_000),
        userHandle: string | null = null,
        authorizer: string | null = null,
        action: SecurityAction | null = null;
      let credentials: Credential[] = [];
      if (purpose === 'add') {
        requireCondition(
          typeof body.grantToken === 'string',
          400,
          'INVALID_REQUEST',
          'An authorization grant is required.',
        );
        action = { kind: 'add-passkey', target: null };
        const grant = await consumeSecurityGrant(db, {
          accountId: session!.accountId,
          sessionTokenHash: session!.tokenHash,
          action,
          grantToken: body.grantToken,
        });
        await identityLimit(db, accountId!);
        expiresAt = new Date(
          Math.min(expiresAt.getTime(), Date.parse(grant.expiresAt)),
        );
        authorizer = grant.identityId;
        let user = await one<{ user_handle: string }>(
          db,
          'SELECT user_handle FROM passkey_users WHERE account_id=$1',
          [accountId],
        );
        if (!user) {
          user = { user_handle: generateSessionToken() };
          await db.query(
            'INSERT INTO passkey_users(account_id,user_handle) VALUES($1,$2)',
            [accountId, user.user_handle],
          );
        }
        userHandle = user.user_handle;
        credentials = await ownedCredentials(db, accountId!);
      } else if (purpose === 'signup') userHandle = generateSessionToken();
      else if (purpose === 'reauth') {
        action = actionField(body.action);
        await validateAction(db, accountId!, action);
        credentials = await ownedCredentials(
          db,
          accountId!,
          action.kind === 'remove-identity' ? action.target : null,
        );
        requireCondition(
          credentials.length > 0,
          409,
          'PASSKEY_UNAVAILABLE',
          'Use another active sign-in method to authorize this action.',
        );
      }
      const challenge = generateSessionToken(),
        id = crypto.randomUUID();
      const options =
        purpose === 'signup' || purpose === 'add'
          ? await generateRegistrationOptions({
              rpName: 'Conclave',
              rpID: rpId,
              userName: 'Conclave account',
              userDisplayName: 'Conclave account',
              userID: passkeyBytes(userHandle, 32),
              challenge: passkeyBytes(challenge, 32),
              timeout: Math.min(60_000, expiresAt.getTime() - now.getTime()),
              attestationType: 'none',
              authenticatorSelection: {
                residentKey: 'required',
                requireResidentKey: true,
                userVerification: 'required',
              },
              supportedAlgorithmIDs: passkeyAlgorithms,
              excludeCredentials: credentials.map((p) => ({
                id: p.credential_id,
                transports: p.transports,
              })),
            })
          : await generateAuthenticationOptions({
              rpID: rpId,
              challenge: passkeyBytes(challenge, 32),
              timeout: 60_000,
              userVerification: 'required',
              ...(purpose === 'reauth'
                ? {
                    allowCredentials: credentials.map((p) => ({
                      id: p.credential_id,
                      transports: p.transports,
                    })),
                  }
                : {}),
            });
      await db.query(
        `INSERT INTO passkey_challenges(id,purpose,browser_hash,challenge,account_id,user_handle,session_token_hash,authorizer_identity_id,action,target,origin,rp_id,allowed_credentials,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          id,
          purpose,
          binding.hash,
          challenge,
          accountId,
          userHandle,
          session?.tokenHash ?? null,
          authorizer,
          action?.kind ?? null,
          action?.target ?? null,
          origin,
          rpId,
          credentials.map((p) => p.credential_id),
          now,
          expiresAt,
        ],
      );
      return {
        challengeId: id,
        purpose,
        accountId: purpose === 'signup' ? null : accountId,
        action,
        expiresAt: expiresAt.toISOString(),
        rpId,
        options,
      };
    });
    return jsonResponse(
      envelope,
      201,
      binding.cookie ? { 'Set-Cookie': binding.cookie } : undefined,
    );
  }
  exact(body, ['challengeId', 'credential']);
  const challengeId = uuidField(body.challengeId).toLowerCase();
  const result = await transaction(pool, async (db) => {
    if (session) await lockSecuritySession(db, session);
    else await signedOutBrowser(db, request, binding.hash);
    // Read the immutable challenge first; acquire the owner's lock before any credential mutation.
    const snapshot = await one<Challenge>(
      db,
      'SELECT * FROM passkey_challenges WHERE id=$1',
      [challengeId],
    );
    requireCondition(
      snapshot &&
        snapshot.purpose === purpose &&
        snapshot.browser_hash === binding.hash,
      401,
      'CHALLENGE_UNAVAILABLE',
      'Start a new passkey request.',
    );
    let storedCredential: Credential | null = null;
    if (purpose === 'login' || purpose === 'reauth') {
      const value = body.credential;
      if (!value || typeof value !== 'object' || Array.isArray(value))
        proofRejected();
      const id = (value as Record<string, unknown>).id;
      passkeyBytes(id, 1024);
      const lookup = await one<Credential>(
        db,
        `SELECT p.* FROM passkeys p JOIN identities i ON i.id=p.identity_id AND i.account_id=p.account_id WHERE p.credential_id=$1 AND i.revoked_at IS NULL`,
        [id],
      );
      if (!lookup || (session && lookup.account_id !== session.accountId))
        proofRejected();
      if (!session)
        requireCondition(
          await one(
            db,
            'SELECT id FROM accounts WHERE id=$1 AND disabled_at IS NULL FOR UPDATE',
            [lookup.account_id],
          ),
          401,
          'PASSKEY_PROOF_REJECTED',
          'The passkey could not be verified.',
        );
      storedCredential = await one<Credential>(
        db,
        `SELECT p.* FROM passkeys p JOIN identities i ON i.id=p.identity_id AND i.account_id=p.account_id WHERE p.credential_id=$1 AND i.revoked_at IS NULL FOR UPDATE OF p`,
        [id],
      );
      if (!storedCredential) proofRejected();
    }
    const challenge = await one<Challenge>(
      db,
      `SELECT * FROM passkey_challenges WHERE id=$1 AND browser_hash=$2 AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`,
      [challengeId, binding.hash],
    );
    requireCondition(
      challenge &&
        challenge.purpose === purpose &&
        challenge.origin === origin &&
        challenge.rp_id === rpId &&
        challenge.session_token_hash === (session?.tokenHash ?? null) &&
        (!session || challenge.account_id === session.accountId),
      401,
      'CHALLENGE_UNAVAILABLE',
      'Start a new passkey request.',
    );
    request.signal.throwIfAborted();
    if (purpose === 'signup' || purpose === 'add') {
      if (session) {
        await activeAuthorizer(
          db,
          session.accountId,
          challenge.authorizer_identity_id,
        );
        await identityLimit(db, session.accountId);
      }
      const registration = await verifyPasskeyRegistration(body.credential, {
        challenge: challenge.challenge,
        origin,
        rpId,
      });
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `identity:passkey:${registration.credential.id}`,
      ]);
      requireCondition(
        !(await one(
          db,
          "SELECT id FROM identities WHERE kind='passkey' AND subject=$1",
          [registration.credential.id],
        )),
        409,
        'PASSKEY_UNAVAILABLE',
        'Use a different new passkey for this account.',
      );
      if (purpose === 'signup') {
        await db.query('INSERT INTO accounts(id) VALUES($1)', [
          challenge.account_id,
        ]);
        await db.query(
          'INSERT INTO passkey_users(account_id,user_handle) VALUES($1,$2)',
          [challenge.account_id, challenge.user_handle],
        );
      }
      const identityId = crypto.randomUUID();
      await db.query(
        "INSERT INTO identities(id,account_id,kind,subject) VALUES($1,$2,'passkey',$3)",
        [identityId, challenge.account_id, registration.credential.id],
      );
      await db.query(
        `INSERT INTO passkeys(credential_id,identity_id,account_id,user_handle,public_key,counter,device_type,backed_up,transports)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          registration.credential.id,
          identityId,
          challenge.account_id,
          challenge.user_handle,
          registration.credential.publicKey,
          registration.credential.counter,
          registration.credentialDeviceType,
          registration.credentialBackedUp,
          registration.credential.transports ?? [],
        ],
      );
      request.signal.throwIfAborted();
      await finishChallenge(db, challengeId, session);
      if (session) {
        await revokeOtherSessions(db, session.accountId, session.tokenHash);
        return {
          body: { added: true, accountId: session.accountId, identityId },
          cookie: undefined,
        };
      }
      return {
        body: { accountId: challenge.account_id },
        cookie: await newSession(
          db,
          challenge.account_id!,
          identityId,
          binding.hash,
        ),
      };
    }
    const credential = storedCredential!;
    if (purpose === 'reauth') {
      if (
        !challenge.allowed_credentials.includes(credential.credential_id) ||
        challenge.account_id !== credential.account_id ||
        !challenge.action
      )
        proofRejected();
      const action = { kind: challenge.action, target: challenge.target };
      await validateAction(db, credential.account_id, action);
      if (
        action.kind === 'remove-identity' &&
        action.target === credential.identity_id
      )
        proofRejected();
    }
    const verified = await verifyPasskeyAuthentication(body.credential, {
      challenge: challenge.challenge,
      origin,
      rpId,
      userHandle: credential.user_handle,
      requireUserHandle: purpose === 'login',
      deviceType: credential.device_type,
      credential: {
        id: credential.credential_id,
        publicKey: new Uint8Array(credential.public_key),
        counter: Number(credential.counter),
        transports: credential.transports,
      },
    });
    request.signal.throwIfAborted();
    await db.query(
      'UPDATE passkeys SET counter=$2,backed_up=$3,last_used_at=clock_timestamp() WHERE credential_id=$1',
      [
        credential.credential_id,
        verified.newCounter,
        verified.credentialBackedUp,
      ],
    );
    await finishChallenge(db, challengeId, session);
    if (purpose === 'reauth')
      return {
        body: {
          ...(await createSecurityGrant(db, {
            accountId: credential.account_id,
            sessionTokenHash: session!.tokenHash,
            identityId: credential.identity_id,
            action: { kind: challenge.action!, target: challenge.target },
          })),
          accountId: credential.account_id,
        },
        cookie: undefined,
      };
    return {
      body: { accountId: credential.account_id },
      cookie: await newSession(
        db,
        credential.account_id,
        credential.identity_id,
        binding.hash,
      ),
    };
  });
  // Only signup/login issue a session cookie; add/reauth are not sign-ins.
  if (result.cookie)
    await grantSignInTestCredit(pool, result.body.accountId, origin);
  return jsonResponse(
    result.body,
    200,
    result.cookie ? { 'Set-Cookie': result.cookie } : undefined,
  );
}
