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
  PreSignError,
  preSignErrorMessage,
  readPreSignInspection,
  type PreSignInspection,
} from '../../lib/client/pre-sign';

export type PreSignReaderControl = { cancelPending: () => void };
const readable = (value: string) =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (letter) => letter.toUpperCase());
const simulationNames = {
  succeeded: 'Simulation completed',
  failed: 'Simulation failed',
  unavailable: 'Simulation unavailable',
  'not-run': 'Simulation was not run',
};
export function LivePreSignReader({
  accountId,
  controlRef,
}: {
  accountId: string | null;
  controlRef?: Ref<PreSignReaderControl>;
}) {
  const t = useT();
  const fieldId = useId();
  const [draft, setDraft] = useState({ accountId, value: '' });
  const [response, setResponse] = useState<{
    accountId: string;
    inspection: PreSignInspection;
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
  const transaction = draft.accountId === accountId ? draft.value : '';
  const inspection =
    response?.accountId === accountId ? response.inspection : null;
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
      message:
        'The read was cancelled. Your entered transaction is still here.',
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
      const result = await readPreSignInspection(transaction, owner, {
        signal: abort.signal,
      });
      if (current()) setResponse({ accountId: owner, inspection: result });
    } catch (failure) {
      if (
        !current() ||
        (failure instanceof Error && failure.name === 'AbortError')
      )
        return;
      setNotice({
        accountId: owner,
        message: preSignErrorMessage(failure),
      });
      if (failure instanceof PreSignError && failure.status === 401)
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
          'Inspect a transaction before signing. Decode its instructions and simulate against the configured Solana network, without connecting a wallet or submitting it.',
        )}
      </p>
      {!accountId && (
        <p className="ct-note">
          {t('Sign in through Account to inspect a transaction.')}
        </p>
      )}
      <form
        className="cw-simple-form"
        onSubmit={(event) => {
          event.preventDefault();
          void inspect();
        }}
      >
        <label htmlFor={fieldId}>{t('Serialized transaction (base64)')}</label>
        <textarea
          id={fieldId}
          name="serialized-transaction"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          rows={4}
          maxLength={1644}
          value={transaction}
          disabled={!accountId || pending}
          aria-describedby={`${fieldId}-help`}
          onChange={(event) => {
            setDraft({ accountId, value: event.target.value });
            setResponse(null);
            setNotice(null);
          }}
          placeholder={t('Paste a complete legacy or v0 transaction')}
        />
        <p id={`${fieldId}-help`} className="ct-note">
          {t(
            'The transaction contents will be sent to the configured RPC for simulation. Never enter a private key or recovery phrase. Nothing is signed, sent onchain, or saved by this view.',
          )}
        </p>
        <div>
          <button
            data-icon-trigger
            className="ct-button ct-button-primary"
            type="submit"
            disabled={!accountId || pending || !transaction.trim()}
          >
            <MotionIcon name="search" size={18} />
            {pending ? t('Inspecting transaction…') : t('Inspect and simulate')}
          </button>
          {pending && (
            <button className="ct-button" type="button" onClick={cancelRead}>
              {t('Cancel inspection')}
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
      {inspection && <PreSignResult inspection={inspection} />}
    </>
  );
}

function PreSignResult({ inspection }: { inspection: PreSignInspection }) {
  const t = useT();
  const { simulation, input, lookups } = inspection;
  const instructionWarnings = inspection.instructions.flatMap((instruction) =>
    instruction.flags
      .filter(
        (flag) =>
          flag.severity === 'critical' ||
          [
            'UNKNOWN_PROGRAM',
            'UNSUPPORTED_INSTRUCTION',
            'UNSUPPORTED_TOKEN_PROGRAM',
            'MALFORMED_INSTRUCTION',
          ].includes(flag.code),
      )
      .map((flag) => ({ ...flag, location: instruction.location })),
  );
  return (
    <>
      <section
        className="ct-detail ct-example"
        aria-label={t('Simulation result and warnings')}
      >
        <span className="ct-eyebrow">
          {t('Pre-sign inspection · no transaction submitted')}
        </span>
        <h3>{t(simulationNames[simulation.status])}</h3>
        <p className="ct-takeaway">
          {simulation.status === 'succeeded'
            ? t(
                'The RPC simulated execution successfully. This does not establish that the transaction is safe or matches your intent.',
              )
            : simulation.status === 'failed'
              ? t(
                  'The RPC reported an execution failure. The decoded instructions still describe requested actions; they have not executed onchain.',
                )
              : t(
                  'No simulation outcome is established. Only the available instruction evidence is shown.',
                )}
        </p>
        {simulation.error && (
          <p className="ct-note">
            {t('Execution error: {code}{instruction}{programCode}.', {
              code: simulation.error.code.replaceAll('-', ' '),
              instruction:
                simulation.error.instructionIndex === null
                  ? ''
                  : t(' at instruction {index}', {
                      index: simulation.error.instructionIndex,
                    }),
              programCode:
                simulation.error.customCode === null
                  ? ''
                  : t(' (program code {code})', {
                      code: simulation.error.customCode,
                    }),
            })}
          </p>
        )}
        {instructionWarnings.map((flag, index) => (
          <div
            className="ct-note"
            key={`${flag.location}:${flag.code}:${index}`}
          >
            <AlertTriangle size={15} aria-hidden="true" />
            <div>
              <strong>
                {t('{severity} · instruction {location}', {
                  severity:
                    flag.severity === 'critical' ? t('Critical') : t('Warning'),
                  location: flag.location,
                })}
              </strong>
              <p>{t(flag.message)}</p>
            </div>
          </div>
        ))}
        {inspection.warnings
          .filter((warning) => warning.severity === 'warning')
          .map((warning) => (
            <div className="ct-note" key={warning.code}>
              <AlertTriangle size={15} aria-hidden="true" />
              <p>{t(warning.message)}</p>
            </div>
          ))}
      </section>
      <details className="ct-detail ct-example">
        <summary>{t('Inspection evidence')}</summary>
        <dl className="ct-facts">
          <div>
            <dt>{t('Network')}</dt>
            <dd>
              {inspection.cluster === 'devnet'
                ? t('Devnet · test network')
                : t('Mainnet beta')}
            </dd>
          </div>
          <div>
            <dt>{t('Inspected at')}</dt>
            <dd>
              {inspection.inspectedAt.replace('T', ' ').replace('Z', ' UTC')}
            </dd>
          </div>
          <div>
            <dt>{t('Transaction hash (SHA-256)')}</dt>
            <dd className="ct-code">{inspection.transactionHash}</dd>
          </div>
          <div>
            <dt>{t('Genesis hash')}</dt>
            <dd className="ct-code">{inspection.genesisHash}</dd>
          </div>
          <div>
            <dt>{t('Reader')}</dt>
            <dd>
              {t('Version {version} · deterministic instruction decoding', {
                version: inspection.readerVersion,
              })}
            </dd>
          </div>
          <div>
            <dt>{t('Format')}</dt>
            <dd>
              {t('{format} · {bytes} bytes', {
                format:
                  input.version === 'legacy' ? t('Legacy') : t('Version 0'),
                bytes: input.byteLength,
              })}
            </dd>
          </div>
          <div>
            <dt>{t('Fee payer')}</dt>
            <dd className="ct-code">{input.feePayer}</dd>
          </div>
          <div>
            <dt>{t('Signatures')}</dt>
            <dd>
              {t('{present} present / {required} required · not verified', {
                present: input.presentSignatures,
                required: input.requiredSignatures,
              })}
            </dd>
          </div>
          <div>
            <dt>{t('Original blockhash')}</dt>
            <dd className="ct-code">{input.recentBlockhash}</dd>
          </div>
          <div>
            <dt>{t('Blockhash policy')}</dt>
            <dd>
              {simulation.blockhashReplacementRequested
                ? t('RPC replacement requested for simulation only')
                : t('Original blockhash retained')}
            </dd>
          </div>
          <div>
            <dt>{t('Durable nonce')}</dt>
            <dd>
              {input.nonce === 'none'
                ? t('No recognized nonce advance')
                : input.nonce === 'durable'
                  ? t('Nonce advance recognized; blockhash preserved')
                  : t(
                      'Nonce-like instruction is ambiguous; simulation withheld',
                    )}
            </dd>
          </div>
          <div>
            <dt>{t('Simulation bank')}</dt>
            <dd>
              {simulation.contextSlot === null
                ? t('Unavailable')
                : t(
                    'Finalized context slot {slot} (not transaction inclusion)',
                    { slot: simulation.contextSlot },
                  )}
            </dd>
          </div>
          {simulation.replacementBlockhash && (
            <>
              <div>
                <dt>{t('Simulation blockhash')}</dt>
                <dd className="ct-code">
                  {simulation.replacementBlockhash.blockhash}
                </dd>
              </div>
              <div>
                <dt>{t('Last valid block height')}</dt>
                <dd>{simulation.replacementBlockhash.lastValidBlockHeight}</dd>
              </div>
            </>
          )}
          <div>
            <dt>{t('Compute units')}</dt>
            <dd>{simulation.unitsConsumed ?? t('Unavailable')}</dd>
          </div>
          <div>
            <dt>{t('Simulated fee (lamports)')}</dt>
            <dd>{simulation.feeLamports ?? t('Unavailable')}</dd>
          </div>
          <div>
            <dt>{t('Address tables')}</dt>
            <dd>
              {lookups.status === 'not-required'
                ? t('Not required')
                : lookups.status === 'resolved'
                  ? t('{count} resolved at slot {slot}', {
                      count: lookups.tables.length,
                      slot: lookups.contextSlot!,
                    })
                  : t('Could not resolve')}
            </dd>
          </div>
          <div>
            <dt>{t('Simulation address binding')}</dt>
            <dd>
              {lookups.simulationBinding === 'matched'
                ? t('Loaded addresses matched resolved tables')
                : lookups.simulationBinding === 'not-required'
                  ? t('No loaded addresses')
                  : t('Unverified')}
            </dd>
          </div>
        </dl>
        {inspection.warnings
          .filter((warning) => warning.severity === 'info')
          .map((warning) => (
            <p className="ct-note" key={warning.code}>
              {t(warning.message)}
            </p>
          ))}
      </details>
      {inspection.instructions.map((instruction) => (
        <details className="ct-detail ct-example" key={instruction.location}>
          <summary>
            {t('Instruction {location} · {kind}', {
              location: instruction.location,
              kind:
                instruction.kind === 'unknown'
                  ? t('Not decoded')
                  : t(readable(instruction.kind)),
            })}
          </summary>
          <p className="ct-note">{t(instruction.description)}</p>
          <dl className="ct-facts">
            <div>
              <dt>{t('Program')}</dt>
              <dd className="ct-code">
                {instruction.programId ?? t('Unavailable')}
              </dd>
            </div>
            {Object.entries(instruction.fields).map(([key, value]) => (
              <div key={key}>
                <dt>{t(readable(key))}</dt>
                <dd className="ct-code">
                  {[
                    'authorityType',
                    'accountState',
                    'auditorKeyConfigured',
                    'autoApproveNewAccounts',
                  ].includes(key) ||
                  value === 'none' ||
                  (key === 'amount' && value === 'confidential; not decoded')
                    ? t(value)
                    : value}
                </dd>
              </div>
            ))}
          </dl>
          {instruction.flags.map((flag, index) => (
            <p className="ct-note" key={`${flag.code}:${index}`}>
              <strong>
                {t('{severity}:', { severity: t(readable(flag.severity)) })}
              </strong>{' '}
              {t(flag.message)}
            </p>
          ))}
        </details>
      ))}
      <details className="ct-detail ct-example">
        <summary>
          {t('Accounts · {count}', { count: inspection.accounts.length })}
        </summary>
        <p className="ct-note">
          {t(
            'Account roles come from the transaction message. Signer status does not verify a signature or prove authorization.',
          )}
        </p>
        {inspection.accounts.map((account) => (
          <dl className="ct-facts" key={account.address}>
            <div>
              <dt>
                {account.signer ? t('Signer') : t('Non-signer')} ·{' '}
                {account.writable ? t('Writable') : t('Read only')}
              </dt>
              <dd className="ct-code">{account.address}</dd>
            </div>
          </dl>
        ))}
      </details>
      <details className="ct-detail ct-example">
        <summary>
          {t('Simulated account state · {count} returned', {
            count: simulation.accounts.length,
          })}
        </summary>
        <p className="ct-note">
          {t(
            'These are bounded post-simulation snapshots, not balance changes or a complete account of transaction effects. {count} writable accounts were outside the return limit.',
            { count: simulation.omittedWritableAccounts },
          )}
        </p>
        {!simulation.accounts.length && (
          <p className="ct-note">
            {t('No checked account snapshots are available.')}
          </p>
        )}
        {simulation.accounts.map((account) => (
          <section key={account.address} aria-label={t('Simulated account')}>
            <dl className="ct-facts">
              <div>
                <dt>{t('Address')}</dt>
                <dd className="ct-code">{account.address}</dd>
              </div>
              <div>
                <dt>{t('State')}</dt>
                <dd>
                  {account.exists
                    ? t('Present · data {status}', {
                        status: t(account.dataStatus),
                      })
                    : t('Absent in returned snapshot')}
                </dd>
              </div>
              {account.exists && (
                <>
                  <div>
                    <dt>{t('Program owner')}</dt>
                    <dd className="ct-code">{account.owner}</dd>
                  </div>
                  <div>
                    <dt>{t('Lamports')}</dt>
                    <dd>{account.lamports}</dd>
                  </div>
                  <div>
                    <dt>{t('Data bytes')}</dt>
                    <dd>{account.dataBytes}</dd>
                  </div>
                  <div>
                    <dt>{t('Executable')}</dt>
                    <dd>{account.executable ? t('Yes') : t('No')}</dd>
                  </div>
                </>
              )}
              {account.token && (
                <>
                  <div>
                    <dt>{t('Token mint')}</dt>
                    <dd className="ct-code">{account.token.mint}</dd>
                  </div>
                  <div>
                    <dt>{t('Token authority')}</dt>
                    <dd className="ct-code">{account.token.owner}</dd>
                  </div>
                  <div>
                    <dt>{t('Token amount (base units)')}</dt>
                    <dd>{account.token.amount}</dd>
                  </div>
                  <div>
                    <dt>{t('Token state')}</dt>
                    <dd>{t(account.token.state)}</dd>
                  </div>
                  <div>
                    <dt>{t('Delegate')}</dt>
                    <dd className="ct-code">
                      {account.token.delegate ?? t('None')}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('Delegated amount (base units)')}</dt>
                    <dd>{account.token.delegatedAmount}</dd>
                  </div>
                  <div>
                    <dt>{t('Close authority')}</dt>
                    <dd className="ct-code">
                      {account.token.closeAuthority ?? t('Token owner')}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('Native reserve (lamports)')}</dt>
                    <dd>
                      {account.token.nativeReserve ??
                        t('Not a native token account')}
                    </dd>
                  </div>
                </>
              )}
            </dl>
          </section>
        ))}
      </details>
    </>
  );
}
