'use client';
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Plus,
  RefreshCw,
  Wallet,
  Unlink,
} from 'lucide-react';
import type {
  LinkedWallet,
  WalletPnl,
  WalletCapability,
} from '../../lib/second-look/wallet';
import {
  walletsResponse,
  walletResponse,
  pnlResponse,
} from '../../lib/client/second-look-contracts';
import {
  decimalAmount,
  object,
  shortAddress,
  usd6,
} from '../../lib/client/second-look';
import {
  readableCode,
  tokenIdentity,
  utcTime,
  walletFeeRows,
} from './presentation';
import {
  Busy,
  CopyButton,
  ErrorNotice,
  EvidenceLink,
  Modal,
  TokenAvatar,
  useSecondLookApi,
  type PanelProps,
} from './shared';

export function WalletPanel({
  accountId,
  controlRef,
  onComposer,
  onDraft,
  onSignIn,
  onToast,
}: PanelProps) {
  const api = useSecondLookApi(accountId);
  const { run } = api;
  const [wallets, setWallets] = useState<LinkedWallet[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [pnlRecord, setPnl] = useState<WalletPnl | null>(null);
  const pnl = pnlRecord?.walletId === selected ? pnlRecord : null;
  const [tab, setTab] = useState<'positions' | 'activity' | 'fees'>(
    'positions',
  );
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [linkAddress, setLinkAddress] = useState('');
  const [label, setLabel] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [capability, setCapability] = useState<WalletCapability | null>(null);
  const polls = useRef({ id: '', count: 0 });
  const [pausedWalletId, setPausedWalletId] = useState<string | null>(null);
  const current = wallets.find((w) => w.id === selected);
  useEffect(() => {
    onComposer({
      placeholder: 'Paste a public Solana wallet address…',
      label: 'Link wallet',
      busy: api.busy,
    });
  }, [onComposer, api.busy]);
  useEffect(() => {
    if (!accountId) return;
    void run(async (request) => {
      const result = await request('second-look/wallets', {
        validate: walletsResponse,
      });
      setCapability(result.capability);
      setWallets(result.wallets);
      setSelected(result.wallets[0]?.id ?? null);
      setLoaded(true);
    });
  }, [accountId, run]);
  useEffect(() => {
    if (!selected || !accountId) return;
    void run(async (request) => {
      const result = await request(`second-look/wallets/${selected}/pnl`, {
        validate: pnlResponse,
      });
      setPnl(result.pnl);
    });
  }, [selected, accountId, run]);
  useImperativeHandle(controlRef, () => ({
    async submit(value) {
      if (!accountId) {
        api.setError('Sign in to save read-only wallet links.');
        onSignIn();
        return;
      }
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.trim())) {
        api.setError('Enter a public Solana wallet address.');
        return;
      }
      setLinkAddress(value.trim());
      setLabel('');
    },
  }));
  async function link() {
    await run(async (request) => {
      const result = await request('second-look/wallets', {
        body: { address: linkAddress, label: label.trim() || undefined },
        validate: walletResponse,
      });
      setCapability(result.capability);
      setWallets((current) => [
        ...current.filter((w) => w.id !== result.wallet.id),
        result.wallet,
      ]);
      setSelected(result.wallet.id);
      setLinkAddress('');
      onDraft('');
      onToast('Read-only wallet linked.');
    });
  }
  async function sync() {
    if (!current || !capability?.configured) return;
    polls.current = { id: current.id, count: 0 };
    setPausedWalletId(null);
    await run(async (request) => {
      const result = await request(`second-look/wallets/${current.id}/sync`, {
        body: {},
        validate: walletResponse,
      });
      setCapability(result.capability);
      setWallets((items) =>
        items.map((w) => (w.id === result.wallet.id ? result.wallet : w)),
      );
      const resultPnl = await request(`second-look/wallets/${current.id}/pnl`, {
        validate: pnlResponse,
      });
      setPnl(resultPnl.pnl);
      onToast('Sync requested. Progress updates automatically.');
    });
  }
  const refresh = useCallback(
    async (resume = false) => {
      if (!selected) return;
      if (resume) {
        polls.current = { id: selected, count: 0 };
        setPausedWalletId(null);
      }
      await run(async (request) => {
        const [result, resultPnl] = await Promise.all([
          request(`second-look/wallets/${selected}`, {
            validate: walletResponse,
          }),
          request(`second-look/wallets/${selected}/pnl`, {
            validate: pnlResponse,
          }),
        ]);
        setCapability(result.capability);
        setWallets((items) =>
          items.map((w) => (w.id === result.wallet.id ? result.wallet : w)),
        );
        setPnl(resultPnl.pnl);
      });
    },
    [run, selected],
  );
  useEffect(() => {
    if (
      !current ||
      !capability?.configured ||
      api.busy ||
      linkAddress ||
      confirmRemove ||
      current.sync.state === 'blocked' ||
      !(
        ['queued', 'running'].includes(current.sync.state) ||
        current.sync.pending > 0
      )
    )
      return;
    if (polls.current.id !== current.id)
      polls.current = { id: current.id, count: 0 };
    if (polls.current.count >= 20) return;
    const timer = setTimeout(() => {
      polls.current.count++;
      if (polls.current.count >= 20) setPausedWalletId(current.id);
      void refresh();
    }, 5000);
    return () => clearTimeout(timer);
  }, [
    current,
    capability?.configured,
    api.busy,
    linkAddress,
    confirmRemove,
    refresh,
  ]);
  async function remove() {
    if (!current) return;
    await run(async (request) => {
      await request(`second-look/wallets/${current.id}`, {
        method: 'DELETE',
        validate: (x): x is { deleted: true } =>
          object(x) && x.deleted === true,
      });
      const remaining = wallets.filter((w) => w.id !== current.id);
      setWallets(remaining);
      setSelected(remaining[0]?.id ?? null);
      setPnl(null);
      setConfirmRemove(false);
      onToast('Wallet unlinked and its cached records removed.');
    });
  }
  return (
    <section aria-label="My wallet">
      <ErrorNotice message={api.error} />
      {capability && !capability.configured && (
        <p className="sl-notice">
          Wallet history is not connected yet. Linked addresses remain read
          only.
        </p>
      )}
      {wallets.length ? (
        <div className="sl-wallet-selector">
          <label>
            <Wallet size={15} />
            <select
              aria-label="Linked wallet"
              value={selected ?? ''}
              disabled={api.busy}
              onChange={(e) => setSelected(e.target.value)}
            >
              {wallets.map((wallet) => (
                <option key={wallet.id} value={wallet.id}>
                  {wallet.label || shortAddress(wallet.address)}
                </option>
              ))}
            </select>
          </label>
          <span className="sl-label">READ ONLY</span>
          <button
            className="sl-text-button"
            onClick={() => {
              onDraft('');
              onToast('Paste another public address in the bottom bar.');
            }}
          >
            <Plus size={14} />
            Add wallet
          </button>
        </div>
      ) : null}
      {!current ? (
        <div className="sl-wallet-empty">
          <span className="sl-eyebrow">YOUR ACTIVITY, IN CONTEXT</span>
          <h2>Know what you kept.</h2>
          <p>
            A clear view of your Solana positions and profit after fees.
            <br />
            Link a public wallet address in the bar below.
          </p>
          <div className="sl-wallet-empty-columns">
            <div>
              <ArrowUpRight size={18} />
              <h3>True P&L</h3>
              <p>
                Realized and unrealized changes.
                <br />
                Network fees included.
              </p>
            </div>
            <div>
              <ArrowDownLeft size={18} />
              <h3>Every cost, explained</h3>
              <p>
                Priority fees, tips and platform fees.
                <br />
                Rent stays separate.
              </p>
            </div>
            <div>
              <Wallet size={18} />
              <h3>Read only, always</h3>
              <p>
                No signing permission.
                <br />
                No movement of funds.
              </p>
            </div>
          </div>
          {!accountId && (
            <button className="sl-button sl-primary" onClick={onSignIn}>
              Sign in to link a wallet
            </button>
          )}
          {accountId && !loaded && api.busy && (
            <Busy label="Loading linked wallets" />
          )}
        </div>
      ) : (
        <>
          <div className="sl-wallet-title">
            <div>
              <span className="sl-eyebrow">THIS MONTH</span>
              <h2>Wallet overview</h2>
              <div className="sl-address">
                <span>{shortAddress(current.address)}</span>
                <CopyButton value={current.address} onToast={onToast} />
                <EvidenceLink
                  href={`https://solscan.io/account/${current.address}`}
                >
                  Explorer
                </EvidenceLink>
              </div>
            </div>
            <div className="sl-heading-actions">
              <button
                className="sl-icon-button"
                aria-label="Refresh wallet"
                disabled={api.busy}
                onClick={() => void refresh(true)}
              >
                <RefreshCw size={16} />
              </button>
              <button
                className="sl-button"
                disabled={
                  api.busy ||
                  !capability?.configured ||
                  ['queued', 'running'].includes(current.sync.state)
                }
                onClick={() => void sync()}
              >
                {!capability?.configured
                  ? 'History not connected'
                  : current.sync.state === 'queued' ||
                      current.sync.state === 'running'
                    ? 'Sync queued'
                    : 'Sync history'}
              </button>
              <button
                className="sl-icon-button"
                aria-label="Unlink wallet"
                disabled={api.busy}
                onClick={() => setConfirmRemove(true)}
              >
                <Unlink size={15} />
              </button>
            </div>
          </div>
          {api.busy && (
            <div className="sl-progress">
              <Busy label="Loading wallet records" />
            </div>
          )}
          <div className="sl-metric-strip">
            <div>
              <span>Net P&L</span>
              <strong>{usd6(pnl?.netUsd6)}</strong>
              <small>
                {pnl?.complete
                  ? 'After all recorded fees'
                  : 'Waiting for complete history'}
              </small>
            </div>
            <div>
              <span>Realized</span>
              <strong>{usd6(pnl?.realizedUsd6)}</strong>
              <small>Closed positions</small>
            </div>
            <div>
              <span>Unrealized change</span>
              <strong>{usd6(pnl?.unrealizedChangeUsd6)}</strong>
              <small>Change during this month</small>
            </div>
            <div>
              <span>Recorded fees</span>
              <strong>{usd6(pnl?.observed.feesUsd6)}</strong>
              <small>
                {pnl?.complete ? 'All fees' : 'Available records only'}
              </small>
            </div>
          </div>
          <div className="sl-sync-line">
            <span
              className={`sl-status-dot${pnl?.complete ? ' is-green' : ''}`}
            />
            <span>
              {pnl?.complete
                ? 'History verified'
                : current.sync.state === 'blocked'
                  ? 'Data connection required'
                  : current.sync.state === 'running'
                    ? 'Syncing history'
                    : current.sync.state === 'queued'
                      ? 'Waiting to sync'
                      : 'Partial history'}
            </span>
            <span>
              {current.sync.finalized} finalized · {current.sync.pending}{' '}
              pending · {current.sync.unavailable} unavailable
            </span>
            <span>
              {current.sync.lastSyncAt
                ? `${utcTime(current.sync.lastSyncAt)} UTC`
                : 'Not synced yet'}
            </span>
          </div>
          {pausedWalletId === current.id &&
            ['queued', 'running'].includes(current.sync.state) && (
              <p className="sl-muted">
                Sync is still running. Use Refresh wallet to check again.
              </p>
            )}
          {current.sync.errorCode && (
            <p className="sl-notice">
              Last sync: {readableCode(current.sync.errorCode)}. Available
              records remain visible.
            </p>
          )}
          {pnl && !pnl.complete && (
            <details className="sl-disclosure">
              <summary>Partial history · what’s included?</summary>
              <p>
                Complete totals stay hidden until the source history and
                balances reconcile.
              </p>
              <dl className="sl-quote">
                <div>
                  <dt>Observed realized</dt>
                  <dd>{usd6(pnl.observed.realizedUsd6)}</dd>
                </div>
                <div>
                  <dt>Observed unrealized change</dt>
                  <dd>{usd6(pnl.observed.unrealizedChangeUsd6)}</dd>
                </div>
              </dl>
              {pnl.exceptions.map((line, i) => (
                <p key={i}>{readableCode(line)}</p>
              ))}
            </details>
          )}
          <nav className="sl-subnav" aria-label="Wallet sections">
            {(['positions', 'activity', 'fees'] as const).map((item) => (
              <button
                key={item}
                onClick={() => setTab(item)}
                aria-current={tab === item ? 'page' : undefined}
              >
                {readableCode(item)}
                {item === 'positions' && pnl && (
                  <span>{pnl.positions.length}</span>
                )}
              </button>
            ))}
          </nav>
          {tab === 'positions' ? (
            <div className="sl-table-wrap">
              <table className="sl-table">
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Balance</th>
                    <th>Cost basis</th>
                    <th>Value</th>
                    <th>Unrealized</th>
                  </tr>
                </thead>
                <tbody>
                  {pnl?.positions.map((position) => (
                    <tr key={position.mint}>
                      <td>
                        <div className="sl-table-token">
                          <TokenAvatar mint={position.mint} size={28} />
                          <span>
                            <strong>
                              {tokenIdentity(position.mint).symbol}
                            </strong>
                            <small>
                              {position.market === 'no_market'
                                ? 'No market · review'
                                : position.missingBasis
                                  ? 'Missing cost basis'
                                  : position.airdrop
                                    ? 'Airdrop · zero basis'
                                    : position.estimated
                                      ? 'Estimated'
                                      : shortAddress(position.mint)}
                            </small>
                          </span>
                        </div>
                      </td>
                      <td>
                        {decimalAmount(
                          position.amount,
                          position.decimals,
                          Math.min(position.decimals, 5),
                        )}
                      </td>
                      <td>{usd6(position.basisUsd6)}</td>
                      <td>{usd6(position.valueUsd6)}</td>
                      <td>{usd6(position.unrealizedUsd6)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!pnl?.positions.length && (
                <div className="sl-inline-empty">
                  {api.busy
                    ? 'Loading positions…'
                    : 'Positions appear after wallet history is indexed.'}
                </div>
              )}
            </div>
          ) : tab === 'activity' ? (
            <div className="sl-table-wrap">
              <table className="sl-table">
                <thead>
                  <tr>
                    <th>Activity</th>
                    <th>Time · UTC</th>
                    <th>Transaction</th>
                    <th>Review</th>
                  </tr>
                </thead>
                <tbody>
                  {pnl?.activity.map((activity) => (
                    <tr key={activity.signature}>
                      <td>{readableCode(activity.kind)}</td>
                      <td>
                        {activity.timestamp
                          ? utcTime(activity.timestamp)
                          : 'Unavailable'}
                      </td>
                      <td>
                        <EvidenceLink
                          href={`https://solscan.io/tx/${activity.signature}`}
                        >
                          {shortAddress(activity.signature)}
                        </EvidenceLink>
                      </td>
                      <td>
                        {activity.warnings.length
                          ? activity.warnings.map(readableCode).join(' · ')
                          : 'Finalized'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!pnl?.activity.length && (
                <div className="sl-inline-empty">
                  No indexed activity to show yet.
                </div>
              )}
              {pnl?.activityTruncated && (
                <p className="sl-muted">
                  Showing the most recent available activity.
                </p>
              )}
            </div>
          ) : (
            <div className="sl-fees">
              <dl>
                {pnl &&
                  walletFeeRows(pnl.fees).map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{usd6(value)}</dd>
                    </div>
                  ))}
              </dl>
              <p className="sl-muted">
                Rent deposits excluded:{' '}
                {pnl ? decimalAmount(pnl.rentExcludedLamports, 9, 6) : '—'} SOL.
                Missing fee prices stay unknown.
              </p>
            </div>
          )}
          <footer className="sl-report-footer">
            <span>FIFO accounting · UTC calendar month</span>
            <span>Public address · ownership not verified</span>
          </footer>
        </>
      )}
      {linkAddress && (
        <Modal
          title="Link a read-only wallet"
          onClose={() => {
            if (!api.busy) setLinkAddress('');
          }}
        >
          <p className="sl-muted">
            Conclave reads public history. Linking does not prove ownership or
            grant signing permission.
          </p>
          <code className="sl-full-address">{linkAddress}</code>
          <label className="sl-field">
            Label <span>optional</span>
            <input
              maxLength={80}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="My Solana wallet"
            />
          </label>
          <ErrorNotice message={api.error} />
          <button
            className="sl-button sl-primary sl-wide"
            disabled={api.busy}
            onClick={() => void link()}
          >
            {api.busy ? 'Linking…' : 'Link wallet'}
          </button>
        </Modal>
      )}
      {confirmRemove && (
        <Modal
          title="Unlink this wallet?"
          onClose={() => {
            if (!api.busy) setConfirmRemove(false);
          }}
        >
          <p className="sl-muted">
            This removes the link and its cached wallet records from your
            account. Your onchain wallet and funds are unaffected.
          </p>
          <ErrorNotice message={api.error} />
          <button
            className="sl-button sl-danger sl-wide"
            disabled={api.busy}
            onClick={() => void remove()}
          >
            Unlink wallet
          </button>
        </Modal>
      )}
    </section>
  );
}
