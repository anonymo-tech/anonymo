'use client';

import { useT } from '@/lib/i18n';
import { securityActionLabel } from '../../lib/auth/security';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AccountSecurityError,
  createAccountSecurityClient,
  securityErrorMessage,
  type SecurityAction,
  type SecurityGrant,
  type SecurityIdentity,
  type SecurityOverview,
} from '../../lib/client/auth-security';
import {
  createPasskeyClient,
  performPasskeyCeremony,
} from '../../lib/client/passkeys';
import {
  connectIdentityWallet,
  isAborted,
  signIdentityChallenge,
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
type Props = {
  session: AccountSession;
  wallets: readonly StandardWallet[];
  passkeysEnabled: boolean;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onSessionRefresh: (signedOut?: boolean) => void;
};
const short = (v: string) => `${v.slice(0, 6)}…${v.slice(-6)}`;
const utc = (v: string) =>
  `${new Date(v).toISOString().slice(0, 19).replace('T', ' ')} UTC`;

export function LiveAccountSecurity({
  session,
  wallets,
  passkeysEnabled,
  disabled,
  onBusyChange,
  onSessionRefresh,
}: Props) {
  const t = useT();
  const [overview, setOverview] = useState<SecurityOverview | null>(null);
  const [action, setAction] = useState<SecurityAction | null>(null);
  const [grant, setGrant] = useState<SecurityGrant | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [notice, setNotice] = useState('');
  const [expired, setExpired] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const propsRef = useRef({ onBusyChange, onSessionRefresh });
  useLayoutEffect(() => {
    propsRef.current = { onBusyChange, onSessionRefresh };
  });
  useLayoutEffect(() => {
    mounted.current = true;
    const invalidate = () => {
      operation.current?.abort();
      setGrant(null);
      setAction(null);
      setConnection(null);
      setOverview(null);
      setNotice('Account status changed. Refresh before continuing.');
    };
    window.addEventListener('conclave:session-change', invalidate);
    return () => {
      mounted.current = false;
      operation.current?.abort();
      propsRef.current.onBusyChange(false);
      window.removeEventListener('conclave:session-change', invalidate);
    };
  }, [session.accountId]);
  useEffect(() => {
    const controller = new AbortController();
    operation.current = controller;
    void createAccountSecurityClient({
      accountId: session.accountId,
      signal: controller.signal,
    })
      .overview()
      .then((value) => {
        if (!controller.signal.aborted) setOverview(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setNotice(securityErrorMessage(error));
      });
    return () => controller.abort();
  }, [session.accountId]);
  useEffect(() => {
    if (!grant) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, grant.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [grant]);
  useEffect(() => {
    if (!connection) return;
    return watchWallet(connection.wallet, (accounts) => {
      if (
        accounts?.some(
          (account) =>
            account.address === connection.account.address &&
            account.publicKey.every(
              (byte, index) => byte === connection.account.publicKey[index],
            ),
        )
      )
        return;
      operation.current?.abort();
      setConnection(null);
      setGrant(null);
      setAction(null);
      setNotice(
        'Wallet accounts or permissions changed. Choose the wallet again.',
      );
    });
  }, [connection]);
  async function run(work: (signal: AbortSignal) => Promise<void>) {
    if (busyRef.current || disabled || document.visibilityState !== 'visible')
      return;
    busyRef.current = true;
    setBusy(true);
    onBusyChange(true);
    setNotice('');
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    try {
      await work(controller.signal);
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && !isAborted(error)) {
        setNotice(securityErrorMessage(error));
        if (error instanceof AccountSecurityError && error.outcomeUnknown) {
          setUnknown(true);
          setGrant(null);
        }
        if (error instanceof AccountSecurityError && error.status === 401)
          propsRef.current.onSessionRefresh();
      }
    } finally {
      if (operation.current === controller) {
        busyRef.current = false;
        if (mounted.current) {
          setBusy(false);
          propsRef.current.onBusyChange(false);
        }
      }
    }
  }
  function choose(next: SecurityAction) {
    if (busyRef.current || unknown) return;
    setAction(next);
    setGrant(null);
    setExpired(false);
    setNotice('');
  }
  function installGrant(value: SecurityGrant, signal: AbortSignal) {
    signal.throwIfAborted();
    setGrant(value);
    setExpired(false);
    setNotice('Identity confirmed. Review the action below, then continue.');
  }
  async function refresh() {
    await run(async (signal) => {
      const value = await createAccountSecurityClient({
        accountId: session.accountId,
        signal,
      }).overview();
      signal.throwIfAborted();
      setOverview(value);
      setUnknown(false);
      setAction(null);
      setGrant(null);
      setConnection(null);
      setNotice('Saved account security status refreshed.');
      propsRef.current.onSessionRefresh();
    });
  }
  async function provePasskey() {
    if (!action) return;
    const reviewed = action;
    await run(async (signal) => {
      const client = createPasskeyClient({
        accountId: session.accountId,
        origin: window.location.origin,
        signal,
      });
      const challenge = await client.options('reauth', reviewed);
      signal.throwIfAborted();
      const credential = await performPasskeyCeremony(challenge, {
        origin: window.location.origin,
        signal,
      });
      const result = await client.verify(challenge, credential);
      signal.throwIfAborted();
      if (!result.grant)
        throw new AccountSecurityError(
          'INVALID_GRANT',
          'The approval was not confirmed. Refresh before continuing.',
        );
      installGrant(result.grant, signal);
    });
  }
  async function proveWallet(
    identity: SecurityIdentity,
    wallet: StandardWallet,
  ) {
    if (!action) return;
    const reviewed = action;
    await run(async (signal) => {
      const accounts = await connectIdentityWallet(wallet);
      signal.throwIfAborted();
      const account = accounts.find((v) => v.address === identity.subject);
      if (!account)
        throw new AccountSecurityError(
          'WALLET_MISMATCH',
          'Choose the existing wallet account shown in this review.',
        );
      const off = watchWallet(wallet, (accounts) => {
        if (
          accounts?.some(
            (value) =>
              value.address === account.address &&
              value.publicKey.every(
                (byte, index) => byte === account.publicKey[index],
              ),
          )
        )
          return;
        operation.current?.abort();
      });
      try {
        const client = createAccountSecurityClient({
          accountId: session.accountId,
          signal,
        });
        const challenge = await client.walletOptions(
          identity,
          reviewed,
          window.location.origin,
        );
        signal.throwIfAborted();
        if (document.visibilityState !== 'visible')
          throw new AccountSecurityError(
            'PAGE_HIDDEN',
            'Return to Conclave, then confirm the action again.',
          );
        const proof = await signIdentityChallenge(
          wallet,
          account,
          challenge,
          walletSupports(wallet, 'signIn') ? 'signIn' : 'signMessage',
        );
        signal.throwIfAborted();
        installGrant(await client.verifyWallet(challenge, proof), signal);
      } finally {
        off();
      }
    });
  }
  async function connectNewWallet(wallet: StandardWallet) {
    await run(async (signal) => {
      const accounts = await connectIdentityWallet(wallet);
      signal.throwIfAborted();
      setConnection({ wallet, accounts, account: accounts[0] });
      setAction(null);
      setGrant(null);
      setNotice(
        'Choose the wallet address to link, then confirm it with an existing identity.',
      );
    });
  }
  async function complete() {
    if (!grant || expired || unknown) return;
    const approved = grant;
    await run(async (signal) => {
      const client = createAccountSecurityClient({
        accountId: session.accountId,
        signal,
      });
      // Each grant is single-use. A failed or lost final response requires a saved-state read.
      setGrant(null);
      try {
        if (approved.action.kind === 'add-passkey') {
          const passkeys = createPasskeyClient({
            accountId: session.accountId,
            origin: window.location.origin,
            signal,
          });
          const challenge = await passkeys.options('add', approved);
          signal.throwIfAborted();
          const credential = await performPasskeyCeremony(challenge, {
            origin: window.location.origin,
            signal,
          });
          await passkeys.verify(challenge, credential);
        } else if (approved.action.kind === 'link-wallet') {
          const selected = connection;
          if (
            !selected ||
            selected.account.address !== approved.action.target ||
            !selected.wallet.accounts.some(
              (v) => v.address === selected.account.address,
            )
          )
            throw new AccountSecurityError(
              'WALLET_MISMATCH',
              'Choose the wallet to link again.',
            );
          const challenge = await client.linkOptions(
            approved,
            window.location.origin,
          );
          signal.throwIfAborted();
          if (document.visibilityState !== 'visible')
            throw new AccountSecurityError(
              'PAGE_HIDDEN',
              'Return to Conclave and refresh account status before continuing.',
            );
          const proof = await signIdentityChallenge(
            selected.wallet,
            selected.account,
            challenge,
            walletSupports(selected.wallet, 'signIn')
              ? 'signIn'
              : 'signMessage',
          );
          signal.throwIfAborted();
          await client.linkWallet(challenge, proof);
        } else if (approved.action.kind === 'remove-identity')
          await client.removeIdentity(approved);
        else {
          const result = await client.revokeSessions(approved);
          signal.throwIfAborted();
          if (result.signedOut) {
            propsRef.current.onSessionRefresh(true);
            return;
          }
        }
        signal.throwIfAborted();
        const value = await client.overview();
        signal.throwIfAborted();
        setOverview(value);
        setAction(null);
        setConnection(null);
        setNotice('Account security updated.');
        propsRef.current.onSessionRefresh();
      } catch (error) {
        if (!signal.aborted) setUnknown(true);
        throw error;
      }
    });
  }
  const reviewedIdentityIndex =
    action?.kind === 'remove-identity'
      ? (overview?.identities.findIndex(
          (identity) => identity.id === action.target,
        ) ?? -1)
      : -1;
  const reviewedIdentity =
    reviewedIdentityIndex >= 0
      ? overview?.identities[reviewedIdentityIndex]
      : undefined;
  const reviewedSession =
    action?.kind === 'revoke-sessions'
      ? overview?.sessions.find((row) => row.id === action.target)
      : undefined;
  function actionLabel(reviewed: SecurityAction) {
    const english = securityActionLabel(reviewed);
    if (reviewed.kind === 'link-wallet')
      return t('Link Solana wallet {address} to this Conclave account', {
        address: reviewed.target ?? '',
      });
    if (reviewed.kind === 'remove-identity')
      return t('Remove sign-in identity {id} from this Conclave account', {
        id: reviewed.target ?? '',
      });
    if (reviewed.kind === 'revoke-sessions' && reviewed.target !== 'others')
      return t('Sign out Conclave session {id}', { id: reviewed.target ?? '' });
    return t(english);
  }
  const actionTitle = !action
    ? ''
    : reviewedIdentity
      ? reviewedIdentity.kind === 'passkey'
        ? t('Remove Passkey {number}', { number: reviewedIdentityIndex + 1 })
        : t('Remove Solana wallet')
      : reviewedSession
        ? reviewedSession.current
          ? t('Sign out this session started {date}', {
              date: utc(reviewedSession.createdAt),
            })
          : t('Sign out the session started {date}', {
              date: utc(reviewedSession.createdAt),
            })
        : actionLabel(action);
  const locked = disabled || busy;
  const eligible =
    overview?.identities.filter(
      (v) => action?.kind !== 'remove-identity' || action.target !== v.id,
    ) ?? [];
  return (
    <section className="ct-detail" aria-label={t('Account security')}>
      <h3>{t('Account security')}</h3>
      <p>
        {t(
          'Keep access to another previously enrolled wallet or passkey, including a synced copy. If all enrolled credentials are lost, support cannot restore access. There is no email reset, recovery code, or manual override. Adding or removing a method signs out your other sessions.',
        )}
      </p>
      {overview ? (
        <>
          <h4>{t('Sign-in methods')}</h4>
          <ul>
            {overview.identities.map((identity, index) => (
              <li key={identity.id}>
                <strong>
                  {identity.kind === 'passkey'
                    ? t('Passkey {number}', { number: index + 1 })
                    : t('Solana wallet {address}', {
                        address: short(identity.subject),
                      })}
                </strong>{' '}
                <small>
                  {t('Added {date}', { date: utc(identity.createdAt) })}
                </small>{' '}
                <button
                  className="ct-button"
                  type="button"
                  disabled={locked || unknown || overview.identities.length < 2}
                  onClick={() =>
                    choose({ kind: 'remove-identity', target: identity.id })
                  }
                >
                  {t('Review removal')}
                </button>
              </li>
            ))}
          </ul>
          <button
            className="ct-button"
            type="button"
            disabled={
              locked ||
              unknown ||
              !passkeysEnabled ||
              overview.identities.length >= 16
            }
            onClick={() => choose({ kind: 'add-passkey', target: null })}
          >
            {t('Add passkey')}
          </button>
          {!passkeysEnabled && (
            <p>{t('Passkey enrollment is not configured.')}</p>
          )}
          <details>
            <summary>{t('Link a Solana wallet')}</summary>
            <p>
              {t(
                'Connect the new wallet, approve the link with an existing sign-in method, then prove ownership of the new wallet.',
              )}
            </p>
            <div className="ct-segments">
              {wallets.map((wallet, index) => (
                <button
                  className="ct-button"
                  type="button"
                  key={`${wallet.name}:${index}`}
                  disabled={
                    locked || unknown || overview.identities.length >= 16
                  }
                  onClick={() => void connectNewWallet(wallet)}
                >
                  {t('Connect {wallet}', { wallet: wallet.name.slice(0, 80) })}
                </button>
              ))}
            </div>
            {!wallets.length && (
              <p>{t('No compatible wallet was detected.')}</p>
            )}
            {connection && (
              <div className="ct-models">
                {connection.accounts.map((account) => (
                  <button
                    className="ct-button"
                    type="button"
                    key={account.address}
                    disabled={locked || unknown}
                    onClick={() => {
                      setConnection({ ...connection, account });
                      choose({ kind: 'link-wallet', target: account.address });
                    }}
                  >
                    {t('Review linking {address}', {
                      address: short(account.address),
                    })}
                  </button>
                ))}
              </div>
            )}
          </details>
          <h4>{t('Sessions')}</h4>
          <ul>
            {overview.sessions.map((row) => (
              <li key={row.id}>
                <strong>
                  {row.current ? t('This session') : t('Other session')}
                </strong>{' '}
                <small>
                  {t('Started {started} · Expires {expires}', {
                    started: utc(row.createdAt),
                    expires: utc(row.expiresAt),
                  })}
                </small>{' '}
                <button
                  className="ct-button"
                  type="button"
                  disabled={locked || unknown}
                  onClick={() =>
                    choose({ kind: 'revoke-sessions', target: row.id })
                  }
                >
                  {t('Review sign-out')}
                </button>
              </li>
            ))}
          </ul>
          {overview.moreSessions && (
            <p>
              {t(
                'Showing the 50 most recent sessions. “Sign out other sessions” also covers older sessions.',
              )}
            </p>
          )}
          <button
            className="ct-button"
            type="button"
            disabled={locked || unknown}
            onClick={() =>
              choose({ kind: 'revoke-sessions', target: 'others' })
            }
          >
            {t('Sign out other sessions')}
          </button>
        </>
      ) : (
        <p>{t('Account security details have not loaded.')}</p>
      )}
      {action && !unknown && (
        <section className="ct-detail" aria-label={t('Review account action')}>
          <h4>{actionTitle}</h4>
          {reviewedIdentity && (
            <p>
              {reviewedIdentity.kind === 'solana' && (
                <>
                  <code>
                    {reviewedIdentity.subject.slice(0, 22)}
                    <wbr />
                    {reviewedIdentity.subject.slice(22)}
                  </code>
                  <br />
                </>
              )}
              {t('Added {date}', { date: utc(reviewedIdentity.createdAt) })}
            </p>
          )}
          {action.kind === 'remove-identity' && (
            <p>
              {t(
                'This method will no longer sign in. Confirm using a different method that remains on the account.',
              )}
            </p>
          )}
          {grant && !expired ? (
            <>
              <p>
                {t(
                  'Identity confirmed until {date}. This approval applies only to the action above.',
                  { date: utc(new Date(grant.expiresAt).toISOString()) },
                )}
              </p>
              <button
                className="ct-button ct-button-primary"
                type="button"
                disabled={locked}
                onClick={() => void complete()}
              >
                {action.kind === 'add-passkey'
                  ? t('Create the new passkey')
                  : action.kind === 'link-wallet'
                    ? t('Confirm with the new wallet')
                    : action.kind === 'remove-identity'
                      ? t('Remove this sign-in method')
                      : t('Sign out reviewed sessions')}
              </button>
            </>
          ) : (
            <>
              <p>
                {expired
                  ? t(
                      'Approval expired. Confirm again with an existing identity.',
                    )
                  : t('Confirm this action with an existing sign-in method.')}
              </p>
              {passkeysEnabled &&
                eligible.some((v) => v.kind === 'passkey') && (
                  <button
                    className="ct-button"
                    type="button"
                    disabled={locked}
                    onClick={() => void provePasskey()}
                  >
                    {t('Confirm with existing passkey')}
                  </button>
                )}
              {eligible
                .filter((v) => v.kind === 'solana')
                .map((identity) => (
                  <div key={identity.id}>
                    <p>
                      {t('Existing wallet {address}', {
                        address: identity.subject,
                      })}
                    </p>
                    {wallets.map((wallet, index) => (
                      <button
                        className="ct-button"
                        type="button"
                        disabled={locked}
                        key={`${wallet.name}:${index}`}
                        onClick={() => void proveWallet(identity, wallet)}
                      >
                        {t('Confirm in {wallet}', {
                          wallet: wallet.name.slice(0, 80),
                        })}
                      </button>
                    ))}
                  </div>
                ))}
            </>
          )}
          <button
            className="ct-button"
            type="button"
            disabled={locked}
            onClick={() => {
              setAction(null);
              setGrant(null);
            }}
          >
            {t('Cancel action')}
          </button>
        </section>
      )}
      {unknown && (
        <p role="alert">
          {t(
            'The last action may have completed. Read the saved security status before starting another action.',
          )}
        </p>
      )}
      {notice && <output className="ct-note">{t(notice)}</output>}
      {busy && (
        <output>{t('Waiting for your account or authenticator…')}</output>
      )}
      <button
        className="ct-button"
        type="button"
        disabled={locked}
        onClick={() => void refresh()}
      >
        {t('Refresh security status')}
      </button>
    </section>
  );
}
