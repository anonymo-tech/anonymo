// Phones have no browser wallet: Safari and Chrome on a phone never inject window.ethereum. A wallet app pays from its
// own built-in browser instead, so the dashboard opens /pay there. The link carries only the key's keyCommit (a one-way
// hash that every deposit already publishes on chain), never the key; /pay reads the contracts from the gateway itself.

import { parseUsd } from './money.ts';
import type { EvmChain, Hex } from './types.ts';

export type PayLink = { keyCommit: Hex; chain: EvmChain; token: string; amount?: string };

const COMMIT = /^0x[0-9a-fA-F]{64}$/;
const CHAIN = /^(rhc|base|arbitrum)$/;
const TOKEN = /^[A-Z]{3,5}$/;

/** A phone or tablet browser (iPadOS reports itself as a Mac with touch). */
export function isMobileBrowser(nav: { userAgent: string; maxTouchPoints?: number } | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  if (!nav) return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 1);
}

export function payUrl(origin: string, link: PayLink): string {
  const q = new URLSearchParams({ k: link.keyCommit, chain: link.chain, token: link.token });
  if (link.amount !== undefined) {
    if (!parseUsd(link.amount)) return '';
    q.set('amount', link.amount.trim().replace(/^\$\s*/, ''));
  }
  return `${origin.replace(/\/+$/, '')}/pay?${q.toString()}`;
}

/** Reads a /pay query string. Anything malformed gives null, so the page asks for a fresh link. */
export function parsePayLink(search: string): PayLink | null {
  const q = new URLSearchParams(search);
  const keyCommit = q.get('k') ?? '';
  const chain = q.get('chain') ?? '';
  const token = (q.get('token') ?? '').toUpperCase();
  const amount = q.get('amount') ?? undefined;
  if (amount !== undefined && !parseUsd(amount)) return null;
  if (!COMMIT.test(keyCommit) || !CHAIN.test(chain) || !TOKEN.test(token)) return null;
  return { keyCommit: keyCommit.toLowerCase() as Hex, chain: chain as EvmChain, token, ...(amount ? { amount } : {}) };
}

/** Links that open a page inside a wallet app's browser. Each app documents its own format. */
export function walletAppLinks(url: string): { name: string; href: string }[] {
  return [
    { name: 'MetaMask', href: `https://link.metamask.io/dapp/${url.replace(/^https?:\/\//, '')}` },
    { name: 'Coinbase Wallet', href: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(url)}` },
    { name: 'Trust Wallet', href: `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(url)}` },
  ];
}
