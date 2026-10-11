'use client';

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
        Read a Solana program’s loader state and a bounded deployment history
        through the configured network’s RPC.
      </p>
      {!accountId && (
        <p className="ct-note">Sign in through Account to inspect a program.</p>
      )}
      <form
        className="cw-simple-form"
        onSubmit={(event) => {
          event.preventDefault();
          void inspect();
        }}
      >
        <label htmlFor={fieldId}>Program address</label>
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
          placeholder="Paste a Solana program address"
        />
        <p id={`${fieldId}-help`} className="ct-note">
          Paste only the public program address. It will be sent to the
          configured RPC service. Never enter a private key or recovery phrase.
        </p>
        <div>
          <button
            data-icon-trigger
            className="ct-button ct-button-primary"
            type="submit"
            disabled={!accountId || pending || !address.trim()}
          >
            <MotionIcon name="search" size={18} />
            {pending ? 'Reading program…' : 'Inspect program'}
          </button>
          {pending && (
            <button className="ct-button" type="button" onClick={cancelRead}>
              Cancel read
            </button>
          )}
        </div>
      </form>
      {error && (
        <output className="ct-note">
          <Info size={15} aria-hidden="true" />
          <span>{error}</span>
        </output>
      )}
      {program && (
        <>
          <section
            className="ct-detail ct-example"
            aria-label="Program state and warnings"
          >
            <span className="ct-eyebrow">Finalized RPC snapshot</span>
            <h3>{statusNames[program.status]}</h3>
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
                        ? 'Warning'
                        : 'Information'}
                    </strong>
                    <p>{warning.message}</p>
                  </div>
                </div>
              ))}
          </section>
          <section
            className="ct-detail ct-example"
            aria-label="Program account record"
          >
            <div className="ct-detail-heading">
              <h3>Program account</h3>
              <span className="ct-status ct-status-neutral">Read only</span>
            </div>
            <dl className="ct-facts">
              <div>
                <dt>Network</dt>
                <dd>
                  {program.cluster === 'devnet'
                    ? 'Devnet · test network'
                    : 'Mainnet beta'}
                </dd>
              </div>
              <div>
                <dt>Program address</dt>
                <dd className="ct-code">{program.address}</dd>
              </div>
              <div>
                <dt>Loader</dt>
                <dd>
                  {program.loader === null
                    ? 'Unavailable'
                    : loaderNames[program.loader]}
                </dd>
              </div>
              {program.owner && (
                <div>
                  <dt>Owner program</dt>
                  <dd className="ct-code">{program.owner}</dd>
                </div>
              )}
              <div>
                <dt>Finalized context slot</dt>
                <dd>{program.contextSlot}</dd>
              </div>
              <div>
                <dt>Upgradeability</dt>
                <dd>
                  {program.mutability === 'upgradeable'
                    ? 'Upgradeable under this loader'
                    : program.mutability === 'immutable'
                      ? 'Immutable under this loader’s rules'
                      : 'Not established'}
                </dd>
              </div>
              <div>
                <dt>Current upgrade authority</dt>
                <dd className="ct-code">
                  {program.authority.status === 'present'
                    ? program.authority.address
                    : program.authority.status === 'none'
                      ? 'None in the recognized loader state'
                      : 'Not established'}
                </dd>
              </div>
              <div>
                <dt>Latest deployment slot in account state</dt>
                <dd>
                  {program.lastDeploymentSlot ??
                    'Not available from this state'}
                </dd>
              </div>
              {program.loaderStateSlot !== null && (
                <div>
                  <dt>Loader state slot</dt>
                  <dd>
                    {program.loaderStateSlot}
                    {program.status === 'retracted'
                      ? ' · retracted state, not a deployment date'
                      : ''}
                  </dd>
                </div>
              )}
              {program.programDataAddress && (
                <div>
                  <dt>ProgramData account</dt>
                  <dd className="ct-code">{program.programDataAddress}</dd>
                </div>
              )}
              {program.nextVersionAddress && (
                <div>
                  <dt>Next version address · not inspected</dt>
                  <dd className="ct-code">{program.nextVersionAddress}</dd>
                </div>
              )}
            </dl>
            {program.status === 'finalized' && (
              <p className="ct-note">
                Loader v4 code finalization is a program state. It is separate
                from the network finality of this RPC snapshot.
              </p>
            )}
          </section>
          <section
            className="ct-detail ct-example"
            aria-label="Observed program deployment history"
          >
            <h3>Observed deployments and upgrades</h3>
            {program.history.status === 'not-scanned' ? (
              <p>History was not scanned for this account state.</p>
            ) : (
              <>
                <p className="ct-note">
                  {
                    program.warnings.find(
                      (warning) => warning.code === 'HISTORY_BOUNDED',
                    )?.message
                  }
                </p>
                <p className="ct-note">
                  {program.history.scannedSignatures} signatures scanned ·{' '}
                  {program.history.verifiedTransactions} transactions checked ·{' '}
                  {program.history.unavailableTransactions} unavailable
                </p>
                {program.history.events.length === 0 &&
                  program.history.status === 'bounded' && (
                    <p>
                      {program.loader === 'v4'
                        ? 'Deployment events were not interpreted because the historical loader version is unverified.'
                        : 'No matching deployment or upgrade events were found within these checked records.'}
                    </p>
                  )}
                {program.history.events.map((event) => (
                  <details
                    className="ct-detail ct-example"
                    key={`${event.signature}:${event.instruction}`}
                  >
                    <summary>
                      {eventNames[event.kind]} · slot {event.slot}
                    </summary>
                    <dl className="ct-facts">
                      <div>
                        <dt>Time</dt>
                        <dd>{utcTime(event.blockTime)}</dd>
                      </div>
                      <div>
                        <dt>Loader</dt>
                        <dd>{loaderNames[event.loader]}</dd>
                      </div>
                      <div>
                        <dt>Transaction signature</dt>
                        <dd className="ct-code">{event.signature}</dd>
                      </div>
                      <div>
                        <dt>Instruction</dt>
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
