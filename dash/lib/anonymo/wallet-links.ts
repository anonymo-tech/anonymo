// Phones have no browser wallet: Safari and Chrome on a phone never inject window.ethereum. A wallet app pays from its
// own built-in browser instead, so the dashboard opens /pay there. The link carries only the key's keyCommit (a one-way
// hash that every deposit already publishes on chain), never the key; /pay reads the contracts from the gateway itself.

import { COIN_ADDRESS } from './coin.ts';
import { parseUsd } from './money.ts';
import type { EvmChain, Hex, PublicCoinInstructions } from './types.ts';

export type PayLink = { keyCommit: Hex; chain: EvmChain; token: string; amount?: string };

const COMMIT = /^0x[0-9a-fA-F]{64}$/;
const CHAIN = /^(rhc|base|arbitrum)$/;
const TOKEN = /^[A-Z]{3,5}$/;

/** Accept only the deployed NYMO token on Robinhood Chain mainnet and a separately configured CoinPay contract. */
export function availableNymoRail<T extends PublicCoinInstructions>(coin: T | null | undefined): coin is T {
  if (!coin || coin.chain !== 'rhc' || coin.chain_id !== 4663 || coin.token?.symbol !== 'NYMO' ||
      typeof coin.token.address !== 'string' || coin.token.address.toLowerCase() !== COIN_ADDRESS || coin.token.decimals !== 18) return false;
  const spender = typeof coin.coin_pay === 'string' ? coin.coin_pay.toLowerCase() : '';
  return !!spender && /^0x[0-9a-f]{40}$/.test(spender) && spender !== COIN_ADDRESS &&
    !/^0x0{36}(?:0000|dead)$/.test(spender) && Number.isSafeInteger(coin.confirmations) &&
    coin.confirmations >= 0 && !!parseUsd(coin.max_usd_per_payment);
}

/** A phone or tablet browser (iPadOS reports itself as a Mac with touch). */
export function isMobileBrowser(nav: { userAgent: string; maxTouchPoints?: number } | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  if (!nav) return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 1);
}

export function payUrl(origin: string, link: PayLink): string {
  if (link.token === 'NYMO' && link.chain !== 'rhc') return '';
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
  if (token === 'NYMO' && chain !== 'rhc') return null;
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
