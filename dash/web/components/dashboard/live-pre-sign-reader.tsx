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
        Inspect a transaction before signing. Decode its instructions and
        simulate against the configured Solana network, without connecting a
        wallet or submitting it.
      </p>
      {!accountId && (
        <p className="ct-note">
          Sign in through Account to inspect a transaction.
        </p>
      )}
      <form
        className="cw-simple-form"
        onSubmit={(event) => {
          event.preventDefault();
          void inspect();
        }}
      >
        <label htmlFor={fieldId}>Serialized transaction (base64)</label>
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
          placeholder="Paste a complete legacy or v0 transaction"
        />
        <p id={`${fieldId}-help`} className="ct-note">
          The transaction contents will be sent to the configured RPC for
          simulation. Never enter a private key or recovery phrase. Nothing is
          signed, sent onchain, or saved by this view.
        </p>
        <div>
          <button
            data-icon-trigger
            className="ct-button ct-button-primary"
            type="submit"
            disabled={!accountId || pending || !transaction.trim()}
          >
            <MotionIcon name="search" size={18} />
            {pending ? 'Inspecting transaction…' : 'Inspect and simulate'}
          </button>
          {pending && (
            <button className="ct-button" type="button" onClick={cancelRead}>
              Cancel inspection
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
      {inspection && <PreSignResult inspection={inspection} />}
    </>
  );
}

function PreSignResult({ inspection }: { inspection: PreSignInspection }) {
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
        aria-label="Simulation result and warnings"
      >
        <span className="ct-eyebrow">
          Pre-sign inspection · no transaction submitted
        </span>
        <h3>{simulationNames[simulation.status]}</h3>
        <p className="ct-takeaway">
          {simulation.status === 'succeeded'
            ? 'The RPC simulated execution successfully. This does not establish that the transaction is safe or matches your intent.'
            : simulation.status === 'failed'
              ? 'The RPC reported an execution failure. The decoded instructions still describe requested actions; they have not executed onchain.'
              : 'No simulation outcome is established. Only the available instruction evidence is shown.'}
        </p>
        {simulation.error && (
          <p className="ct-note">
            Execution error: {simulation.error.code.replaceAll('-', ' ')}
            {simulation.error.instructionIndex === null
              ? ''
              : ` at instruction ${simulation.error.instructionIndex}`}
            {simulation.error.customCode === null
              ? ''
              : ` (program code ${simulation.error.customCode})`}
            .
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
                {flag.severity === 'critical' ? 'Critical' : 'Warning'} ·
                instruction {flag.location}
              </strong>
              <p>{flag.message}</p>
            </div>
          </div>
        ))}
        {inspection.warnings
          .filter((warning) => warning.severity === 'warning')
          .map((warning) => (
            <div className="ct-note" key={warning.code}>
              <AlertTriangle size={15} aria-hidden="true" />
              <p>{warning.message}</p>
            </div>
          ))}
      </section>
      <details className="ct-detail ct-example">
        <summary>Inspection evidence</summary>
        <dl className="ct-facts">
          <div>
            <dt>Network</dt>
            <dd>
              {inspection.cluster === 'devnet'
                ? 'Devnet · test network'
                : 'Mainnet beta'}
            </dd>
          </div>
          <div>
            <dt>Inspected at</dt>
            <dd>
              {inspection.inspectedAt.replace('T', ' ').replace('Z', ' UTC')}
            </dd>
          </div>
          <div>
            <dt>Transaction hash (SHA-256)</dt>
            <dd className="ct-code">{inspection.transactionHash}</dd>
          </div>
          <div>
            <dt>Genesis hash</dt>
            <dd className="ct-code">{inspection.genesisHash}</dd>
          </div>
          <div>
            <dt>Reader</dt>
            <dd>
              Version {inspection.readerVersion} · deterministic instruction
              decoding
            </dd>
          </div>
          <div>
            <dt>Format</dt>
            <dd>
              {input.version === 'legacy' ? 'Legacy' : 'Version 0'} ·{' '}
              {input.byteLength} bytes
            </dd>
          </div>
          <div>
            <dt>Fee payer</dt>
            <dd className="ct-code">{input.feePayer}</dd>
          </div>
          <div>
            <dt>Signatures</dt>
            <dd>
              {input.presentSignatures} present / {input.requiredSignatures}{' '}
              required · not verified
            </dd>
          </div>
          <div>
            <dt>Original blockhash</dt>
            <dd className="ct-code">{input.recentBlockhash}</dd>
          </div>
          <div>
            <dt>Blockhash policy</dt>
            <dd>
              {simulation.blockhashReplacementRequested
                ? 'RPC replacement requested for simulation only'
                : 'Original blockhash retained'}
            </dd>
          </div>
          <div>
            <dt>Durable nonce</dt>
            <dd>
              {input.nonce === 'none'
                ? 'No recognized nonce advance'
                : input.nonce === 'durable'
                  ? 'Nonce advance recognized; blockhash preserved'
                  : 'Nonce-like instruction is ambiguous; simulation withheld'}
            </dd>
          </div>
          <div>
            <dt>Simulation bank</dt>
            <dd>
              {simulation.contextSlot === null
                ? 'Unavailable'
                : `Finalized context slot ${simulation.contextSlot} (not transaction inclusion)`}
            </dd>
          </div>
          {simulation.replacementBlockhash && (
            <>
              <div>
                <dt>Simulation blockhash</dt>
                <dd className="ct-code">
                  {simulation.replacementBlockhash.blockhash}
                </dd>
              </div>
              <div>
                <dt>Last valid block height</dt>
                <dd>{simulation.replacementBlockhash.lastValidBlockHeight}</dd>
              </div>
            </>
          )}
          <div>
            <dt>Compute units</dt>
            <dd>{simulation.unitsConsumed ?? 'Unavailable'}</dd>
          </div>
          <div>
            <dt>Simulated fee (lamports)</dt>
            <dd>{simulation.feeLamports ?? 'Unavailable'}</dd>
          </div>
          <div>
            <dt>Address tables</dt>
            <dd>
              {lookups.status === 'not-required'
                ? 'Not required'
                : lookups.status === 'resolved'
                  ? `${lookups.tables.length} resolved at slot ${lookups.contextSlot}`
                  : 'Could not resolve'}
            </dd>
          </div>
          <div>
            <dt>Simulation address binding</dt>
            <dd>
              {lookups.simulationBinding === 'matched'
                ? 'Loaded addresses matched resolved tables'
                : lookups.simulationBinding === 'not-required'
                  ? 'No loaded addresses'
                  : 'Unverified'}
            </dd>
          </div>
        </dl>
        {inspection.warnings
          .filter((warning) => warning.severity === 'info')
          .map((warning) => (
            <p className="ct-note" key={warning.code}>
              {warning.message}
            </p>
          ))}
      </details>
      {inspection.instructions.map((instruction) => (
        <details className="ct-detail ct-example" key={instruction.location}>
          <summary>
            Instruction {instruction.location} ·{' '}
            {instruction.kind === 'unknown'
              ? 'Not decoded'
              : readable(instruction.kind)}
          </summary>
          <p className="ct-note">{instruction.description}</p>
          <dl className="ct-facts">
            <div>
              <dt>Program</dt>
              <dd className="ct-code">
                {instruction.programId ?? 'Unavailable'}
              </dd>
            </div>
            {Object.entries(instruction.fields).map(([key, value]) => (
              <div key={key}>
                <dt>{readable(key)}</dt>
                <dd className="ct-code">{value}</dd>
              </div>
            ))}
          </dl>
          {instruction.flags.map((flag, index) => (
            <p className="ct-note" key={`${flag.code}:${index}`}>
              <strong>{readable(flag.severity)}:</strong> {flag.message}
            </p>
          ))}
        </details>
      ))}
      <details className="ct-detail ct-example">
        <summary>Accounts · {inspection.accounts.length}</summary>
        <p className="ct-note">
          Account roles come from the transaction message. Signer status does
          not verify a signature or prove authorization.
        </p>
        {inspection.accounts.map((account) => (
          <dl className="ct-facts" key={account.address}>
            <div>
              <dt>
                {account.signer ? 'Signer' : 'Non-signer'} ·{' '}
                {account.writable ? 'Writable' : 'Read only'}
              </dt>
              <dd className="ct-code">{account.address}</dd>
            </div>
          </dl>
        ))}
      </details>
      <details className="ct-detail ct-example">
        <summary>
          Simulated account state · {simulation.accounts.length} returned
        </summary>
        <p className="ct-note">
          These are bounded post-simulation snapshots, not balance changes or a
          complete account of transaction effects.{' '}
          {simulation.omittedWritableAccounts} writable accounts were outside
          the return limit.
        </p>
        {!simulation.accounts.length && (
          <p className="ct-note">No checked account snapshots are available.</p>
        )}
        {simulation.accounts.map((account) => (
          <section key={account.address} aria-label="Simulated account">
            <dl className="ct-facts">
              <div>
                <dt>Address</dt>
                <dd className="ct-code">{account.address}</dd>
              </div>
              <div>
                <dt>State</dt>
                <dd>
                  {account.exists
                    ? `Present · data ${account.dataStatus}`
                    : 'Absent in returned snapshot'}
                </dd>
              </div>
              {account.exists && (
                <>
                  <div>
                    <dt>Program owner</dt>
                    <dd className="ct-code">{account.owner}</dd>
                  </div>
                  <div>
                    <dt>Lamports</dt>
                    <dd>{account.lamports}</dd>
                  </div>
                  <div>
                    <dt>Data bytes</dt>
                    <dd>{account.dataBytes}</dd>
                  </div>
                  <div>
                    <dt>Executable</dt>
                    <dd>{account.executable ? 'Yes' : 'No'}</dd>
                  </div>
                </>
              )}
              {account.token && (
                <>
                  <div>
                    <dt>Token mint</dt>
                    <dd className="ct-code">{account.token.mint}</dd>
                  </div>
                  <div>
                    <dt>Token authority</dt>
                    <dd className="ct-code">{account.token.owner}</dd>
                  </div>
                  <div>
                    <dt>Token amount (base units)</dt>
                    <dd>{account.token.amount}</dd>
                  </div>
                  <div>
                    <dt>Token state</dt>
                    <dd>{account.token.state}</dd>
                  </div>
                  <div>
                    <dt>Delegate</dt>
                    <dd className="ct-code">
                      {account.token.delegate ?? 'None'}
                    </dd>
                  </div>
                  <div>
                    <dt>Delegated amount (base units)</dt>
                    <dd>{account.token.delegatedAmount}</dd>
                  </div>
                  <div>
                    <dt>Close authority</dt>
                    <dd className="ct-code">
                      {account.token.closeAuthority ?? 'Token owner'}
                    </dd>
                  </div>
                  <div>
                    <dt>Native reserve (lamports)</dt>
                    <dd>
                      {account.token.nativeReserve ??
                        'Not a native token account'}
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
