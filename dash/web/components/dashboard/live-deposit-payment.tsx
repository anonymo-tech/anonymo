'use client';

import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  connectDepositWallet,
  createDepositPaymentClient,
  depositPaymentErrorMessage,
  DepositPaymentError,
  formatLamports,
  isDepositWallet,
  sameDepositPayment,
  signDepositPayment,
  type DepositPayment,
  type SignedDepositPayment,
} from '../../lib/client/deposit-payment';
import {
  formatDepositAmount,
  type DepositIntent,
} from '../../lib/client/deposits';
import { watchWallet, type StandardWallet } from '../../lib/client/service';

type Props = {
  accountId: string;
  intent: DepositIntent;
  visible: boolean;
  walletSubmission: boolean;
  onUpdated: (intent: DepositIntent) => void;
  onCredited: () => Promise<boolean | void>;
};
type Snapshot = { deposit: DepositIntent; payment: DepositPayment | null };
const pageVisible = () => document.visibilityState !== 'hidden';
export function LiveDepositPayment(props: Props) {
  return (
    <PaymentSession key={`${props.accountId}:${props.intent.id}`} {...props} />
  );
}
function PaymentSession({
  accountId,
  intent,
  visible,
  walletSubmission,
  onUpdated,
  onCredited,
}: Props) {
  const fieldId = useId();
  const [originalIntent] = useState(() => intent);
  const [sessionBlocked, setSessionBlocked] = useState(false);
  const [hasSigned, setHasSigned] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [wallets, setWallets] = useState<StandardWallet[]>([]),
    [walletIndex, setWalletIndex] = useState(''),
    [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [uncertain, setUncertain] = useState(false),
    [cursor, setCursor] = useState<string | null>(null),
    [now, setNow] = useState(Date.now);
  const epoch = useRef(0),
    controller = useRef<AbortController | null>(null),
    blocked = useRef(false),
    working = useRef(false),
    currentPayment = useRef<DepositPayment | null>(null),
    signed = useRef<SignedDepositPayment | null>(null),
    selectedWallet = useRef<StandardWallet | null>(null),
    phase = useRef<string | null>(null);
  const effectUpdate = useEffectEvent((deposit: DepositIntent) =>
    onUpdated(deposit),
  );
  function install(next: Snapshot) {
    if (
      currentPayment.current &&
      (!next.payment ||
        !sameDepositPayment(currentPayment.current, next.payment))
    )
      throw new DepositPaymentError(
        'PAYMENT_CHANGED',
        'The saved payment changed unexpectedly. Do not sign another transfer.',
      );
    currentPayment.current = next.payment;
    setSnapshot(next);
    onUpdated(next.deposit);
  }
  function fail(failure: unknown) {
    setError(depositPaymentErrorMessage(failure));
    if (failure instanceof DepositPaymentError && failure.status === 401)
      window.dispatchEvent(
        new CustomEvent('conclave:session-change', {
          detail: { reason: 'signed-out' },
        }),
      );
  }
  useLayoutEffect(() => {
    const reset = () => {
      blocked.current = true;
      setSessionBlocked(true);
      setHasSigned(false);
      epoch.current++;
      controller.current?.abort();
      signed.current = null;
      currentPayment.current = null;
      selectedWallet.current = null;
      working.current = false;
      phase.current = null;
      setSnapshot(null);
      setWallets([]);
      setWalletIndex('');
      setBusy(null);
      setError('');
      setNotice('');
      setUncertain(false);
      setCursor(null);
    };
    const hide = () => {
      if (pageVisible()) return;
      // External wallets may hide the browser during an explicit signing handoff.
      if (phase.current === 'connecting' || phase.current === 'signing') return;
      epoch.current++;
      controller.current?.abort();
      working.current = false;
      phase.current = null;
      setBusy(null);
    };
    window.addEventListener('conclave:session-change', reset);
    document.addEventListener('visibilitychange', hide);
    const dispose = () => {
      epoch.current++;
      controller.current?.abort();
      signed.current = null;
      selectedWallet.current = null;
      window.removeEventListener('conclave:session-change', reset);
      document.removeEventListener('visibilitychange', hide);
    };
    return () => dispose();
  }, []);
  useLayoutEffect(() => {
    if (!visible || blocked.current) return;
    const generation = ++epoch.current,
      abort = new AbortController();
    controller.current = abort;
    const current = () =>
      !abort.signal.aborted && generation === epoch.current && !blocked.current;
    const frame = requestAnimationFrame(() => {
      setBusy('Reading saved payment…');
      working.current = true;
      void createDepositPaymentClient(accountId, { signal: abort.signal })
        .read(originalIntent, currentPayment.current ?? undefined)
        .then((next) => {
          if (current()) {
            currentPayment.current = next.payment;
            setSnapshot(next);
            effectUpdate(next.deposit);
          }
        })
        .catch((failure) => {
          if (current()) fail(failure);
        })
        .finally(() => {
          if (current()) {
            working.current = false;
            setBusy(null);
          }
        });
    });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const dispose = () => {
      cancelAnimationFrame(frame);
      clearInterval(timer);
      abort.abort();
      epoch.current++;
      working.current = false;
      phase.current = null;
    };
    return () => dispose();
  }, [accountId, originalIntent, visible]);
  useEffect(() => {
    if (!visible || blocked.current) return;
    let disposed = false;
    const cleanups: (() => void)[] = [],
      observations = new Map<StandardWallet, () => void>();
    const invalidate = (wallet: StandardWallet) => {
      if (selectedWallet.current !== wallet || phase.current === 'connecting')
        return;
      epoch.current++;
      controller.current?.abort();
      working.current = false;
      phase.current = null;
      selectedWallet.current = null;
      setBusy(null);
      setWalletIndex('');
      setError(
        'The wallet accounts or permissions changed. Read saved payment status before continuing.',
      );
    };
    void import('@wallet-standard/app')
      .then(({ getWallets }) => {
        if (disposed) return;
        const registry = getWallets();
        const update = () => {
          if (disposed) return;
          const available = registry.get().filter(isDepositWallet).slice(0, 32);
          for (const [wallet, off] of observations)
            if (!available.includes(wallet)) {
              off();
              observations.delete(wallet);
              invalidate(wallet);
            }
          for (const wallet of available)
            if (!observations.has(wallet))
              observations.set(
                wallet,
                watchWallet(wallet, () => invalidate(wallet)),
              );
          setWallets(available);
          setWalletIndex('');
        };
        cleanups.push(
          registry.on('register', update),
          registry.on('unregister', update),
        );
        update();
      })
      .catch(() => {
        if (!disposed)
          setError(
            'Wallet discovery is unavailable. Reload before connecting a wallet.',
          );
      });
    return () => {
      disposed = true;
      cleanups.forEach((off) => off());
      observations.forEach((off) => off());
    };
  }, [visible]);
  async function action(
    label: string,
    run: (
      client: ReturnType<typeof createDepositPaymentClient>,
      current: () => boolean,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {
    if (!visible || !pageVisible() || working.current || blocked.current)
      return;
    controller.current?.abort();
    const abort = new AbortController(),
      generation = ++epoch.current;
    controller.current = abort;
    working.current = true;
    setBusy(label);
    setError('');
    setNotice('');
    const current = () =>
      generation === epoch.current && !abort.signal.aborted && !blocked.current;
    try {
      await run(
        createDepositPaymentClient(accountId, { signal: abort.signal }),
        current,
        abort.signal,
      );
    } catch (failure) {
      if (current()) fail(failure);
    } finally {
      if (current()) {
        working.current = false;
        phase.current = null;
        setBusy(null);
      }
    }
  }
  const saved =
      intent.state === 'credited' ? intent : (snapshot?.deposit ?? intent),
    payment = snapshot?.payment ?? null;
  const signable =
    walletSubmission &&
    saved.cluster === 'mainnet-beta' &&
    payment?.canSign &&
    Date.parse(payment.expiresAt) > now &&
    saved.state !== 'credited' &&
    !uncertain &&
    !hasSigned;
  const retryable =
    saved.state !== 'credited' &&
    payment?.canSubmit &&
    Date.parse(payment.expiresAt) > now &&
    (payment.signature !== null || hasSigned);
  async function refresh() {
    await action('Reading saved payment…', async (client, current) => {
      const next = await client.read(saved, payment ?? undefined);
      if (current()) {
        install(next);
        setNotice(
          'Saved status refreshed. A submitted transfer is not credit until finalized verification succeeds.',
        );
      }
    });
  }
  async function prepare() {
    await action('Preparing exact transfer…', async (client, current) => {
      const next = await client.prepare(saved);
      if (current()) {
        install(next);
        setCursor(null);
      }
    });
  }
  async function continueInWallet() {
    const wallet = wallets[Number(walletIndex)];
    if (!payment || !signable || walletIndex === '' || !wallet) return;
    await action(
      'Checking the saved transfer…',
      async (client, current, signal) => {
        const next = await client.prepare(saved);
        if (!current()) return;
        install(next);
        if (
          !sameDepositPayment(payment, next.payment) ||
          !next.payment.canSign ||
          Date.parse(next.payment.expiresAt) <= Date.now()
        )
          throw new DepositPaymentError(
            'PAYMENT_RECOVERY_ONLY',
            'This payment can no longer be signed. Check its saved status.',
          );
        selectedWallet.current = wallet;
        phase.current = 'connecting';
        setBusy('Connecting the exact source wallet…');
        const account = await connectDepositWallet(
          wallet,
          next.deposit.sourceWallet,
        );
        if (!current()) return;
        if (!pageVisible()) {
          setNotice(
            'Wallet connected. Return here and continue in your wallet when ready.',
          );
          return;
        }
        phase.current = 'signing';
        setBusy('Review and confirm in your wallet…');
        const approval = await signDepositPayment(
          wallet,
          account,
          next.payment,
          next.deposit,
          { signal, current },
        );
        if (!current()) return;
        signed.current = approval;
        setHasSigned(true);
        if (Date.parse(next.payment.expiresAt) <= Date.now()) {
          setNotice(
            'The review window closed while your wallet was open. Conclave did not submit this transfer. Only recovery of an existing transfer is available.',
          );
          return;
        }
        if (!pageVisible()) {
          setNotice(
            'Your checked signature is held in page memory. Return here and explicitly submit this same signed transfer.',
          );
          return;
        }
        setUncertain(true);
        phase.current = 'submitting';
        setBusy('Submitting the signed transfer…');
        const result = await client.submit(
          next.deposit,
          next.payment,
          approval,
        );
        if (!current()) return;
        install(result);
        setUncertain(false);
        setNotice(
          result.submitted
            ? 'The network accepted this transfer for processing. Check finalized payment before expecting service credit.'
            : 'The signed transfer is saved. Its network acceptance is not established; check status and recover this same transfer.',
        );
        if (result.deposit.state === 'credited') await onCredited();
      },
    );
  }
  async function resend() {
    if (!payment || !retryable) return;
    await action('Checking the same transfer…', async (client, current) => {
      const next = await client.read(saved, payment);
      if (!current()) return;
      install(next);
      if (
        !next.payment ||
        !next.payment.canSubmit ||
        Date.parse(next.payment.expiresAt) <= Date.now()
      )
        throw new DepositPaymentError(
          'PAYMENT_RECOVERY_ONLY',
          'The signing window is closed. Only finalized-payment recovery is available.',
        );
      setUncertain(true);
      phase.current = 'submitting';
      const result = next.payment.signature
        ? await client.retry(next.deposit, next.payment)
        : signed.current
          ? await client.submit(next.deposit, next.payment, signed.current)
          : null;
      if (!result || !current()) return;
      install(result);
      setUncertain(false);
      setNotice(
        'The same signed transfer was checked for submission. No new wallet signature or payment was created. Check finalization before expecting credit.',
      );
    });
  }
  async function recover(nextPage: boolean) {
    await action('Checking finalized payment…', async (client, current) => {
      const result = await client.recover(saved, nextPage ? cursor : null);
      if (!current()) return;
      onUpdated(result.deposit);
      setSnapshot((previous) =>
        previous ? { ...previous, deposit: result.deposit } : previous,
      );
      setCursor(result.search.nextCursor);
      setNotice(
        result.credited
          ? 'Finalized payment verified and credited once.'
          : result.search.status === 'incomplete'
            ? 'The network check was incomplete. Continue this recovery check; this does not prove that no payment exists.'
            : 'No matching finalized payment was found on this page. This does not prove that no payment exists.',
      );
      if (result.credited) {
        setUncertain(false);
        await onCredited();
      }
      const read = await client.read(result.deposit, payment ?? undefined);
      if (current()) install(read);
    });
  }
  if (!visible || sessionBlocked) return null;
  return (
    <section className="ct-example" aria-label="Wallet deposit payment">
      <h3>
        {saved.state === 'credited'
          ? 'Payment verified'
          : payment
            ? 'Review wallet transfer'
            : 'Pay from your wallet'}
      </h3>
      <p className="cp-fineprint">
        Conclave requests a signature for the exact transfer below, then submits
        it to the network. Your wallet must have USDC and SOL for the network
        fee. A network submission alone does not add service credit.
      </p>
      {error && (
        <output className="cp-boundary-note" role="alert">
          {error}
        </output>
      )}
      {notice && (
        <output className="cp-boundary-note" aria-live="polite">
          {notice}
        </output>
      )}
      {busy && (
        <output className="cp-fineprint" aria-live="polite">
          {busy}
        </output>
      )}
      {!snapshot && !busy && (
        <button
          type="button"
          className="cp-button"
          onClick={() => void refresh()}
        >
          Read saved payment
        </button>
      )}
      {snapshot &&
        !payment &&
        saved.state !== 'credited' &&
        (walletSubmission &&
        saved.paymentWindowOpen &&
        saved.cluster === 'mainnet-beta' ? (
          <button
            type="button"
            className="cp-button"
            disabled={!!busy}
            onClick={() => void prepare()}
          >
            Review wallet payment · no transfer yet
          </button>
        ) : (
          <p className="cp-boundary-note">
            Wallet payment is unavailable for this intent. Existing transfers
            can still be checked when recovery is enabled.
          </p>
        ))}
      {payment && (
        <>
          <dl className="ct-facts">
            <div>
              <dt>Network</dt>
              <dd>
                {saved.cluster === 'mainnet-beta'
                  ? 'Solana Mainnet'
                  : 'Solana Devnet · test tokens'}
              </dd>
            </div>
            <div>
              <dt>Exact amount</dt>
              <dd>{formatDepositAmount(saved.amountUsd6)} USDC</dd>
            </div>
            <div>
              <dt>Source wallet</dt>
              <dd className="ct-code">{saved.sourceWallet}</dd>
            </div>
            <div>
              <dt>Recipient treasury</dt>
              <dd className="ct-code">{saved.recipientWallet}</dd>
            </div>
            <div>
              <dt>Recipient USDC account</dt>
              <dd className="ct-code">{saved.recipientTokenAccount}</dd>
            </div>
            <div>
              <dt>Estimated network fee</dt>
              <dd>{formatLamports(payment.feeLamports)} SOL</dd>
            </div>
            <div>
              <dt>Review expires</dt>
              <dd>
                {new Date(payment.expiresAt)
                  .toISOString()
                  .replace('T', ' ')
                  .replace('.000Z', ' UTC')}
              </dd>
            </div>
            <div>
              <dt>Saved transfer</dt>
              <dd>
                {payment.state === 'submitted'
                  ? 'Submitted · finalization not yet verified'
                  : payment.state}
              </dd>
            </div>
            {payment.signature && (
              <div>
                <dt>Transaction signature</dt>
                <dd className="ct-code">{payment.signature}</dd>
              </div>
            )}
          </dl>
          {signable ? (
            <>
              <label htmlFor={fieldId}>
                Wallet
                <select
                  id={fieldId}
                  value={walletIndex}
                  disabled={!!busy}
                  onChange={(event) => setWalletIndex(event.target.value)}
                >
                  <option value="">Choose a wallet</option>
                  {wallets.map((wallet, index) => (
                    <option key={index} value={index}>
                      {wallet.name}
                    </option>
                  ))}
                </select>
              </label>
              {!wallets.length && (
                <p className="cp-fineprint">
                  No compatible mainnet wallet was detected. Open this page in a
                  browser with your source wallet available.
                </p>
              )}
              <button
                type="button"
                className="cp-button cp-button-primary"
                disabled={!!busy || walletIndex === ''}
                onClick={() => void continueInWallet()}
              >
                Continue in wallet · {formatDepositAmount(saved.amountUsd6)}{' '}
                USDC
              </button>
            </>
          ) : (
            saved.state !== 'credited' && (
              <p className="cp-fineprint">
                {uncertain
                  ? 'The last submission outcome is unknown. Recover this saved transfer before considering another deposit.'
                  : 'This attempt is for recovery only once submitted or expired. It cannot be replaced with a new blockhash here.'}
              </p>
            )
          )}
          <button
            type="button"
            className="cp-text-button"
            disabled={!!busy}
            onClick={() => void refresh()}
          >
            Read saved payment status
          </button>
          {retryable && (
            <details className="ct-example">
              <summary>Recover the same signed submission</summary>
              <p className="cp-fineprint">
                This sends only the original signed transaction again while it
                remains valid. It does not ask for a new wallet signature or
                create another transfer.
              </p>
              <button
                type="button"
                className="cp-button"
                disabled={!!busy}
                onClick={() => void resend()}
              >
                {payment.signature || uncertain
                  ? 'Resubmit the same signed transfer'
                  : 'Submit the saved signed transfer'}
              </button>
            </details>
          )}
        </>
      )}
      {saved.state !== 'credited' && saved.canReconcile && (
        <>
          <button
            type="button"
            className="cp-button"
            disabled={!!busy}
            onClick={() => void recover(false)}
          >
            Check finalized payment
          </button>
          {cursor && (
            <button
              type="button"
              className="cp-text-button"
              disabled={!!busy}
              onClick={() => void recover(true)}
            >
              Check next recovery page
            </button>
          )}
          <p className="cp-fineprint">
            Recovery reads the original reference and verifies finalized
            transfers. It never signs or sends a transaction.
          </p>
        </>
      )}
    </section>
  );
}
