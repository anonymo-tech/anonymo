'use client';

import { useT } from '@/lib/i18n';
import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import {
  ArrowLeft,
  ArrowRight,
  Fingerprint,
  LoaderCircle,
  Wallet,
} from 'lucide-react';
import {
  preferredSignInMethod,
  type StandardWallet,
  type WalletAccount,
} from '../../lib/client/service';
import { walletChoices, type WalletChoice } from './wallet-options';

type Props = {
  availability: 'loading' | 'preview' | 'service' | 'error';
  passkeysEnabled: boolean;
  walletEnabled: boolean;
  wallets: readonly StandardWallet[];
  connection: {
    wallet: StandardWallet;
    accounts: WalletAccount[];
    account: WalletAccount;
  } | null;
  busy: string | null;
  disabled: boolean;
  notice: string;
  uncertainSignIn: boolean;
  onConnect: (wallet: StandardWallet) => void;
  onSignIn: (method: 'signIn' | 'signMessage') => void;
  onPasskey: (purpose: 'signup' | 'login') => void;
  onSelectAccount: (account: WalletAccount) => void;
  onClearConnection: () => void;
  onRefresh: () => void;
};

export function SignInOptions(props: Props) {
  const t = useT();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [step, setStep] = useState<'choose' | 'passkey' | 'wallet' | 'connect'>(
    'choose',
  );
  const [selected, setSelected] = useState<WalletChoice | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const choices = walletChoices(props.wallets);
  const waiting = props.availability === 'loading';
  const blocked = props.disabled || waiting || props.availability === 'error';
  const choice = props.connection
    ? choices.find((item) => item.wallet === props.connection?.wallet)
    : (choices.find((item) => item.name === selected?.name) ?? selected);
  const title =
    step === 'choose'
      ? mode === 'login'
        ? t('Welcome back')
        : t('Create an account')
      : step === 'passkey'
        ? mode === 'login'
          ? t('Use your passkey')
          : t('Create a passkey')
        : step === 'wallet'
          ? t('Choose a wallet')
          : t('Continue with {name}', { name: choice?.name ?? t('wallet') });

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [step, mode]);

  function back() {
    props.onClearConnection();
    setSelected(null);
    setStep(step === 'connect' ? 'wallet' : 'choose');
  }

  return (
    <section className="signin-options" aria-label={t('Sign in')}>
      {step !== 'choose' && (
        <button
          className="signin-back"
          type="button"
          aria-label={t('Back')}
          disabled={props.disabled}
          onClick={back}
        >
          <ArrowLeft size={19} />
        </button>
      )}
      {step === 'connect' && choice?.logo && (
        <Image
          className="signin-selected-logo"
          src={choice.logo}
          alt=""
          width={44}
          height={44}
          unoptimized
        />
      )}
      <h2 id="signin-title" ref={heading} tabIndex={-1}>
        {title}
      </h2>
      {step === 'choose' && (
        <>
          <div className="signin-actions">
            <button
              className="signin-action signin-primary"
              type="button"
              disabled={blocked}
              onClick={() => setStep('passkey')}
            >
              <Fingerprint size={20} />
              {t('Continue with passkey')}
            </button>
            <button
              className="signin-action"
              type="button"
              disabled={blocked}
              onClick={() => setStep('wallet')}
            >
              <Wallet size={20} />
              {t('Continue with wallet')}
            </button>
          </div>
          <p className="signin-switch">
            {mode === 'login' ? t('New to Conclave?') : t('Have an account?')}{' '}
            <button
              type="button"
              disabled={props.disabled}
              onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}
            >
              {mode === 'login' ? t('Sign up') : t('Sign in')}
            </button>
          </p>
        </>
      )}
      {step === 'passkey' && (
        <>
          <p className="signin-helper">
            {props.passkeysEnabled
              ? t('Use Face ID, Touch ID, or your device PIN.')
              : t('Passkey sign-in is not available yet.')}
          </p>
          {mode === 'signup' && props.passkeysEnabled && (
            <p className="signin-helper">
              {t(
                'Keep access to your passkey. There is no email reset if all linked sign-in methods are lost.',
              )}
            </p>
          )}
          <button
            className="signin-action signin-primary"
            type="button"
            disabled={blocked || !props.passkeysEnabled}
            onClick={() => props.onPasskey(mode)}
          >
            <Fingerprint size={20} />
            {props.busy === 'passkey'
              ? t('Waiting for your device…')
              : t('Continue')}
          </button>
        </>
      )}
      {step === 'wallet' && (
        <div className="signin-wallets">
          {choices.map((item, index) => (
            <button
              className="signin-wallet"
              type="button"
              key={`${item.name}:${index}`}
              disabled={blocked}
              onClick={() => {
                setSelected(item);
                setStep('connect');
                if (props.walletEnabled && item.wallet)
                  props.onConnect(item.wallet);
              }}
            >
              {item.logo && (
                <Image
                  src={item.logo}
                  alt=""
                  width={30}
                  height={30}
                  unoptimized
                />
              )}
              <span>{item.name}</span>
              <ArrowRight size={16} />
            </button>
          ))}
        </div>
      )}
      {step === 'connect' && (
        <>
          {props.connection ? (
            <>
              <div
                className="signin-accounts"
                aria-label={t('Choose an account')}
              >
                {props.connection.accounts.map((account) => (
                  <button
                    type="button"
                    key={account.address}
                    disabled={blocked}
                    aria-pressed={
                      props.connection?.account.address === account.address
                    }
                    aria-label={t('Use account {address}', {
                      address: account.address,
                    })}
                    onClick={() => props.onSelectAccount(account)}
                  >
                    {account.address.slice(0, 6)}…{account.address.slice(-6)}
                  </button>
                ))}
              </div>
              <p className="signin-helper">
                {t(
                  'Approve a sign-in message in your wallet. No transaction is sent.',
                )}
              </p>
              <button
                className="signin-action signin-primary"
                type="button"
                disabled={blocked}
                onClick={() => {
                  const method =
                    props.connection &&
                    preferredSignInMethod(props.connection.wallet);
                  if (method) props.onSignIn(method);
                }}
              >
                {props.busy === 'signing'
                  ? t('Waiting for your wallet…')
                  : t('Sign in')}
                <ArrowRight size={18} />
              </button>
            </>
          ) : props.busy === 'connecting' ? (
            <output className="signin-helper">
              {t('Waiting for your wallet…')}
            </output>
          ) : !props.walletEnabled ? (
            <p className="signin-helper">
              {t('Wallet sign-in is not available yet.')}
            </p>
          ) : choice?.wallet ? (
            <button
              className="signin-action signin-primary"
              type="button"
              disabled={blocked}
              onClick={() => {
                if (choice.wallet) props.onConnect(choice.wallet);
              }}
            >
              {t('Try again')}
            </button>
          ) : (
            <>
              <p className="signin-helper">
                {t('Open {name} in this browser, then return here.', {
                  name: selected?.name ?? '',
                })}
              </p>
              {selected?.url && (
                <a
                  className="signin-action"
                  href={selected.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('Get {name}', { name: selected.name })}
                  <ArrowRight size={18} />
                </a>
              )}
            </>
          )}
        </>
      )}
      {waiting && (
        <output className="signin-helper">
          <LoaderCircle className="signin-spinner" size={16} />
          {t('Checking account…')}
        </output>
      )}
      {props.notice && (
        <output className="signin-notice">{t(props.notice)}</output>
      )}
      {(props.availability === 'error' || props.uncertainSignIn) && (
        <button
          className="signin-action"
          type="button"
          disabled={!!props.busy}
          onClick={props.onRefresh}
        >
          {t('Refresh account status')}
        </button>
      )}
    </section>
  );
}
