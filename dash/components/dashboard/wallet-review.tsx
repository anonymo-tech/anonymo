'use client';

// 08 What am I signing? The person pastes one wallet request; this page says what it would allow, separates the lasting
// permission from any immediate balance change, and keeps every signing control in the wallet. It never asks the
// wallet for anything. An optional simulation is a read sent only after the person sees what it sends, and where.

import { ShieldAlert, ShieldCheck, Wallet } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { getAddress, isAddress, type Address } from 'viem';
import { useAnonymo } from '../anonymo-provider';
import { evmNetwork, shortAddress } from '@/lib/anonymo/chains';
import { formatUnits } from '@/lib/anonymo/wallet';
import type { DepositContracts, EvmChain } from '@/lib/anonymo/types';
import {
  hostOf,
  isStale,
  limitedPreview,
  parseWalletRequest,
  reviewRequest,
  rpcClient,
  simulateApproval,
  simulationDisclosure,
  verifiedFromContracts,
  WALLET_REVIEW_DRAFT,
  type ApprovalReview,
  type RequestRefusal,
  type Simulation,
} from '@/lib/anonymo/wallet-request';
import './wallet-review.css';

const CHAINS: EvmChain[] = ['rhc', 'base', 'arbitrum'];

function peekDraft() {
  try {
    return sessionStorage.getItem(WALLET_REVIEW_DRAFT) || null;
  } catch {
    return null;
  }
}

function dropDraft() {
  try {
    sessionStorage.removeItem(WALLET_REVIEW_DRAFT);
  } catch {
    // nothing stored
  }
}

export function WalletReview() {
  const { client } = useAnonymo();
  const [text, setText] = useState('');
  const [reviewed, setReviewed] = useState<{ text: string; result: { ok: true; review: ApprovalReview } | RequestRefusal } | null>(null);
  const [contracts, setContracts] = useState<DepositContracts | null>(null);
  const [contractsError, setContractsError] = useState(false);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const inputId = useId();

  useEffect(() => {
    const controller = new AbortController();
    client.depositContracts(controller.signal).then(setContracts, () => { if (!controller.signal.aborted) setContractsError(true); });
    return () => controller.abort();
  }, [client]);

  const networks = useMemo(() => CHAINS.map(chain => ({ chain, chainId: evmNetwork(chain).chainId, name: evmNetwork(chain).name })), []);
  const verified = useMemo(() => verifiedFromContracts(contracts, c => evmNetwork(c).chainId), [contracts]);

  const review = useCallback((input: string) => {
    const parsed = parseWalletRequest(input);
    const result = parsed.ok ? reviewRequest(parsed.request, { networks, ...verified }) : parsed;
    setReviewed({ text: input, result });
    requestAnimationFrame(() => resultHeading.current?.focus());
  }, [networks, verified]);

  // A request brought over from chat is reviewed once the verified token list is known, then forgotten.
  useEffect(() => {
    if (!contracts && !contractsError) return;
    const draft = peekDraft();
    if (!draft) return;
    dropDraft();
    setText(draft);
    review(draft);
  }, [contracts, contractsError, review]);

  const changed = !!reviewed && reviewed.text !== text;
  const result = reviewed?.result;

  return (
    <div className="wallet-review-page">
      <form className="wallet-review-form" onSubmit={event => { event.preventDefault(); review(text); }}>
        <label htmlFor={inputId}>Wallet request</label>
        <textarea id={inputId} className="input mono" rows={5} spellCheck={false} autoComplete="off" value={text}
          placeholder={'{"from":"0x…","to":"0x…","data":"0x095ea7b3…","chainId":4663}'}
          onChange={event => setText(event.target.value)} />
        <details className="wallet-review-formats">
          <summary>What can I paste?</summary>
          <p>A token approval, either as the transaction your wallet or the app shows (<code>eth_sendTransaction</code> JSON with <code>from</code>, <code>to</code>, <code>data</code> and <code>chainId</code>), or as an <code>ethereum:</code> link of the form <code>ethereum:&lt;token&gt;@&lt;chainId&gt;/approve?address=&lt;spender&gt;&amp;uint256=&lt;amount&gt;</code>.</p>
          <p>Signature requests (permits, typed data) are not supported yet.</p>
        </details>
        <button type="submit" className="btn btn-primary" disabled={!text.trim()}>Review request</button>
        {contractsError && <p className="faint">Verified token details are unavailable right now, so token names and decimals are not shown.</p>}
      </form>

      {result && (
        <section className="wallet-review-result" aria-labelledby="wallet-review-result">
          <h2 id="wallet-review-result" ref={resultHeading} tabIndex={-1} className="sr-only">Review</h2>
          {changed ? (
            <p className="notice notice-amber">The request changed. Review it again before relying on anything below.</p>
          ) : result.ok ? (
            <ApprovalView key={result.review.fingerprint} review={result.review} />
          ) : (
            <p className="notice notice-amber" role="alert"><ShieldAlert size={16} aria-hidden="true" /> {result.message}</p>
          )}
        </section>
      )}
    </div>
  );
}

function ApprovalView({ review }: { review: ApprovalReview }) {
  const token = review.token.verified;
  const symbol = token?.symbol ?? 'tokens';
  const who = review.spender.label ? `the ${review.spender.label}` : `the address ${shortAddress(review.spender.address)}`;
  const [fullSpender, setFullSpender] = useState(false);
  const [fullToken, setFullToken] = useState(false);
  const [preview, setPreview] = useState(false);
  const [returned, setReturned] = useState(false);
  const limit = limitedPreview(review, 10n);

  const headline = review.amount.zero ? `This removes ${who}’s permission to spend your ${symbol}.` : `This lets ${review.spender.label ? `the ${review.spender.label}` : 'an app'} spend your ${symbol}.`;
  const later = review.amount.zero
    ? `After this, ${who} can no longer move your ${symbol}.`
    : review.amount.unlimited
      ? `${capital(who)} could move any amount of your ${symbol}, now or later, until you set the allowance back to 0.`
      : `${capital(who)} could move up to ${review.amount.text} from your wallet at any time, until it is used or you revoke it.`;

  return (
    <div className="wallet-review-approval">
      <div className={review.amount.zero ? 'wr-summary is-calm' : 'wr-summary'}>
        <span className="wr-kind">{review.amount.zero ? <ShieldCheck size={16} aria-hidden="true" /> : <ShieldAlert size={16} aria-hidden="true" />}Token approval</span>
        <strong>{headline}</strong>
      </div>

      {!review.chain.supported && <p className="notice notice-amber">This request is for chain {review.chain.id}. Anonymo cannot verify tokens or simulate on that chain, so check every address in your wallet.</p>}
      {review.value > 0n && <p className="notice notice-amber">It also sends {formatUnits(review.value, 18, 18)} of the chain’s native coin. An approval normally sends none.</p>}

      <h3 className="wr-label">Requested permission</h3>
      <dl className="wr-facts">
        <div>
          <dt>Spender</dt>
          <dd>
            <span className="mono">{fullSpender ? review.spender.address : review.spender.label ?? shortAddress(review.spender.address)}</span>
            <button type="button" className="wr-link" aria-expanded={fullSpender} onClick={() => setFullSpender(v => !v)}>{fullSpender ? 'Hide full address' : 'Show full address'}</button>
            {!review.spender.label && <small>Not a contract Anonymo can identify.</small>}
          </dd>
        </div>
        <div>
          <dt>Token contract</dt>
          <dd>
            <span className="mono">{fullToken ? review.token.address : shortAddress(review.token.address)}</span>
            <button type="button" className="wr-link" aria-expanded={fullToken} onClick={() => setFullToken(v => !v)}>{fullToken ? 'Hide full address' : 'Show full address'}</button>
            <small>{token ? `${token.symbol}, verified on ${review.chain.name}` : 'Unverified token: its name and decimals are not known.'}</small>
          </dd>
        </div>
        <div><dt>Allowance</dt><dd><strong>{review.amount.text}</strong></dd></div>
        <div><dt>Chain</dt><dd>{review.chain.name}</dd></div>
        <div><dt>From</dt><dd className="mono">{review.account ? shortAddress(review.account) : 'Not stated in the request'}</dd></div>
      </dl>

      <h3 className="wr-label">What it allows later</h3>
      <p className="wr-later">{later}</p>

      <h3 className="wr-label">Immediate balance change</h3>
      <SimulationPanel review={review} />

      {limit && (
        <div className="wr-preview">
          <button type="button" className="wr-link" aria-expanded={preview} onClick={() => setPreview(v => !v)}>Preview a {limit.text} limit</button>
          {preview && (
            <p className="faint">
              Illustrative only. If your wallet lets you edit the spending limit, set it to {limit.text} there and check the exact
              amount it shows before approving. An edited request is a new request: paste it here to review it again.
            </p>
          )}
        </div>
      )}

      <button type="button" className="btn btn-primary wr-return" onClick={() => setReturned(true)}><Wallet size={17} aria-hidden="true" />Return to wallet</button>
      {returned && <output className="wr-returned">Nothing was signed here. Switch back to your wallet to approve or reject the request.</output>}
    </div>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function SimulationPanel({ review }: { review: ApprovalReview }) {
  const network = review.chain.key ? evmNetwork(review.chain.key) : null;
  const rpcUrl = network?.rpcUrl ?? '';
  const [account, setAccount] = useState(review.account ?? '');
  const [running, setRunning] = useState(false);
  const [sim, setSim] = useState<Simulation | null>(null);
  const [now, setNow] = useState(0);
  const accountId = useId();
  useEffect(() => {
    if (!sim) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [sim]);

  if (!review.chain.supported || !rpcUrl)
    return <p className="wr-sim is-muted">Not checked. A read-only simulation is only available on the chains Anonymo supports.</p>;

  const validAccount = isAddress(account.trim(), { strict: false });
  const disclosure = validAccount ? simulationDisclosure(review, rpcUrl, getAddress(account.trim()) as Address) : null;
  const token = review.token.verified;
  const stale = sim && isStale(sim, review, now);

  async function run() {
    if (!validAccount) return;
    setRunning(true);
    setSim(await simulateApproval(review, getAddress(account.trim()) as Address, rpcClient(rpcUrl)));
    setNow(Date.now());
    setRunning(false);
  }

  return (
    <div className="wr-sim">
      {sim && !stale && sim.kind === 'ok' ? (
        <div className="wr-sim-result">
          <strong>{token ? `${formatUnits(abs(sim.balanceChange), token.decimals, token.decimals)} ${token.symbol}` : `${abs(sim.balanceChange)} units`}{sim.balanceChange < 0n ? ' out' : sim.balanceChange > 0n ? ' in' : ''}</strong>
          <p>
            {sim.balanceChange === 0n
              ? `This approval moves no tokens now. The spender could move your ${token?.symbol ?? 'tokens'} up to the allowance later.`
              : 'This request also moves tokens right away. Check this in your wallet before approving.'}
          </p>
          <small>Simulated against the latest block. Current allowance {token ? formatUnits(sim.currentAllowance, token.decimals, token.decimals) : sim.currentAllowance.toString()}{sim.allowanceAfter !== sim.currentAllowance ? `, afterwards ${review.amount.unlimited ? 'unlimited' : token ? formatUnits(sim.allowanceAfter, token.decimals, token.decimals) : sim.allowanceAfter.toString()}` : ''}.</small>
        </div>
      ) : sim && !stale && sim.kind !== 'ok' ? (
        <p className="notice notice-amber" role="alert">{sim.message} The request was not sent anywhere else.</p>
      ) : (
        <p className="is-muted">{stale ? 'The last check is out of date. Run it again for the current request.' : 'Not checked yet.'}</p>
      )}
      <label className="field" htmlFor={accountId}>Your wallet address
        <input id={accountId} className="input mono" value={account} spellCheck={false} autoComplete="off" placeholder="0x…"
          onChange={event => { setAccount(event.target.value); setSim(null); }} />
      </label>
      {disclosure ? (
        <>
          <p className="faint">A check sends these to {disclosure.host}, a public RPC for {review.chain.name}. It reads; it cannot sign or send anything.</p>
          <dl className="wr-sends">{disclosure.fields.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="mono">{v}</dd></div>)}</dl>
          <button type="button" className="btn" disabled={running} onClick={() => void run()}>{running ? 'Checking…' : `Check with ${hostOf(rpcUrl)}`}</button>
        </>
      ) : (
        <p className="faint">Enter the wallet address the request comes from to run a read-only check.</p>
      )}
    </div>
  );
}

const abs = (n: bigint) => (n < 0n ? -n : n);
