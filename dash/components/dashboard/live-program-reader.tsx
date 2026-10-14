'use client';

import { useT } from '@/lib/i18n';

import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { MotionIcon } from './motion-icon';
import {
  ProgramReaderError,
  programReaderErrorMessage,
  readProgramInspection,
  type ProgramInspection,
} from '../../lib/client/program-reader';

export type ProgramReaderControl = { cancelPending: () => void };
const loaderNames = {
  v1: 'BPF loader v1',
  v2: 'BPF loader v2',
  v3: 'Upgradeable loader v3',
  v4: 'Loader v4',
  native: 'Native runtime loader',
  unknown: 'Unrecognized loader',
};
const statusNames = {
  'not-found': 'Account not found',
  'not-program': 'This address is not a program',
  unsupported: 'Program state not supported',
  deployed: 'Program deployed',
  retracted: 'Program code retracted',
  finalized: 'Code finalized under loader v4',
};
const eventNames = {
  deploy: 'Deployment',
  upgrade: 'Upgrade',
  'deploy-or-redeploy': 'Deployment or redeployment',
};
const utcTime = (seconds: number | null) =>
  seconds === null
    ? 'Time unavailable'
    : new Date(seconds * 1000)
        .toISOString()
        .replace('T', ' ')
        .replace('.000Z', ' UTC');

export function LiveProgramReader({
  accountId,
  controlRef,
}: {
  accountId: string | null;
  controlRef?: Ref<ProgramReaderControl>;
}) {
  const t = useT();
  const fieldId = useId();
  const [draft, setDraft] = useState({ accountId, value: '' });
  const [response, setResponse] = useState<{
    accountId: string;
    program: ProgramInspection;
  } | null>(null);
  const [notice, setNotice] = useState<{
    accountId: string | null;
    message: string;
  } | null>(null);
  const [pendingOwner, setPendingOwner] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const address = draft.accountId === accountId ? draft.value : '';
  const program = response?.accountId === accountId ? response.program : null;
  const error = notice?.accountId === accountId ? notice.message : null;
  const pending = !!accountId && pendingOwner === accountId;

  useEffect(() => {
    mounted.current = true;
    generation.current++;
    const reset = () => {
      controller.current?.abort();
      generation.current++;
      inFlight.current = false;
      setDraft({ accountId, value: '' });
      setResponse(null);
      setNotice(null);
      setPendingOwner(null);
    };
    window.addEventListener('conclave:session-change', reset);
    const shutdown = () => {
      mounted.current = false;
      generation.current++;
      controller.current?.abort();
      inFlight.current = false;
    };
    return () => {
      shutdown();
      window.removeEventListener('conclave:session-change', reset);
    };
  }, [accountId]);

  function cancelRead() {
    controller.current?.abort();
    generation.current++;
    inFlight.current = false;
    setPendingOwner(null);
    setNotice({
      accountId,
      message: 'The read was cancelled. Your entered address is still here.',
    });
  }
  useImperativeHandle(controlRef, () => ({
    cancelPending: () => {
      if (inFlight.current) cancelRead();
    },
  }));

  async function inspect() {
    if (!accountId || inFlight.current) return;
    const owner = accountId,
      requestGeneration = ++generation.current;
    const abort = new AbortController();
    controller.current?.abort();
    controller.current = abort;
    inFlight.current = true;
    setPendingOwner(owner);
    setNotice(null);
    setResponse(null);
    const current = () =>
      mounted.current &&
      requestGeneration === generation.current &&
      !abort.signal.aborted;
    try {
      const result = await readProgramInspection(address, owner, {
        signal: abort.signal,
      });
      if (current()) setResponse({ accountId: owner, program: result });
    } catch (failure) {
      if (
        !current() ||
        (failure instanceof Error && failure.name === 'AbortError')
      )
        return;
      setNotice({
        accountId: owner,
        message: programReaderErrorMessage(failure),
      });
      if (failure instanceof ProgramReaderError && failure.status === 401)
        window.dispatchEvent(
          new CustomEvent('conclave:session-change', {
            detail: { reason: 'signed-out' },
          }),
        );
    } finally {
      if (current()) {
        inFlight.current = false;
        setPendingOwner(null);
      }
    }
  }
  return (
    <>
      <p className="ct-intro">
        {t(
          'Read a Solana program’s loader state and a bounded deployment history through the configured network’s RPC.',
        )}
      </p>
      {!accountId && (
        <p className="ct-note">
          {t('Sign in through Account to inspect a program.')}
        </p>
      )}
      <form
        className="cw-simple-form"
        onSubmit={(event) => {
          event.preventDefault();
          void inspect();
        }}
      >
        <label htmlFor={fieldId}>{t('Program address')}</label>
        <input
          id={fieldId}
          name="program-address"
          type="text"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={64}
          value={address}
          disabled={!accountId || pending}
          aria-describedby={`${fieldId}-help`}
          onChange={(event) => {
            setDraft({ accountId, value: event.target.value });
            setResponse(null);
            setNotice(null);
          }}
          placeholder={t('Paste a Solana program address')}
        />
        <p id={`${fieldId}-help`} className="ct-note">
          {t(
            'Paste only the public program address. It will be sent to the configured RPC service. Never enter a private key or recovery phrase.',
          )}
        </p>
        <div>
          <button
            data-icon-trigger
            className="ct-button ct-button-primary"
            type="submit"
            disabled={!accountId || pending || !address.trim()}
          >
            <MotionIcon name="search" size={18} />
            {pending ? t('Reading program…') : t('Inspect program')}
          </button>
          {pending && (
            <button className="ct-button" type="button" onClick={cancelRead}>
              {t('Cancel read')}
            </button>
          )}
        </div>
      </form>
      {error && (
        <output className="ct-note">
          <Info size={15} aria-hidden="true" />
          <span>{t(error)}</span>
        </output>
      )}
      {program && (
        <>
          <section
            className="ct-detail ct-example"
            aria-label={t('Program state and warnings')}
          >
            <span className="ct-eyebrow">{t('Finalized RPC snapshot')}</span>
            <h3>{t(statusNames[program.status])}</h3>
            {program.warnings
              .filter((warning) => warning.code !== 'HISTORY_BOUNDED')
              .map((warning) => (
                <div className="ct-note" key={warning.code}>
                  {warning.severity === 'warning' ? (
                    <AlertTriangle size={15} aria-hidden="true" />
                  ) : (
                    <Info size={15} aria-hidden="true" />
                  )}
                  <div>
                    <strong>
                      {warning.severity === 'warning'
                        ? t('Warning')
                        : t('Information')}
                    </strong>
                    <p>{t(warning.message)}</p>
                  </div>
                </div>
              ))}
          </section>
          <section
            className="ct-detail ct-example"
            aria-label={t('Program account record')}
          >
            <div className="ct-detail-heading">
              <h3>{t('Program account')}</h3>
              <span className="ct-status ct-status-neutral">
                {t('Read only')}
              </span>
            </div>
            <dl className="ct-facts">
              <div>
                <dt>{t('Network')}</dt>
                <dd>
                  {program.cluster === 'devnet'
                    ? t('Devnet · test network')
                    : t('Mainnet beta')}
                </dd>
              </div>
              <div>
                <dt>{t('Program address')}</dt>
                <dd className="ct-code">{program.address}</dd>
              </div>
              <div>
                <dt>{t('Loader')}</dt>
                <dd>
                  {program.loader === null
                    ? t('Unavailable')
                    : t(loaderNames[program.loader])}
                </dd>
              </div>
              {program.owner && (
                <div>
                  <dt>{t('Owner program')}</dt>
                  <dd className="ct-code">{program.owner}</dd>
                </div>
              )}
              <div>
                <dt>{t('Finalized context slot')}</dt>
                <dd>{program.contextSlot}</dd>
              </div>
              <div>
                <dt>{t('Upgradeability')}</dt>
                <dd>
                  {program.mutability === 'upgradeable'
                    ? t('Upgradeable under this loader')
                    : program.mutability === 'immutable'
                      ? t('Immutable under this loader’s rules')
                      : t('Not established')}
                </dd>
              </div>
              <div>
                <dt>{t('Current upgrade authority')}</dt>
                <dd className="ct-code">
                  {program.authority.status === 'present'
                    ? program.authority.address
                    : program.authority.status === 'none'
                      ? t('None in the recognized loader state')
                      : t('Not established')}
                </dd>
              </div>
              <div>
                <dt>{t('Latest deployment slot in account state')}</dt>
                <dd>
                  {program.lastDeploymentSlot ??
                    t('Not available from this state')}
                </dd>
              </div>
              {program.loaderStateSlot !== null && (
                <div>
                  <dt>{t('Loader state slot')}</dt>
                  <dd>
                    {program.loaderStateSlot}
                    {program.status === 'retracted'
                      ? t(' · retracted state, not a deployment date')
                      : ''}
                  </dd>
                </div>
              )}
              {program.programDataAddress && (
                <div>
                  <dt>{t('ProgramData account')}</dt>
                  <dd className="ct-code">{program.programDataAddress}</dd>
                </div>
              )}
              {program.nextVersionAddress && (
                <div>
                  <dt>{t('Next version address · not inspected')}</dt>
                  <dd className="ct-code">{program.nextVersionAddress}</dd>
                </div>
              )}
            </dl>
            {program.status === 'finalized' && (
              <p className="ct-note">
                {t(
                  'Loader v4 code finalization is a program state. It is separate from the network finality of this RPC snapshot.',
                )}
              </p>
            )}
          </section>
          <section
            className="ct-detail ct-example"
            aria-label={t('Observed program deployment history')}
          >
            <h3>{t('Observed deployments and upgrades')}</h3>
            {program.history.status === 'not-scanned' ? (
              <p>{t('History was not scanned for this account state.')}</p>
            ) : (
              <>
                <p className="ct-note">
                  {t(
                    program.warnings.find(
                      (warning) => warning.code === 'HISTORY_BOUNDED',
                    )?.message ?? '',
                  )}
                </p>
                <p className="ct-note">
                  {t(
                    '{signatures} signatures scanned · {transactions} transactions checked · {unavailable} unavailable',
                    {
                      signatures: program.history.scannedSignatures,
                      transactions: program.history.verifiedTransactions,
                      unavailable: program.history.unavailableTransactions,
                    },
                  )}
                </p>
                {program.history.events.length === 0 &&
                  program.history.status === 'bounded' && (
                    <p>
                      {program.loader === 'v4'
                        ? t(
                            'Deployment events were not interpreted because the historical loader version is unverified.',
                          )
                        : t(
                            'No matching deployment or upgrade events were found within these checked records.',
                          )}
                    </p>
                  )}
                {program.history.events.map((event) => (
                  <details
                    className="ct-detail ct-example"
                    key={`${event.signature}:${event.instruction}`}
                  >
                    <summary>
                      {t('{event} · slot {slot}', {
                        event: t(eventNames[event.kind]),
                        slot: event.slot,
                      })}
                    </summary>
                    <dl className="ct-facts">
                      <div>
                        <dt>{t('Time')}</dt>
                        <dd>{t(utcTime(event.blockTime))}</dd>
                      </div>
                      <div>
                        <dt>{t('Loader')}</dt>
                        <dd>{t(loaderNames[event.loader])}</dd>
                      </div>
                      <div>
                        <dt>{t('Transaction signature')}</dt>
                        <dd className="ct-code">{event.signature}</dd>
                      </div>
                      <div>
                        <dt>{t('Instruction')}</dt>
                        <dd>{event.instruction}</dd>
                      </div>
                    </dl>
                  </details>
                ))}
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}
