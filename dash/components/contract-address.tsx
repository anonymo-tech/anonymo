'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CopyButton } from './copy-button';
import { COIN_CHAIN, coinAddress, shortAddress } from '@/lib/anonymo/coin';

/** The coin's contract address with a copy button. Says "Announced at launch" until an address is set (lib/anonymo/coin.ts). */
export function ContractAddress({ className = '' }: { className?: string }) {
  const address = coinAddress();
  return (
    <div className={`ca ${className}`} role="group" aria-label="Contract address">
      <div className="ca-label">
        <span className="ca-kicker">Contract address</span>
        <span className="ca-chain">{COIN_CHAIN}</span>
      </div>
      {address ? (
        <>
          <code className="ca-value" title={address}>
            <span className="ca-full">{address}</span>
            <span className="ca-short" aria-hidden="true">
              {shortAddress(address)}
            </span>
          </code>
          <CopyButton text={address} label="Copy" className="ca-copy" />
        </>
      ) : (
        <span className="ca-value ca-pending">Announced at launch</span>
      )}
      <p className="ca-note">Only trust the address shown on anonymo.tech.</p>
    </div>
  );
}

/** The same address as a compact chip, so it is visible without scrolling: the site header, the workspace top bar
 * and the landing hero. The whole chip copies. `full` shows the whole address on wide screens (short on phones). */
export function ContractAddressChip({ className = '', full = false }: { className?: string; full?: boolean }) {
  const address = coinAddress();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  if (!address)
    return (
      <span className={`ca-chip ca-chip-pending ${className}`} title={`Contract address on ${COIN_CHAIN}: announced at launch`}>
        <span className="ca-chip-label">CA</span>
        <span>Announced at launch</span>
      </span>
    );
  return (
    <button
      type="button"
      className={`ca-chip ${className}`}
      title={`Copy the contract address (${COIN_CHAIN}): ${address}`}
      aria-label={copied ? 'Contract address copied' : `Copy contract address ${address}`}
      onClick={() => {
        void navigator.clipboard?.writeText(address).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    >
      <span className="ca-chip-label">CA</span>
      {full ? (
        <code>
          <span className="ca-full">{address}</span>
          <span className="ca-short">{shortAddress(address)}</span>
        </code>
      ) : (
        <code>{shortAddress(address)}</code>
      )}
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      <span className="ca-chip-state" aria-hidden="true">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}
