'use client';

import { useT } from '@/lib/i18n';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  Fingerprint,
  Info,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import Image from 'next/image';
import './account-dialog.css';
import { LiveAccountSecurity } from './live-account-security';
import { formatAccountUsd6 } from '../../lib/client/account-records';
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

function WalletMark({ wallet }: { wallet: StandardWallet }) {
  const icon =
    typeof wallet.icon === 'string' &&
    wallet.icon.length <= 90000 &&
    /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(
      wallet.icon,
    )
      ? wallet.icon
      : null;
  return (
    <span className="ca-provider-mark">
      {icon ? (
        <Image src={icon} alt="" width={28} height={28} unoptimized />
      ) : (
        <Wallet size={23} aria-hidden="true" />
      )}
    </span>
  );
}

export function LiveIdentityPanel({ onClose }: { onClose?: () => void }) {
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
  const [method, setMethod] = useState<'wallet' | 'passkey'>('wallet');
  const [pendingWalletName, setPendingWalletName] = useState('');
  const [welcomeCredit, setWelcomeCredit] = useState<{
    accountId: string;
    amountUsd6: string;
  } | null>(null);
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
        setWelcomeCredit((credit) =>
          credit?.accountId === current?.accountId ? credit : null,
        );
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
      setNotice('Wallet connected. Confirm sign-in to continue.');
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
      setWelcomeCredit(
        verified.welcomeCredit
          ? {
              accountId: verified.accountId,
              amountUsd6: verified.welcomeCredit.amountUsd6,
            }
          : null,
      );
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
  const locked = !!busy || securityBusy || uncertainSignIn;
  const activeMethod =
    session || !passkeysEnabled
      ? 'wallet'
      : !walletEnabled && passkeysEnabled
        ? 'passkey'
        : method;
  const refreshStatus = () => {
    setAvailability('loading');
    setRefresh((value) => value + 1);
  };

  return (
    <section
      className="ca-panel"
      aria-label={t('Account access')}
      aria-busy={availability === 'loading' || !!busy}
    >
      {session ? (
        <div className="ca-session">
          <span className="ca-method-icon">
            {signedAddress ? (
              <Image
                src="/brand/providers/solana.svg"
                alt="Solana"
                width={27}
                height={24}
              />
            ) : (
              <Fingerprint size={27} />
            )}
          </span>
          <span>
            <strong>
              {signedAddress
                ? shortAddress(signedAddress)
                : t('Passkey account')}
            </strong>
            <small>
              {needsReauth
                ? t('Confirm your wallet change')
                : t('Signed in to Conclave')}
            </small>
          </span>
          <button
            className="ca-text-button"
            type="button"
            disabled={locked}
            onClick={() => void signOut()}
          >
            {busy === 'signing-out' ? t('Signing out…') : t('Sign out')}
          </button>
        </div>
      ) : preview ? (
        <div className="ca-preview">
          <div
            className="ca-preview-methods"
            aria-label={t('Account sign-in methods')}
          >
            <span>
              <Image
                src="/brand/providers/solana.svg"
                alt=""
                width={19}
                height={17}
              />
              {t('Solana wallet')}
            </span>
            <span>
              <Fingerprint size={19} aria-hidden="true" />
              {t('Passkey')}
            </span>
          </div>
          <p className="ca-intro">
            {t(
              'Sign-in is unavailable in this preview. You can keep exploring the tools.',
            )}
          </p>
        </div>
      ) : availability === 'loading' ? (
        <output className="ca-loading">
          <LoaderCircle className="ca-spinner" size={19} aria-hidden="true" />
          {t('Checking your sign-in options…')}
        </output>
      ) : null}

      {availability === 'service' &&
        passkeysEnabled &&
        !session &&
        activeMethod === 'passkey' && (
          <section className="ca-step" aria-label={t('Passkey sign-in')}>
            <div className="ca-passkey-heading">
              <span className="ca-method-icon">
                <Fingerprint size={25} aria-hidden="true" />
              </span>
              <p>{t('Use Face ID, your fingerprint or a security key.')}</p>
            </div>
            <button
              className="ca-button ca-primary"
              type="button"
              disabled={locked}
              onClick={() => void passkeySignIn('login')}
            >
              {busy === 'passkey' ? (
                <LoaderCircle className="ca-spinner" size={17} />
              ) : (
                <Fingerprint size={18} />
              )}
              {busy === 'passkey'
                ? t('Waiting for your authenticator…')
                : t('Sign in with passkey')}
            </button>
            <button
              className="ca-button ca-secondary"
              type="button"
              disabled={locked}
              onClick={() => void passkeySignIn('signup')}
            >
              {t('Create an account with a passkey')}
              <ArrowRight size={16} />
            </button>
            <p className="ca-recovery">
              {t(
                'Keep another enrolled wallet or synced passkey. If you lose every sign-in method, we cannot restore access.',
              )}
            </p>
          </section>
        )}

      {availability === 'service' &&
        walletEnabled &&
        (!session || needsReauth) &&
        activeMethod === 'wallet' && (
          <section className="ca-step" aria-label={t('Wallet sign-in')}>
            {connection ? (
              <>
                <div className="ca-step-heading">
                  <h3>{connection.wallet.name.slice(0, 80)}</h3>
                  <span>{t('Confirm sign-in')}</span>
                </div>
                <div
                  className="ca-account-list"
                  aria-label={t('Choose an account')}
                >
                  {connection.accounts.map((account) => (
                    <button
                      className="ca-account-row"
                      type="button"
                      key={account.address}
                      disabled={locked}
                      aria-label={t('Use account {address}', {
                        address: account.address,
                      })}
                      aria-pressed={
                        connection.account.address === account.address
                      }
                      onClick={() => selectAccount(account)}
                    >
                      <WalletMark wallet={connection.wallet} />
                      <span>
                        <strong>{shortAddress(account.address)}</strong>
                        <small>
                          {connection.account.address === account.address
                            ? t('Selected account')
                            : t('Choose this account')}
                        </small>
                      </span>
                      {connection.account.address === account.address && (
                        <Check size={17} />
                      )}
                    </button>
                  ))}
                </div>
                <p className="ca-step-note">
                  {t(
                    'Approve a sign-in message in your wallet. This does not send a transaction.',
                  )}
                </p>
                <div
                  className="ca-signing-actions"
                  aria-label={t('Sign-in method')}
                >
                  {walletSupports(connection.wallet, 'signIn') && (
                    <button
                      className="ca-button ca-primary"
                      type="button"
                      disabled={locked}
                      onClick={() => void signIn('signIn')}
                    >
                      {busy === 'signing' ? (
                        <LoaderCircle className="ca-spinner" size={17} />
                      ) : (
                        <ShieldCheck size={17} />
                      )}
                      {busy === 'signing'
                        ? t('Waiting for your wallet…')
                        : t('Confirm sign-in')}
                    </button>
                  )}
                  {preferredSignInMethod(connection.wallet) ===
                    'signMessage' && (
                    <button
                      className="ca-button ca-primary"
                      type="button"
                      disabled={locked}
                      onClick={() => void signIn('signMessage')}
                    >
                      {busy === 'signing' ? (
                        <LoaderCircle className="ca-spinner" size={17} />
                      ) : (
                        <ShieldCheck size={17} />
                      )}
                      {busy === 'signing'
                        ? t('Waiting for your wallet…')
                        : t('Sign in with a message')}
                    </button>
                  )}
                </div>
                <button
                  className="ca-text-button ca-change-wallet"
                  type="button"
                  disabled={locked}
                  onClick={() => {
                    connected.current = null;
                    setConnection(null);
                    setNotice('Choose another wallet to connect.');
                  }}
                >
                  {t('Choose another wallet')}
                </button>
              </>
            ) : (
              <>
                <div className="ca-step-heading">
                  <h3 className="ca-network">
                    <Image
                      src="/brand/providers/solana.svg"
                      alt=""
                      width={17}
                      height={15}
                    />
                    Solana
                  </h3>
                  {wallets.length > 0 && <span>{t('Choose a wallet')}</span>}
                </div>
                {wallets.length ? (
                  <div
                    className="ca-wallet-list"
                    aria-label={t('Available Solana wallets')}
                  >
                    {wallets.map((wallet, index) => (
                      <button
                        className="ca-wallet-row"
                        type="button"
                        key={`${wallet.name}:${index}`}
                        disabled={locked}
                        onClick={() => {
                          setPendingWalletName(wallet.name);
                          void connect(wallet);
                        }}
                      >
                        <WalletMark wallet={wallet} />
                        <span>
                          <strong>{wallet.name.slice(0, 80)}</strong>
                          {busy === 'connecting' &&
                            pendingWalletName === wallet.name && (
                              <small>{t('Waiting for your wallet…')}</small>
                            )}
                        </span>
                        {busy === 'connecting' &&
                        pendingWalletName === wallet.name ? (
                          <LoaderCircle className="ca-spinner" size={17} />
                        ) : (
                          <ArrowRight size={16} />
                        )}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="ca-empty-wallet">
                    <Wallet size={21} aria-hidden="true" />
                    <div>
                      <strong>{t('No wallet detected')}</strong>
                      <p>
                        {t(
                          'Open this page in your wallet’s browser, or enable your browser wallet and refresh.',
                        )}
                      </p>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        )}

      {availability === 'service' &&
        !session &&
        walletEnabled &&
        passkeysEnabled && (
          <div className="ca-alternative">
            <button
              className="ca-text-button ca-method-switch"
              type="button"
              disabled={locked}
              onClick={() =>
                setMethod(activeMethod === 'wallet' ? 'passkey' : 'wallet')
              }
            >
              {activeMethod === 'wallet' ? (
                <Fingerprint size={17} aria-hidden="true" />
              ) : (
                <Wallet size={17} aria-hidden="true" />
              )}
              {activeMethod === 'wallet'
                ? t('Use a passkey instead')
                : t('Use a wallet instead')}
            </button>
          </div>
        )}

      {uncertainSignIn ? (
        <p className="ca-notice" role="alert">
          <Info size={16} />
          <span>
            {t(
              'Sign-in may have completed. Refresh your account status before trying again.',
            )}
          </span>
        </p>
      ) : (
        notice && (
          <output className="ca-notice">
            <Info size={16} />
            <span>{t(notice)}</span>
          </output>
        )
      )}

      {session && welcomeCredit?.accountId === session.accountId && (
        <output className="ca-notice">
          <Check size={16} aria-hidden="true" />
          <span>
            {t(
              'Welcome! {amount} USD in usage credit is ready for your model requests.',
              {
                amount: formatAccountUsd6(welcomeCredit.amountUsd6),
              },
            )}
          </span>
        </output>
      )}

      {availability === 'service' && session && !needsReauth && (
        <div className="ca-security">
          <LiveAccountSecurity
            key={session.accountId}
            session={session}
            wallets={wallets}
            passkeysEnabled={passkeysEnabled}
            disabled={!!busy}
            onBusyChange={setSecurityBusy}
            onSessionRefresh={refreshAfterSecurity}
          />
        </div>
      )}

      <footer className="ca-footer">
        {preview ? (
          <button
            className="ca-button ca-primary"
            type="button"
            onClick={onClose}
          >
            {t('Continue exploring')}
            <ArrowRight size={16} />
          </button>
        ) : (
          <>
            {availability === 'service' && !session && (
              <p className="ca-privacy">
                <ShieldCheck size={14} />
                {t('Never share your recovery phrase or private key.')}
              </p>
            )}
            <div className="ca-footer-actions">
              <button
                className="ca-text-button"
                type="button"
                disabled={!!busy || securityBusy || availability === 'loading'}
                onClick={refreshStatus}
              >
                <RefreshCw size={14} />
                {availability === 'error'
                  ? t('Try again')
                  : t('Refresh account status')}
              </button>
              {onClose && (
                <button
                  className="ca-text-button"
                  type="button"
                  onClick={onClose}
                >
                  {session ? t('Close') : t('Continue exploring')}
                </button>
              )}
            </div>
          </>
        )}
      </footer>
    </section>
  );
}
