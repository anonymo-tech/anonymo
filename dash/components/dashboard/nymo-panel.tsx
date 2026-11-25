'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { parseUnits, type Address } from 'viem';
import { useAnonymo } from '../anonymo-provider';
import { describeError } from '@/lib/anonymo/client';
import { everydayWallet, moveStake, stakeControls, stakePosition, type StakeContract, type StakeSummary } from '@/lib/anonymo/everyday';
import { formatUsdAmount } from '@/lib/anonymo/money';
import { describeWalletError, formatUnits, injectedProvider } from '@/lib/anonymo/wallet';

const exitContract = process.env.NEXT_PUBLIC_ANONYMO_STAKE_CREDITS_ADDRESS;
const fallback = /^0x[0-9a-fA-F]{40}$/.test(exitContract ?? '') ? { chainId: 4663, address: exitContract as Address } : null;
const tierNames = ['Plus', 'Pro', 'Black'];

export function NymoPanel() {
  const { client, key, demo, ready } = useAnonymo();
  const [contract, setContract] = useState<StakeContract | null>(fallback);
  const [summary, setSummary] = useState<StakeSummary | null>(null);
  const [amount, setAmount] = useState('');
  const [position, setPosition] = useState<{ account: string; staked: bigint; paused: boolean | null; contract: Address | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [demoLinked, setDemoLinked] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const address = contract?.address;
  const units = /^\d{1,35}(?:\.\d{1,18})?$/.test(amount) ? parseUnits(amount, 18) : 0n;

  useEffect(() => {
    if (demo || !ready) return;
    const abort = new AbortController();
    const showError = (e: unknown) => { if (!abort.signal.aborted) setError(describeError(e)); };
    void client.stakeContract(abort.signal).then((data) => { if (!abort.signal.aborted) setContract(data.address ? data : fallback); }, showError);
    setSummary(null);
    if (!key) return () => abort.abort();
    const refresh = () => void client.stakeSummary(abort.signal).then((data) => { if (!abort.signal.aborted) setSummary(data); }, showError);
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => { abort.abort(); window.clearInterval(timer); };
  }, [client, key, demo, ready]);

  const controls = stakeControls(units, position, busy);

  async function act(action: 'connect' | 'link' | 'stake' | 'unstake') {
    if (busy || (action === 'stake' || action === 'unstake') && !controls[action]) return;
    if (demo) {
      const staked = position?.staked ?? 0n;
      setPosition({ account: 'Demo wallet', contract: null, staked: action === 'stake' ? staked + units : action === 'unstake' ? staked - units : staked, paused: false });
      if (action === 'link') { setDemoLinked(true); setStatus('Demo wallet linked.'); }
      if (action === 'stake' || action === 'unstake') setAmount('');
      return;
    }
    if (!address) return;
    const provider = injectedProvider();
    if (!provider) { setError('Open Anonymo in an Ethereum wallet browser or enable a browser wallet.'); return; }
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const connection = await everydayWallet(provider, contract.chainId);
      if (action === 'link') {
        const { message, expires } = await client.stakeLinkChallenge(connection.account);
        const signature = await connection.wallet.signMessage({ account: connection.account, message });
        await client.stakeLink(connection.account, expires, signature);
        setStatus('Wallet linked for daily credits.');
        void client.stakeSummary().then(setSummary, () => undefined);
      }
      if (action === 'stake' || action === 'unstake') {
        if (connection.account.toLowerCase() !== position?.account.toLowerCase() || position.contract !== address)
          throw new Error('Your wallet changed. Check its stake before continuing.');
        await moveStake(connection, address, action, units, (hash) => setStatus(`Submitted ${hash}`));
        setStatus(action === 'unstake' ? '$NYMO returned to your wallet.' : '$NYMO staked. Your tier updates after confirmation.');
        setAmount('');
      }
      setPosition({ ...await stakePosition(connection, address), account: connection.account, contract: address });
    } catch (e) {
      setError(describeWalletError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vault-memory-layout">
      <section className="panel panel-stack" aria-labelledby="nymo-position-title">
        <h2 id="nymo-position-title">Your stake</h2>
        <p>Stake $NYMO, get daily credits. Unstake any time from the wallet you used to stake.</p>
        {position && <p><strong>{formatUnits(position.staked, 18)} $NYMO</strong> staked · {position.account}</p>}
        {(demo || address) ? (
          <>
            <button type="button" className="btn" disabled={busy} onClick={() => void act('connect')}>{position ? 'Refresh wallet' : 'Connect wallet'}</button>
            {position && (
              <>
                <label className="field">$NYMO amount <input className="input" inputMode="decimal" value={amount} disabled={busy} onChange={(e) => setAmount(e.target.value)} /></label>
                {position.paused && <p className="notice">New stakes are paused. You can still unstake.</p>}
                <div className="row">
                  <button type="button" className="btn btn-primary" disabled={!controls.stake} onClick={() => void act('stake')}>Stake</button>
                  <button type="button" className="btn" disabled={!controls.unstake} onClick={() => void act('unstake')}>Unstake</button>
                </div>
                {(key || demo) && !summary?.wallet && !demoLinked && <>
                  <p className="muted">Your wallet can be linked to one key for daily credits. Keep a backup of that key.</p>
                  <button type="button" className="btn" disabled={busy} onClick={() => void act('link')}>Sign to link wallet to key</button>
                </>}
              </>
            )}
          </>
        ) : <p className="muted">The staking contract is unavailable.</p>}
        {!key && !demo && <Link href="/dashboard/key">Set up a key to receive daily credits</Link>}
        {address && <details><summary>Robinhood Chain contract</summary><code>{address}</code></details>}
        {busy && <p role="status">Check your wallet…</p>}
        {status && <p className="notice" role="status">{status}</p>}
        {error && <p className="notice notice-rose" role="alert">{error}</p>}
      </section>
      <section className="panel panel-stack" aria-labelledby="nymo-credits-title">
        <h2 id="nymo-credits-title">Daily credits</h2>
        <p>{demo ? 'Pro' : summary?.tier ?? 'Free'} tier · {demo ? '50,000' : formatUnits(BigInt(summary?.twab ?? 0), 18)} $NYMO averaged over 7 days</p>
        {summary?.wallet && <p>Linked wallet <code>{summary.wallet}</code></p>}
        <p><strong>{formatUsdAmount(demo ? 1.4 : summary?.availableCreditsUsd ?? 0)}</strong> available today{summary?.dailyCreditsUsd ? ` of ${formatUsdAmount(summary.dailyCreditsUsd)}` : ''}.</p>
        <p>Daily credits are for messages, voice and images. They expire at midnight UTC and cannot be transferred or withdrawn.</p>
        <ul>
          {(summary?.tierTable?.map((rule) => formatUnits(BigInt(rule.minTwab), 18)) ?? ['10,000', '50,000', '250,000'])
            .map((threshold, i) => <li key={tierNames[i]}><strong>{tierNames[i]}</strong> · {threshold} $NYMO seven-day average</li>)}
        </ul>
        {summary && <p>{summary.limits.memoryItems == null ? 'Unlimited' : summary.limits.memoryItems.toLocaleString()} Vault Memory items
          {summary.limits.dailyVoiceSeconds > 0 ? ` · ${summary.limits.dailyVoiceSeconds / 3600} h of voice daily` : ''}
          {summary.limits.council ? ' · Council access' : ''}
          {summary.limits.priority ? ' · Priority routing' : ''}
          {summary.limits.partyPlayers > 0 ? ` · Party rooms for ${summary.limits.partyPlayers}` : ''}</p>}
      </section>
    </div>
  );
}
