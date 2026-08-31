import bs58 from 'bs58';
import type { getWallets } from '@wallet-standard/app';
import type {
  StandardConnectFeature,
  StandardEventsFeature,
} from '@wallet-standard/features';
import type {
  SolanaSignInFeature,
  SolanaSignMessageFeature,
} from '@solana/wallet-standard-features';

export type StandardWallet = ReturnType<
  ReturnType<typeof getWallets>['get']
>[number];
export type WalletAccount = StandardWallet['accounts'][number];
export type AccountSession = {
  accountId: string;
  identities: { kind: 'solana' | 'passkey'; subject: string }[];
};
export type IdentityCapabilities = { configured: boolean };
export type WalletChallenge = {
  id: string;
  purpose: 'sign-in';
  address: string;
  origin: string;
  message: string;
  expiresAt: number;
  input: {
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
};
export type WalletSignInMethod = 'signIn' | 'signMessage';
export type WalletProof = {
  challengeId: string;
  address: string;
  signatureType: 'ed25519';
  signatureBase64: string;
  signedMessageBase64: string;
  publicKeyBase64: string;
  method: WalletSignInMethod;
  signInSupported: boolean;
};
type Fetcher = typeof fetch;
type RequestOptions = { signal?: AbortSignal; fetch?: Fetcher };
const statement =
  'Sign in to Conclave. This does not authorize a transaction or payment.';
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class IdentityError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
    this.status = status;
  }
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function invalidResponse(): never {
  throw new IdentityError(
    'INVALID_RESPONSE',
    'The account service returned an invalid response. Try again.',
  );
}
export function identityErrorMessage(error: unknown) {
  return error instanceof IdentityError
    ? error.message
    : 'The wallet request did not complete. You can try again when ready.';
}
export function isAborted(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

async function request(
  path: string,
  body: unknown,
  options: RequestOptions,
) {
  const fetcher = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetcher(`/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      mode: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: options.signal,
      headers:
        body === undefined
          ? { Accept: 'application/json' }
          : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (isAborted(error)) throw error;
    throw new IdentityError(
      'NETWORK_ERROR',
      'The account service could not be reached. Try again.',
    );
  }
  if (
    response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    invalidResponse();
  const reader = response.body?.getReader();
  if (!reader) invalidResponse();
  let text = '',
    size = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) {
        await reader.cancel();
        invalidResponse();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (isAborted(error) || error instanceof IdentityError) throw error;
    invalidResponse();
  } finally {
    reader.releaseLock();
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    invalidResponse();
  }
  if (!response.ok) {
    const code = record(record(data)?.error)?.code;
    const safeCode =
      typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code)
        ? code
        : 'REQUEST_FAILED';
    const message =
      response.status === 401
        ? 'Your sign-in could not be verified. Connect and sign in again.'
        : response.status === 429
          ? 'Too many sign-in requests. Wait a moment and try again.'
          : response.status === 403
            ? 'This account request was not allowed. Check the workspace address and try again.'
            : response.status === 503
              ? 'Account services are not available for this workspace right now.'
              : 'The account request could not be completed. Try again.';
    throw new IdentityError(safeCode, message, response.status);
  }
  return data;
}

export async function getIdentityCapabilities(
  options: RequestOptions = {},
): Promise<IdentityCapabilities> {
  const data = record(await request('capabilities', undefined, options)),
    wallet = record(data?.walletSignIn);
  if (
    (data?.mode !== 'preview' && data?.mode !== 'service') ||
    typeof wallet?.configured !== 'boolean' ||
    (wallet.configured &&
      (wallet.format !== 'siws' ||
        !Array.isArray(wallet.formats) ||
        !wallet.formats.includes('siws')))
  )
    invalidResponse();
  return { configured: data.mode === 'service' && wallet.configured };
}
export async function getAccountSession(
  options: RequestOptions = {},
): Promise<AccountSession | null> {
  let data: Record<string, unknown> | null;
  try {
    data = record(await request('auth/session', undefined, options));
  } catch (error) {
    if (error instanceof IdentityError && error.status === 401) return null;
    throw error;
  }
  if (
    typeof data?.accountId !== 'string' ||
    !uuid.test(data.accountId) ||
    !Array.isArray(data.identities) ||
    data.identities.length > 64
  )
    invalidResponse();
  const identities = data.identities.map(
    (value): AccountSession['identities'][number] => {
      const identity = record(value);
      if (
        (identity?.kind !== 'solana' && identity?.kind !== 'passkey') ||
        typeof identity.subject !== 'string' ||
        !identity.subject.length ||
        identity.subject.length > (identity.kind === 'passkey' ? 1366 : 44)
      )
        invalidResponse();
      if (identity.kind === 'solana' && !validAddress(identity.subject))
        invalidResponse();
      if (identity.kind === 'passkey') {
        if (!/^[A-Za-z0-9_-]+$/.test(identity.subject)) invalidResponse();
        try {
          const decoded = atob(
            identity.subject.replace(/-/g, '+').replace(/_/g, '/'),
          );
          const canonical = btoa(decoded)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
          if (
            !decoded.length ||
            decoded.length > 1024 ||
            canonical !== identity.subject
          )
            invalidResponse();
        } catch {
          invalidResponse();
        }
      }
      return { kind: identity.kind, subject: identity.subject };
    },
  );
  return { accountId: data.accountId, identities };
}
export async function requestWalletChallenge(
  address: string,
  origin: string,
  options: RequestOptions = {},
) {
  const data = record(await request('auth/challenge', { address }, options));
  return validateWalletChallenge(data?.challenge, address, origin);
}
export async function verifyWalletProof(
  proof: WalletProof,
  options: RequestOptions = {},
) {
  const data = record(await request('auth/verify', proof, options));
  if (typeof data?.accountId !== 'string' || !uuid.test(data.accountId))
    invalidResponse();
  const session = await getAccountSession(options);
  if (
    !session ||
    session.accountId !== data.accountId ||
    !session.identities.some(
      (identity) =>
        identity.kind === 'solana' && identity.subject === proof.address,
    )
  ) {
    throw new IdentityError(
      'SESSION_NOT_CONFIRMED',
      'The server session could not be confirmed. Refresh account status before continuing.',
    );
  }
  return session;
}
export async function signOutAccount(options: RequestOptions = {}) {
  try {
    const result = record(await request('auth/logout', {}, options));
    if (result?.signedOut !== true) invalidResponse();
  } catch (error) {
    if (!(error instanceof IdentityError && error.status === 401)) throw error;
  }
}

function validAddress(address: string) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
  try {
    const bytes = bs58.decode(address);
    return bytes.length === 32 && bs58.encode(bytes) === address;
  } catch {
    return false;
  }
}
function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++)
    if (a[index] !== b[index]) return false;
  return true;
}
function base64(value: ArrayLike<number>) {
  return btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(''));
}
function feature(
  wallet: StandardWallet,
  name: `${string}:${string}`,
  method: string,
) {
  const value = record(wallet.features[name]);
  return value && typeof value[method] === 'function' ? value : null;
}
export function walletSupports(
  wallet: StandardWallet,
  method: 'signIn' | 'signMessage',
) {
  return !!feature(wallet, `solana:${method}`, method);
}
/** Sign In With Solana when the wallet offers it; exact-message signing otherwise. */
export function preferredSignInMethod(
  wallet: StandardWallet,
): WalletSignInMethod {
  return walletSupports(wallet, 'signIn') ? 'signIn' : 'signMessage';
}
export function isSignInWallet(wallet: StandardWallet) {
  return (
    !!wallet &&
    typeof wallet.name === 'string' &&
    wallet.name.length > 0 &&
    wallet.name.length <= 80 &&
    Array.isArray(wallet.chains) &&
    wallet.chains.some(
      (chain) => typeof chain === 'string' && chain.startsWith('solana:'),
    ) &&
    !!record(wallet.features) &&
    !!feature(wallet, 'standard:connect', 'connect') &&
    !!feature(wallet, 'standard:events', 'on') &&
    (walletSupports(wallet, 'signIn') || walletSupports(wallet, 'signMessage'))
  );
}
export function solanaAccounts(accounts: readonly unknown[]): WalletAccount[] {
  if (!Array.isArray(accounts) || accounts.length > 32)
    throw new IdentityError(
      'INVALID_WALLET',
      'This wallet returned an unsupported account list.',
    );
  return accounts.filter((value): value is WalletAccount => {
    const account = record(value);
    return (
      !!account &&
      typeof account.address === 'string' &&
      validAddress(account.address) &&
      account.publicKey instanceof Uint8Array &&
      account.publicKey.length === 32 &&
      bs58.encode(account.publicKey) === account.address &&
      Array.isArray(account.chains) &&
      account.chains.some(
        (chain) => typeof chain === 'string' && chain.startsWith('solana:'),
      ) &&
      Array.isArray(account.features)
    );
  });
}
export function watchWallet(
  wallet: StandardWallet,
  listener: (accounts?: readonly WalletAccount[]) => void,
) {
  const events = wallet.features[
    'standard:events'
  ] as StandardEventsFeature['standard:events'];
  return events.on('change', (change) => {
    if (change.accounts || change.chains || change.features)
      listener(change.accounts);
  });
}
export async function connectIdentityWallet(wallet: StandardWallet) {
  if (!isSignInWallet(wallet))
    throw new IdentityError(
      'UNSUPPORTED_WALLET',
      'Choose a Solana wallet that supports message sign-in.',
    );
  const connect = wallet.features[
    'standard:connect'
  ] as StandardConnectFeature['standard:connect'];
  const result = await connect.connect();
  const accounts = solanaAccounts(result.accounts);
  if (!accounts.length)
    throw new IdentityError(
      'NO_SOLANA_ACCOUNT',
      'The wallet did not share a Solana account. Connect again when ready.',
    );
  return accounts;
}

export function validateWalletChallenge(
  value: unknown,
  address: string,
  origin: string,
): WalletChallenge {
  const challenge = record(value),
    input = record(challenge?.input);
  if (
    !challenge ||
    !input ||
    typeof challenge.id !== 'string' ||
    !uuid.test(challenge.id) ||
    challenge.purpose !== 'sign-in' ||
    challenge.address !== address ||
    challenge.origin !== origin ||
    !validAddress(address) ||
    typeof challenge.message !== 'string' ||
    challenge.message.length > 2048 ||
    !Number.isSafeInteger(challenge.expiresAt) ||
    Number(challenge.expiresAt) <= Date.now() ||
    Number(challenge.expiresAt) > Date.now() + 600_000 ||
    input.address !== address ||
    input.domain !== new URL(origin).host ||
    input.uri !== `${origin}/` ||
    input.statement !== statement ||
    input.version !== '1' ||
    input.requestId !== challenge.id ||
    typeof input.nonce !== 'string' ||
    !/^[a-f0-9]{32}$/.test(input.nonce) ||
    typeof input.issuedAt !== 'string' ||
    typeof input.expirationTime !== 'string' ||
    !Number.isFinite(Date.parse(input.issuedAt)) ||
    Date.parse(input.issuedAt) > Date.now() + 30_000 ||
    Date.parse(input.expirationTime) !== challenge.expiresAt ||
    Date.parse(input.expirationTime) <= Date.parse(input.issuedAt) ||
    Date.parse(input.expirationTime) - Date.parse(input.issuedAt) > 600_000
  )
    invalidResponse();
  const expected = `${input.domain} wants you to sign in with your Solana account:\n${address}\n\n${statement}\n\nURI: ${input.uri}\nVersion: 1\nNonce: ${input.nonce}\nIssued At: ${input.issuedAt}\nExpiration Time: ${input.expirationTime}\nRequest ID: ${challenge.id}`;
  if (challenge.message !== expected) invalidResponse();
  return challenge as WalletChallenge;
}

export async function signIdentityChallenge(
  wallet: StandardWallet,
  account: WalletAccount,
  challenge: Pick<WalletChallenge, 'id' | 'address' | 'message' | 'input'>,
  method: WalletSignInMethod,
): Promise<WalletProof> {
  const signInSupported = walletSupports(wallet, 'signIn');
  // The server refuses exact-message proofs from wallets that offer signIn.
  if (
    !walletSupports(wallet, method) ||
    (method === 'signMessage' && signInSupported) ||
    !solanaAccounts([account]).length ||
    account.address !== challenge.address
  ) {
    throw new IdentityError(
      'UNSUPPORTED_WALLET',
      'This wallet cannot sign in with the selected account and method.',
    );
  }
  const expected = new TextEncoder().encode(challenge.message);
  const outputs =
    method === 'signIn'
      ? await (
          wallet.features[
            'solana:signIn'
          ] as SolanaSignInFeature['solana:signIn']
        ).signIn(challenge.input)
      : await (
          wallet.features[
            'solana:signMessage'
          ] as SolanaSignMessageFeature['solana:signMessage']
        ).signMessage({ account, message: expected });
  const output =
    Array.isArray(outputs) && outputs.length === 1 ? outputs[0] : null;
  const returnedAccount =
    output && 'account' in output
      ? solanaAccounts([output.account])[0]
      : account;
  if (
    !output ||
    (method === 'signIn' && !('account' in output)) ||
    !(output.signedMessage instanceof Uint8Array) ||
    !sameBytes(output.signedMessage, expected) ||
    !(output.signature instanceof Uint8Array) ||
    output.signature.length !== 64 ||
    (output.signatureType !== undefined &&
      output.signatureType !== 'ed25519') ||
    ('signedMessageFormat' in output &&
      output.signedMessageFormat !== undefined) ||
    !returnedAccount ||
    returnedAccount.address !== account.address ||
    !sameBytes(returnedAccount.publicKey, account.publicKey)
  ) {
    throw new IdentityError(
      'WALLET_PROOF_MISMATCH',
      'The wallet returned a different account or message format. Nothing was verified.',
    );
  }
  return {
    challengeId: challenge.id,
    address: account.address,
    signatureType: 'ed25519',
    signatureBase64: base64(output.signature),
    signedMessageBase64: base64(output.signedMessage),
    publicKeyBase64: base64(account.publicKey),
    method,
    signInSupported,
  };
}
