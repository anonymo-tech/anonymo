'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { LiveDepositPayment } from './live-deposit-payment';
import {
  createDepositsClient,
  DepositClientError,
  depositErrorMessage,
  depositSignature,
  formatDepositAmount,
  makeDepositCreation,
  parseDepositAmount,
  sameDepositTerms,
  type DepositCapability,
  type DepositCreation,
  type DepositIntent,
} from '../../lib/client/deposits';

type CreationReview = {
  input: DepositCreation;
  capability: DepositCapability;
  phase: 'review' | 'uncertain';
};
const networkLabel = (cluster: DepositIntent['cluster']) =>
  cluster === 'devnet' ? 'Solana Devnet · test tokens' : 'Solana Mainnet';
const utc = (value: string) =>
  new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
const statusLabel = (intent: DepositIntent, now: number) =>
  intent.state === 'credited'
    ? 'Credited'
    : Date.parse(intent.expiresAt) <= now || intent.status === 'expired'
      ? 'Expired · recovery only'
      : 'Awaiting payment';

function IntentFacts({ intent }: { intent: DepositIntent }) {
  return (
    <dl className="ct-facts">
      <div>
        <dt>Network</dt>
        <dd>{networkLabel(intent.cluster)}</dd>
      </div>
      <div>
        <dt>Exact amount</dt>
        <dd>{formatDepositAmount(intent.amountUsd6)} USDC</dd>
      </div>
      <div>
        <dt>Source wallet</dt>
        <dd className="ct-code">{intent.sourceWallet}</dd>
      </div>
      <div>
        <dt>USDC mint</dt>
        <dd className="ct-code">{intent.mint}</dd>
      </div>
      <div>
        <dt>Treasury wallet</dt>
        <dd className="ct-code">{intent.recipientWallet}</dd>
      </div>
      <div>
        <dt>Treasury token account</dt>
        <dd className="ct-code">{intent.recipientTokenAccount}</dd>
      </div>
      <div>
        <dt>Required reference</dt>
        <dd className="ct-code">{intent.reference}</dd>
      </div>
      <div>
        <dt>Created</dt>
        <dd>{utc(intent.createdAt)}</dd>
      </div>
      <div>
        <dt>Payment window ends</dt>
        <dd>{utc(intent.expiresAt)}</dd>
      </div>
      <div>
        <dt>Intent ID</dt>
        <dd className="ct-code">{intent.id}</dd>
      </div>
    </dl>
  );
}

export function LiveDepositPanel({
  accountId,
  visible,
  onCredited,
}: {
  accountId: string | null;
  visible: boolean;
  onCredited: () => Promise<boolean | void>;
}) {
  const fieldId = useId();
  const [capability, setCapability] = useState<DepositCapability | null>(null);
  const [wallets, setWallets] = useState<string[]>([]),
    [sourceWallet, setSourceWallet] = useState(''),
    [amount, setAmount] = useState('');
  const [intents, setIntents] = useState<DepositIntent[]>([]),
    [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<DepositIntent | null>(null),
    [review, setReview] = useState<CreationReview | null>(null);
  const [signature, setSignature] = useState(''),
    [checkedSignature, setCheckedSignature] = useState<string | null>(null);
  const [signatureReview, setSignatureReview] = useState<string | null>(null),
    [verificationPending, setVerificationPending] = useState(false);
  const [loading, setLoading] = useState(!!accountId),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [now, setNow] = useState(Date.now);
  const [revision, setRevision] = useState(0);
  const mounted = useRef(false),
    blocked = useRef(false),
    working = useRef(false),
    epoch = useRef(0),
    lifetime = useRef<AbortController | null>(null);
  const selectedRef = useRef<DepositIntent | null>(null);

  function fail(failure: unknown, generation: number) {
    if (
      !mounted.current ||
      generation !== epoch.current ||
      (failure instanceof Error && failure.name === 'AbortError')
    )
      return;
    setError(depositErrorMessage(failure));
    if (failure instanceof DepositClientError && failure.status === 401)
      window.dispatchEvent(
        new CustomEvent('conclave:session-change', {
          detail: { reason: 'signed-out' },
        }),
      );
  }
  function install(intent: DepositIntent) {
    selectedRef.current = intent;
    setSelected(intent);
    setIntents((current) =>
      current.map((item) => (item.id === intent.id ? intent : item)),
    );
  }
  async function action(
    work: (
      client: ReturnType<typeof createDepositsClient>,
      current: () => boolean,
    ) => Promise<void>,
  ) {
    const controller = lifetime.current;
    if (
      !accountId ||
      !visible ||
      !controller ||
      controller.signal.aborted ||
      working.current ||
      blocked.current
    )
      return;
    const generation = epoch.current;
    const current = () =>
      mounted.current &&
      generation === epoch.current &&
      !controller.signal.aborted &&
      !blocked.current;
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work(
        createDepositsClient(accountId, { signal: controller.signal }),
        current,
      );
    } catch (failure) {
      fail(failure, generation);
    } finally {
      if (current()) {
        working.current = false;
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    mounted.current = true;
    const reset = () => {
      epoch.current++;
      blocked.current = true;
      working.current = false;
      lifetime.current?.abort();
      selectedRef.current = null;
      setCapability(null);
      setWallets([]);
      setSourceWallet('');
      setAmount('');
      setIntents([]);
      setNextCursor(null);
      setSelected(null);
      setReview(null);
      setSignature('');
      setSignatureReview(null);
      setCheckedSignature(null);
      setVerificationPending(false);
      setError('');
      setNotice('');
      setBusy(false);
      setLoading(false);
    };
    window.addEventListener('conclave:session-change', reset);
    const shutdown = () => {
      mounted.current = false;
      epoch.current++;
      lifetime.current?.abort();
    };
    return () => {
      shutdown();
      window.removeEventListener('conclave:session-change', reset);
    };
  }, []);

  useEffect(() => {
    if (!accountId || !visible || blocked.current) return;
    const controller = new AbortController(),
      generation = ++epoch.current;
    lifetime.current = controller;
    working.current = true;
    const current = () =>
      mounted.current &&
      generation === epoch.current &&
      !controller.signal.aborted;
    const initialize = async () => {
      const client = createDepositsClient(accountId, {
        signal: controller.signal,
      });
      const privateRead = async <T,>(request: Promise<T>): Promise<T> => {
        try {
          return await request;
        } catch (failure) {
          if (failure instanceof DepositClientError && failure.status === 401)
            fail(failure, generation);
          throw failure;
        }
      };
      const original = selectedRef.current;
      const reads = await Promise.allSettled([
        privateRead(client.capability()),
        privateRead(client.wallets()),
        privateRead(client.list()),
        original
          ? privateRead(client.read(original.id))
          : Promise.resolve(null),
      ]);
      if (!current()) return;
      if (reads[0].status === 'fulfilled') setCapability(reads[0].value);
      if (reads[1].status === 'fulfilled') {
        const verifiedWallets = reads[1].value;
        setWallets(verifiedWallets);
        setSourceWallet((previous) =>
          verifiedWallets.includes(previous)
            ? previous
            : (verifiedWallets[0] ?? ''),
        );
      }
      if (reads[2].status === 'fulfilled') {
        setIntents(reads[2].value.deposits);
        setNextCursor(reads[2].value.nextCursor);
      }
      if (reads[3].status === 'fulfilled' && reads[3].value && original) {
        if (!sameDepositTerms(original, reads[3].value))
          fail(
            new DepositClientError(
              'INTENT_CHANGED',
              'The saved intent terms changed unexpectedly. No payment instructions are available.',
            ),
            generation,
          );
        else {
          install(reads[3].value);
          if (reads[3].value.state === 'credited') {
            setVerificationPending(false);
            setSignatureReview(null);
          }
        }
      }
      const failure =
        reads.find(
          (read) =>
            read.status === 'rejected' &&
            read.reason instanceof DepositClientError &&
            read.reason.status === 401,
        ) ?? reads.find((read) => read.status === 'rejected');
      if (failure?.status === 'rejected') fail(failure.reason, generation);
      if (current()) {
        working.current = false;
        setLoading(false);
        setBusy(false);
      }
    };
    void initialize();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [accountId, visible, revision]);

  function reviewCreation() {
    setError('');
    setNotice('');
    if (
      !capability?.configured ||
      !sourceWallet ||
      !wallets.includes(sourceWallet) ||
      busy ||
      loading
    )
      return;
    try {
      const value = parseDepositAmount(amount);
      if (
        !capability.maximumUsd6 ||
        BigInt(value) > BigInt(capability.maximumUsd6)
      )
        throw new DepositClientError(
          'DEPOSIT_LIMIT',
          'The amount exceeds the configured deposit limit.',
        );
      setReview({
        input: makeDepositCreation(value, sourceWallet, crypto.randomUUID()),
        capability: { ...capability },
        phase: 'review',
      });
    } catch (failure) {
      setError(depositErrorMessage(failure));
    }
  }
  async function createIntent() {
    if (!review) return;
    const frozen = review;
    await action(async (client, current) => {
      setReview({ ...frozen, phase: 'uncertain' });
      try {
        const result = await client.create(frozen.input, frozen.capability);
        if (!current()) return;
        install(result.deposit);
        setIntents((current) =>
          current.some((intent) => intent.id === result.deposit.id)
            ? current
            : [result.deposit, ...current],
        );
        setReview(null);
        setSignature('');
        setSignatureReview(null);
        setCheckedSignature(null);
        setVerificationPending(false);
        setNotice(
          result.replayed
            ? 'The original intent was recovered. No transfer was sent by this interface.'
            : 'Intent saved. No transfer was sent by this interface.',
        );
      } catch (failure) {
        if (
          current() &&
          failure instanceof DepositClientError &&
          failure.status >= 400 &&
          failure.status < 500 &&
          ![408, 429].includes(failure.status)
        )
          setReview({ ...frozen, phase: 'review' });
        throw failure;
      }
    });
  }
  async function openIntent(id: string) {
    if (review) return;
    await action(async (client, current) => {
      const intent = await client.read(id);
      if (!current()) return;
      install(intent);
      setSignature('');
      setSignatureReview(null);
      setCheckedSignature(null);
      setVerificationPending(false);
    });
  }
  async function readStatus() {
    const original = selectedRef.current;
    if (!original) return;
    await action(async (client, current) => {
      const intent = await client.read(original.id);
      if (!current()) return;
      if (!sameDepositTerms(original, intent))
        throw new DepositClientError(
          'INTENT_CHANGED',
          'The saved intent terms changed unexpectedly. No payment instructions are available.',
        );
      install(intent);
      if (intent.state === 'credited') {
        setVerificationPending(false);
        setSignatureReview(null);
        setNotice('This intent is credited in the service ledger.');
        const refreshed = await onCredited();
        if (current() && refreshed === false)
          setNotice(
            'This intent is credited. Refresh Purse to read the current balance.',
          );
      } else
        setNotice(
          'The saved intent is not credited. Reading status does not search for or send a transaction.',
        );
    });
  }
  function reviewSignature() {
    if (!selected?.canReconcile || selected.state === 'credited' || busy)
      return;
    setError('');
    setNotice('');
    try {
      setSignatureReview(depositSignature(signature));
    } catch (failure) {
      setError(depositErrorMessage(failure));
    }
  }
  async function reconcile() {
    const intent = selectedRef.current,
      candidate = signatureReview;
    if (
      !intent ||
      !candidate ||
      !intent.canReconcile ||
      intent.state === 'credited'
    )
      return;
    await action(async (client, current) => {
      setCheckedSignature(candidate);
      setVerificationPending(true);
      let result;
      try {
        result = await client.reconcile(intent, candidate);
      } catch (failure) {
        if (
          current() &&
          failure instanceof DepositClientError &&
          failure.status >= 400 &&
          failure.status < 500 &&
          ![408, 429].includes(failure.status)
        )
          setVerificationPending(false);
        throw failure;
      }
      if (!current()) return;
      install(result.deposit);
      setVerificationPending(false);
      setSignatureReview(null);
      setNotice(
        result.replayed
          ? 'This transaction was already credited once. No duplicate credit was created.'
          : 'Finalized transfer verified and credited in the service ledger.',
      );
      const refreshed = await onCredited();
      if (current() && refreshed === false)
        setNotice(
          'Deposit credited. Refresh Purse to read the current balance.',
        );
    });
  }
  const selectedExpired = selected
    ? Date.parse(selected.expiresAt) <= now || selected.status === 'expired'
    : false;

  return (
    <section className="cp-ledger ct-tools" aria-label="USDC deposits">
      <div className="cp-ledger-heading">
        <h2>USDC deposits</h2>
        <button
          className="cp-text-button"
          type="button"
          disabled={!accountId || busy || loading || !!review}
          onClick={() => {
            setBusy(true);
            setError('');
            setRevision((value) => value + 1);
          }}
        >
          Refresh deposit records
        </button>
      </div>
      <p className="cp-fineprint">
        Deposits add prepaid service credit. The balance shown in Purse is not
        your wallet’s token balance. Wallet payment is available only when its
        network and treasury checks are enabled.
      </p>
      {!accountId && (
        <p className="cp-boundary-note">
          Sign in through Account to view or recover owned deposit intents.
        </p>
      )}
      {loading && (
        <output className="cp-boundary-note">
          Reading deposit configuration and account records…
        </output>
      )}
      {capability && !capability.configured && (
        <p className="cp-boundary-note">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>
            New deposits are disabled or missing operator configuration.{' '}
            {capability.recoveryConfigured
              ? 'Existing intents may still allow signature recovery.'
              : 'Deposit recovery is also unavailable until the operator enables it for the configured network.'}
          </span>
        </p>
      )}
      {capability?.configured && (
        <p className="cp-boundary-note">
          {capability.cluster === 'devnet'
            ? 'Devnet is a test network. Do not use real funds.'
            : 'Mainnet configuration is present.'}{' '}
          Configuration alone is not a live RPC or treasury verification.
          Transfers are verified against the saved intent during reconciliation.
        </p>
      )}
      {error && (
        <output className="cp-boundary-note">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>{error}</span>
        </output>
      )}
      {notice && <output className="cp-boundary-note">{notice}</output>}
      {accountId &&
        !loading &&
        !selected &&
        !review &&
        capability?.configured && (
          <details className="ct-example">
            <summary>Prepare a deposit intent</summary>
            <form
              className="cp-form-paper"
              onSubmit={(event) => {
                event.preventDefault();
                reviewCreation();
              }}
            >
              <p className="cp-fineprint">
                Creating an intent records the exact amount, verified source
                wallet, network, and a 15-minute payment window. It does not
                move funds or open your wallet.
              </p>
              {!wallets.length ? (
                <p className="cp-boundary-note">
                  Sign in through Account with the source Solana wallet before
                  preparing an intent.
                </p>
              ) : (
                <>
                  <label htmlFor={`${fieldId}-wallet`}>
                    Verified source wallet
                    <select
                      id={`${fieldId}-wallet`}
                      value={sourceWallet}
                      disabled={busy}
                      onChange={(event) => setSourceWallet(event.target.value)}
                    >
                      {wallets.map((wallet) => (
                        <option key={wallet} value={wallet}>
                          {wallet}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label htmlFor={`${fieldId}-amount`}>
                    Exact amount · USDC
                    <input
                      id={`${fieldId}-amount`}
                      inputMode="decimal"
                      autoComplete="off"
                      value={amount}
                      maxLength={17}
                      disabled={busy}
                      onChange={(event) => setAmount(event.target.value)}
                      placeholder="5.000000"
                    />
                  </label>
                  <p className="cp-fineprint">
                    Up to {formatDepositAmount(capability.maximumUsd6!)} USDC
                    per intent on {networkLabel(capability.cluster!)}.
                  </p>
                  <button
                    className="cp-button cp-button-primary"
                    type="submit"
                    disabled={busy || !amount.trim() || !sourceWallet}
                  >
                    Review intent
                  </button>
                </>
              )}
            </form>
          </details>
        )}
      {review && (
        <div className="cp-form-paper" aria-label="Deposit intent confirmation">
          <h3>
            {review.phase === 'uncertain'
              ? 'Recover the original intent'
              : 'Confirm the intent details'}
          </h3>
          <dl className="ct-facts">
            <div>
              <dt>Network</dt>
              <dd>{networkLabel(review.capability.cluster!)}</dd>
            </div>
            <div>
              <dt>Exact amount</dt>
              <dd>{formatDepositAmount(review.input.amountUsd6)} USDC</dd>
            </div>
            <div>
              <dt>Source wallet</dt>
              <dd className="ct-code">{review.input.sourceWallet}</dd>
            </div>
            <div>
              <dt>USDC mint</dt>
              <dd className="ct-code">{review.capability.mint}</dd>
            </div>
            <div>
              <dt>Treasury wallet</dt>
              <dd className="ct-code">{review.capability.recipientWallet}</dd>
            </div>
            <div>
              <dt>Treasury token account</dt>
              <dd className="ct-code">
                {review.capability.recipientTokenAccount}
              </dd>
            </div>
          </dl>
          <p className="cp-fineprint">
            {review.phase === 'uncertain'
              ? 'The previous response did not establish whether the intent was saved. Recovery uses the same request key and exact terms. After closing this page, check recent intents before creating another.'
              : 'The reference and expiry will be assigned when the service saves this intent. This action does not transfer USDC.'}
          </p>
          {review.phase === 'review' && (
            <button
              className="cp-text-button"
              type="button"
              disabled={busy}
              onClick={() => setReview(null)}
            >
              Back to amount
            </button>
          )}
          <button
            className="cp-button cp-button-primary"
            type="button"
            disabled={busy}
            onClick={() => void createIntent()}
          >
            {busy
              ? 'Checking intent…'
              : review.phase === 'uncertain'
                ? 'Recover same intent request'
                : 'Create intent · no transfer'}
          </button>
        </div>
      )}
      {selected && (
        <div className="cp-form-paper" aria-label="Selected deposit intent">
          <h3>
            {statusLabel(selected, now)} ·{' '}
            {formatDepositAmount(selected.amountUsd6)} USDC
          </h3>
          {selected.cluster === 'devnet' && (
            <p className="cp-boundary-note">
              Devnet test intent. Do not send real funds.
            </p>
          )}
          {selected.state !== 'credited' && (
            <p className="cp-fineprint">
              {selectedExpired
                ? 'The payment window has closed. An already-submitted transfer can still be checked if it landed within the original window.'
                : 'This is an unpaid intent, not proof that a transfer was submitted.'}{' '}
              A generic wallet send without the exact reference and supported
              transfer format may not be accepted.
            </p>
          )}
          {selected.state !== 'credited' &&
            !selectedExpired &&
            !selected.paymentWindowOpen && (
              <p className="cp-boundary-note">
                New payments are unavailable for this saved intent under the
                current configuration. Its details remain available for
                recovery.
              </p>
            )}
          <details className="ct-example" open>
            <summary>Saved intent details</summary>
            <IntentFacts intent={selected} />
          </details>
          {accountId && (
            <LiveDepositPayment
              accountId={accountId}
              intent={selected}
              visible={visible}
              walletSubmission={capability?.walletSubmission === true}
              onUpdated={install}
              onCredited={onCredited}
            />
          )}
          {selected.settlement && (
            <div className="ct-example">
              <h3>Recorded settlement</h3>
              <dl className="ct-facts">
                <div>
                  <dt>Transaction signature</dt>
                  <dd className="ct-code">{selected.settlement.signature}</dd>
                </div>
                <div>
                  <dt>Finalized slot</dt>
                  <dd>{selected.settlement.slot}</dd>
                </div>
                <div>
                  <dt>Block time</dt>
                  <dd>
                    {utc(
                      new Date(
                        selected.settlement.blockTime * 1000,
                      ).toISOString(),
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Verified</dt>
                  <dd>{utc(selected.settlement.verifiedAt)}</dd>
                </div>
                <div>
                  <dt>Ledger transaction</dt>
                  <dd className="ct-code">
                    {selected.settlement.transactionId}
                  </dd>
                </div>
              </dl>
            </div>
          )}
          {selected.state !== 'credited' && !selected.canReconcile && (
            <p className="cp-boundary-note">
              Signature recovery is unavailable for this saved intent’s network
              and treasury configuration. Keep its ID and the original
              transaction signature.
            </p>
          )}
          {selected.state !== 'credited' && selected.canReconcile && (
            <form
              className="cp-form-paper"
              onSubmit={(event) => {
                event.preventDefault();
                reviewSignature();
              }}
            >
              <h3>Recover an existing transfer</h3>
              <p className="cp-fineprint">
                Provide a transaction already submitted for this exact intent.
                The server reads the configured network and verifies finality,
                amount, wallet, recipient, reference, and original time window
                before crediting.
              </p>
              <label htmlFor={`${fieldId}-signature`}>
                Transaction signature
                <input
                  id={`${fieldId}-signature`}
                  value={signature}
                  maxLength={88}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy || !!signatureReview}
                  onChange={(event) => {
                    setSignature(event.target.value);
                    setCheckedSignature(null);
                    setVerificationPending(false);
                  }}
                  placeholder="Existing base58 transaction signature"
                />
              </label>
              {!signatureReview && (
                <button
                  className="cp-button"
                  type="submit"
                  disabled={busy || !signature.trim()}
                >
                  Review signature check
                </button>
              )}
              {signatureReview && (
                <>
                  <p className="cp-fineprint">
                    Confirm a read and ledger reconciliation for this signature.
                    No wallet transaction will be signed or sent.
                  </p>
                  <dl className="ct-facts">
                    <div>
                      <dt>Signature to verify</dt>
                      <dd className="ct-code">{signatureReview}</dd>
                    </div>
                  </dl>
                  {verificationPending && (
                    <p className="cp-boundary-note">
                      Verification outcome is uncertain. Read saved status or
                      check this same signature again; do not send another
                      transfer.
                    </p>
                  )}
                  <button
                    className="cp-button cp-button-primary"
                    type="button"
                    disabled={busy}
                    onClick={() => void reconcile()}
                  >
                    {busy
                      ? 'Verifying transfer…'
                      : checkedSignature === signatureReview
                        ? 'Check the same signature again'
                        : 'Confirm signature verification'}
                  </button>
                  <button
                    className="cp-text-button"
                    type="button"
                    disabled={busy || verificationPending}
                    onClick={() => {
                      setSignatureReview(null);
                      setCheckedSignature(null);
                    }}
                  >
                    Edit signature
                  </button>
                </>
              )}
            </form>
          )}
          <button
            className="cp-text-button"
            type="button"
            disabled={busy}
            onClick={() => void readStatus()}
          >
            Read saved intent status
          </button>
          <button
            className="cp-text-button"
            type="button"
            disabled={busy}
            onClick={() => {
              selectedRef.current = null;
              setSelected(null);
              setSignature('');
              setSignatureReview(null);
              setCheckedSignature(null);
              setVerificationPending(false);
              setNotice('');
              setError('');
            }}
          >
            Back to recent intents
          </button>
        </div>
      )}
      {accountId && !loading && (
        <details className="ct-example" open={!selected && !review}>
          <summary>Recent deposit intents</summary>
          {intents.length ? (
            intents.map((intent) => (
              <button
                className="cp-text-button"
                type="button"
                key={intent.id}
                disabled={busy || !!review}
                onClick={() => void openIntent(intent.id)}
              >
                {formatDepositAmount(intent.amountUsd6)} USDC ·{' '}
                {networkLabel(intent.cluster)} · {statusLabel(intent, now)} ·{' '}
                {utc(intent.createdAt)}
              </button>
            ))
          ) : (
            <p className="cp-fineprint">
              No intents were returned on this page.
            </p>
          )}
          {nextCursor && (
            <button
              className="cp-text-button"
              type="button"
              disabled={busy || !!review}
              onClick={() =>
                void action(async (client, current) => {
                  const page = await client.list(nextCursor);
                  if (current()) {
                    setIntents(page.deposits);
                    setNextCursor(page.nextCursor);
                  }
                })
              }
            >
              Read earlier intents
            </button>
          )}
        </details>
      )}
    </section>
  );
}
