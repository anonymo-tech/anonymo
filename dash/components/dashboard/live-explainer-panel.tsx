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
import { LivePreSignReader } from './live-pre-sign-reader';
import { featureOn } from './feature-switches';
import {
  decodeTransactionError,
  parseTransactionErrorDetail,
} from '../../lib/solana/transaction-errors';
import {
  LiveProgramReader,
  type ProgramReaderControl,
} from './live-program-reader';
import {
  ExplainerError,
  explainerErrorMessage,
  readTransactionExplanation,
  type TransactionExplanation,
} from '../../lib/client/solana';

const fieldLabels: Record<string, string> = {
  source: 'Source',
  destination: 'Destination',
  authority: 'Authority',
  owner: 'Owner',
  delegate: 'Delegate',
  mint: 'Mint',
  account: 'Account',
  amountRaw: 'Amount in base units',
  lamports: 'Amount in lamports',
  decimals: 'Token decimals',
  authorityType: 'Authority type',
  newAuthority: 'New authority',
  microLamportsPerComputeUnit:
    'Priority price per compute unit (micro-lamports)',
  computeUnits: 'Requested compute unit limit',
  heapBytes: 'Requested heap bytes',
  loadedAccountBytes: 'Requested loaded account bytes',
  feeAmountRaw: 'Transfer fee in base units',
  maximumFeeRaw: 'Maximum fee in base units',
};
const kindLabels: Record<string, string> = {
  unknown: 'Not decoded',
  computeBudget: 'Compute or fee settings',
  systemTransfer: 'SOL transfer',
  transfer: 'Token transfer',
  transferChecked: 'Token transfer',
  transferCheckedWithFee: 'Token transfer with fee',
  approve: 'Delegate approval',
  approveChecked: 'Delegate approval',
  setAuthority: 'Authority change',
  closeAccount: 'Account closure',
  memo: 'Memo',
  computeSetUnitPrice: 'Compute unit price',
  computeSetUnitLimit: 'Compute unit limit',
  computeRequestHeapFrame: 'Heap frame request',
  computeSetLoadedAccountsDataSizeLimit: 'Loaded account data limit',
  associatedTokenCreate: 'Create associated token account',
  associatedTokenCreateIdempotent: 'Create associated token account if absent',
  associatedTokenRecoverNested: 'Recover nested associated tokens',
  initializePermanentDelegate: 'Initialize permanent delegate',
  initializeTransferHook: 'Initialize transfer hook',
  updateTransferHook: 'Change transfer hook',
  initializeScaledUiAmountConfig: 'Initialize display scaling',
  updateMultiplier: 'Change display scaling',
  initializePausableConfig: 'Initialize pause control',
  pause: 'Pause token operations',
  resume: 'Resume token operations',
  confidentialTransfer: 'Confidential token transfer',
  confidentialTransferWithFee: 'Confidential token transfer with fee',
};
const readableName = (value: string) =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (letter) => letter.toUpperCase());

export function LiveExplainerPanel({
  accountId,
  initialSignature,
}: {
  accountId: string | null;
  initialSignature?: string;
}) {
  const t = useT();
  const [mode, setMode] = useState<'transaction' | 'program' | 'pre-sign'>(
    'transaction',
  );
  const transactionControl = useRef<ProgramReaderControl>(null);
  const programControl = useRef<ProgramReaderControl>(null);
  const preSignControl = useRef<ProgramReaderControl>(null);
  const chooseMode = (next: 'transaction' | 'program' | 'pre-sign') => {
    if (next === mode) return;
    (mode === 'transaction'
      ? transactionControl
      : mode === 'program'
        ? programControl
        : preSignControl
    ).current?.cancelPending();
    setMode(next);
  };
  return (
    <>
      <fieldset className="ct-segments" aria-label={t('Inspection mode')}>
        <button
          type="button"
          aria-pressed={mode === 'transaction'}
          onClick={() => chooseMode('transaction')}
        >
          {t('Transaction')}
        </button>
        <button
          type="button"
          aria-pressed={mode === 'program'}
          onClick={() => chooseMode('program')}
        >
          {t('Program')}
        </button>
        <button
          type="button"
          aria-pressed={mode === 'pre-sign'}
          onClick={() => chooseMode('pre-sign')}
        >
          {t('Pre-sign')}
        </button>
      </fieldset>
      <div hidden={mode !== 'transaction'}>
        <LiveTransactionReader
          key={accountId ?? 'signed-out'}
          accountId={accountId}
          initialSignature={initialSignature}
          controlRef={transactionControl}
        />
      </div>
      <div hidden={mode !== 'program'}>
        <LiveProgramReader
          key={accountId ?? 'signed-out'}
          accountId={accountId}
          controlRef={programControl}
        />
      </div>
      <div hidden={mode !== 'pre-sign'}>
        <LivePreSignReader
          key={accountId ?? 'signed-out'}
          accountId={accountId}
          controlRef={preSignControl}
        />
      </div>
    </>
  );
}

function LiveTransactionReader({
  accountId,
  initialSignature = '',
  controlRef,
}: {
  accountId: string | null;
  initialSignature?: string;
  controlRef: Ref<ProgramReaderControl>;
}) {
  const t = useT();
  const fieldId = useId();
  const [draft, setDraft] = useState({ accountId, value: initialSignature });
  const [response, setResponse] = useState<{
    accountId: string;
    explanation: TransactionExplanation;
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
  const signature = draft.accountId === accountId ? draft.value : '';
  const explanation =
    response?.accountId === accountId ? response.explanation : null;
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
      const result = await readTransactionExplanation(signature, owner, {
        signal: abort.signal,
      });
      if (current()) setResponse({ accountId: owner, explanation: result });
    } catch (failure) {
      if (
        !current() ||
        (failure instanceof Error && failure.name === 'AbortError')
      )
        return;
      setNotice({ accountId: owner, message: explainerErrorMessage(failure) });
      if (failure instanceof ExplainerError && failure.status === 401)
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
  function cancelRead() {
    controller.current?.abort();
    generation.current++;
    inFlight.current = false;
    setPendingOwner(null);
    setNotice({
      accountId,
      message: 'The read was cancelled. Your entered signature is still here.',
    });
  }
  useImperativeHandle(controlRef, () => ({
    cancelPending: () => {
      if (inFlight.current) cancelRead();
    },
  }));

  return (
    <>
      <p className="ct-intro">
        {t(
          'Inspect an existing Solana transaction through the configured network’s RPC. This deterministic decoder reads transaction data; it does not ask a model, connect a wallet, sign, simulate, or submit a transaction.',
        )}
      </p>
      {!accountId && (
        <p className="ct-note">
          {t('Sign in through Account to read an existing transaction.')}
        </p>
      )}
      <form
        className="cw-simple-form"
        onSubmit={(event) => {
          event.preventDefault();
          void inspect();
        }}
      >
        <label htmlFor={fieldId}>{t('Transaction signature')}</label>
        <input
          id={fieldId}
          name="transaction-signature"
          type="text"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={100}
          value={signature}
          disabled={!accountId || pending}
          aria-describedby={`${fieldId}-help`}
          onChange={(event) => {
            setDraft({ accountId, value: event.target.value });
            setResponse(null);
            setNotice(null);
          }}
          placeholder={t('Paste an existing transaction signature')}
        />
        <p id={`${fieldId}-help`} className="ct-note">
          {t(
            'Paste only the public transaction signature, never a private key or recovery phrase. The signature will be sent to the configured RPC service.',
          )}
        </p>
        <div>
          <button
            data-icon-trigger
            className="ct-button ct-button-primary"
            type="submit"
            disabled={!accountId || pending || !signature.trim()}
          >
            <MotionIcon name="search" size={18} />
            {pending ? t('Reading transaction…') : t('Inspect transaction')}
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
      {explanation && (
        <>
          <section
            className="ct-detail ct-example"
            aria-label={t('Execution and decoder warnings')}
          >
            <span className="ct-eyebrow">{t('Read-only RPC result')}</span>
            <h3>
              {explanation.execution === 'failed'
                ? t('Transaction failed')
                : explanation.execution === 'unknown'
                  ? t('Execution outcome unknown')
                  : t('Transaction executed')}
            </h3>
            <p>
              {explanation.execution === 'failed'
                ? t(
                    'The recorded instructions describe attempted actions. Their requested state changes did not commit; a network fee may still have been charged.',
                  )
                : explanation.execution === 'unknown'
                  ? t(
                      'The available data does not establish whether execution succeeded. Do not infer that the listed actions completed.',
                    )
                  : t(
                      'The RPC reports successful execution. This is not a determination that the transaction was safe or intended.',
                    )}
            </p>
            {featureOn('explainer') &&
              featureOn('failureReasons') &&
              explanation.execution === 'failed' && (
                <FailureReason
                  error={explanation.executionError}
                  instructions={explanation.instructions}
                />
              )}
            <p className="ct-takeaway">
              {t(
                'Finalized inclusion is not a safety guarantee. Unknown programs, unsupported instructions, and missing metadata can leave effects unexplained. Mint state, invoked hook behavior, program upgrades, and current permissions have not been inspected.',
              )}
            </p>
            {explanation.flags.length ? (
              <div aria-label={t('Decoder flags')}>
                {explanation.flags.map((flag, index) => (
                  <div
                    className="ct-note"
                    key={`${flag.code}:${flag.instruction ?? ''}:${index}`}
                  >
                    {flag.severity === 'info' ? (
                      <Info size={15} aria-hidden="true" />
                    ) : (
                      <AlertTriangle size={15} aria-hidden="true" />
                    )}
                    <div>
                      <strong>
                        {flag.severity === 'critical'
                          ? t('Critical')
                          : flag.severity === 'warning'
                            ? t('Warning')
                            : t('Information')}
                        {flag.instruction !== undefined
                          ? t(' · instruction {instruction}', {
                              instruction: flag.instruction,
                            })
                          : ''}
                      </strong>
                      <p>{t(flag.message)}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="ct-note">
                {t(
                  'The supported decoder did not return a flag. This does not establish that every effect was decoded or that the transaction was safe.',
                )}
              </p>
            )}
          </section>
          <section
            className="ct-detail ct-example"
            aria-label={t('Transaction evidence')}
          >
            <div className="ct-detail-heading">
              <h3>{t('Transaction record')}</h3>
              <span className="ct-status ct-status-neutral">
                {t('Finalized')}
              </span>
            </div>
            <dl className="ct-facts">
              <div>
                <dt>{t('Network')}</dt>
                <dd>
                  {explanation.cluster === 'devnet'
                    ? t('Devnet · test network')
                    : t('Mainnet beta')}
                </dd>
              </div>
              <div>
                <dt>{t('Genesis hash')}</dt>
                <dd className="ct-code">{explanation.genesisHash}</dd>
              </div>
              <div>
                <dt>{t('Signature')}</dt>
                <dd className="ct-code">{explanation.signature}</dd>
              </div>
              <div>
                <dt>{t('Slot')}</dt>
                <dd>{explanation.slot}</dd>
              </div>
              <div>
                <dt>{t('Decoder')}</dt>
                <dd>
                  {t('Version {version} · instruction data only', {
                    version: explanation.decoderVersion,
                  })}
                </dd>
              </div>
              <div>
                <dt>{t('Instructions')}</dt>
                <dd>
                  {t('{count} decoded or marked unsupported', {
                    count: explanation.instructions.length,
                  })}
                </dd>
              </div>
            </dl>
          </section>
          {explanation.instructions.map((instruction) => (
            <details
              className="ct-detail ct-example"
              key={instruction.location}
            >
              <summary>
                {t('Instruction {location} · {kind}', {
                  location: instruction.location,
                  kind: t(
                    kindLabels[instruction.kind] ??
                      readableName(instruction.kind),
                  ),
                })}
              </summary>
              <p className="ct-note">{t(instruction.description)}</p>
              <dl className="ct-facts">
                <div>
                  <dt>{t('Program')}</dt>
                  <dd className="ct-code">
                    {instruction.programId ?? t('Unavailable or malformed')}
                  </dd>
                </div>
                {Object.entries(instruction.fields).map(([key, value]) => (
                  <div key={key}>
                    <dt>{t(fieldLabels[key] ?? readableName(key))}</dt>
                    <dd className="ct-code">
                      {[
                        'authorityType',
                        'accountState',
                        'auditorKeyConfigured',
                        'autoApproveNewAccounts',
                      ].includes(key) ||
                      value === 'none' ||
                      (key === 'amount' &&
                        value === 'confidential; not decoded')
                        ? t(value)
                        : value}
                    </dd>
                  </div>
                ))}
              </dl>
              {instruction.flags.map((flag, index) => (
                <p className="ct-note" key={`${flag.code}:${index}`}>
                  {t(flag.message)}
                </p>
              ))}
            </details>
          ))}
        </>
      )}
    </>
  );
}

function FailureReason({
  error,
  instructions,
}: {
  error: unknown;
  instructions: TransactionExplanation['instructions'];
}) {
  const t = useT();
  const detail = parseTransactionErrorDetail(error);
  const programId =
    detail?.instructionIndex === null
      ? null
      : (instructions.find(
          (instruction) =>
            instruction.location === String(detail?.instructionIndex),
        )?.programId ?? null);
  const failure = detail && decodeTransactionError(detail, programId);
  return (
    <section className="ct-takeaway" aria-label={t('Why it failed')}>
      <h4>{t('Why it failed')}</h4>
      <p>
        {failure
          ? t(failure.reason, {
              code: failure.code ?? '',
              hex:
                failure.code === undefined
                  ? ''
                  : `0x${failure.code.toString(16)}`,
            })
          : t('The RPC did not provide a structured failure reason.')}
      </p>
      {failure && (
        <>
          <p className="ct-code" style={{ overflowWrap: 'anywhere' }}>
            {failure.instructionIndex === null
              ? t('Transaction · {error}', {
                  error: failure.name ?? detail?.kind ?? '',
                })
              : t('Instruction #{n} · {program} · {error}', {
                  n: failure.instructionIndex,
                  program: failure.programName
                    ? t(failure.programName)
                    : programId
                      ? `${programId.slice(0, 6)}…${programId.slice(-6)}`
                      : t('Program unavailable'),
                  error: failure.name ?? failure.code ?? detail?.kind ?? '',
                })}
          </p>
          {failure.code !== undefined && !failure.name && programId && (
            <p className="ct-code" style={{ overflowWrap: 'anywhere' }}>
              {programId}
            </p>
          )}
          {failure.instructionIndex !== null && (
            <p>
              {t(
                'The instruction number is zero-based. The program shown is the outer instruction’s program; an invoked program may have returned the error.',
              )}
            </p>
          )}
        </>
      )}
    </section>
  );
}
