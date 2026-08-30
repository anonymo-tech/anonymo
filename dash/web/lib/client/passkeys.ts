import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import {
  AccountSecurityError,
  createSecurityRequest,
  invalidSecurityResponse,
  parseSecurityGrant,
  sameSecurityAction,
  securityExpiry,
  securityId,
  securityRecord,
  securityTimestamp,
  type SecurityAction,
  type SecurityGrant,
  type SecurityOptions,
} from './auth-security.ts';
import { parseSecurityAction } from '../auth/security.ts';

export type PasskeyPurpose = 'signup' | 'login' | 'add' | 'reauth';
export type PasskeyChallenge = {
  challengeId: string;
  purpose: PasskeyPurpose;
  accountId: string | null;
  action: SecurityAction | null;
  expiresAt: number;
  rpId: string;
  options:
    | PublicKeyCredentialCreationOptionsJSON
    | PublicKeyCredentialRequestOptionsJSON;
};
export type PasskeyCredential =
  | RegistrationResponseJSON
  | AuthenticationResponseJSON;
export type PasskeyAdapter = {
  register(
    options: PublicKeyCredentialCreationOptionsJSON,
  ): Promise<RegistrationResponseJSON>;
  authenticate(
    options: PublicKeyCredentialRequestOptionsJSON,
  ): Promise<AuthenticationResponseJSON>;
  cancel(): void;
};
export type AuthCapabilities = {
  wallet: boolean;
  passkeys: boolean;
  rpId: string | null;
};
function base64url(value: unknown, max = 2048, exactBytes?: number): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length > max ||
    value.length % 4 === 1
  )
    return invalidSecurityResponse();
  try {
    const bytes = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    if (
      (exactBytes !== undefined && bytes.length !== exactBytes) ||
      btoa(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !==
        value
    )
      return invalidSecurityResponse();
  } catch {
    return invalidSecurityResponse();
  }
  return value;
}
function descriptors(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64)
    return invalidSecurityResponse();
  const result = value.map((item) => {
    const v = securityRecord(item);
    if (v.type !== 'public-key') return invalidSecurityResponse();
    return { id: base64url(v.id), type: 'public-key' as const };
  });
  if (new Set(result.map((v) => v.id)).size !== result.length)
    return invalidSecurityResponse();
  return result;
}
export function parsePasskeyChallenge(
  value: unknown,
  expected: {
    purpose: PasskeyPurpose;
    origin: string;
    accountId?: string;
    action?: SecurityAction;
  },
  now = Date.now(),
): PasskeyChallenge {
  const v = securityRecord(value),
    options = securityRecord(v.options),
    origin = new URL(expected.origin);
  if (
    origin.origin !== expected.origin ||
    (origin.protocol !== 'https:' &&
      !(origin.protocol === 'http:' && origin.hostname === 'localhost')) ||
    v.purpose !== expected.purpose ||
    v.rpId !== origin.hostname ||
    v.accountId !== (expected.accountId ?? null)
  )
    return invalidSecurityResponse();
  let action: SecurityAction | null = null;
  if (expected.purpose === 'reauth' || expected.purpose === 'add') {
    try {
      action = parseSecurityAction(v.action);
    } catch {
      return invalidSecurityResponse();
    }
    const expectedAction =
      expected.purpose === 'add'
        ? { kind: 'add-passkey' as const, target: null }
        : expected.action;
    if (!expectedAction || !sameSecurityAction(action, expectedAction))
      return invalidSecurityResponse();
  } else if (v.action !== null) return invalidSecurityResponse();
  const expiresAt = securityExpiry(
    securityTimestamp(v.expiresAt),
    now,
    expected.purpose === 'add' ? 120_000 : 300_000,
  );
  const challenge = base64url(options.challenge, 256);
  if (
    challenge.length < 32 ||
    (options.timeout !== undefined &&
      (typeof options.timeout !== 'number' ||
        !Number.isSafeInteger(options.timeout) ||
        options.timeout <= 0 ||
        options.timeout > 300_000)) ||
    (options.extensions !== undefined &&
      Object.keys(securityRecord(options.extensions)).some(
        (key) => key !== 'credProps',
      ))
  )
    return invalidSecurityResponse();
  const timeout = Math.min(
    typeof options.timeout === 'number' ? options.timeout : 300_000,
    expiresAt - now,
  );
  let parsedOptions: PasskeyChallenge['options'];
  if (expected.purpose === 'signup' || expected.purpose === 'add') {
    const rp = securityRecord(options.rp),
      user = securityRecord(options.user),
      selection = securityRecord(options.authenticatorSelection);
    if (
      rp.id !== origin.hostname ||
      rp.name !== 'Conclave' ||
      user.name !== 'Conclave account' ||
      user.displayName !== 'Conclave account' ||
      options.attestation !== 'none' ||
      selection.residentKey !== 'required' ||
      selection.userVerification !== 'required' ||
      !Array.isArray(options.pubKeyCredParams) ||
      options.pubKeyCredParams.length < 1 ||
      options.pubKeyCredParams.length > 3
    )
      return invalidSecurityResponse();
    const params = options.pubKeyCredParams.map((item) => {
      const v = securityRecord(item);
      if (v.type !== 'public-key' || ![-7, -8, -257].includes(v.alg as number))
        return invalidSecurityResponse();
      return { type: 'public-key' as const, alg: v.alg as number };
    });
    parsedOptions = {
      rp: { id: origin.hostname, name: 'Conclave' },
      user: {
        id: base64url(user.id, 128, 32),
        name: 'Conclave account',
        displayName: 'Conclave account',
      },
      challenge,
      pubKeyCredParams: params,
      timeout,
      excludeCredentials: descriptors(options.excludeCredentials),
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
      attestation: 'none',
      extensions: { credProps: true },
    };
  } else {
    const allowCredentials = descriptors(options.allowCredentials);
    if (
      options.rpId !== origin.hostname ||
      options.userVerification !== 'required' ||
      (expected.purpose === 'login' && allowCredentials.length !== 0) ||
      (expected.purpose === 'reauth' && allowCredentials.length === 0)
    )
      return invalidSecurityResponse();
    parsedOptions = {
      rpId: origin.hostname,
      challenge,
      timeout,
      userVerification: 'required',
      ...(allowCredentials.length ? { allowCredentials } : {}),
    };
  }
  return {
    challengeId: securityId(v.challengeId),
    purpose: expected.purpose,
    accountId: expected.accountId ?? null,
    action,
    expiresAt,
    rpId: origin.hostname,
    options: parsedOptions,
  };
}
export function validatePasskeyCredential(
  value: unknown,
  challenge: PasskeyChallenge,
  origin: string,
): PasskeyCredential {
  const v = securityRecord(value),
    response = securityRecord(v.response),
    registration =
      challenge.purpose === 'signup' || challenge.purpose === 'add';
  const id = base64url(v.id);
  if (
    base64url(v.rawId) !== id ||
    v.type !== 'public-key' ||
    JSON.stringify(value).length > 196_608
  )
    return invalidSecurityResponse();
  const clientDataJSON = base64url(response.clientDataJSON, 8192);
  let clientData: Record<string, unknown>;
  try {
    clientData = securityRecord(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          Uint8Array.from(
            atob(clientDataJSON.replace(/-/g, '+').replace(/_/g, '/')),
            (c) => c.charCodeAt(0),
          ),
        ),
      ),
    );
  } catch {
    return invalidSecurityResponse();
  }
  if (
    clientData.type !== (registration ? 'webauthn.create' : 'webauthn.get') ||
    clientData.challenge !== challenge.options.challenge ||
    clientData.origin !== origin ||
    (clientData.crossOrigin !== undefined &&
      clientData.crossOrigin !== false) ||
    clientData.topOrigin !== undefined
  )
    return invalidSecurityResponse();
  if (registration) base64url(response.attestationObject, 131_072);
  else {
    base64url(response.authenticatorData, 4096);
    base64url(response.signature, 4096);
    if (
      challenge.purpose === 'login' &&
      (response.userHandle === undefined || response.userHandle === null)
    )
      return invalidSecurityResponse();
    if (response.userHandle !== undefined && response.userHandle !== null)
      base64url(response.userHandle, 128, 32);
    const allow = (challenge.options as PublicKeyCredentialRequestOptionsJSON)
      .allowCredentials;
    if (allow?.length && !allow.some((v) => v.id === id))
      return invalidSecurityResponse();
  }
  securityRecord(v.clientExtensionResults);
  return value as PasskeyCredential;
}
let activeCeremony: symbol | null = null;
export async function performPasskeyCeremony(
  challenge: PasskeyChallenge,
  options: {
    origin: string;
    signal?: AbortSignal;
    adapter?: PasskeyAdapter;
    visible?: () => boolean;
    now?: () => number;
  },
): Promise<PasskeyCredential> {
  const now = options.now ?? Date.now;
  if (activeCeremony)
    throw new AccountSecurityError(
      'CEREMONY_BUSY',
      'Finish or cancel the current passkey request first.',
    );
  const current = () => {
    options.signal?.throwIfAborted();
    if (challenge.expiresAt <= now())
      throw new AccountSecurityError(
        'CHALLENGE_EXPIRED',
        'This passkey request expired. Start again when ready.',
      );
  };
  current();
  if (
    !(
      options.visible?.() ??
      (typeof document !== 'undefined' &&
        document.visibilityState === 'visible')
    )
  )
    throw new AccountSecurityError(
      'PAGE_HIDDEN',
      'Return to Conclave before starting a passkey request.',
    );
  const token = Symbol('passkey');
  activeCeremony = token;
  let adapter = options.adapter;
  const abort = () => {
    if (activeCeremony === token) adapter?.cancel();
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (!adapter) {
      const library = await import('@simplewebauthn/browser');
      adapter = {
        register: (optionsJSON) =>
          library.startRegistration({ optionsJSON, useAutoRegister: false }),
        authenticate: (optionsJSON) =>
          library.startAuthentication({
            optionsJSON,
            useBrowserAutofill: false,
          }),
        cancel: () => library.WebAuthnAbortService.cancelCeremony(),
      };
    }
    current();
    const result =
      challenge.purpose === 'signup' || challenge.purpose === 'add'
        ? await adapter.register(
            challenge.options as PublicKeyCredentialCreationOptionsJSON,
          )
        : await adapter.authenticate(
            challenge.options as PublicKeyCredentialRequestOptionsJSON,
          );
    // Native passkey handoff can hide the page. Account/unmount aborts still fence the result.
    current();
    return validatePasskeyCredential(result, challenge, options.origin);
  } catch (error) {
    if (options.signal?.aborted)
      throw new DOMException('Passkey request cancelled.', 'AbortError');
    if (error instanceof AccountSecurityError) throw error;
    throw new AccountSecurityError(
      'PASSKEY_NOT_COMPLETED',
      'The passkey request did not complete. You can start again when ready.',
    );
  } finally {
    options.signal?.removeEventListener('abort', abort);
    if (activeCeremony === token) activeCeremony = null;
  }
}
export async function getAuthCapabilities(
  options: SecurityOptions = {},
): Promise<AuthCapabilities> {
  const data = securityRecord(
    await createSecurityRequest(options)('/api/capabilities'),
  );
  const wallet = securityRecord(data.walletSignIn),
    passkeys = securityRecord(data.passkeys);
  if (
    typeof wallet.configured !== 'boolean' ||
    typeof passkeys.configured !== 'boolean' ||
    (passkeys.rpId !== null && typeof passkeys.rpId !== 'string') ||
    (passkeys.configured && !passkeys.rpId)
  )
    return invalidSecurityResponse();
  return {
    wallet: wallet.configured,
    passkeys: passkeys.configured,
    rpId: passkeys.rpId as string | null,
  };
}
export function createPasskeyClient(
  options: SecurityOptions & { origin: string },
) {
  const request = createSecurityRequest(options);
  return {
    async options(
      purpose: PasskeyPurpose,
      input?: SecurityAction | SecurityGrant,
    ) {
      if ((purpose === 'signup' || purpose === 'login') && options.accountId)
        return invalidSecurityResponse();
      if ((purpose === 'reauth' || purpose === 'add') && !options.accountId)
        return invalidSecurityResponse();
      const action =
        purpose === 'reauth' ? parseSecurityAction(input) : undefined;
      const grant = purpose === 'add' ? (input as SecurityGrant) : undefined;
      if (
        grant &&
        (grant.accountId !== options.accountId ||
          grant.action.kind !== 'add-passkey' ||
          grant.action.target !== null ||
          grant.expiresAt <= Date.now())
      )
        throw new AccountSecurityError(
          'GRANT_EXPIRED',
          'Confirm adding this passkey again; the previous approval expired.',
        );
      const response = await request(
        `/api/auth/passkeys/${purpose}/options`,
        action ? { action } : grant ? { grantToken: grant.grantToken } : {},
      );
      return parsePasskeyChallenge(response, {
        purpose,
        origin: options.origin,
        accountId: options.accountId,
        action,
      });
    },
    async verify(
      challenge: PasskeyChallenge,
      credential: PasskeyCredential,
    ): Promise<{
      accountId: string;
      grant?: SecurityGrant;
      identityId?: string;
    }> {
      if (challenge.accountId !== (options.accountId ?? null))
        return invalidSecurityResponse();
      validatePasskeyCredential(credential, challenge, options.origin);
      try {
        const result = securityRecord(
          await request(
            `/api/auth/passkeys/${challenge.purpose}/verify`,
            { challengeId: challenge.challengeId, credential },
            true,
          ),
        );
        const accountId = securityId(result.accountId);
        if (options.accountId && accountId !== options.accountId)
          return invalidSecurityResponse();
        if (challenge.purpose === 'reauth')
          return {
            accountId,
            grant: parseSecurityGrant(result, accountId, challenge.action!),
          };
        if (challenge.purpose === 'add') {
          if (result.added !== true) return invalidSecurityResponse();
          return { accountId, identityId: securityId(result.identityId) };
        }
        return { accountId };
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (error instanceof AccountSecurityError && error.status) throw error;
        throw new AccountSecurityError(
          'UNCONFIRMED_VERIFICATION',
          'This identity action may have completed. Refresh saved account status before trying again.',
          0,
          true,
        );
      }
    },
  };
}
