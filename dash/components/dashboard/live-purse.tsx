'use client';

import { useEffect, useRef, useState } from 'react';
import { MotionIcon } from './motion-icon';
import { LiveDepositPanel } from './live-deposit-panel';
import { featureOn } from './feature-switches';
import {
  createAccountRecordsClient,
  formatAccountUsd6,
  type LedgerEntry,
  type ReceiptSummary,
} from '../../lib/client/account-records';
import type { ServiceBalance } from '../../lib/client/workspace';

export type PurseAccount = {
  accountId: string | null;
  balance: ServiceBalance | null;
  refresh: () => Promise<boolean>;
};
const activity: Record<LedgerEntry['kind'], string> = {
  deposit: 'Deposit credited',
  hold: 'Reserved for a request',
  capture: 'Usage settled',
  release: 'Unused reservation returned',
  refund: 'Refund credited',
  internal_test_credit: 'Internal test credit · not USDC',
};
const utc = (value: string) =>
  new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(value));

export function LivePurse({
  account,
  visible,
}: {
  account: PurseAccount;
  visible: boolean;
}) {
  const [entries, setEntries] = useState<LedgerEntry[]>([]),
    [receipts, setReceipts] = useState<ReceiptSummary[]>([]);
  const [ledgerCursor, setLedgerCursor] = useState<string | null>(null),
    [receiptCursor, setReceiptCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const loading = useRef(false);
  const owner = account.accountId;
  useEffect(() => {
    if (!visible || !owner) return;
    const abort = new AbortController();
    controller.current = abort;
    loading.current = true;
    const client = createAccountRecordsClient(owner, abort.signal);
    void Promise.all([
      client.ledger(),
      featureOn('receipts')
        ? client.receipts()
        : Promise.resolve({ receipts: [], nextCursor: null }),
    ])
      .then(([ledger, signed]) => {
        if (abort.signal.aborted) return;
        setEntries(ledger.entries);
        setLedgerCursor(ledger.nextCursor);
        setReceipts(signed.receipts);
        setReceiptCursor(signed.nextCursor);
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setError(
            'Account records could not be loaded. Refresh to try again.',
          );
      })
      .finally(() => {
        if (!abort.signal.aborted) {
          setBusy(false);
          loading.current = false;
        }
      });
    return () => {
      abort.abort();
      if (controller.current === abort) {
        controller.current = null;
        loading.current = false;
      }
    };
  }, [visible, owner, revision]);
  async function more(kind: 'ledger' | 'receipts') {
    const abort = controller.current;
    if (!owner || !abort || abort.signal.aborted || loading.current) return;
    loading.current = true;
    setBusy(true);
    setError('');
    try {
      const client = createAccountRecordsClient(owner, abort.signal);
      if (kind === 'ledger') {
        const result = await client.ledger(ledgerCursor);
        if (!abort.signal.aborted) {
          setEntries((current) => [
            ...current,
            ...result.entries.filter(
              (item) => !current.some((existing) => existing.id === item.id),
            ),
          ]);
          setLedgerCursor(result.nextCursor);
        }
      } else {
        const result = await client.receipts(receiptCursor);
        if (!abort.signal.aborted) {
          setReceipts((current) => [
            ...current,
            ...result.receipts.filter(
              (item) => !current.some((existing) => existing.id === item.id),
            ),
          ]);
          setReceiptCursor(result.nextCursor);
        }
      }
    } catch {
      if (!abort.signal.aborted)
        setError('Additional records could not be loaded. Try again.');
    } finally {
      if (!abort.signal.aborted) {
        loading.current = false;
        setBusy(false);
      }
    }
  }
  async function download(id: string) {
    const abort = controller.current;
    if (!owner || !abort || abort.signal.aborted || loading.current) return;
    loading.current = true;
    setBusy(true);
    setError('');
    try {
      const receipt = await createAccountRecordsClient(
        owner,
        abort.signal,
      ).receipt(id);
      if (abort.signal.aborted) return;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(receipt, null, 2)], {
          type: 'application/json',
        }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `conclave-receipt-${id}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      if (!abort.signal.aborted)
        setError(
          'The receipt could not be downloaded. Blind comparison receipts become available after model names are revealed.',
        );
    } finally {
      if (!abort.signal.aborted) {
        loading.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <section className="cp-page cp-purse" aria-label="Account Purse">
      <header className="cp-heading">
        <div>
          <h1 className="cp-title">Purse</h1>
          <p className="cp-description">
            Your available balance, open reservations, and settled usage.
          </p>
        </div>
        <button
          className="cp-button"
          type="button"
          disabled={busy || !owner}
          onClick={() => {
            setBusy(true);
            setError('');
            void account.refresh();
            setRevision((value) => value + 1);
          }}
        >
          Refresh
        </button>
      </header>
      <div className="cp-purse-layout">
        <div className="cp-balance-area">
          <span className="cp-eyebrow">Available balance</span>
          <p className="cp-balance">
            {owner && account.balance
              ? formatAccountUsd6(account.balance.availableUsd6)
              : '—'}{' '}
            <span>USD</span>
          </p>
          <p>
            {owner && account.balance
              ? `${formatAccountUsd6(account.balance.reservedUsd6)} USD reserved for open requests.`
              : 'Sign in to view your account balance.'}
          </p>
          {owner && account.balance?.internalTestCreditUsd6 && (
            <p className="cp-fineprint">
              This account received{' '}
              {formatAccountUsd6(account.balance.internalTestCreditUsd6)} USD of
              internal test credit for local testing. Test credit is not USDC,
              not a deposit and cannot be withdrawn.
            </p>
          )}
        </div>
        <div className="cp-budget-paper">
          <h2>Review before you spend</h2>
          <p>
            Every request shows its maximum reservation before you approve it.
            Unused funds return to your available balance after settlement.
          </p>
          <p className="cp-fineprint">
            A displayed balance is prepaid service credit, not a wallet token
            balance. Deposit availability and saved intents appear below.
          </p>
        </div>
      </div>
      <LiveDepositPanel
        key={owner ?? 'signed-out'}
        accountId={owner}
        visible={visible}
        onCredited={async () => {
          setBusy(true);
          setError('');
          setRevision((value) => value + 1);
          return account.refresh();
        }}
      />
      {error && <output className="cp-boundary-note">{error}</output>}
      <section className="cp-ledger" aria-label="Account activity">
        <div className="cp-ledger-heading">
          <h2>Activity</h2>
          <span>UTC</span>
        </div>
        {entries.length ? (
          <table
            aria-label="Account ledger"
            style={{
              width: '100%',
              textAlign: 'left',
              borderCollapse: 'collapse',
            }}
          >
            <thead>
              <tr className="cp-ledger-columns">
                <th>Activity</th>
                <th>Date · UTC</th>
                <th>Amount · USD</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr className="cp-ledger-columns" key={entry.id}>
                  <td>{activity[entry.kind]}</td>
                  <td>
                    <time dateTime={entry.createdAt}>
                      {utc(entry.createdAt)}
                    </time>
                  </td>
                  <td>
                    {formatAccountUsd6(
                      entry.kind === 'capture'
                        ? entry.reservedDeltaUsd6
                        : entry.availableDeltaUsd6,
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="cp-fineprint">
            {!owner
              ? 'Sign in to view activity.'
              : busy
                ? 'Loading activity…'
                : 'No recorded activity yet.'}
          </p>
        )}
        {ledgerCursor && (
          <button
            className="cp-text-button"
            type="button"
            disabled={busy}
            onClick={() => void more('ledger')}
          >
            Load more activity
          </button>
        )}
      </section>
      {featureOn('receipts') && (
        <section className="cp-ledger" aria-label="Signed receipts">
          <div className="cp-ledger-heading">
            <h2>Receipts</h2>
            <span>Signed records</span>
          </div>
          <p className="cp-fineprint">
            These receipts have not been anchored on Solana. Verify signatures
            with a separately trusted signer key; downloading a receipt does not
            verify its signature.
          </p>
          {receipts.map((receipt) => (
            <div className="cp-ledger-columns" key={receipt.id}>
              <span>
                {utc(receipt.issuedAt)} UTC
                <br />
                <small>
                  {receipt.kind === 'media' ? 'Studio · ' : 'Chat · '}
                  {receipt.state === 'signed_pending_batch'
                    ? 'Awaiting hourly batch'
                    : 'Awaiting Solana anchor'}
                </small>
              </span>
              <button
                className="cp-text-button"
                type="button"
                disabled={busy}
                onClick={() => void download(receipt.id)}
              >
                <MotionIcon name="download" size={18} /> Download receipt
              </button>
              <span>{formatAccountUsd6(receipt.actualUsd6)} USD</span>
            </div>
          ))}
          {!receipts.length && (
            <p className="cp-fineprint">
              {!owner
                ? 'Sign in to view receipts.'
                : busy
                  ? 'Loading receipts…'
                  : 'No signed receipts available. Unrevealed blind comparison receipts stay hidden until you reveal their model names.'}
            </p>
          )}
          {receiptCursor && (
            <button
              className="cp-text-button"
              type="button"
              disabled={busy}
              onClick={() => void more('receipts')}
            >
              Load more receipts
            </button>
          )}
        </section>
      )}
    </section>
  );
}
