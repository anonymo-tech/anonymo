'use client';

import { useT } from '@/lib/i18n';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Fingerprint, Info } from 'lucide-react';
import Link from '@/components/site-link';
import { MotionIcon } from './motion-icon';
import { LiveAccountSecurity } from './live-account-security';
import { SignInOptions } from './sign-in-options';
import {
  createPasskeyClient,
  getAuthCapabilities,
  performPasskeyCeremony,
} from '../../lib/client/passkeys';
import {
  AccountSecurityError,
  securityErrorMessage,
} from '../../lib/client/auth-security';
import {
  connectIdentityWallet,
  getAccountSession,
  identityErrorMessage,
  isAborted,
  isSignInWallet,
  preferredSignInMethod,
  requestWalletChallenge,
  signIdentityChallenge,
  signOutAccount,
  verifyWalletProof,
  walletSupports,
  watchWallet,
  type AccountSession,
  type StandardWallet,
  type WalletAccount,
} from '../../lib/client/service';

type Connection = {
  wallet: StandardWallet;
  accounts: WalletAccount[];
  account: WalletAccount;
};
type Availability = 'loading' | 'preview' | 'service' | 'error';
const shortAddress = (address: string) =>
  `${address.slice(0, 4)}…${address.slice(-4)}`;
const accountKey = (accounts: readonly WalletAccount[]) =>
  accounts.map((account) => account.address).join(':');

export function LiveIdentityPanel() {
  const t = useT();
  const [availability, setAvailability] = useState<Availability>('loading');
  const [session, setSession] = useState<AccountSession | null>(null);
  const [wallets, setWallets] = useState<readonly StandardWallet[]>([]);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [busy, setBusy] = useState<
    'connecting' | 'signing' | 'signing-out' | 'passkey' | null
  >(null);
  const [notice, setNotice] = useState('');
  const [passkeysEnabled, setPasskeysEnabled] = useState(false);
  const [walletEnabled, setWalletEnabled] = useState(false);
  const [securityBusy, setSecurityBusy] = useState(false);
  const [uncertainSignIn, setUncertainSignIn] = useState(false);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const connected = useRef<Connection | null>(null);
  const verifiedSession = useRef<AccountSession | null>(null);

  useLayoutEffect(() => {
    const changed = (event: Event) => {
      operation.current?.abort();
      busyRef.current = false;
      setBusy(null);
      connected.current = null;
      setConnection(null);
      setSecurityBusy(false);
      if (
        (event as CustomEvent<{ reason?: string }>).detail?.reason ===
        'wallet-changed'
      ) {
        setNeedsReauth(true);
        setNotice(
          'Your wallet changed. Sign in again before accessing private data.',
        );
        return;
      }
      verifiedSession.current = null;
      setSession(null);
      setAvailability('loading');
      setRefresh((value) => value + 1);
    };
    window.addEventListener('conclave:session-change', changed);
    return () => {
      operation.current?.abort();
      window.removeEventListener('conclave:session-change', changed);
    };
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    operation.current = controller;
    void (async () => {
      try {
        const capabilities = await getAuthCapabilities({
          signal: controller.signal,
        });
        const current =
          capabilities.wallet || capabilities.passkeys
            ? await getAccountSession({ signal: controller.signal })
            : null;
        if (controller.signal.aborted) return;
        setAvailability(
          capabilities.wallet || capabilities.passkeys ? 'service' : 'preview',
        );
        setPasskeysEnabled(capabilities.passkeys);
        setWalletEnabled(capabilities.wallet);
        setUncertainSignIn(false);
        verifiedSession.current = current;
        setSession(current);
        setNotice('');
        setNeedsReauth(false);
      } catch (error) {
        if (!controller.signal.aborted && !isAborted(error)) {
          setAvailability('error');
          setNotice(
            error instanceof AccountSecurityError
              ? securityErrorMessage(error)
              : identityErrorMessage(error),
          );
        }
      }
    })();
    return () => {
      mounted.current = false;
      controller.abort();
      operation.current?.abort();
    };
  }, [refresh]);

  useEffect(() => {
    if (availability !== 'service') return;
    let disposed = false;
    const cleanups: (() => void)[] = [];
    const walletListeners = new Map<StandardWallet, () => void>();
    const observedAccounts = new Map<StandardWallet, string>();
    const changed = (
      wallet: StandardWallet,
      accounts?: readonly WalletAccount[],
    ) => {
      const current = connected.current;
      const previous = observedAccounts.get(wallet) ?? '';
      const next = accountKey(accounts ?? wallet.accounts);
      observedAccounts.set(wallet, next);
      const addresses =
        verifiedSession.current?.identities
          .filter((identity) => identity.kind === 'solana')
          .map((identity) => identity.subject) ?? [];
      if (
        disposed ||
        (current?.wallet !== wallet &&
          !addresses.some((address) => previous.split(':').includes(address)))
      )
        return;
      if (accounts && next === previous && isSignInWallet(wallet)) return;
      operation.current?.abort();
      connected.current = null;
      setConnection(null);
      setNeedsReauth(true);
      setNotice(
        'Your wallet accounts or permissions changed. Connect and sign in again to confirm the account.',
      );
      window.dispatchEvent(
        new CustomEvent('conclave:session-change', {
          detail: { reason: 'wallet-changed' },
        }),
      );
    };
    void import('@wallet-standard/app')
      .then(({ getWallets }) => {
        if (disposed) return;
        const registry = getWallets();
        const update = () => {
          if (disposed) return;
          const available = registry.get().filter(isSignInWallet).slice(0, 32);
          for (const [wallet, off] of walletListeners) {
            if (!available.includes(wallet)) {
              off();
              walletListeners.delete(wallet);
              changed(wallet);
            }
          }
          for (const wallet of available) {
            if (!walletListeners.has(wallet)) {
              observedAccounts.set(wallet, accountKey(wallet.accounts));
              walletListeners.set(
                wallet,
                watchWallet(wallet, (accounts) => changed(wallet, accounts)),
              );
            }
          }
          setWallets(available);
        };
        cleanups.push(
          registry.on('register', update),
          registry.on('unregister', update),
        );
        update();
      })
      .catch(() => {
        if (!disposed)
          setNotice(
            'Wallet discovery is unavailable. Refresh account status to try again.',
          );
      });
    return () => {
      disposed = true;
      cleanups.forEach((off) => off());
      walletListeners.forEach((off) => off());
    };
  }, [availability]);

  function begin(nextBusy: NonNullable<typeof busy>) {
    if (
      busyRef.current ||
      securityBusy ||
      document.visibilityState !== 'visible'
    )
      return null;
    busyRef.current = true;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(nextBusy);
    setNotice('');
    return controller;
  }
  function end(controller: AbortController) {
    if (operation.current !== controller) return;
    busyRef.current = false;
    if (mounted.current) setBusy(null);
  }
  function failed(error: unknown, controller: AbortController) {
    if (mounted.current && !controller.signal.aborted && !isAborted(error))
      setNotice(identityErrorMessage(error));
  }
  async function connect(wallet: StandardWallet) {
    const controller = begin('connecting');
    if (!controller) return;
    try {
      const accounts = await connectIdentityWallet(wallet);
      if (controller.signal.aborted) return;
      const next = { wallet, accounts, account: accounts[0] };
      connected.current = next;
      setConnection(next);
      setNotice('');
    } catch (error) {
      failed(error, controller);
    } finally {
      end(controller);
    }
  }
  async function signIn(method: 'signIn' | 'signMessage') {
    const selected = connected.current;
    if (!selected) return;
    const controller = begin('signing');
    if (!controller) return;
    try {
      const challenge = await requestWalletChallenge(
        selected.account.address,
        window.location.origin,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      const proof = await signIdentityChallenge(
        selected.wallet,
        selected.account,
        challenge,
        method,
      );
      if (controller.signal.aborted) return;
      const verified = await verifyWalletProof(proof, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      verifiedSession.current = verified;
      setSession(verified);
      setNeedsReauth(false);
      setNotice('Signed in. Your identity was verified by the server.');
      window.dispatchEvent(
        new CustomEvent('conclave:session-change', {
          detail: { reason: 'signed-in' },
        }),
      );
    } catch (error) {
      failed(error, controller);
    } finally {
      end(controller);
    }
  }
  async function passkeySignIn(purpose: 'signup' | 'login') {
    if (!passkeysEnabled || session || uncertainSignIn) return;
    const controller = begin('passkey');
    if (!controller) return;
    let verificationAttempted = false;
    try {
      const client = createPasskeyClient({
        origin: window.location.origin,
        signal: controller.signal,
      });
      const challenge = await client.options(purpose);
      controller.signal.throwIfAborted();
      const credential = await performPasskeyCeremony(challenge, {
        origin: window.location.origin,
        signal: controller.signal,
      });
      verificationAttempted = true;
      const result = await client.verify(challenge, credential);
      controller.signal.throwIfAborted();
      const current = await getAccountSession({ signal: controller.signal });
      controller.signal.throwIfAborted();
      if (!current || current.accountId !== result.accountId)
        throw new AccountSecurityError(
          'SESSION_UNCONFIRMED',
          'The sign-in may have completed. Refresh account status before trying again.',
          0,
          true,
        );
      verifiedSession.current = current;
      setSession(current);
      setNeedsReauth(false);
      setNotice('Signed in with your passkey.');
      window.dispatchEvent(
        new CustomEvent('conclave:session-change', {
          detail: { reason: 'signed-in' },
        }),
      );
    } catch (error) {
      if (!controller.signal.aborted && mounted.current) {
        setNotice(securityErrorMessage(error));
        if (
          verificationAttempted ||
          (error instanceof AccountSecurityError && error.outcomeUnknown)
        )
          setUncertainSignIn(true);
      }
    } finally {
      end(controller);
    }
  }
  function refreshAfterSecurity(signedOut = false) {
    window.dispatchEvent(
      new CustomEvent('conclave:session-change', {
        detail: { reason: signedOut ? 'signed-out' : 'signed-in' },
      }),
    );
  }
  async function signOut() {
    const controller = begin('signing-out');
    if (!controller) return;
    try {
      await signOutAccount({ signal: controller.signal });
      if (controller.signal.aborted) return;
      verifiedSession.current = null;
      setSession(null);
      setNeedsReauth(false);
      connected.current = null;
      setConnection(null);
      setNotice(
        'Signed out of Conclave. Your wallet connection is managed by your wallet.',
      );
      window.dispatchEvent(
        new CustomEvent('conclave:session-change', {
          detail: { reason: 'signed-out' },
        }),
      );
    } catch (error) {
      failed(error, controller);
    } finally {
      end(controller);
    }
  }
  function selectAccount(account: WalletAccount) {
    if (!connection || busyRef.current) return;
    const next = { ...connection, account };
    connected.current = next;
    setConnection(next);
    setNotice('Sign in to verify the selected account.');
  }
  const signedAddress = session?.identities.find(
    (identity) => identity.kind === 'solana',
  )?.subject;
  const preview = availability === 'preview';

  if (!session || needsReauth) {
    return (
      <SignInOptions
        availability={availability}
        passkeysEnabled={passkeysEnabled && !session}
        walletEnabled={walletEnabled}
        wallets={wallets}
        connection={connection}
        busy={busy}
        disabled={!!busy || securityBusy || uncertainSignIn}
        notice={t(notice)}
        uncertainSignIn={uncertainSignIn}
        onConnect={(wallet) => void connect(wallet)}
        onSignIn={(method) => void signIn(method)}
        onPasskey={(purpose) => void passkeySignIn(purpose)}
        onSelectAccount={selectAccount}
        onClearConnection={() => {
          connected.current = null;
          setConnection(null);
          setNotice('');
        }}
        onRefresh={() => {
          setAvailability('loading');
          setRefresh((value) => value + 1);
        }}
      />
    );
  }

  return (
    <>
      <p className="ct-intro">
        {preview
          ? t(
              'You are exploring without an account. No wallet or passkey is connected.',
            )
          : availability === 'loading'
            ? t('Checking account availability…')
            : availability === 'error'
              ? t('Account status could not be checked.')
              : session
                ? t(
                    'Your Conclave account is signed in. Identity prompts only appear after you choose a sign-in or security action.',
                  )
                : t(
                    'Create an account or sign in with a passkey or Solana wallet. Connecting a wallet alone does not verify a session.',
                  )}
      </p>
      <div className="ct-connections">
        <div>
          <MotionIcon name="purse" size={24} />
          <span>
            <strong>{t('Solana wallet')}</strong>
            <small>
              {preview
                ? t('Signing and wallet identity are not connected.')
                : signedAddress
                  ? needsReauth
                    ? t('{address} · sign in again to confirm wallet changes', {
                        address: shortAddress(signedAddress),
                      })
                    : t('{address} · server-verified session', {
                        address: shortAddress(signedAddress),
                      })
                  : availability === 'service'
                    ? t(
                        'A sign-in message does not authorize a transaction or payment.',
                      )
                    : t('Waiting for account service status.')}
            </small>
          </span>
          {session ? (
            <button
              data-icon-trigger
              className="ct-button"
              type="button"
              disabled={!!busy || securityBusy || uncertainSignIn}
              onClick={() => void signOut()}
            >
              {busy === 'signing-out' ? t('Signing out…') : t('Sign out')}
            </button>
          ) : (
            <span className="ct-status ct-status-neutral">
              {preview
                ? t('Unavailable')
                : availability === 'loading'
                  ? t('Checking')
                  : availability === 'service'
                    ? t('Not signed in')
                    : t('Unavailable')}
            </span>
          )}
        </div>
        <div>
          <Fingerprint size={19} aria-hidden="true" />
          <span>
            <strong>{t('Passkey')}</strong>
            <small>
              {session?.identities.some(
                (identity) => identity.kind === 'passkey',
              )
                ? t('A passkey is linked to this account.')
                : passkeysEnabled
                  ? t(
                      'Create an account or use an existing passkey. No email or password is requested.',
                    )
                  : t('Passkey sign-in is not configured.')}
            </small>
          </span>
          <span className="ct-status ct-status-neutral">
            {passkeysEnabled ? t('Available') : t('Unavailable')}
          </span>
        </div>
      </div>
      {availability === 'service' && passkeysEnabled && !session && (
        <section className="ct-detail" aria-label={t('Passkey sign-in')}>
          <h3>{t('Use a passkey')}</h3>
          <p>
            {t(
              'Your browser or authenticator will ask you to confirm. If every previously enrolled wallet or passkey is lost, support cannot restore access. There is no email reset, recovery code, or manual override.',
            )}
          </p>
          <div className="ct-segments">
            <button
              className="ct-button ct-button-primary"
              type="button"
              disabled={!!busy || securityBusy || uncertainSignIn}
              onClick={() => void passkeySignIn('signup')}
            >
              {t('Create account with passkey')}
            </button>
            <button
              className="ct-button"
              type="button"
              disabled={!!busy || securityBusy || uncertainSignIn}
              onClick={() => void passkeySignIn('login')}
            >
              {t('Sign in with passkey')}
            </button>
          </div>
          {busy === 'passkey' && (
            <output>{t('Waiting for your authenticator…')}</output>
          )}
          {uncertainSignIn && (
            <p role="alert">
              {t(
                'Sign-in may have completed. Refresh account status before trying again.',
              )}
            </p>
          )}
        </section>
      )}
      {availability === 'service' && session && !needsReauth && (
        <LiveAccountSecurity
          key={session.accountId}
          session={session}
          wallets={wallets}
          passkeysEnabled={passkeysEnabled}
          disabled={!!busy}
          onBusyChange={setSecurityBusy}
          onSessionRefresh={refreshAfterSecurity}
        />
      )}
      {availability === 'service' &&
        walletEnabled &&
        (!session || needsReauth) && (
          <section className="ct-detail" aria-label={t('Wallet sign-in')}>
            {connection ? (
              <>
                <h3>{connection.wallet.name.slice(0, 80)}</h3>
                <p>
                  {t(
                    'Connected accounts are not signed in until the server verifies a signature.',
                  )}
                </p>
                <div className="ct-models" aria-label={t('Choose an account')}>
                  {connection.accounts.map((account) => (
                    <button
                      className="ct-model"
                      type="button"
                      key={account.address}
                      disabled={!!busy || securityBusy || uncertainSignIn}
                      aria-label={t('Use account {address}', {
                        address: account.address,
                      })}
                      aria-pressed={
                        connection.account.address === account.address
                      }
                      onClick={() => selectAccount(account)}
                    >
                      <span className="ct-model-name">
                        <strong>{shortAddress(account.address)}</strong>
                        <small>
                          {connection.account.address === account.address
                            ? t('Selected account')
                            : t('Use this account')}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
                <button
                  className="ct-button"
                  type="button"
                  disabled={!!busy || securityBusy || uncertainSignIn}
                  onClick={() => {
                    connected.current = null;
                    setConnection(null);
                    setNotice('Choose another wallet to connect.');
                  }}
                >
                  {t('Choose another wallet')}
                </button>
                <div className="ct-segments" aria-label={t('Sign-in method')}>
                  {walletSupports(connection.wallet, 'signIn') && (
                    <button
                      data-icon-trigger
                      className="ct-button ct-button-primary"
                      type="button"
                      disabled={!!busy || securityBusy || uncertainSignIn}
                      onClick={() => void signIn('signIn')}
                    >
                      <MotionIcon name="purse" size={20} />
                      {busy === 'signing'
                        ? t('Waiting for wallet…')
                        : t('Sign in with wallet')}
                    </button>
                  )}
                  {preferredSignInMethod(connection.wallet) ===
                    'signMessage' && (
                    <button
                      className="ct-button"
                      type="button"
                      disabled={!!busy || securityBusy || uncertainSignIn}
                      onClick={() => void signIn('signMessage')}
                    >
                      {t('Use exact-message sign-in')}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <h3>{t('Choose a wallet')}</h3>
                <p>
                  {wallets.length
                    ? t('Connect first, then approve a sign-in message.')
                    : t(
                        'No compatible Solana wallet was detected. Open this page in a wallet-enabled browser, then refresh account status.',
                      )}
                </p>
                <div
                  className="ct-models"
                  aria-label={t('Available Solana wallets')}
                >
                  {wallets.map((wallet, index) => (
                    <button
                      data-icon-trigger
                      className="ct-model"
                      type="button"
                      key={`${wallet.name}:${index}`}
                      disabled={!!busy || securityBusy || uncertainSignIn}
                      onClick={() => void connect(wallet)}
                    >
                      <MotionIcon name="purse" size={24} />
                      <span className="ct-model-name">
                        <strong>{wallet.name.slice(0, 80)}</strong>
                        <small>
                          {busy === 'connecting'
                            ? t('Waiting for wallet…')
                            : t('Connect wallet')}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </section>
        )}
      {notice && (
        <output className="ct-note">
          <Info size={14} aria-hidden="true" />
          <span>{t(notice)}</span>
        </output>
      )}
      <p className="ct-note">
        <Info size={14} aria-hidden="true" />
        <span>
          {preview
            ? t('No signature or recovery phrase is needed to use the demo.')
            : t(
                'Conclave never asks for your recovery phrase or private key. Account sign-in does not send a transaction.',
              )}
        </span>
      </p>
      {!preview && (
        <button
          className="ct-button"
          type="button"
          disabled={!!busy || securityBusy || availability === 'loading'}
          onClick={() => {
            setAvailability('loading');
            setRefresh((value) => value + 1);
          }}
        >
          {t('Refresh account status')}
        </button>
      )}
      <Link data-icon-trigger className="ct-source" href="/docs#integrations">
        {t('View integration status ')}
        <MotionIcon name="open" size={20} />
      </Link>
    </>
  );
}
