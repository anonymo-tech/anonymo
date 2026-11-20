'use client';

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
